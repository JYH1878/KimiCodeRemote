// probe12: wire WsBridge directly against a local echo server that pings
// every 2s and counts pongs — isolates bridge send/receive from the desktop.
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

const { WsBridge } = await import('../dist/wsbridge.js');
const KEY = Buffer.alloc(32, 7);
const { seal, openEnvelope } = await import('../dist/crypto.js');

const pongs = [];
let pings = 0;

const wssEcho = new WebSocketServer({ port: 54999 });
wssEcho.on('connection', (ws) => {
  console.log('[echo] upstream connected');
  ws.send(JSON.stringify({ type: 'server_hello', payload: { ws_connection_id: 'echo', protocol_version: 2, max_event_buffer_size: 100, capabilities: { event_batching: false, compression: false } } }));
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    console.log(`[echo] got: ${m.type}${m.id ? ':' + m.id : ''}`);
    if (m.type === 'client_hello') {
      ws.send(JSON.stringify({ type: 'ack', id: m.id, code: 0, msg: 'ok', payload: { accepted_subscriptions: [], resync_required: [], cursors: {} } }));
    } else if (m.type === 'pong') {
      pongs.push(m.payload?.nonce ?? '(none)');
    } else if (m.type === 'subscribe_v2') {
      ws.send(JSON.stringify({ type: 'ack', id: m.id, code: 0, msg: 'ok', payload: { accepted: m.payload.session_id, not_found: [], resync_required: [], cursors: {} } }));
      // emit a session_event 1s later
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'transcript.ops', seq: 1, session_id: m.payload.session_id, payload: { type: 'transcript.ops', agent_id: 'main', ops: [] } }));
      }, 1000);
    }
  });
  const t = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    pings++;
    ws.send(JSON.stringify({ type: 'ping', timestamp: new Date().toISOString(), payload: { nonce: `n${pings}` } }));
  }, 2000);
  ws.on('close', () => clearInterval(t));
});

const bridge = new WsBridge(KEY, { port: 54999 }, 'fake-token', (s) => console.log(`[bridge] ${s}`));
const server = http.createServer();
server.on('upgrade', (req, socket, head) => bridge.handleUpgrade(req, socket, head));
server.listen(55123);

await new Promise((r) => setTimeout(r, 300));
const phone = new WebSocket('ws://127.0.0.1:55123/ws');
phone.on('message', (data) => {
  const m = openEnvelope(KEY, JSON.parse(String(data)));
  console.log(`[phone] <- ${m.t}:${m.id ?? ''} ok=${String(m.ok)}`);
});
await new Promise((r) => phone.on('open', r));
phone.send(JSON.stringify(seal(KEY, { t: 'sub', id: 's1', session_id: 'sess_test' })));

setTimeout(async () => {
  console.log(`pings sent: ${pings}, pongs received: ${pongs.length} -> ${pongs.join(',')}`);
  phone.close();
  await bridge.close();
  server.close();
  wssEcho.close();
  process.exit(0);
}, 9000);
