import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AudioStore, SafeError } from "../src/server/store.js";
import { analyzeWav, pcmToWav } from "../src/server/audio.js";
import { readConfig } from "../src/server/config.js";
import { VoiceService } from "../src/server/service.js";
import {
  ElevenLabs,
  generationSchema,
  type SpeechProvider,
} from "../src/server/elevenlabs.js";

function context(paid = true, provider?: SpeechProvider) {
  const dir = mkdtempSync(path.join(tmpdir(), "vb-test-"));
  const config = readConfig({
    DATA_DIR: dir,
    ENABLE_PAID_GENERATION: String(paid),
    ELEVENLABS_VOICE_ID: "voice-from-test-provider",
  });
  const store = new AudioStore(dir),
    demo = store.seedDemo("assets/test-voice.wav");
  const service = new VoiceService(config, store, demo, provider);
  return {
    config,
    store,
    service,
    dir,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const input = generationSchema.parse({
  text: "Testing a request",
  request_id: "request-1",
  confirm_paid_generation: true,
});
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
      await new Promise((r) => setTimeout(r, 15));
      if (fail)
        throw new SafeError("GENERATION_UNCERTAIN", "Uncertain test outcome");
      const pcm = Buffer.alloc(48000);
      for (let i = 0; i < 24000; i++)
        pcm.writeInt16LE(
          Math.round(Math.sin(i / 12) * 10000 * (i / 24000)),
          i * 2,
        );
      return pcm;
    },
  };
}
test("real fixture duration and 64 waveform samples come from WAV samples", () => {
  const analysis = analyzeWav(readFileSync("assets/test-voice.wav"));
  assert.equal(analysis.durationSeconds, 9.105);
  assert.equal(analysis.waveform.length, 64);
  assert.ok(new Set(analysis.waveform).size > 40);
  assert.equal(Math.max(...analysis.waveform), 1);
  const samples = Buffer.alloc(48000);
  for (let i = 24000; i < 48000; i += 2) samples.writeInt16LE(16384, i);
  const known = analyzeWav(pcmToWav(samples));
  assert.equal(known.durationSeconds, 1);
  assert.equal(known.waveform[0], 0);
  assert.equal(known.waveform[63], 1);
  assert.throws(() => analyzeWav(Buffer.alloc(50)));
  assert.throws(() => pcmToWav(Buffer.alloc(3)));
});
test("audio and signing key survive reopening; media signatures reject expiry and tampering", () => {
  const c = context();
  const original = c.service.result("demo");
  const id = original.structuredContent.audioId;
  const link = new URL(original._meta.playback.url);
  assert.ok(
    c.store.verify(
      id,
      link.searchParams.get("expires"),
      link.searchParams.get("sig"),
    ),
  );
  assert.ok(!c.store.verify(id, "1", link.searchParams.get("sig")));
  assert.ok(
    !c.store.verify(id, link.searchParams.get("expires"), "0".repeat(64)),
  );
  c.store.close();
  const reopened = new AudioStore(c.dir);
  assert.equal(reopened.get(id, "lavender").durationSeconds, 9.105);
  assert.ok(
    reopened.verify(
      id,
      link.searchParams.get("expires"),
      link.searchParams.get("sig"),
    ),
  );
  reopened.close();
  rmSync(c.dir, { recursive: true, force: true });
});
test("paid generation is disabled by default and explicit confirmation is required", async () => {
  const provider = mockProvider(),
    c = context(false, provider);
  try {
    await assert.rejects(c.service.generate(input), {
      code: "PAID_GENERATION_DISABLED",
    });
    assert.equal(provider.calls, 0);
    assert.throws(() => generationSchema.parse({ text: "no permission" }));
    assert.equal(c.service.result("demo").structuredContent.source, "test");
  } finally {
    c.close();
  }
});
test("concurrent and repeated identical requests generate once, including after restart", async () => {
  const provider = mockProvider(),
    c = context(true, provider);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => c.service.generate(input)),
  );
  assert.equal(provider.calls, 1);
  assert.equal(
    new Set(results.map((r) => r.structuredContent.audioId)).size,
    1,
  );
  assert.equal(results[0].structuredContent.durationSeconds, 1);
  const id = results[0].structuredContent.audioId;
  c.store.close();
  const reopened = new AudioStore(c.dir),
    service = new VoiceService(c.config, reopened, id, provider);
  assert.equal((await service.generate(input)).structuredContent.audioId, id);
  assert.equal(provider.calls, 1);
  reopened.close();
  rmSync(c.dir, { recursive: true, force: true });
});
test("request ID reuse with different content is a conflict", async () => {
  const provider = mockProvider(),
    c = context(true, provider);
  try {
    await c.service.generate(input);
    await assert.rejects(
      c.service.generate({ ...input, text: "different text" }),
      { code: "IDEMPOTENCY_CONFLICT" },
    );
    assert.equal(provider.calls, 1);
  } finally {
    c.close();
  }
});
test("uncertain generation is not automatically retried; explicit retry is required", async () => {
  const provider = mockProvider(true),
    c = context(true, provider);
  try {
    await assert.rejects(c.service.generate(input), {
      code: "GENERATION_UNCERTAIN",
    });
    await assert.rejects(c.service.generate(input), {
      code: "GENERATION_NOT_RETRIED",
    });
    assert.equal(provider.calls, 1);
    await assert.rejects(c.service.generate({ ...input, retry_failed: true }), {
      code: "GENERATION_UNCERTAIN",
    });
    assert.equal(provider.calls, 2);
  } finally {
    c.close();
  }
});
test("missing audio does not silently regenerate", () => {
  const provider = mockProvider(),
    c = context(false, provider);
  try {
    assert.throws(() => c.service.result(`vb_${"a".repeat(64)}`), {
      code: "AUDIO_NOT_FOUND",
    });
    assert.equal(provider.calls, 0);
  } finally {
    c.close();
  }
});
test("local mode rejects public exposure; OAuth refuses incomplete configuration", () => {
  assert.throws(() => readConfig({ HOST: "0.0.0.0" }));
  assert.throws(() => readConfig({ PUBLIC_BASE_URL: "https://example.com" }));
  assert.throws(() => readConfig({ AUTH_MODE: "oauth" }));
  assert.throws(() =>
    readConfig({ PUBLIC_BASE_URL: "http://user:pass@127.0.0.1:3000" }),
  );
});
test("ElevenLabs adapter uses server-only key, documented PCM format, settings and real metadata", async () => {
  const c = context();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  c.config.apiKey = "test-secret-must-not-leak";
  const provider = new ElevenLabs(c.config, (async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).includes("/text-to-speech/"))
      return new Response(new Uint8Array([0, 1, 0, 2]));
    if (String(url).endsWith("/v1/models"))
      return Response.json([
        {
          model_id: "real-model-from-api",
          name: "Model",
          can_do_text_to_speech: true,
        },
      ]);
    if (String(url).endsWith("/v1/voices"))
      return Response.json({
        voices: [{ voice_id: "real-voice-from-api", name: "Voice" }],
      });
    return Response.json({ voice_id: "real-voice-from-api" });
  }) as typeof fetch);
  try {
    const catalog = await provider.catalog();
    assert.equal(catalog.voices[0].voice_id, "real-voice-from-api");
    await provider.validate("real-voice-from-api", "real-model-from-api");
    const pcm = await provider.generate(
      "Hello",
      "real-voice-from-api",
      "real-model-from-api",
      {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0,
        use_speaker_boost: true,
        speed: 1,
      },
    );
    assert.equal(pcm.length, 4);
    const call = requests.at(-1)!;
    assert.ok(call.url.endsWith("?output_format=pcm_24000"));
    assert.equal(
      new Headers(call.init!.headers).get("xi-api-key"),
      "test-secret-must-not-leak",
    );
    assert.equal(
      JSON.parse(String(call.init!.body)).model_id,
      "real-model-from-api",
    );
    assert.ok(!JSON.stringify(catalog).includes(c.config.apiKey));
    await assert.rejects(provider.validate("invented", "invalid"), {
      code: "INVALID_VOICE_OR_MODEL",
    });
  } finally {
    c.close();
  }
});
test("provider failures redact response bodies and never retry paid calls", async () => {
  const c = context();
  c.config.apiKey = "private-key";
  let calls = 0;
  const provider = new ElevenLabs(c.config, (async () => {
    calls++;
    return new Response("private-key user text", { status: 500 });
  }) as typeof fetch);
  try {
    await assert.rejects(
      provider.generate("private text", "v", "m", {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0,
        use_speaker_boost: true,
        speed: 1,
      }),
      (e: Error) =>
        !e.message.includes("private-key") &&
        !e.message.includes("private text"),
    );
    assert.equal(calls, 1);
  } finally {
    c.close();
  }
});
