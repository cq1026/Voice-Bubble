import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, SignJWT, exportJWK } from "jose";
import { Response as MFResponse, WebSocketPair } from "miniflare";
import { makeRuntime, localBindings } from "./worker/runtime.js";
import { RESOURCE_URI } from "../src/server/mcp.js";
let c: Awaited<ReturnType<typeof makeRuntime>>;
before(async () => {
  c = await makeRuntime();
});
after(async () => {
  await c.mf.dispose();
});
let sequence = 0;
async function rpc(method: string, params: unknown) {
  const response = await c.mf.dispatchFetch(
    `${localBindings.PUBLIC_BASE_URL}/mcp`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    },
  );
  assert.equal(response.status, 200, await response.clone().text());
  const body = (await response.json()) as any;
  assert.ok(!body.error, JSON.stringify(body.error));
  return body.result;
}
test("production Worker bundle handles MCP initialization, tools and official borderless resource", async () => {
  const init = await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assert.equal(init.serverInfo.name, "Voice Bubble");
  const list = await rpc("tools/list", {});
  assert.equal(list.tools.length, 6);
  assert.equal(
    list.tools.find((t: any) => t.name === "get_voice_bubble")._meta.ui
      .resourceUri,
    RESOURCE_URI,
  );
  const resource = await rpc("resources/read", { uri: RESOURCE_URI }),
    item = resource.contents[0];
  assert.equal(item.mimeType, "text/html;profile=mcp-app");
  assert.equal(item._meta.ui.prefersBorder, false);
  assert.equal(item._meta["openai/widgetPrefersBorder"], false);
  assert.deepEqual(item._meta.ui.csp.resourceDomains, [
    localBindings.PUBLIC_BASE_URL,
  ]);
  assert.deepEqual(item._meta.ui.csp.connectDomains, [
    localBindings.PUBLIC_BASE_URL,
  ]);
  assert.ok(!item.text.includes("ELEVENLABS_API_KEY"));
  assert.ok(!item.text.includes(localBindings.MEDIA_SIGNING_KEY));
  assert.equal(
    (await c.mf.dispatchFetch(`${localBindings.PUBLIC_BASE_URL}/__test/host`))
      .status,
    404,
  );
});
test("R2-backed signed media supports real CORS, HEAD, range, suffix, If-Range and invalid ranges", async () => {
  const result = await rpc("tools/call", {
    name: "get_voice_bubble",
    arguments: { audio_id: "demo" },
  });
  assert.equal(result.structuredContent.source, "test");
  assert.equal(result.structuredContent.waveform.length, 64);
  assert.ok(!JSON.stringify(result.structuredContent).includes("sig="));
  const url = result._meta.playback.url;
  const full = await c.mf.dispatchFetch(url),
    bytes = new Uint8Array(await full.arrayBuffer());
  assert.equal(full.status, 200);
  assert.equal(bytes.byteLength, 437118);
  const range = await c.mf.dispatchFetch(url, {
    headers: { Range: "bytes=0-43", Origin: "null" },
  });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("access-control-allow-origin"), "*");
  assert.equal(range.headers.get("access-control-allow-credentials"), null);
  assert.equal(range.headers.get("accept-ranges"), "bytes");
  assert.equal(range.headers.get("content-range"), "bytes 0-43/437118");
  assert.deepEqual(
    new Uint8Array(await range.arrayBuffer()),
    bytes.subarray(0, 44),
  );
  const head = await c.mf.dispatchFetch(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(Number(head.headers.get("content-length")), bytes.length);
  const suffix = await c.mf.dispatchFetch(url, {
    headers: { Range: "bytes=-20" },
  });
  assert.equal(suffix.status, 206);
  assert.deepEqual(
    new Uint8Array(await suffix.arrayBuffer()),
    bytes.slice(-20),
  );
  for (const value of [
    "bytes=9999999-",
    "bytes=20-10",
    "bytes=-0",
    "bytes=0-10,20-30",
    "bytes=-",
    "bad",
  ]) {
    const invalid = await c.mf.dispatchFetch(url, {
      headers: { Range: value },
    });
    assert.equal(invalid.status, 416, value);
    assert.equal(
      invalid.headers.get("content-range"),
      `bytes */${bytes.length}`,
    );
  }
  assert.equal(
    (
      await c.mf.dispatchFetch(url, {
        headers: { Range: "bytes=0-43", "If-Range": '"wrong"' },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await c.mf.dispatchFetch(url, {
        headers: { Range: "bytes=0-43", "If-Range": head.headers.get("etag")! },
      })
    ).status,
    206,
  );
  assert.equal(
    (
      await c.mf.dispatchFetch(url, {
        method: "OPTIONS",
        headers: { Origin: "null", "Access-Control-Request-Headers": "Range" },
      })
    ).status,
    204,
  );
});
test("expired/tampered links are denied; reread returns the same stable ID without generation", async () => {
  const result = await rpc("tools/call", {
    name: "get_voice_bubble",
    arguments: { audio_id: "demo" },
  });
  const expired = await c.mf.dispatchFetch(
    result._meta.playback.url.replace(/expires=\d+/, "expires=1"),
  );
  assert.equal(expired.status, 403);
  assert.equal(expired.headers.get("access-control-allow-origin"), "*");
  assert.equal(
    (
      await c.mf.dispatchFetch(
        result._meta.playback.url.replace(
          /sig=[a-f0-9]+/,
          `sig=${"0".repeat(64)}`,
        ),
      )
    ).status,
    403,
  );
  const refreshed = await rpc("tools/call", {
    name: "get_voice_bubble",
    arguments: { audio_id: result.structuredContent.audioId },
  });
  assert.equal(
    refreshed.structuredContent.audioId,
    result.structuredContent.audioId,
  );
  assert.equal(
    (await c.mf.dispatchFetch(refreshed._meta.playback.url)).status,
    200,
  );
  assert.equal(
    (await c.db
      .prepare("SELECT count(*) AS n FROM jobs")
      .first<{ n: number }>())!.n,
    0,
  );
});
test("MCP rejects arbitrary origins, proxy-exposed local mode, and oversized request bodies", async () => {
  const url = `${localBindings.PUBLIC_BASE_URL}/mcp`;
  assert.equal(
    (
      await c.mf.dispatchFetch(url, {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await c.mf.dispatchFetch(url, {
        method: "OPTIONS",
        headers: { Origin: "https://chatgpt.com" },
      })
    ).status,
    204,
  );
  for (const header of ["X-Forwarded-For", "Forwarded", "CF-Connecting-IP"]) {
    assert.equal(
      (await c.mf.dispatchFetch(url, { headers: { [header]: "203.0.113.1" } }))
        .status,
      403,
    );
  }
  assert.equal(
    (await c.mf.dispatchFetch("https://public.example/mcp")).status,
    403,
  );
  assert.equal(
    (
      await c.mf.dispatchFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: " ".repeat(33000),
      })
    ).status,
    413,
  );
});
test("paid generation stays disabled in the Worker and safe errors never claim success", async () => {
  const result = await rpc("tools/call", {
    name: "generate_voice_bubble",
    arguments: { text: "Test", confirm_paid_generation: true },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /PAID_GENERATION_DISABLED/);
  assert.equal(result.structuredContent, undefined);
  const missing = await rpc("tools/call", {
    name: "get_voice_bubble",
    arguments: { audio_id: `vb_${"b".repeat(64)}` },
  });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /AUDIO_NOT_FOUND/);
});
test("OAuth discovery and owner JWT verification execute inside workerd with a fixture JWKS", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256"),
    jwk = await exportJWK(publicKey);
  const origin = "https://voice-bubble.test-subdomain.workers.dev",
    issuer = "https://identity.example/";
  const bindings = {
    ...localBindings,
    AUTH_MODE: "oauth",
    PUBLIC_BASE_URL: origin,
    OAUTH_ISSUER: issuer,
    OAUTH_JWKS_URL: `${issuer}.well-known/jwks.json`,
    OAUTH_OWNER_SUB: "owner-123",
  };
  let jwksFetches = 0,
    unexpectedFetches = 0;
  const runtime = await makeRuntime({
    bindings,
    outboundService: async (request) => {
      if (request.url === bindings.OAUTH_JWKS_URL) {
        jwksFetches++;
        return MFResponse.json({
          keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }],
        });
      }
      unexpectedFetches++;
      return new MFResponse(null, { status: 503 });
    },
  });
  async function token(overrides: Record<string, unknown> = {}) {
    return new SignJWT({ scope: "voice:use", ...overrides })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(String(overrides.iss ?? issuer))
      .setAudience(String(overrides.aud ?? `${origin}/mcp`))
      .setSubject(String(overrides.sub ?? "owner-123"))
      .setIssuedAt()
      .setExpirationTime((overrides.exp as number) ?? "5m")
      .sign(privateKey);
  }
  async function call(
    jwt?: string,
    name = "get_voice_bubble",
    args: object = { audio_id: "demo" },
  ) {
    return runtime.mf.dispatchFetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
  }
  try {
    const denied = await call();
    assert.equal(denied.status, 401);
    assert.match(
      denied.headers.get("www-authenticate")!,
      /oauth-protected-resource/,
    );
    for (const route of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const metadata = (await (
        await runtime.mf.dispatchFetch(origin + route)
      ).json()) as any;
      assert.equal(metadata.resource, `${origin}/mcp`);
      assert.deepEqual(metadata.authorization_servers, [issuer]);
    }
    const success = await call(await token());
    assert.equal(success.status, 200);
    const result = ((await success.json()) as any).result;
    assert.equal(result.structuredContent.source, "test");
    assert.equal(
      (
        await runtime.mf.dispatchFetch(result._meta.playback.url, {
          headers: { Range: "bytes=0-43" },
        })
      ).status,
      206,
    );
    for (const bad of [
      { sub: "other-person" },
      { aud: "wrong" },
      { iss: "https://attacker.example/" },
      { scope: "other" },
      { exp: 1 },
    ])
      assert.equal((await call(await token(bad))).status, 401);
    assert.equal((await call("not-a-jwt")).status, 401);
    for (const name of [
      "list_voice_bubbles",
      "get_voice_bubble_download",
      "delete_voice_bubble",
    ]) {
      const args =
        name === "list_voice_bubbles"
          ? {}
          : {
              audio_id: result.structuredContent.audioId,
              confirm_delete: true,
            };
      for (const jwt of [
        undefined,
        "invalid",
        await token({ sub: "other-person" }),
        await token({ scope: "other" }),
        await token({ exp: 1 }),
      ])
        assert.equal((await call(jwt, name, args)).status, 401);
    }
    const listed = await call(await token(), "list_voice_bubbles", {});
    assert.equal(
      ((await listed.json()) as any).result.structuredContent.total_count,
      1,
    );
    const downloaded = await call(await token(), "get_voice_bubble_download", {
      audio_id: result.structuredContent.audioId,
    });
    const downloadResult = ((await downloaded.json()) as any).result;
    assert.equal(
      (
        await runtime.mf.dispatchFetch(
          downloadResult.structuredContent.download_url,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await runtime.mf.dispatchFetch(
          `${origin}/delete/${result.structuredContent.audioId}`,
        )
      ).status,
      404,
    );
    assert.equal(
      (await runtime.mf.dispatchFetch(`${origin}/__test/host`)).status,
      404,
    );
    assert.ok(jwksFetches >= 1);
    assert.equal(unexpectedFetches, 0);
  } finally {
    await runtime.mf.dispose();
  }
});
test("full Worker ElevenLabs adapter coalesces concurrent MCP calls against a network-isolated fake upstream", async () => {
  let syntheses = 0;
  const runtime = await makeRuntime({
    bindings: {
      ...localBindings,
      ENABLE_PAID_GENERATION: "true",
      ELEVENLABS_API_KEY: "mock-worker-key",
    },
    outboundService: async (request) => {
      const url = new URL(request.url);
      assert.equal(url.origin, "https://api.elevenlabs.io");
      assert.equal(request.headers.get("xi-api-key"), "mock-worker-key");
      if (url.pathname.startsWith("/v1/text-to-speech/")) {
        syntheses++;
        assert.equal(url.searchParams.get("output_format"), "pcm_24000");
        await new Promise((r) => setTimeout(r, 100));
        return new MFResponse(new Uint8Array(48000));
      }
      if (url.pathname === "/v1/models")
        return MFResponse.json([
          { model_id: "eleven_v4", can_do_text_to_speech: true },
        ]);
      return MFResponse.json({ voice_id: "voice-from-test-provider" });
    },
  });
  async function generate(id: number) {
    const response = await runtime.mf.dispatchFetch(
      `${localBindings.PUBLIC_BASE_URL}/mcp`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "generate_voice_bubble",
            arguments: {
              text: "mocked Worker generation",
              confirm_paid_generation: true,
              request_id: "worker-test",
            },
          },
        }),
      },
    );
    return ((await response.json()) as any).result;
  }
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => generate(i + 1)),
    );
    for (const result of results) {
      assert.ok(!result.isError, JSON.stringify(result.content));
      assert.equal(result.structuredContent.durationSeconds, 1);
    }
    assert.equal(
      new Set(results.map((r) => r.structuredContent.audioId)).size,
      1,
    );
    assert.equal(syntheses, 1);
    const replay = await generate(10);
    assert.equal(
      replay.structuredContent.audioId,
      results[0].structuredContent.audioId,
    );
    assert.equal(syntheses, 1);
    assert.equal(
      (await runtime.mf.dispatchFetch(replay._meta.playback.url)).status,
      200,
    );
    assert.ok(!JSON.stringify(results).includes("mock-worker-key"));
  } finally {
    await runtime.mf.dispose();
  }
});

test("Turbo uses a real workerd WebSocket upgrade with fake upstream and persists complete PCM only once", async () => {
  let sessions = 0;
  const frames: any[] = [];
  const runtime = await makeRuntime({
    bindings: {
      ...localBindings,
      ENABLE_PAID_GENERATION: "true",
      ELEVENLABS_API_KEY: "mock-worker-key",
    },
    outboundService: async (request) => {
      const url = new URL(request.url);
      assert.equal(url.origin, "https://api.elevenlabs.io");
      assert.equal(request.headers.get("xi-api-key"), "mock-worker-key");
      if (url.pathname === "/v1/models")
        return MFResponse.json([
          { model_id: "eleven_v4_turbo", can_do_text_to_speech: true },
        ]);
      if (url.pathname.startsWith("/v1/voices/"))
        return MFResponse.json({ voice_id: "kai-fixture" });
      assert.equal(url.pathname, "/v1/text-to-dialogue/stream-input");
      assert.equal(url.searchParams.get("model_id"), "eleven_v4_turbo");
      assert.equal(url.searchParams.get("output_format"), "pcm_24000");
      assert.equal(request.headers.get("Upgrade"), "websocket");
      sessions++;
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        frames.push(message);
        if (message.close_socket) {
          pair[1].send(JSON.stringify({ audio: btoa("\0".repeat(48000)) }));
          pair[1].send(JSON.stringify({ is_final: true }));
          pair[1].close(1000);
        }
      });
      return new MFResponse(null, { status: 101, webSocket: pair[0] });
    },
  });
  async function generate() {
    const response = await runtime.mf.dispatchFetch(
      `${localBindings.PUBLIC_BASE_URL}/mcp`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "generate_voice_bubble",
            arguments: {
              text: "你好 Hello",
              model_id: "eleven_v4_turbo",
              voice_id: "kai-fixture",
              voice_settings: { speed: 1.2, style: 1 },
              confirm_paid_generation: true,
            },
          },
        }),
      },
    );
    return ((await response.json()) as any).result;
  }
  try {
    const first = await generate();
    assert.ok(!first.isError, JSON.stringify(first));
    assert.equal(first.structuredContent.durationSeconds, 1);
    assert.deepEqual(frames[0], {
      voices: ["kai-fixture"],
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    });
    assert.deepEqual(frames[1], {
      inputs: [
        { text: "你好 Hello", voice_id: "kai-fixture", new_turn: false },
      ],
    });
    assert.deepEqual(frames[2], { close_socket: true });
    assert.equal(
      (await runtime.mf.dispatchFetch(first._meta.playback.url)).status,
      200,
    );
    assert.equal(
      (await generate()).structuredContent.audioId,
      first.structuredContent.audioId,
    );
    assert.equal(sessions, 1);
  } finally {
    await runtime.mf.dispose();
  }
});
