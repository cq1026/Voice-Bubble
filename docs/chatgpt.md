# 将 Voice Bubble 接入 ChatGPT

这是 **ChatGPT App / MCP Apps**，不是浏览器扩展或旧版 ai-plugin manifest 插件。
交付物核心是 MCP 工具 + ChatGPT 内嵌 UI resource。

## 第一步：部署和账户条件

先完成 [部署说明](deployment.md)，准备：

1. 可从外网访问的 HTTPS MCP 地址，路径为 `/mcp`。
2. 已配置的 OAuth 身份提供商、准确的 audience 和你自己的 owner sub。
3. ChatGPT 账户有 developer mode / 自定义 app 或 connector 的权限。菜单名称可能随套餐和界面变化。

官方入口：[Connect from ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)。
本项目核对的是 OpenAI 官方示例中的流程；如果界面没有开发者模式，需要先解决账户功能权限，
而不是更改播放器去绕过平台。

## 第二步：添加应用

1. 在 ChatGPT 设置的 Apps/Connectors 中启用 Developer mode（如果当前界面和账户支持）。
2. 创建自定义 app/connector，名称填 **Voice Bubble**。
3. MCP URL 填 `https://你的域名/mcp`，认证选择 OAuth。
4. 按界面要求填写 OAuth client ID/secret，或使用提供商已开启的动态客户端注册流程。
   将 ChatGPT 显示的回调 URL 加入提供商 allowlist。
5. 使用 `OAUTH_OWNER_SUB` 对应的个人账号授权。授权失败时检查 issuer、audience、`voice:use` scope 和 sub；不要改为公网免认证。
6. 在一个新对话中选择/启用 Voice Bubble。确认工具列表包含 `get_voice_bubble`、
   `list_voice_options`、`generate_voice_bubble`。

## 第三步：先验收已有测试音频

保持服务端 `ENABLE_PAID_GENERATION=false`。向 ChatGPT 发送：

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

1. 在服务端安全设置 `ELEVENLABS_API_KEY`；聊天中不要输入 Key。
2. 读取音色列表，设置默认音色 `ELEVENLABS_VOICE_ID`。不要使用本文中虚构的音色 ID，本文没有提供默认假 ID。
3. 你明确同意启用真实付费调用后再开启 `ENABLE_PAID_GENERATION=true` 并重启。
4. 请求一段短句，明确确认本次生成费用。工具参数需带 `confirm_paid_generation: true`。
5. 检查生成的气泡没有“测试音频”标记，可播放真实内容。
6. 记录工具结果里的 `audioId`，再次调用 `get_voice_bubble`；确认没有新生成或额外费用。

失败提示 `GENERATION_NOT_RETRIED` 或 `GENERATION_UNCERTAIN` 时，先查 ElevenLabs
历史/用量。只有你明确愿意再尝试并接受可能的再次费用时才使用 `retry_failed: true`。

## 本次未能代你验证的事项

没有接入你的 ChatGPT 账户、公网域名、OAuth tenant 或 ElevenLabs 密钥，也没有触发真实计费。
因此本地浏览器结果不能标记为 ChatGPT 实测通过；移动 ChatGPT、平台容器最终表现、
真实 OAuth 连接、真实 ElevenLabs 音质和账户模型权限均需按上面步骤验收。
