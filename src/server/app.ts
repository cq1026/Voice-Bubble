import express from "express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { authorization } from "./auth.js";
import { AudioStore } from "./store.js";
import { VoiceService } from "./service.js";
import { createMcpServer } from "./mcp.js";
import type { SpeechProvider } from "./elevenlabs.js";

export function createApplication(
  config: Config,
  options: { provider?: SpeechProvider; html?: string } = {},
) {
  const store = new AudioStore(config.dataDir);
  const demoId = store.seedDemo(path.resolve("assets/test-voice.wav"));
  const service = new VoiceService(config, store, demoId, options.provider);
  const html =
    options.html ?? readFileSync(path.resolve("dist/widget.html"), "utf8");
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    next();
  });
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });
  app.use((req, res, next) => {
    const host = req.headers.host;
    const allowed = new Set([new URL(config.baseUrl).host]);
    if (config.authMode === "local") {
      allowed.add(`localhost:${config.port}`);
      allowed.add(`127.0.0.1:${config.port}`);
    }
    if (!host || !allowed.has(host)) {
      res.status(403).json({ error: "Unexpected Host" });
      return;
    }
    next();
  });
  if (config.authMode === "oauth") {
    const metadata = {
      resource: config.audience,
      authorization_servers: [config.issuer],
      scopes_supported: [config.scope],
      bearer_methods_supported: ["header"],
    };
    for (const route of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ])
      app.get(route, (_req, res) => {
        res.set("Access-Control-Allow-Origin", "*").json(metadata);
      });
  }
  app.use("/audio", (req, res, next) => {
    // These are short-lived, signed capability URLs. No cookies or OAuth tokens are used by the iframe.
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Range",
      "Access-Control-Expose-Headers":
        "Accept-Ranges, Content-Range, Content-Length",
      "Cache-Control": "private, no-store",
      "Cross-Origin-Resource-Policy": "cross-origin",
    });
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.get("/audio/:file", (req, res) => {
    const id = req.params.file.replace(/\.wav$/, "");
    if (
      !req.params.file.endsWith(".wav") ||
      !store.verify(id, req.query.expires, req.query.sig)
    ) {
      res
        .status(403)
        .json({
          error:
            "Playback link invalid or expired. Refresh using get_voice_bubble.",
        });
      return;
    }
    if (!store.has(id)) {
      res.sendStatus(404);
      return;
    }
    res.type("audio/wav").set("Content-Disposition", "inline");
    // DATA_DIR defaults to the hidden .data directory. The filename is strictly hash-validated;
    // allow that parent directory without exposing a static directory or arbitrary dotfiles.
    res.sendFile(
      store.path(id),
      {
        acceptRanges: true,
        cacheControl: false,
        lastModified: false,
        dotfiles: "allow",
      },
      (err) => {
        if (err && !res.headersSent)
          res.status((err as { statusCode?: number }).statusCode ?? 404).end();
      },
    );
  });
  app.use("/mcp", (req, res, next) => {
    const origin = req.headers.origin;
    const allowed = new Set([
      config.baseUrl,
      "https://chatgpt.com",
      "https://chat.openai.com",
    ]);
    if (origin && !allowed.has(origin)) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
    if (origin)
      res.set({
        "Access-Control-Allow-Origin": origin,
        Vary: "Origin",
        "Access-Control-Allow-Headers":
          "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id",
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
        "Access-Control-Expose-Headers": "WWW-Authenticate, MCP-Session-Id",
      });
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.use("/mcp", authorization(config), express.json({ limit: "32kb" }));
  app.all("/mcp", async (req, res) => {
    const server = createMcpServer(service, html);
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent)
        res
          .status(500)
          .json({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32603, message: "Internal server error" },
          });
    }
  });
  if (config.testHost && config.authMode === "local") {
    const localOnly = authorization(config);
    app.get("/__test/host", localOnly, (_req, res) => {
      res.set(
        "Content-Security-Policy",
        `default-src 'none'; script-src 'self' 'unsafe-inline'; frame-src 'self'; connect-src 'self'; style-src 'unsafe-inline'`,
      );
      res
        .type("html")
        .send(readFileSync(path.resolve("dist/test-host.html"), "utf8"));
    });
    app.get("/__test/widget", localOnly, (_req, res) => {
      // Match the declared UI resource CSP, including media-src. The real host enforces its own sandbox.
      res.set(
        "Content-Security-Policy",
        `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src ${config.baseUrl}; connect-src ${config.baseUrl}; img-src data:; base-uri 'none'; form-action 'none'`,
      );
      res.type("html").send(html);
    });
  }
  app.use(
    (
      _err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (!res.headersSent)
        res.status(400).json({ error: "Request could not be processed" });
    },
  );
  return { app, store, service };
}
