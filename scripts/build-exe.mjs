// npm run build:exe - package bridge + PWA into a single Windows executable
// via Node SEA (single executable application). The root script runs
// `npm run build` first; this script then:
//   1. esbuild-bundles packages/bridge/src/cli.ts into one CJS file
//   2. walks packages/pwa/dist and generates the SEA asset manifest
//      (hashed filenames change on every PWA build - the list is always
//      generated, never hand-written)
//   3. produces the SEA blob (node --experimental-sea-config)
//   4. copies node.exe -> release/KimiCodeRemote.exe
//   5. injects the blob with postject and lights the SEA sentinel fuse
// Output: release/KimiCodeRemote.exe (gitignored). All its mutable state
// lives in KimiCodeRemote-data/ next to wherever the exe is placed.
// cloudflared is NOT embedded - it is downloaded on first run (tunnel.ts).
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild'; // hoisted devDependency (via vite)
import { inject } from 'postject';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PWA_DIST = join(ROOT, 'packages', 'pwa', 'dist');
const OUT_DIR = join(ROOT, 'release');
const BUILD_DIR = join(OUT_DIR, 'build');
const EXE = join(OUT_DIR, 'KimiCodeRemote.exe');
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

mkdirSync(BUILD_DIR, { recursive: true });

// 1. bundle the bridge CLI (and everything it imports) into one CJS file
await build({
  entryPoints: [join(ROOT, 'packages', 'bridge', 'src', 'cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: join(BUILD_DIR, 'cli.cjs'),
  sourcemap: false,
  // ws optional peer deps: deliberately not installed; ws wraps these
  // requires in try/catch and runs pure-JS without them
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'info',
});

// 2. collect the PWA dist as SEA assets (keys = web paths, forward slashes)
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
const distFiles = walk(PWA_DIST);
if (!distFiles.some((f) => f.endsWith('index.html'))) {
  throw new Error(`no index.html in ${PWA_DIST} - run: npm run build`);
}
const assets = {};
for (const f of distFiles) {
  assets[relative(PWA_DIST, f).split(sep).join('/')] = resolve(f);
}

// 3. sea-config + blob
const configPath = join(BUILD_DIR, 'sea-config.json');
writeFileSync(
  configPath,
  JSON.stringify(
    {
      main: resolve(join(BUILD_DIR, 'cli.cjs')),
      output: resolve(join(BUILD_DIR, 'cli.blob')),
      disableExperimentalSEAWarning: true,
      assets,
    },
    null,
    2,
  ) + '\n',
);
const sea = spawnSync(process.execPath, ['--experimental-sea-config', configPath], {
  stdio: 'inherit',
});
if (sea.status !== 0) throw new Error('node --experimental-sea-config failed');

// 4. fresh copy of the current node runtime
copyFileSync(process.execPath, EXE);

// 5. inject the blob (postject warns "The signature seems corrupted!" on
// Windows - expected when modifying a signed node.exe, does not affect it)
await inject(EXE, 'NODE_SEA_BLOB', readFileSync(join(BUILD_DIR, 'cli.blob')), {
  sentinelFuse: SEA_FUSE,
});

console.log(`built ${relative(ROOT, EXE)} (${(statSync(EXE).size / 1e6).toFixed(1)} MB)`);
