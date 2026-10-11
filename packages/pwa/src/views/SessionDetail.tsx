import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Remote, WsClient } from '../api.js';
import { classifyMessage, cleanUserMessage } from '../clean.js';
import { Markdown } from '../md.js';
import type {
  Approval,
  ContentBlock,
  Message,
  MessagesPageData,
  QuestionEntry,
  SessionStatus,
} from '../types.js';

const PAGE_SIZE = 50;

// The server returns message pages newest -> oldest. We render oldest -> newest.
function toChronological(items: Message[]): Message[] {
  return [...items].reverse();
}

// Merge a freshly fetched newest-page into the loaded list: known ids keep
// their position (content refreshed), unknown ids are newer and append at the
// bottom. Never drops or reorders already-loaded history.
function mergeNewestPage(existing: Message[], incoming: Message[]): Message[] {
  if (existing.length === 0) return incoming;
  const byId = new Map(existing.map((m) => [m.id, m]));
  const appended: Message[] = [];
  for (const m of incoming) {
    if (byId.has(m.id)) byId.set(m.id, m);
    else appended.push(m);
  }
  return [...byId.values(), ...appended];
}

// Prepend an older page (chronological) in front of the loaded list.
function prependOlderPage(existing: Message[], older: Message[]): Message[] {
  const ids = new Set(existing.map((m) => m.id));
  return [...older.filter((m) => !ids.has(m.id)), ...existing];
}

function messageText(m: Message): string {
  return m.content
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
    .join('')
    .trim();
}

// Drop optimistic echoes whose text has been confirmed by a real (server-side)
// user message; count-aware so double-sent identical texts don't eat each other.
function reconcileOptimistic(list: Message[]): Message[] {
  const realCounts = new Map<string, number>();
  for (const m of list) {
    if (m.role !== 'user' || m.local) continue;
    const t = messageText(m);
    if (t) realCounts.set(t, (realCounts.get(t) ?? 0) + 1);
  }
  const confirmed = new Map<string, number>();
  return list.filter((m) => {
    if (!m.local) return true;
    const t = messageText(m);
    if ((realCounts.get(t) ?? 0) > (confirmed.get(t) ?? 0)) {
      confirmed.set(t, (confirmed.get(t) ?? 0) + 1);
      return false;
    }
    return true;
  });
}

// <system-reminder> / <system> stripping lives in clean.ts (shared, unit-verified).
// cleanUserBlocks is replaced by classifyMessage + cleanUserMessage.

function Blocks({ blocks }: { blocks: ContentBlock[] }) {
  const parts: React.ReactNode[] = [];
  let key = 0;
  for (const b of blocks) {
    if (b.type === 'text' && b.text) {
      parts.push(<Markdown key={key++} text={b.text} />);
    } else if (b.type === 'thinking' && b.thinking) {
      parts.push(
        <details key={key++} className="thinking">
          <summary>思考过程</summary>
          <div className="thinking-body">{b.thinking}</div>
        </details>,
      );
    } else if (b.type === 'tool_use') {
      parts.push(
        <details key={key++} className="tool">
          <summary>🔧 {b.tool_name ?? 'tool'}</summary>
          <pre>{JSON.stringify(b.input, null, 2)}</pre>
        </details>,
      );
    } else if (b.type === 'tool_result') {
      const text =
        typeof b.output === 'string'
          ? b.output
          : JSON.stringify(b.output, null, 2) ?? '';
      parts.push(
        <details key={key++} className={`tool-result${b.is_error ? ' is-error' : ''}`}>
          <summary>{b.is_error ? '⚠ 工具结果（出错）' : '工具结果'}</summary>
          <pre>{text.slice(0, 4000)}</pre>
        </details>,
      );
    }
  }
  return <>{parts}</>;
}

export function SessionDetail({
  remote,
  ws,
  sessionId,
  title,
  live,
  onBack,
}: {
  remote: Remote;
  ws: WsClient;
  sessionId: string;
  title: string;
  live: boolean;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasOlder, setHasOlder] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [questions, setQuestions] = useState<QuestionEntry[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const streamRef = useRef<HTMLDivElement | null>(null);
  const refreshTimer = useRef<number | null>(null);
  const stickToBottom = useRef(true);
  const prependAnchor = useRef<{ height: number; top: number } | null>(null);
  const loadingOlderRef = useRef(false);
  const localSeq = useRef(0);

  const fetchPage = useCallback(
    async (beforeId?: string): Promise<{ items: Message[]; hasMore: boolean }> => {
      const q = new URLSearchParams({ page_size: String(PAGE_SIZE) });
      if (beforeId) q.set('before_id', beforeId);
      const res = await remote.box('GET', `/api/v1/sessions/${sessionId}/messages?${q}`);
      const payload = res.body as
        | { code?: number; msg?: string; data?: MessagesPageData }
        | null;
      if (payload?.code !== 0) {
        throw new Error(payload?.msg ?? `拉取消息失败 (${res.status})`);
      }
      return {
        items: toChronological(payload.data?.items ?? []),
        hasMore: payload.data?.has_more === true,
      };
    },
    [remote, sessionId],
  );

  const refresh = useCallback(async () => {
    try {
      const [page, st, ap, qs] = await Promise.all([
        fetchPage(),
        remote.box('GET', `/api/v1/sessions/${sessionId}/status`),
        remote.box('GET', `/api/v1/sessions/${sessionId}/approvals?status=pending`),
        remote.box('GET', `/api/v1/sessions/${sessionId}/questions?status=pending`),
      ]);
      setMessages((prev) => reconcileOptimistic(mergeNewestPage(prev, page.items)));
      setStatus((st.body as { data?: SessionStatus } | null)?.data ?? null);
      setApprovals((ap.body as { data?: { items?: Approval[] } } | null)?.data?.items ?? []);
      setQuestions((qs.body as { data?: { items?: QuestionEntry[] } } | null)?.data?.items ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [fetchPage, remote, sessionId]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void refresh();
    }, 250);
  }, [refresh]);

  // initial load: newest page, land at the bottom of the conversation
  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setHasOlder(true);
    setInitialLoading(true);
    stickToBottom.current = true;
    void (async () => {
      try {
        const { items, hasMore } = await fetchPage();
        if (cancelled) return;
        setMessages(items);
        setHasOlder(hasMore);
        setError(null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setInitialLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchPage]);

  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current || !hasOlder) return;
    const oldest = messages[0];
    if (!oldest) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const el = streamRef.current;
    if (el) prependAnchor.current = { height: el.scrollHeight, top: el.scrollTop };
    try {
      const { items, hasMore } = await fetchPage(oldest.id);
      setMessages((prev) => prependOlderPage(prev, items));
      setHasOlder(hasMore);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [fetchPage, hasOlder, messages]);

  useEffect(() => {
    void refresh();
    ws.onEvent = (sid) => {
      if (sid === sessionId) scheduleRefresh();
    };
    return () => {
      ws.onEvent = undefined;
      ws.unsubscribe(sessionId);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [refresh, scheduleRefresh, sessionId, ws]);

  // polling fallback: only when the live websocket path is not fully up
  useEffect(() => {
    if (live) return;
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [live, refresh]);

  // (re)subscribe whenever liveness changes; a fresh transport needs a new sub
  useEffect(() => {
    void ws.subscribe(sessionId);
  }, [live, sessionId, ws]);

  // keep the viewport glued to the bottom on new output, but never yank the
  // user away while they read history; restore position after prepending.
  useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    if (prependAnchor.current) {
      el.scrollTop = el.scrollHeight - prependAnchor.current.height + prependAnchor.current.top;
      prependAnchor.current = null;
      return;
    }
    if (stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, status?.busy, initialLoading]);

  const onStreamScroll = useCallback(() => {
    const el = streamRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (el.scrollTop < 60 && hasOlder && !loadingOlderRef.current) void loadOlder();
  }, [hasOlder, loadOlder]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput('');
    const optimistic: Message = {
      id: `local-${Date.now()}-${++localSeq.current}`,
      role: 'user',
      content: [{ type: 'text', text }],
      local: true,
    };
    stickToBottom.current = true;
    setMessages((prev) => [...prev, optimistic]);
    try {
      const res = await remote.box('POST', `/api/v1/sessions/${sessionId}/prompts`, {
        content: [{ type: 'text', text }],
      });
      const payload = res.body as { code?: number; msg?: string; data?: { prompt_id?: string; status?: string } } | null;
      if (payload?.code !== 0) throw new Error(payload?.msg ?? `发送失败 (${res.status})`);
      // busy session: the new prompt is queued - inject it into the running turn
      if (payload.data?.status === 'queued' && payload.data.prompt_id) {
        await remote.box('POST', `/api/v1/sessions/${sessionId}/prompts:steer`, {
          prompt_ids: [payload.data.prompt_id],
        });
      }
      scheduleRefresh();
    } catch (e) {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }, [input, remote, scheduleRefresh, sending, sessionId]);

  const decideApproval = useCallback(
    async (approvalId: string, decision: 'approved' | 'rejected') => {
      setApprovals((prev) => prev.filter((a) => a.approval_id !== approvalId));
      await remote.box('POST', `/api/v1/sessions/${sessionId}/approvals/${approvalId}`, {
        decision,
        scope: 'session',
      });
      scheduleRefresh();
    },
    [remote, scheduleRefresh, sessionId],
  );

  const answerQuestion = useCallback(
    async (entry: QuestionEntry, answers: Record<string, unknown>) => {
      setQuestions((prev) => prev.filter((q) => q.question_id !== entry.question_id));
      let res = await remote.box('POST', `/api/v1/sessions/${sessionId}/questions/${entry.question_id}`, { answers });
      if (res.status !== 200 || (res.body as { code?: number } | null)?.code !== 0) {
        // fallback: some builds expose an action-style tail instead
        res = await remote.box('POST', `/api/v1/sessions/${sessionId}/questions/:answer`, {
          question_id: entry.question_id,
          answers,
        });
      }
      if (res.status !== 200 || (res.body as { code?: number } | null)?.code !== 0) {
        setError('回答提交失败，请重试');
        scheduleRefresh();
      }
    },
    [remote, scheduleRefresh, sessionId],
  );

  const answerSingle = (entry: QuestionEntry, qid: string, optionId: string) =>
    void answerQuestion(entry, { [qid]: { kind: 'single', option_id: optionId } });

  const answerOther = (entry: QuestionEntry, qid: string) => {
    const text = (otherText[qid] ?? '').trim();
    if (!text) return;
    void answerQuestion(entry, { [qid]: { kind: 'other', text } });
  };

  return (
    <div className="detail-page">
      <header className="topbar">
        <button className="btn ghost" onClick={onBack}>
          ‹ 返回
        </button>
        <span className="title ellipsis">{title}</span>
        <span className={`conn ${live ? 'ok' : 'poll'}`}>{live ? '实时' : '轮询'}</span>
      </header>

      <div className="stream" ref={streamRef} onScroll={onStreamScroll}>
        {approvals.map((a) => (
          <div key={a.approval_id} className="card approval-card">
            <div className="card-head">🔐 待审批 · {a.tool_name}</div>
            <div className="card-body">
              <div>{a.action}</div>
              {a.tool_input_display != null && <pre>{JSON.stringify(a.tool_input_display, null, 2).slice(0, 1200)}</pre>}
            </div>
            <div className="card-actions">
              <button className="btn danger" onClick={() => void decideApproval(a.approval_id, 'rejected')}>
                拒绝
              </button>
              <button className="btn primary" onClick={() => void decideApproval(a.approval_id, 'approved')}>
                同意
              </button>
            </div>
          </div>
        ))}

        {questions.map((entry) => (
          <div key={entry.question_id} className="card question-card">
            {entry.questions.map((q) => (
              <div key={q.id} className="q-item">
                <div className="card-head">❓ {q.header || 'Agent 提问'}</div>
                <div className="card-body">
                  <div>{q.question}</div>
                  {q.body && <div className="muted small">{q.body}</div>}
                </div>
                <div className="card-actions column">
                  {(q.options ?? []).map((o) => (
                    <button key={o.id} className="btn option" onClick={() => answerSingle(entry, q.id, o.id)}>
                      {o.label}
                      {o.description && <span className="muted small"> · {o.description}</span>}
                    </button>
                  ))}
                  {(q.allow_other ?? true) && (
                    <div className="other-row">
                      <input
                        value={otherText[q.id] ?? ''}
                        aria-label={q.other_label ?? '自定义回答'}
                        placeholder={q.other_label ?? '自定义回答…'}
                        onChange={(e) => setOtherText((prev) => ({ ...prev, [q.id]: e.target.value }))}
                      />
                      <button className="btn primary" onClick={() => answerOther(entry, q.id)}>
                        发送
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}

        {hasOlder && !initialLoading && (
          <div className="load-older">
            <button className="btn ghost" disabled={loadingOlder} onClick={() => void loadOlder()}>
              {loadingOlder ? '加载中…' : '↑ 加载更早的消息'}
            </button>
          </div>
        )}
        {!hasOlder && !initialLoading && messages.length > 0 && (
          <div className="history-start muted small">— 已经是最早的消息 —</div>
        )}
        {initialLoading && <div className="history-start muted small">加载中…</div>}

        {messages.map((m) => {
          const cls = classifyMessage(m);
          if (cls === 'hidden') return null; // injections / task notices / tool+system roles
          if (cls === 'assistant') {
            return (
              <div key={m.id} className="msg assistant">
                <Blocks blocks={m.content} />
              </div>
            );
          }
          const cleaned = cleanUserMessage(m);
          if (cls === 'skill') {
            // activation envelope -> a thin collapsed strip; the user's own
            // words (if any) render as a normal user card beside it
            return (
              <div key={m.id} className="skill-group">
                <details className="skill-strip">
                  <summary>✨ skill「{cleaned.skillName}」</summary>
                  <div className="skill-detail">
                    {cleaned.userText && <div className="skill-args">{cleaned.userText}</div>}
                    {cleaned.rawText && <div className="skill-raw muted small">{cleaned.rawText}</div>}
                  </div>
                </details>
                {cleaned.userText && (
                  <div className="bubble user">
                    <div className="user-text">
                      <Markdown text={cleaned.userText} />
                    </div>
                  </div>
                )}
              </div>
            );
          }
          if (!cleaned.userText) return null; // nothing renderable -> no empty bubble
          return (
            <div key={m.id} className={`bubble user${m.local ? ' pending' : ''}`}>
              <div className="user-text">
                <Markdown text={cleaned.userText} />
              </div>
            </div>
          );
        })}
        {status?.busy && (
          <div className="typing">
            <span></span>
            <span></span>
            <span></span>
          </div>
        )}
      </div>

      {error && <div className="error-note">{error}</div>}
      <footer className="composer">
        <textarea
          value={input}
          aria-label="输入消息"
          placeholder={status?.busy ? '会话运行中，输入将插队（steer）…' : '输入消息…'}
          rows={1}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="btn primary send" disabled={sending || input.trim() === ''} onClick={() => void send()}>
          发送
        </button>
      </footer>
    </div>
  );
}
