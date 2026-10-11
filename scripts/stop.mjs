// npm run stop - gracefully stop a running bridge (start:bg or npm start).
// Graceful path: drop run/bridge.stop; the bridge polls it, tears down the
// tunnel child and exits. Fallback after 15s: taskkill /F /T (or kill) the
// whole tree. Finally verify: nothing on the port, no cloudflared from this
// repo's bin/ left behind.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUN_DIR = join(ROOT, 'run');
const PID_FILE = join(RUN_DIR, 'bridge.pid');
const STATE_FILE = join(RUN_DIR, 'state.json');
const STOP_FILE = join(RUN_DIR, 'bridge.stop');
const PORT = Number(process.env.KIMI_REMOTE_PORT || 7777);
const IS_WIN = process.platform === 'win32';

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

function readLivePid() {
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) return pid;
  } catch {
    /* no pid file */
  }
  return null;
}

function portListenerPid() {
  if (IS_WIN) {
    const r = run('netstat', ['-ano', '-p', 'tcp']);
    for (const line of r.out.split(/\r?\n/)) {
      const m = line.match(new RegExp(`\\S+:${PORT}\\s.*LISTENING\\s+(\\d+)`));
      if (m) return Number(m[1]);
    }
    return null;
  }
  const r = run('sh', ['-c', `lsof -ti tcp:${PORT} -sTCP:LISTEN || true`]);
  const pid = Number((r.out || '').trim().split(/\s+/)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function killTree(pid) {
  if (IS_WIN) return run('taskkill', ['/F', '/T', '/PID', String(pid)]);
  try {
    process.kill(-pid, 'SIGKILL'); // process group
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  return { ok: true, out: '' };
}

// cloudflared children orphaned by a hard-killed bridge: match by this repo's
// bin path in the command line, never by bare process name.
function findOrphanCloudflared() {
  const needle = join(ROOT, 'bin', IS_WIN ? 'cloudflared.exe' : 'cloudflared').toLowerCase();
  if (IS_WIN) {
    const r = run('powershell', [
      '-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"name='cloudflared.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ]);
    if (!r.out.trim()) return [];
    let list;
    try {
      const parsed = JSON.parse(r.out);
      list = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
    return list
      .filter((p) => typeof p.CommandLine === 'string' && p.CommandLine.toLowerCase().includes(needle))
      .map((p) => Number(p.ProcessId))
      .filter((n) => Number.isInteger(n) && n > 0);
  }
  const r = run('sh', ['-c', `pgrep -af cloudflared || true`]);
  return r.out
    .split(/\r?\n/)
    .filter((l) => l.toLowerCase().includes(needle))
    .map((l) => Number(l.split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function cleanupRunFiles() {
  for (const f of [PID_FILE, STATE_FILE, STOP_FILE]) {
    try {
      if (existsSync(f)) rmSync(f, { force: true });
    } catch {
      /* best effort */
    }
  }
}

let pid = readLivePid();

if (!pid) {
  // no pid file (crashed run, or a foreground `npm start`): fall back to
  // whoever holds the port
  pid = portListenerPid();
  if (pid) {
    console.log(`pid 文件缺失，按端口 ${PORT} 找到 pid ${pid}（硬停止）`);
    killTree(pid);
  } else {
    console.log('bridge 未在运行。');
  }
} else {
  console.log(`向 bridge (pid ${pid}) 发送停止信号…`);
  writeFileSync(STOP_FILE, String(Date.now()));
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && pidAlive(pid)) {
    await new Promise((r) => setTimeout(r, 300));
  }
  if (pidAlive(pid)) {
    console.log('15 秒未优雅退出，强制结束进程树…');
    killTree(pid);
  }
}

// residual check: orphaned cloudflared from THIS repo
const orphans = findOrphanCloudflared();
for (const orph of orphans) {
  console.log(`回收残留 cloudflared (pid ${orph})`);
  killTree(orph);
}

// wait a beat for socket teardown, then verify
await new Promise((r) => setTimeout(r, 1500));
cleanupRunFiles();

const listener = portListenerPid();
const remaining = findOrphanCloudflared();
if (listener || remaining.length > 0) {
  console.error(`停止后仍有残留: port=${PORT} listener pid=${listener ?? '无'}, cloudflared=[${remaining.join(', ')}]`);
  process.exit(1);
}
console.log(`bridge 已停止（端口 ${PORT} 无监听，无 cloudflared 残留）。`);
