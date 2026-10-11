import { useCallback, useEffect, useState } from 'react';
import type { Remote, WsClient } from '../api.js';
import type { ActivityStatus, V2ByWorkspaceResponse, V2SessionItem } from '../types.js';

function relTime(value: number | string | undefined): string {
  if (value == null) return '';
  const ts = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ts)) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

// group title: last path segment of the workspace cwd (handles both separators)
function workspaceName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '');
  const seg = trimmed.split(/[\\/]/).pop() ?? '';
  return seg || cwd;
}

interface Group {
  key: string;
  cwd: string;
  name: string;
  sessions: V2SessionItem[]; // newest first by meta.updated_at
  latestAt: number;
  model?: string; // newest session's activity.model, for session creation
}

function buildGroups(responses: V2ByWorkspaceResponse[]): Group[] {
  const byKey = new Map<string, Group>();
  const seenSessions = new Set<string>();
  for (const payload of responses) {
    for (const g of payload.data?.groups ?? []) {
      const cwd = typeof g.workspace?.cwd === 'string' && g.workspace.cwd ? g.workspace.cwd : '';
      const key = g.workspace?.id || cwd;
      if (!cwd || !key) continue;
      let group = byKey.get(key);
      if (!group) {
        group = { key, cwd, name: workspaceName(cwd), sessions: [], latestAt: 0, model: undefined };
        byKey.set(key, group);
      }
      for (const s of g.sessions ?? []) {
        if (!s?.id || s.meta?.archived === true || seenSessions.has(s.id)) continue;
        seenSessions.add(s.id);
        group.sessions.push(s);
      }
    }
  }
  const groups = [...byKey.values()];
  for (const g of groups) {
    g.sessions.sort((a, b) => (b.meta?.updated_at ?? 0) - (a.meta?.updated_at ?? 0));
    g.latestAt = g.sessions[0]?.meta?.updated_at ?? 0;
    g.model = g.sessions[0]?.activity?.model;
  }
  // groups ordered by their newest session's updated_at, newest group first
  groups.sort((a, b) => b.latestAt - a.latestAt);
  return groups;
}

function StatusBadge({ status }: { status: ActivityStatus | undefined }) {
  if (status === 'running') return <span className="badge busy">运行中</span>;
  if (status === 'approval') return <span className="badge approval">待审批</span>;
  if (status === 'question') return <span className="badge question">待回答</span>;
  return null;
}

export function SessionList({
  remote,
  ws,
  onOpen,
}: {
  remote: Remote;
  ws: WsClient;
  onOpen: (id: string, title: string) => void;
}) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [creatingKey, setCreatingKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      // by_workspace view, full sweep via page_token when the server pages us
      const pages: V2ByWorkspaceResponse[] = [];
      let token: string | undefined;
      for (let i = 0; i < 10; i++) {
        const path =
          '/api/v2/sessions?view=by_workspace&page_size=100&group.page_size=100' +
          (token ? `&page_token=${encodeURIComponent(token)}` : '');
        const res = await remote.box('GET', path);
        const payload = res.body as V2ByWorkspaceResponse | null;
        if (payload?.code !== 0) throw new Error(payload?.msg ?? `status ${res.status}`);
        pages.push(payload);
        token = payload.data?.has_more ? payload.data?.next_page_token : undefined;
        if (!token) break;
      }
      setGroups(buildGroups(pages));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [remote]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    const bump = () => void refresh();
    ws.onEvent = bump;
    return () => {
      clearInterval(t);
      ws.onEvent = undefined;
    };
  }, [refresh, ws]);

  const createInGroup = useCallback(
    async (group: Group) => {
      if (creatingKey) return;
      setCreatingKey(group.key);
      try {
        // model: newest session in this group, else the globally newest session
        // (groups/sessions are both sorted newest-first)
        const model = group.model ?? groups[0]?.model ?? 'kimi-code/k3-256k';
        const title = `手机会话 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
        const created = await remote.box('POST', '/api/v1/sessions', {
          title,
          metadata: { cwd: group.cwd },
        });
        const payload = created.body as { code?: number; msg?: string; data?: { id?: string } } | null;
        if (payload?.code !== 0 || !payload.data?.id) throw new Error(payload?.msg ?? '创建失败');
        const id = payload.data.id;
        // a created session drops agent_config.model - set it or turns fail
        await remote.box('POST', `/api/v1/sessions/${id}/profile`, {
          agent_config: { model, permission_mode: 'yolo' },
        });
        void refresh();
        onOpen(id, title);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setCreatingKey(null);
      }
    },
    [creatingKey, groups, onOpen, refresh, remote],
  );

  const total = groups.reduce((n, g) => n + g.sessions.length, 0);

  return (
    <div className="list-page">
      <header className="topbar">
        <span className="title">会话</span>
      </header>
      {error && <div className="error-note">{error}</div>}
      <div className="session-list">
        {total === 0 && !error && (
          <div className="empty">还没有会话：先在电脑上打开 Kimi Code 建一个会话，手机上即可看到并新建。</div>
        )}
        {groups.map((g) => {
          const isCollapsed = collapsed[g.key] === true;
          return (
            <section key={g.key} className="ws-group">
              <div className="ws-group-head">
                <button
                  className="ws-group-toggle"
                  onClick={() => setCollapsed((prev) => ({ ...prev, [g.key]: !isCollapsed }))}
                >
                  <span className={`chevron${isCollapsed ? ' closed' : ''}`}>▾</span>
                  <span className="ws-name ellipsis">{g.name}</span>
                  <span className="ws-count">{g.sessions.length}</span>
                </button>
                <button
                  className="btn icon"
                  title={`在 ${g.cwd} 新建会话`}
                  disabled={creatingKey === g.key}
                  onClick={() => void createInGroup(g)}
                >
                  {creatingKey === g.key ? '…' : '+'}
                </button>
              </div>
              <div className="ws-cwd ellipsis">{g.cwd}</div>
              {!isCollapsed &&
                g.sessions.map((s) => (
                  <button
                    key={s.id}
                    className="session-card"
                    onClick={() => onOpen(s.id, s.meta?.title || '未命名会话')}
                  >
                    <div className="row1">
                      <span className="s-title">{s.meta?.title || '未命名会话'}</span>
                      <StatusBadge status={s.activity?.status} />
                    </div>
                    <div className="row2">
                      <span className="s-sub">{s.meta?.last_prompt ?? ''}</span>
                      <span className="s-time">{relTime(s.meta?.updated_at)}</span>
                    </div>
                  </button>
                ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
