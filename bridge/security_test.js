import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import * as deviceWs from './device-ws.js';

const token = 'test-token-'.padEnd(64, 'x');
const server = deviceWs.start(0, { host: '127.0.0.1', token });
await once(server, 'listening');
const { port } = server.address();
const url = `ws://127.0.0.1:${port}`;

const unauthorizedStatus = await new Promise((resolve, reject) => {
  const ws = new WebSocket(url);
  ws.once('unexpected-response', (_request, response) => resolve(response.statusCode));
  ws.once('open', () => reject(new Error('unauthenticated client was accepted')));
  ws.once('error', () => {});
});
assert.equal(unauthorizedStatus, 401);

const authorized = new WebSocket(url, {
  headers: { Authorization: `Bearer ${token}` },
});
await once(authorized, 'open');
assert.equal(deviceWs.isConnected(), true);
authorized.close();
await once(authorized, 'close');

deviceWs.stop();
console.log('device WebSocket authentication: ok');
