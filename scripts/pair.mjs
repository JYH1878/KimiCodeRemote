// npm run pair - print the current pairing URL + QR for a running bridge.
// The bridge writes run/state.json once its tunnel is ready. The pairing key
// rides in the #k= fragment (never sent to the tunnel/Cloudflare).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = join(ROOT, 'run', 'state.json');
const KEY_FILE = join(ROOT, '.kimi-remote.json');

let state;
try {
  state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
} catch {
  console.error('未找到 run/state.json：bridge 未启动，或隧道尚未就绪（快速隧道需 10-90 秒）。');
  console.error('先运行 npm run start:bg，稍后重试。');
  process.exit(1);
}
if (typeof state.url !== 'string' || !state.url.startsWith('https://')) {
  console.error('run/state.json 内容异常：', JSON.stringify(state).slice(0, 200));
  process.exit(1);
}

let key;
try {
  key = JSON.parse(readFileSync(KEY_FILE, 'utf8')).key;
} catch {
  console.error(`配对钥匙文件不可读：${KEY_FILE}`);
  process.exit(1);
}

const pairingUrl = `${state.url}/#k=${key}`;
console.log(`bridge pid ${state.pid ?? '?'}，启动于 ${state.started_at ? new Date(state.started_at).toLocaleString('zh-CN') : '?'}`);
console.log('\n配对地址（手机浏览器打开，或扫码）：\n' + pairingUrl);
try {
  console.log(await qrcode.toString(pairingUrl, { type: 'terminal', small: true }));
} catch {
  /* qr is best-effort */
}
