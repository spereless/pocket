// LAN WebSocket server that the Pocket device (or the Slice-1 loopback client)
// connects to. Single client at a time.
//
// Frames:
//   binary  = PCM16 @ 24 kHz mono, little-endian
//             (device -> bridge = mic, bridge -> device = speaker)
//   text    = JSON control/state
//             (device -> bridge = input events like { kind: "button" } / { kind: "tap" })
//             (bridge -> device = orb state like { orb: "listening" })

import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';

const emitter = new EventEmitter();
let wss = null;
let client = null;

export function start(port = 8789) {
  if (wss) return;
  wss = new WebSocketServer({ port, host: '0.0.0.0' });
  console.log(`[device-ws] listening on 0.0.0.0:${port}`);
  wss.on('connection', (ws, req) => {
    if (client) {
      console.log('[device-ws] rejecting second client');
      try { ws.close(4000, 'already connected'); } catch {}
      return;
    }
    const addr = req.socket.remoteAddress;
    console.log(`[device-ws] connected: ${addr}`);
    client = ws;
    emitter.emit('connected', { addr });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        emitter.emit('pcm', data);
      } else {
        try {
          emitter.emit('control', JSON.parse(data.toString()));
        } catch (e) {
          console.error('[device-ws] bad JSON:', e.message);
        }
      }
    });
    ws.on('close', () => {
      if (client === ws) client = null;
      console.log('[device-ws] disconnected');
      emitter.emit('disconnected');
    });
    ws.on('error', (err) => console.error('[device-ws] ws error:', err.message));
  });
  wss.on('error', (err) => console.error('[device-ws] server error:', err.message));
}

export function stop() {
  try { client?.close(); } catch {}
  try { wss?.close(); } catch {}
  client = null;
  wss = null;
}

export function sendPcm(buf) {
  if (!client || client.readyState !== 1) return;
  try { client.send(buf, { binary: true }); } catch {}
}

export function sendState(obj) {
  if (!client || client.readyState !== 1) return;
  try { client.send(JSON.stringify(obj)); } catch {}
}

export function isConnected() {
  return !!client && client.readyState === 1;
}

export function on(event, cb) { emitter.on(event, cb); }
export function off(event, cb) { emitter.off(event, cb); }
