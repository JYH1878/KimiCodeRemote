// npm run start:bg - launch the bridge as a hidden background process.
// Windows: node itself owns a hidden console (detached + windowsHide), the
// equivalent of the classic wscript/VBS trick without a wrapper script.
// Output goes to logs/bridge.log; lifecycle artifacts live in run/.
// Already running (live pid in run/bridge.pid)? Say so and do nothing.
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'packages', 'bridge', 'dist', 'cli.js');
const RUN_DIR = join(ROOT, 'run');
const PID_FILE = join(RUN_DIR, 'bridge.pid');
const LOG_FILE = join(ROOT, 'logs', 'bridge.log');
const PORT = Number(process.env.KIMI_REMOTE_PORT || 7777);

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // EPERM = exists, no permission
  }
}

function readLivePid() {
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) return pid;
    rmSync(PID_FILE, { force: true }); // stale file from a crashed run
  } catch {
    /* no pid file */
  }
  return null;
}

async function waitForHealthz(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

if (!existsSync(CLI)) {
  console.error('bridge 未构建：先运行 npm run build');
  process.exit(1);
}

const running = readLivePid();
if (running) {
  console.log(`bridge 已在运行 (pid ${running})，不重复启动。`);
  console.log('  配对地址: npm run pair    停止: npm run stop');
  process.exit(0);
}

mkdirSync(join(ROOT, 'logs'), { recursive: true });
mkdirSync(RUN_DIR, { recursive: true });
appendFileSync(LOG_FILE, `\n===== start:bg ${new Date().toISOString()} =====\n`);

const out = openSync(LOG_FILE, 'a');
const child = spawn(process.execPath, [CLI], {
  cwd: ROOT,
  detached: true, // survives this npm process; own (hidden) console on Windows
  stdio: ['ignore', out, out],
  windowsHide: true,
});
child.unref();
closeSync(out);

console.log(`bridge 后台启动中 (pid ${child.pid})，日志: logs/bridge.log`);
const up = await waitForHealthz(30_000);
if (!up) {
  console.error('30 秒内 healthz 未就绪，最近的日志输出：');
  try {
    const tail = readFileSync(LOG_FILE, 'utf8').split('\n').slice(-25).join('\n');
    console.error(tail);
  } catch {
    /* log unreadable */
  }
  process.exit(1);
}
console.log(`bridge 已就绪 (http://127.0.0.1:${PORT}/healthz ok)`);
console.log('隧道就绪需要 10-90 秒；配对地址: npm run pair（含二维码）');
