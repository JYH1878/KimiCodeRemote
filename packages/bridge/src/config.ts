// Central path/config constants for the bridge.
import { homedir, tmpdir } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/bridge/dist

export const REPO_ROOT = join(HERE, '..', '..', '..');
export const PWA_DIST = join(REPO_ROOT, 'packages', 'pwa', 'dist');
export const KEY_FILE = join(REPO_ROOT, '.kimi-remote.json');
export const BIN_DIR = join(REPO_ROOT, 'bin');
export const CLOUDFLARED_BIN = join(
  BIN_DIR,
  process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared',
);

// ~/.kimi-code is strictly read-only for this process.
export const KIMI_HOME = join(homedir(), '.kimi-code');
export const INSTANCES_DIR = join(KIMI_HOME, 'server', 'instances');
export const TOKEN_FILE = join(KIMI_HOME, 'server.token');

// Hidden test hook (KIMI_REMOTE_INSTANCE_FILE): force a specific instance
// file. Returns a validated absolute path only - confined to the instance
// registry, the repo or the system temp dir, no traversal, .json only.
export function forcedInstanceFile(): string | null {
  const raw = process.env.KIMI_REMOTE_INSTANCE_FILE;
  if (!raw) return null;
  const file = resolve(raw);
  if (raw.includes('..') || !file.endsWith('.json')) return null;
  const confined = [INSTANCES_DIR, REPO_ROOT, tmpdir()].some(
    (root) => file.startsWith(resolve(root) + sep),
  );
  return confined ? file : null;
}

export const DEFAULT_PORT = Number(process.env.KIMI_REMOTE_PORT || 7777);

// run/ artifacts for background operation (all gitignored):
//   bridge.pid  - single-instance guard + `npm run stop` target
//   state.json  - {url, pid, started_at} pairing info for `npm run pair`
//   bridge.stop - flag file; the bridge polls it and shuts down gracefully
export const RUN_DIR = join(REPO_ROOT, 'run');
export const PID_FILE = join(RUN_DIR, 'bridge.pid');
export const STATE_FILE = join(RUN_DIR, 'state.json');
export const STOP_FILE = join(RUN_DIR, 'bridge.stop');

export const MAX_BOX_BODY = 5 * 1024 * 1024;
export const MAX_WS_FRAME = 10 * 1024 * 1024;
