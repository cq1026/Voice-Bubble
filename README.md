# Voice Bubble

个人使用的 ChatGPT MCP App：在对话内显示一条语音消息，通过服务端 ElevenLabs API
生成语音，或直接重播持久保存的音频。使用官方 MCP Apps `ui://` resource 和 bridge，
不是只提供独立播放器网页，也不嵌套 ElevenLabs 插件。

气泡透明背景、左对齐，350 × 62 px，最大宽度 85%；左下角 9 px，其余圆角 26 px。
只有播放/暂停、真实波形、剩余时长、1×/1.5×/2×倍速。默认浅紫 `#eee9fa` / 深紫 `#3e3557`，
可在服务端选择粉色。无自动播放、外层卡片、标题栏、下载按钮或设置面板。

**当前是可运行 MVP。已完成本地协议和浏览器验证；ChatGPT 内实测、真实 OAuth 提供商登录和真实 ElevenLabs 付费生成尚未验证。**
测试音频会明确标注。完整结果见 [验收记录](docs/validation.md)。

实际组件截图（测试音频）：[浅色](docs/screenshots/light.png)、[深色](docs/screenshots/dark.png)、[手机宽度](docs/screenshots/mobile.png)。

## 本地启动

需要 Node.js 24 和 npm；无需数据库服务、FFmpeg 或 ElevenLabs Key 即可播放已有测试音频。
所有命令在仓库根目录执行。

```bash
npm ci
cp .env.example .env
npm run build
npm start
```

默认只监听本机 `127.0.0.1:3000`。MCP 路径 `/mcp`，存活检查 `/healthz`。
开发时运行 `npm run dev`；修改 UI 后重新 `npm run build`，再重新读取 UI resource。
服务不是一个公开播放器主页；组件 HTML 由 MCP `resources/read` 提供给 ChatGPT。

可以用 MCP 客户端调用：

```json
{ "name": "get_voice_bubble", "arguments": { "audio_id": "demo" } }
```

此调用只读取仓库自带的真实语音文件，绝不调用 ElevenLabs。测试方法和本地 iframe
测试宿主见 [验收记录](docs/validation.md)，它只是开发工具，不替代 ChatGPT 接入。

## 工具

| 工具                    | 用途                                                        | 会生成或收费吗     |
| ----------------------- | ----------------------------------------------------------- | ------------------ |
| `get_voice_bubble`      | 按 `audio_id` 读取、重播、刷新签名 URL；`demo` 读取测试音频 | 不会               |
| `list_voice_options`    | 读取 ElevenLabs 账户音色和支持 TTS 的模型                   | 不执行 TTS         |
| `generate_voice_bubble` | 文本转语音、持久存储，返回内嵌气泡                          | 新内容会；默认禁用 |

生成参数：`text`（1–3000 字符）、可选 `voice_id`、`model_id`、`voice_settings`
（stability、similarity_boost、style、use_speaker_boost、speed）、可选 `request_id`，
以及必须显式为 `true` 的 `confirm_paid_generation`。默认音色只来自服务端配置，不虚构 ID。
模型默认 `eleven_multilingual_v2`，生成前会向 ElevenLabs 校验音色和模型。

工具的 `structuredContent` 包含稳定 `audioId`、真实 `durationSeconds`、64 项 RMS 波形、
来源、配色和播放格式；短期签名地址及过期时间只放在组件可见的 `_meta.playback`。
前端不接触 ElevenLabs Key 或 OAuth access token。波形不是转写文本，也不是随机可视化。

## 先播放，后启用付费生成

1. 保持 `ENABLE_PAID_GENERATION=false`，先完成 `demo` 在 ChatGPT 的播放验收。
2. 在服务器环境变量或部署平台的密钥管理器设置 `ELEVENLABS_API_KEY`，不要在聊天里提供它。
3. 调用 `list_voice_options` 或从账户复制真实音色 ID，设置 `ELEVENLABS_VOICE_ID`。
4. 你明确同意启用付费调用后，设置 `ENABLE_PAID_GENERATION=true` 并重启服务。
5. 明确请求一次生成，例如：“使用 Voice Bubble 读出这句话：你好。我确认这次 ElevenLabs 生成会产生费用。”
6. 后续重播用返回的 `audioId` 调用 `get_voice_bubble`，不再生成。

`confirm_paid_generation` 是工具调用的显式确认参数，不能替代宿主的用户授权；
真正的服务端开关仍是默认关闭的 `ENABLE_PAID_GENERATION`。组件只能调用读取工具，不能调用生成工具。
本次开发未启用该开关、未提交真实 ElevenLabs 生成请求。

## 持久化与重复请求

`DATA_DIR`（默认 `.data`）保存 SQLite、WAV 和媒体签名密钥。文本不写入日志或数据库；
内容哈希包含文本、音色、模型、设置和输出格式，相同请求永久复用同一音频。
相同 `request_id` 不能对应不同内容。并发同请求合并；失败和不确定请求落库，重启后也不会自动重试。

HTTP 超时可能发生在上游已经计费之后，系统无法保证跨第三方的绝对 exactly-once。
检查 ElevenLabs 用量后，只有再次明确授权才能使用 `retry_failed: true`；这可能产生第二次费用。
进程崩溃留下的 pending 请求至少等待 180 秒后才允许显式重试。

媒体链接默认 10 分钟有效；打开旧消息或加载失败时，组件通过 bridge 重新读取同一 ID。
获取链接失败时气泡内显示重试状态，不用“重新生成”掩盖错误。永久丢失的数据不会自动补生成。
备份整个 `DATA_DIR`，尤其是 SQLite、WAV 和 `media-signing.key`。SQLite 部署只运行一个应用实例。

## 认证、部署和 ChatGPT 接入

本地 `AUTH_MODE=local` 只允许回环地址，拒绝公开 origin 配置及代理转发头。
线上必须使用 `AUTH_MODE=oauth`。服务校验 JWT 签名、issuer、audience、到期时间、scope，
并且只接受 `OAUTH_OWNER_SUB` 对应的个人账户；其他账户即使能登录也被拒绝。

已提供 Dockerfile、Compose、Caddy HTTPS 配置和持久卷。具体步骤见：

- [部署和 OAuth 配置](docs/deployment.md)
- [逐步接入 ChatGPT 与分阶段验收](docs/chatgpt.md)
- [官方接口核对记录](docs/references.md)

组件设置 `_meta.ui.prefersBorder=false` 及 OpenAI 的 `openai/widgetPrefersBorder=false`。
这只是官方支持的展示请求；ChatGPT 仍可能显示平台标识和容器。项目不注入 DOM、不访问父页面样式，
不修改 ChatGPT 原生消息，也不尝试隐藏平台 UI。

## 开发验证

```bash
npm run typecheck
npm test
# 本机有 Chromium 时：
CHROMIUM_PATH=/usr/bin/chromium npm run test:browser
# 否则先安装 Playwright 对应浏览器，再运行：
npx playwright install chromium
npm run test:browser
```

浏览器测试使用官方 `AppBridge` 和真实 MCP HTTP 调用，在无同源权限的 iframe 内
播放真实音频，并验证 CSP/CORS/拖动/倍速/刷新；不使用模拟播放计时器。
ElevenLabs 网络测试使用隔离的模拟上游，不能视为真实付费服务已验收。

## 目录

```text
src/server/       MCP、认证、媒体分发、SQLite、ElevenLabs
src/ui/           透明语音气泡 React 组件
src/shared/       组件结果契约
assets/           明确标注的预录测试音频
tests/            协议、存储、认证、供应商适配与浏览器验收
docs/             部署、ChatGPT 接入、官方来源、验证结果
deploy/           HTTPS 反向代理
```
