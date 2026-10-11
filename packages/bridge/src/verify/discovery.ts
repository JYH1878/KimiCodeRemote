// verify:discovery - print the discovered desktop instance; any live instance
// counts (freshest heartbeat that answers healthz). The port is assigned by
// the desktop app per machine, so no specific port is asserted here.
import { discoverUpstream, readInstanceFiles } from '../discovery.js';

async function main(): Promise<void> {
  const all = readInstanceFiles();
  console.log('registered instances (freshest heartbeat first):');
  for (const i of all) {
    console.log(`  port=${i.port} pid=${i.pid} heartbeat_at=${i.heartbeat_at} version=${i.host_version ?? '?'}`);
  }
  const { instance } = await discoverUpstream((s) => console.log(`  ${s}`));
  console.log(
    `picked: 127.0.0.1:${instance.port} (pid=${instance.pid ?? '?'} version=${instance.host_version ?? '?'})`,
  );
  console.log('PASS: live desktop instance discovered');
}

void main().catch((e: Error) => {
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
});
