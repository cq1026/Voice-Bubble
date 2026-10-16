import {
  Miniflare,
  convertV4MiniflareOptions,
  Response as MFResponse,
  type V4MiniflareOptions,
} from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
export const TEST_KEY = "f".repeat(64); // Test-only key, never used in production.
export const localBindings = {
  AUTH_MODE: "local",
  PUBLIC_BASE_URL: "http://127.0.0.1:8787",
  MEDIA_SIGNING_KEY: TEST_KEY,
  ENABLE_PAID_GENERATION: "false",
  ELEVENLABS_VOICE_ID: "voice-from-test-provider",
};
export async function makeRuntime(
  options: Partial<V4MiniflareOptions> = {},
  migrate = true,
) {
  const { scriptPath = path.resolve("dist/worker/app.js"), ...extra } =
    options as Partial<V4MiniflareOptions> & { scriptPath?: string };
  const directory = path.dirname(scriptPath);
  const modules = [
    { type: "ESModule" as const, path: scriptPath },
    ...readdirSync(directory)
      .filter((name) => /\.(html|wav)$/.test(name))
      .map((name) => ({
        type: name.endsWith(".html") ? ("Text" as const) : ("Data" as const),
        path: path.join(directory, name),
      })),
  ];
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: "voice-bubble-test",
      modules,
      modulesRoot: directory,
      compatibilityDate: "2026-10-01",
      cf: false,
      host: "127.0.0.1",
      d1Databases: { DB: "test-db" },
      r2Buckets: { AUDIO: "test-audio" },
      bindings: localBindings,
      // No network can reach ElevenLabs during tests. OAuth tests explicitly replace this with a JWKS fixture.
      outboundService: async () =>
        new MFResponse("External network disabled in tests", { status: 503 }),
      ...extra,
    } as V4MiniflareOptions),
  );
  await mf.ready;
  const db = await mf.getD1Database("DB"),
    bucket = await mf.getR2Bucket("AUDIO");
  if (migrate) {
    const sql = readdirSync("migrations")
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => readFileSync(path.join("migrations", name), "utf8"))
      .join("\n")
      .replace(/^--.*$/gm, "");
    await db.batch(
      sql
        .split(";")
        .filter((s) => s.trim())
        .map((s) => db.prepare(s)),
    );
  }
  return {
    mf,
    db: db as unknown as D1Database,
    bucket: bucket as unknown as R2Bucket,
  };
}
