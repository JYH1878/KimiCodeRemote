// The single file defining what remote clients may ask the desktop server.
// The official Server API is experimental and may drift between versions -
// when it does, adjust these rules here (and request building in upstream.ts).
// Everything not matched here is rejected with 403 before any upstream call,
// including shutdown/config/providers/oauth/fs*/files/remote-control.

type Method = 'GET' | 'POST';

interface Rule {
  method: Method;
  re: RegExp;
}

const ID = '[^/:]+'; // one path segment (no slashes, no ':' action suffix)
const SESS = `/api/v1/sessions/${ID}`;
const SUBS = 'messages|prompts|approvals|questions|status|transcript|children';

const RULES: Rule[] = [
  { method: 'GET', re: /^\/api\/v1\/healthz$/ },
  { method: 'GET', re: /^\/api\/v2\/sessions$/ },

  { method: 'GET', re: /^\/api\/v1\/sessions$/ },
  { method: 'POST', re: /^\/api\/v1\/sessions$/ },
  { method: 'GET', re: new RegExp(`^${SESS}$`) },
  { method: 'POST', re: new RegExp(`^${SESS}:delete$`) },

  { method: 'GET', re: new RegExp(`^${SESS}/messages$`) },
  { method: 'GET', re: new RegExp(`^${SESS}/messages/${ID}$`) },

  { method: 'GET', re: new RegExp(`^${SESS}/(?:${SUBS})$`) },
  { method: 'POST', re: new RegExp(`^${SESS}/(?:prompts|prompts:steer)$`) },
  // profile: session-scoped settings (model / permission_mode). Required to
  // give API-created sessions a model - without it every turn fails with
  // "Model not set". Touches no filesystem or system state.
  { method: 'POST', re: new RegExp(`^${SESS}/profile$`) },
  { method: 'POST', re: new RegExp(`^${SESS}/(?:approvals|questions)/${ID}$`) },

  { method: 'GET', re: new RegExp(`^${SESS}/transcript/(?:ops|user-messages|plan)$`) },
];

export function isAllowed(method: string, pathname: string): boolean {
  return RULES.some((r) => r.method === method && r.re.test(pathname));
}
