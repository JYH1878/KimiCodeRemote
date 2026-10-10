// verify:ws - encrypted WS through the bridge: subscribe to a temp session,
// fire a prompt via the WS api channel, expect >=1 streamed event within 30s.
// If the upstream WS is unavailable, degrades to verifying the polling path.
import WebSocket from 'ws';
import {
  BoxClient,
  check,
  cleanupVerifySession,
  createVerifySession,
  finish,
  loadPairingKey,
  pollForAssistantText,
  startTestBridge,
} from './runner.js';
import { openEnvelope, seal } from '../crypto.js';

interface Inner {
  t?: string;
  id?: string;
  ok?: boolean;
  status?: number;
  session_id?: string;
}

void (async () => {
  const { keyBuf } = loadPairingKey();
  const bridge = await startTestBridge();
  const base = `http://127.0.0.1:${bridge.port}`;
  const box = new BoxClient(base, keyBuf);
  const session = await createVerifySession(box);
  console.log(`bridge on ${base}; temp session ${session.id}`);

  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`);
  const frames: Inner[] = [];
  let gotEvent = false;
  const waiters: Array<{ pred: (m: Inner) => boolean; resolve: (m: Inner) => void }> = [];

  const dispatch = (m: Inner) => {
    if (process.env.KIMI_REMOTE_WS_DEBUG) console.log(`  [phone-ws] <- ${m.t}:${m.id ?? ''} ok=${String(m.ok)} status=${String(m.status)}`);
    frames.push(m);
    if (m.t === 'ev') gotEvent = true;
    const idx = waiters.findIndex((w) => w.pred(m));
    if (idx >= 0) {
      const w = waiters[idx];
      if (w) waiters.splice(idx, 1);
      w?.resolve(m);
    }
  };
  ws.on('message', (data) => {
    try {
      dispatch(openEnvelope<Inner>(keyBuf, JSON.parse(String(data))));
    } catch {
      /* ignore undecryptable */
    }
  });
  ws.on('error', () => {});

  const send = (obj: unknown) => ws.send(JSON.stringify(seal(keyBuf, obj)));
  const waitFor = (pred: (m: Inner) => boolean, timeoutMs: number): Promise<Inner | null> =>
    new Promise((resolve) => {
      const already = frames.find(pred);
      if (already) {
        resolve(already);
        return;
      }
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolve2);
        if (idx >= 0) waiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
      const resolve2 = (m: Inner) => {
        clearTimeout(timer);
        resolve(m);
      };
      waiters.push({ pred, resolve: resolve2 });
    });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    setTimeout(() => reject(new Error('ws open timeout')), 10_000);
  });

  const hello = await waitFor((m) => m.t === 'hello', 5000);
  check('bridge /ws sends encrypted hello', !!hello);

  send({ t: 'sub', id: 's1', session_id: session.id });
  const subRes = await waitFor((m) => m.t === 'sub_res' && m.id === 's1', 15_000);

  if (subRes?.ok) {
    check('encrypted subscribe accepted (upstream WS bridged)', true);
    send({
      t: 'api',
      id: 'a1',
      method: 'POST',
      path: `/api/v1/sessions/${session.id}/prompts`,
      body: { content: [{ type: 'text', text: '从 1 数到 20，每行一个数字，不要输出其他内容' }] },
    });
    const apiRes = await waitFor((m) => m.t === 'api_res' && m.id === 'a1', 20_000);
    check('WS api channel: prompt POST -> 200', !!apiRes && apiRes.status === 200, `status=${apiRes?.status}`);
    const deadline = Date.now() + 30_000;
    while (!gotEvent && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    check('streamed session event received within 30s', gotEvent);
  } else {
    // DEGRADED: upstream WS unavailable - verify the polling fallback instead
    console.log('  NOTE  upstream WS unavailable (sub_res ok=%s) - verifying polling fallback', subRes?.ok);
    send({
      t: 'api',
      id: 'a1',
      method: 'POST',
      path: `/api/v1/sessions/${session.id}/prompts`,
      body: { content: [{ type: 'text', text: '只回复 PONG' }] },
    });
    const apiRes = await waitFor((m) => m.t === 'api_res' && m.id === 'a1', 20_000);
    check('WS api channel still works when upstream WS is down', !!apiRes && apiRes.status === 200);
    const polled = await pollForAssistantText(box, session.id, 'PONG', 30_000);
    check('polling fallback delivers the reply within 30s', polled);
  }

  send({ t: 'unsub', id: 'u1', session_id: session.id });
  await cleanupVerifySession(box, session);
  ws.close();
  await bridge.close();
  finish();
})().catch((e: Error) => {
  console.error(`FAIL: ${e.stack ?? e.message}`);
  process.exit(1);
});
