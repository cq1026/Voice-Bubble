# 验收记录

本地验收日期：2026-10-15。测试环境为 Node.js 24.19.0，实际 Chromium 浏览器，
官方 MCP Apps `AppBridge` 和隔离 iframe；使用仓库中的真实 WAV，不模拟播放计时。

## 已通过

- TypeScript 类型检查和生产构建。
- Docker 镜像构建、Compose 配置校验、非 root 容器启动、容器内 MCP 读取和 HTTP 206。
  使用独立临时命名卷替换容器后，同一音频可读取，替换前的签名链接仍有效；测试容器和卷已清理。
  容器使用 Node.js 24.22.0，未注入 ElevenLabs Key，网络设为 none，真实付费调用为 0。
- 服务端测试 15 项：真实音频分析、64 个采样波形、SQLite 持久化、签名验证与过期、
  默认禁用付费、并发合并、重启后去重、request ID 冲突、不确定生成不自动重试、缺失文件处理、
  配置校验、模拟 ElevenLabs API 契约与脱敏、真实 HTTP MCP 协议、CORS/Range/HEAD、OAuth JWT 校验。
- 浏览器测试 8 项：真实播放/暂停、波形点击和拖动、三档速度、透明气泡几何与深浅主题、
  320px 手机宽度、粉色选项、重开不自动播放、过期链接经 bridge 刷新、失败后重试、CSP。
  测试分组的条目数量与细分能力数量不同。

其中修复过一次真实联调问题：Express 默认拒绝隐藏 `.data` 目录下的音频文件。
现在只对经过哈希文件名和签名验证的音频路径允许访问，没有暴露目录或任意文件。
容器联调还修复了源文件权限导致非 root 用户无法读取 package.json 的问题；
运行时文件通过 COPY --chown=node:node 交付，未改为 root 运行。

## 测试边界

Docker 构建、非 root 运行、容器替换后的音频及签名密钥持久化已通过本地验证；
这不代表 Caddy 公网证书或真实 OAuth 提供商已经部署。

| 项目                                            | 结论                                     |
| ----------------------------------------------- | ---------------------------------------- |
| 本地 MCP 资源/工具/HTTP 协议                    | 已验证                                   |
| 本地官方 bridge + sandbox 中的真实播放          | 已验证                                   |
| 播放、暂停、点击/拖动、倍速、重开               | 已验证（Chromium）                       |
| UI CSP 声明及本地对应浏览器策略、媒体 CORS、206 | 已验证                                   |
| OAuth 签名、issuer/audience/sub/scope/到期校验  | 使用本地生成密钥与 JWT 验证              |
| ElevenLabs 请求格式、错误处理、重试保护         | 隔离模拟上游验证，非真实服务调用         |
| ChatGPT 实际容器/无边框请求的呈现               | **未验证**                               |
| 真实 OAuth 提供商与 ChatGPT 授权流程            | **未验证**                               |
| ElevenLabs 真实付费生成、音质、账户权限         | **未执行**；等待用户明确触发             |
| ChatGPT 手机客户端 / Safari                     | **未验证**；仅本地 Chromium 手机宽度检查 |
| 公网 TLS、真实域名和部署平台                    | **未部署**                               |

## 复现

```bash
npm ci
npm run typecheck
npm test
CHROMIUM_PATH=/usr/bin/chromium npm run test:browser
```

若没有系统 Chromium：`npx playwright install chromium` 后执行 `npm run test:browser`。
测试自动启停专用本地服务器，使用 `.data/browser-tests`，付费生成强制关闭。
截图输出到 `test-results/voice-bubble-{light,dark,mobile}.png`，只显示测试音频气泡。
已保存截图：[浅色](screenshots/light.png)、[深色](screenshots/dark.png)、[手机宽度](screenshots/mobile.png)。

如需开发者手动检查，构建并启用测试宿主：

```bash
BUILD_TEST_HOST=true npm run build
ENABLE_TEST_HOST=true npm start
```

测试宿主路径为 `/__test/host`，只在 `AUTH_MODE=local` 可用，生产禁用。
这不是对外发布的独立播放器产品，也不能替代 ChatGPT 验收。

真实 ChatGPT 验收清单见 [接入说明](chatgpt.md)。
