import { readFileSync } from "node:fs";
import { parse, printParseErrorCode } from "jsonc-parser";
const errors = [];
const config = parse(readFileSync("wrangler.jsonc", "utf8"), errors, {
  allowTrailingComma: true,
});
if (errors.length) {
  console.error(
    "Invalid wrangler.jsonc:",
    errors.map((e) => printParseErrorCode(e.error)).join(", "),
  );
  process.exit(1);
}
const checks = [
  [
    config.vars.AUTH_MODE === "oauth",
    "AUTH_MODE must remain oauth for public deployment",
  ],
  [
    config.vars.ENABLE_PAID_GENERATION === "false",
    "This demo release must keep ENABLE_PAID_GENERATION=false",
  ],
  [config.workers_dev === true, "workers_dev must be enabled"],
  [
    /^https:\/\/voice-bubble\.[a-z0-9-]+\.workers\.dev$/.test(
      config.vars.PUBLIC_BASE_URL,
    ),
    "Set PUBLIC_BASE_URL to your exact workers.dev origin",
  ],
  [
    !JSON.stringify(config).includes("YOUR-"),
    "Replace the OAuth issuer/JWKS and workers.dev placeholders",
  ],
  [
    config.d1_databases[0].database_id !==
      "00000000-0000-0000-0000-000000000000",
    "Set the real D1 database_id returned by Cloudflare",
  ],
  [
    !["MEDIA_SIGNING_KEY", "ELEVENLABS_API_KEY", "OAUTH_OWNER_SUB"].some(
      (k) => k in config.vars,
    ),
    "Private settings must use Workers Secrets, not vars",
  ],
];
const failed = checks.filter(([ok]) => !ok);
if (failed.length) {
  for (const [, message] of failed) console.error(message);
  process.exit(1);
}
console.info(
  "Public configuration checked. Wrangler will request Cloudflare authorization if needed.",
);
