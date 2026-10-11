# Kimi Code 桌面版安卓手机远控 —— 调研结论报告

- 调研日期：2026-10-10 深夜 ~ 2026-10-11 凌晨（GMT+8）
- 调研方式：官方文档/页面原文抓取 + GitHub API 现查 + 本机只读实测 + 社区平台检索（Reddit/V2EX/知乎/B站/小红书）
- 证据分级：**【实测】**= 本机只读命令输出；**【查证】**= 公开 URL/API 当日核实；**【推测】**= 基于证据的推断；**【未验证】**= 查不到或无法核实
- 热度数字查询时间：GitHub API，第一批 2026-10-10 23:55、第二批 2026-10-11 00:00、第三批 2026-10-11 00:13（均为 GMT+8）

---

## 结论速览

| # | 问题 | 一句话答案 |
|---|---|---|
| 1 | 官方有没有桌面版远控？ | **现在没有，但正在开发**——桌面版文档/changelog 全无远控；官方 Collaborator 的草稿 PR #4169「桌面端原生管理远控设备」2026-10-10 提交（昨天）。【查证】 |
| 2 | 第三方有谁在做？ | 6+ 个产品支持 Kimi Code **CLI**（Paseo、hapi、QuickTUI、metabot、Pocket、SezSab/kimi-remote 等），**无一支持桌面版**。【查证】 |
| 3 | 热度/空白？ | CLI 远控生态很热（Paseo 20,381★、Happy 24,080★、hapi 5,211★、metabot 994★，GitHub API 现查）；「Kimi Code 桌面版专属远控」细分**是空白**。【查证】 |
| 4 | 能不能做？ | **能**——桌面版在本机 127.0.0.1:54754（端口为本机实测值，每台机器不同）内嵌完整 kimi web server（/api/v1/* bearer 鉴权），实例注册表 `~/.kimi-code/server/instances/*.json` 可自动发现端口，官方有 Server API 文档。路线排序：a) 对接桌面版本地接口 > b) 桥接 CLI > c) 独立软件终端中转。【实测+查证】 |
| 5 | 前景？ | **有条件值得做**：官方下场风险高（PR #4169 + Kimi Work 已有同款），但官方方案必走付费会员+官方中继，「免会员/自托管/局域网直连」空间已被 CLI 侧验证（Paseo 在 kimi rc 存在下长到 2 万★）。窗口期估计数月。【推测，依据查证】 |
| 6 | 做什么形态？ | **推荐**：电脑端 bridge + 手机端 PWA（后做原生安卓）的独立软件，对接桌面版内嵌 Server API；**备选**：零开发/轻量反代（Tailscale 或反代 127.0.0.1:54754 到局域网）保底自用。skill/MCP/插件形态被实测否决。 |

**做不做：做。** 保底自用 1-2 天即可落地（备选方案）；开源产品有真实空白和已被验证的需求逻辑，但要快——官方桌面版远控大概率数月内发布，产品定位必须压在官方不覆盖的「免会员、自托管、局域网/隐私、安卓原生体验」上。

---

## 1. 官方：桌面版远控现状、`kimi rc` 接管可能性、Kimi Work 关系、roadmap

### 1.1 桌面版现在没有官方远控/会话同步 【查证】

- 桌面版 2026-09-17 与 CLI v2.0.0 同日发布，macOS（Apple Silicon/Intel）+ Windows x64，闭源（2026-07-17 起开发迁入私有仓库，开源仓库 PR #1849 删除了 Electron 壳）。证据：[What's New](https://www.kimi.com/code/docs/en/kimi-code/whats-new.html)、[PR #1849](https://github.com/MoonshotAI/kimi-code/pull/1849)。
- 桌面版全部公开文档（Getting Started、FAQ、Settings、changelog 1.0.0–1.0.4）**均无** remote control / 手机查看 / 会话同步功能；changelog 中唯一「mobile」字样是移动端渲染性能修复。证据：[Desktop Changelog](https://www.kimi.com/code/docs/en/kimi-code-desktop/changelog.html)、[Desktop FAQ](https://www.kimi.com/code/docs/en/kimi-code-desktop/help.html)。
- 桌面版与 CLI 共享 `~/.kimi-code/`（配置、账号凭证、会话、日志），UI 状态存应用私有目录。证据：[Desktop Settings](https://www.kimi.com/code/docs/en/kimi-code-desktop/settings-and-extensions.html)。

### 1.2 `kimi rc` 不能接管桌面版会话 【查证+实测；部分推测】

- `kimi rc`（=`kimi remote`=`kimi web --remote-control`；会话内 `/remote-control`）是 **CLI 的前台进程**，把手机经 Kimi 中继（`code-rc.kimi.com` / `code-rc.kimi.ai`）接到**它自己启动的那个 CLI server** 上；付费会员专属、每账号约 3 台设备、单机单实例（锁文件 `~/.kimi-code/server/rc.json`）、只绑 loopback 且不支持 `--host`。证据：[Remote Control 官方文档](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/remote-control.html)（2026-10-10 抓取原文）。
- 【实测】本机桌面版正在运行（7 个 `Kimi Code.exe` 进程），但 `~/.kimi-code/server/` 下**不存在 rc.json**，且 `server/instances/*.json` 注册的实例 pid 正是桌面版进程（`"pid":<桌面版进程PID>,"port":54754,"host_version":"2.1.1"`，pid 为本机实测值已隐去）——即桌面版走的是自己的内嵌 server 实例，`kimi rc` 的中继机制属于 CLI 进程，二者不共享入口。
- 【推测/未验证】桌面版与 CLI 共享 `sessions/` 目录且格式同源（桌面版 server 的 host_version 就是 CLI 版本 2.1.1），理论上 CLI 在同一 workspace 启动 `kimi web/rc` 可能列出桌面版创建的会话。本次受只读约束（启动 rc 会写锁文件）未做实验，**官方文档也没有「rc 接管桌面会话」的任何说法**，按现状应视为不能。

### 1.3 Kimi Work 远控与 Kimi Code 的关系 【查证】

- Kimi Work 远控 2026-09-22 上线：手机 Kimi App（Android/iOS ≥3.1.0）登录同一账号、设备配对（非扫码链接），控制对象是「电脑上的 Kimi Work」；官方页通篇未提 Kimi Code，页面未提会员要求。证据：[Kimi Work Remote Control 官方页](https://www.kimi.com/resources/kimi-work-remote-control)（2026-10-10 抓取原文）。
- 两者是同一账号/会员生态下的独立产品线：Kimi Work 桌面版的 bug 提交到 MoonshotAI/kimi-code 仓库（issue #4096 显示其远控走独立的 `kimi.gateway.work.v1.RemoteControlService` API），但应用互相独立。证据：[issue #4096](https://github.com/MoonshotAI/kimi-code/issues/4096)。
- **Kimi Work 远控不能控制 Kimi Code 会话**——无任何官方证据支持，按现状视为不能。

### 1.4 roadmap 线索：桌面版远控正在开发中（最重要发现） 【查证】

- **PR #4169「feat(kap-server): add remote control device management」**：GitHub API 核实 state=open、创建于 2026-10-10T09:18Z，作者为官方 Collaborator；内容为桌面端原生管理远控设备（列出/重命名/停用/删除，走 `/api/v1/remote-control/devices*` 路由），PR 正文标注配套桌面端工作在私有仓库 `MoonshotAI/kimi-code-app#838`。即**桌面版 × 远控集成已在开发，但未发布、无官方时间表**。证据：[PR #4169](https://github.com/MoonshotAI/kimi-code/pull/4169)（GitHub API 2026-10-11 00:13 核实）。
- issue #3860「feat(desktop): allow connecting Desktop to a remote kimi server (SSH dev boxes)」：2026-09-17 开，GitHub API 核实 open、仅 2 条用户跟帖、零官方回复；issue 内容透露桌面版内嵌 kap-server、渲染进程支持 `?kimi_origin=<url>` 重定向 REST/WS。证据：[issue #3860](https://github.com/MoonshotAI/kimi-code/issues/3860)。
- 官方无公开 roadmap 页/看板（GitHub 与文档站均无）；官方社区 Discord（[联系页](https://www.kimi.com/code/docs/en/kimi-code/contact-and-feedback.html) 所列）内容无法外部抓取【未验证】。

---

## 2. 第三方产品全景（全部支持 CLI，无一支持桌面版）

| 产品 | 形态 | 支持对象 | 收费 | 证据 |
|---|---|---|---|---|
| **Paseo** | 原生 iOS/Android + 桌面 app + Web + daemon；E2E 加密托管 relay（可自托管） | Kimi Code **CLI**（官网有 [Kimi 专页](https://paseo.sh/kimi)，agents 列表明示 CLI） | 免费开源 Apache-2.0 | [paseo.sh/kimi](https://paseo.sh/kimi)、[GitHub](https://github.com/getpaseo/paseo) |
| **hapi**（tiann/weishu 出品） | 原生 iOS(SwiftUI)/Android(Compose) + Web/PWA + Telegram Mini App；本地优先，可完全自托管 | Kimi Code **CLI**（经 ACP `kimi acp` 接入，含审批/会话恢复） | 免费开源 AGPL-3.0 | [GitHub tiann/hapi](https://github.com/tiann/hapi)、[agents 文档](https://github.com/tiann/hapi/blob/main/docs/guide/agents.md) |
| **QuickTUI** | 商业 iOS/Android app + 电脑端 server（SSH/tmux 会话中转，Windows 端上架 Microsoft Store） | Kimi Code **CLI**（官网有专文《Run Kimi Code from phone》） | 1 台电脑免费；Pro 买断 ¥168；Relay 订阅 ¥48-98/月 | [quicktui.ai](https://quicktui.ai)、[Kimi 指南](https://quicktui.ai/guides/run-kimi-code-from-phone/) |
| **metabot** | 自托管服务，手机端入口是飞书/Telegram/Slack/微信 bot（无独立 app） | **Kimi Code CLI 为一级引擎**（走官方本地 Server API + `kimi login`） | 免费开源 MIT（agent 订阅自备） | [GitHub xvirobotics/metabot](https://github.com/xvirobotics/metabot) |
| **Pocket** | 电脑端托盘 app + Android APK（iOS 需侧载）；账号配对+中继，E2E 加密 | 宣称支持 Kimi Code（语境为 CLI，未逐一说明） | 闭源；定价未公开，注册受限 | [pocket-releases](https://github.com/pocketcli-app/pocket-releases)、[官网](https://pocket.pocketcli.net/en) |
| **SezSab/kimi-remote** | 自托管 PWA + tmux 控制实时 CLI 会话（推送/语音输入） | Kimi Code **CLI** | 免费开源 MIT | [GitHub](https://github.com/SezSab/kimi-remote)、[Reddit 帖](https://www.reddit.com/r/kimi/comments/1v006pw/i_built_kimi_remote_control_your_kimi_cli) |
| **Ajwyunsx/kimi-remote** | **Kimi Code 插件**：配对链接+二维码，手机浏览器控制 | Kimi Code **CLI**（插件形态） | 开源 | [GitHub](https://github.com/Ajwyunsx/kimi-remote) |
| **Happy Coder** | iOS/Android app + 桌面客户端 + Web；E2E 加密中继 | **不支持 Kimi**：仅 Claude Code/Codex/Grok；7 个 Kimi 相关 PR/issue 全部未合并（PR #888 于 2026-06-07 关闭未合并） | 免费开源 MIT | [GitHub](https://github.com/slopus/happy)、[PR #888 API](https://api.github.com/repos/slopus/happy/pulls/888) |
| 其他 GitHub 小项目 | mjolnir（ACP 控制平面）、reemoat（自托管 E2E）、AgentPocket（Android+Tailscale）、codeaw（ACP+Flutter）、larryluozhang/kimi-mobile（kimi web 非官方原生客户端，含协议笔记）、eeljoe/kimi-web-mobile（反代修移动端）、qkunio/kimicode-mobile（iOS 客户端 for kimi rc）、moon-code / laoniubia/kimi-code-desktop（非官方桌面客户端）等 | 全部为 CLI/`kimi web` 场景 | 多为开源 | GitHub 搜索 API，2026-10-10/11 现查 |

**关键结论【查证】：没有任何第三方产品宣称支持「Kimi Code 桌面版」**——所有方案接的都是 CLI（或 CLI 的 `kimi web` 本地服务）。wjt0321/kimi-code-desktop 虽叫「desktop」，实为调用本机 CLI 的非官方 Windows 客户端，且无远控功能、2★、停更于 2026-07-30。

## 3. 热度（GitHub API 现查）与细分空白判断

查询时间：批① 2026-10-10 23:55、批② 2026-10-11 00:00、批③ 2026-10-11 00:13（GMT+8），均为 `api.github.com` 实时返回。

| 仓库 | Stars | Forks | 最近 push | 备注 |
|---|---|---|---|---|
| slopus/happy | 24,080 | 2,059 | 2026-10-10 | 赛道最热，但**不支持 Kimi** |
| getpaseo/paseo | 20,381 | 2,403 | 2026-10-10 | 支持 Kimi CLI 的最成熟方案，open_issues 1,168，高度活跃 |
| MoonshotAI/kimi-code | 7,820 | 1,282 | 2026-10-10 | 官方 CLI 仓库 |
| tiann/hapi | 5,211 | 597 | 2026-10-06 | 原生双端 + Kimi(ACP)，增长快 |
| omnara-ai/omnara | 2,903 | 233 | 2026-10-10 | 已转型托管平台，无 Kimi |
| friuns2/codex-mobile | 959 | 195 | 2026-09-20 | Codex 向，参照系 |
| xvirobotics/metabot | 994 | 167 | 2026-09-15 | 飞书/Telegram 路线，Kimi 一级引擎 |
| getpaseo/paseo-relay | 101 | 27 | 2026-08-22 | Paseo 自托管中继 |
| BrokkAi/mjolnir | 91 | 8 | 2026-10-10 | ACP 控制平面（含 Kimi） |
| slopus/happy-desktop | 87 | 18 | 2026-10-10 | Happy 桌面端 |
| rends-east/reemoat | 20 | 1 | 2026-10-09 | 自托管 E2E（含 Kimi） |
| SezSab/kimi-remote | 10 | 3 | 2026-07-18 | 停更 |
| npu-chenlin/AgentPocket | 10 | 0 | 2026-09-24 | Android+Tailscale |
| chenweigao/perch | 6 | 0 | 2026-10-10 | macOS 原生（含 Kimi） |
| ChisaAlter/ChisaCode | 4 | 0 | 2026-09-30 | local-first 控制面 |
| wjt0321/kimi-code-desktop | 2 | 0 | 2026-07-30 | 非官方 Windows 客户端，停更 |
| feifei210134258/moon-code | 2 | 1 | 2026-09-03 | CLI 桌面工作台 |
| AvianJay/codeaw | 2 | 0 | 2026-10-10 | ACP+Flutter 安卓 |
| qkunio/kimicode-mobile | 1 | 0 | 2026-10-05 | iOS 客户端 for kimi rc |
| Ajwyunsx/kimi-remote | 1 | 0 | 2026-09-24 | 插件形态 |
| pocket-releases / kimi-mobile / outpost / kimi-web-mobile / kimipocket / kimi-viewer-android / laoniubia-kimi-code-desktop | 0-1 | — | 2026-08~10 | 早期/个人项目 |

社区声量【查证/未验证混合】：Reddit r/kimi 有 Paseo 演示帖与自制 kimi-remote 帖（URL 见第 2 节，互动量因 Reddit 拒抓**未验证**）；V2EX 有 Kimi Code 用量讨论但**未找到**手机远控专帖；B站、小红书**未找到**相关内容；知乎/linux.do 有 Happy 自部署教程（Claude/Codex 向）。

**细分空白判断【查证+推测】：「Kimi Code 桌面版专属远控」目前是空白**——官方在开发未发布（PR #4169），第三方无人支持桌面版；但 CLI 远控赛道已经拥挤（2 个 2 万★级头部 + 一批千★级），需求总量被充分验证。

## 4. 能不能做：本机只读实测（2026-10-10 23:4x-23:5x，GMT+8）

### 4.1 安装目录：确证 Electron，内嵌 web 前端 【实测】

`ls -la "D:\SoftWares\Kimi Code\"` 输出摘录：

```
-rwxr-xr-x 1 JYH 197121 225501472 Sep 24 15:46 Kimi Code.exe
-rw-r--r-- 1 JYH 197121      1096 Sep 24 15:46 LICENSE.electron.txt
-rw-r--r-- 1 JYH 197121   7148150 Sep 24 15:46 resources.pak
-rw-r--r-- 1 JYH 197121    740048 Sep 24 15:46 v8_context_snapshot.bin
drwxr-xr-x 1 JYH 197121          0 Sep 25 03:14 resources
```

`resources/` 下有 `app.asar`（30.6MB）、`app.asar.unpacked/node_modules/node-pty`（内置终端能力）、`desktop-dist/`。`desktop-dist/index.html`（3041 字节）含 `useKimiWebClient` 注释与 `kimi-web.color-scheme` 等 localStorage 键、`<title>Kimi Code</title>`——**桌面版前端就是 kimi web client**；同目录还有 `browser-control.html`（`<title>Kimi Browser Control</title>`）。

### 4.2 进程与端口：桌面版内嵌 HTTP server 监听两个本地端口 【实测】

`Get-Process` 输出：7 个 `Kimi Code.exe`（路径均为 `D:\SoftWares\Kimi Code\Kimi Code.exe`，PID 列表为本机实测值，已隐去）→ Electron 多进程形态。

`netstat -ano -p tcp` 中桌面版主进程（PID 与实例注册表所记一致）监听 `127.0.0.1:54751` 与 `127.0.0.1:54754`（其余监听端口经 PID 反查均属本机其他无关应用）。只读 HTTP 探测输出摘录：

```
$ curl -s -i http://127.0.0.1:54754/        → HTTP/1.1 200 OK, content-length: 3041
  （返回体与 resources/desktop-dist/index.html 逐字节等长，即 kimi web UI）
$ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:54754/api/sessions  → 401
$ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:54754/api/instances → 401
$ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:54754/rc            → 200（SPA 兜底）
$ curl -s -i http://127.0.0.1:54751/          → 404 not found（各路径均 404，含 WebSocket 升级探测；用途未明，疑似内部 IPC 通道）
```

即：**桌面版在本机跑着完整的 kimi web server（web UI + `/api/v1/*` REST，bearer token 鉴权）**。

### 4.3 ~/.kimi-code 结构：实例注册表 + 共享 token（只看名字，未读任何凭证） 【实测】

`ls`/`find` 输出摘录（仅目录结构与文件名）：

```
~/.kimi-code/
├── server/
│   ├── events/          # __global__.jsonl + session_*.jsonl（9 个会话事件流）
│   └── instances/       # <实例标识>.json（1 个活跃实例）
├── server.token         # 43 字节，存在，未读取
├── sessions/            # wd_* 每工作区一个目录
├── workspaces.json, session_index.jsonl, mcp.json, credentials/, plugins/managed/ ...
└── （当前无 server/rc.json → kimi rc 未在运行）
```

`instances/*.json` 仅提取字段名与非敏感值（`grep -o` 键名）：

```
"server_id":"<本机实例标识，已隐去>"  "pid":<桌面版进程PID，已隐去>  "port":54754  "host_version":"2.1.1"
（字段全集：server_id / pid / port / host / host_version / started_at / heartbeat_at）
```

**实例注册表直接给出桌面版 server 的 pid 和端口**——第三方工具无需扫端口即可发现桌面版实例。`host_version` 与 CLI 版本一致（`~/.kimi-code/bin/kimi --version` → `2.1.1`），佐证桌面版内嵌的就是 CLI 同款 server。鉴权 token 即用户自己的 `~/.kimi-code/server.token`（配合官方 `kimi web rotate-token` 可轮换）。

### 4.4 CLI 侧补充：官方文档化的程序化接入 【实测+查证】

`kimi web --help` 实测输出：默认端口 58627、默认绑 127.0.0.1、`--host` 可绑 LAN、`rotate-token` 轮换 token、`--rc` 开启远控、`--dangerous-bypass-auth` 等。【查证】官方文档进一步确认：

- `kimi web --host` **官方支持局域网手机浏览器访问，Web UI 自带手机布局**，建议配 `KIMI_CODE_PASSWORD`：[web.html](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/web.html)。
- **Server API（实验性但官方成文）**：REST `/api/v1`（+`/api/v2/sessions`、`/api/v2/mcp`）+ WebSocket `/api/v1/ws`，bearer token 或 WS 子协议鉴权，提供 `GET /openapi.json`、`GET /asyncapi.json`，覆盖会话/消息/流式事件/审批/文件系统：[server-api.html](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html)。
- **ACP**：`kimi acp` 官方支持（Zed/JetBrains 接入协议）：[kimi-acp.html](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html)。hapi 已用此接入 Kimi。

### 4.5 三条技术路线排序（每条附依据）

**a) 直接对接桌面版本地接口 —— 排第 1（可行，差异化核心）**
依据：实测桌面版内嵌 server（54754 端口、kimi web UI、`/api/v1/*` 401）；实例注册表自动发现（4.3）；鉴权用用户自己的 server.token（自用天然合法，产品化做配对 UX）；官方 Server API 有文档和 openapi.json（4.4）；metabot 在 CLI 侧用同款 Server API 已跑通（第 2 节）。风险：API 官方标注实验性、可能随版本变动（server-api.html 原文警告）；54751 端口用途未明不影响本路线。

**b) 桥接本机 CLI（`kimi web`/`kimi rc` 本地端、`kimi acp`） —— 排第 2（保底，但差异化弱）**
依据：`kimi web --host` 官方原生支持手机 LAN 访问（4.4），0 开发即可用；ACP 协议稳定、有生态（hapi）。但它控制的是 CLI 会话而非桌面版已有会话（1.2）；且官方已自带，做产品等于和官方免费功能正面竞争——适合兜底不适合做卖点。

**c) 完全独立软件（自带 agent 或终端/tmux 中转） —— 排第 3（不推荐）**
依据：QuickTUI（SSH+tmux）、SezSab/kimi-remote（PWA+tmux）是此路线代表；与桌面版会话完全无关，体验绕远，且赛道已有商业玩家。桌面版内置 node-pty（4.1）是官方自己的终端能力，第三方用不上。

## 5. 前景判断：有条件值得做

**官方下场风险：高，且有时间表信号**【推测，依据查证】。PR #4169 于 2026-10-10（调研前一天）提交，桌面版远控集成已在官方私有仓库开发；Kimi Work 2026-09-22 已上线同款功能，说明组织内该能力已产品化过一次；桌面版与 CLI 共用 kap-server（PR 标题），移植成本低。合理推测官方桌面版远控在数月内发布。

**但官方方案大概率 = 付费会员 + 官方中继**（kimi rc 现状如此，Kimi Work 远控走 Kimi App 账号体系）【推测】。第三方「免会员 / 自托管 / 局域网直连 / 隐私不出网」的空间已被 CLI 侧验证：kimi rc 官方远控存在的情况下，Paseo 仍长到 20,381★、hapi 5,211★【查证，第 3 节】。

**差异化空间**：①桌面版会话直达（现在官方/第三方都没有）；②免会员；③自托管/局域网/隐私；④安卓原生体验（官方只有手机浏览器+PWA）；⑤多实例/多工作区管理（官方单机单实例）。

**判断：值得做，条件有二**——(1) 接受窗口期限制，MVP 必须快（数周内），抢在官方发布前建立用户；(2) 定位压在官方不做的差异点上，做好官方发布后转型为「增强层/自托管替代」的准备。若目标是长期垄断型产品，则不值得——官方下场只是时间问题。

## 6. 形态收敛：1 个推荐 + 1 个备选

**推荐：独立软件 ——「电脑端 bridge 服务 + 手机端 PWA（先行）/ 原生安卓（后做）」，对接桌面版内嵌 Server API。**
- 可行性依据【实测+查证】：桌面版 54754 端口跑着完整 kimi web server（4.2）；`server/instances/*.json` 实现零配置实例发现（4.3）；鉴权用用户本机 server.token（配对流程引导用户粘贴/授权读取，或引导 `KIMI_CODE_PASSWORD`）；官方 Server API 文档 + openapi.json/asyncapi.json 给出完整协议面（4.4）；远程层用 Tailscale/自建中继任选。metabot（CLI 侧同款架构）与 larryluozhang/kimi-mobile（kimi web 协议笔记）证明协议对接可行。
- 工作量粗估：MVP（实例发现 + 会话列表/消息流/审批 + PWA + Tailscale 远程）约 2-4 人周；加自建中继、推送、原生安卓再 4-8 人周。主要不确定性是实验性 API 的版本漂移，需做版本适配层。

**备选：零开发/轻量反代工具 —— 把桌面版（或 `kimi web --host`）暴露到局域网/Tailscale。**
- 可行性依据【实测+查证】：自用场景下直接反代 `127.0.0.1:54754`（带 token 的 URL 书签即可打开，kimi web UI 自带手机布局）；CLI 侧 `kimi web --host` 官方原生支持（4.4）；eeljoe/kimi-web-mobile 已在 CLI 侧用「反代+Host/Origin 重写」验证过该思路（第 2 节）。
- 工作量粗估：0.5-2 天（一个反代配置 + 说明文档）；天花板低，无推送/无原生体验，但保底自用足够，且可作为推荐形态的最小验证。

**否决 skill/MCP/插件形态**【实测+查证，非凭空假设】：skill 是 Markdown 提示词文件，无常驻进程能力；MCP server 是「会话内工具面」，随会话起停，不构成独立远控通道（实测 `~/.kimi-code/mcp.json` 为 CLI/桌面共享配置、`plugins/managed/` 存在，但二者都只是给 agent 注入能力，没有任何文档/实测证据表明它们能在桌面版上开远程入口）；Ajwyunsx/kimi-remote 的「插件」实质也是诱导 CLI 侧起服务（1★，单提交）。桌面版唯一可用的程序化接口就是其实测暴露的内嵌 web server。

---

## 附：未验证/假设清单

1. CLI `kimi rc`/`kimi web` 能否列出桌面版创建的会话（共享 sessions 目录，格式同源）——受只读约束未启动实验，【未验证】。
2. 桌面版 54751 端口用途——各路径 404，【未验证】（疑似内部 IPC，不影响结论）。
3. 官方桌面版远控发布时间——仅有开发中证据（PR #4169），无时间表，「数月内」为【推测】。
4. 官方桌面版远控是否同样要求付费会员——按 kimi rc 现状【推测】。
5. Reddit 帖互动量（Reddit 拒抓）、知乎/linux.do 教程全文 URL、QuickTUI 美区定价、Pocket 定价、【未验证】。
6. B站/小红书无相关内容——受搜索引擎收录限制，结论为「未找到」而非「不存在」。
7. kimi-agent-sdk（MoonshotAI 官方仓库）对新版 TS CLI 的兼容性【未验证】。
8. Paseo 对 Kimi 是原生适配还是 ACP 接入——官网未标注【未验证】。
