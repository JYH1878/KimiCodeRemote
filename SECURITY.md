# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Use
[GitHub Security Advisories](https://github.com/security/advisories) ->
"Report a new vulnerability" (or the *Security* tab of this repository) so the
report stays private until a fix is released. Include reproduction steps and
the bridge/PWA versions involved if you can.

## Supported versions

Only the latest commit on `main` is supported. There are no stable releases
yet; please re-test against `main` before reporting.

## Threat model reminders

- All traffic between the phone PWA and the bridge is AES-256-GCM encrypted
  end to end. The cloudflared tunnel and any observer can only see ciphertext
  and metadata (timing, sizes, domains).
- The pairing key (`.kimi-remote.json` on the computer) is the *only*
  credential. Never paste it into issues, logs, or screenshots.

## If the pairing key leaks

Delete `.kimi-remote.json` in the project root and restart the bridge: a
fresh 32-byte key is generated on startup and every previously paired URL
stops working immediately.

## Scope

- Issues in Kimi Code itself (the desktop app or its CLI) are out of scope -
  report those upstream.
- The bridge deliberately never exposes anything other than the static PWA,
  `GET /healthz`, `POST /box`, and `WS /ws`, and only binds `127.0.0.1`.
  Reports of "other endpoints reachable" should first check that they are not
  hitting the upstream desktop server directly.
