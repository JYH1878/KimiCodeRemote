// kimi-remote bridge CLI. One command to pair your phone:
//   npm start            (or: node packages/bridge/dist/cli.js)
// Prints LAN + public pairing URLs (with the key in the #k= fragment) and QR
// codes. The key never appears in logs beyond this intentional pairing print.
import { loadOrCreateKey, readKeyString } from './crypto.js';
import { startBridge } from './server.js';
import { DEFAULT_PORT, KEY_FILE } from './config.js';
import { lanAddresses } from './net.js';
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

  const lans = lanAddresses().map((ip) => `http://${ip}:${bridge.port}/${fragment}`);
  if (lans.length === 0) {
    console.log(`\nLAN: no routable IPv4 found - use http://localhost:${bridge.port}/${fragment}`);
  }
  for (const [i, url] of lans.entries()) {
    await printQr(i === 0 ? 'LAN pairing URL (scan with phone)' : 'LAN pairing URL (alternate)', url);
    if (i === 0) break; // one QR for the primary LAN address is enough
  }
  for (const url of lans.slice(1)) console.log(`also: ${url}`);

  bridge.tunnelReady.then(async (url) => {
    if (url) {
      await printQr('PUBLIC pairing URL (works on 4G)', `${url}/${fragment}`);
      console.log('note: quick-tunnel URLs change on every bridge restart.');
      console.log('the tunnel carries ciphertext only.');
    } else {
      console.log('\nPUBLIC URL: unavailable (see log above) - LAN-only mode.');
    }
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
