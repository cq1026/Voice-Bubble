import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { KeyObject } from "node:crypto";
import type { Config } from "./config.js";
import type { RequestHandler } from "express";

export async function verifyOwner(
  token: string,
  config: Config,
  key: JWTVerifyGetKey | KeyObject | CryptoKey | Uint8Array,
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
export function authorization(config: Config): RequestHandler {
  const key =
    config.authMode === "oauth"
      ? createRemoteJWKSet(new URL(config.jwksUrl!))
      : null;
  return async (req, res, next) => {
    if (config.authMode === "local") {
      if (
        req.headers["x-forwarded-for"] ||
        req.headers["x-forwarded-host"] ||
        req.headers.forwarded
      ) {
        res
          .status(403)
          .json({
            error:
              "Local mode cannot be used behind a public proxy. Configure OAuth.",
          });
        return;
      }
      next();
      return;
    }
    const token = req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
    try {
      if (!token) throw new Error();
      await verifyOwner(token, config, key!);
      next();
    } catch {
      res.set(
        "WWW-Authenticate",
        `Bearer resource_metadata="${config.baseUrl}/.well-known/oauth-protected-resource", scope="${config.scope}"`,
      );
      res.status(401).json({ error: "invalid_token" });
    }
  };
}
