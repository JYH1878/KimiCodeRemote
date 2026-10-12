// KimiCodeRemote bridge CLI. One command to pair your phone:
//   npm start            (or: node packages/bridge/dist/cli.js)
//   npm run start:bg     hidden-window background mode (see scripts/start-bg.mjs)
//   KimiCodeRemote.exe   packaged single-executable build (double-click)
// Prints the public (tunnel) pairing URL + QR; the key rides in the #k=
// fragment. The bridge binds loopback only: no tunnel, no remote access -
// if the tunnel cannot be established the CLI fails loudly instead of
// falling back to LAN. The key is printed only on a real terminal - never
// into redirected stdout (log files); background pairing uses `npm run pair`.
//
// Extra modes for the packaged exe:
//   --watch               poll for the Kimi Code desktop app; spawn a hidden
//                         bridge child when it appears, keep watching when it
//                         exits (the bridge follows the desktop app on its own).
//   --install-autostart   write the Startup-folder .vbs (exe --watch at logon)
//   --uninstall-autostart remove it
// A second instance hitting EADDRINUSE just re-prints the running bridge's
// pairing URL + QR and exits 0 (double-click = show the code again).
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { loadOrCreateKey, readKeyString } from './crypto.js';
import { startBridge } from './server.js';
import {
  DATA_ROOT,
  DEFAULT_PORT,
  DEFAULT_TUNNEL,
  KEY_FILE,
  LOG_DIR,
  SEA_MODE,
  STATE_FILE,
} from './config.js';
import {
  cleanupRunFiles,
  startDesktopWatchdog,
  startStopFileWatcher,
  writePidFile,
  writeStateFile,
} from './runstate.js';
import { healthzReachable, pidAlive, readInstanceFiles } from './discovery.js';
import { autostartVbsPath, installAutostart, uninstallAutostart } from './autostart.js';
import * as QRCode from 'qrcode';

// this script itself (dev mode: dist/cli.js handed to node as the child's
// entry; unused in SEA mode - the exe is the entry). import.meta.url is
// undefined inside the SEA bundle's CJS shim, hence the guard.
const SELF_SCRIPT: string = (() => {
  const url: unknown = import.meta.url;
  return typeof url === 'string' ? fileURLToPath(url) : '';
})();

interface CliArgs {
  port: number;
  tunnel: boolean;
  watch: boolean;
  autostart: 'install' | 'uninstall' | null;
}

function parseArgs(argv: string[]): CliArgs {
  let port = DEFAULT_PORT;
  let tunnel = DEFAULT_TUNNEL;
  let watch = false;
  let autostart: 'install' | 'uninstall' | null = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') port = Number(argv[++i]);
    else if (a === '--no-tunnel') tunnel = false;
    else if (a === '--tunnel') tunnel = true;
    else if (a === '--watch') watch = true;
    else if (a === '--install-autostart') autostart = 'install';
    else if (a === '--uninstall-autostart') autostart = 'uninstall';
    else if (a === '--help' || a === '-h') {
      console.log('usage: kimicoderemote-bridge [--port 7777] [--no-tunnel] [--watch]');
      console.log('                     [--install-autostart | --uninstall-autostart]');
      console.log('background mode: npm run start:bg / stop / pair');
      console.log('exe: --watch follows the Kimi Code desktop app; autostart flags manage the logon entry');
      process.exit(0);
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('invalid port');
    process.exit(1);
  }
  return { port, tunnel, watch, autostart };
}

async function printQr(label: string, url: string): Promise<void> {
  console.log(`\n${label}:\n${url}`);
  try {
    console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
  } catch {
    /* qr is best-effort */
  }
}

// Packaged exe + real console (double-click): hold the window open so the
// message above can actually be read before the process exits. npm start
// users have terminal scrollback; piped/background runs must never block.
async function pauseBeforeExit(): Promise<void> {
  if (!SEA_MODE) return;
  if (!process.stdin?.isTTY || !process.stdout?.isTTY) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question('\n按回车键退出 / press Enter to exit…');
  } catch {
    /* stdin closed */
  } finally {
    rl.close();
  }
}

function appendWatcherLog(line: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, 'watcher.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* best effort */
  }
}

// Is a desktop instance actually alive? Same primitives as discoverUpstream
// (instance registry + pid + healthz) but never throws, and liveness is always
// enforced: the forced-instance test hook must not bypass it here, or a stale
// registry entry would start a bridge against a dead desktop.
async function desktopAlive(): Promise<boolean> {
  try {
    for (const inst of readInstanceFiles()) {
      if (typeof inst.pid === 'number' && !pidAlive(inst.pid)) continue;
      if (await healthzReachable(inst.port)) return true;
    }
  } catch {
    /* registry unreadable - treat as no desktop */
  }
  return false;
}

// Poll for the desktop app every 15s; when it is alive and no child is
// running, spawn a hidden bridge child with the same port/tunnel settings.
// The child owns its own lifecycle (it exits when the desktop app closes via
// its own watchdog); we just keep watching and respawn next time it is needed.
async function runWatcher(port: number, tunnel: boolean): Promise<void> {
  console.log('watcher: waiting for the Kimi Code desktop app (poll every 15s)');
  let child: ReturnType<typeof spawn> | null = null;
  let probing = false;

  // Dynamic settings ride in the environment (validated: port is an integer
  // 1..65535, tunnel a boolean -> env KIMI_REMOTE_PORT / KIMI_REMOTE_NO_TUNNEL);
  // the child's argv stays a fixed literal array. Dev mode (node dist/cli.js)
  // needs the script path as the single argument.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    KIMI_REMOTE_PORT: String(port),
    ...(tunnel ? {} : { KIMI_REMOTE_NO_TUNNEL: '1' }),
  };

  const spawnBridge = (): void => {
    const c = spawn(process.execPath, SEA_MODE ? [] : [SELF_SCRIPT], {
      env: childEnv,
      windowsHide: true,
      stdio: 'ignore',
    });
    child = c;
    appendWatcherLog(`spawned bridge pid ${c.pid ?? '?'} (port ${port}, tunnel ${tunnel})`);
    c.once('exit', (code) => {
      appendWatcherLog(`bridge pid ${c.pid ?? '?'} exited (code ${code})`);
      if (child === c) child = null;
    });
  };

  const tick = (): void => {
    if (child || probing) return;
    probing = true;
    void desktopAlive()
      .then((alive) => {
        probing = false;
        if (alive && !child) spawnBridge();
      })
      .catch(() => {
        probing = false;
      });
  };

  const bye = (): void => {
    clearInterval(timer);
    try {
      child?.kill();
    } catch {
      /* already gone */
    }
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  startStopFileWatcher(bye);

  const timer = setInterval(tick, 15_000);
  tick();
}

// First-run autostart question (packaged exe, real console only): the answer
// is remembered in the key file so we never ask twice.
async function askAutostartOnce(): Promise<void> {
  if (!SEA_MODE) return;
  let asked = false;
  try {
    asked = (JSON.parse(readFileSync(KEY_FILE, 'utf8')) as { autostart_asked?: boolean })
      .autostart_asked === true;
  } catch {
    /* not answered yet */
  }
  if (asked) return;
  if (!process.stdin?.isTTY || !process.stdout?.isTTY) return; // double-click console only
  console.log('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer = '';
  try {
    answer = (await rl.question('以后随 Kimi Code 桌面版自动启动？[Y/n] ')).trim().toLowerCase();
  } catch {
    /* stdin closed - default to yes below */
  } finally {
    rl.close();
  }
  try {
    const cfg = JSON.parse(readFileSync(KEY_FILE, 'utf8')) as Record<string, unknown>;
    // rewrite preserving every other field (key, tunnel config, ...)
    writeFileSync(KEY_FILE, JSON.stringify({ ...cfg, autostart_asked: true }, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    /* key file gone - nothing to mark */
  }
  if (answer === '' || answer === 'y' || answer === 'yes') {
    try {
      const vbs = installAutostart(process.execPath);
      console.log(`autostart installed: ${vbs} (runs hidden at logon; remove: --uninstall-autostart)`);
    } catch (e) {
      console.error(`autostart install failed: ${(e as Error).message}`);
    }
  } else {
    console.log('autostart: not installed (run with --install-autostart to add it later)');
  }
}

// Second instance (double-click while a bridge already owns the port): show
// the running bridge's pairing URL + QR, then exit cleanly. No single-
// instance lock by design.
async function printSecondInstancePairing(): Promise<void> {
  console.log('\nanother bridge is already listening on this port - showing its pairing info.');
  let state: { url?: unknown; pid?: unknown } | null = null;
  try {
    state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { url?: unknown; pid?: unknown };
  } catch {
    /* no state file (yet) */
  }
  const url = state?.url;
  if (typeof url === 'string' && url.startsWith('https://')) {
    const keyStr = readKeyString(KEY_FILE);
    if (process.stdout.isTTY) {
      await printQr('PUBLIC pairing URL (works on any network)', `${url}/#k=${keyStr}`);
    } else {
      console.log(`already running (pid ${state?.pid ?? '?'}): ${url}/#k=<redacted - run in a console window for the QR>`);
    }
    await pauseBeforeExit(); // double-clicker needs time to scan the QR
    process.exit(0);
  }
  console.error('the running bridge has not finished establishing its tunnel yet - retry in a moment.');
  await pauseBeforeExit();
  process.exit(0);
}

async function main(): Promise<void> {
  const { port, tunnel, watch, autostart } = parseArgs(process.argv);

  if (autostart) {
    if (!SEA_MODE) {
      console.error('autostart flags are only supported by the packaged KimiCodeRemote.exe');
      process.exit(1);
    }
    if (autostart === 'install') {
      const vbs = installAutostart(process.execPath);
      console.log(`autostart installed: ${vbs}`);
    } else {
      const removed = uninstallAutostart();
      console.log(removed ? `autostart removed: ${autostartVbsPath()}` : 'autostart was not installed');
    }
    process.exit(0);
  }

  if (watch) {
    await runWatcher(port, tunnel);
    return;
  }

  const startedAt = Date.now();
  console.log('KimiCodeRemote bridge');
  console.log(`pairing key file: ${KEY_FILE} (delete it to rotate the key)`);
  if (SEA_MODE) mkdirSync(DATA_ROOT, { recursive: true }); // fresh exe on first double-click: data dir may not exist yet
  const key = loadOrCreateKey(KEY_FILE);
  if (key.length !== 32) process.exit(1); // paranoia; loadOrCreateKey already validates

  await askAutostartOnce();

  let bridge: Awaited<ReturnType<typeof startBridge>>;
  try {
    bridge = await startBridge({ port, keyFile: KEY_FILE, tunnel });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      await printSecondInstancePairing(); // exits 0
    }
    throw e;
  }
  const keyStr = readKeyString(KEY_FILE);
  const fragment = `#k=${keyStr}`;

  writePidFile(process.pid);

  bridge.tunnelReady.then(async (url) => {
    if (url) {
      // Never write the pairing key to a redirected (log-file) stdout: print
      // the full URL+QR only on a real terminal; background users run `npm run pair`.
      if (process.stdout.isTTY) {
        await printQr('PUBLIC pairing URL (works on any network)', `${url}/${fragment}`);
        console.log('note: quick-tunnel URLs change on every bridge restart.');
        console.log('the tunnel carries ciphertext only.');
      } else {
        console.log(`tunnel ready: ${url} (key redacted - run \`npm run pair\` for the pairing URL + QR)`);
      }
      writeStateFile({ url, pid: process.pid, started_at: startedAt });
      return;
    }
    if (!tunnel) {
      console.log(`\ntunnel disabled (--no-tunnel): dev mode on http://127.0.0.1:${bridge.port}`);
      return;
    }
    console.error('\nfatal: tunnel unavailable (see log above) - no remote access. fix the network and rerun npm start.');
    await pauseBeforeExit();
    await bye('tunnel unavailable', 1);
  });

  let closing = false;
  async function bye(reason: string, code = 0): Promise<void> {
    if (closing) return;
    closing = true;
    console.log(`\nshutting down (${reason})...`);
    cleanupRunFiles(process.pid);
    setTimeout(() => process.exit(code), 3000).unref(); // close() must not hang us
    try {
      await bridge.close();
    } finally {
      process.exit(code);
    }
  }
  process.on('SIGINT', () => void bye('sigint'));
  process.on('SIGTERM', () => void bye('sigterm'));

  // graceful stop signal from `npm run stop` (flag file; Windows has no
  // cross-process graceful signals)
  startStopFileWatcher(() => void bye('stop file (npm run stop)'));

  // follow the desktop app: when its instance is gone, we are useless
  startDesktopWatchdog(bridge.instance, (reason) => void bye(reason), (s) =>
    console.log(`[bridge] ${s}`),
  );
}

void main().catch((e: Error) => {
  console.error(`fatal: ${e.message}`);
  void pauseBeforeExit().finally(() => process.exit(1));
});
