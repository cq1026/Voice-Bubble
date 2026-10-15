import path from "node:path";
import { z } from "zod";

const boolean = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");
const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("127.0.0.1"),
  PUBLIC_BASE_URL: z.url().default("http://127.0.0.1:3000"),
  AUTH_MODE: z.enum(["local", "oauth"]).default("local"),
  OAUTH_ISSUER: z.url().optional(),
  OAUTH_JWKS_URL: z.url().optional(),
  OAUTH_OWNER_SUB: z.string().min(1).optional(),
  DATA_DIR: z.string().default(".data"),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  ELEVENLABS_MODEL_ID: z.string().default("eleven_multilingual_v2"),
  ENABLE_PAID_GENERATION: boolean,
  ENABLE_TEST_HOST: boolean,
  BUBBLE_PALETTE: z.enum(["lavender", "pink"]).default("lavender"),
  MEDIA_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
});
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  // Do not include parser details/received values in errors: this input contains credentials.
  const parsed = schema.safeParse(
    Object.fromEntries(Object.entries(env).filter(([, v]) => v !== "")),
  );
  if (!parsed.success)
    throw new Error(
      `Invalid configuration fields: ${[...new Set(parsed.error.issues.map((i) => i.path[0]))].join(", ")}`,
    );
  const e = parsed.data;
  const base = new URL(e.PUBLIC_BASE_URL);
  if (
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  )
    throw new Error(
      "PUBLIC_BASE_URL must be an origin without a path or credentials",
    );
  if (e.AUTH_MODE === "local") {
    if (
      !["127.0.0.1", "localhost", "::1"].includes(e.HOST) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
      base.protocol !== "http:"
    )
      throw new Error(
        "Local mode only supports a loopback listener and loopback HTTP origin. Use OAuth for public access.",
      );
  } else {
    if (
      base.protocol !== "https:" ||
      !e.OAUTH_ISSUER ||
      !e.OAUTH_JWKS_URL ||
      !e.OAUTH_OWNER_SUB
    )
      throw new Error(
        "OAuth requires HTTPS PUBLIC_BASE_URL, OAUTH_ISSUER, OAUTH_JWKS_URL and OAUTH_OWNER_SUB",
      );
    if (
      ![e.OAUTH_ISSUER, e.OAUTH_JWKS_URL].every(
        (v) => new URL(v).protocol === "https:",
      )
    )
      throw new Error("OAuth endpoints must use HTTPS");
    if (e.ENABLE_TEST_HOST)
      throw new Error("The test harness is only available in local mode");
  }
  return {
    port: e.PORT,
    host: e.HOST,
    baseUrl: base.origin,
    authMode: e.AUTH_MODE,
    issuer: e.OAUTH_ISSUER,
    jwksUrl: e.OAUTH_JWKS_URL,
    ownerSub: e.OAUTH_OWNER_SUB,
    dataDir: path.resolve(e.DATA_DIR),
    apiKey: e.ELEVENLABS_API_KEY,
    defaultVoice: e.ELEVENLABS_VOICE_ID,
    defaultModel: e.ELEVENLABS_MODEL_ID,
    paidEnabled: e.ENABLE_PAID_GENERATION,
    testHost: e.ENABLE_TEST_HOST,
    palette: e.BUBBLE_PALETTE,
    mediaTtl: e.MEDIA_URL_TTL_SECONDS,
    scope: "voice:use",
    audience: `${base.origin}/mcp`,
  };
}
export type Config = ReturnType<typeof readConfig>;
