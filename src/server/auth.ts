import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Config } from "./config.js";
const keys = new Map<string, JWTVerifyGetKey>();
export async function verifyOwner(
  token: string,
  config: Config,
  key: JWTVerifyGetKey | CryptoKey | Uint8Array,
) {
  const options = {
    issuer: config.issuer,
    audience: config.audience,
    algorithms: ["RS256", "ES256"],
    requiredClaims: ["exp", "sub", "iat"],
  };
  const result =
    typeof key === "function"
      ? await jwtVerify(token, key, options)
      : await jwtVerify(token, key, options);
  if (result.payload.sub !== config.ownerSub) throw new Error("Owner mismatch");
  if (
    typeof result.payload.scope !== "string" ||
    !result.payload.scope.split(" ").includes(config.scope)
  )
    throw new Error("Missing scope");
  return result.payload;
}
export async function authorization(
  request: Request,
  config: Config,
): Promise<Response | null> {
  if (config.authMode === "local") {
    const peer = request.headers.get("cf-connecting-ip");
    // workerd's local server adds this header too; only a loopback peer is allowed.
    if (
      (peer !== null && !["127.0.0.1", "::1"].includes(peer)) ||
      new URL(request.url).origin !== config.baseUrl ||
      ["forwarded", "x-forwarded-for", "x-forwarded-host"].some((h) =>
        request.headers.has(h),
      )
    )
      return Response.json(
        { error: "Local mode cannot be exposed through a proxy" },
        { status: 403 },
      );
    return null;
  }
  try {
    const token = request.headers
      .get("authorization")
      ?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) throw new Error();
    if (!keys.has(config.jwksUrl!))
      keys.set(config.jwksUrl!, createRemoteJWKSet(new URL(config.jwksUrl!)));
    await verifyOwner(token, config, keys.get(config.jwksUrl!)!);
    return null;
  } catch {
    return Response.json(
      { error: "invalid_token" },
      {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${config.baseUrl}/.well-known/oauth-protected-resource", scope="${config.scope}"`,
          "Cache-Control": "no-store",
        },
      },
    );
  }
}
