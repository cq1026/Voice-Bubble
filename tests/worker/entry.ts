// Test-only entrypoint, never used by wrangler.jsonc or the production bundle.
import worker from "../../src/server/app.js";
import { readConfig, type Env } from "../../src/server/config.js";
import { authorization } from "../../src/server/auth.js";
import host from "../../dist/test-host.html";
import widget from "../../dist/widget.html";
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__test/")) {
      const config = readConfig({ ...env });
      if (config.authMode !== "local")
        return new Response(null, { status: 404 });
      const denied = await authorization(request, config);
      if (denied) return denied;
      const isHost = url.pathname === "/__test/host";
      return new Response(isHost ? host : widget, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": isHost
            ? "default-src 'none'; script-src 'self' 'unsafe-inline'; frame-src 'self'; connect-src 'self'; style-src 'unsafe-inline'"
            : `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src ${config.baseUrl}; connect-src ${config.baseUrl}; img-src data:; base-uri 'none'; form-action 'none'`,
        },
      });
    }
    return worker.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
