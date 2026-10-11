// kimi-remote bridge CLI. One command to pair your phone:
//   npm start            (or: node packages/bridge/dist/cli.js)
// Prints the public (tunnel) pairing URL + QR; the key rides in the #k=
// fragment. The bridge binds loopback only: no tunnel, no remote access -
// if the tunnel cannot be established the CLI fails loudly instead of
// falling back to LAN. The key never appears in logs beyond the pairing print.
import { loadOrCreateKey, readKeyString } from './crypto.js';
import { startBridge } from './server.js';
import { DEFAULT_PORT, KEY_FILE } from './config.js';
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
      console.log('usage: kimi-remote-bridge [--port 7777] [--no-tunnel]');
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
  console.log('kimi-remote bridge');
  console.log(`pairing key file: ${KEY_FILE} (delete it to rotate the key)`);
  const key = loadOrCreateKey(KEY_FILE);
  if (key.length !== 32) process.exit(1); // paranoia; loadOrCreateKey already validates

  const bridge = await startBridge({ port, keyFile: KEY_FILE, tunnel });
  const keyStr = readKeyString(KEY_FILE);
  const fragment = `#k=${keyStr}`;

  bridge.tunnelReady.then(async (url) => {
    if (url) {
      await printQr('PUBLIC pairing URL (works on any network)', `${url}/${fragment}`);
      console.log('note: quick-tunnel URLs change on every bridge restart.');
      console.log('the tunnel carries ciphertext only.');
      return;
    }
    if (!tunnel) {
      console.log(`\ntunnel disabled (--no-tunnel): dev mode on http://127.0.0.1:${bridge.port}`);
      return;
    }
    console.error('\nfatal: tunnel unavailable (see log above) - no remote access. fix the network and rerun npm start.');
    await bridge.close();
    process.exit(1);
  });

  const bye = () => {
    console.log('\nshutting down...');
    void bridge.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

void main().catch((e: Error) => {
  console.error(`fatal: ${e.message}`);
  process.exit(1);
});
