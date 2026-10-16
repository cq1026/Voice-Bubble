# Voice Bubble

个人使用的 ChatGPT MCP App：在对话内显示一条透明背景的语音气泡，通过 ElevenLabs API
生成语音，或重播持久保存的音频。使用官方 MCP Apps `ui://` resource 和 bridge。

**当前运行架构：Cloudflare Workers + 私有 R2 + D1。** Express、Node HTTP 服务、磁盘 SQLite
和 Docker 部署已移除。Node.js 24 仅用于构建、Wrangler 和测试，线上代码使用 Web APIs，
不需要 `nodejs_compat`。生产配置 `ENABLE_PAID_GENERATION=true`，默认模型 `eleven_v4`。首次真实付费生成仍由本人在 ChatGPT 中明确授权；自动测试和部署不生成真实语音。

外观保持不变：左对齐，350 × 62 px、最大宽度 85%；左下角 9px，其余圆角 26px；
浅紫 `#eee9fa` / 深紫 `#3e3557`，可在服务端选择粉色。只有播放/暂停、真实波形、剩余时长和
1×/1.5×/2×倍速，无外层卡片、标题、设置或自动播放。

截图：[浅色](docs/screenshots/light.png)、[深色](docs/screenshots/dark.png)、[手机宽度](docs/screenshots/mobile.png)。

## 本地启动

无需 Cloudflare 登录或 ElevenLabs Key。需要 Node.js 24、npm。

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Wrangler 自动构建 UI，并在 `http://127.0.0.1:8787` 启动本地 workerd；`/mcp` 是 MCP 端点，
`/healthz` 是存活检查。D1/R2 在 `.wrangler/state` 本地模拟并持久保存，**不会访问远端资源**。
`.dev.vars` 的示例签名密钥仅用于本机，生产必须使用随机 Workers Secret。

MCP 客户端调用：

```json
{ "name": "get_voice_bubble", "arguments": { "audio_id": "demo" } }
```

首次读取将仓库自带的 9.105 秒真实 WAV 存到 R2，把真实时长和 64 项 RMS 波形存到 D1。
气泡会标注“测试音频”，不会请求 ElevenLabs。生产没有独立播放器主页。
如需本机手动查看官方 bridge 下的气泡：`npm run dev:test`，打开
`http://127.0.0.1:3100/__test/host`。它使用独立临时数据库，测试宿主不会进入生产部署包。

## Cloudflare 部署

优先使用 `https://voice-bubble.<你的子域>.workers.dev`，不需要买域名或配置 Caddy。

完整的账户页面、填写项、资源绑定、Secrets、OAuth 和发布命令见 **[Cloudflare 部署指南](docs/cloudflare.md)**。
[ChatGPT 接入和验收](docs/chatgpt.md) 在部署完成后执行。

交付包含 `wrangler.jsonc`、仅供回环开发的 `wrangler.local.jsonc`、`migrations/0001_initial.sql`。
公开配置使用 OAuth，只有 `OAUTH_OWNER_SUB` 对应账户能读取 MCP 工具/资源或获得音频链接。
ElevenLabs Key、媒体签名密钥、owner subject 使用 Workers Secrets，不进入组件或工具结果。

## 工具

| 工具 | 用途 | 是否生成 |
| --- | --- | --- |
| `get_voice_bubble` | 读取、重播、刷新链接；`demo` 读取测试音频 | 否 |
| `list_voice_options` | 从 ElevenLabs 获取真实音色 ID、TTS 模型 | 否；需要 API Key |
| `generate_voice_bubble` | 生成、存储并返回气泡 | 新内容收费；必须明确授权 |

生成接受 `text`（1–3000 字符）、可选 `voice_id`、`model_id`、`voice_settings`、`request_id`，
必须包含 `confirm_paid_generation: true`。用户指定模型/音色优先；未指定模型默认 v4，未指定音色则使用服务端默认音色（若未配置则要求选择）。ID 必须从 `list_voice_options` 选择，不按名称猜测。
v4 和 v4 Turbo 只发送 stability、similarity_boost；style、speed、speaker boost 被过滤，播放器倍速保持可用。其他模型按模型能力过滤 Style、Speaker Boost。模型或格式不兼容时明确报错，不降级。
协议、限制与验证边界见 [ElevenLabs 模型兼容说明](docs/elevenlabs-models.md)。
音色和模型在生成前向 ElevenLabs 校验；PCM 响应上限 16 MiB，以控制 Worker 内存。
`structuredContent` 返回稳定音频 ID、时长、波形和播放格式；签名 URL 仅在 `_meta.playback` 中。

## 持久化和计费保护

- R2 只保存 WAV；D1 保存音频元数据、request ID 绑定、任务状态和尝试编号，不保存正文或密钥。
- 相同规范化文本、音色、模型和设置生成相同 ID。D1 原子认领跨 Worker 实例防重，
  不依赖内存锁。并发请求短暂等待已有任务；较慢时返回状态和 ID，稍后只读即可。
- `failed` / `uncertain` / 中断遗留的 `pending` 均不会自动再次生成。只有再次明确授权
  `retry_failed: true` 才能重试；过期 pending 至少等待 180 秒。
- R2 写入与 D1 不支持跨服务事务。先写每次尝试专属的不可变对象，再在 D1 事务中发布元数据和 ready 状态。
  尝试编号校验防止旧请求覆盖新结果。提交异常时保留对象供恢复；不会将异常视为可以免费再生成。
- 已有元数据但 R2 对象丢失时直接报错，即使显式 retry 也不会悄悄补生成。
- 第三方接口计费和网络中断不能保证绝对 exactly-once。重试前必须查看 ElevenLabs 用量。

这里使用 D1 原子 SQL 已足以协调当前短文本任务，未额外引入 Durable Objects、队列或后台自动重试。
签名链接默认 10 分钟；过期或重开时，组件经官方 bridge 调用只读工具刷新同一 ID。
R2 bucket 不公开，只有通过 Worker 校验的短期链接能读取音频，支持 GET/HEAD、字节 Range、CORS。

## 验证

```bash
npm run typecheck
npm test
CHROMIUM_PATH=/usr/bin/chromium npm run test:browser
# 没有系统 Chromium 时先执行：npx playwright install chromium
npm run deploy:check
```

服务端测试使用真实 workerd / D1 / R2 本地实现，OAuth 使用本地签名 JWT 与隔离 JWKS。
浏览器通过官方 AppBridge 在 sandbox iframe 内播放真实 WAV，验证拖动、倍速、重开、链接刷新、CSP。
ElevenLabs 使用模拟上游，测试禁止外网生成。

**2026-10-16 已部署并验证真实 Cloudflare D1/R2、Auth0 本人登录、MCP 和线上 demo 播放。**
MCP：`https://voice-bubble.296056703.workers.dev/mcp`。生产配置已启用付费生成，仍需逐次明确授权。
本人已确认 ChatGPT 内 demo 显示、播放正常，真实音色列表可用；真实付费生成未执行。
本次资源和线上检查见 [实际部署记录](docs/deployment-progress.md)。
详情见 [验收记录](docs/validation.md) 和 [官方来源](docs/references.md)。

## 目录

```text
src/server/       Worker、MCP、OAuth、R2 媒体、D1 协调、ElevenLabs
src/ui/           原有 React 透明语音气泡
src/shared/       组件数据契约
migrations/       D1 SQL 迁移
assets/           真实测试音频
scripts/          UI 构建与部署前配置检查
wrangler*.jsonc   生产/本地绑定
tests/           workerd 存储与协议测试、浏览器验收、测试宿主
docs/            Cloudflare / ChatGPT 步骤和验证边界
```

`_meta.ui.prefersBorder=false` 和 `openai/widgetPrefersBorder=false` 请求无边框展示。
ChatGPT 自己的标识或容器仍由平台决定，不注入宿主 DOM/CSS。
