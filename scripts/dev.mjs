// npm run dev - bridge (serving API) + vite dev server (hot reload) together.
// The vite dev server proxies /box, /ws and /healthz to the bridge, so the
// PWA can be developed against the real encrypted transport.
import { spawn } from 'node:child_process';

const procs = [];

function run(name, cmd, args, color) {
  const p = spawn(cmd, args, { shell: true, env: process.env });
  const tag = `\x1b[${color}m[${name}]\x1b[0m`;
  const pump = (stream) => {
    stream.on('data', (d) => process.stdout.write(String(d).replace(/^/gm, tag + ' ')));
  };
  pump(p.stdout);
  pump(p.stderr);
  p.on('exit', (code) => {
    console.log(`${tag} exited (${code})`);
    for (const other of procs) other.kill();
    process.exit(code ?? 0);
  });
  procs.push(p);
}

console.log('kimi-remote dev: bridge on :7777, vite on :5183 (open http://localhost:5183)');
run('bridge', 'npm', ['run', 'dev:bridge'], '36');
run('vite', 'npm', ['run', 'dev:pwa'], '35');
