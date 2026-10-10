// probe9: approvals?status=pending -> POST approve -> file written. Final loop check.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const token = readFileSync(join(process.env.USERPROFILE, '.kimi-code', 'server.token'), 'utf8').trim();
const base = 'http://127.0.0.1:54754';
const auth = { Authorization: `Bearer ${token}` };
const api = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...auth, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cwd = mkdtempSync(join(tmpdir(), 'kimi-probe9-'));
const created = await api('POST', '/api/v1/sessions', { title: 'kimi-probe9', metadata: { cwd } });
const sid = created.json?.data?.id;
await api('POST', `/api/v1/sessions/${sid}/profile`, { agent_config: { model: 'kimi-code/k3-256k', permission_mode: 'manual' } });
await api('POST', `/api/v1/sessions/${sid}/prompts`, { content: [{ type: 'text', text: '请在当前目录创建文件 hello.txt，内容一行：hi' }] });

let item = null;
for (let i = 0; i < 15; i++) {
  await sleep(2000);
  const ap = await api('GET', `/api/v1/sessions/${sid}/approvals?status=pending`);
  item = ap.json?.data?.items?.[0] || null;
  if (item) break;
}
if (!item) { console.log('NO APPROVAL'); process.exit(1); }
console.log('approval item:', JSON.stringify(item).slice(0, 450));
const r = await api('POST', `/api/v1/sessions/${sid}/approvals/${item.approval_id}`, { decision: 'approved', scope: 'session' });
console.log('approve:', r.status, r.json?.code, r.json?.msg, JSON.stringify(r.json?.data));
const target = join(cwd, 'hello.txt');
for (let i = 0; i < 15; i++) {
  await sleep(2000);
  try { console.log(`file written after ~${(i + 1) * 2}s:`, JSON.stringify(readFileSync(target, 'utf8'))); break; } catch {}
}
// questions endpoint shape with status param (likely empty)
const qs = await api('GET', `/api/v1/sessions/${sid}/questions?status=pending`);
console.log('questions?status=pending:', qs.status, JSON.stringify(qs.json?.data)?.slice(0, 120));

await api('POST', `/api/v1/sessions/${sid}:delete`);
for (let i = 0; i < 15; i++) {
  try { rmSync(cwd, { recursive: true, force: true, maxRetries: 2, retryDelay: 500 }); console.log('temp removed'); break; }
  catch { await sleep(2000); }
}
process.exit(0);
