import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AudioStore, SafeError } from "../src/server/store.js";
import { analyzeWav, pcmToWav, audioId } from "../src/server/audio.js";
import { readConfig } from "../src/server/config.js";
import { VoiceService } from "../src/server/service.js";
import {
  ElevenLabs,
  generationSchema,
  settingsSchema,
  type SpeechProvider,
} from "../src/server/elevenlabs.js";
import { makeRuntime, localBindings, TEST_KEY } from "./worker/runtime.js";
const demo = new Uint8Array(readFileSync("assets/test-voice.wav"));
const input = generationSchema.parse({
  text: "Testing a request",
  request_id: "request-1",
  confirm_paid_generation: true,
});
async function context(paid = true, provider?: SpeechProvider) {
  const runtime = await makeRuntime();
  const config = readConfig({
    ...localBindings,
    ENABLE_PAID_GENERATION: String(paid),
  });
  const store = new AudioStore(runtime.db, runtime.bucket, TEST_KEY);
  return {
    ...runtime,
    config,
    store,
    service: new VoiceService(config, store, demo, provider),
    close: () => runtime.mf.dispose(),
  };
}
function mockProvider(fail = false) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    catalog: async () => ({ voices: [], models: [] }),
    validate: async () => {},
    generate: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 40));
      if (fail)
        throw new SafeError("GENERATION_UNCERTAIN", "Uncertain test outcome");
      const pcm = new Uint8Array(48000),
        view = new DataView(pcm.buffer);
      for (let i = 0; i < 24000; i++)
        view.setInt16(
          i * 2,
          Math.round(Math.sin(i / 12) * 10000 * (i / 24000)),
          true,
        );
      return pcm;
    },
  };
}
test("real WAV duration and waveform use decoded samples, without Node Buffer", () => {
  const analysis = analyzeWav(demo);
  assert.equal(analysis.durationSeconds, 9.105);
  assert.equal(analysis.waveform.length, 64);
  assert.ok(new Set(analysis.waveform).size > 40);
  assert.equal(Math.max(...analysis.waveform), 1);
  const pcm = new Uint8Array(48000),
    view = new DataView(pcm.buffer);
  for (let i = 24000; i < 48000; i += 2) view.setInt16(i, 16384, true);
  const known = analyzeWav(pcmToWav(pcm));
  assert.equal(known.durationSeconds, 1);
  assert.equal(known.waveform[0], 0);
  assert.equal(known.waveform[63], 1);
  assert.throws(() => analyzeWav(new Uint8Array(50)));
  assert.throws(() => pcmToWav(new Uint8Array(3)));
});
test("R2 audio, D1 metadata and signatures survive destruction/recreation of the Worker runtime", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "vb-persist-"));
  let c = await makeRuntime({ resourcePersistencePath: directory });
  try {
    const store = new AudioStore(c.db, c.bucket, TEST_KEY),
      id = await store.seedDemo(demo);
    const link = new URL(
      (await store.playback(id, localBindings.PUBLIC_BASE_URL, 600)).url,
    );
    await c.mf.dispose();
    c = await makeRuntime({ resourcePersistencePath: directory }, false);
    const reopened = new AudioStore(c.db, c.bucket, TEST_KEY);
    assert.equal((await reopened.get(id, "lavender")).durationSeconds, 9.105);
    assert.ok(
      await reopened.verify(
        id,
        link.searchParams.get("expires"),
        link.searchParams.get("sig"),
      ),
    );
    assert.ok(!(await reopened.verify(id, "1", link.searchParams.get("sig"))));
    assert.ok(
      !(await reopened.verify(
        id,
        link.searchParams.get("expires"),
        "0".repeat(64),
      )),
    );
    const response = await c.mf.dispatchFetch(link.href, {
      headers: { Range: "bytes=0-43" },
    });
    assert.equal(response.status, 206);
    assert.equal((await response.arrayBuffer()).byteLength, 44);
  } finally {
    await c.mf.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("default paid switch and explicit confirmation prevent generation", async () => {
  const provider = mockProvider(),
    c = await context(false, provider);
  try {
    await assert.rejects(c.service.generate(input), {
      code: "PAID_GENERATION_DISABLED",
    });
    assert.equal(provider.calls, 0);
    assert.throws(() => generationSchema.parse({ text: "no permission" }));
    assert.equal(
      (await c.service.result("demo")).structuredContent.source,
      "test",
    );
  } finally {
    await c.close();
  }
});
test("8 independent service/store instances share one D1 claim and one generated R2 object", async () => {
  const provider = mockProvider(),
    c = await context(true, provider);
  try {
    const services = Array.from(
      { length: 8 },
      () =>
        new VoiceService(
          c.config,
          new AudioStore(c.db, c.bucket, TEST_KEY),
          demo,
          provider,
        ),
    );
    const results = await Promise.all(services.map((s) => s.generate(input)));
    assert.equal(provider.calls, 1);
    assert.equal(
      new Set(results.map((r) => r.structuredContent.audioId)).size,
      1,
    );
    assert.equal(results[0].structuredContent.durationSeconds, 1);
    const service = new VoiceService(
      c.config,
      new AudioStore(c.db, c.bucket, TEST_KEY),
      demo,
      provider,
    );
    assert.equal(
      (await service.generate(input)).structuredContent.audioId,
      results[0].structuredContent.audioId,
    );
    assert.equal(provider.calls, 1);
    assert.equal((await c.bucket.list()).objects.length, 1);
  } finally {
    await c.close();
  }
});
test("request ID cannot bind different content under concurrent calls", async () => {
  const provider = mockProvider(),
    c = await context(true, provider);
  try {
    const results = await Promise.allSettled([
      c.service.generate(input),
      c.service.generate({ ...input, text: "other" }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
        .reason.code,
      "IDEMPOTENCY_CONFLICT",
    );
    assert.equal(provider.calls, 1);
  } finally {
    await c.close();
  }
});
test("uncertain result remains blocked in fresh services; only explicit retry can claim once", async () => {
  const provider = mockProvider(true),
    c = await context(true, provider);
  try {
    await assert.rejects(c.service.generate(input), {
      code: "GENERATION_UNCERTAIN",
    });
    const fresh = new VoiceService(
      c.config,
      new AudioStore(c.db, c.bucket, TEST_KEY),
      demo,
      provider,
    );
    await assert.rejects(fresh.generate(input), {
      code: "GENERATION_NOT_RETRIED",
    });
    assert.equal(provider.calls, 1);
    await assert.rejects(fresh.generate({ ...input, retry_failed: true }), {
      code: "GENERATION_UNCERTAIN",
    });
    assert.equal(provider.calls, 2);
  } finally {
    await c.close();
  }
});
test("stale pending claim needs explicit retry; late attempt cannot overwrite or fail its replacement", async () => {
  const c = await context(),
    id = await audioId("fencing");
  try {
    const first = (await c.store.claim(id, false, Date.now() - 181_000))!;
    assert.equal(await c.store.claim(id, false), null);
    const second = (await c.store.claim(id, true))!;
    assert.ok(second);
    assert.notEqual(first, second);
    assert.equal(await c.store.claim(id, true), null);
    await assert.rejects(c.store.complete(id, first, demo), {
      code: "GENERATION_UNCERTAIN",
    });
    await c.store.finish(id, first, "failed");
    assert.equal((await c.store.job(id))!.status, "pending");
    await c.store.complete(id, second, pcmToWav(new Uint8Array(48000)));
    await assert.rejects(c.store.complete(id, first, demo), {
      code: "GENERATION_UNCERTAIN",
    });
    await c.store.finish(id, first, "uncertain");
    assert.equal((await c.store.get(id, "lavender")).durationSeconds, 1);
    assert.equal((await c.store.job(id))!.status, "ready");
    assert.equal(await c.store.claim(id, true), null);
  } finally {
    await c.close();
  }
});
test("R2 failure after paid result records uncertainty and does not regenerate", async () => {
  const provider = mockProvider(),
    c = await context(true, provider);
  try {
    const failingBucket = new Proxy(c.bucket, {
      get(target, property) {
        return property === "put"
          ? async () => {
              throw new Error("R2 unavailable");
            }
          : Reflect.get(target, property, target);
      },
    });
    const store = new AudioStore(c.db, failingBucket, TEST_KEY),
      service = new VoiceService(c.config, store, demo, provider);
    await assert.rejects(service.generate(input), {
      code: "GENERATION_UNCERTAIN",
    });
    await assert.rejects(c.service.generate(input), {
      code: "GENERATION_NOT_RETRIED",
    });
    assert.equal(provider.calls, 1);
  } finally {
    await c.close();
  }
});
test("missing R2 object with ready metadata never triggers another paid request, even explicit retry", async () => {
  const provider = mockProvider(),
    c = await context(true, provider);
  try {
    const result = await c.service.generate(input),
      id = result.structuredContent.audioId;
    await c.bucket.delete((await c.store.row(id))!.object_key);
    await assert.rejects(c.service.generate({ ...input, retry_failed: true }), {
      code: "AUDIO_NOT_FOUND",
    });
    assert.equal(provider.calls, 1);
  } finally {
    await c.close();
  }
});
test("configuration requires secrets, loopback local mode, HTTPS OAuth and exact owner", () => {
  assert.throws(() =>
    readConfig({ ...localBindings, PUBLIC_BASE_URL: "https://public.example" }),
  );
  assert.throws(() => readConfig({ ...localBindings, AUTH_MODE: "oauth" }));
  assert.throws(() => readConfig({ ...localBindings, MEDIA_SIGNING_KEY: "" }));
  assert.throws(() =>
    readConfig({
      ...localBindings,
      PUBLIC_BASE_URL: "http://user:pass@127.0.0.1:8787",
    }),
  );
});
test("ElevenLabs Web API adapter uses real catalog IDs and server-only key with PCM format", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [],
    config = readConfig(localBindings);
  config.apiKey = "test-secret-must-not-leak";
  const provider = new ElevenLabs(config, (async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).includes("/text-to-speech/"))
      return new Response(new Uint8Array(4));
    if (String(url).endsWith("/v1/models"))
      return Response.json([
        {
          model_id: "model-from-api",
          name: "Model",
          can_do_text_to_speech: true,
        },
      ]);
    if (String(url).endsWith("/v1/voices"))
      return Response.json({
        voices: [{ voice_id: "voice-from-api", name: "Voice" }],
      });
    return Response.json({ voice_id: "voice-from-api" });
  }) as typeof fetch);
  const catalog = await provider.catalog();
  await provider.validate("voice-from-api", "model-from-api");
  assert.equal(
    (
      await provider.generate(
        "Hi",
        "voice-from-api",
        "model-from-api",
        settingsSchema.parse({}),
      )
    ).length,
    4,
  );
  assert.ok(requests.at(-1)!.url.endsWith("?output_format=pcm_24000"));
  assert.equal(requests.at(-1)!.init!.redirect, "manual");
  assert.equal(
    new Headers(requests.at(-1)!.init!.headers).get("xi-api-key"),
    config.apiKey,
  );
  assert.ok(!JSON.stringify(catalog).includes(config.apiKey));
  await assert.rejects(provider.validate("invented", "invalid"), {
    code: "INVALID_VOICE_OR_MODEL",
  });
});
test("provider errors redact body and never retry a paid HTTP error", async () => {
  const config = readConfig(localBindings);
  config.apiKey = "private-test-key";
  let calls = 0;
  const provider = new ElevenLabs(config, (async () => {
    calls++;
    return new Response("private-test-key user text", { status: 500 });
  }) as typeof fetch);
  await assert.rejects(
    provider.generate("private text", "v", "m", settingsSchema.parse({})),
    (e: Error) =>
      !e.message.includes("private-test-key") &&
      !e.message.includes("private text"),
  );
  assert.equal(calls, 1);
});
test("D1 publication failure rolls back metadata/status, retains R2 recovery object, and blocks regeneration", async () => {
  const provider = mockProvider(),
    c = await context(true, provider);
  try {
    await c.db
      .prepare(
        "CREATE TRIGGER fail_ready BEFORE UPDATE OF status ON jobs WHEN NEW.status='ready' BEGIN SELECT RAISE(ABORT, 'simulated commit failure'); END",
      )
      .run();
    await assert.rejects(c.service.generate(input), {
      code: "GENERATION_UNCERTAIN",
    });
    assert.equal((await c.bucket.list()).objects.length, 1);
    assert.equal(
      (await c.db
        .prepare("SELECT count(*) AS n FROM audio")
        .first<{ n: number }>())!.n,
      0,
    );
    assert.equal(
      (await c.db
        .prepare("SELECT status FROM jobs")
        .first<{ status: string }>())!.status,
      "uncertain",
    );
    const fresh = new VoiceService(
      c.config,
      new AudioStore(c.db, c.bucket, TEST_KEY),
      demo,
      provider,
    );
    await assert.rejects(fresh.generate(input), {
      code: "GENERATION_NOT_RETRIED",
    });
    assert.equal(provider.calls, 1);
  } finally {
    await c.close();
  }
});

test("a job published between polling metadata and status returns its audio without regenerating", async () => {
  const provider = mockProvider(),
    c = await context(true, provider);
  try {
    const first = await c.service.generate(input);
    const store = new AudioStore(c.db, c.bucket, TEST_KEY);
    const row = store.row.bind(store);
    let reads = 0;
    // Simulate publication immediately after the poll's metadata read:
    // three cache probes and the first poll miss, but status is already ready.
    store.row = async (id) => (++reads <= 4 ? null : row(id));
    store.claim = async () => null;
    const joined = new VoiceService(c.config, store, demo, provider);
    assert.equal(
      (await joined.generate(input)).structuredContent.audioId,
      first.structuredContent.audioId,
    );
    assert.equal(provider.calls, 1);
  } finally {
    await c.close();
  }
});
