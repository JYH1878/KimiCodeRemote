// verify:discovery - print the discovered desktop instance; the live one on
// port 54754 must be picked (freshest heartbeat that answers healthz).
import { discoverUpstream, readInstanceFiles } from '../discovery.js';

async function main(): Promise<void> {
  const all = readInstanceFiles();
  console.log('registered instances (freshest heartbeat first):');
  for (const i of all) {
    console.log(`  port=${i.port} pid=${i.pid} heartbeat_at=${i.heartbeat_at} version=${i.host_version ?? '?'}`);
  }
  const { instance } = await discoverUpstream((s) => console.log(`  ${s}`));
  console.log(`picked: 127.0.0.1:${instance.port} (server_id=${instance.server_id})`);
  if (instance.port !== 54754) {
    console.error(`FAIL: expected the live instance on port 54754, got ${instance.port}`);
    process.exit(1);
  }
  console.log('PASS: live desktop instance on port 54754 discovered');
}

void main().catch((e: Error) => {
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
});
