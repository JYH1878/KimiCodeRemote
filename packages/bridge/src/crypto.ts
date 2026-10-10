// AES-256-GCM envelope crypto. Wire format: JSON {iv, ct} with base64url
// values; plaintext bytes are `iv(12) || ciphertext || gcm-tag(16)`. The
// pairing key IS the credential: anything that fails to decrypt is rejected.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export const IV_LEN = 12;
export const KEY_LEN = 32;

export function b64urlEncode(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

export function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export interface Envelope {
  iv: string;
  ct: string;
}

interface KeyFile {
  version: 1;
  key: string;
  created_at: string;
}

export function loadOrCreateKey(file: string): Buffer {
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as KeyFile;
    if (typeof parsed.key !== 'string') throw new Error(`malformed key file ${file}`);
    const key = b64urlDecode(parsed.key);
    if (key.length !== KEY_LEN) throw new Error(`key in ${file} must be ${KEY_LEN} bytes`);
    return key;
  }
  const key = randomBytes(KEY_LEN);
  const data: KeyFile = {
    version: 1,
    key: b64urlEncode(key),
    created_at: new Date().toISOString(),
  };
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  return key;
}

export function readKeyString(file: string): string {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as KeyFile;
  return parsed.key;
}

export function seal(key: Buffer, value: unknown): Envelope {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const pt = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value), 'utf8')),
    cipher.final(),
  ]);
  const ct = Buffer.concat([pt, cipher.getAuthTag()]);
  return { iv: b64urlEncode(iv), ct: b64urlEncode(ct) };
}

export function openEnvelope<T = unknown>(key: Buffer, env: unknown): T {
  if (!env || typeof env !== 'object') throw new Error('bad envelope');
  const { iv, ct } = env as Record<string, unknown>;
  if (typeof iv !== 'string' || typeof ct !== 'string') throw new Error('bad envelope');
  const ivBuf: Buffer = b64urlDecode(iv);
  const ctBuf: Buffer = b64urlDecode(ct);
  if (ivBuf.length !== IV_LEN || ctBuf.length <= 16) throw new Error('bad envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, ivBuf);
  decipher.setAuthTag(ctBuf.subarray(ctBuf.length - 16));
  const pt = Buffer.concat([
    decipher.update(ctBuf.subarray(0, ctBuf.length - 16)),
    decipher.final(), // throws on auth failure
  ]);
  return JSON.parse(pt.toString('utf8')) as T;
}
