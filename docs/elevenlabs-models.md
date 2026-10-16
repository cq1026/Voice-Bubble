# ElevenLabs 模型兼容与生产生成

核对日期：2026-10-16。默认 `eleven_v4`；`model_id` 和 `voice_id` 的显式值优先，名称由 ChatGPT 从实时 `list_voice_options` 匹配，绝不编造 ID。默认音色未配置时必须选择音色。

## 官方协议

- [Create speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)：`POST /v1/text-to-speech/{voice_id}`，服务端 `xi-api-key`，JSON 含 `text`、`model_id`、`voice_settings`。该接口以模型的 `can_do_text_to_speech` 能力判定可用模型。
- [模型列表](https://elevenlabs.io/docs/api-reference/models/list)：读取真实 ID、TTS 能力、Style/Speaker Boost 能力、语言、`maximum_text_length_per_request`。项目上限 3000 字符，若模型返回更低上限则在付费前拒绝。
- [Eleven v4](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/eleven-v4)：两种 v4 变体只有 Stability、Similarity；不支持 Style、Speed 或 SSML。中文、英文等语言由输入文本及所选模型识别，不强制英语。
- [TTS 使用指南](https://elevenlabs.io/docs/eleven-creative/playground/text-to-speech) 明确可通过 Create speech 使用 `eleven_v4`。
- [实时 Dialogue 指南](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tdd) 为 Turbo 使用 `wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input?model_id=eleven_v4_turbo&output_format=pcm_24000`。Worker 通过带密钥请求头的 Upgrade 建立连接，先注册单个 voice 和设置，再发送 inputs，最后 close_socket 刷出短文本。收集 base64 PCM，只有 `is_final:true` 才保存；中途断线、error、超时或非法数据记为 uncertain，不重连、不回退 REST。旧 WebSocket API 参考页仍只写 v3，本实现按更新后的官方实时指南处理 v4。

| 模型 | 设置处理 |
| --- | --- |
| `eleven_v4`、`eleven_v4_turbo` | 仅 stability、similarity_boost；忽略 style、speed、use_speaker_boost |
| `eleven_v3` | stability 为 0/0.5/1；不发送 speaker boost；其他能力按模型列表处理 |
| `eleven_multilingual_v2`、Flash/Turbo 等 TTS 模型 | 保留现有设置；API 明确不支持 Style/Speaker Boost 时过滤 |

Create speech 的输出枚举包含 `pcm_24000`，没有注明 v4 专属格式限制。继续请求 24kHz 单声道 16-bit PCM，在 Worker 封装 WAV；播放器和真实波形计算不变。不请求需要更高套餐的 44.1kHz PCM，也不改用压缩格式。响应非 PCM、为空、奇数字节、流中断或超过 16MiB 时拒绝保存并记录不确定状态，不尝试第二次付费生成。

## 计费与缓存

`ENABLE_PAID_GENERATION=true` 仅开放能力；每次工具请求仍必须包含 `confirm_paid_generation:true`。ChatGPT 只能在本人明确授权时设置此参数。服务端无法独立审计聊天原文，确认参数与本人 OAuth 构成执行边界。

缓存使用规范化文本、真实音色、明确模型、有效设置和 PCM 格式。v4 被忽略的设置不会导致重复计费。保留旧版缓存键的读取兼容、D1 原子认领、request_id 冲突校验、任务状态和显式 retry_failed 机制。生成前的目录/音色查询是只读操作；它们失败时不发起 TTS。

不改数据库结构、R2 Bucket、签名链接、OAuth 或 UI。所有密钥继续使用 Workers Secrets。自动测试的 HTTP 适配器为注入的假 fetch；Worker 集成测试拦截全部出站请求，不会联系真实 TTS。

## 验证边界

模型请求、参数过滤、缓存、错误、PCM→WAV 已有模拟测试。Turbo 的 WebSocket 握手、消息格式、最终帧判定、异常流和实际 workerd Socket→WAV→R2/D1 链路均使用模拟上游测试。真实付费 TTS 未执行，v4/Turbo 的账户端到端兼容及音质仍待本人首次授权验证。模拟通过不代表真实提供方已接受请求。
