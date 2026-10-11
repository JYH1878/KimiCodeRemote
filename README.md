# kimi-remote

手机远控电脑上的 **Kimi Code 桌面版**：会话列表 → 实时消息流 → 发消息 → 审批/提问应答。
任意网络可达（4G 可连），且**端到端加密**——中继只搬密文。

> 官方桌面版远控尚未发布（PR #4169 开发中），第三方产品均只支持 CLI。本项目是桌面版的首个可用远控方案。调研依据见 [REPORT.md](REPORT.md)。

## 30 秒上手

```bash
npm install
npm start          # 前台模式：终端打印配对地址 + 二维码
```

终端会打印**公网配对地址 + 二维码**（cloudflared 快速隧道，免账号；首次自动下载 Windows 二进制到 `bin/`）。

手机（任意网络，4G 也行）**扫码或打开配对地址**即可，形如：

```
https://xxxx.trycloudflare.com/#k=<钥匙>
```

bridge 只绑 127.0.0.1（局域网无法直连），隧道不可用时 `npm start` 直接报错退出，重跑即可。

`#k=` 后面就是全部凭证。前提：Kimi Code 桌面版正在运行（bridge 通过 `~/.kimi-code/server/instances/*.json` 自动发现端口）。

## 无窗口后台运行

不想留一个前台终端，用后台模式（Windows 隐藏窗口，日志落 `logs/bridge.log`）：

```bash
npm run start:bg   # 隐藏窗口后台启动；已在跑则提示、不重复起
npm run pair       # 打印当前配对地址 + 二维码（读 run/state.json）
npm run stop       # 优雅停止：关隧道、回收 cloudflared、清理 run/
```

- 隧道就绪需要 10–90 秒，就绪后 `run/state.json` 写入 `{url, pid, started_at}`，`npm run pair` 随时可看。
- **桌面版退出跟随**：bridge 每 15 秒检查所连的桌面实例，进程消失且 healthz 失联连续 5 次（约 1 分钟）就优雅退出并清理——桌面版关了，远控跟着结束，不留孤儿进程。
- `logs/`、`run/` 均已 gitignore。

### 固定域名：命名隧道（可选）

快速隧道的地址每次重启都会变。有自己的 Cloudflare 账号和域名时，可一次性配置命名隧道，配对地址固定为 `https://<你的域名>`：

```bash
bin/cloudflared.exe tunnel login                                  # 浏览器授权
bin/cloudflared.exe tunnel create kimi-remote                     # 创建隧道（记住输出的 UUID 即名称 kimi-remote）
bin/cloudflared.exe tunnel route dns kimi-remote kimi.example.com # 绑定你的子域名
```

然后在 `.kimi-remote.json`（项目根，gitignored）加一段：

```json
{
  "key": "<现有钥匙，别动>",
  "tunnel": { "mode": "named", "name": "kimi-remote", "hostname": "kimi.example.com" }
}
```

重启 bridge 即走 `cloudflared tunnel run kimi-remote`，地址固定。未配置或配置不合法时自动回退快速隧道。

## 架构（文字版）

```
┌────────┐  AES-256-GCM 加密信封   ┌─────────────┐   明文+Bearer     ┌──────────────────┐
│ 手机    │ ─────────────────────▶ │ bridge(电脑) │ ────────────────▶ │ Kimi 桌面版内嵌   │
│ PWA    │ ◀───────────────────── │ :7777       │ ◀──────────────── │ server 127.0.0.1 │
└────────┘   {iv,ct} 密文信封      └─────────────┘  server.token     └──────────────────┘
     │            ▲                     │
     │ WSS(密文帧) └────── /ws 加密帧桥  └─── cloudflared 快速隧道（只转发密文）
     └── 浏览器内存持有钥匙；localStorage 存副本
```

- **bridge**（`packages/bridge`，Node+TS）：只暴露 4 个面——静态 PWA、`GET /healthz`、`POST /box`（加密 HTTP 代理）、`WS /ws`（加密双向帧桥）。其余一律 404。
- **pwa**（`packages/pwa`，Vite+React+TS，移动优先）：构建产物由 bridge 直接 serve。
- 桌面版的 `server.token` 只存在于 bridge→127.0.0.1 的请求头里，永不出现在任何响应、日志或前端产物。

## 安全模型

- **单钥匙模型**：首次启动生成 32 字节随机钥匙，存项目根 `.kimi-remote.json`（已 gitignore）。钥匙即全部凭证——能解出合法密文就是自己人，解不出一律 401 拒绝，无用户名无密码无会话。
- **AES-256-GCM**：每条消息随机 12 字节 IV，密文后附 16 字节 tag，线上格式 `{iv, ct}`（base64url）。浏览器端用 [@noble/ciphers](https://github.com/paulmillr/noble-ciphers) 纯 JS 实现（不依赖 Web Crypto，任何环境可用），bridge 端用 node:crypto，两者互通。
- **中继只搬密文**：cloudflared 快速隧道只传输密文信封（bridge 只绑 127.0.0.1，不暴露局域网端口）。中继/旁观者理论上可见的只有元数据（连接时间、流量大小、目标域名）。
- **白名单**：解密后的内层 path 必须命中 `packages/bridge/src/allowlist.ts`（唯一白名单文件）：`/api/v1/healthz`、`GET /api/v2/sessions`、`/api/v1/sessions` 及其子路由（messages/prompts/prompts:steer/approvals/questions/status/transcript/children/profile/:delete）。其余一律 403——尤其 shutdown、config、providers、oauth、fs*、files、remote-control。
- **钥匙泄露处置**：删除 `.kimi-remote.json` 并重启 bridge，钥匙立即更换；旧配对地址全部失效。
- **元数据残留**：快速隧道的随机子域名、连接时段与流量大小会被 Cloudflare 看到；会话标题/内容/文件路径均在密文内。bridge 不落任何盘上日志（终端输出除外）。
- 手机端钥匙存 localStorage（`kimi_remote_key`）：共用手机/浏览器时注意；URL hash 里的钥匙在载入后立即从地址栏抹掉。

## 已知限制

- **快速隧道地址重启会变**：每次 `npm start` / `npm run start:bg` 生成新的 `*.trycloudflare.com`，需要重新扫码；要固定地址请配置[命名隧道](#固定域名命名隧道可选)。隧道不可用则启动即报错退出，重跑即可。
- **实验性 API 可能漂移**：桌面版 Server API 未承诺稳定。白名单集中在 `allowlist.ts`、上游请求集中在 `upstream.ts`，漂移只改这两处。
- **手机新建会话**：在会话列表对应工作区分组的「+」里新建，工作目录即该组工作区；模型取该组（无则全局）最新会话的 activity.model（API 建的会话必须显式设 model，否则 turn 立即失败 "Model not set"）。
- **Markdown 简渲染**：标题/列表/粗斜体/行内代码/围栏代码块/引用/链接，不含表格与图片。
- 每个远控新建的临时工作区会残留一个桌面版 `kimi-cu` runner 进程（桌面版自身行为），重启桌面版后释放。

## 命令

| 命令 | 作用 |
|---|---|
| `npm start` | 起 bridge（前台），打印配对地址+二维码 |
| `npm run start:bg` | 无窗口后台启动（日志 `logs/bridge.log`，已在跑则不重复起） |
| `npm run pair` | 打印当前配对地址 + 二维码（需 bridge 隧道就绪） |
| `npm run stop` | 优雅停止 bridge + 回收 cloudflared，验证无残留 |
| `npm run build` | 两包编译（tsc + vite） |
| `npm run dev` | bridge + vite 热更新（vite 代理到 :7777） |
| `npm run verify:discovery` | 验证实例发现（应为 54754 活实例） |
| `npm run verify:e2e` | 全链路验收：加密拒绝/白名单/404/PONG 回环 |
| `npm run verify:ws` | 加密 WS 订阅→发 prompt→30s 内收到流式事件 |
| `npm run verify:tunnel` | 公网隧道 `/healthz` 200（失败降级验证 loopback 并提示记录） |
| `npm run verify:ux` | 消息流分页语义 + 工作区分组字段（临时会话发 2 条消息实测） |

## 目录

```
packages/bridge/src/
  allowlist.ts   白名单（唯一文件）
  upstream.ts    上行路径与请求（唯一文件）
  crypto.ts      AES-256-GCM 信封
  discovery.ts   桌面版实例发现（注册表+healthz 探活）
  server.ts      http 面：/healthz /box /ws 静态
  wsbridge.ts    加密 WS 协议 + 上游 WS 复用
  tunnel.ts      cloudflared 下载、快速隧道、命名隧道
  runstate.ts    run/ 生命周期：pid/state/stop + 桌面退出看门狗
  cli.ts         npm start 入口（打印配对地址/二维码）
  verify/        验收脚本（只走 bridge，唯一例外见 e2e）
packages/pwa/src/
  api.ts         加密 /box 客户端 + WS 自动重连
  crypto.ts      @noble/ciphers 信封（与 bridge 同格式）
  views/         配对页 / 会话列表（按工作区分组）/ 会话详情（消息流+审批+提问）
scripts/
  start-bg.mjs   无窗口后台启动（detached+windowsHide，等价 wscript 方案）
  stop.mjs       优雅停止 + 残留回收（stop 文件 → taskkill 兜底）
  pair.mjs       打印配对地址 + 二维码
```
