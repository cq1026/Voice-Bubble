import { z } from "zod";

export interface Env {
  DB: D1Database;
  AUDIO: R2Bucket;
  PUBLIC_BASE_URL: string;
  AUTH_MODE: string;
  MEDIA_SIGNING_KEY: string;
  OAUTH_ISSUER?: string;
  OAUTH_JWKS_URL?: string;
  OAUTH_OWNER_SUB?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;
  ELEVENLABS_MODEL_ID?: string;
  ENABLE_PAID_GENERATION?: string;
  BUBBLE_PALETTE?: string;
  MEDIA_URL_TTL_SECONDS?: string;
}
const schema = z.object({
  PUBLIC_BASE_URL: z.url(),
  AUTH_MODE: z.enum(["local", "oauth"]).default("oauth"),
  MEDIA_SIGNING_KEY: z.string().regex(/^[a-f0-9]{64}$/),
  OAUTH_ISSUER: z.url().optional(),
  OAUTH_JWKS_URL: z.url().optional(),
  OAUTH_OWNER_SUB: z.string().min(1).optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  ELEVENLABS_MODEL_ID: z.string().default("eleven_multilingual_v2"),
  ENABLE_PAID_GENERATION: z.enum(["true", "false"]).default("false"),
  BUBBLE_PALETTE: z.enum(["lavender", "pink"]).default("lavender"),
  MEDIA_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
});
export function readConfig(env: Record<string, unknown>) {
  const parsed = schema.safeParse(
    Object.fromEntries(Object.entries(env).filter(([, v]) => v !== "")),
  );
  if (!parsed.success)
    throw new Error(
      `Invalid configuration fields: ${[...new Set(parsed.error.issues.map((i) => i.path[0]))].join(", ")}`,
    );
  const e = parsed.data,
    base = new URL(e.PUBLIC_BASE_URL);
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
      !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
      base.protocol !== "http:"
    )
      throw new Error("Local mode only permits a loopback HTTP origin");
  } else {
    if (
      base.protocol !== "https:" ||
      !e.OAUTH_ISSUER ||
      !e.OAUTH_JWKS_URL ||
      !e.OAUTH_OWNER_SUB
    )
      throw new Error(
        "OAuth requires HTTPS, issuer, JWKS URL and owner subject",
      );
    if (
      ![e.OAUTH_ISSUER, e.OAUTH_JWKS_URL].every(
        (v) => new URL(v).protocol === "https:",
      )
    )
      throw new Error("OAuth endpoints must use HTTPS");
  }
  return {
    baseUrl: base.origin,
    authMode: e.AUTH_MODE,
    issuer: e.OAUTH_ISSUER,
    jwksUrl: e.OAUTH_JWKS_URL,
    ownerSub: e.OAUTH_OWNER_SUB,
    signingKey: e.MEDIA_SIGNING_KEY,
    apiKey: e.ELEVENLABS_API_KEY,
    defaultVoice: e.ELEVENLABS_VOICE_ID,
    defaultModel: e.ELEVENLABS_MODEL_ID,
    paidEnabled: e.ENABLE_PAID_GENERATION === "true",
    palette: e.BUBBLE_PALETTE,
    mediaTtl: e.MEDIA_URL_TTL_SECONDS,
    scope: "voice:use",
    audience: `${base.origin}/mcp`,
  };
}
export type Config = ReturnType<typeof readConfig>;
