# Initial demo deployment — 2026-10-16

This document records the initial demo deployment with paid generation disabled. For the subsequent production TTS upgrade, see [model compatibility](elevenlabs-models.md) and [current validation](validation.md).

Cloudflare device OAuth authorization succeeded for account `720f81d5f65520dcc97d1238e0191981`.

## Completed remotely

- Created private R2 bucket `voice-bubble-audio`. Managed public URL disabled; no custom public domains.
- Created D1 `voice-bubble`, ID `2eb77a1c-e09e-49f0-9141-12254a56a41b`.
- Applied `0001_initial.sql` successfully to remote D1.
- Confirmed the account workers.dev subdomain is `296056703`.
- Created the `voice-bubble` Worker record and uploaded a randomly generated `MEDIA_SIGNING_KEY` Workers Secret. Secret listing confirms its presence; its value is not in this repository.
- Filled account ID, database ID and public origin in `wrangler.jsonc`.

`ENABLE_PAID_GENERATION` remains `"false"`. No ElevenLabs key or paid generation was used.

## Validation

- TypeScript check passed.
- Wrangler production dry-run passed (gzip approximately 797 KiB).
- All 20 server tests passed, including workerd D1/R2 and OAuth fixture verification.
- All 8 Chromium tests passed.
- Those automated suites use local resources. Additional live checks are recorded below; ChatGPT itself has not been tested.

## Auth0 and application publication

- Official Auth0 CLI 1.37.0 device login succeeded and persisted for the existing tenant `dev-8wtgry41v4vu7opw.us.auth0.com`.
- Created API `Voice Bubble`, ID `6ad18b620a9be99290309f7f`, identifier `https://voice-bubble.296056703.workers.dev/mcp`, RS256, one permission `voice:use`, 1-hour access tokens.
- Created public native OAuth client `Voice Bubble ChatGPT`, ID `n7shXMEuTBs7DzxO2mOwAhymheFaRkfU`. Supports Authorization Code with PKCE, refresh tokens, and device grant for owner setup. Token endpoint authentication is `none`; ChatGPT does not require a client secret for this public client.
- Registered the documented stable ChatGPT callback `https://chatgpt.com/connector_platform_oauth_redirect`. Auth0 discovery advertises RFC 9207 issuer identification. The actual ChatGPT setup screen must still be checked for the exact callback it selects.
- Confirmed the existing database login connection includes the new application and retains Default App.
- Filled real issuer and JWKS from tenant discovery. Uses the default Auth0 domain; no custom domain, subscription, or trial-only features were enabled.
- Published the application with real D1/R2 bindings. Final active Worker version after owner binding: `d186ea75-40a8-416d-99c2-3c26ab9f50fb` (100% traffic).
- Verified the owner's real Auth0 access token signature, issuer, audience, expiry and `voice:use`; also verified the ID token and matched subjects. Uploaded the verified subject as the `OAUTH_OWNER_SUB` Workers Secret. No credentials are included in this repository.

## Current online checks

The real endpoint is `https://voice-bubble.296056703.workers.dev/mcp`.
| Check | Live result |
| --- | --- |
| `/healthz` | 200, `ok:true`, `storage:d1+r2`, `paidGeneration:false` |
| OAuth protected-resource metadata | 200, real MCP audience and Auth0 issuer |
| Missing or invalid bearer token | 401 with OAuth challenge |
| Authenticated MCP initialization | 200, protocol 2025-11-25 |
| Tools and UI resource | All 3 tools; real HTML resource with correct MIME, CSP, borderless metadata |
| `get_voice_bubble(audio_id="demo")` | Success; 9.105-second WAV, 64 waveform bins, 437118 bytes |
| Downloaded audio hash | Exactly matches repository demo WAV |
| Media GET / HEAD / byte Range | 200 / 200 / 206, correct content length and CORS |
| Unsigned and expired media links | 403 |
| Replay | Same stable audio ID, no generation |
| Remote D1 | One test audio, zero generation jobs and zero generation request records |
| Chromium using deployed widget and direct workers.dev audio | Real play, pause, seek, 1×/1.5×/2×; no autoplay |

The Chromium test used the official MCP Apps AppBridge in a local sandbox test host, production widget/data downloaded over authenticated MCP, and direct HTTPS audio requests to the real Worker (206 observed). TLS verification stayed enabled; the environment's Chromium certificate database needed writable access. This does not claim ChatGPT itself was tested.

The initial Auth0 `resource_parameter_profile` was `audience`. Automatic approval rejected the proposed tenant-wide PATCH to `compatibility`; the rejected command did not produce its output file and was not retried. **Two subsequent read-only checks report `resource_parameter_profile: compatibility` and no default audience.** The origin of this intervening change is not established in this session. The setting now supports ChatGPT's RFC 8707 `resource` parameter, so no further mutation or approval is needed for it.

The live `/oauth/device/code` endpoint rejected `resource` as not yet supported, despite current public documentation, so the successful owner setup device flow used `audience`. The separate authorization-code preflight used `resource`, S256 PKCE and the configured ChatGPT callback; Auth0 returned the expected `login_required` response with matching issuer and state. Full ChatGPT authorization-code exchange is still pending actual ChatGPT login.

Next: add the custom MCP server in ChatGPT with the public client ID documented in `chatgpt.md`, log in as the same owner, and test the demo within ChatGPT. No further Cloudflare or Auth0 account setup is currently required. Never disable OAuth to work around authentication errors.

Official references checked on 2026-10-16:

- https://developers.openai.com/plugins/build/auth
- https://auth0.com/docs/api/management/v2/tenants/patch-settings
- https://auth0.com/docs/get-started/authentication-and-authorization-flow/device-authorization-flow
- https://auth0.com/pricing
