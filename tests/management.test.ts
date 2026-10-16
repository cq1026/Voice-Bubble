import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { AudioStore } from "../src/server/store.js";
import { audioId, pcmToWav } from "../src/server/audio.js";
import { VoiceService } from "../src/server/service.js";
import { readConfig } from "../src/server/config.js";
import { listSchema, parseCursor } from "../src/server/management.js";
import { makeRuntime, localBindings, TEST_KEY } from "./worker/runtime.js";
const wav = pcmToWav(new Uint8Array(48000));
const demo = new Uint8Array(readFileSync("assets/test-voice.wav"));
const base = localBindings.PUBLIC_BASE_URL;
async function context() {
  const c = await makeRuntime();
  const store = new AudioStore(c.db, c.bucket, TEST_KEY);
  return { ...c, store };
}
async function save(
  store: AudioStore,
  name = "one",
  metadata?: { voice: string; model: string },
) {
  const id = await audioId(name);
  const token = await store.claim(id, false);
  assert.ok(token);
  await store.complete(id, token, wav, metadata);
  await store.bindRequest("req-" + name, id);
  return id;
}
function bucketWithDelete(
  bucket: R2Bucket,
  remove: (key: string | string[]) => Promise<void>,
) {
  return new Proxy(bucket, {
    get(target, key) {
      if (key === "delete") return remove;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
async function rpc(
  c: Awaited<ReturnType<typeof context>>,
  name: string,
  args: object,
) {
  const response = await c.mf.dispatchFetch(base + "/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as any).result;
}

test("listing is newest first, bounded and cursor paginated with ties, source filter, totals and unknown old metadata", async () => {
  const c = await context();
  try {
    const ids = [];
    for (let i = 0; i < 4; i++)
      ids.push(
        await save(
          c.store,
          String(i),
          i === 3 ? { voice: "kai", model: "eleven_v4" } : undefined,
        ),
      );
    for (const id of ids)
      await c.db
        .prepare("UPDATE audio SET created_at=1000 WHERE id=?")
        .bind(id)
        .run();
    await c.store.seedDemo(demo);
    const first = await c.store.list(2, undefined, "elevenlabs");
    assert.equal(first.total_count, 4);
    assert.equal(first.total_byte_length, 4 * wav.length);
    assert.deepEqual(
      first.items.map((x) => x.audio_id),
      [...ids].sort().reverse().slice(0, 2),
    );
    const next = await c.store.list(
      2,
      parseCursor(first.next_cursor!),
      "elevenlabs",
    );
    assert.equal(next.next_cursor, null);
    assert.equal(
      new Set([...first.items, ...next.items].map((x) => x.audio_id)).size,
      4,
    );
    assert.ok(
      [...first.items, ...next.items].some(
        (x) => x.voice_id === null && x.model_id === null,
      ),
    );
    assert.equal((await c.store.list()).items[0].source, "demo");
    assert.equal((await c.store.list(20, undefined, "demo")).total_count, 1);
    assert.equal(listSchema.parse({}).limit, 20);
    assert.throws(() => listSchema.parse({ limit: 101 }));
    assert.throws(() => parseCursor("garbage"), { code: "INVALID_CURSOR" });
    const live = await rpc(c, "list_voice_bubbles", { limit: 2 });
    assert.equal(live.structuredContent.items.length, 2);
    assert.ok(!JSON.stringify(live).includes("object_key"));
    assert.ok(!JSON.stringify(live).includes("attempt_token"));
  } finally {
    await c.mf.dispose();
  }
});

test("download returns exact original WAV attachment with signed expiry, refresh and purpose isolation", async () => {
  const c = await context();
  try {
    const id = await save(c.store);
    const result = await rpc(c, "get_voice_bubble_download", { audio_id: id });
    assert.ok(!result.isError);
    const url = result.structuredContent.download_url;
    assert.ok(result.content[0].text.includes(url));
    const response = await c.mf.dispatchFetch(url);
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("Content-Disposition"),
      `attachment; filename="${id}.wav"`,
    );
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), wav);
    assert.equal(
      (await c.mf.dispatchFetch(url.replace("/download/", "/audio/"))).status,
      403,
    );
    const expired = await c.store.signedLink(
      id,
      base,
      30,
      "download",
      Date.now() - 60000,
    );
    assert.equal((await c.mf.dispatchFetch(expired.url)).status, 403);
    assert.equal(
      (
        await c.mf.dispatchFetch(
          (await c.store.signedLink(id, base, 30, "download")).url,
        )
      ).status,
      200,
    );
    assert.equal((await c.mf.dispatchFetch(url.split("?")[0])).status, 403);
    const missing = await rpc(c, "get_voice_bubble_download", {
      audio_id: await audioId("missing"),
    });
    assert.equal(missing.isError, true);
    const row = (await c.store.row(id))!;
    await c.bucket.delete(row.object_key);
    await assert.rejects(c.store.signedLink(id, base, 30, "download"), {
      code: "AUDIO_NOT_FOUND",
    });
  } finally {
    await c.mf.dispose();
  }
});

test("explicit single-target confirmation and demo protection are enforced in MCP and storage", async () => {
  const c = await context();
  try {
    const id = await save(c.store);
    for (const args of [
      { audio_id: id },
      { audio_id: id, confirm_delete: false },
      { audio_id: [id], confirm_delete: true },
    ]) {
      assert.equal((await rpc(c, "delete_voice_bubble", args)).isError, true);
      assert.ok(await c.store.row(id));
    }
    await assert.rejects(c.store.deleteAudio(id, false), {
      code: "DELETE_CONFIRMATION_REQUIRED",
    });
    const demoId = await c.store.seedDemo(demo);
    const protectedResult = await rpc(c, "delete_voice_bubble", {
      audio_id: demoId,
      confirm_delete: true,
    });
    assert.match(protectedResult.content[0].text, /DEMO_PROTECTED/);
    assert.ok(await c.store.row(demoId));
  } finally {
    await c.mf.dispose();
  }
});

test("permanent deletion removes only target, revokes links, cleans jobs/requests and is idempotent", async () => {
  const c = await context();
  try {
    const id = await save(c.store),
      other = await save(c.store, "other");
    const row = (await c.store.row(id))!;
    const play = await c.store.playback(id, base, 600),
      download = await c.store.signedLink(id, base, 600, "download");
    const result = await rpc(c, "delete_voice_bubble", {
      audio_id: id,
      confirm_delete: true,
    });
    assert.deepEqual(result.structuredContent, {
      audio_id: id,
      status: "deleted",
    });
    assert.equal(await c.store.row(id), null);
    assert.equal(await c.bucket.head(row.object_key), null);
    assert.equal(await c.store.job(id), null);
    assert.equal(
      await c.db
        .prepare("SELECT 1 FROM requests WHERE audio_id=?")
        .bind(id)
        .first(),
      null,
    );
    assert.equal(
      (await c.store.deleteAudio(id, true)).status,
      "already_deleted",
    );
    assert.equal(
      (await c.store.deleteAudio(await audioId("missing"), true)).status,
      "not_found",
    );
    assert.equal((await c.mf.dispatchFetch(play.url)).status, 403);
    assert.equal((await c.mf.dispatchFetch(download.url)).status, 403);
    assert.deepEqual(
      (await c.store.list()).items.map((x) => x.audio_id),
      [other],
    );
    assert.ok(await c.bucket.head((await c.store.row(other))!.object_key));
  } finally {
    await c.mf.dispose();
  }
});

test("R2 delete failure retains deletion marker, hides audio and blocks generation until explicit deletion retry", async () => {
  const c = await context();
  try {
    const id = await save(c.store);
    const play = await c.store.playback(id, base, 600);
    const failing = new AudioStore(
      c.db,
      bucketWithDelete(c.bucket, async () => {
        throw Error("private failure");
      }),
      TEST_KEY,
    );
    await assert.rejects(failing.deleteAudio(id, true), {
      code: "DELETE_INCOMPLETE",
    });
    assert.equal((await c.store.list()).total_count, 0);
    assert.equal((await c.mf.dispatchFetch(play.url)).status, 403);
    await assert.rejects(c.store.claim(id, true), { code: "AUDIO_DELETING" });
    await assert.rejects(c.store.bindRequest("new-request", id), {
      code: "AUDIO_DELETING",
    });
    assert.equal(
      await c.db
        .prepare("SELECT 1 FROM requests WHERE request_id='new-request'")
        .first(),
      null,
    );
    assert.equal((await c.store.deleteAudio(id, true)).status, "deleted");
  } finally {
    await c.mf.dispose();
  }
});

test("D1 marking failure leaves original data; D1 cleanup failure rolls back and can recover after R2 was removed", async () => {
  const c = await context();
  try {
    const id = await save(c.store),
      key = (await c.store.row(id))!.object_key;
    await c.db
      .prepare(
        "CREATE TRIGGER fail_mark BEFORE INSERT ON audio_deletions BEGIN SELECT RAISE(ABORT,'injected'); END",
      )
      .run();
    await assert.rejects(c.store.deleteAudio(id, true), {
      code: "DELETE_INCOMPLETE",
    });
    assert.ok(await c.store.row(id));
    assert.ok(await c.bucket.head(key));
    await c.db.prepare("DROP TRIGGER fail_mark").run();
    await c.db
      .prepare(
        "CREATE TRIGGER fail_cleanup BEFORE DELETE ON audio BEGIN SELECT RAISE(ABORT,'injected'); END",
      )
      .run();
    await assert.rejects(c.store.deleteAudio(id, true), {
      code: "DELETE_INCOMPLETE",
    });
    assert.equal(await c.bucket.head(key), null);
    assert.equal((await c.store.job(id))!.status, "ready");
    assert.ok(
      await c.db
        .prepare("SELECT 1 FROM requests WHERE audio_id=?")
        .bind(id)
        .first(),
    );
    assert.equal(await c.store.row(id), null);
    await c.db.prepare("DROP TRIGGER fail_cleanup").run();
    assert.equal((await c.store.deleteAudio(id, true)).status, "deleted");
    assert.equal(await c.store.job(id), null);
  } finally {
    await c.mf.dispose();
  }
});

test("pending, failed, uncertain and expired pending tasks cannot be erased or race with completion", async () => {
  const c = await context();
  try {
    const id = await audioId("pending"),
      token = await c.store.claim(id, false, 1);
    for (const status of ["pending", "failed", "uncertain"]) {
      await c.db
        .prepare("UPDATE jobs SET status=? WHERE id=?")
        .bind(status, id)
        .run();
      await assert.rejects(c.store.deleteAudio(id, true), {
        code: "DELETE_UNSAFE_JOB",
      });
      assert.equal((await c.store.job(id))!.status, status);
    }
    await c.db
      .prepare("UPDATE jobs SET status='pending' WHERE id=?")
      .bind(id)
      .run();
    await c.store.complete(id, token!, wav);
    assert.equal((await c.store.deleteAudio(id, true)).status, "deleted");
    // Late old paid completion cannot publish after deletion or create a job.
    await assert.rejects(c.store.complete(id, token!, wav), {
      code: "GENERATION_UNCERTAIN",
    });
    assert.equal(await c.store.row(id), null);
    assert.equal(await c.store.job(id), null);
  } finally {
    await c.mf.dispose();
  }
});

test("concurrent deletion retries are fenced from a new incarnation and new request/job records", async () => {
  const c = await context();
  try {
    const id = await save(c.store);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      started = new Promise<void>((r) => (entered = r));
    const delayed = new AudioStore(
      c.db,
      bucketWithDelete(c.bucket, async (key) => {
        await c.bucket.delete(key);
        entered();
        await gate;
      }),
      TEST_KEY,
    );
    const slow = delayed.deleteAudio(id, true);
    await started;
    await assert.rejects(c.store.claim(id, true), { code: "AUDIO_DELETING" });
    await c.store.deleteAudio(id, true);
    const token = await c.store.claim(id, false);
    assert.ok(token);
    await c.store.complete(id, token, wav);
    await c.store.bindRequest("regenerated", id);
    release();
    await slow;
    assert.ok(await c.store.row(id));
    assert.equal((await c.store.job(id))!.attempt_token, token);
    assert.ok(
      await c.db
        .prepare("SELECT 1 FROM requests WHERE request_id='regenerated'")
        .first(),
    );
    assert.ok(await c.bucket.head((await c.store.row(id))!.object_key));
  } finally {
    await c.mf.dispose();
  }
});

test("deleted deterministic content requires fresh paid authorization; old versioned and legacy links never revive", async () => {
  const c = await context();
  let paid = 0;
  const config = readConfig({
    ...localBindings,
    ENABLE_PAID_GENERATION: "true",
  });
  const provider = {
    catalog: async () => ({ voices: [], models: [] }),
    validate: async () => {},
    generate: async () => {
      paid++;
      return new Uint8Array(48000);
    },
  };
  const service = new VoiceService(config, c.store, demo, provider);
  const input = {
    text: "mock text",
    confirm_paid_generation: true as const,
    retry_failed: false,
    request_id: "same-request",
  };
  try {
    const first = await service.generate(input),
      id = first.structuredContent.audioId;
    const expires = Math.floor(Date.now() / 1000) + 600;
    const sig = createHmac("sha256", Buffer.from(TEST_KEY, "hex"))
      .update(`audio:${id}:${expires}`)
      .digest("hex");
    const legacy = `${base}/audio/${id}.wav?expires=${expires}&sig=${sig}`;
    assert.equal((await c.mf.dispatchFetch(legacy)).status, 200);
    await c.store.deleteAudio(id, true);
    assert.equal(paid, 1);
    await assert.rejects(
      service.generate({ ...input, confirm_paid_generation: undefined } as any),
    );
    assert.equal(paid, 1);
    const next = await service.generate(input);
    assert.equal(next.structuredContent.audioId, id);
    assert.equal(paid, 2);
    assert.equal(
      (await c.mf.dispatchFetch(next._meta.playback.url)).status,
      200,
    );
    assert.equal(
      (await c.mf.dispatchFetch(first._meta.playback.url)).status,
      403,
    );
    assert.equal((await c.mf.dispatchFetch(legacy)).status, 403);
  } finally {
    await c.mf.dispose();
  }
});

test("D1 cleanup committed but reply lost is recoverable without touching another audio", async () => {
  const c = await context();
  try {
    const id = await save(c.store),
      other = await save(c.store, "other");
    let lost = true;
    const db = new Proxy(c.db, {
      get(target, key) {
        if (key === "withSession")
          return (...args: any[]) => {
            const session = (target.withSession as any)(...args);
            return new Proxy(session, {
              get(s, k) {
                if (k === "batch")
                  return async (statements: any[]) => {
                    const result = await s.batch(statements);
                    if (lost) {
                      lost = false;
                      throw Error("response lost after commit");
                    }
                    return result;
                  };
                const value = Reflect.get(s, k);
                return typeof value === "function" ? value.bind(s) : value;
              },
            });
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await assert.rejects(
      new AudioStore(db, c.bucket, TEST_KEY).deleteAudio(id, true),
      { code: "DELETE_INCOMPLETE" },
    );
    assert.equal(
      (await c.store.deleteAudio(id, true)).status,
      "already_deleted",
    );
    assert.ok(await c.store.row(other));
  } finally {
    await c.mf.dispose();
  }
});

test("additive migration preserves existing legacy audio, jobs and requests without fabricating metadata", async () => {
  const c = await makeRuntime({}, false);
  async function apply(file: string) {
    const sql = readFileSync(file, "utf8").replace(/^--.*$/gm, "");
    await c.db.batch(
      sql
        .split(";")
        .filter((x) => x.trim())
        .map((x) => c.db.prepare(x)),
    );
  }
  try {
    await apply("migrations/0001_initial.sql");
    const id = await audioId("legacy-migration"),
      key = "legacy/audio.wav";
    await c.bucket.put(key, wav);
    await c.db
      .prepare("INSERT INTO audio VALUES (?, 'elevenlabs',1,?,?,?,1000)")
      .bind(id, JSON.stringify(Array(64).fill(0)), key, wav.length)
      .run();
    await c.db
      .prepare("INSERT INTO jobs VALUES (?, 'ready','legacy-token',1000,1000)")
      .bind(id)
      .run();
    await c.db
      .prepare("INSERT INTO requests VALUES ('legacy-request',?,1000)")
      .bind(id)
      .run();
    await apply("migrations/0002_audio_management.sql");
    const store = new AudioStore(c.db, c.bucket, TEST_KEY);
    const list = await store.list();
    assert.equal(list.total_count, 1);
    assert.equal(list.items[0].audio_id, id);
    assert.equal(list.items[0].voice_id, null);
    assert.equal(list.items[0].model_id, null);
    assert.ok(await store.job(id));
    assert.ok(
      await c.db
        .prepare("SELECT 1 FROM requests WHERE request_id='legacy-request'")
        .first(),
    );
    assert.equal(
      (await c.mf.dispatchFetch((await store.playback(id, base, 600)).url))
        .status,
      200,
    );
  } finally {
    await c.mf.dispose();
  }
});
