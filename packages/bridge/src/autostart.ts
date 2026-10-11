// Windows login autostart for the packaged exe: a single .vbs in the user's
// Startup folder launches `KimiCodeRemote.exe --watch` hidden at logon. No
// registry, no admin rights. The watcher then follows the Kimi Code desktop
// app (spawn bridge when it appears, let the bridge exit when it closes).
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const VBS_NAME = 'KimiCodeRemote.vbs';

export function autostartVbsPath(): string | null {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', VBS_NAME);
}

export function installAutostart(exePath: string): string {
  const vbs = autostartVbsPath();
  if (!vbs) throw new Error('%APPDATA% not set - cannot locate the Startup folder');
  // VBS escaping: "" inside a string literal is one literal quote, so
  // """C:\path with space\KimiCodeRemote.exe"" --watch" runs
  // "C:\path with space\KimiCodeRemote.exe" --watch with the path protected.
  const content =
    `' KimiCodeRemote autostart - launches the bridge watcher hidden at logon.\n` +
    `' Delete this file to disable, or run: KimiCodeRemote.exe --uninstall-autostart\n` +
    'Set sh = CreateObject("WScript.Shell")\n' +
    `sh.Run """${exePath}"" --watch", 0, False\n`;
  mkdirSync(dirname(vbs), { recursive: true });
  // UTF-16 LE + BOM: wscript reads plain .vbs as ANSI by default and would
  // garble non-ASCII characters in the exe path.
  writeFileSync(vbs, '\uFEFF' + content, 'utf16le');
  return vbs;
}

export function uninstallAutostart(): boolean {
  const vbs = autostartVbsPath();
  if (!vbs || !existsSync(vbs)) return false;
  rmSync(vbs, { force: true });
  return true;
}
