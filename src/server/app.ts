import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { readConfig, type Env } from "./config.js";
import { authorization } from "./auth.js";
import { AudioStore } from "./store.js";
import { VoiceService } from "./service.js";
import { createMcpServer } from "./mcp.js";
import { media, mediaHeaders } from "./media.js";
import widget from "../../dist/widget.html";
import demo from "../../assets/test-voice.wav";

export async function handleRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url),
    headers = new Headers({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    });
  if (
    url.pathname.startsWith("/audio/") ||
    url.pathname.startsWith("/download/")
  )
    for (const [key, value] of Object.entries(mediaHeaders))
      headers.set(key, value);
  try {
    const config = readConfig({ ...env });
    if (url.origin !== config.baseUrl)
      return new Response("Unexpected origin", { status: 403, headers });
    if (config.authMode === "local") {
      const denied = await authorization(request, config);
      if (denied) return denied;
    }
    if (url.pathname === "/healthz")
      return Response.json(
        { ok: true, storage: "d1+r2", paidGeneration: config.paidEnabled },
        { headers },
      );
    if (
      config.authMode === "oauth" &&
      [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp",
      ].includes(url.pathname)
    ) {
      headers.set("Access-Control-Allow-Origin", "*");
      return Response.json(
        {
          resource: config.audience,
          authorization_servers: [config.issuer],
          scopes_supported: [config.scope],
          bearer_methods_supported: ["header"],
        },
        { headers },
      );
    }
    if (
      url.pathname.startsWith("/audio/") ||
      url.pathname.startsWith("/download/")
    ) {
      const response = await media(
        request,
        new AudioStore(env.DB, env.AUDIO, config.signingKey),
      );
      for (const [key, value] of headers) response.headers.set(key, value);
      return response;
    }
    if (url.pathname !== "/mcp")
      return new Response("Not found", { status: 404, headers });
    const origin = request.headers.get("origin");
    if (
      origin &&
      ![
        config.baseUrl,
        "https://chatgpt.com",
        "https://chat.openai.com",
      ].includes(origin)
    )
      return new Response("Origin not allowed", { status: 403, headers });
    if (origin) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Vary", "Origin");
      headers.set(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id",
      );
      headers.set("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
      headers.set(
        "Access-Control-Expose-Headers",
        "WWW-Authenticate, MCP-Session-Id",
      );
    }
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers });
    const denied = await authorization(request, config);
    if (denied) {
      for (const [key, value] of headers) denied.headers.set(key, value);
      return denied;
    }
    const service = new VoiceService(
      config,
      new AudioStore(env.DB, env.AUDIO, config.signingKey),
      new Uint8Array(demo),
    );
    const server = createMcpServer(service, widget);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: 32 * 1024,
    });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      // JSON-only stateless transport: consume before closing the per-request MCP server.
      const body = response.body ? await response.arrayBuffer() : null;
      const result = new Response(body, {
        status: response.status,
        headers: response.headers,
      });
      for (const [key, value] of headers) result.headers.set(key, value);
      return result;
    } finally {
      await server.close().catch(() => {});
    }
  } catch {
    // Do not log env, provider errors, request bodies, bearer tokens or signed URLs.
    return Response.json(
      {
        error:
          "Service unavailable; check configuration and resource migrations",
      },
      { status: 503, headers },
    );
  }
}
export default { fetch: handleRequest } satisfies ExportedHandler<Env>;
