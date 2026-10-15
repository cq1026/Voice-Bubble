import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApplication } from "../src/server/app.js";
import { readConfig } from "../src/server/config.js";
import { RESOURCE_URI } from "../src/server/mcp.js";
import { generateKeyPair, SignJWT } from "jose";
import { verifyOwner } from "../src/server/auth.js";
import type { Server } from "node:http";

const directory = mkdtempSync(path.join(tmpdir(), "vb-http-"));
const config = readConfig({
  PORT: "3199",
  PUBLIC_BASE_URL: "http://127.0.0.1:3199",
  DATA_DIR: path.join(directory, ".data"),
});
const runtime = createApplication(config, {
  html: '<!doctype html><div id="test-widget"></div>',
});
let server: Server;
before(async () => {
  await new Promise<void>((resolve, reject) => {
    server = runtime.app.listen(config.port, config.host, (error) =>
      error ? reject(error) : resolve(),
    );
  });
});
after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  runtime.store.close();
  rmSync(directory, { recursive: true, force: true });
});
let id = 1;
async function rpc(method: string, params: unknown) {
  const response = await fetch(`${config.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(!data.error, JSON.stringify(data.error));
  return data.result;
}
test("real HTTP MCP initialization, tools and embedded UI resource metadata", async () => {
  const init = await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assert.equal(init.serverInfo.name, "Voice Bubble");
  const tools = await rpc("tools/list", {});
  assert.equal(tools.tools.length, 3);
  assert.equal(
    tools.tools.find((t: any) => t.name === "get_voice_bubble")._meta.ui
      .resourceUri,
    RESOURCE_URI,
  );
  const resource = await rpc("resources/read", { uri: RESOURCE_URI });
  assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.equal(resource.contents[0]._meta.ui.prefersBorder, false);
  assert.equal(resource.contents[0]._meta["openai/widgetPrefersBorder"], false);
  assert.deepEqual(resource.contents[0]._meta.ui.csp.resourceDomains, [
    config.baseUrl,
  ]);
  assert.deepEqual(resource.contents[0]._meta.ui.csp.connectDomains, [
    config.baseUrl,
  ]);
});
test("MCP audio result uses private metadata for URL and supports CORS, HEAD, byte ranges and expiry", async () => {
  const result = await rpc("tools/call", {
    name: "get_voice_bubble",
    arguments: { audio_id: "demo" },
  });
  assert.equal(result.structuredContent.source, "test");
  assert.equal(result.structuredContent.waveform.length, 64);
  assert.ok(!JSON.stringify(result.structuredContent).includes("sig="));
  const url = result._meta.playback.url;
  const range = await fetch(url, {
    headers: { Range: "bytes=0-43", Origin: "null" },
  });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("access-control-allow-origin"), "*");
  assert.equal(range.headers.get("accept-ranges"), "bytes");
  assert.match(range.headers.get("content-range")!, /^bytes 0-43\//);
  assert.equal((await range.arrayBuffer()).byteLength, 44);
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const suffix = await fetch(url, { headers: { Range: "bytes=-20" } });
  assert.equal(suffix.status, 206);
  assert.equal((await suffix.arrayBuffer()).byteLength, 20);
  const invalid = await fetch(url, { headers: { Range: "bytes=9999999-" } });
  assert.equal(invalid.status, 416);
  const expired = await fetch(url.replace(/expires=\d+/, "expires=1"));
  assert.equal(expired.status, 403);
  const refreshed = await rpc("tools/call", {
    name: "get_voice_bubble",
    arguments: { audio_id: result.structuredContent.audioId },
  });
  assert.equal((await fetch(refreshed._meta.playback.url)).status, 200);
});
test("CORS rejects arbitrary origins on MCP while signed audio needs no credentials", async () => {
  assert.equal(
    (
      await fetch(`${config.baseUrl}/mcp`, {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${config.baseUrl}/mcp`, {
        method: "OPTIONS",
        headers: { Origin: "https://chatgpt.com" },
      })
    ).status,
    204,
  );
  assert.equal(
    (
      await fetch(`${config.baseUrl}/mcp`, {
        headers: { "X-Forwarded-For": "203.0.113.1" },
      })
    ).status,
    403,
  );
});
test("tools return safe errors without pretending a failed generation succeeded", async () => {
  const result = await rpc("tools/call", {
    name: "generate_voice_bubble",
    arguments: {
      text: "Test",
      voice_id: "test-voice",
      confirm_paid_generation: true,
    },
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
test("OAuth verifies signature, issuer, audience, owner, expiry and scope", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const cfg = {
    ...config,
    issuer: "https://identity.example/",
    ownerSub: "owner-123",
    audience: "https://voice.example/mcp",
  };
  async function token(overrides: Record<string, unknown> = {}) {
    return new SignJWT({ scope: "voice:use", ...overrides })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(String(overrides.iss ?? cfg.issuer))
      .setAudience(String(overrides.aud ?? cfg.audience))
      .setSubject(String(overrides.sub ?? cfg.ownerSub))
      .setIssuedAt()
      .setExpirationTime((overrides.exp as number) ?? "5m")
      .sign(privateKey);
  }
  assert.equal(
    (await verifyOwner(await token(), cfg, publicKey)).sub,
    "owner-123",
  );
  for (const bad of [
    { sub: "other-person" },
    { aud: "wrong-audience" },
    { iss: "https://attacker.example/" },
    { scope: "other" },
    { exp: 1 },
  ])
    await assert.rejects(verifyOwner(await token(bad), cfg, publicKey));
  await assert.rejects(verifyOwner("not-a-jwt", cfg, publicKey));
});
