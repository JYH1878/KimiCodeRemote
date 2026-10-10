// LAN address enumeration for the printed pairing URLs.
import { networkInterfaces } from 'node:os';

export function lanAddresses(): string[] {
  const out: string[] = [];
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const addr of list ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
    }
  }
  // stable, private ranges first
  return out.sort((a, b) => {
    const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3);
    return rank(a) - rank(b);
  });
}
