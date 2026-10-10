// Transport layer: encrypted /box HTTP + encrypted WebSocket with automatic
// reconnect. The pairing key never leaves this module's closures.
import { seal, openEnvelope } from './crypto.js';
import type { EnvelopeBody } from './types.js';

export class RemoteError extends Error {
  constructor(
    public kind: 'http' | 'upstream',
    public httpStatus: number,
    public upstreamStatus: number | null,
    message: string,
  ) {
    super(message);
  }
}

export class Remote {
  constructor(readonly key: Uint8Array) {}

  async box(method: string, path: string, body?: unknown, timeoutMs = 90_000): Promise<EnvelopeBody> {
    const res = await fetch('/box', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(seal(this.key, { method, path, body })),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) {
      throw new RemoteError('http', res.status, null, `bridge rejected: HTTP ${res.status}`);
    }
    const opened = openEnvelope<EnvelopeBody>(this.key, await res.json());
    return opened;
  }

  wsUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }
}

interface Inner {
  t: string;
  id?: string;
  ok?: boolean;
  status?: number;
  connected?: boolean;
  upstream?: boolean;
  session_id?: string;
  event?: unknown;
  body?: unknown;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private reqSeq = 0;
  private pending = new Map<string, { resolve: (v: Inner) => void; timer: number }>();

  transportUp = false;
  upstreamUp = false;
  subs = new Set<string>();
  onStatusChange?: () => void;
  onEvent?: (sessionId: string, event: unknown) => void;

  constructor(private remote: Remote) {}

  get live(): boolean {
    return this.transportUp && this.upstreamUp;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private emit(): void {
    this.onStatusChange?.();
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.remote.wsUrl());
    } catch {
      setTimeout(() => this.connect(), 3000);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.transportUp = true;
      this.emit();
      for (const sessionId of this.subs) {
        this.send({ t: 'sub', id: `sub${++this.reqSeq}`, session_id: sessionId });
      }
    };
    ws.onmessage = (ev) => {
      let m: Inner;
      try {
        m = openEnvelope<Inner>(this.remote.key, JSON.parse(String(ev.data)));
      } catch {
        return;
      }
      if (m.t === 'hello') {
        this.upstreamUp = !!m.upstream;
        this.emit();
      } else if (m.t === 'up') {
        this.upstreamUp = !!m.connected;
        this.emit();
      } else if (m.t === 'ev') {
        this.onEvent?.(m.session_id ?? '', m.event);
      } else if (m.t === 'sub_res' || m.t === 'api_res' || m.t === 'unsub_res') {
        const waiter = m.id ? this.pending.get(m.id) : undefined;
        if (waiter) {
          clearTimeout(waiter.timer);
          this.pending.delete(m.id ?? '');
          waiter.resolve(m);
        }
      }
    };
    ws.onclose = () => {
      this.transportUp = false;
      this.upstreamUp = false;
      this.emit();
      for (const [, waiter] of this.pending) waiter.resolve({ t: 'gone' });
      this.pending.clear();
      if (!this.stopped) setTimeout(() => this.connect(), 2000 + Math.random() * 2000);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    };
  }

  private send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(seal(this.remote.key, obj)));
    }
  }

  private request(frame: Record<string, unknown>, timeoutMs = 30_000): Promise<Inner> {
    return new Promise((resolve) => {
      if (!this.transportUp) {
        resolve({ t: 'down' });
        return;
      }
      const id = `r${++this.reqSeq}`;
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        resolve({ t: 'timeout', id });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.send({ ...frame, id });
    });
  }

  async subscribe(sessionId: string): Promise<boolean> {
    this.subs.add(sessionId);
    const res = await this.request({ t: 'sub', session_id: sessionId }, 15_000);
    return res.t !== 'down' && res.t !== 'timeout' && res.ok === true;
  }

  unsubscribe(sessionId: string): void {
    this.subs.delete(sessionId);
    this.send({ t: 'unsub', id: `unsub${++this.reqSeq}`, session_id: sessionId });
  }

  async api(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown } | null> {
    const res = await this.request({ t: 'api', method, path, body });
    if (res.t === 'api_res') return { status: res.status ?? 0, body: res.body };
    return null;
  }
}
