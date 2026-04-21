import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const cfg = JSON.parse(readFileSync(`${homedir()}/.openclaw/openclaw.json`, 'utf8'));
const port = cfg.gateway?.port ?? 18789;
const token = cfg.gateway?.auth?.token;
const url = `ws://127.0.0.1:${port}/`;

console.log(`[connect] ${url}`);
const ws = new WebSocket(url);
const pending = new Map(); // id -> resolve

function send(frame) {
  const s = JSON.stringify(frame);
  console.log(`[send] ${s.length > 300 ? s.slice(0, 300) + '…' : s}`);
  ws.send(s);
}

function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    pending.set(id, { resolve, reject });
    send({ type: 'req', id, method, params });
  });
}

ws.on('open', () => console.log('[open]'));

ws.on('message', async (raw) => {
  const ev = JSON.parse(raw.toString());
  if (ev.type === 'event' && ev.event === 'connect.challenge') {
    console.log(`[recv event] connect.challenge nonce=${ev.payload.nonce}`);
    const t0 = Date.now();
    const helloOk = await request('connect', {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: 'gateway-client', version: '0.0.1', platform: 'node', mode: 'backend' },
      auth: { token },
      role: 'operator',
      scopes: ['operator.write'],
    }).catch((e) => { console.error('[connect failed]', e); process.exit(1); });
    console.log(`[hello-ok] protocol=${helloOk.protocol} methods=${helloOk.features.methods.length} (${Date.now() - t0}ms)`);

    // Now call agent. Run it 3 times back-to-back to measure warm-session latency.
    for (let i = 1; i <= 3; i++) {
      const s = Date.now();
      const res = await request('agent', {
        agentId: 'main',
        message: `reply with exactly: r${i}`,
        sessionKey: 'agent:main:pocket',
        idempotencyKey: randomUUID(),
        timeout: 60000,
      });
      const text = res?.result?.meta?.finalAssistantVisibleText ?? '(none)';
      console.log(`[agent #${i}] ${Date.now() - s}ms — "${text}"`);
    }
    ws.close();
    process.exit(0);
    return;
  }

  if (ev.type === 'res') {
    const p = pending.get(ev.id);
    if (!p) { console.log(`[res unknown id] ${ev.id}`); return; }
    pending.delete(ev.id);
    if (ev.ok) p.resolve(ev.payload);
    else p.reject(new Error(ev.error?.message ?? 'rpc error'));
    return;
  }

  // Ignore other events (ticks, etc.)
  if (ev.type === 'event' && ev.event !== 'tick') {
    console.log(`[event] ${ev.event}`);
  }
});

ws.on('error', (e) => console.error('[ws error]', e.message));
ws.on('close', (c, r) => console.log(`[close] ${c} ${r?.toString()}`));

setTimeout(() => { console.log('[timeout]'); process.exit(2); }, 120000);
