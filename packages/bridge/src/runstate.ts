// run/ artifacts and lifecycle watchers for background operation:
//   bridge.pid  - who owns the loopback port (single instance, `npm run stop`)
//   state.json  - {url, pid, started_at} pairing info for `npm run pair`
//   bridge.stop - flag file polled by the bridge for graceful shutdown
//   watchdog    - follow the desktop app: when its process is gone AND its
//                 healthz is dead for 5 consecutive 15s checks, exit quietly.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PID_FILE, STATE_FILE, STOP_FILE } from './config.js';
import { healthzReachable, pidAlive, type Instance } from './discovery.js';

export interface BridgeState {
  url: string;
  pid: number;
  started_at: number;
}

export function writePidFile(pid: number): void {
  mkdirSync(dirname(PID_FILE), { recursive: true });
  writeFileSync(PID_FILE, String(pid));
}

export function writeStateFile(state: BridgeState): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Remove our run/ artifacts. Ownership-guarded: a pid file/state written by a
// different (newer) bridge is left alone; ours go.
export function cleanupRunFiles(pid: number): void {
  try {
    if (readFileSync(PID_FILE, 'utf8').trim() === String(pid)) rmSync(PID_FILE, { force: true });
  } catch {
    /* already gone */
  }
  try {
    const st = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { pid?: number };
    if (st?.pid === pid) rmSync(STATE_FILE, { force: true });
  } catch {
    /* already gone */
  }
  try {
    if (existsSync(STOP_FILE)) rmSync(STOP_FILE, { force: true });
  } catch {
    /* already gone */
  }
}

// `npm run stop` drops the flag file; poll it and shut down gracefully.
// (A cross-process SIGTERM on Windows is a hard kill and would orphan
// cloudflared, so the flag file is the actual stop signal.)
export function startStopFileWatcher(onStop: () => void, intervalMs = 1000): void {
  const timer = setInterval(() => {
    if (existsSync(STOP_FILE)) {
      clearInterval(timer);
      onStop();
    }
  }, intervalMs);
  timer.unref();
}

export interface WatchdogOptions {
  intervalMs?: number; // default 15s
  misses?: number; // consecutive dead checks before exit, default 5
}

// Desktop-exit follow: the desktop instance is considered gone only when its
// pid no longer exists AND healthz fails; 5 consecutive misses -> graceful exit.
// An immediate first check keeps the worst-case detection at ~4 intervals.
export function startDesktopWatchdog(
  instance: Instance,
  onExit: (reason: string) => void,
  log: (s: string) => void = console.log,
  opts: WatchdogOptions = {},
): void {
  const intervalMs = opts.intervalMs ?? 15_000;
  const needed = opts.misses ?? 5;
  let misses = 0;
  const probe = async () => {
    const pidGone = typeof instance.pid === 'number' && !pidAlive(instance.pid);
    if (!pidGone) {
      misses = 0;
      return;
    }
    const healthy = await healthzReachable(instance.port);
    if (healthy) {
      misses = 0;
      return;
    }
    misses++;
    log(`watchdog: desktop instance 127.0.0.1:${instance.port} gone (pid ${instance.pid} dead, healthz failing) - ${misses}/${needed}`);
    if (misses >= needed) {
      clearInterval(timer);
      onExit('desktop instance gone');
    }
  };
  const timer = setInterval(() => void probe(), intervalMs);
  timer.unref();
  void probe();
}
