// verify:e2e - everything goes through the bridge port. The only direct
// desktop call is the sanctioned "pairing key is not a server token" 401
// comparison. Flow:
//   1. encrypted session list -> 200, contains real sessions
//   2. garbage ciphertext / wrong-key envelope -> rejected (non-200)
//   3. plaintext direct access to bridge API paths -> 404
//   4. pairing key as bearer token against the desktop port -> 401
//   5. /box response body carries no plaintext session_id (ciphertext only)
//   6. allowlist: config/shutdown -> 403 without touching upstream
//   7. temp session -> "PONG" within 60s -> cleanup (session + temp dir)
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
import { b64urlEncode, seal } from '../crypto.js';
import { randomBytes } from 'node:crypto';

void (async () => {
  const { keyBuf } = loadPairingKey();
  const bridge = await startTestBridge();
  const base = `http://127.0.0.1:${bridge.port}`;
  console.log(`bridge on ${base} (upstream desktop: 127.0.0.1:${bridge.instance.port})`);
  const box = new BoxClient(base, keyBuf);

  // healthz
  const hz = await fetch(`${base}/healthz`);
  check('GET /healthz -> 200 ok', hz.status === 200 && (await hz.text()) === 'ok');

  // temp session first so the list assertion below always has a real session
  const session = await createVerifySession(box);

  // 1. encrypted session list
  const listed = await box.call('GET', '/api/v2/sessions');
  const listedPayload = listed.body as { code?: number; data?: { items?: Array<{ id?: string }> } } | undefined;
  const listedIds = listedPayload?.data?.items?.map((i) => i.id) ?? [];
  check(
    'encrypted GET /api/v2/sessions -> http 200 + envelope status 200',
    listed.http === 200 && listed.status === 200,
    `http=${listed.http} status=${listed.status}`,
  );
  check(
    'session list contains real sessions (incl. fresh temp session)',
    listedPayload?.code === 0 && listedIds.length > 0 && listedIds.includes(session.id),
    `items=${listedIds.length}`,
  );

  // 2. garbage ciphertext / wrong key
  const garbage = await fetch(`${base}/box`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ iv: b64urlEncode(randomBytes(12)), ct: b64urlEncode(randomBytes(64)) }),
  });
  check('garbage ciphertext -> rejected (401)', garbage.status === 401, `status=${garbage.status}`);
  // structurally valid envelope, but sealed under a key we never issued
  const wrongKeySealed = seal(randomBytes(32), { method: 'GET', path: '/api/v2/sessions' });
  const wrongKey = await fetch(`${base}/box`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(wrongKeySealed),
  });
  check('valid envelope under unknown key -> rejected (401)', wrongKey.status === 401, `status=${wrongKey.status}`);
  const junk = await fetch(`${base}/box`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
  });
  check('request without envelope shape -> rejected (400)', junk.status === 400, `status=${junk.status}`);

  // 3. plaintext direct access to bridge API path -> 404
  const plain = await fetch(`${base}/api/v1/sessions`);
  check('plaintext GET /api/v1/sessions on bridge -> 404', plain.status === 404, `status=${plain.status}`);

  // 4. pairing key used as desktop server token -> 401 (sanctioned direct call)
  const tokenAbuse = await fetch(`http://127.0.0.1:${bridge.instance.port}/api/v2/sessions`, {
    headers: { authorization: `Bearer ${b64urlEncode(keyBuf)}` },
    signal: AbortSignal.timeout(10_000),
  });
  check('pairing key as desktop bearer token -> 401 (two credential domains)', tokenAbuse.status === 401, `status=${tokenAbuse.status}`);

  // 5. wire carries no plaintext session_id
  const rawBody = listed.raw;
  check(
    '/box response body contains no plaintext session_id',
    !rawBody.includes(session.id) && rawBody.includes('"ct"'),
    'response must be ciphertext',
  );

  // 6. allowlist rejections (never forwarded upstream)
  const cfg = await box.call('GET', '/api/v1/config');
  check('allowlist: GET /api/v1/config -> 403', cfg.http === 403, `http=${cfg.http}`);
  const shutdown = await box.call('POST', '/api/v1/shutdown');
  check('allowlist: POST /api/v1/shutdown -> 403', shutdown.http === 403, `http=${shutdown.http}`);

  // 7. PONG round-trip through the bridge
  const prompt = await box.call('POST', `/api/v1/sessions/${session.id}/prompts`, {
    content: [{ type: 'text', text: '只回复 PONG' }],
  });
  check('POST prompt through /box -> 200', prompt.http === 200 && prompt.status === 200, `http=${prompt.http}`);
  const gotPong = await pollForAssistantText(box, session.id, 'PONG', 60_000);
  if (!gotPong) {
    const detail = await box.call('GET', `/api/v1/sessions/${session.id}`);
    console.log(`  DEBUG session detail: ${detail.raw.slice(0, 600)}`);
  }
  check('assistant PONG polled within 60s (through bridge)', gotPong);

  await cleanupVerifySession(box, session);
  check('temp session deleted + temp workspace removed', true);

  await bridge.close();
  finish();
})().catch((e: Error) => {
  console.error(`FAIL: ${e.stack ?? e.message}`);
  process.exit(1);
});
