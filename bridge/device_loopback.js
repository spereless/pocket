// Slice-1 test client. Pretends to be the ESP32:
//   - captures Mac mic, streams PCM16 binary frames to the bridge
//   - plays bridge-sent PCM16 binary frames on Mac speaker
//   - logs JSON control frames (orb state, etc.) to stdout
//
// Usage:
//   Terminal 1:  POCKET_MODE=device node voice.js
//   Terminal 2:  POCKET_DEVICE_TOKEN=<same-token> node device_loopback.js
//
// Speak into the Mac mic -> bridge -> xAI -> reply -> this client's speaker.
// Slice 1 passes when that loop sounds like M1 did.

import WebSocket from 'ws';
import record from 'node-record-lpcm16';
import { spawn } from 'node:child_process';

const URL = process.env.POCKET_BRIDGE_URL ?? 'ws://127.0.0.1:8789';
const SAMPLE_RATE = 24000;
const DEVICE_TOKEN = process.env.POCKET_DEVICE_TOKEN;

if (!DEVICE_TOKEN || DEVICE_TOKEN.length < 32) {
  console.error('POCKET_DEVICE_TOKEN must be set to at least 32 characters');
  process.exit(1);
}

const ws = new WebSocket(URL, {
  headers: { Authorization: `Bearer ${DEVICE_TOKEN}` },
});
let mic = null;
let speaker = null;

function startSpeaker() {
  const proc = spawn('play', [
    '-q', '-t', 'raw', '-r', String(SAMPLE_RATE), '-e', 'signed-integer',
    '-b', '16', '-c', '1', '-L', '-',
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  proc.on('error', (err) => console.error('[loopback speaker]', err.message));
  proc.stderr.on('data', (data) => console.error('[loopback speaker]', data.toString().trim()));
  proc.stdin.on('error', () => {});
  return proc;
}

let micBytes = 0, spkBytes = 0, lastReport = Date.now();

ws.on('open', () => {
  console.log(`[loopback] connected to ${URL}`);
  speaker = startSpeaker();
  mic = record.record({ sampleRate: SAMPLE_RATE, channels: 1, audioType: 'raw', recorder: 'sox' });
  mic.stream().on('data', (chunk) => {
    micBytes += chunk.length;
    const now = Date.now();
    if (now - lastReport > 2000) {
      console.log(`[loopback] mic→bridge ${micBytes} B  bridge→spk ${spkBytes} B`);
      lastReport = now;
    }
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(chunk, { binary: true }); } catch {}
    }
  });
  mic.stream().on('error', (err) => console.error('[loopback mic]', err.message));
});

ws.on('message', (data, isBinary) => {
  if (isBinary) {
    spkBytes += data.length;
    try { speaker?.stdin.write(data); } catch {}
  } else {
    console.log(`[loopback] state: ${data.toString()}`);
  }
});

ws.on('close', () => { console.log('[loopback] closed'); shutdown(); });
ws.on('error', (err) => { console.error('[loopback ws]', err.message); shutdown(); });

function shutdown() {
  try { mic?.stop(); } catch {}
  try { speaker?.kill('SIGTERM'); } catch {}
  try { ws?.close(); } catch {}
  setTimeout(() => process.exit(0), 100);
}

process.on('SIGINT', () => { console.log('\n[loopback shutdown]'); shutdown(); });
process.on('SIGTERM', shutdown);
