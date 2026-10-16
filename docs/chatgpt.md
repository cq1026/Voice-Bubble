# 将 Voice Bubble 接入 ChatGPT

这是 **ChatGPT App / MCP Apps**，不是浏览器扩展或旧版 ai-plugin manifest 插件。
交付物核心是 MCP 工具 + ChatGPT 内嵌 UI resource。

## 本次已部署配置（2026-10-16）

服务已上线并完成真实 Auth0 本人登录、MCP 和 demo 浏览器播放检查。
当前官方入口为 [ChatGPT Plugins](https://chatgpt.com/plugins) → 加号 → **Add custom MCP server**。
在同一个创建表单中填写：

| 字段 | 值 |
| --- | --- |
| 名称 | Voice Bubble |
| MCP URL | `https://voice-bubble.296056703.workers.dev/mcp` |
| Authentication | OAuth，使用预先注册的客户端 |
| Client ID | `n7shXMEuTBs7DzxO2mOwAhymheFaRkfU` |
| Client Secret | 留空；本项目使用 public client + PKCE，`token_endpoint_auth_method=none` |

登录时使用首次 Voice-Bubble 设备登录时选择的同一应用用户；服务只接受该用户的 subject。
已注册回调 `https://chatgpt.com/connector_platform_oauth_redirect`，Auth0 提供 RFC 9207 issuer identification。
如果当前 ChatGPT 表单显示不同的回调，只提供这个非秘密 URL 让部署者更新，不使用通配符。
不要把客户端密钥、密码或令牌发到聊天。

本人已确认 ChatGPT 内 demo 正常显示并可听到测试音频。接入后使用 `get_voice_bubble(audio_id="demo")`。
当前参考：[官方接入步骤](https://developers.openai.com/plugins/deploy/connect-chatgpt)、
[OAuth 与回调说明](https://developers.openai.com/plugins/build/auth)。下方是通用接入和验收说明。

## 第一步：部署和账户条件

先完成 [Cloudflare 部署说明](cloudflare.md)，准备：

1. 可从外网访问的 HTTPS MCP 地址，路径为 `/mcp`。
2. 已配置的 OAuth 身份提供商、准确的 audience 和你自己的 owner sub。
3. ChatGPT 账户有 developer mode / 自定义 app 或 connector 的权限。菜单名称可能随套餐和界面变化。

官方入口：[Connect from ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)。
本项目核对的是 OpenAI 官方示例中的流程；如果界面没有开发者模式，需要先解决账户功能权限，
而不是更改播放器去绕过平台。

## 第二步：添加应用

1. 在 ChatGPT 设置的 Apps/Connectors 中启用 Developer mode（如果当前界面和账户支持）。
2. 创建自定义 app/connector，名称填 **Voice Bubble**。
3. MCP URL 填 `https://voice-bubble.<你的子域>.workers.dev/mcp`，认证选择 OAuth。
4. 按界面要求填写 OAuth client ID/secret，或使用提供商已开启的动态客户端注册流程。
   将 ChatGPT 显示的回调 URL 加入提供商 allowlist。
5. 使用 `OAUTH_OWNER_SUB` 对应的个人账号授权。授权失败时检查 issuer、audience、`voice:use` scope 和 sub；不要改为公网免认证。
6. 在一个新对话中选择/启用 Voice Bubble。确认工具列表包含 `get_voice_bubble`、
   `list_voice_options`、`generate_voice_bubble`。

## 第三步：先验收已有测试音频

demo 不调用付费 API，生产开关开启时仍可安全测试。向 ChatGPT 发送：

> 使用 Voice Bubble 的 get_voice_bubble，audio_id 设为 demo。只播放已有测试音频，不调用 ElevenLabs 生成。

预期出现一条左对齐的紫色语音气泡，内部时长下方有“测试音频”小字。没有自动播放。
实际音频长 9.105 秒，播放前剩余时长按秒向上取整；它是本地预录测试语音，非 ElevenLabs 成品。

逐项验收：

- 透明背景，仅一条气泡；无自己绘制的卡片、标题、品牌栏或设置面板。
- 点击播放可听到声音，暂停后声音及进度停止。
- 点击波形中段，播放位置确实跳转；拖动可连续定位；触屏同样验证。
- 倍速按 1× → 1.5× → 2× → 1× 切换，声音播放速度随之改变。
- 波形播放区域变色，剩余时长随真实 `audio.currentTime` 变化。
- 切换 ChatGPT 深浅主题；在手机宽度检查气泡不超过容器 85%。
- 关闭并重开对话，点击后同一音频可以再次播放，没有生成请求。
- 超过 10 分钟后重新打开，链接应通过 `get_voice_bubble` 刷新，而不是调用生成工具。

`prefersBorder=false` / `openai/widgetPrefersBorder=false` 已请求无边框；ChatGPT 自身的标识、
工具标签和容器可能保留。这是宿主行为，不使用 CSS/DOM 注入强行移除。

如果只显示文字而没有气泡，先确认当前客户端支持 MCP Apps、工具元数据里存在
`_meta.ui.resourceUri`，以及 `resources/read` 返回 `text/html;profile=mcp-app`。
修改资源或 CSP 后在 ChatGPT 重新加载 app 的工具/资源信息，必要时重新添加 app。

## 第四步：你明确触发一次 ElevenLabs 生成

1. 正式环境已配置 ElevenLabs Secret；发布配置启用 `ENABLE_PAID_GENERATION=true`，默认模型 `eleven_v4`。
2. 在 ChatGPT 的应用设置中刷新 Voice Bubble 工具信息，以读取更新后的模型说明，再在新对话中选择它。
3. 先读取 `list_voice_options`，按真实名称找到音色 ID；重名时选择准确音色。无需修改 Cloudflare 后台。
4. 明确请求：“使用 Eleven v4 和 Kai 的音色朗读：你好，这是我的语音气泡。允许本次付费生成。”
5. ChatGPT 使用真实 `voice_id`、`model_id="eleven_v4"` 和 `confirm_paid_generation: true`。没有明确付费授权时不得调用。
6. 可改说“这次用 Eleven v4 Turbo”或“用 Kai英文版和 multilingual v2”，工具会优先使用指定值。
7. 保存返回的 `audioId`；重播调用 `get_voice_bubble`，相同文本、音色、模型、有效设置也会复用音频。

v4 系列会忽略 `style`、`speed`、`use_speaker_boost`，可设置 `stability` 和 `similarity_boost`。
生成速度设置与播放器的 1×/1.5×/2×播放速度是两回事；后者不变。

失败提示 `GENERATION_NOT_RETRIED` 或 `GENERATION_UNCERTAIN` 时，先查 ElevenLabs
历史/用量。只有你明确愿意再尝试并接受可能的再次费用时才使用 `retry_failed: true`。

## 验证边界

本人已确认 ChatGPT demo 和真实 ElevenLabs 音色列表成功。自动测试仅使用模拟生成响应，
不调用真实付费 TTS。真实 v4/v4 Turbo 音质、账户实际输出格式权限和首次完整生成链路，
仍需本人通过上述明确授权的请求验收。Worker 仅校验 OAuth 本人身份与确认参数；
“用户明确同意”的对话判断由 ChatGPT 按工具说明完成。

## 已保存音频管理

刷新应用工具列表，新增 list_voice_bubbles、get_voice_bubble_download、delete_voice_bubble。
先列出语音，再用返回的实际 ID 播放或下载。需要删除时先核对完整 ID，明确确认后再删除。
旧记录音色/模型未知时不能按名称猜测目标；demo 不能删除。详见 [管理和恢复说明](audio-management.md)。
本次部署不会自动删除任何生产音频；生产删除需要以后由本人独立确认验收。
