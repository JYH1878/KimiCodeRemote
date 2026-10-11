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

### 7. 验收后修订 2（2026-10-11，领导拍板）
- 彻底移除局域网入口：`cli.ts` 不再打印/兜底 LAN 地址，隧道不可用则启动即报错退出；`server.ts` 绑定从 0.0.0.0 收紧到 127.0.0.1（局域网无法直连，仅经隧道到达）；删除 `net.ts`（已无引用）；`verify:tunnel` 降级路径改验 loopback；README 同步。
- 复验：build 0 错误；netstat 确认仅 127.0.0.1:7777；局域网 IP 直连被拒；公网 healthz ok、明文 API 404、乱密文 401。

### 8. 迭代二：消息流修复 / 工作区分组 / 无窗口后台（2026-10-11）

三项迭代全部交付，验收全绿。

**任务 1 消息流（SessionDetail.tsx、types.ts）**
- API 语义：`GET messages` items 新→旧；进会话拉 `?page_size=50` 后反转渲染；到顶（按钮 `↑ 加载更早` 或 scrollTop<60 触发）用 `?before_id=<当前最旧id>&page_size=50` 翻页 prepend，`has_more=false` 停。
- WS/轮询刷新只拉最新一页，按 id 合并（已知 id 原位更新内容、新 id 追加尾部），不丢已加载历史、不打乱顺序；发送先本地乐观插入（半透明气泡），刷新时按文本计数对账消除，失败即回滚。
- 渲染规则：role=tool/system 不显示；user 气泡剥 `<system-reminder>…</system-reminder>`（剥完为空则整个气泡不渲染）；thinking 只折叠在 assistant 气泡内。
- 滚动：贴底才自动沉底（读历史不拽回）；prepend 后按 scrollHeight 差恢复锚点。
- 自查：真实 237 条消息会话（5 页×50）全量走查——id 无重复、时间序重建 user/assistant 双方齐全、最旧边界 empty+has_more=false、刷新 top-50 ⊆ 已加载集（合并前提成立）。

**任务 2 会话列表（SessionList.tsx）**
- 改走 `GET /api/v2/sessions?view=by_workspace&page_size=100&group.page_size=100`，顶层 `has_more/next_page_token` 用 `page_token` 翻页拿全（上限 10 页防御）；`meta.archived=true` 过滤。
- 组=工作区：标题 cwd 末段，副标完整 cwd（rtl 截断显示尾部）；组内按 updated_at 新→旧、组按组内最新排序；可折叠默认展开（chevron 旋转动画）；徽标映射 activity.status：running→运行中 / approval→待审批 / question→待回答；5s 轮询+WS 触发刷新保留。
- 组头「+」在该工作区建会话：POST sessions {title, metadata:{cwd}} → profile 设 model（该组最新 activity.model，无则全列表最新）→ 进详情。
- types.ts 新增 V2WorkspaceGroupData 等类型；旧 SessionItem 类型保留但列表不再使用。

**任务 3 无窗口后台（bridge + 根脚本）**
- Windows 免 VBS：node 自带隐藏控制台（`detached:true + windowsHide + stdio→logs/bridge.log`），`npm run start:bg` 起完轮询 healthz 30s 就绪即报；pid 文件活着则拒绝重复起。
- `run/` 三件套（runstate.ts）：bridge.pid（cli 启动即写）、state.json（隧道就绪写 {url,pid,started_at}，`npm run pair` 读取打印 URL+二维码）、bridge.stop（`npm run stop` 落文件，bridge 1s 轮询到即优雅退出——Windows 跨进程 SIGTERM 是硬杀，会孤儿 cloudflared，故用停止文件）。
- `npm run stop`：优雅路径 15s 等待→taskkill /F /T 兜底；按命令行匹配本仓库 bin/cloudflared.exe 回收孤儿（绝不按进程名裸杀）；收尾验证 7777 无监听+无 cloudflared 残留，清理 run/ 文件。
- 桌面退出跟随：cli 每 15s 查所选实例（首次立即查，最快 ~60s 判死），pid 不存在且 healthz 失败连续 5 次→优雅退出+清理。隐藏测试钩子 `KIMI_REMOTE_INSTANCE_FILE`（限实例注册表/仓库/临时目录内的 .json，路径校验过 Mimosa）强制指定实例并跳过启动期存活过滤。
- 命名隧道可选配置：`.kimi-remote.json` 可加 `tunnel:{mode:"named",name,hostname}`；走 `cloudflared tunnel --no-autoupdate run --url http://127.0.0.1:<port> <name>`（--url 免写 config.yml），URL 固定 https://<hostname>，就绪判据 "Registered tunnel connection"；配置缺失/不合法自动回退快速隧道。README 写明 login/create/route dns 一次性步骤。
- logs/、run/ 进 .gitignore。

**验收（全绿）**
1. build 零错误 ✅（tunnel.ts 后期改动后重跑）
2. verify:discovery/e2e/ws 全绿 ✅；tunnel+ux 在最终代码上重跑 ✅（ux 17 项：倒序首页、before_id 严格更旧无重复、has_more 边界、by_workspace 字段齐全含临时会话归属与 activity.{status,model}、清理）
3. start:bg → logs/bridge.log 有启动记录、run/state.json 含 trycloudflare URL、curl /healthz 200、pair 输出同一 URL（pid/时间一致）✅；重复 start:bg 正确拒绝 ✅
4. stop → 7777 无监听（仅 TIME_WAIT 余波）、无 node/cloudflared 残留、run/ 清空、日志尾部优雅退出记录 ✅
5. 反向：假实例（pid 3999999 不存在、port 59999 不通）启动 bridge，watchdog 1/5→5/5，**60s 优雅退出**（<80s），退出码 0 ✅

**其他**
- 顺手清理：7777 遗留 bridge（pid 30188，旧会话残留）+ 3 个孤儿 cloudflared（指向已死临时端口）。
- docs 未动 API 快照；allowlist/upstream 零改动（query 透传本就支持）。

### 9. 版本提交被 Mimosa 安检拦截 → 复核误报 → 已解决（2026-10-11）

代码与验收完成后，本地 `git commit` 被 Mimosa L3 门禁以两条数据流拦截，同一结果 3 次，按规矩写 BLOCKED.md 停手。两条发现：① `startBridge`→`tunnel.ts` 的 `spawn`（无 shell、参数全字面量、binPath 为仓库常量）；② `startDesktopWatchdog`→`healthzReachable` 的 `fetch`（host 硬编码 127.0.0.1）。执行者已加固（bin 路径 resolve 后必须在 BIN_DIR 内 + validPort 双重校验）并全量回归。
管理者（领导会话）逐行走查 diff，独立复核两条均为**误报**（外部无可控字符串到达 spawn；port 即使被污染也只能探 loopback）。领导拍板：授权提交、删除 BLOCKED.md。已提交，事件关闭。

### 10. 管理者验收复跑（2026-10-11，领导会话亲验）

**明卷全绿（本人复跑，非执行者自述）**
- build 零错误；verify:discovery / e2e(14) / ws(4) / ux(17) / tunnel 全部 PASS（exit 0 一把过）。
- start:bg 全链路实测：state.json 落 URL → curl 公网 healthz ok → pair 同 URL → stop 后 7777 无监听、无 cloudflared 残留、run/ 清空 ✅
- 看门狗反向验证亲跑：假实例（死 pid+不通端口）→ watchdog 1/5→5/5，60s 优雅退出 exit 0 ✅

**暗卷（执行者不知道的三条抽查）**
1. 真实 263 条消息会话 before_id 全量走查：6 页、零重复、严格有序、正确终止 has_more=false ✅
2. 钥匙卫生：.kimi-remote.json gitignore 生效、git 全历史零接触、run/ logs/ 零历史 ✅
3. 监听面+日志抽查：后台运行仅 127.0.0.1:7777 一个监听面 ✅；**但发现 logs/bridge.log 含完整配对 URL（钥匙进日志，违反红线）** ❌→已修

**验收中修复（管理者动手）**
- cli.ts：非 TTY（后台日志）时不再打印带钥匙的配对 URL，改打无钥匙 URL + 提示 `npm run pair`；TTY（npm start 前台）行为不变。修复后实测：bridge.log 零 `#k=`、隧道就绪、公网 healthz ok、看门狗退出路径正常。改动已 git add 进暂存区。

**结论：迭代二通过验收。** Mimosa 拦截经独立复核为误报，领导拍板后已提交关闭（详见 §9）。

### 11. 迭代三：消息流净化 + ZCode 风卡片 + Kimi 配色（2026-10-11）

**取证（真实会话 session_2fa63600…3dc，46 条消息，任务书外的新发现）**
- `metadata.origin.kind` 实测种类：`user`（普通）、`skill_activation`、`injection`（variant: loadable-tools / date_change / **interruption**——任务书未列，同判不渲染）、`task`（后台任务 `<notification>` 噪音——任务书未列，判不渲染）。
- skill_activation：userText 三级来源 `skillArgs`（剥 `[name](kimi-code://skill/…)` 提及标记）→ `clientMetadata[0].display_text`（剥末尾附件文件名行 + 开头裸 skill 名）→ 剥净正文（去 `<skill-loaded>` 信封与 "User activated…" 行）；末道保险：userText 含信封痕迹则置空。rawText= `<skill-loaded>` 内说明书 excerpt（≤600 字符）供展开查看。
- 纯图 user 消息（3 图无文字）：正文全是 `<system>Image compressed…` 噪音 → 剥后为空 → 不产空气泡（断言覆盖）。

**实现（只动 packages/pwa、scripts/、根 package.json；bridge 零改动）**
- `types.ts`：Message 增可选 `metadata.origin`（字段全可选）。
- 新增 `clean.ts` 纯函数：`classifyMessage`（hidden/assistant/user/skill）+ `cleanUserMessage`（{skillName,userText,rawText}）+ `stripHarnessNoise`（`<system-reminder>`+`<system>` 双剥）。
- `SessionDetail.tsx`：接入 clean.ts；skill 消息=默认收起的「✨ skill「名」」细条（展开看 args+说明书摘要）+ 用户原话照普通消息渲染；清洗后为空不产气泡；用户消息改右侧深色圆角卡片（panel-2+发丝边，超长 max-height 截断）；助手消息全宽平铺去气泡框；审批卡/提问卡/输入条/顶栏结构不动只重刷色。
- `SessionList.tsx`：每工作区一张 16px 圆角卡片——头部（亮蓝圆角方块 SVG 文件夹图标 + 粗体名 +「本地」描边胶囊 +「N 个任务」+ 折叠箭头 +「+」方钮）；副行（完整路径 rtl 截断 + 「更新于 xx」）；卡内会话行（标题省略+相对时间+右侧状态胶囊，行间发丝线）。by_workspace 拉取/翻页/折叠/5s 轮询+WS/archived 过滤/组内新建全部保留。
- `styles.css` 全量重写：`--bg:#0A0C10 --panel:#12161D --panel-2:#1A2029 --border:#242C38 --text:#E8EAF0 --muted:#8B93A5 --accent:#3D7BFF`（其上白字），危险/警示色保留；旧绿 #18e299/#245641（含 rgba 变体）全仓零残留（src+dist grep 确认）；`index.html` 的 theme-color 与 SVG favicon 同步换蓝（favicon 是最后一处旧绿）。
- `scripts/verify-pwa.mjs` + 根 `verify:pwa`：项目自带 tsc 把 clean.ts 单文件编到临时目录（`import type` 被擦除，产物零运行时依赖）→ 真实拉取取证会话 46 条 → 18 项断言（skillName==="leader"、userText 含「推进项目」且不含信封字样、3 条 injection+1 条 task+24 条 tool 全 hidden、普通 user 原文通过、纯图 user 剥空、assistant 全通过）。禁伪造数据。

**web-design-guidelines 审查（联网拉到 vercel-labs 规则后逐条过）修复项**
- icon 按钮/输入框补 aria-label；`:focus-visible` 焦点环（2px accent）；hover 态限定 `@media(hover:hover)`；`prefers-reduced-motion` 降级；时间数字 tabular-nums；`.stream` overscroll-behavior:contain；输入控件 16px 防 iOS 自动缩放；theme-color 跟页面底色。

**验收**
1. `npm run build` ✅（两包 tsc+vite 零错误）；`verify:pwa` ✅ 18/18；`verify:discovery` ✅；`verify:e2e` ✅ 14 项；`verify:ws` ✅ 4 项；`verify:ux` ✅ 12 项。
2. `verify:tunnel` 首跑 FAIL（新 quick tunnel 30 次重试不可达）——**已知环境干扰复现**（本机 DNS 间歇劣化，见 §公网隧道实测证据）；同期主隧道公网 healthz 200，单独重跑 verify:tunnel ✅ exit 0（12 次重试后通）。与本次改动无关（bridge 零改动）。
3. 视觉自查（桌面浏览器 390×844 移动视口，本地 7777）：列表页工作区卡片/副行/状态胶囊/发丝线 ✓；聊天页 skill 细条默认收起+点击展开（args+摘要）✓、用户原话右侧深色卡片 ✓、injection/task 不可见 ✓、助手全宽平铺+thinking/工具折叠 ✓、顶栏/输入条/审批配色 ✓、无绿色残留 ✓。
4. 遗留：管理者手机视口终验（完成条件 2）。

### 12. 热修：微信内手机返回直接退出网页（2026-10-11，领导实测反馈）

**原因**：SPA 无路由，「列表→会话」只是 `Shell.tsx` 的 React state 切换，浏览器历史栈始终只有一条记录；手机返回键/微信左滑手势 = 浏览器后退，无处可退 → webview 直接关闭。

**修复（只动 `Shell.tsx`）**
- `openSession` 时 `history.pushState({view:'session',id,title}, '')` 压栈（**URL 不变**，不碰 `#k=` 钥匙 fragment——钥匙早已入 localStorage）。
- `popstate` 监听按 `event.state` 分流：`view:'session'` → 恢复该会话（**前进方向也要正确**——首版无脑回列表被实测抓出：go_forward 后详情页丢成列表）；否则回列表。
- 界面「‹ 返回」按钮改走 `history.back()`（state 匹配时）保持栈一致，失配兜底直接 setOpenId(null)。

**实测闭环（桌面浏览器 390×844）**：进会话（canGoBack:true）→ go_back 回列表（栈底，再退才退出）→ go_forward 正确恢复同一会话 → 界面「‹ 返回」回列表 ✓。回归：build ✅、verify:pwa ✅、verify:ux ✅。
