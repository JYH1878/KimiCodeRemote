// Shared helpers for the verify:* suite. Every verify talks to the desktop
// ONLY through the bridge (encrypted /box or /ws); the single sanctioned
// exception is e2e's "pairing key is not a server token" 401 probe.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBridge, type Bridge } from '../server.js';
import { b64urlDecode, loadOrCreateKey, openEnvelope, seal } from '../crypto.js';
import { KEY_FILE } from '../config.js';

export function loadPairingKey(): { keyBuf: Buffer; keyStr: string } {
  // same file, same creation path as production startup
  loadOrCreateKey(KEY_FILE);
  const keyStr = JSON.parse(readFileSync(KEY_FILE, 'utf8')).key as string;
  const keyBuf = b64urlDecode(keyStr);
  if (keyBuf.length !== 32) throw new Error('pairing key must be 32 bytes');
  return { keyBuf, keyStr };
}

export interface BoxResult {
  http: number;
  status?: number;
  body?: unknown;
  raw: string;
  decryptFailed?: boolean;
}

export class BoxClient {
  constructor(
    private baseUrl: string,
    private keyBuf: Buffer,
  ) {}

  async call(method: string, path: string, body?: unknown, timeoutMs = 90_000): Promise<BoxResult> {
    const env = seal(this.keyBuf, { method, path, body });
    const res = await fetch(`${this.baseUrl}/box`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(env),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    if (res.status !== 200) return { http: res.status, raw };
    try {
      const opened = openEnvelope<{ status: number; body: unknown }>(this.keyBuf, JSON.parse(raw));
      return { http: res.status, status: opened.status, body: opened.body, raw };
    } catch {
      return { http: res.status, raw, decryptFailed: true };
    }
  }
}

export async function startTestBridge(): Promise<Bridge> {
  return startBridge({ port: 0, keyFile: KEY_FILE, tunnel: false });
}

const failures: string[] = [];

export function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
    failures.push(name);
  }
}

export function finish(): never {
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nall checks passed');
  process.exit(0);
}

export function createTempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'kimi-remote-verify-'));
}

export function removeTempWorkspace(dir: string): void {
  // The desktop app keeps one kimi-cu runner process per workspace; it pins
  // the directory as its cwd even after the session is deleted. Remove what
  // we can and report the residual empty shell.
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 500 });
      return;
    } catch {
      /* desktop runner still holds the cwd - wait and retry */
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    }
  }
  try {
    for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true });
  } catch {
    /* contents also pinned */
  }
  console.error(`  WARN  temp workspace not fully removable (desktop runner holds cwd): ${dir}`);
}

export interface VerifySession {
  id: string;
  cwd: string;
}

// Create a temporary session through the bridge. Model comes from the newest
// real session (allowlisted /api/v2/sessions); turns fail with "Model not
// set" otherwise - the create endpoint drops agent_config.model.
export async function createVerifySession(box: BoxClient): Promise<VerifySession> {
  const cwd = createTempWorkspace();
  const created = await box.call('POST', '/api/v1/sessions', {
    title: 'kimi-remote-verify',
    metadata: { cwd },
  });
  const payload = created.body as { code?: number; data?: { id?: string } } | undefined;
  const id = payload?.data?.id;
  if (created.http !== 200 || payload?.code !== 0 || !id) {
    throw new Error(`cannot create verify session: http=${created.http} body=${created.raw.slice(0, 300)}`);
  }
  const list = await box.call('GET', '/api/v2/sessions');
  const items = (list.body as { data?: { items?: Array<{ activity?: { model?: string } }> } } | undefined)?.data?.items ?? [];
  const model = items.map((i) => i.activity?.model).find((m) => typeof m === 'string' && m.length > 0) ?? 'kimi-code/k3-256k';
  const profile = await box.call('POST', `/api/v1/sessions/${id}/profile`, {
    agent_config: { model, permission_mode: 'yolo' },
  });
  const profilePayload = profile.body as { code?: number; msg?: string } | undefined;
  if (profile.http !== 200 || profilePayload?.code !== 0) {
    throw new Error(`cannot set session model: http=${profile.http} body=${profile.raw.slice(0, 300)}`);
  }
  return { id, cwd };
}

export function messageText(message: { role?: string; content?: Array<{ type?: string; text?: string }> }): string {
  return (message.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
}

export async function pollForAssistantText(
  box: BoxClient,
  sessionId: string,
  needle: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await box.call('GET', `/api/v1/sessions/${sessionId}/messages`);
    const items = (res.body as { data?: { items?: Array<{ role: string; content: unknown[] }> } } | undefined)?.data?.items ?? [];
    const hit = items.some(
      (m) => m.role === 'assistant' && messageText(m as never).includes(needle),
    );
    if (hit) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  return false;
}

export async function cleanupVerifySession(box: BoxClient, session: VerifySession): Promise<void> {
  await box.call('POST', `/api/v1/sessions/${session.id}:delete`);
  removeTempWorkspace(session.cwd);
}
