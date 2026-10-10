// Browser-side AES-256-GCM envelopes via @noble/ciphers (pure JS on purpose:
// WebCrypto is unavailable over plain http:// LAN addresses).
// Wire format matches the bridge exactly: {iv, ct} base64url, ct||tag(16).
import { gcm } from '@noble/ciphers/aes';
import { utf8ToBytes, bytesToUtf8 } from '@noble/ciphers/utils';

export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function keyFromB64url(s: string): Uint8Array {
  const key = b64urlDecode(s);
  if (key.length !== 32) throw new Error('key must be 32 bytes');
  return key;
}

export function seal(key: Uint8Array, value: unknown): { iv: string; ct: string } {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const c = gcm(key, iv);
  const ct = c.encrypt(utf8ToBytes(JSON.stringify(value)));
  return { iv: b64urlEncode(iv), ct: b64urlEncode(ct) };
}

export function openEnvelope<T = unknown>(key: Uint8Array, env: unknown): T {
  if (!env || typeof env !== 'object') throw new Error('bad envelope');
  const { iv, ct } = env as Record<string, unknown>;
  if (typeof iv !== 'string' || typeof ct !== 'string') throw new Error('bad envelope');
  const pt = gcm(key, b64urlDecode(iv)).decrypt(b64urlDecode(ct)); // throws on auth failure
  return JSON.parse(bytesToUtf8(pt)) as T;
}
