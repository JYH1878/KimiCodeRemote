// Dev-only probe: exercises the desktop server API directly to pin down live
// behavior (steer semantics, WS event flow). NOT part of the verify suite.
// Usage: node packages/bridge/dist/devtools/probe.mjs <cwd-for-test-session>
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const homedir = process.env.USERPROFILE || process.env.HOME;
const token = readFileSync(join(homedir, '.kimi-code', 'server.token'), 'utf8').trim();
const inst = JSON.parse(readFileSync(join(homedir, '.kimi-code', 'server', 'instances', '01M4K3ZK5PJ7M1YP8YCMQBM8CR.json'), 'utf8'));
const base = `http://127.0.0.1:${inst.port}`;

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cwd = process.argv[2] || mkdtempSync(join(tmpdir(), 'kimicoderemote-probe-'));
console.log('cwd =', cwd);

// 1. list sessions
const v2 = await api('GET', '/api/v2/sessions');
console.log('v2 sessions status', v2.status, 'code', v2.json?.code, 'items', v2.json?.data?.items?.length);
const first = v2.json?.data?.items?.[0];
console.log('first item keys:', first && Object.keys(first));
if (first) console.log('first item sample:', JSON.stringify(first).slice(0, 400));

// 2. create temp session
const created = await api('POST', '/api/v1/sessions', { title: 'kimicoderemote-probe', metadata: { cwd } });
console.log('create status', created.status, 'code', created.json?.code);
const sid = created.json?.data?.id;
console.log('session id len', sid?.length);

// 3. quick prompt -> PONG
const p1 = await api('POST', `/api/v1/sessions/${sid}/prompts`, { content: [{ type: 'text', text: '只回复 PONG，不要任何其他内容' }] });
console.log('prompt1 status', p1.status, 'code', p1.json?.code, 'data', JSON.stringify(p1.json?.data)?.slice(0, 300));

// 4. WS subscribe while it runs
const ws = new WebSocket(`ws://127.0.0.1:${inst.port}/api/v1/ws`, {
  headers: { Authorization: `Bearer ${token}` },
});
let eventCount = 0;
const seenTypes = new Map();
ws.on('message', (buf) => {
  const m = JSON.parse(buf.toString());
  seenTypes.set(m.type, (seenTypes.get(m.type) || 0) + 1);
  if (m.type === 'session_event') {
    eventCount++;
    if (eventCount <= 6) {
      console.log('ev:', JSON.stringify({ type: m.type, payload: m.payload }).slice(0, 400));
    }
  } else if (!['ping', 'session_event'].includes(m.type)) {
    console.log('ws msg:', JSON.stringify(m).slice(0, 300));
  }
});
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'client_hello', id: 'h1', payload: { client_id: 'probe-' + Date.now() } }));
});
await sleep(1200);
ws.send(JSON.stringify({ type: 'subscribe_v2', id: 's1', payload: { session_id: sid, transcript: { '*': 'delta' } } }));
await sleep(500);

// 5. wait for PONG in messages
let pong = null;
for (let i = 0; i < 30; i++) {
  await sleep(2000);
  const msgs = await api('GET', `/api/v1/sessions/${sid}/messages`);
  const items = msgs.json?.data?.items || [];
  for (const m of items) {
    if (m.role === 'assistant') {
      const text = (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      if (text.includes('PONG')) { pong = { waitedMs: (i + 1) * 2000, nMessages: items.length }; break; }
    }
  }
  if (pong) break;
}
console.log('PONG result:', pong, '| ws events seen:', eventCount, '| types:', JSON.stringify([...seenTypes.entries()]));

// 6. steer semantics: fire a long turn, then a second prompt
await api('POST', `/api/v1/sessions/${sid}/prompts`, { content: [{ type: 'text', text: '从 1 数到 25，每行一个数字，不要解释' }] });
await sleep(3000);
const st = await api('GET', `/api/v1/sessions/${sid}/status`);
console.log('status while running:', JSON.stringify(st.json?.data));
const p2 = await api('POST', `/api/v1/sessions/${sid}/prompts`, { content: [{ type: 'text', text: '改成只数到 3' }] });
console.log('prompt2 (busy?) status', p2.status, 'code', p2.json?.code, 'msg', p2.json?.msg, 'data', JSON.stringify(p2.json?.data)?.slice(0, 200));
const pid2 = p2.json?.data?.prompt_id;
if (pid2) {
  const steer = await api('POST', `/api/v1/sessions/${sid}/prompts:steer`, { prompt_ids: [pid2] });
  console.log('steer status', steer.status, 'code', steer.json?.code, 'data', JSON.stringify(steer.json?.data));
} else {
  console.log('prompt2 returned no prompt_id; steer not attempted');
}

// 7. approvals / questions endpoints
const ap = await api('GET', `/api/v1/sessions/${sid}/approvals`);
console.log('approvals:', ap.status, JSON.stringify(ap.json?.data)?.slice(0, 120));
const qs = await api('GET', `/api/v1/sessions/${sid}/questions`);
console.log('questions:', qs.status, JSON.stringify(qs.json?.data)?.slice(0, 120));

await sleep(2500);
console.log('total ws events:', eventCount, 'types:', JSON.stringify([...seenTypes.entries()]));
ws.close();

// 8. cleanup: delete probe session + temp dir
const del = await api('POST', `/api/v1/sessions/${sid}:delete`);
console.log('delete status', del.status, 'code', del.json?.code, 'data', JSON.stringify(del.json?.data));
try { rmSync(cwd, { recursive: true, force: true }); console.log('temp dir removed'); } catch (e) { console.log('rm failed', e.message); }
process.exit(0);
