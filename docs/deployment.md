# 部署

当前版本已迁移至 Cloudflare Workers + R2 + D1，请使用 **[Cloudflare 部署指南](cloudflare.md)**。
其中包含 workers.dev、账户授权、资源创建、D1 迁移、Secrets、OAuth、发布命令和验证记录。

旧版 Docker / Compose / Caddy 部署已经移除，避免仍然运行基于本地磁盘的旧服务。
原 `.data` 数据不会自动上传，也不会被迁移命令删除。当前 demo 会从仓库 WAV 写入 R2。
如果你在旧版已有个人生成音频，请保留旧 SQLite、WAV 和签名密钥备份，再单独进行数据导入；
本次没有把旧版测试目录或本地密钥上传到 Cloudflare。
