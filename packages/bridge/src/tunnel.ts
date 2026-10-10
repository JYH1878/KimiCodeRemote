// Cloudflared quick-tunnel integration (free, no account). Downloads the
// official Windows binary on first run, then spawns `cloudflared tunnel
// --url http://127.0.0.1:<port>` and parses the trycloudflare URL. The tunnel
// only ever carries ciphertext; Cloudflare can see timing and sizes at most.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const DOWNLOAD_URL =
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

// SSRF guard for the download itself: only https to GitHub hosts.
const ALLOWED_DOWNLOAD_HOSTS =
  /^https:\/\/([a-z0-9-]+\.)*(github\.com|githubusercontent\.com)\//i;

export async function ensureCloudflared(
  binPath: string,
  log: (s: string) => void = console.error,
): Promise<string> {
  if (existsSync(binPath)) return binPath;
  mkdirSync(dirname(binPath), { recursive: true });
  log(`downloading cloudflared from ${DOWNLOAD_URL} ...`);
  const res = await fetch(DOWNLOAD_URL, { redirect: 'follow', signal: AbortSignal.timeout(600_000) });
  const finalUrl = res.url || DOWNLOAD_URL;
  if (!ALLOWED_DOWNLOAD_HOSTS.test(finalUrl)) {
    throw new Error(`download redirected to untrusted host: ${new URL(finalUrl).host}`);
  }
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1_000_000) throw new Error('downloaded binary suspiciously small, aborting');
  writeFileSync(binPath, buf, { mode: 0o755 });
  log(`cloudflared saved to ${binPath} (${(buf.length / 1e6).toFixed(1)} MB)`);
  return binPath;
}

let activeChild: ReturnType<typeof spawn> | null = null;

// Kill the tunnel child and wait for it to be fully reaped. Exiting while
// the stdio pumps are still tearing down trips a libuv assertion on Windows.
export async function stopTunnel(): Promise<void> {
  const child = activeChild;
  activeChild = null;
  if (!child) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  });
}

// Resolves with the public URL, or null if the tunnel could not be
// established (caller degrades to LAN-only).
export function startTunnel(
  binPath: string,
  localPort: number,
  log: (s: string) => void = console.error,
): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const child = spawn(
      binPath,
      ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${localPort}`],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    activeChild = child;
    const finish = (url: string | null, why?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!url) {
        log(`tunnel failed: ${why ?? 'unknown'}; output tail: ${out.slice(-500).replace(/\n+/g, ' | ')}`);
        try {
          child.kill();
        } catch {
          /* noop */
        }
        if (activeChild === child) activeChild = null;
      }
      resolve(url);
    };
    const timeout = setTimeout(() => finish(null, 'timed out after 90s'), 90_000);
    const onLine = (line: string) => {
      out += line + '\n';
      const m = line.match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i);
      if (m) finish(m[0]);
    };
    child.stdout.on('data', (d: Buffer) => String(d).split(/\r?\n/).forEach(onLine));
    child.stderr.on('data', (d: Buffer) => String(d).split(/\r?\n/).forEach(onLine));
    child.on('exit', (code) => {
      if (!settled) finish(null, `process exited early (code ${code})`);
      if (activeChild === child) activeChild = null;
    });
  });
}
