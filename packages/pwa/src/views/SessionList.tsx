import { useCallback, useEffect, useState } from 'react';
import type { Remote, WsClient } from '../api.js';
import type { SessionsResponse, SessionItem } from '../types.js';

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

export function SessionList({
  remote,
  ws,
  onOpen,
}: {
  remote: Remote;
  ws: WsClient;
  onOpen: (id: string, title: string) => void;
}) {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await remote.box('GET', '/api/v1/sessions');
      const payload = res.body as SessionsResponse | null;
      if (payload?.code !== 0) throw new Error(payload?.msg ?? `status ${res.status}`);
      setSessions(payload.data?.items ?? []);
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

  const createSession = useCallback(async () => {
    setCreating(true);
    try {
      // model: copy from the newest real session (v2 activity), else fallback
      const v2 = await remote.box('GET', '/api/v2/sessions');
      interface V2Item {
        activity?: { model?: string };
        workspace?: { cwd?: string | null };
      }
      const v2Payload = v2.body as { data?: { items?: V2Item[] } } | null;
      const items = v2Payload?.data?.items ?? [];
      const model = items.map((i) => i.activity?.model).find((m) => typeof m === 'string' && m.length > 0) ?? 'kimi-code/k3-256k';
      const cwd = items.map((i) => i.workspace?.cwd).find((c): c is string => typeof c === 'string' && c.length > 0);
      if (!cwd) {
        setError('没有可复用的工作目录：先在电脑上开一个会话，再从手机新建。');
        return;
      }
      const created = await remote.box('POST', '/api/v1/sessions', {
        title: `手机会话 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
        metadata: { cwd },
      });
      const payload = created.body as { code?: number; msg?: string; data?: { id?: string } } | null;
      if (payload?.code !== 0 || !payload.data?.id) throw new Error(payload?.msg ?? '创建失败');
      const id = payload.data.id;
      const title = `手机会话 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
      await remote.box('POST', `/api/v1/sessions/${id}/profile`, {
        agent_config: { model, permission_mode: 'yolo' },
      });
      await refresh();
      onOpen(id, title);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }, [remote, refresh, onOpen]);

  return (
    <div className="list-page">
      <header className="topbar">
        <span className="title">会话</span>
        <button className="btn primary" disabled={creating} onClick={() => void createSession()}>
          {creating ? '创建中…' : '+ 新会话'}
        </button>
      </header>
      {error && <div className="error-note">{error}</div>}
      <div className="session-list">
        {sessions.length === 0 && !error && <div className="empty">还没有会话</div>}
        {sessions.map((s) => (
          <button key={s.id} className="session-card" onClick={() => onOpen(s.id, s.title || '未命名会话')}>
            <div className="row1">
              <span className="s-title">{s.title || '未命名会话'}</span>
              {s.busy && <span className="badge busy">运行中</span>}
              {s.pending_interaction === 'approval' && <span className="badge approval">待审批</span>}
              {s.pending_interaction === 'question' && <span className="badge question">待回答</span>}
            </div>
            <div className="row2">
              <span className="s-sub">{s.last_prompt ?? ''}</span>
              <span className="s-time">{relTime(s.updated_at)}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
