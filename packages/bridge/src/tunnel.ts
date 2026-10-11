// Cloudflared quick-tunnel integration (free, no account). Downloads the
// official binary for the host platform on first run (Windows: raw .exe;
// macOS: .tgz unpacked in pure JS), then spawns `cloudflared tunnel
// --url http://127.0.0.1:<port>` and parses the trycloudflare URL. The tunnel
// only ever carries ciphertext; Cloudflare can see timing and sizes at most.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { BIN_DIR } from './config.js';

const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

// SSRF guard for the download itself: only https to GitHub hosts.
const ALLOWED_DOWNLOAD_HOSTS =
  /^https:\/\/([a-z0-9-]+\.)*(github\.com|githubusercontent\.com)\//i;

// Which release asset fits this platform/arch (official asset names).
export function downloadTarget(platform: string, arch: string): string {
  if (platform === 'win32') return `${RELEASE_BASE}cloudflared-windows-amd64.exe`;
  if (platform === 'darwin' && arch === 'x64') return `${RELEASE_BASE}cloudflared-darwin-amd64.tgz`;
  if (platform === 'darwin' && arch === 'arm64') return `${RELEASE_BASE}cloudflared-darwin-arm64.tgz`;
  throw new Error(`unsupported platform: ${platform}-${arch} (cloudflared is fetched for Windows and macOS only)`);
}

// NUL-terminated string at [start, end) of a header/data block.
function cstr(buf: Buffer, start: number, end: number): string {
  const slice = buf.subarray(start, end);
  const nul = slice.indexOf(0);
  return slice.toString('utf8', 0, nul === -1 ? slice.length : nul);
}

// Tar size field (offset 124, 12 bytes): octal ASCII, or GNU base-256 when
// the high bit of the first byte is set.
function tarSize(header: Buffer): number {
  const first = header.readUInt8(124);
  if ((first & 0x80) !== 0) {
    let value = first & 0x7f;
    for (let i = 125; i < 136; i++) value = value * 256 + header.readUInt8(i);
    return value;
  }
  const octal = header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim();
  return octal ? parseInt(octal, 8) : 0;
}

// Minimal USTAR/GNU tar reader over a memory buffer: 512-byte header blocks,
// data blocks stepped over with alignment kept. GNU 'L' longname blocks set
// the next entry's name; pax 'x'/'g' extension blocks are skipped. Returns
// the contents of the named regular file (matched by full path or basename).
export function extractTarEntry(tar: Buffer, entryName: string): Buffer {
  let longName: string | null = null;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive padding block
    const size = tarSize(header);
    if (!Number.isFinite(size) || size < 0) throw new Error('tar: invalid size field');
    const dataStart = offset + 512;
    const data = tar.subarray(dataStart, Math.min(dataStart + size, tar.length));
    const type = header.readUInt8(156);
    const name = longName ?? cstr(header, 0, 100);
    longName = null;
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === 0x4c) {
      longName = cstr(data, 0, data.length); // 'L': name of the next entry
    } else if (type === 0x30 || type === 0x00) {
      if (name === entryName || name.endsWith(`/${entryName}`)) return data;
    }
    // 'x'/'g' pax headers, dirs, links etc: skipped, alignment preserved
  }
  throw new Error(`tar: entry "${entryName}" not found`);
}

// macOS release asset: gzip + tar wrapping a single `cloudflared` binary.
// Unpacked in pure JS (no system tar, no new dependency) and written
// executable next to the other platform binaries.
export function extractCloudflaredFromTgz(tgz: Buffer, binPath: string): string {
  const bin = extractTarEntry(gunzipSync(tgz), 'cloudflared');
  if (bin.length < 1_000_000) throw new Error('extracted binary suspiciously small, aborting');
  mkdirSync(dirname(binPath), { recursive: true });
  writeFileSync(binPath, bin, { mode: 0o755 });
  return binPath;
}

export async function ensureCloudflared(
  binPath: string,
  log: (s: string) => void = console.error,
): Promise<string> {
  if (existsSync(binPath)) return binPath;
  mkdirSync(dirname(binPath), { recursive: true });
  const url = downloadTarget(process.platform, process.arch);
  log(`downloading cloudflared from ${url} ...`);
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600_000) });
  const finalUrl = res.url || url;
  if (!ALLOWED_DOWNLOAD_HOSTS.test(finalUrl)) {
    throw new Error(`download redirected to untrusted host: ${new URL(finalUrl).host}`);
  }
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1_000_000) throw new Error('downloaded binary suspiciously small, aborting');
  if (url.endsWith('.tgz')) {
    extractCloudflaredFromTgz(buf, binPath);
    log(`cloudflared extracted to ${binPath} (${(buf.length / 1e6).toFixed(1)} MB tgz)`);
  } else {
    writeFileSync(binPath, buf, { mode: 0o755 });
    log(`cloudflared saved to ${binPath} (${(buf.length / 1e6).toFixed(1)} MB)`);
  }
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

// Optional named-tunnel config in .kimi-remote.json:
//   { "tunnel": { "mode": "named", "name": "...", "hostname": "..." } }
// With a named tunnel the pairing URL is the stable https://<hostname>; the
// one-time login/create/route-dns setup is documented in the README.
export interface NamedTunnel {
  name: string;
  hostname: string;
}

export function loadNamedTunnelConfig(
  keyFile: string,
  log: (s: string) => void = console.error,
): NamedTunnel | null {
  try {
    const cfg = JSON.parse(readFileSync(keyFile, 'utf8')) as {
      tunnel?: { mode?: string; name?: string; hostname?: string };
    };
    const t = cfg.tunnel;
    if (!t || t.mode !== 'named') return null;
    if (typeof t.name !== 'string' || !t.name || typeof t.hostname !== 'string' || !t.hostname) {
      log('tunnel config invalid: named mode needs non-empty name + hostname - using quick tunnel');
      return null;
    }
    return { name: t.name, hostname: t.hostname.replace(/^https?:\/\//, '').replace(/\/+$/, '') };
  } catch {
    return null; // no config file (yet) or unparsable - quick tunnel
  }
}

// Resolves with the public URL, or null if the tunnel could not be
// established (no tunnel, no remote access - the CLI fails loudly).
export function startTunnel(
  binPath: string,
  localPort: number,
  log: (s: string) => void = console.error,
  named?: NamedTunnel | null,
): Promise<string | null> {
  // containment: only the repo's own bin/ binary may ever be spawned
  const bin = resolve(binPath);
  if (!bin.startsWith(resolve(BIN_DIR) + sep)) {
    return Promise.reject(new Error(`cloudflared path escaped ${BIN_DIR}`));
  }
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const args = named
      ? // --url doubles as the ingress rule, so no config.yml is needed
        ['tunnel', '--no-autoupdate', 'run', '--url', `http://127.0.0.1:${localPort}`, named.name]
      : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${localPort}`];
    const child = spawn(binPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    activeChild = child;
    if (named) log(`starting named tunnel "${named.name}" (public: https://${named.hostname})`);
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
      if (named) {
        // a named tunnel serves a fixed hostname; readiness = edge connections
        if (/Registered tunnel connection/i.test(line)) finish(`https://${named.hostname}`);
      } else {
        // quick-tunnel hostnames are multi-word ("word-word-word-word");
        // cloudflared also logs https://api.trycloudflare.com (its API
        // endpoint) before the real URL - single-label hosts don't count
        const m = line.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/i);
        if (m) finish(m[0]);
      }
    };
    child.stdout.on('data', (d: Buffer) => String(d).split(/\r?\n/).forEach(onLine));
    child.stderr.on('data', (d: Buffer) => String(d).split(/\r?\n/).forEach(onLine));
    child.on('exit', (code) => {
      if (!settled) finish(null, `process exited early (code ${code})`);
      if (activeChild === child) activeChild = null;
    });
  });
}
