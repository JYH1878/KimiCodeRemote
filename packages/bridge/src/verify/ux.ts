// verify:ux - message-flow + workspace-grouping acceptance, all through the
// bridge's real encrypted /box channel:
//   (a) temp session, 2 turns with unique markers:
//       - first page is newest->oldest (page_size=1 -> newest is the MARK2 reply)
//       - before_id walks strictly older messages, no duplicates, terminates
//         with has_more=false, and the chronological rebuild puts MARK1 before MARK2
//       - boundary: before_id=<oldest> returns no items and has_more=false
//   (b) GET /api/v2/sessions?view=by_workspace returns well-formed groups
//       (workspace.id/cwd, sessions[].id/meta/activity) incl. the temp session
//   (c) temp session + temp workspace cleanup
import {
  BoxClient,
  check,
  cleanupVerifySession,
  createVerifySession,
  finish,
  loadPairingKey,
  messageText,
  pollForAssistantText,
  startTestBridge,
} from './runner.js';

interface WireMessage {
  id: string;
  role: string;
  content: Array<{ type?: string; text?: string }>;
}

interface MessagesPayload {
  code?: number;
  msg?: string;
  data?: { items?: WireMessage[]; has_more?: boolean };
}

const MARK1 = 'UXA-3F9K';
const MARK2 = 'UXB-7Q2M';

void (async () => {
  const { keyBuf } = loadPairingKey();
  const bridge = await startTestBridge();
  const base = `http://127.0.0.1:${bridge.port}`;
  console.log(`bridge on ${base} (upstream desktop: 127.0.0.1:${bridge.instance.port})`);
  const box = new BoxClient(base, keyBuf);

  // ---- setup: temp session + two sequential turns so ordering is deterministic
  const session = await createVerifySession(box);
  for (const marker of [MARK1, MARK2]) {
    const prompt = await box.call('POST', `/api/v1/sessions/${session.id}/prompts`, {
      content: [{ type: 'text', text: `verify:ux 请只回复这串字符 ${marker}` }],
    });
    const promptPayload = prompt.body as { code?: number; msg?: string } | undefined;
    check(
      `POST prompt ${marker} through /box -> 200`,
      prompt.http === 200 && prompt.status === 200 && promptPayload?.code === 0,
      `http=${prompt.http} body=${prompt.raw.slice(0, 200)}`,
    );
    const replied = await pollForAssistantText(box, session.id, marker, 60_000);
    check(`assistant replied ${marker} within 60s`, replied);
  }

  const messagesPath = `/api/v1/sessions/${session.id}/messages`;

  // ---- (a1) first page is newest -> oldest
  const first = await box.call('GET', `${messagesPath}?page_size=1`);
  const firstPayload = first.body as MessagesPayload | undefined;
  const firstItems = firstPayload?.data?.items ?? [];
  check(
    'messages page_size=1 -> code 0, 1 item, has_more=true (older history exists)',
    firstPayload?.code === 0 && firstItems.length === 1 && firstPayload?.data?.has_more === true,
    `items=${firstItems.length} body=${first.raw.slice(0, 200)}`,
  );
  const newest = firstItems[0];
  if (!newest) {
    check('messages page_size=1 -> exactly one item', false, first.raw.slice(0, 200));
    await cleanupVerifySession(box, session);
    await bridge.close();
    finish();
  }
  check(
    'newest-first confirmed: page[0] is the assistant reply to the SECOND prompt',
    newest.role === 'assistant' && messageText(newest as never).includes(MARK2),
    `role=${newest.role} text=${messageText(newest as never).slice(0, 80)}`,
  );

  // ---- (a2) before_id walk: strictly older pages, no dup, terminates at has_more=false
  const collected: WireMessage[] = [newest];
  const seen = new Set<string>([newest.id]);
  let hasMore = true;
  let beforeId = newest.id;
  let steps = 0;
  let noDup = true;
  let strictlyOlder = true;
  while (hasMore && steps < 50) {
    steps++;
    const res = await box.call('GET', `${messagesPath}?before_id=${encodeURIComponent(beforeId)}&page_size=2`);
    const payload = res.body as MessagesPayload | undefined;
    if (payload?.code !== 0) {
      check(`before_id page ${steps} -> code 0`, false, res.raw.slice(0, 200));
      break;
    }
    const items = payload.data?.items ?? [];
    for (const m of items) {
      if (seen.has(m.id)) noDup = false;
      seen.add(m.id);
      collected.push(m);
    }
    const last = items[items.length - 1];
    if (last) {
      beforeId = last.id; // pages keep moving strictly down
    }
    hasMore = payload.data?.has_more === true;
    if (items.length === 0 && hasMore) strictlyOlder = false; // empty page must end the walk
  }
  check(`before_id walk: >=4 messages collected (2 user + 2 assistant)`, collected.length >= 4, `collected=${collected.length}`);
  check('before_id walk: no duplicate ids across pages', noDup);
  check('before_id walk: strictly older pages, ends with has_more=false', strictlyOlder && !hasMore && steps < 50, `steps=${steps} has_more=${hasMore}`);

  // chronological rebuild (collected is newest -> oldest): MARK1 prompt before MARK2 prompt
  const chrono = [...collected].reverse();
  const idx1 = chrono.findIndex((m) => m.role === 'user' && messageText(m as never).includes(MARK1));
  const idx2 = chrono.findIndex((m) => m.role === 'user' && messageText(m as never).includes(MARK2));
  check(
    'chronological order rebuild: first prompt strictly before second prompt',
    idx1 >= 0 && idx2 >= 0 && idx1 < idx2,
    `idx(${MARK1})=${idx1} idx(${MARK2})=${idx2}`,
  );

  // ---- (a3) boundary: nothing older than the oldest message
  const oldest = chrono[0];
  if (!oldest) {
    check('chronological rebuild produced at least one message', false);
    await cleanupVerifySession(box, session);
    await bridge.close();
    finish();
  }
  const boundary = await box.call('GET', `${messagesPath}?before_id=${encodeURIComponent(oldest.id)}&page_size=2`);
  const boundaryPayload = boundary.body as MessagesPayload | undefined;
  check(
    'boundary: before_id=<oldest> -> empty items, has_more=false',
    boundaryPayload?.code === 0 && (boundaryPayload?.data?.items ?? []).length === 0 && boundaryPayload?.data?.has_more === false,
    boundary.raw.slice(0, 200),
  );

  // ---- (b) by_workspace shape
  const v2 = await box.call('GET', '/api/v2/sessions?view=by_workspace&page_size=100&group.page_size=100');
  const v2Payload = v2.body as
    | {
        code?: number;
        msg?: string;
        data?: {
          groups?: Array<{
            workspace?: { id?: string; cwd?: string | null };
            sessions?: Array<{
              id?: string;
              meta?: { title?: string; updated_at?: number; archived?: boolean };
              activity?: { status?: string; model?: string };
            }>;
          }>;
        };
      }
    | undefined;
  const groups = v2Payload?.data?.groups ?? [];
  check(
    'v2 by_workspace -> code 0, non-empty groups[]',
    v2.http === 200 && v2Payload?.code === 0 && groups.length > 0,
    `http=${v2.http} groups=${groups.length} body=${v2.raw.slice(0, 200)}`,
  );
  let shapeOk = true;
  let shapeWhy = '';
  outer: for (const g of groups) {
    if (!g.workspace || typeof g.workspace.cwd !== 'string' || !g.workspace.cwd || !g.workspace.id) {
      shapeOk = false;
      shapeWhy = `group workspace incomplete: ${JSON.stringify(g.workspace)?.slice(0, 120)}`;
      break;
    }
    for (const s of g.sessions ?? []) {
      if (!s.id || typeof s.meta !== 'object' || typeof s.meta?.updated_at !== 'number') {
        shapeOk = false;
        shapeWhy = `session fields incomplete: ${JSON.stringify(s)?.slice(0, 160)}`;
        break outer;
      }
    }
  }
  check('every group has workspace.{id,cwd}; every session has id + meta.updated_at', shapeOk, shapeWhy);

  const tempSession = groups
    .flatMap((g) => (g.sessions ?? []).map((s) => ({ cwd: g.workspace?.cwd, s })))
    .find((x) => x.s.id === session.id);
  check(
    'temp session appears in by_workspace groups (with cwd of its temp workspace)',
    !!tempSession && typeof tempSession.cwd === 'string' &&
      tempSession.cwd.toLowerCase() === session.cwd.toLowerCase(),
    `found=${!!tempSession} groupCwd=${tempSession?.cwd} expected=${session.cwd}`,
  );
  check(
    'temp session has activity.{status,model} populated',
    typeof tempSession?.s.activity === 'object' &&
      typeof tempSession.s.activity?.status === 'string' &&
      typeof tempSession.s.activity?.model === 'string' &&
      tempSession.s.activity.model.length > 0,
    JSON.stringify(tempSession?.s.activity),
  );

  // ---- (c) cleanup
  await cleanupVerifySession(box, session);
  check('temp session deleted + temp workspace removed', true);

  await bridge.close();
  finish();
})().catch((e: Error) => {
  console.error(`FAIL: ${e.stack ?? e.message}`);
  process.exit(1);
});
