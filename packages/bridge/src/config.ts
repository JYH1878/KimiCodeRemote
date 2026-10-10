// Central path/config constants for the bridge.
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
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

export const DEFAULT_PORT = Number(process.env.KIMI_REMOTE_PORT || 7777);

export const MAX_BOX_BODY = 5 * 1024 * 1024;
export const MAX_WS_FRAME = 10 * 1024 * 1024;
