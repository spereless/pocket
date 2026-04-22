import 'dotenv/config';
import WebSocket from 'ws';
import { Buffer } from 'node:buffer';
import { createAudioIo } from './audio_io.js';
import { OpenclawClient } from './openclaw_client.js';

const SAMPLE_RATE = 24000;
const OPENCLAW_TIMEOUT_MS = 90_000;
const OPENCLAW_AGENT = 'main';
const OPENCLAW_SESSION_KEY = 'agent:main:pocket';

/* Persistent gateway connection: one handshake at bridge boot, then every
 * ask_openclaw turn goes over the same socket. Replaces the `spawn openclaw
 * gateway call agent` subprocess which cost ~10 s per turn. */
const openclaw = new OpenclawClient();
openclaw.on('ready', () => console.log('[openclaw] ready'));
openclaw.on('error', (err) => console.error('[openclaw] error:', err.message ?? err));
openclaw.on('disconnected', ({ code, reason }) => console.warn(`[openclaw] disconnected code=${code} reason=${reason}`));
openclaw.start();

if (!process.env.XAI_API_KEY?.startsWith('xai-')) {
  console.error('XAI_API_KEY missing or malformed. Paste it into bridge/.env');
  process.exit(1);
}

let ws = null;
let sessionReady = false;
const audio = createAudioIo({ sampleRate: SAMPLE_RATE });

// Tool-call state. xAI Realtime uses a two-response pattern: the tool-call
// response must close (response.done) before we may send response.create to
// let Grok speak the tool result. Track both signals per call_id.
const pendingToolCalls = new Map(); // call_id -> { outputSent, turnClosed, replyRequested }

const micBuffer = [];
let bufferedBytes = 0;
const MAX_BUFFER_BYTES = SAMPLE_RATE * 2 * 10;

let micOpen = false;        /* PTT: only forward mic chunks to xAI while held */
let uplinkBytes = 0;        /* bytes of audio sent during the current PTT press */
let responseActive = false; /* true between response.created and response.done */
let currentOrbState = null; /* dedupe repeated sendState calls */
let speakingThisResponse = false;

function setOrb(name) {
  if (currentOrbState === name) return;
  currentOrbState = name;
  audio.sendState?.({ orb: name });
}

async function askOpenclaw(prompt, { signal } = {}) {
  if (!openclaw.ready) return 'Error: OpenClaw gateway is not connected.';
  try {
    const text = await openclaw.askAgent(prompt, {
      agentId: OPENCLAW_AGENT,
      sessionKey: OPENCLAW_SESSION_KEY,
      timeoutMs: OPENCLAW_TIMEOUT_MS,
      signal,
    });
    if (typeof text === 'string' && text.length > 0) return text;
    return 'Error: openclaw returned no assistant text.';
  } catch (err) {
    if (err?.message === 'aborted') throw err;  /* let caller distinguish cancel */
    return `Error: openclaw call failed (${err?.message ?? err}).`;
  }
}

function maybeRequestReply(callId) {
  const state = pendingToolCalls.get(callId);
  if (!state) return;
  if (state.outputSent && state.turnClosed && !state.replyRequested) {
    state.replyRequested = true;
    console.log(`[ask_openclaw] requesting grok reply for ${callId}`);
    try { ws.send(JSON.stringify({ type: 'response.create' })); } catch {}
    pendingToolCalls.delete(callId);
  }
}

let activeToolCallId = null;
let activeToolAbort = null;

function cancelActiveTool(reason) {
  if (!activeToolCallId) return;
  console.log(`[ask_openclaw] cancel ${activeToolCallId} (${reason})`);
  try { activeToolAbort?.abort(); } catch {}
  pendingToolCalls.delete(activeToolCallId);
  activeToolCallId = null;
  activeToolAbort = null;
}

async function handleFunctionCall(callId, name, argsJson) {
  if (name !== 'ask_openclaw') {
    console.error(`[tool] unknown function: ${name}`);
    return;
  }
  let prompt;
  try {
    prompt = JSON.parse(argsJson).prompt;
  } catch {
    prompt = '';
  }
  if (!prompt) {
    sendFunctionOutput(callId, 'Error: no prompt provided.');
    return;
  }
  // Supersede any older in-flight call.
  if (activeToolCallId && activeToolCallId !== callId) {
    cancelActiveTool('superseded by newer call');
  }
  const abort = new AbortController();
  activeToolCallId = callId;
  activeToolAbort = abort;
  console.log(`[ask_openclaw] prompt: ${JSON.stringify(prompt)}`);
  let answer;
  try {
    answer = await askOpenclaw(prompt, { signal: abort.signal });
  } catch (err) {
    if (err?.message === 'aborted') {
      console.log(`[ask_openclaw] aborted ${callId}`);
      return;
    }
    answer = `Error: ${err?.message ?? err}`;
  }
  // If we were superseded/cancelled while running, drop the result.
  if (activeToolCallId !== callId) {
    console.log(`[ask_openclaw] dropping stale result for ${callId}`);
    return;
  }
  activeToolAbort = null;
  activeToolCallId = null;
  console.log(`[ask_openclaw] answer: ${JSON.stringify(answer.slice(0, 200))}${answer.length > 200 ? '…' : ''}`);
  sendFunctionOutput(callId, answer);
}

function sendFunctionOutput(callId, output) {
  try {
    ws.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output },
    }));
  } catch {}
  const state = pendingToolCalls.get(callId) ?? { outputSent: false, turnClosed: false, replyRequested: false };
  state.outputSent = true;
  pendingToolCalls.set(callId, state);
  maybeRequestReply(callId);
}

function interrupt() {
  audio.stopPlayback();
  cancelActiveTool('user interrupted');
  if (responseActive) {
    try { ws?.send(JSON.stringify({ type: 'response.cancel' })); } catch {}
    responseActive = false;
  }
}

function sendAudioChunk(pcm) {
  try {
    ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: pcm.toString('base64'),
    }));
  } catch {}
}

function flushMicBuffer() {
  for (const chunk of micBuffer) sendAudioChunk(chunk);
  micBuffer.length = 0;
  bufferedBytes = 0;
}

function startAudio() {
  audio.onChunk((chunk) => {
    if (!micOpen) return;            /* PTT closed -> drop mic chunk */
    if (sessionReady) {
      sendAudioChunk(chunk);
      uplinkBytes += chunk.length;
    } else if (bufferedBytes + chunk.length <= MAX_BUFFER_BYTES) {
      micBuffer.push(chunk);
      bufferedBytes += chunk.length;
    }
  });
  audio.onControl?.(handleDeviceControl);
  audio.start();
}

function handleDeviceControl(msg) {
  if (msg?.kind !== 'button') return;
  if (msg.action === 'down') {
    console.log('[ptt] down');
    micOpen = true;
    uplinkBytes = 0;
    interrupt();    /* stop any in-flight Grok reply, cancel any tool call */
    try { ws?.send(JSON.stringify({ type: 'input_audio_buffer.clear' })); } catch {}
    setOrb('listening');
  } else if (msg.action === 'up') {
    console.log(`[ptt] up (${uplinkBytes} B uplinked)`);
    micOpen = false;
    if (!sessionReady) return;
    if (uplinkBytes < SAMPLE_RATE * 2 * 0.2) {   /* <200 ms of audio: ignore tap */
      console.log('[ptt] ignored (too short)');
      try { ws?.send(JSON.stringify({ type: 'input_audio_buffer.clear' })); } catch {}
      /* Reset the orb — firmware optimistically went to 'thinking' on release. */
      setOrb('idle');
      return;
    }
    try {
      ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      ws.send(JSON.stringify({ type: 'response.create' }));
    } catch {}
  }
}

function connect() {
  ws = new WebSocket('wss://api.x.ai/v1/realtime', {
    headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` },
  });

  ws.on('open', () => {
    console.log('[open] connected to xAI Realtime');
    ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        voice: 'Eve',
        instructions:
          'You are Pocket, a voice companion. Keep answers short and conversational. ' +
          'For anything about the user\'s email, calendar, files, tasks, messages, or personal context, ' +
          'you MUST call the ask_openclaw function and pass the user\'s question as the prompt. ' +
          'Do not answer personal-data questions from your own knowledge — OpenClaw has the user\'s real data. ' +
          'For general knowledge, math, definitions, or chit-chat, answer directly without calling any tool.',
        turn_detection: null,   /* PTT: device commits via button:up control frame */
        input_audio_transcription: { model: 'grok-2-audio' },
        audio: {
          input:  { format: { type: 'audio/pcm', rate: SAMPLE_RATE } },
          output: { format: { type: 'audio/pcm', rate: SAMPLE_RATE } },
        },
        tools: [
          {
            type: 'function',
            name: 'ask_openclaw',
            description:
              'Ask the user\'s OpenClaw agent for anything involving their real personal data: ' +
              'emails, calendar events, files, tasks, messages, contacts, or memory. ' +
              'Pass the user\'s question verbatim as the prompt. Returns a string answer to read aloud.',
            parameters: {
              type: 'object',
              properties: {
                prompt: {
                  type: 'string',
                  description: 'The user\'s question, rephrased as a clear instruction for OpenClaw.',
                },
              },
              required: ['prompt'],
            },
          },
        ],
        tool_choice: 'auto',
      },
    }));
  });

  ws.on('message', (raw) => {
    const event = JSON.parse(raw.toString());
    switch (event.type) {
      case 'session.created':
        console.log(`[session.created] ${event.session.id}`);
        break;

      case 'session.updated':
        if (sessionReady) break;
        sessionReady = true;
        console.log('[ready] speak now — Ctrl-C to exit');
        flushMicBuffer();
        break;

      case 'input_audio_buffer.speech_started':
        /* PTT mode: ignored (interrupt is driven by button:down). */
        break;

      case 'response.created':
        responseActive = true;
        speakingThisResponse = false;
        setOrb('thinking');
        break;

      case 'conversation.item.input_audio_transcription.completed':
        console.log(`\n[you] ${event.transcript}`);
        break;

      case 'response.output_audio.delta': {
        if (!speakingThisResponse) {
          speakingThisResponse = true;
          setOrb('speaking');
        }
        const pcm = Buffer.from(event.delta, 'base64');
        audio.play(pcm);
        break;
      }

      case 'response.output_audio_transcript.done':
        console.log(`[grok] ${event.transcript}`);
        break;

      case 'response.function_call_arguments.done':
        console.log(`[tool] ${event.name}(${event.arguments}) call_id=${event.call_id}`);
        pendingToolCalls.set(event.call_id, { outputSent: false, turnClosed: false, replyRequested: false });
        handleFunctionCall(event.call_id, event.name, event.arguments);
        break;

      case 'response.done': {
        responseActive = false;
        audio.endResponse();
        /* Do NOT send orb=idle here. xAI emits response.done as soon as it
         * finishes generating, but the device is still draining several
         * seconds of buffered PCM from its PSRAM ring. The device's spk_task
         * flips to idle when its PA actually drops — that's the real end.
         * (The firmware's 10s thinking-timeout catches the case where we
         * never entered speaking at all.) */
        // If this response was a tool-call turn, mark its calls as turnClosed
        // and try to drive the reply. A turn can contain multiple function_call items.
        const items = event.response?.output ?? [];
        for (const item of items) {
          if (item.type === 'function_call' && item.call_id) {
            const state = pendingToolCalls.get(item.call_id);
            if (state) {
              state.turnClosed = true;
              maybeRequestReply(item.call_id);
            }
          }
        }
        break;
      }

      case 'error':
        console.error(`\n[error] ${event.code ?? '?'}: ${event.message ?? JSON.stringify(event)}`);
        setOrb('error');
        setTimeout(() => {
          if (currentOrbState === 'error') setOrb('idle');
        }, 3000);
        break;
    }
  });

  ws.on('error', (err) => console.error('[ws error]', err.message));
  ws.on('close', () => {
    console.log('[ws closed]');
    shutdown();
  });
}

function shutdown() {
  try { audio.stop(); } catch {}
  try { ws?.close(); } catch {}
  setTimeout(() => process.exit(0), 150);
}

process.on('SIGINT', () => { console.log('\n[shutdown]'); shutdown(); });
process.on('SIGTERM', shutdown);

startAudio();
connect();
