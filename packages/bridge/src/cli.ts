// KimiCodeRemote bridge CLI. One command to pair your phone:
//   npm start            (or: node packages/bridge/dist/cli.js)
//   npm run start:bg     hidden-window background mode (see scripts/start-bg.mjs)
// Prints the public (tunnel) pairing URL + QR; the key rides in the #k=
// fragment. The bridge binds loopback only: no tunnel, no remote access -
// if the tunnel cannot be established the CLI fails loudly instead of
// falling back to LAN. The key is printed only on a real terminal - never
// into redirected stdout (log files); background pairing uses `npm run pair`.
import { loadOrCreateKey, readKeyString } from './crypto.js';
import { startBridge } from './server.js';
import { DEFAULT_PORT, KEY_FILE } from './config.js';
import {
  cleanupRunFiles,
  startDesktopWatchdog,
  startStopFileWatcher,
  writePidFile,
  writeStateFile,
} from './runstate.js';
import * as QRCode from 'qrcode';

function parseArgs(argv: string[]): { port: number; tunnel: boolean } {
  let port = DEFAULT_PORT;
  let tunnel = true;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') port = Number(argv[++i]);
    else if (a === '--no-tunnel') tunnel = false;
    else if (a === '--tunnel') tunnel = true;
    else if (a === '--help' || a === '-h') {
      console.log('usage: kimicoderemote-bridge [--port 7777] [--no-tunnel]');
      console.log('background mode: npm run start:bg / stop / pair');
      process.exit(0);
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('invalid port');
    process.exit(1);
  }
  return { port, tunnel };
}

async function printQr(label: string, url: string): Promise<void> {
  console.log(`\n${label}:\n${url}`);
  try {
    console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
  } catch {
    /* qr is best-effort */
  }
}

async function main(): Promise<void> {
  const { port, tunnel } = parseArgs(process.argv);
  const startedAt = Date.now();
  console.log('KimiCodeRemote bridge');
  console.log(`pairing key file: ${KEY_FILE} (delete it to rotate the key)`);
  const key = loadOrCreateKey(KEY_FILE);
  if (key.length !== 32) process.exit(1); // paranoia; loadOrCreateKey already validates

  const bridge = await startBridge({ port, keyFile: KEY_FILE, tunnel });
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
  process.exit(1);
});
