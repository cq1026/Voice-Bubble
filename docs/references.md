# 官方接口核对记录

核对日期：2026-10-15。官方文档网站 `developers.openai.com`、`modelcontextprotocol.io`
和 `elevenlabs.io` 在本云环境返回网络策略 403。因此没有宣称已直接读取这些网站当前页面；
实际阅读的是当天可访问的 **OpenAI 官方示例仓库、MCP 官方 SDK 文档、ElevenLabs 官方 SDK 源码**。
以下记录实际查阅内容和对应版本，方便部署时复核。

## 实际阅读的官方来源

| 官方来源                                                                                                                 | 核对内容                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| [OpenAI MCP App Basics](https://github.com/openai/openai-apps-sdk-examples/tree/main/mcp_app_basics_node)                | `registerAppTool`、`registerAppResource`、`RESOURCE_MIME_TYPE`、`useApp`、`ontoolresult`、Streamable HTTP |
| [OpenAI authenticated example](https://github.com/openai/openai-apps-sdk-examples/tree/main/authenticated_server_python) | OAuth protected resource metadata、Auth0 配置、认证触发                                                   |
| [OpenAI example README](https://github.com/openai/openai-apps-sdk-examples#testing-in-chatgpt)                           | developer mode、添加 app/connector、公开 HTTPS MCP 端点                                                   |
| [MCP Apps OpenAI migration](https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/migrate_from_openai_apps.md) | `_meta.ui.resourceUri`、`prefersBorder` 与 OpenAI 元数据对应关系                                          |
| [MCP Apps CSP/CORS](https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/csp-cors.md)                         | 元数据位于 `contents[]`；connectDomains/resourceDomains                                                   |
| [MCP Apps resource types](https://github.com/modelcontextprotocol/ext-apps/blob/main/src/spec.types.ts)                  | resourceDomains 包含 media-src；prefersBorder=false 请求无边框、无背景                                    |
| [MCP Apps authorization](https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/authorization.md)               | 每服务 OAuth、HTTP 401、issuer/audience 校验                                                              |
| [MCP Apps v2 migration](https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/migrate-to-2.md)                 | v2 分包与兼容的 UI wire protocol                                                                          |
| [ElevenLabs JS SDK](https://github.com/elevenlabs/elevenlabs-js)                                                         | GET /v1/voices、GET /v1/voices/{voice_id}、GET /v1/models、POST /v1/text-to-speech/{voice_id}、pcm_24000  |

读取时的 Git 提交：

- OpenAI examples: `18cc38e78a968712c357bacdc3c79fead5bfc6b4`
- MCP ext-apps: `82221c0c8ce7661efa6771c9d461511b1650495f`（npm `2.0.3`）
- ElevenLabs JS: `278c39c0984ef55590749b92e6d0ef947abcee96`

项目使用 npm 当前发布的 SDK 2.x 分包，确切依赖版本锁定于 `package-lock.json`。
OpenAI 示例有部分仍使用 SDK 1.x 的服务端导入；本项目依据 MCP 官方迁移文档使用 2.x，
内嵌 UI 消息协议保持兼容。没有使用已淘汰的插件 manifest 作为内嵌 UI 方案。

## 官方网站入口（部署者可直接核对）

- https://developers.openai.com/apps-sdk/build/mcp-server
- https://developers.openai.com/apps-sdk/build/chatgpt-ui
- https://developers.openai.com/apps-sdk/reference
- https://developers.openai.com/apps-sdk/build/auth
- https://developers.openai.com/apps-sdk/deploy/connect-chatgpt
- https://modelcontextprotocol.io/extensions/apps/overview
- https://elevenlabs.io/docs/api-reference/text-to-speech/convert

本地测试宿主使用 SDK 的 AppBridge；它能验证协议和真实浏览器行为，但不能替代
ChatGPT 对 resource 元数据的处理、平台容器样式或移动客户端实际兼容性验收。

## Cloudflare 迁移核对

同日访问 `developers.cloudflare.com` 也遇到网络策略 403；实际读取 Cloudflare 官方文档仓库
[cloudflare/cloudflare-docs](https://github.com/cloudflare/cloudflare-docs)，提交
`7bbbb67b7a97eb1a4ea881f6abf120088ecadcee`，并核对安装的 Wrangler / Workers Types / MCP SDK：

- [D1 Worker API](https://developers.cloudflare.com/d1/worker-api/d1-database/)：batch 事务、`withSession("first-primary")`、顺序一致性。
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)：私有绑定、流式 body、Range 参数、写入强一致性。
- [Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)：`.dev.vars` 与 `wrangler secret put`，后者会立即部署新版本。
- [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)：账户子域和 `workers_dev`。
- [Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)：Text/Data 模块、D1/R2 绑定和 observability。
- 安装的 `@modelcontextprotocol/server` 2.3.1：`WebStandardStreamableHTTPServerTransport`、stateless JSON、32 KiB 请求上限、`CfWorkerJsonSchemaValidator`；Workers 中不使用 Node transport 或动态代码生成的校验器。

官方源码核对与本地 workerd 测试不能替代 Cloudflare 账户权限、线上配额或 ChatGPT 的真实接入测试。
