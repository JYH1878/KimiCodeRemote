# KimiCodeRemote

[English](README.md) | 简体中文

用手机远控电脑上的 **Kimi Code 桌面版**：出门在外也能看会话进度、发消息、应答审批和提问。手机用 4G 就能连，全程端到端加密——中继服务器只搬运密文。不用装 App，不用注册账号，手机浏览器打开一个网址就是控制界面。

> **免责声明**：本项目为非官方社区项目，与 Moonshot AI 无任何关联，亦未获其授权或认可。Kimi 是 Moonshot AI 的商标。

> 官方桌面版远控尚未发布（PR #4169 开发中），第三方产品均只支持 CLI。本项目是桌面版的首个可用远控方案。调研依据见 [REPORT.md](REPORT.md)。

## 方式一：下载 exe，双击即用（Windows）

前提只有一个：电脑上**正在运行** Kimi Code 桌面版。

1. 从 [Releases](https://github.com/JYH1878/KimiCodeRemote/releases) 下载最新的 `KimiCodeRemote.exe`（约 93 MB）。
2. 双击它——控制台窗口会打印配对地址和二维码。
3. 手机扫码（或用手机浏览器打开该地址），完成配对，进入控制界面。

几个实操提示：

- **Windows SmartScreen 可能拦截**：exe 没有做代码签名，下载后首次双击可能弹「Windows 已保护你的电脑」——点「更多信息 → 仍要运行」即可。
- **首次双击会问**「以后随 Kimi Code 桌面版自动启动？」，回车（默认装）即可。装好后完全无感：桌面版一开它就启动，桌面版一关它约一分钟内自动退出，没有窗口。
- exe 可以拷到任何位置（比如桌面）；所有数据放在它旁边的 `KimiCodeRemote-data\`。删其中的 `.kimi-remote.json` 即换钥匙（旧配对地址全部失效），删整个文件夹即恢复出厂。
- 首次运行会自动下载隧道组件 cloudflared（需要联网——本来就是联网用的）。
- 弹出的控制台窗口别关，关了远控就断；不想看到窗口就用上面的开机自启。

## 方式二：从源码运行（Windows / macOS）

适合想看代码的用户和 macOS 用户。前提：装有 [Node.js](https://nodejs.org/) ≥ 20，且 Kimi Code 桌面版运行中。

```bash
npm install
npm start
```

终端打印配对地址 + 二维码，手机扫码即用。首次运行会自动下载 cloudflared 到 `bin/`；隧道不可用时启动会直接报错退出，重跑一次即可。

不想留终端窗口，用后台模式：

```bash
npm run start:bg   # 后台启动（Windows 隐藏窗口，日志在 logs/bridge.log）
npm run pair       # 随时重新打印配对地址 + 二维码
npm run stop       # 优雅停止并清理
```

隧道就绪需要 10–90 秒，之后 `npm run pair` 随时可看地址。桌面版关闭后 bridge 会自动跟着退出，不留孤儿进程。

在源码目录里也可以 `npm run build:exe` 自己打出 exe（产物 `release/KimiCodeRemote.exe`），之后双击即用，与方式一下载的完全相同。

## 手机上能做什么

- **会话列表**：按工作区分组，点分组的「+」可在对应工作区新建会话（模型取该工作区最新会话的模型）
- **实时消息流**：Kimi 的回复流式刷新
- **发消息**：像平时一样下指令
- **应答审批和提问**：工具调用审批、agent 提问都能在手机上直接处理

网页端的 Markdown 是简渲染（没有表格和图片），精细阅读回电脑上看。

## 常见问题

- **网址每次重启都会变**，需要重新扫码。有自己的 Cloudflare 域名可以配置固定地址，方法见[开发者文档](docs/DEVELOPMENT.md)。
- **怎么停止**：前台模式按 `Ctrl+C` 或关掉窗口；后台模式 `npm run stop`；exe 在任务管理器里结束 `KimiCodeRemote.exe`。
- **打不开 / 配对失败**：先看电脑上的程序还在不在运行，再用最新打印的二维码重扫一次（旧地址可能已失效）。

## 安全（一分钟版）

- **端到端加密**：AES-256-GCM，手机和电脑之间的中继（Cloudflare 隧道）只搬运密文，能看到的只有连接时间和流量大小。
- **一把钥匙**：`#k=` 后的钥匙即全部凭证，没有用户名和密码。钥匙存在电脑上的 `.kimi-remote.json`，手机上存浏览器 localStorage——共用手机时注意。
- **钥匙泄露了**：删掉电脑上的 `.kimi-remote.json` 重启程序，钥匙立即更换，旧地址全部作废。
- 程序只监听本机回环（127.0.0.1），局域网无法直连，对外只有加密隧道一个入口。

完整的安全模型、API 白名单和实现细节见[开发者文档](docs/DEVELOPMENT.md)。

## 开发者

架构、完整安全模型、全部命令、验收脚本与目录结构：[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 许可证

[MIT](LICENSE)
