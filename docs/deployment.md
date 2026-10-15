# 部署与个人认证

## 最小部署条件

播放已有音频需要：一个 ChatGPT 能访问的 HTTPS 域名、持久磁盘、支持 OAuth/JWT 的身份提供商。
不需要 ElevenLabs Key。真实生成额外需要你自己的 ElevenLabs Key、真实音色 ID 和明确启用付费。

当前交付包含配置，不代表已经把应用发布到公网。云开发环境的“发布”也不自动等于
部署一个公网 MCP 服务；ChatGPT 需要可访问的服务 URL。

## OAuth（以 Auth0 为例）

采用 OpenAI 官方认证示例同类架构：OAuth 登录由成熟身份提供商负责，本服务只验证 access token。
不自制密码登录页，不把固定 bearer 密钥写进组件。

1. 在 Auth0 建立 tenant 和 API。API identifier 必须与 `https://你的域名/mcp` 完全一致，签名使用 RS256。
2. 给 API 定义 `voice:use` permission/scope，并让你的用户有权获得该 scope。
3. 建立用于 ChatGPT 的 OAuth 应用，启用 Authorization Code 和 PKCE；如需长会话，按提供商设置 refresh token / offline access。
4. 在 ChatGPT 新建 app/connector 时，使用界面显示的 OAuth callback URL，把它精确加入提供商允许的回调列表。
   不从旧教程猜测或通配回调 URL。把 provider 的 client ID/secret 放入 ChatGPT 的 OAuth 配置，**不放在播放器中**。
5. 若所用 ChatGPT 流程使用动态客户端注册，按 OpenAI 官方示例在 tenant 开启 DCR；如果界面支持手工 client ID/secret，则使用上一步建立的应用。
6. 对 Auth0，配置 Default Audience 为 API identifier，确保 access token 是针对该 API 的 JWT，而不是仅给 `/userinfo` 用的 opaque token。
7. 从提供商的 OIDC/OAuth 元数据复制精确 issuer（包含可能存在的尾部 `/`）与 `jwks_uri`。
8. 将你自己的用户 `sub` 配置为 `OAUTH_OWNER_SUB`。这是限制个人使用的最终校验；其他用户即使登录成功也无法调用工具。

生产环境必须设置：

```dotenv
AUTH_MODE=oauth
HOST=0.0.0.0
PUBLIC_BASE_URL=https://你的域名
OAUTH_ISSUER=https://你的身份提供商域名/
OAUTH_JWKS_URL=https://你的身份提供商域名/.well-known/jwks.json
OAUTH_OWNER_SUB=从身份提供商复制的你的用户sub
ENABLE_PAID_GENERATION=false
```

上面的值是说明占位符，不能直接运行。实际域名及 issuer/JWKS 依提供商为准。
服务发布 OAuth protected resource metadata 于 `/.well-known/oauth-protected-resource`
及 `/.well-known/oauth-protected-resource/mcp`。未认证 `/mcp` 返回 HTTP 401 和
`WWW-Authenticate` discovery hint；授权服务器发现由真实身份提供商处理。

## Docker Compose + Caddy

准备一台有 Docker Compose 的服务器，将域名 A/AAAA 指向它，并允许入站 80/443。
在仓库根目录：

```bash
cp .env.example .env
# 编辑 .env：填 VOICE_BUBBLE_DOMAIN（仅主机名），以及上述 OAuth 元数据。
# 初次保持 ENABLE_PAID_GENERATION=false，不需要填 ElevenLabs Key。
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

Compose 会覆盖开发用的 HOST/AUTH_MODE/PUBLIC_BASE_URL，强制 OAuth 和 HTTPS。
Caddy 自动处理证书，反向代理到应用内部端口；应用的 3000 端口不发布到宿主公网。
不要改成 `AUTH_MODE=local` 后通过隧道公开无认证服务。

部署后检查：

```bash
curl --fail https://你的域名/healthz
curl --fail https://你的域名/.well-known/oauth-protected-resource
curl -i https://你的域名/mcp
```

最后一条在未携带令牌时应为 401；这是正常的访问保护。登录后通过 ChatGPT 调用
`get_voice_bubble` 读取 demo，验证音频来自同一个 HTTPS origin，Range 请求返回 206。

## 持久磁盘、升级和恢复

- Compose 的 `voice-data` 卷保存 `/app/.data`，容器替换或正常重启不会删除音频。
- **不要执行 `docker compose down -v`**，它会删除命名卷。升级使用 `docker compose up -d --build`。
- 只部署一个应用实例；多副本需要另行迁移存储和分布式任务协调。
- 备份时停止应用或使用 SQLite 正确备份方法，同时保留 WAV 和媒体签名密钥。不能仅复制正在写入的主 SQLite 文件而忽略 WAL。
- 删除签名密钥会使旧链接失效，但只要数据库和音频仍在，重新读取同一 ID 可以获得新链接。
- 正在生成时崩溃可能导致请求状态不确定；系统不会自动重试或再次扣费。按 README 的显式重试流程处理。

## CSP、CORS 与日志

`PUBLIC_BASE_URL` 同时决定签名媒体 URL 和 UI resource 的 CSP allowlist。
其 origin 加入 `resourceDomains`（包含 media-src）和 `connectDomains`，没有额外嵌套 iframe。
域名变更后必须重启并在 ChatGPT 刷新 app 工具/resource 元数据。

音频路由使用短期签名 capability URL，允许 `Access-Control-Allow-Origin: *`，但不使用 cookie
或 `Access-Control-Allow-Credentials`。这是为了支持宿主 sandbox 的 opaque/null origin，
不是公开音频目录。没有有效签名仍返回 403。HTTP GET/HEAD/单范围请求支持拖动播放。
MCP 路由只接受允许的 origin，并要求生产 OAuth；组件刷新链接经过宿主 bridge，由宿主保管令牌。

API Key 只从服务端环境读取；应用不记录请求正文、鉴权头或完整上游错误。媒体签名密钥保存在
私有数据目录，文件权限 0600。签名 URL 本身在到期前拥有读取权限，避免开启记录查询参数的
反向代理 access log。第三方托管平台若默认记录 URL，应配置 query redaction。

出站网络至少需要 `api.elevenlabs.io`（仅使用 ElevenLabs 时）和你的身份提供商 JWKS 域名。
安装需要 npm registry；Caddy 还需其 ACME 证书服务网络。平台网络白名单按实际部署配置，
不要为了消除报错而关闭 TLS 校验。

## 带代理的云环境构建

普通服务器可直接按上面的 Compose 命令构建。本次云环境的 BuildKit 没有自动获得代理 DNS，
因此使用了现有代理和平台提供的可信 CA；没有关闭 TLS 校验。Dockerfile 支持可选的
BuildKit `build_ca` secret，只在安装依赖时挂载，不把证书或代理凭据写入镜像。
应用本身以 Node.js `--use-env-proxy` 启动，支持环境已经配置的 HTTP_PROXY/HTTPS_PROXY/NO_PROXY。

在本云环境复现镜像构建的命令为：

```bash
voice_proxy_ip=$(python3 -c 'import socket; print(socket.gethostbyname("proxy"))')
DOCKER_CONFIG="$PWD/.cache/docker" docker build \
  --network=host --add-host "proxy:$voice_proxy_ip" \
  --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY \
  --secret "id=build_ca,src=$NODE_EXTRA_CA_CERTS" \
  -t voice-bubble:local .
```

此段中的 `proxy` 是本云环境已有的代理主机名，仅适用于该环境；其他部署环境按其真实网络
配置处理，不要照搬临时解析出的 IP，也不需要把这些构建参数加入公网应用的环境变量。
