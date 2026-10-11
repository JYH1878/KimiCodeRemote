// Encrypted WebSocket bridge. Every frame in both directions is an
// AES-256-GCM envelope; inside is a small private protocol:
//   client -> bridge: {t:'api', id, method, path, body}
//                     {t:'sub', id, session_id}
//                     {t:'unsub', id, session_id}
//                     {t:'ping'}
//   bridge -> client: {t:'hello', upstream}
//                     {t:'api_res', id, status, body}
//                     {t:'sub_res', id, session_id, ok, reason?}
//                     {t:'unsub_res', id, session_id, ok}
//                     {t:'ev', session_id, event}        (upstream session_event)
//                     {t:'up', connected}                (upstream WS health)
//                     {t:'pong'}
// Upstream we hold one shared authenticated WebSocket to /api/v1/ws and
// multiplex all client subscriptions over it. If the upstream WS cannot be
// established, clients are told so and fall back to polling via /box.
import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { openEnvelope, seal } from './crypto.js';
import { isAllowed } from './allowlist.js';
import { splitPath, upstreamRequest } from './upstream.js';
import type { Instance } from './discovery.js';
import { MAX_WS_FRAME } from './config.js';

interface PendingSub {
  client: WebSocket;
  reqId: string;
  sessionId: string;
  timer: NodeJS.Timeout;
}

export class WsBridge {
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_FRAME });
  private sessionClients = new Map<string, Set<WebSocket>>();
  private pendingSubs = new Map<string, PendingSub>();
  private upstream: WebSocket | null = null;
  private upstreamReady = false;
  private upstreamPromise: Promise<boolean> | null = null;
  private resolveConnect: ((ok: boolean) => void) | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private upSeq = 0;

  constructor(
    private key: Buffer,
    private instance: Instance,
    private token: string,
    private log: (s: string) => void,
  ) {}

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
  }

  async close(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const sub of this.pendingSubs.values()) clearTimeout(sub.timer);
    this.pendingSubs.clear();
    for (const ws of this.wss.clients) ws.terminate();
    this.upstream?.close();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private send(ws: WebSocket, obj: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(seal(this.key, obj)));
    }
  }

  private broadcast(obj: unknown): void {
    for (const ws of this.wss.clients) this.send(ws, obj);
  }

  private onConnection(ws: WebSocket): void {
    this.send(ws, { t: 'hello', upstream: this.upstreamReady });
    const pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 30_000);
    ws.on('message', (data) => void this.onClientMessage(ws, data));
    ws.on('close', () => {
      clearInterval(pingTimer);
      this.dropClient(ws);
    });
    ws.on('error', () => ws.terminate());
  }

  private dropClient(ws: WebSocket): void {
    for (const [sessionId, set] of this.sessionClients) {
      set.delete(ws);
      if (set.size === 0) this.sessionClients.delete(sessionId);
    }
  }

  private async onClientMessage(ws: WebSocket, data: unknown): Promise<void> {
    let inner: Record<string, unknown>;
    try {
      inner = openEnvelope<Record<string, unknown>>(this.key, JSON.parse(String(data)));
    } catch {
      ws.close(4001, 'bad envelope');
      return;
    }
    const t = inner.t;
    if (t === 'ping') {
      this.send(ws, { t: 'pong' });
      return;
    }
    if (t === 'api') {
      await this.handleApi(ws, inner);
      return;
    }
    if (t === 'sub') {
      await this.handleSub(ws, inner);
      return;
    }
    if (t === 'unsub') {
      this.handleUnsub(ws, inner);
      return;
    }
    this.send(ws, { t: 'api_res', id: String(inner.id ?? ''), status: 400, body: { error: 'unknown frame type' } });
  }

  private async handleApi(ws: WebSocket, inner: Record<string, unknown>): Promise<void> {
    const id = String(inner.id ?? '');
    const method = typeof inner.method === 'string' ? inner.method.toUpperCase() : '';
    const sp = splitPath(inner.path);
    if (!sp || (method !== 'GET' && method !== 'POST')) {
      this.send(ws, { t: 'api_res', id, status: 400, body: { error: 'bad request' } });
      return;
    }
    if (!isAllowed(method, sp.pathname)) {
      this.send(ws, { t: 'api_res', id, status: 403, body: { error: 'forbidden' } });
      return;
    }
    const out = await upstreamRequest({
      instance: this.instance,
      token: this.token,
      method,
      pathname: sp.pathname,
      search: sp.search,
      body: inner.body,
    });
    this.send(ws, { t: 'api_res', id, status: out.status, body: out.body });
  }

  private async handleSub(ws: WebSocket, inner: Record<string, unknown>): Promise<void> {
    const id = String(inner.id ?? '');
    const sessionId = String(inner.session_id ?? '');
    if (!sessionId) {
      this.send(ws, { t: 'sub_res', id, session_id: sessionId, ok: false, reason: 'missing session_id' });
      return;
    }
    const up = await this.ensureUpstream();
    if (!up || !this.upstream || this.upstream.readyState !== WebSocket.OPEN) {
      this.send(ws, { t: 'sub_res', id, session_id: sessionId, ok: false, reason: 'upstream websocket unavailable' });
      return;
    }
    const upId = `s${++this.upSeq}`;
    const timer = setTimeout(() => {
      if (this.pendingSubs.delete(upId)) {
        this.send(ws, { t: 'sub_res', id, session_id: sessionId, ok: false, reason: 'subscribe timed out' });
      }
    }, 10_000);
    this.pendingSubs.set(upId, { client: ws, reqId: id, sessionId, timer });
    this.log(`upstream -> subscribe_v2:${upId} session=${sessionId}`);
    try {
      this.upstream.send(
        JSON.stringify({
          type: 'subscribe_v2',
          id: upId,
          payload: { session_id: sessionId, transcript: { '*': 'delta' } },
        }),
      );
    } catch (e) {
      this.log(`upstream send failed: ${(e as Error).message}`);
    }
  }

  private handleUnsub(ws: WebSocket, inner: Record<string, unknown>): void {
    const id = String(inner.id ?? '');
    const sessionId = String(inner.session_id ?? '');
    const set = this.sessionClients.get(sessionId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        this.sessionClients.delete(sessionId);
        if (this.upstream?.readyState === WebSocket.OPEN) {
          this.upstream.send(JSON.stringify({ type: 'unsubscribe_v2', id: `u${++this.upSeq}`, payload: { session_id: sessionId } }));
        }
      }
    }
    this.send(ws, { t: 'unsub_res', id, session_id: sessionId, ok: true });
  }

  private wantUpstream(): boolean {
    return this.sessionClients.size > 0 || this.pendingSubs.size > 0;
  }

  private ensureUpstream(): Promise<boolean> {
    if (this.upstreamReady && this.upstream?.readyState === WebSocket.OPEN) return Promise.resolve(true);
    if (this.upstreamPromise) return this.upstreamPromise;
    this.upstreamPromise = this.connectUpstream().finally(() => {
      this.upstreamPromise = null;
    });
    return this.upstreamPromise;
  }

  private connectUpstream(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (this.resolveConnect === done) this.resolveConnect = null;
          resolve(ok);
        }
      };
      const timer = setTimeout(() => {
        ws?.terminate();
        done(false);
      }, 8000);
      this.resolveConnect = done;
      let ws: WebSocket;
      try {
        ws = new WebSocket(`ws://127.0.0.1:${this.instance.port}/api/v1/ws`, {
          headers: { authorization: `Bearer ${this.token}` },
        });
      } catch (e) {
        this.log(`upstream ws connect failed: ${(e as Error).message}`);
        done(false);
        return;
      }
      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'client_hello',
            id: 'hello',
            payload: { client_id: `kimicoderemote-${randomUUID()}` },
          }),
        );
      });
      ws.on('message', (data) => this.onUpstreamMessage(ws, String(data)));
      ws.on('error', (err) => {
        this.log(`upstream ws error: ${err.message}`);
      });
      (ws as unknown as { _socket?: { on: (ev: string, cb: (e: Error) => void) => void } })._socket?.on(
        'error',
        (e) => this.log(`upstream raw socket error: ${e.message}`),
      );
      ws.on('close', (code, reason) => {
        const wasReady = this.upstreamReady;
        this.log(`upstream ws closed (code=${code} reason=${reason.toString() || 'none'} wasReady=${wasReady})`);
        this.upstream = null;
        this.upstreamReady = false;
        for (const sub of this.pendingSubs.values()) {
          clearTimeout(sub.timer);
          this.send(sub.client, { t: 'sub_res', id: sub.reqId, session_id: sub.sessionId, ok: false, reason: 'upstream closed' });
        }
        this.pendingSubs.clear();
        if (wasReady) {
          this.broadcast({ t: 'up', connected: false });
          this.log('upstream websocket closed');
        }
        if (this.wantUpstream()) {
          this.reconnectTimer = setTimeout(() => {
            void this.ensureUpstream().then(() => this.retrySubscriptions());
          }, 3000);
        }
        done(false);
      });
      this.upstream = ws;
    });
  }

  private retrySubscriptions(): void {
    if (!this.upstreamReady) return;
    for (const sessionId of [...this.sessionClients.keys()]) {
      const upId = `s${++this.upSeq}`;
      this.upstream?.send(
        JSON.stringify({
          type: 'subscribe_v2',
          id: upId,
          payload: { session_id: sessionId, transcript: { '*': 'delta' } },
        }),
      );
    }
  }

  private onUpstreamMessage(ws: WebSocket, raw: string): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.log(`upstream sent non-json frame (${raw.length} bytes)`);
      return;
    }
    const type = m.type;
    if (process.env.KIMI_REMOTE_WS_DEBUG) {
      this.log(`upstream <- ${type}${m.id ? `:${String(m.id)}` : ''}${m.code !== undefined ? ` code=${String(m.code)}` : ''}`);
    }
    if (type === 'server_hello') return;
    if (type === 'ping') {
      if (process.env.KIMI_REMOTE_WS_DEBUG) {
        this.log(`upstream ping raw: ${raw.slice(0, 300)} -> pong sent`);
      }
      ws.send(JSON.stringify({ type: 'pong', payload: { nonce: (m.payload as { nonce?: string })?.nonce ?? '' } }));
      return;
    }
    if (type === 'ack' && m.id === 'hello') {
      const code = Number(m.code);
      if (code === 0) {
        this.upstreamReady = true;
        this.log('upstream websocket ready');
        this.broadcast({ t: 'up', connected: true });
        this.resolveConnect?.(true);
      } else {
        this.log(`upstream client_hello rejected: ${String(m.msg ?? code)}`);
        this.resolveConnect?.(false);
        ws.close();
      }
      return;
    }
    if (type === 'ack') {
      const pending = this.pendingSubs.get(String(m.id));
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingSubs.delete(String(m.id));
        const code = Number(m.code);
        if (code === 0) {
          const set = this.sessionClients.get(pending.sessionId) ?? new Set<WebSocket>();
          set.add(pending.client);
          this.sessionClients.set(pending.sessionId, set);
        }
        this.send(pending.client, {
          t: 'sub_res',
          id: pending.reqId,
          session_id: pending.sessionId,
          ok: code === 0,
          reason: code === 0 ? undefined : String(m.msg ?? 'rejected'),
        });
      }
      return;
    }
    if (type === 'error') {
      this.log(`upstream ws error frame: ${JSON.stringify(m.payload ?? m).slice(0, 200)}`);
      return;
    }
    // Any session-scoped frame (transcript.ops/reset, event.session.*,
    // permission.approval.*, agent.*, ...) carries a session_id - fan it out.
    // The asyncapi calls these "session_event" but on the wire the top-level
    // type is the concrete event name.
    const eventSessionId = typeof m.session_id === 'string' ? m.session_id : '';
    if (eventSessionId && (m.seq !== undefined || m.volatile !== undefined || m.payload !== undefined)) {
      const set = this.sessionClients.get(eventSessionId);
      if (set) {
        for (const client of set) {
          this.send(client, { t: 'ev', session_id: eventSessionId, event: m });
        }
      }
    }
  }
}
