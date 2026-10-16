# Cloudflare 适配验收记录

日期：2026-10-16。工具链 Node.js 24.19.0、Wrangler 4.151.0（配套 Miniflare/workerd）、
实际 Chromium。**生产应用运行于 Workers，不是 Node。以下自动化套件使用本地模拟资源；
2026-10-16 已补充真实线上验证，见 [实际部署记录](deployment-progress.md)。**

## 已验证

- TypeScript 类型检查；Wrangler `deploy --dry-run` 成功。部署包约 799 KiB gzip，无 `nodejs_compat`，
  不导入 `node:fs`、`node:sqlite` 或 Express；UI 与真实 demo WAV 为 Worker 模块。
- 实际执行本地 D1 迁移；`wrangler dev --local` 启动，`/healthz`、MCP demo 和真实 R2 Range 206 成功。
- 27 项服务端测试：使用本地 D1/R2 绑定、生产 Worker bundle 和隔离的模拟上游。
  覆盖真实波形/时长、运行时销毁重建后持久化及旧签名链接、8 个独立服务实例并发去重、
  request ID 竞争冲突、失败后禁止自动重试、过期 pending 的显式重试、旧尝试版本隔离、
  R2 故障、D1 发布事务回滚与 R2 孤立对象保留、对象丢失不生成、默认付费禁用、密钥脱敏，
  以及实际 workerd 内从 MCP 到模拟 ElevenLabs 的并发请求全链路。
- v4/Turbo/v3/v2 参数能力、真实 ID 校验、字符限制、有效设置缓存、PCM 转 WAV、格式拒绝和脱敏错误。Turbo WebSocket 的握手、单音色注册、输入/关闭帧、最终帧、流截断、超时，以及实际 workerd 内 Socket→R2/D1 复用链路均使用模拟上游。
- 真实 workerd MCP 初始化、工具列表、UI resource 的 MIME/CSP/无边框元数据；生产无测试页面。
  R2 音频支持完整内容、HEAD、字节/后缀 Range、206/416、If-Range、CORS 和签名过期刷新。
  OAuth JWT 在 workerd 内验证签名、issuer、audience、本人 sub、scope、过期，JWKS 使用测试 fixture。
- 8 项浏览器测试：官方 AppBridge + sandbox iframe + 真实 Worker MCP/R2 音频。
  验证播放/暂停、点击和拖动波形、1×/1.5×/2×、透明单气泡和深浅主题、320px 手机宽度、
  粉色选项、重开不自动播放、链接过期的只读刷新、加载失败的有界恢复、CSP 拦截。

测试中的 `ENABLE_PAID_GENERATION=true` 只出现在隔离的模拟供应商用例，外部网络被替换/拒绝，
无真实 ElevenLabs API Key。Wrangler 生产配置为 `true`、本地配置仍为 `false`；**真实付费请求为 0**。

## 尚未验证 / 需要你的账户

| 项目 | 当前状态 |
| --- | --- |
| Cloudflare 登录、R2 启用、远端资源创建 | 2026-10-16 已完成；R2 私有、无公开域名 |
| 真实账户 D1 迁移和 Worker 发布 | 已完成；线上 demo 写入 D1/R2 并成功重播 |
| workers.dev 公网 TLS、Cloudflare CPU/用量限制 | 公网 TLS 与 demo 已通过；未做配额或负载压测 |
| D1 跨区域副本/Cloudflare 多地点并发故障 | 未做线上压测；原子 SQL 和版本隔离在本地真实 D1 实现验证 |
| Auth0/其他真实 IdP + ChatGPT OAuth 登录 | Auth0 真实本人令牌、JWKS、MCP 验证通过；本人已确认 ChatGPT 登录和 demo 成功 |
| ChatGPT 内实际气泡、平台容器与无边框请求 | 本人已确认正常显示、播放 demo；平台外框由宿主控制 |
| ChatGPT 手机客户端 / Safari | 未验证；手机宽度仅 Chromium |
| ElevenLabs 真实音质、模型权限和计费 | 未执行真实 TTS；本次授权启用生产开关 |

Cloudflare 部署页面和字段见 [部署指南](cloudflare.md)，ChatGPT 逐项验收见 [接入说明](chatgpt.md)。
旧版的 Docker 验证不作为当前 Workers 部署的证明。

## 复现

```bash
npm ci
npm run check
# 若使用系统 Chromium：
CHROMIUM_PATH=/usr/bin/chromium npm run check
# 没有浏览器时先执行：npx playwright install chromium
```

`npm test` 先打包真实生产 Worker，再以独立本地资源测试；浏览器测试自动构建测试专用入口，
使用临时 D1/R2，并在结束时停止运行时。不需要 Cloudflare 登录。

本云沙箱限制 HOME 写入，因此运行 Wrangler 时把配置和日志定向到忽略目录：

```bash
XDG_CONFIG_HOME="$PWD/.cache/config" WRANGLER_SEND_METRICS=false \
  CHROMIUM_PATH=/usr/bin/chromium npm run check
```

这只是本云开发环境的配置路径，不是线上 Worker 的环境变量。Wrangler 本地启动可能提示无法读取
Cloudflare 的模拟 `Request.cf` 元数据；服务未使用它，本地存储和媒体验证仍通过。

手动查看本地测试宿主：`npm run dev:test` → `http://127.0.0.1:3100/__test/host`。
该入口只编入测试 bundle，不能部署为公开应用。截图保存于 `test-results`；
[浅色](screenshots/light.png)、[深色](screenshots/dark.png)、[手机宽度](screenshots/mobile.png) 为对应组件截图。

## 2026-10-16 正式生成升级发布

GitHub 实现提交 `57bf0ad` 已推送 main；Worker 版本 `ce2969be-379c-4cfd-8150-bfdfc406654a` 已发布。
线上 `/healthz` 返回 paidGeneration:true；默认模型 eleven_v4。三个 Secrets、原 D1 ID、R2 Bucket、Auth0 配置均保留。
现有 demo WAV 的完整读取 200、Range 206 与仓库 fixture SHA-256 一致；此检查使用部署者本地签名的短期媒体链接，
不是重新完成 OAuth 的 MCP 工具调用。旧 owner 登录已过期，发布后带身份的 demo 与 list_voice_options 复查等待本人设备授权。
未发起任何真实付费生成。详见 [本次发布检查](production-validation.json)。
