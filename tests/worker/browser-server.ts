import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeRuntime, localBindings } from "./runtime.js";
execFileSync(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "deploy",
    "tests/worker/entry.ts",
    "--config",
    "wrangler.local.jsonc",
    "--dry-run",
    "--outdir",
    "dist/test-worker",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      BUILD_TEST_HOST: "true",
      WRANGLER_SEND_METRICS: "false",
    },
  },
);
const directory = mkdtempSync(path.join(tmpdir(), "vb-browser-"));
const { mf } = await makeRuntime({
  scriptPath: path.resolve("dist/test-worker/entry.js"),
  port: 3100,
  resourcePersistencePath: directory,
  bindings: { ...localBindings, PUBLIC_BASE_URL: "http://127.0.0.1:3100" },
});
console.info(
  "Workers test host ready on http://127.0.0.1:3100/__test/host; paid generation disabled.",
);
async function stop() {
  await mf.dispose();
  rmSync(directory, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
