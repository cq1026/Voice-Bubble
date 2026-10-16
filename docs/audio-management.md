# ChatGPT 音频管理

沿用本人 Auth0 OAuth、Workers、私有 R2 和 D1；不增加管理后台、不改播放器、不保存语音原文。

## 工具

- `list_voice_bubbles`：`limit` 默认 20，范围 1–100；`cursor` 使用上次返回的 `next_cursor`；可选 `source=elevenlabs|demo`。以创建时间、完整 ID 倒序稳定分页。返回 `audio_id`、`source`、`duration_seconds`、`byte_length`、ISO 8601 `created_at`、可空的 `voice_id/model_id`，以及所选来源的 `total_count/total_byte_length`。统计仅针对可用音频元数据，不代表整个 Bucket（例如未发布的恢复对象）的账单大小。
- `get_voice_bubble_download`：完整 `audio_id`，检查记录和 R2 存在，返回 `download_url/expires_at`。默认 10 分钟，原始 WAV，不转码。下载响应带 attachment；过期可重新获取，不重新生成。链接只含 ID、文件版本摘要、过期时间和签名；不含 OAuth、API Key 或 R2 Key。
- `delete_voice_bubble`：完整 `audio_id` 和必填 `confirm_delete:true`。必须先展示具体 ID 并说明永久删除，收到用户明确确认才调用。只支持单条，无批量、通配符或 demo 强制删除选项。身份验证由服务端执行；对话中的“明确确认”由 ChatGPT 按工具说明执行，服务端强制校验确认参数。

例子：“列出最近生成的 10 条”→`list_voice_bubbles(limit=10,source="elevenlabs")`；“播放第 3 条”→用该条实际 ID 调用原 `get_voice_bubble`。名称、顺序、上下文不足以确定目标时，必须询问用户，不能猜 ID。旧音频没有音色/模型 ID 时显示未知，不能声称它对应某个音色。

刷新 ChatGPT 中 Voice Bubble 的工具列表后，应该看到原有三个工具及三个新增工具。

## 删除状态与恢复

1. 原子创建/复用 `audio_deletions` 的 `deleting` 记录，捕获当前 WAV 的不可变对象 Key 和删除操作编号。仅成功保存的非 demo 音频可删除；存在非 ready 生成任务时拒绝。
2. 删除中音频从可用列表消失，播放/下载拒绝，新生成认领及 request ID 插入也被阻止。
3. 仅删除捕获的单个 R2 WAV 对象，绝不遍历或清空 Bucket。
4. D1 单个 batch 事务清理该音频的 requests、ready job、audio，再标记 `deleted`。所有 SQL 都绑定完整 ID 和删除操作编号；延迟的重复删除不能清掉重新生成的记录。
5. R2 或 D1 失败返回 `DELETE_INCOMPLETE`，不宣称成功。已建立的 deleting 标记保留；再次明确确认相同 ID 后调用同一工具即可继续。D1 已提交但响应丢失的情况，再次调用返回 already_deleted。

删除不调用 ElevenLabs。pending（包括租约过期）、failed、uncertain 任务均返回 `DELETE_UNSAFE_JOB`，不清理这些记录，以免掩盖计费不确定性或与晚到结果竞争；本工具不承担这些异常生成任务的人工修复。

成功删除后，关联 job 和 request ID 绑定清除。以后相同内容可重新生成，但仍要求生成开关开启和 `confirm_paid_generation:true`。deleted 标记保留，用于永久撤销旧版无文件版本的播放签名。新链接签名绑定用途（播放/下载）及不可变对象版本；相同确定性 ID 重新生成后，旧播放和下载链接不会重新生效。

服务无法撤回用户已下载的文件或撤销已送达的音频字节。新媒体请求及分段请求会重新检查删除状态，响应使用 private,no-store。

## 数据迁移

`0002_audio_management.sql` 仅增加：

- audio 的可空 voice_id、model_id，旧数据保持 NULL。
- 创建时间分页索引、requests.audio_id 索引。
- audio_deletions 状态表；内部对象 Key/操作编号不通过工具返回。

原 audio/jobs/requests 及 R2 数据保持不变。新生成完成时才写入真实模型、音色 ID。部署先执行增量迁移，再发布 Worker；不重建资源。

## 验证边界

管理功能的删除、失败恢复、并发竞争和重新生成测试均使用本地隔离 D1/R2、模拟付费供应商。生产验证只允许列出、读取、下载、验证鉴权和检查资源；禁止删除现有音频，包含用户指出的 28.4 秒音频，也不生成付费测试音频。通过本地测试不代表已经验证生产删除。
