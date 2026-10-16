import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ElevenLabs,
  generationSchema,
  settingsForModel,
  type Model,
} from "../src/server/elevenlabs.js";
import { readConfig } from "../src/server/config.js";
import { VoiceService } from "../src/server/service.js";
import { AudioStore } from "../src/server/store.js";
import { receiveDialogue } from "../src/server/dialogue.js";
import { analyzeWav, pcmToWav } from "../src/server/audio.js";
import { makeRuntime, localBindings, TEST_KEY } from "./worker/runtime.js";

const models: Model[] = [
  "eleven_v4",
  "eleven_v4_turbo",
  "eleven_v3",
  "eleven_multilingual_v2",
  "eleven_flash_v2_5",
  "eleven_turbo_v2_5",
].map((model_id) => ({
  model_id,
  name: model_id,
  can_do_text_to_speech: true,
  can_use_style: model_id === "eleven_multilingual_v2",
  can_use_speaker_boost: ![
    "eleven_v4",
    "eleven_v4_turbo",
    "eleven_v3",
  ].includes(model_id),
  maximum_text_length_per_request: 3000,
  languages: [
    { language_id: "zh", name: "Chinese" },
    { language_id: "en", name: "English" },
  ],
}));
const demo = new Uint8Array(readFileSync("assets/test-voice.wav"));
class FakeSocket extends EventTarget {
  sent: any[] = [];
  accepted = false;
  closed = false;
  constructor(
    private frames: any[] = [
      { audio: btoa("\0".repeat(48000)) },
      { is_final: true },
    ],
    private earlyClose = false,
  ) {
    super();
  }
  accept() {
    this.accepted = true;
  }
  close() {
    this.closed = true;
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
    if (JSON.parse(raw).close_socket)
      queueMicrotask(() => {
        for (const frame of this.frames)
          this.dispatchEvent(
            new MessageEvent("message", { data: JSON.stringify(frame) }),
          );
        if (this.earlyClose) this.dispatchEvent(new Event("close"));
      });
  }
}
function fixture(response?: () => Response | Promise<Response>) {
  const config = readConfig({
    ...localBindings,
    ENABLE_PAID_GENERATION: "true",
    ELEVENLABS_API_KEY: "fake-test-key",
  });
  const paid: { url: URL; body: any }[] = [];
  const sockets: FakeSocket[] = [];
  const provider = new ElevenLabs(config, (async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.elevenlabs.io");
    if (new Headers(init?.headers).get("Upgrade") === "websocket") {
      const socket = new FakeSocket();
      sockets.push(socket);
      paid.push({ url, body: { model_id: url.searchParams.get("model_id") } });
      if (response) return response();
      return {
        status: 101,
        ok: false,
        webSocket: socket,
        headers: new Headers(),
      } as unknown as Response;
    }
    if (init?.method === "POST") {
      paid.push({ url, body: JSON.parse(String(init.body)) });
      assert.equal(init.redirect, "manual");
      return response
        ? response()
        : new Response(new Uint8Array(48000), {
            headers: { "content-type": "application/octet-stream" },
          });
    }
    if (url.pathname === "/v1/models") return Response.json(models);
    if (url.pathname === "/v1/voices")
      return Response.json({
        voices: [{ voice_id: "kai-real-fixture", name: "Kai" }],
      });
    assert.match(url.pathname, /^\/v1\/voices\//);
    return Response.json({
      voice_id: decodeURIComponent(url.pathname.split("/").at(-1)!),
    });
  }) as typeof fetch);
  return { config, paid, provider, sockets };
}

test("v4 and Turbo omit unsupported settings; previous models honor actual capability flags", () => {
  for (const id of ["eleven_v4", "eleven_v4_turbo"]) {
    assert.deepEqual(
      settingsForModel(id, { style: 1, speed: 0.7, use_speaker_boost: true }),
      { stability: 0.5, similarity_boost: 0.75 },
    );
  }
  const v2 = settingsForModel(
    "eleven_multilingual_v2",
    { speed: 1.2, style: 0.8 },
    models[3],
  );
  assert.equal(v2.speed, 1.2);
  assert.equal(v2.style, 0.8);
  const limited = settingsForModel(
    "eleven_flash_v2_5",
    { style: 1 },
    models[4],
  );
  assert.equal(limited.style, undefined);
  assert.equal(
    settingsForModel("eleven_v3", {}, models[2]).use_speaker_boost,
    undefined,
  );
  assert.throws(() => settingsForModel("eleven_v3", { stability: 0.7 }), {
    code: "UNSUPPORTED_VOICE_SETTINGS",
  });
});

test("all supported models use exact selected voice/model, PCM24 request and correct WAV conversion", async () => {
  const f = fixture();
  const catalog = await f.provider.catalog();
  assert.equal(catalog.models.length, models.length);
  assert.equal(catalog.models[0].languages?.[0].language_id, "zh");
  for (const model of models) {
    const cap = await f.provider.validate(
      "kai-real-fixture",
      model.model_id,
      "你好 Hello Bonjour",
    );
    const pcm = await f.provider.generate(
      "你好 Hello Bonjour",
      "kai-real-fixture",
      model.model_id,
      settingsForModel(model.model_id, {}, cap),
    );
    const request = f.paid.at(-1)!;
    if (model.model_id === "eleven_v4_turbo") {
      assert.equal(request.url.pathname, "/v1/text-to-dialogue/stream-input");
      const socket = f.sockets.at(-1)!;
      assert.deepEqual(socket.sent, [
        {
          voices: ["kai-real-fixture"],
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        },
        {
          inputs: [
            {
              text: "你好 Hello Bonjour",
              voice_id: "kai-real-fixture",
              new_turn: false,
            },
          ],
        },
        { close_socket: true },
      ]);
      assert.equal(socket.closed, true);
    } else {
      assert.equal(request.url.pathname, "/v1/text-to-speech/kai-real-fixture");
      assert.equal(request.body.text, "你好 Hello Bonjour");
    }
    assert.equal(request.url.searchParams.get("output_format"), "pcm_24000");
    assert.equal(request.body.model_id, model.model_id);
    assert.equal(analyzeWav(pcmToWav(pcm)).durationSeconds, 1);
    const wav = pcmToWav(pcm);
    assert.equal(new DataView(wav.buffer).getUint32(24, true), 24000);
  }
  await assert.rejects(
    f.provider.validate("kai-real-fixture", "invented-model"),
    { code: "INVALID_VOICE_OR_MODEL" },
  );
  await assert.rejects(
    f.provider.validate("kai-real-fixture", "eleven_v4", "x".repeat(3001)),
    { code: "MODEL_TEXT_LIMIT" },
  );
  assert.equal(f.paid.length, models.length);
});

test("default v4, explicit model/voice selection, effective-setting reuse and explicit authorization", async () => {
  const runtime = await makeRuntime();
  const f = fixture();
  const service = new VoiceService(
    f.config,
    new AudioStore(runtime.db, runtime.bucket, TEST_KEY),
    demo,
    f.provider,
  );
  const input = {
    text: "你好，Hello",
    confirm_paid_generation: true as const,
    retry_failed: false,
  };
  try {
    await assert.rejects(
      service.generate({ ...input, confirm_paid_generation: undefined } as any),
    );
    assert.equal(f.paid.length, 0);
    const first = await service.generate(input);
    assert.equal(f.paid[0].body.model_id, "eleven_v4");
    assert.equal(
      f.paid[0].url.pathname,
      "/v1/text-to-speech/voice-from-test-provider",
    );
    const again = await service.generate(
      generationSchema.parse({
        ...input,
        voice_settings: { style: 1, speed: 1.2 },
      }),
    );
    assert.equal(
      first.structuredContent.audioId,
      again.structuredContent.audioId,
    );
    assert.equal(f.paid.length, 1);
    const other = await service.generate({
      ...input,
      model_id: "eleven_v4_turbo",
      voice_id: "kai-real-fixture",
    });
    assert.notEqual(
      other.structuredContent.audioId,
      first.structuredContent.audioId,
    );
    assert.equal(f.paid[1].body.model_id, "eleven_v4_turbo");
    assert.equal(f.paid[1].url.pathname, "/v1/text-to-dialogue/stream-input");
    assert.deepEqual(f.sockets[0].sent[0].voices, ["kai-real-fixture"]);
    f.config.paidEnabled = false;
    assert.equal(
      (await service.generate(input)).structuredContent.audioId,
      first.structuredContent.audioId,
    );
    assert.equal(f.paid.length, 2);
  } finally {
    await runtime.mf.dispose();
  }
});

test("rejected model/format has no downgrade or retry, malformed audio is uncertain", async () => {
  for (const status of [400, 422, 429, 500]) {
    const f = fixture(
      () => new Response("private provider details", { status }),
    );
    await assert.rejects(
      f.provider.generate(
        "private text",
        "kai",
        "eleven_v4_turbo",
        settingsForModel("eleven_v4_turbo"),
      ),
      (e: any) => {
        assert.ok(!e.message.includes("private"));
        assert.match(e.message, /不会自动降级/);
        return true;
      },
    );
    assert.equal(f.paid.length, 1);
    assert.equal(f.paid[0].body.model_id, "eleven_v4_turbo");
  }
  for (const response of [
    () => new Response(new Uint8Array(3)),
    () =>
      new Response(new Uint8Array(4), {
        headers: { "content-type": "audio/mpeg" },
      }),
    () => new Response(new TextEncoder().encode("RIFFfakeWAVE")),
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.error(new Error("truncated"));
          },
        }),
      ),
  ]) {
    const f = fixture(response);
    await assert.rejects(
      f.provider.generate(
        "text",
        "kai",
        "eleven_v4",
        settingsForModel("eleven_v4"),
      ),
      { code: "GENERATION_UNCERTAIN" },
    );
    assert.equal(f.paid.length, 1);
  }
});

test("Turbo requires closing final frame; truncation, provider error, invalid base64 and timeout never publish partial PCM", async () => {
  const ok = new FakeSocket([
    { audio: btoa("\0") },
    { is_final_audio_for_turn: true },
    { audio: btoa("\0") },
    { is_final: true },
  ]);
  assert.equal(
    (await receiveDialogue(ok as unknown as WebSocket, "短句", "kai", {}))
      .length,
    2,
  );
  assert.equal(ok.accepted, true);
  for (const frames of [
    [{ audio: btoa("\0\0") }, { is_final_audio_for_turn: true }],
    [{ audio: btoa("\0\0") }, { error: "private account details" }],
    [{ audio: "%%%" }, { is_final: true }],
    [{ audio: btoa("\0") }, { is_final: true }],
    [{ is_final: true }],
  ]) {
    const socket = new FakeSocket(frames, true);
    await assert.rejects(
      receiveDialogue(socket as unknown as WebSocket, "text", "kai", {}),
      (e: any) =>
        e.code === "GENERATION_UNCERTAIN" && !e.message.includes("private"),
    );
    assert.equal(socket.closed, true);
    assert.equal(socket.sent.length, 3);
  }
  const timeout = new FakeSocket([]);
  await assert.rejects(
    receiveDialogue(timeout as unknown as WebSocket, "text", "kai", {}, 5),
    { code: "GENERATION_UNCERTAIN" },
  );
  assert.equal(timeout.closed, true);
});
