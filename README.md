# KimiCodeRemote

English | [简体中文](README.zh-CN.md)

Remote-control the **Kimi Code desktop app** from your phone: session list →
live message stream → send prompts → answer approvals/questions. Reachable
from any network (works over 4G) and **end-to-end encrypted** — the relay
only ever carries ciphertext.

> **Disclaimer**: This is an unofficial community project, not affiliated
> with or endorsed by Moonshot AI. Kimi is a trademark of Moonshot AI.

> Official remote control for the desktop app has not shipped yet (PR #4169
> in development) and third-party tools only support the CLI. This project
> is the first working remote for the desktop app. Research notes in
> [REPORT.md](REPORT.md) (Chinese).

## 30-second start

```bash
npm install
npm start          # foreground: prints the pairing URL + QR code
```

The terminal prints a **public pairing URL + QR code** (cloudflared quick
tunnel, no account needed; on first run the matching cloudflared binary for
your OS is downloaded into `bin/` — Windows and macOS are supported).

Open the URL or scan the QR code on your phone (any network, 4G included).
It looks like:

```
https://xxxx.trycloudflare.com/#k=<key>
```

The bridge binds 127.0.0.1 only (nothing reachable from the LAN). If the
tunnel cannot be established, `npm start` fails loudly — just rerun it.

Everything after `#k=` is the entire credential. Prerequisite: the Kimi Code
desktop app is running (the bridge discovers its port automatically via
`~/.kimi-code/server/instances/*.json`).

## Windowless background mode

Prefer no lingering terminal? Run in the background (hidden window on
Windows, logs go to `logs/bridge.log`):

```bash
npm run start:bg   # hidden-window background start; refuses to double-start
npm run pair       # print the current pairing URL + QR code (reads run/state.json)
npm run stop       # graceful stop: close tunnel, reap cloudflared, clean run/
```

- The tunnel takes 10–90 seconds to become ready; `run/state.json` then
  contains `{url, pid, started_at}` — `npm run pair` shows it any time.
- **Desktop-exit follow**: every 15s the bridge checks the desktop instance
  it is attached to; after the pid is gone and healthz has failed 5 times in
  a row (~1 minute) it shuts down and cleans up after itself. Desktop app
  closed → remote control ends, no orphan processes.
- `logs/` and `run/` are gitignored.

### Fixed hostname: named tunnel (optional)

Quick-tunnel URLs change on every restart. With your own Cloudflare account
and domain you can set up a named tunnel once and pin the pairing URL to
`https://<your-domain>` (`bin/cloudflared` is `bin/cloudflared.exe` on
Windows):

```bash
bin/cloudflared tunnel login                                        # browser auth
bin/cloudflared tunnel create kimicoderemote                        # create (note the UUID; the name is kimicoderemote)
bin/cloudflared tunnel route dns kimicoderemote kimi.example.com    # bind your subdomain
```

Then add this to `.kimi-remote.json` (project root, gitignored):

```json
{
  "key": "<your existing key, untouched>",
  "tunnel": { "mode": "named", "name": "kimicoderemote", "hostname": "kimi.example.com" }
}
```

Restart the bridge and it runs `cloudflared tunnel run kimicoderemote`
with a fixed URL. Missing/invalid config falls back to the quick tunnel.

## Architecture (text diagram)

```
┌────────┐  AES-256-GCM envelope   ┌─────────────┐  plaintext+Bearer ┌──────────────────┐
│ phone  │ ──────────────────────▶ │ bridge (PC) │ ────────────────▶ │ Kimi desktop's   │
│ PWA    │ ◀────────────────────── │ :7777       │ ◀──────────────── │ embedded server  │
└────────┘   {iv,ct} ciphertext    └─────────────┘  server.token     │ on 127.0.0.1     │
     │            ▲                     │                            └──────────────────┘
     │ WSS (encrypted frames)           │
     └── /ws encrypted frame bridge ────┴── cloudflared quick tunnel (ciphertext only)
     └── key lives in browser memory; a copy in localStorage
```

- **bridge** (`packages/bridge`, Node+TS): exposes exactly 4 surfaces — the
  static PWA, `GET /healthz`, `POST /box` (encrypted HTTP proxy) and
  `WS /ws` (encrypted bidirectional frame bridge). Everything else is 404.
- **pwa** (`packages/pwa`, Vite+React+TS, mobile-first): built assets are
  served by the bridge directly.
- The desktop app's `server.token` only ever exists in bridge→127.0.0.1
  request headers; it never appears in any response, log, or frontend asset.

## Security model

- **Single-key model**: on first start a random 32-byte key is generated and
  stored in `.kimi-remote.json` in the project root (gitignored). The key is
  the entire credential — whoever can produce valid ciphertext is in,
  everything else gets a 401. No usernames, passwords, or sessions.
- **AES-256-GCM**: a random 12-byte IV per message, 16-byte tag appended to
  the ciphertext, wire format `{iv, ct}` (base64url). The browser side uses
  a pure-JS implementation from [@noble/ciphers](https://github.com/paulmillr/noble-ciphers)
  (no Web Crypto — that is unavailable in non-secure contexts); the bridge
  uses node:crypto. The two interoperate.
- **The relay only carries ciphertext**: the cloudflared quick tunnel
  forwards encrypted envelopes only (the bridge binds 127.0.0.1, no LAN
  port is exposed). What Cloudflare and observers can theoretically see is
  metadata: connection times, traffic sizes, the domain.
- **Allowlist**: after decryption the inner path must match
  `packages/bridge/src/allowlist.ts` (the single allowlist file):
  `/api/v1/healthz`, `GET /api/v2/sessions`, `/api/v1/sessions` and its
  sub-routes (messages/prompts/prompts:steer/approvals/questions/status/
  transcript/children/profile/:delete). Everything else is 403 — notably
  shutdown, config, providers, oauth, fs*, files, remote-control.
- **Key-leak handling**: delete `.kimi-remote.json` and restart the bridge —
  the key rotates immediately and all previously paired URLs stop working.
- **Metadata residue**: the quick tunnel's random subdomain, connection
  times, and traffic sizes are visible to Cloudflare; session
  titles/contents/file paths stay inside the ciphertext. The bridge writes
  no logs to disk (terminal output excepted).
- The phone keeps its key in localStorage (`kimi_remote_key`): mind shared
  phones/browsers. The key in the URL hash is wiped from the address bar
  immediately after load.

## Known limitations

- **Quick-tunnel URLs change on restart**: every `npm start` /
  `npm run start:bg` gets a new `*.trycloudflare.com` and you re-scan; use a
  [named tunnel](#fixed-hostname-named-tunnel-optional) for a stable
  address. If the tunnel is unavailable, startup fails loudly — rerun.
- **Experimental APIs may drift**: the desktop Server API is not guaranteed
  stable. The allowlist lives in `allowlist.ts` and upstream calls in
  `upstream.ts`; a version drift only touches those two files.
- **Creating sessions from the phone**: use the "+" in the session list's
  workspace group; the working directory is that group's workspace. The
  model is taken from the group's (or globally) newest session's
  `activity.model` — sessions created via API must set the model explicitly
  or the turn fails immediately with "Model not set".
- **Simple Markdown rendering**: headings/lists/emphasis/inline code/fenced
  code blocks/quotes/links; no tables or images.
- Every temp workspace created by the remote leaves one `kimi-cu` runner
  process behind (desktop-app behavior); restarting the desktop app
  releases them.

## Commands

| Command | Purpose |
|---|---|
| `npm start` | start the bridge (foreground), print pairing URL + QR |
| `npm run start:bg` | hidden-window background start (logs in `logs/bridge.log`, refuses to double-start) |
| `npm run pair` | print the current pairing URL + QR (needs the tunnel ready) |
| `npm run stop` | graceful stop + cloudflared reaping, verifies no leftovers |
| `npm run build` | build both packages (tsc + vite) |
| `npm run dev` | bridge + vite hot reload (vite proxies to :7777) |
| `npm run verify:discovery` | verify desktop-instance discovery (passes when any live instance is found) |
| `npm run verify:e2e` | end-to-end checks: encrypted refusals/allowlist/404/PONG round-trip |
| `npm run verify:ws` | encrypted WS subscribe → prompt → streaming events within 30s |
| `npm run verify:tunnel` | public tunnel `/healthz` 200 (falls back to loopback check with a notice) |
| `npm run verify:ux` | message-flow paging semantics + workspace-group fields (sends 2 messages in a temp session) |
| `npm run verify:pwa` | PWA message-cleaning assertions (read-only fetch of a real session via the desktop server) |

`verify:*` scripts need the Kimi Code desktop app running on this machine —
they are for local validation, not CI (CI only runs `npm ci` + build).

## Layout

```
packages/bridge/src/
  allowlist.ts   the allowlist (single file)
  upstream.ts    upstream paths & requests (single file)
  crypto.ts      AES-256-GCM envelopes
  discovery.ts   desktop-instance discovery (registry + healthz probing)
  server.ts      http surfaces: /healthz /box /ws static
  wsbridge.ts    encrypted WS protocol + upstream WS reuse
  tunnel.ts      cloudflared download (cross-platform), quick/named tunnels
  runstate.ts    run/ lifecycle: pid/state/stop + desktop-exit watchdog
  cli.ts         npm start entry (prints pairing URL/QR)
  verify/        acceptance scripts (bridge-only, one exception in e2e)
packages/pwa/src/
  api.ts         encrypted /box client + WS auto-reconnect
  crypto.ts      @noble/ciphers envelopes (same format as the bridge)
  views/         pairing / session list (workspace-grouped) / session detail (stream + approvals + questions)
scripts/
  start-bg.mjs   windowless background start (detached+windowsHide)
  stop.mjs       graceful stop + leftover reaping (stop file → taskkill fallback)
  pair.mjs       print pairing URL + QR code
```

## License

[MIT](LICENSE)
