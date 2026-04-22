// Persistent WebSocket client to the OpenClaw gateway.
//
// Replaces the per-request `spawn('openclaw gateway call agent ...')` subprocess
// in voice.js: ~10 s CLI startup + full WS handshake on every turn becomes one
// handshake at bridge boot, then ~1-2 s per agent turn over the live socket.
//
// Reuses the CLI's already-paired device identity from ~/.openclaw/identity/.
// That file holds an ed25519 keypair + a bootstrap-approved operator token
// with `operator.admin` scope, which the `agent` method requires. The gateway
// accepts multiple simultaneous connections from the same device, so the CLI
// and this bridge don't conflict.
//
// Protocol reference reverse-engineered from
//   ~/.npm-global/lib/node_modules/openclaw/dist/client-DkWAat_P.js
//   ~/.npm-global/lib/node_modules/openclaw/dist/device-identity-TBOlRcQx.js
// v3 device-auth payload format: v3|deviceId|clientId|clientMode|role|scopes
//                                 |signedAtMs|token|nonce|platform|deviceFamily

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_IDENTITY_DIR = path.join(os.homedir(), '.openclaw', 'identity');

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function b64url(buf) {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/* Strip the SPKI wrapper so we're left with the 32-byte raw ed25519 public
 * key, which is what the gateway's verifier expects in `device.publicKey`. */
function rawPublicKey(pem) {
  const spki = crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
  if (spki.length === ED25519_SPKI_PREFIX.length + 32 &&
      spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function loadIdentity(identityDir) {
  const idPath = path.join(identityDir, 'device.json');
  const authPath = path.join(identityDir, 'device-auth.json');
  if (!fs.existsSync(idPath)) {
    throw new Error(`openclaw device identity not found at ${idPath}. Run the openclaw CLI once to generate it.`);
  }
  const identity = JSON.parse(fs.readFileSync(idPath, 'utf8'));
  let token = null;
  let scopes = null;
  if (fs.existsSync(authPath)) {
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    const op = auth?.tokens?.operator;
    if (op?.token) { token = op.token; scopes = op.scopes; }
  }
  return { identity, token, scopes };
}

function buildAuthPayloadV3({ deviceId, clientId, clientMode, role, scopes, signedAtMs, token, nonce, platform, deviceFamily }) {
  return [
    'v3',
    deviceId,
    clientId,
    clientMode,
    role,
    scopes.join(','),
    String(signedAtMs),
    token ?? '',
    nonce,
    platform ?? '',
    deviceFamily ?? '',
  ].join('|');
}

function signEd25519(privateKeyPem, payload) {
  const key = crypto.createPrivateKey(privateKeyPem);
  return b64url(crypto.sign(null, Buffer.from(payload, 'utf8'), key));
}

class GatewayError extends Error {
  constructor({ code, message, details }) {
    super(message ?? code ?? 'gateway error');
    this.code = code;
    this.details = details;
  }
}

export class OpenclawClient extends EventEmitter {
  constructor({
    url = 'ws://127.0.0.1:18789',
    role = 'operator',
    identityDir = DEFAULT_IDENTITY_DIR,
    scopes,
    /* Must be a value the gateway recognises (see GATEWAY_CLIENT_IDS).
     * "gateway-client" is the generic backend identifier. */
    clientId = 'gateway-client',
    clientDisplayName = 'pocket-bridge',
  } = {}) {
    super();
    this.url = url;
    this.role = role;
    this.clientId = clientId;
    this.clientDisplayName = clientDisplayName;
    const loaded = loadIdentity(identityDir);
    this.identity = loaded.identity;
    this.token = loaded.token;
    /* Default scopes match what the CLI itself claims. Agent requires
     * operator.write at minimum; operator.admin is what we already have. */
    this.scopes = scopes ?? loaded.scopes ?? ['operator.read', 'operator.write', 'operator.admin'];

    this.ws = null;
    this.ready = false;
    this.nonce = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stopped = false;
    this.backoffMs = 1000;
  }

  start() {
    if (this.stopped) return;
    this.ready = false;
    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      this.scheduleReconnect(err);
      return;
    }
    this.ws.on('message', (raw) => this.onMessage(raw));
    this.ws.on('error', (err) => this.emit('error', err));
    this.ws.on('close', (code, reason) => {
      const r = reason?.toString?.() ?? '';
      this.ready = false;
      /* Reject every in-flight request so callers don't hang. */
      for (const [id, p] of this.pending) {
        clearTimeout(p.timeout);
        p.reject(new Error(`openclaw socket closed (${code}${r ? ': ' + r : ''})`));
        this.pending.delete(id);
      }
      this.emit('disconnected', { code, reason: r });
      this.scheduleReconnect();
    });
  }

  scheduleReconnect(err) {
    if (this.stopped) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 15000);
    if (err) console.error(`[openclaw] reconnect in ${delay}ms: ${err.message || err}`);
    setTimeout(() => this.start(), delay);
  }

  stop() {
    this.stopped = true;
    try { this.ws?.close(); } catch {}
  }

  onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      const nonce = msg.payload?.nonce;
      if (typeof nonce !== 'string' || nonce.trim().length === 0) {
        this.emit('error', new Error('gateway connect challenge missing nonce'));
        try { this.ws.close(1008, 'bad challenge'); } catch {}
        return;
      }
      this.nonce = nonce.trim();
      this.sendConnect();
      return;
    }
    if (msg.type === 'res') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      const status = msg.payload?.status;
      /* For long-running methods (agent) the server first acks with
       * status="accepted". We ignore that and keep waiting for the real
       * response, which carries the same id. */
      if (pending.expectFinal && status === 'accepted') return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timeout);
      if (msg.ok) pending.resolve(msg.payload);
      else pending.reject(new GatewayError(msg.error ?? {}));
      return;
    }
    /* Events (tick, bridge push, etc.) — emit for anyone curious. */
    if (msg.type === 'event') this.emit('event', msg);
  }

  sendConnect() {
    const signedAtMs = Date.now();
    const platform = process.platform;
    const payload = buildAuthPayloadV3({
      deviceId: this.identity.deviceId,
      clientId: this.clientId,
      clientMode: 'backend',
      role: this.role,
      scopes: this.scopes,
      signedAtMs,
      token: this.token ?? '',
      nonce: this.nonce,
      platform,
      deviceFamily: '',
    });
    const signature = signEd25519(this.identity.privateKeyPem, payload);
    const device = {
      id: this.identity.deviceId,
      publicKey: b64url(rawPublicKey(this.identity.publicKeyPem)),
      signature,
      signedAt: signedAtMs,
      nonce: this.nonce,
    };
    const auth = this.token
      ? { token: this.token, deviceToken: this.token }
      : undefined;
    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: this.clientId, displayName: this.clientDisplayName, version: '0.1.0', platform, mode: 'backend' },
      role: this.role,
      scopes: this.scopes,
      auth,
      device,
    };
    this.request('connect', params, { timeoutMs: 10000 }).then((helloOk) => {
      /* Server may rotate our token on connect; pick up the new one. */
      const newToken = helloOk?.auth?.deviceToken;
      if (newToken && newToken !== this.token) this.token = newToken;
      this.ready = true;
      this.backoffMs = 1000;
      console.log(`[openclaw] connected (protocol=${helloOk.protocol}, role=${helloOk.auth?.role}, scopes=${(helloOk.auth?.scopes ?? []).join(',')})`);
      this.emit('ready', helloOk);
    }).catch((err) => {
      console.error(`[openclaw] connect failed: ${err.message ?? err}`);
      try { this.ws.close(1008, 'connect failed'); } catch {}
    });
  }

  /* Send a gateway `req` frame and return a promise for its `res` payload.
   * `expectFinal`: ignore the interim `{status:"accepted"}` and wait for the
   * real payload (used by `agent`). `signal`: AbortSignal to cancel client-side
   * (the protocol has no generic server-side cancel; we just drop the pending
   * entry so the stale result is discarded when it arrives). */
  request(method, params = {}, { expectFinal = false, timeoutMs = 60000, signal } = {}) {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`openclaw ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, expectFinal, timeout });
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(new Error('aborted'));
          return;
        }
        const onAbort = () => {
          const p = this.pending.get(id);
          if (!p) return;
          clearTimeout(p.timeout);
          this.pending.delete(id);
          reject(new Error('aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        this.ws.send(JSON.stringify({ type: 'req', id, method, params }));
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /* Convenience: run one agent turn and return the final visible text.
   * Returns null if the payload doesn't contain any usable text. */
  async askAgent(prompt, { sessionKey = 'agent:main:pocket', agentId = 'main', timeoutMs = 90000, signal } = {}) {
    if (!this.ready) throw new Error('openclaw not connected');
    const payload = await this.request('agent', {
      agentId,
      message: prompt,
      sessionKey,
      idempotencyKey: crypto.randomUUID(),
    }, { expectFinal: true, timeoutMs, signal });
    /* Mirror the CLI's extraction chain; see lessons.md:104. */
    return (
      payload?.result?.meta?.finalAssistantVisibleText
      ?? payload?.result?.meta?.finalAssistantRawText
      ?? payload?.result?.payloads?.[0]?.text
      ?? payload?.meta?.finalAssistantVisibleText
      ?? null
    );
  }
}
