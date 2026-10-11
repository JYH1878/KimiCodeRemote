// verify:pwa - message-stream cleaning against REAL desktop-server data.
// Compiles packages/pwa/src/clean.ts standalone with the project's own tsc,
// pulls the forensic session (skill_activation + injections + normal traffic)
// straight from the desktop server, and asserts the cleaning contract.
// No fixtures, no mocks - failures exit non-zero.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SESSION = 'session_2fa63600-6b50-4c63-81e2-d489b313f3dc';

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failed++;
}

const out = mkdtempSync(join(tmpdir(), 'verify-pwa-'));
try {
  // 1. compile clean.ts standalone (import type from types.ts is elided,
  //    so the emitted clean.js has zero runtime imports)
  execFileSync(
    process.execPath,
    [
      join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
      join(root, 'packages', 'pwa', 'src', 'clean.ts'),
      '--outDir', out,
      '--module', 'esnext',
      '--target', 'es2020',
      '--moduleResolution', 'bundler',
      '--skipLibCheck',
    ],
    { cwd: root, stdio: 'pipe' },
  );
  const clean = await import(pathToFileURL(join(out, 'clean.js')).href);
  check('clean.ts compiles standalone & imports', typeof clean.classifyMessage === 'function' && typeof clean.cleanUserMessage === 'function');

  // 2. discover the desktop server (newest heartbeat instance) + read token
  const token = readFileSync(join(homedir(), '.kimi-code', 'server.token'), 'utf8').trim();
  const instDir = join(homedir(), '.kimi-code', 'server', 'instances');
  const instance = readdirSync(instDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(instDir, f), 'utf8')))
    .sort((a, b) => (b.heartbeat_at ?? 0) - (a.heartbeat_at ?? 0))[0];
  check('desktop server instance discovered', !!instance?.port);

  // 3. pull real sessions - FULL history (the API pages newest -> oldest and
  // these sessions keep growing, so a single newest page eventually scrolls
  // the early forensic messages off the end; page back with before_id).
  async function fetchAll(sid) {
    const out = [];
    let before;
    let status = 0;
    let code = -1;
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({ page_size: '100' });
      if (before) q.set('before_id', before);
      const res = await fetch(
        `http://127.0.0.1:${instance.port}/api/v1/sessions/${sid}/messages?${q}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      status = res.status;
      const payload = await res.json();
      code = payload?.code ?? -1;
      if (status !== 200 || code !== 0) break;
      const batch = payload?.data?.items ?? [];
      out.push(...batch);
      if (payload?.data?.has_more !== true || batch.length === 0) break;
      before = batch[batch.length - 1]?.id;
      if (!before) break;
    }
    return { items: out, status, code };
  }
  const forensic = await fetchAll(SESSION);
  const items = forensic.items;
  check(
    `forensic session fetched (${items.length} messages, full history)`,
    forensic.status === 200 && forensic.code === 0 && items.length > 0,
  );

  // 4. every message classifies without throwing, into a known class
  const CLASSES = new Set(['hidden', 'assistant', 'user', 'skill']);
  let allOk = true;
  for (const m of items) {
    try {
      if (!CLASSES.has(clean.classifyMessage(m))) allOk = false;
    } catch {
      allOk = false;
    }
  }
  check('all messages classify into known classes without throwing', allOk);

  // 5. the skill activation: name + recovered user words, never the envelope
  const skill = items.find((m) => m.metadata?.origin?.kind === 'skill_activation');
  check('skill_activation message present', !!skill);
  if (skill) {
    check('classify -> skill', clean.classifyMessage(skill) === 'skill');
    const c = clean.cleanUserMessage(skill);
    check('skillName === "leader"', c.skillName === 'leader', `got ${c.skillName}`);
    check('userText contains 「推进项目」', c.userText.includes('推进项目'), c.userText.slice(0, 80));
    check(
      'userText free of the instruction envelope',
      !c.userText.includes('skill-loaded') && !c.userText.includes('User activated'),
      c.userText.slice(0, 120),
    );
    check('rawText excerpt non-empty (expandable detail)', c.rawText.length > 0);
  }

  // 6. injections (loadable-tools / date_change / interruption) never render
  const injections = items.filter((m) => m.metadata?.origin?.kind === 'injection');
  check(
    `injections all hidden (found ${injections.length}, need >= 2)`,
    injections.length >= 2 && injections.every((m) => clean.classifyMessage(m) === 'hidden'),
  );

  // 7. task notifications never render
  const tasks = items.filter((m) => m.metadata?.origin?.kind === 'task');
  check(`task notifications hidden (found ${tasks.length})`, tasks.every((m) => clean.classifyMessage(m) === 'hidden'));

  // 8. tool messages never render
  const tools = items.filter((m) => m.role === 'tool');
  check(`tool-role messages hidden (found ${tools.length})`, tools.length > 0 && tools.every((m) => clean.classifyMessage(m) === 'hidden'));

  // 9. normal user message passes through with its own words
  const normal = items.find((m) => clean.classifyMessage(m) === 'user' && clean.cleanUserMessage(m).userText.length > 0);
  check('normal user message present', !!normal);
  if (normal) {
    const c = clean.cleanUserMessage(normal);
    check('normal user: no skill fields, text kept', c.skillName === null && c.rawText === '' && c.userText.length > 0);
  }
  const known = items.find((m) => {
    const t = (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    return m.role === 'user' && t.trim() === '可以看看有没有已安装的适合用的skills';
  });
  check(
    'known plain user text passes through verbatim',
    !!known && clean.cleanUserMessage(known).userText === '可以看看有没有已安装的适合用的skills',
  );

  // 10. user message whose text is pure <system> noise (image-compression
  //     notes) cleans to '' -> must not produce an empty bubble
  const noiseOnly = items.find(
    (m) => m.role === 'user' && (m.content ?? []).some((b) => b.type === 'image'),
  );
  check(
    'image-only user message cleans to empty (no empty bubble)',
    !!noiseOnly && clean.classifyMessage(noiseOnly) === 'user' && clean.cleanUserMessage(noiseOnly).userText === '',
  );

  // 11. assistant messages pass through
  const assistants = items.filter((m) => m.role === 'assistant');
  check(
    `assistant messages pass through (found ${assistants.length})`,
    assistants.length > 0 && assistants.every((m) => clean.classifyMessage(m) === 'assistant'),
  );

  // 12. second real session: model-triggered skill loads carry NO user words
  //     (envelope line "Skill tool loaded instructions…" must not leak as a
  //     user bubble); user-slash skills keep their typed words.
  const SECOND = 'session_253c9bc3-99dd-47fc-9fef-2a4b21f7305b';
  const second = await fetchAll(SECOND);
  const modelTriggered = second.items.filter(
    (m) => m.metadata?.origin?.kind === 'skill_activation' && m.metadata?.origin?.trigger === 'model-tool',
  );
  check(
    `second session fetched, model-triggered skills present (found ${modelTriggered.length})`,
    second.status === 200 && second.code === 0 && modelTriggered.length >= 1,
  );
  check(
    'model-triggered skill loads leave no fake user words',
    modelTriggered.length > 0 &&
      modelTriggered.every((m) => {
        const c = clean.cleanUserMessage(m);
        return c.skillName !== '' && c.userText === '';
      }),
  );
  const slashSkill = second.items.find(
    (m) => m.metadata?.origin?.kind === 'skill_activation' && m.metadata?.origin?.trigger === 'user-slash',
  );
  check(
    'user-slash skill keeps typed words, no envelope/attachment noise',
    !!slashSkill &&
      (() => {
        const c = clean.cleanUserMessage(slashSkill);
        return (
          c.userText.length > 0 &&
          !c.userText.includes('skill-loaded') &&
          !c.userText.includes('Attached image file')
        );
      })(),
  );
} catch (e) {
  check(`fatal: ${e.message}`, false);
} finally {
  rmSync(out, { recursive: true, force: true });
}

console.log(failed === 0 ? 'verify:pwa OK' : `verify:pwa FAILED (${failed})`);
// let the loop drain instead of process.exit(): fetch keep-alive sockets are
// still open at this point and a forced exit trips a libuv assertion on
// Windows (exit code 127 despite all checks passing). Sockets time out in a
// few seconds and the process then exits on its own with this code.
process.exitCode = failed === 0 ? 0 : 1;
