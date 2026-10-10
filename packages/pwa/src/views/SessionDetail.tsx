import { useCallback, useEffect, useRef, useState } from 'react';
import type { Remote, WsClient } from '../api.js';
import { Markdown } from '../md.js';
import type {
  Approval,
  ContentBlock,
  Message,
  QuestionEntry,
  SessionsResponse,
  SessionStatus,
} from '../types.js';

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
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [questions, setQuestions] = useState<QuestionEntry[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const refreshTimer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [msgs, st, ap, qs] = await Promise.all([
        remote.box('GET', `/api/v1/sessions/${sessionId}/messages`),
        remote.box('GET', `/api/v1/sessions/${sessionId}/status`),
        remote.box('GET', `/api/v1/sessions/${sessionId}/approvals?status=pending`),
        remote.box('GET', `/api/v1/sessions/${sessionId}/questions?status=pending`),
      ]);
      setMessages((msgs.body as { data?: { items?: Message[] } } | null)?.data?.items ?? []);
      setStatus((st.body as { data?: SessionStatus } | null)?.data ?? null);
      setApprovals((ap.body as { data?: { items?: Approval[] } } | null)?.data?.items ?? []);
      setQuestions((qs.body as { data?: { items?: QuestionEntry[] } } | null)?.data?.items ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [remote, sessionId]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void refresh();
    }, 250);
  }, [refresh]);

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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput('');
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

      <div className="stream">
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

        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="bubble user">
              <Blocks blocks={m.content.filter((b) => b.type !== 'thinking')} />
            </div>
          ) : m.role === 'assistant' ? (
            <div key={m.id} className="bubble assistant">
              <Blocks blocks={m.content} />
            </div>
          ) : null,
        )}
        {status?.busy && (
          <div className="typing">
            <span></span>
            <span></span>
            <span></span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <div className="error-note">{error}</div>}
      <footer className="composer">
        <textarea
          value={input}
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
