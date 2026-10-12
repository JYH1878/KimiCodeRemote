# KimiCodeRemote

English | [简体中文](README.zh-CN.md)

Remote-control the **Kimi Code desktop app** from your phone: check on sessions, send prompts, and answer approvals/questions while away from your computer. Works over any network (4G included) and is end-to-end encrypted — the relay only ever carries ciphertext. No app to install, no account to create: the phone's browser is the control panel.

> **Disclaimer**: This is an unofficial community project, not affiliated with or endorsed by Moonshot AI. Kimi is a trademark of Moonshot AI.

## Option 1: download the exe and double-click (Windows)

The only prerequisite: the Kimi Code desktop app is **running** on the computer.

1. Download the latest `KimiCodeRemote.exe` from [Releases](https://github.com/JYH1878/KimiCodeRemote/releases).
2. Double-click it — a console window prints the pairing URL and a QR code.
3. Scan the QR code (or open the URL) on your phone. Pairing is done; you are in the control panel.

Practical notes:

- **Windows SmartScreen may warn**: the exe is not code-signed, so the first double-click of a downloaded copy may show "Windows protected your PC" — click "More info → Run anyway".
- **Autostart offer**: on the first double-click you are asked "start automatically with the Kimi Code desktop app?" — press Enter (default yes). From then on it is invisible: it starts when the desktop app opens, exits about a minute after the desktop app closes, and shows no window.
- **Need the QR code again?** Double-click the exe again at any time — it reprints the current pairing URL and QR code, waits for you to press Enter, and exits without disturbing the running service.
- The exe can live anywhere (e.g. your Desktop); all its data goes into `KimiCodeRemote-data\` next to it. Delete `.kimi-remote.json` there to rotate the key (all previously paired URLs stop working), or the whole folder for a factory reset.
- On first run the cloudflared tunnel component is downloaded automatically (honors HTTPS_PROXY and the Windows system proxy; if the download fails, the window stays open and shows how to place the file manually).
- Keep the console window open — closing it ends remote control. If you do not want a window, use the autostart above.

## Option 2: run from source (Windows / macOS)

For reading the code, and for macOS users. Prerequisites: [Node.js](https://nodejs.org/) ≥ 20, and the Kimi Code desktop app running.

```bash
npm install
npm start
```

The terminal prints the pairing URL + QR code — scan and go. On first run cloudflared is downloaded into `bin/` (honors the HTTPS_PROXY environment variable); if the tunnel cannot be established, startup fails loudly and you simply rerun.

Prefer no terminal window? Use background mode:

```bash
npm run start:bg   # background start (hidden window on Windows, logs in logs/bridge.log)
npm run pair       # re-print the current pairing URL + QR code any time
npm run stop       # graceful stop and cleanup
```

The tunnel takes 10–90 seconds to become ready; after that `npm run pair` shows the address any time. When the desktop app closes, the bridge follows and exits on its own — no orphan processes.

You can also build the exe yourself with `npm run build:exe` (output `release/KimiCodeRemote.exe`) — double-click from then on, identical to the download in option 1.

## What you can do from the phone

- **Session list**: grouped by workspace; the "+" on a group creates a new session in that workspace (its model follows the group's newest session)
- **Live message stream**: Kimi's replies stream in real time
- **Send prompts**: give instructions as usual
- **Answer approvals and questions**: tool-call approvals and agent questions can be handled right on the phone

Markdown rendering in the web UI is simplified (no tables or images) — read long-form output on the computer.

## FAQ

- **The URL changes on every restart**, so re-scan after each start. With your own Cloudflare domain you can pin a fixed address — see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) (Chinese).
- **Stopping**: `Ctrl+C` or closing the window in foreground; `npm run stop` in background mode; end `KimiCodeRemote.exe` in Task Manager for the exe.
- **Cannot open / pairing failed**: check the program is still running on the computer, then re-scan with the freshly printed QR code (old URLs may already be invalid).

## Security

- **End-to-end encrypted**: AES-256-GCM. The relay between phone and computer (a Cloudflare tunnel) only carries ciphertext; all an observer can see is connection times and traffic sizes.
- **One key**: everything after `#k=` is the entire credential — no usernames or passwords. The key lives in `.kimi-remote.json` on the computer and in the browser's localStorage on the phone — be careful on shared phones.
- **Key leaked?** Delete `.kimi-remote.json` on the computer and restart: the key rotates immediately and all old URLs are void.
- The program listens on loopback (127.0.0.1) only; nothing is reachable from the LAN, and the encrypted tunnel is the single entry point.

The full security model, API allowlist, and implementation details are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) (Chinese).

## Developers

Architecture, full security model, all commands, acceptance scripts, and directory layout: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) (Chinese).

## License

[MIT](LICENSE)
