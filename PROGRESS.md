# PROGRESS — kimi-remote 施工记录

- 2026-10-11 00:30 起，单一 goal：桌面版手机远控垂直切片（bridge + PWA + E2E 加密 + 公网隧道）。

## 已完成

### 1. Monorepo 骨架
- npm workspaces：`packages/bridge`（Node+TS）、`packages/pwa`（Vite+React+TS）；根 `build/dev/start/verify:*` 脚本。`npm run build` 两包零错误。

### 2. 上游 API/WS 实测（关键发现，全部本机实测）
- **发现**：`~/.kimi-code/server/instances/*.json` → port 54754 活实例；`server.token` 在 `~/.kimi-code/server.token`（根目录，不是 server/ 下）。`/api/v1/healthz` 无需 token。
- **坑 1（Model not set）**：`POST /api/v1/sessions` 会丢弃 `agent_config.model`（回显 `{model:''}`），turn 3ms 内失败 `"Model not set"`。解法：建会后必须 `POST /sessions/{id}/profile {agent_config:{model}}`（桌面 UI 同款口子）。model 取 v2 列表最新会话的 `activity.model`。
- **workspace trust 不需要**：未信任的新 workspace 只要 model 设了就能跑。
- **busy 发消息语义**：idle 时 `POST prompts` 直接 running；busy 时 `POST prompts` 返回 `queued`，再 `POST prompts:steer {prompt_ids:[id]}` 注入（实测 `steered:true`）。
- **审批闭环**：`GET approvals?status=pending`（不带参数直接 40001 报错）→ `POST approvals/{id} {decision:'approved'}` → 2 秒后文件落地 ✓。WS 同时推 `permission.approval.requested`。
- **WS 协议**：连接即收 `server_hello`；`client_hello`→`ack`；`subscribe_v2 {session_id, transcript:{'*':'delta'}}`→`ack`；事件流顶层 `type` 是**具体事件名**（`transcript.ops`/`event.session.work_changed`/`permission.approval.requested`…），不是 asyncapi 里的 `session_event`，按「有 session_id 字段」判别转发；应用层 ping(10s)→pong（任意格式都收，含空 payload）。
- **消息块**：assistant content 含 `thinking`/`text`/`tool_use`/`tool_result`，PWA 只渲染 text+折叠 thinking/tools。
- 删除：`POST /sessions/{id}:delete` ✓。

### 3. bridge（全部交付）
- 加密：AES-256-GCM，`{iv,ct}` base64url，IV 12B 前置语义 + tag 后附；与 @noble/ciphers 实测互通。
- 4 个暴露面：`GET /healthz`→`ok`、`POST /box`、`WS /ws`、静态 PWA；其余 404。
- 白名单集中在 `allowlist.ts`；上游路径/请求集中在 `upstream.ts`（token 只在此附加）。**profile 子路由是白名单必要增项**：不放开则远控建的会话永远设不了 model。
- WS 桥：每帧加密信封；上游单连接复用、断线重连+自动重订阅；上游不可用时告知客户端降级轮询。
- 隧道：首次自动从 GitHub releases 下载 cloudflared（55.4MB，校验重定向 host 白名单）→ trycloudflare URL 解析 → 失败降级 LAN-only。
- `npm start` 打印 LAN/公网配对地址 + 二维码（qrcode terminal）。

### 4. PWA（全部交付）
- hash 钥匙→localStorage（README 写明风险），无钥匙显示配对说明页；@noble/ciphers 纯 JS（http 环境无 WebCrypto）。
- 会话列表（标题/相对时间/busy/待审批待回答角标，5s 轮询+WS 事件触发刷新）；会话详情（消息流 markdown 简渲染+thinking 折叠，WS 实时，断线 3s 轮询，右上角「实时/轮询」指示）；底部输入框（busy 自动走 prompts→steer）；审批卡（同意/拒绝）；提问卡（单选/多选/自定义回答，`:answer` 兜底）。
- 浏览器实测（390×844 手机视口）：配对→列表（真实 50+ 会话）→消息流渲染全部正常。

### 5. 验收状态（2026-10-11 03:2x，最终全绿）
1. `npm run build` ✅ exit 0（清空 dist 后全量重编，两包零错误）
2. `npm run verify:discovery` ✅ 选中 54754 活实例
3. `npm run verify:e2e` ✅ exit 0，14/14 PASS（加密拒绝、404、双凭证域 401、密文无明文 session_id、白名单 403、PONG 60s 内回环、临时会话+临时目录清理）
4. `npm run verify:ws` ✅ exit 0，4/4 PASS（加密 hello、订阅、WS api 200、30s 内流式事件——实时路径非降级）
5. `npm run verify:tunnel` ✅ exit 0，公网 /healthz 200（探测改用 curl 走系统 DNS + DoH/IP·SNI 兜底；关停时等待 cloudflared 完全回收，消除 libuv 断言）
6. `npm start` ✅ 打印 LAN/公网配对地址 + 两个二维码（钥匙已从输出复核中脱敏）

### 公网隧道实测证据
- 多次人工实测：bridge 存活期间 `curl https://<随机名>.trycloudflare.com/healthz` → **200 "ok"**（例：figure-professor-tool-meetings / schema-league-fibre-relocation / possibility-verse-engineering-differences 三个隧道实例均 200）。
- `verify:tunnel` 曾三次 FAIL：非隧道问题，是**本机 DNS 劣化**——配置的解析器（以太网 150.204.1.2、WLAN 10.0.32.32/33）间歇性拒绝 UDP:53：`dns.resolve4('github.com')` 直接 `ECONNREFUSED`，新隧道域名 `getaddrinfo ENOTFOUND` 长达 150s+；同期 curl/node 对活隧道均 200。**最终修复**：探测主路径改用 `curl`（系统解析器，符合验收原文「curl 隧道公网地址」），保留 DoH+IP/SNI 为兜底；最终 run exit 0 全绿。

## 环境干扰记录（非项目缺陷）
- 本机 DNS 出口间歇劣化（上述）；desktop 端 burp MCP 连接失败噪音与本项目无关。
- 桌面版每个新 workspace 常驻一个 kimi-cu 进程并持有 cwd：测试用的 mktemp 目录在会话删除后仍无法整目录移除（内容已清空），重启桌面版后可删。已通过 API 清理全部测试 workspace 注册与测试会话。
- 残留清理完成：probe 会话/工作区注册全部删除； Temp 下遗留 13 个空目录（待桌面版重启后释放）。

## 下一步（交付后可选）
- 手机 4G 人工验收（完成条件 2，路径无已知阻塞：`npm start` → 扫公网码）。
- 若官方发布桌面版远控（PR #4169），评估差异化的自托管/免会员定位。

### 6. 验收后修订（2026-10-11，领导拍板）
- 启动输出删除局域网配对地址（默认常选中虚拟网卡，鸡肋且易误导），只打印公网配对地址+二维码；隧道不可用时才降级打印局域网兜底。改动：`packages/bridge/src/cli.ts`，README「30 秒上手」「已知限制」同步。
- 复验：`npm run build` 0 错误；`npm start` 输出仅公网码；隧道 healthz ok（URL 打印后约 30 秒传播期），明文 API 404。
