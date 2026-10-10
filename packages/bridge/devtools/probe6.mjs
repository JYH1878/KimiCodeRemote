// probe6: set model via POST /sessions/{id}/profile after create, then PONG.
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

const cwd = mkdtempSync(join(tmpdir(), 'kimi-probe6-'));
const created = await api('POST', '/api/v1/sessions', { title: 'kimi-probe6', metadata: { cwd } });
const sid = created.json?.data?.id;
const wid = created.json?.data?.workspace_id;
console.log('session', sid);
await api('POST', `/api/v1/workspaces/${wid}/trust`, {});

const prof = await api('POST', `/api/v1/sessions/${sid}/profile`, {
  agent_config: { model: 'kimi-code/k3-256k', permission_mode: 'yolo' },
});
console.log('profile POST:', prof.status, prof.json?.code, 'agent_config now:', JSON.stringify(prof.json?.data?.agent_config));

const p = await api('POST', `/api/v1/sessions/${sid}/prompts`, { content: [{ type: 'text', text: '回复精确内容：PONG' }] });
console.log('prompt', p.status, p.json?.code);
let ok = false;
for (let i = 0; i < 20; i++) {
  await sleep(2000);
  const msgs = await api('GET', `/api/v1/sessions/${sid}/messages`);
  const items = msgs.json?.data?.items || [];
  const hit = items.find((m) => m.role === 'assistant' && (m.content || []).some((c) => c.type === 'text' && c.text.includes('PONG')));
  if (hit) { ok = true; console.log(`PONG after ~${(i + 1) * 2}s, assistant text:`, JSON.stringify(hit.content)); break; }
}
if (!ok) {
  const det = await api('GET', `/api/v1/sessions/${sid}`);
  console.log('NO PONG, last_turn_reason:', det.json?.data?.last_turn_reason);
}

// steer-while-busy semantics
await api('POST', `/api/v1/sessions/${sid}/prompts`, { content: [{ type: 'text', text: '从 1 数到 30，每行一个数字，不要输出其他内容' }] });
let busy = false;
for (let i = 0; i < 12; i++) { await sleep(1500); const st = await api('GET', `/api/v1/sessions/${sid}/status`); busy = !!st.json?.data?.busy; if (busy) break; }
console.log('busy:', busy);
const p2 = await api('POST', `/api/v1/sessions/${sid}/prompts`, { content: [{ type: 'text', text: '改成只数到 3' }] });
console.log('prompt#2 while busy:', p2.status, p2.json?.code, p2.json?.data?.status);
const steer = await api('POST', `/api/v1/sessions/${sid}/prompts:steer`, { prompt_ids: [p2.json?.data?.prompt_id] });
console.log('steer:', steer.status, steer.json?.code, steer.json?.msg, JSON.stringify(steer.json?.data));

// question forcing (model now works?)
await api('POST', `/api/v1/sessions/${sid}/prompts`, { content: [{ type: 'text', text: '请调用提问工具问我：继续还是停止？（A=继续 B=停止），必须真的调用提问工具等我回答' }] });
let qitem = null;
for (let i = 0; i < 12; i++) {
  await sleep(3000);
  const qs = await api('GET', `/api/v1/sessions/${sid}/questions`);
  qitem = qs.json?.data?.items?.[0] || null;
  if (qitem) break;
}
if (qitem) {
  console.log('question:', JSON.stringify(qitem).slice(0, 400));
  const qid = qitem.question_id;
  const inner = qitem.questions[0];
  const r1 = await api('POST', `/api/v1/sessions/${sid}/questions/${qid}`, { answers: { [inner.id]: { kind: 'single', option_id: inner.options[0].id } } });
  console.log(`POST /questions/${qid} (tail=question_id):`, r1.status, r1.json?.code, r1.json?.msg, JSON.stringify(r1.json?.data));
  if (r1.json?.code !== 0) {
    const r2 = await api('POST', `/api/v1/sessions/${sid}/questions/:answer`, { answers: { [inner.id]: { kind: 'single', option_id: inner.options[1].id } } });
    console.log('POST /questions/:answer:', r2.status, r2.json?.code, r2.json?.msg);
  }
} else {
  console.log('no question appeared');
}

const del = await api('POST', `/api/v1/sessions/${sid}:delete`);
console.log('delete', del.status, del.json?.code);
for (let i = 0; i < 10; i++) {
  try { rmSync(cwd, { recursive: true, force: true, maxRetries: 2, retryDelay: 500 }); console.log('temp removed'); break; }
  catch { await sleep(2000); }
}
process.exit(0);
