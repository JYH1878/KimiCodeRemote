// The HTTP face of the bridge. Exactly four things are exposed:
//   GET  /healthz   -> "ok"
//   POST /box       -> encrypted request/response envelope
//   WS   /ws        -> encrypted frames (see wsbridge.ts)
//   GET  /*         -> static PWA files from packages/pwa/dist
// Everything else: 404. After a successful decrypt nothing but ciphertext
// ever leaves this process.
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { openEnvelope, seal, loadOrCreateKey } from './crypto.js';
import { discoverUpstream } from './discovery.js';
import type { Instance } from './discovery.js';
import { isAllowed } from './allowlist.js';
import { splitPath, upstreamRequest } from './upstream.js';
import { WsBridge } from './wsbridge.js';
import { ensureCloudflared, loadNamedTunnelConfig, startTunnel, stopTunnel } from './tunnel.js';
import { CLOUDFLARED_BIN, MAX_BOX_BODY, PWA_DIST } from './config.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

export interface BridgeOptions {
  port?: number;
  keyFile: string;
  tunnel?: boolean;
}

export interface Bridge {
  port: number;
  instance: Instance;
  tunnelReady: Promise<string | null>;
  close(): Promise<void>;
}

export async function startBridge(opts: BridgeOptions): Promise<Bridge> {
  // key must exist before the server accepts anything
  const key = loadOrCreateKey(opts.keyFile);
  const { instance, token } = await discoverUpstream();
  const log = (s: string) => console.log(`[bridge] ${s}`);

  const wsBridge = new WsBridge(key, instance, token, log);
  const server = http.createServer((req, res) => {
    void handle(req, res, key, instance, token).catch((e) => {
      log(`request error: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    });
  });
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/ws') {
      wsBridge.handleUpgrade(req, socket as never, head);
    } else {
      socket.destroy();
    }
  });

  const listenPort = opts.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  log(`listening on 127.0.0.1:${port} (loopback only, reached via tunnel), upstream desktop instance at 127.0.0.1:${instance.port}`);

  const tunnelReady: Promise<string | null> = opts.tunnel
    ? (async () => {
        try {
          const bin = await ensureCloudflared(CLOUDFLARED_BIN, (s) => log(s));
          const named = loadNamedTunnelConfig(opts.keyFile, (s) => log(s));
          return await startTunnel(bin, port, (s) => log(s), named);
        } catch (e) {
          log(`tunnel unavailable: ${(e as Error).message}`);
          return null;
        }
      })()
    : Promise.resolve(null);

  return {
    port,
    instance,
    tunnelReady,
    close: async () => {
      await stopTunnel();
      await wsBridge.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // give lingering handle teardown a beat before the process may exit
      await new Promise((r) => setTimeout(r, 300));
    },
  };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  key: Buffer,
  instance: Awaited<ReturnType<typeof discoverUpstream>>['instance'],
  token: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://local');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (req.method === 'POST' && path === '/box') {
    await handleBox(req, res, key, instance, token);
    return;
  }

  if (req.method === 'GET' && serveStatic(path, res)) return;

  json(res, 404, { error: 'not found' });
}

async function handleBox(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  key: Buffer,
  instance: Awaited<ReturnType<typeof discoverUpstream>>['instance'],
  token: string,
): Promise<void> {
  let raw: Buffer;
  try {
    raw = await readBody(req, MAX_BOX_BODY);
  } catch {
    json(res, 413, { error: 'body too large' });
    return;
  }
  let env: unknown;
  try {
    env = JSON.parse(raw.toString('utf8'));
  } catch {
    json(res, 400, { error: 'bad json' });
    return;
  }
  // shape check first (400) vs decryption failure (401): a wrong key and no
  // key are the same to us, but a structurally broken request is client error
  if (
    !env ||
    typeof env !== 'object' ||
    typeof (env as Record<string, unknown>).iv !== 'string' ||
    typeof (env as Record<string, unknown>).ct !== 'string'
  ) {
    json(res, 400, { error: 'bad envelope' });
    return;
  }
  let inner: Record<string, unknown>;
  try {
    inner = openEnvelope<Record<string, unknown>>(key, env);
  } catch {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  const method = typeof inner.method === 'string' ? inner.method.toUpperCase() : '';
  const sp = splitPath(inner.path);
  if (!sp || (method !== 'GET' && method !== 'POST')) {
    json(res, 400, { error: 'bad request' });
    return;
  }
  if (!isAllowed(method, sp.pathname)) {
    json(res, 403, { error: 'forbidden' });
    return;
  }
  const out = await upstreamRequest({
    instance,
    token,
    method,
    pathname: sp.pathname,
    search: sp.search,
    body: inner.body,
  });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(seal(key, { status: out.status, body: out.body })));
}

function serveStatic(path: string, res: http.ServerResponse): boolean {
  if (!existsSync(PWA_DIST)) {
    json(res, 404, { error: 'pwa not built - run: npm run build' });
    return true;
  }
  const rel = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
  if (rel.includes('..') || rel.startsWith('.')) return false;
  const filePath = join(PWA_DIST, rel);
  if (!filePath.startsWith(PWA_DIST + sep) && filePath !== join(PWA_DIST, 'index.html')) return false;
  let st;
  try {
    st = statSync(filePath);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  res.writeHead(200, {
    'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'content-length': st.size,
    'cache-control': rel.startsWith('assets/') ? 'public, max-age=604800' : 'no-cache',
  });
  createReadStream(filePath).pipe(res);
  return true;
}
