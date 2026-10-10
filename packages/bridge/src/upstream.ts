// The single file that builds and performs upstream requests to the desktop
// server on 127.0.0.1. The server.token is attached here and nowhere else;
// it never appears in any response, log or client payload.
import type { Instance } from './discovery.js';

export interface UpstreamResult {
  status: number;
  body: unknown;
}

export function splitPath(rawPath: unknown): { pathname: string; search: string } | null {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/') || rawPath.includes('\0')) {
    return null;
  }
  try {
    const u = new URL(rawPath, 'http://upstream.invalid');
    return { pathname: u.pathname, search: u.search };
  } catch {
    return null;
  }
}

export async function upstreamRequest(opts: {
  instance: Instance;
  token: string;
  method: string;
  pathname: string;
  search?: string;
  body?: unknown;
  timeoutMs?: number;
}): Promise<UpstreamResult> {
  const url = `http://127.0.0.1:${opts.instance.port}${opts.pathname}${opts.search ?? ''}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
  } catch (e) {
    return {
      status: 502,
      body: { code: -1, msg: `upstream unreachable: ${(e as Error).message}` },
    };
  }
  const text = await res.text().catch(() => '');
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}
