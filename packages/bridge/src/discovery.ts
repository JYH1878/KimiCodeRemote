// Desktop-instance discovery: read ~/.kimi-code/server/instances/*.json,
// prefer the freshest heartbeat that actually answers /api/v1/healthz.
// This directory (and server.token) are read-only for us.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { INSTANCES_DIR, TOKEN_FILE } from './config.js';

export interface Instance {
  server_id?: string;
  pid?: number;
  host?: string;
  port: number;
  started_at?: number;
  heartbeat_at?: number;
  host_version?: string;
}

export function readInstanceFiles(dir: string = INSTANCES_DIR): Instance[] {
  if (!existsSync(dir)) return [];
  const out: Instance[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Instance;
      if (typeof parsed.port === 'number') out.push(parsed);
    } catch {
      // unreadable/foreign file - ignore
    }
  }
  return out.sort((a, b) => (b.heartbeat_at ?? 0) - (a.heartbeat_at ?? 0));
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // EPERM = exists, no permission
  }
}

export async function healthzReachable(port: number, timeoutMs = 2500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function readToken(): string {
  if (!existsSync(TOKEN_FILE)) {
    throw new Error(`desktop server token not found at ${TOKEN_FILE} (is the desktop app running?)`);
  }
  return readFileSync(TOKEN_FILE, 'utf8').trim();
}

export interface Discovered {
  instance: Instance;
  token: string;
}

export async function discoverUpstream(log?: (s: string) => void): Promise<Discovered> {
  const candidates = readInstanceFiles();
  if (candidates.length === 0) {
    throw new Error(`no desktop instances registered in ${INSTANCES_DIR}`);
  }
  for (const instance of candidates) {
    if (typeof instance.pid === 'number' && !pidAlive(instance.pid)) {
      log?.(`skip 127.0.0.1:${instance.port} - pid ${instance.pid} not alive`);
      continue;
    }
    if (!(await healthzReachable(instance.port))) {
      log?.(`skip 127.0.0.1:${instance.port} - healthz unreachable`);
      continue;
    }
    return { instance, token: readToken() };
  }
  throw new Error('no reachable desktop instance (healthz failed for every candidate)');
}
