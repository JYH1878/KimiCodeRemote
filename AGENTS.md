# AGENTS.md — kimi-remote

## 定位
手机远控 Kimi Code 桌面版的独立软件：电脑端 bridge + 手机端 PWA，AES-256-GCM 端到端加密，经 cloudflared 快速隧道任意网络可达。调研依据见 REPORT.md。

## 怎么跑
- 前提：Kimi Code 桌面版正在运行（bridge 读 `~/.kimi-code/server/instances/*.json` 自动发现其内嵌 server 端口）。
- 启动：`npm install && npm start` → 终端打印公网配对地址 + 二维码，手机扫码即用。
- 验收：`npm run build`、`npm run verify:discovery|e2e|ws|tunnel`，全绿才算完。
- 新会话接手先读 HANDOFF.md（本机内部文件，已 gitignore 不入库）。

## 技术栈
- npm workspaces：`packages/bridge`（Node+TS，`node:crypto` AES-256-GCM 信封）；`packages/pwa`（Vite+React+TS，`@noble/ciphers` 纯 JS 加密——不用 Web Crypto，非安全上下文不可用）。
- cloudflared 快速隧道（首次自动下载到 `bin/`）。bridge 只绑 127.0.0.1，对外仅隧道一个入口，隧道不可用则启动报错退出。

## 目录与约定
- bridge 只暴露 4 个面：静态 PWA、`GET /healthz`、`POST /box`（加密代理）、`WS /ws`（加密帧桥）；其余一律 404。
- 白名单唯一文件 `packages/bridge/src/allowlist.ts`；上行路径/请求唯一文件 `upstream.ts`（`server.token` 只在此附加）。官方 Server API 是实验性的，版本漂移只改这两处。
- API 快照（v2.1.1，2026-10-11 抓取）：`docs/api-snapshot.openapi.json` / `docs/api-snapshot.asyncapi.json`。
- 配对钥匙：项目根 `.kimi-remote.json`（gitignored，首启自动生成；删除重启即换钥匙）。钥匙即全部凭证。

## 红线
- `~/.kimi-code` 只读；禁止调 `/api/v1/shutdown`；禁止动桌面版进程。
- 任何真实 token/钥匙不得进代码、测试、日志、git 历史。
- git 只本地 commit，不 push。

## 当前状态与下一步
- 2026-10-11 MVP 验收通过（验收命令全绿 + 手机 4G 人工实测通过）。
- 在途任务：无。候选迭代见 HANDOFF.md「正在推进的任务」。
