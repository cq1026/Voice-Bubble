# Cloudflare 部署（workers.dev）

本版将 MCP 和媒体分发实际运行在 Workers：R2 私有 bucket 保存 WAV，D1 保存元数据、
去重记录和任务状态。无需 Node 服务进程、持久磁盘、Docker、自购域名或 Durable Object。

当前状态：代码、生产打包、本地 workerd 的 D1/R2 和播放器已验证；**未部署到你的 Cloudflare 账户**。
本环境 `wrangler whoami` 返回未登录。不会使用临时预览账户替代你的私有持久资源。
全部配置保持 `ENABLE_PAID_GENERATION="false"`；demo 不需要 ElevenLabs Key。

## 1. 账户页面和需要填写的值

进入 [Cloudflare Dashboard](https://dash.cloudflare.com/)，选择你自己的账户。
控制台名称可能随版本调整，以资源名称为准。推荐下一节用 CLI 创建资源；若通过页面创建同名资源，跳过对应 CLI 创建命令。

| 页面 | 操作/填写项 |
| --- | --- |
| Workers & Pages → Overview → 账户的 workers.dev 设置 | 首次使用时注册个人子域；记录 `<你的子域>.workers.dev`。Worker 名固定为 `voice-bubble` |
| Storage & databases → R2 Object Storage | 首次需要由你启用 R2；如果要求账单信息，在 Cloudflare 页面自行填写。创建 bucket：`voice-bubble-audio`，默认位置和 Standard 存储即可 |
| R2 → voice-bubble-audio → Settings | **Public Development URL / r2.dev 保持 Disabled**，不添加 Public Custom Domain；无需 R2 CORS 规则，CORS 由 Worker 返回 |
| Storage & databases → D1 SQL Database → Create database | 名称 `voice-bubble`；创建后复制 Database ID 到 `wrangler.jsonc` 的 `d1_databases[0].database_id` |
| Workers & Pages → voice-bubble → Settings → Domains & Routes | 部署后确认 workers.dev 已启用：`https://voice-bubble.<你的子域>.workers.dev` |
| Workers & Pages → voice-bubble → Bindings | 检查 D1 绑定名 **DB** → `voice-bubble`；R2 绑定名 **AUDIO** → `voice-bubble-audio`。Wrangler 会根据配置自动创建绑定 |
| Workers & Pages → voice-bubble → Settings → Variables and Secrets → Add | Type 选 **Secret**，添加下文的 `MEDIA_SIGNING_KEY`、`OAUTH_OWNER_SUB`。不要选普通 Text，也不要填入前端 |

不要在 GitHub 或聊天中粘贴 Cloudflare token、OAuth client secret、ElevenLabs Key 或媒体签名密钥。
Cloudflare 创建 R2 的账单确认属于你的账户操作；demo 不调用收费 TTS，但 Cloudflare 自身用量按账户套餐计费。

## 2. 授权和创建资源

在你能完成浏览器登录的终端中，进入仓库：

```bash
npm ci
npx wrangler login
npx wrangler whoami
npx wrangler r2 bucket create voice-bubble-audio
npx wrangler d1 create voice-bubble
```

`wrangler login` 打开 Cloudflare 的授权页面，由你登录并确认。若是无浏览器 CI，使用你自己的
Cloudflare API Token 存入 CI 的 secret；需要账户范围的 Workers Scripts Edit、D1 Edit、Workers R2 Storage Edit，
以及 Wrangler 请求的账户读取权限。优先使用交互登录，不必为本项目把整个账户凭据写入仓库。

编辑 **`wrangler.jsonc`**：

| 字段 | 填写 |
| --- | --- |
| `name` | 保持 `voice-bubble` |
| `workers_dev` | 保持 `true`；`preview_urls` 保持 `false` |
| `d1_databases[0].database_id` | `d1 create` 返回的真实 UUID，替换全零占位符 |
| `vars.PUBLIC_BASE_URL` | `https://voice-bubble.<你的子域>.workers.dev`，不加 `/mcp` 或末尾 `/` |
| `vars.AUTH_MODE` | 保持 `oauth` |
| `vars.OAUTH_ISSUER` | 身份提供商的 issuer，例如你的 Auth0 tenant 的 HTTPS origin，保留其要求的末尾 `/` |
| `vars.OAUTH_JWKS_URL` | 提供商 discovery 文档中的 `jwks_uri` |
| `vars.ENABLE_PAID_GENERATION` | **保持字符串 `"false"`** |

多个 Cloudflare 账户时，让 Wrangler 选择正确账户，或把非秘密的 `account_id` 添加到配置。
`wrangler.local.jsonc` 仅供本机运行，不能用于公开部署；线上 Worker 会拒绝请求 origin 与配置不一致的访问。

## 3. 配置 OAuth 和“仅本人”访问

Workers Secrets 不是一个登录系统。本应用沿用标准 OAuth / JWT，需要现有身份提供商；
Cloudflare Access 的网页登录拦截不能直接替代 ChatGPT 所需的 OAuth MCP 流程。
这里以 Auth0 为例，也可以使用能签发 RS256/ES256 access token 的兼容提供商。

1. [Auth0 Dashboard](https://manage.auth0.com/) → **Applications → APIs → Create API**：
   Name 填 `Voice Bubble`；Identifier 填 `https://voice-bubble.<你的子域>.workers.dev/mcp`；Signing Algorithm 选 RS256。
2. 进入这个 API 的 **Permissions**，添加 permission `voice:use`。配置你的账户/应用能请求这个 scope。
3. **Applications → Applications → Create Application**：名称 `Voice Bubble ChatGPT`，选择适合服务端 OAuth 的 Regular Web Application；
   开启 Authorization Code，并支持 PKCE。将 Client ID / Client Secret 留在提供商与 ChatGPT 的认证配置中，不存进 UI。
4. **Settings → API Authorization Settings → Default Audience**（部分界面在 Advanced）：填上述完整 API identifier。
   确保签发的是有此 audience 的 JWT access token，而非仅访问 `/userinfo` 的 opaque token。
5. **User Management → Users → 你自己的账户 → Details**：复制准确的 `user_id` / subject，例如提供商实际给出的 `sub`，
   稍后作为 `OAUTH_OWNER_SUB` secret；不要填邮箱或自拟 ID。
6. 打开该 tenant 的 OIDC discovery `https://<实际 Auth0 域名>/.well-known/openid-configuration`，
   从中复制 `issuer` 和 `jwks_uri` 到 Wrangler 配置。按实际 tenant 域名填写，不照搬地域域名。
7. 在 ChatGPT 创建应用时，将 **ChatGPT 当前显示的精确 OAuth callback URL** 加入这个 Auth0 应用的
   **Settings → Allowed Callback URLs**，保存。不要猜测旧版 URL 或使用通配符。
8. 如果 ChatGPT 的当前流程要求动态客户端注册，按 OpenAI 官方 Auth0 示例开启 DCR；若界面允许
   手工 client ID/secret，使用上面建立的应用。真实 IdP 流程仍需你登录验收。

服务校验签名、issuer、audience、exp、iat、`voice:use` 和 owner subject。其他登录账户仍被拒绝。
OAuth 保护所有 MCP 工具和 UI resource；音频使用短期签名 URL，不让 iframe 获得 access token。

## 4. 迁移、发布和添加 Secrets

以下命令会修改你已授权的 Cloudflare 账户资源。先完成上面的占位符和 OAuth 元数据填写。

```bash
npm run db:migrate:remote
npm run deploy:check
npm run deploy
npx wrangler secret put MEDIA_SIGNING_KEY
npx wrangler secret put OAUTH_OWNER_SUB
```

- 迁移会在 D1 创建 `audio`、`jobs`、`requests` 三张表；Wrangler 记录迁移版本，重复执行不会重建表。
- `deploy:check` 是离线打包检查，不会上传、建资源或验证账户权限。
- `npm run deploy` 会先检查占位符、OAuth、workers.dev 和付费关闭，再执行真正发布。
- 首次发布尚未设置 secret 时服务返回 503，访问默认拒绝；设置两个 secret 后才可用。
- `MEDIA_SIGNING_KEY` 必须是 **32 随机字节的 64 位小写十六进制字符串**。在你自己的可信终端生成：
  `openssl rand -hex 32`，将输出粘贴到 secret 命令的隐藏输入框或 Cloudflare Secret 字段。不要提交到 Git。
- `OAUTH_OWNER_SUB` 填上节复制的本人 subject。
- `wrangler secret put` 会创建并立即部署新 Worker 版本；若改用 Dashboard，记得点击保存/部署。
- 首次 demo 阶段**不需要** `ELEVENLABS_API_KEY`，也不要启用生成。

部署后的入口：`https://voice-bubble.<你的子域>.workers.dev/mcp`。
R2 首个 demo 对象会在本人成功调用 `get_voice_bubble(audio_id="demo")` 时初始化，无需手工上传 fixture。

## 5. 线上只读检查和 ChatGPT 验收

把以下地址换成自己的真实子域：

```bash
curl --fail https://voice-bubble.<你的子域>.workers.dev/healthz
curl --fail https://voice-bubble.<你的子域>.workers.dev/.well-known/oauth-protected-resource/mcp
curl -i https://voice-bubble.<你的子域>.workers.dev/mcp
```

预期：第一项 `ok:true`、`storage:"d1+r2"`、`paidGeneration:false`；第二项返回正确 resource/issuer；
第三项 **401** 且有 `WWW-Authenticate`。`healthz` 是配置与进程存活检查，真正存储可用性以认证后读取 demo 为准。

然后按 [ChatGPT 接入说明](chatgpt.md) 登录，只读 demo，验证真实声音、暂停、拖动、三档倍速、
重开后的播放和过期链接刷新。浏览器 Network 中音频应来自同一个 workers.dev origin，Range 返回 206。
不要将带 `sig` 查询参数的完整地址贴进公开日志。

如果返回 503：检查两个 secret、OAuth 配置、D1 迁移和绑定；403：检查 PUBLIC_BASE_URL 是否与实际 origin 一致；
401：检查 JWT audience、issuer、scope 和 owner sub。不要以关闭 OAuth 的方式处理公开服务认证问题。

## 6. 升级、数据和故障行为

正常升级：`npm ci` → `npm run db:migrate:remote` → `npm run deploy`。保持同一个 DB 和 bucket 绑定，
不重新创建资源，不运行 DROP 或清空 R2。Worker 版本更新不会删除 D1/R2。

旧 `.data` 目录不是线上存储，也不会自动迁移；本次没有个人付费音频。若你在旧版另有数据，先备份再导入，
不要把运行目录或旧签名密钥直接推送到 GitHub。D1 可用 Time Travel / export 备份；R2 对象需要单独备份。
示例：`npx wrangler d1 export DB --remote --output .cache/voice-bubble-d1.sql`（输出在 Git 忽略目录）。

D1 单条 UPSERT 原子认领任务，使用 `first-primary` session。D1 batch 在同一事务内发布元数据与 ready 状态；
R2 在其之前写入尝试专属对象。D1 提交异常可能留下 R2 孤立对象，保留用于人工核对恢复，不能仅删除任务行然后重发 TTS。
旧尝试的版本校验不能覆盖新结果。任务没有自动重试、cron 或队列；即使 Worker 中断，pending 也持续阻止重复生成。
第三方请求可能已经计费，180 秒后也只能由你明确授权重试。

签名 secret 保持稳定，普通重新发布后旧的未过期链接仍有效。轮换该 secret 会使旧链接立即失效，
但组件只读刷新即可获得新链接，不需要生成。R2 保持私有，避免启用公开 bucket、公共缓存或删除音频的 lifecycle rule。

## 7. CSP、CORS、日志和限制

`PUBLIC_BASE_URL` 是 UI resource 的 `connectDomains` / `resourceDomains` 唯一媒体 origin，
同时提供 OpenAI 对应 CSP 元数据及无边框请求。域名变化后重新部署并在 ChatGPT 刷新应用资源。
媒体由 Worker 验证 HMAC 后流式读取 R2，支持 GET/HEAD、单范围和后缀 Range、206/416、If-Range。
媒体 CORS 为 `*`，无 cookie/credentials，以兼容 sandbox 的 null origin；无签名无法访问。

`observability.enabled=false`，应用不记录正文、令牌、密钥或签名 URL；不要自行开启包含完整 URL 的
请求日志/Logpush。Cloudflare 控制面仍有自己的审计信息，不能承诺平台不记录任何数据。

Worker gzip 包低于 1 MiB。CPU、请求数、D1/R2 用量依你的套餐；本地模拟不执行公网配额限制。
先验证 demo；如 Cloudflare Metrics 出现 CPU 超限，再根据实际套餐调整，不宣称免费套餐下所有长文本都已验证。
ElevenLabs PCM 上限 16 MiB，网络超时 90 秒；读取失败不会自动重新请求付费接口。

## 8. 当前验证边界

已验证：Wrangler dry-run、本地迁移和启动、真实 workerd MCP/UI、D1/R2 持久化与跨实例并发去重、
失败/中断保护、OAuth JWT 和本人校验、真实浏览器播放/拖动/倍速/刷新。

仍需要你的操作：Cloudflare 登录和 R2 启用、真实 D1/bucket 创建、workers.dev 子域和 OAuth 元数据填写、
两个 Secrets、远端迁移与发布、Auth0 和 ChatGPT 登录验收。当前没有创建或修改你的远端账户资源。

真实 ElevenLabs 生成仍未执行。之后你明确要求启用时，添加 `ELEVENLABS_API_KEY` secret、配置真实音色，
并在独立的启用步骤中修改付费开关和 `scripts/check-deploy.mjs` 的 demo 发布保护；不能仅靠聊天参数绕过关闭状态。
