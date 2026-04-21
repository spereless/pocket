import 'dotenv/config';
import WebSocket from 'ws';
import record from 'node-record-lpcm16';
import Speaker from 'speaker';
import { Buffer } from 'node:buffer';

const SAMPLE_RATE = 24000;

if (!process.env.XAI_API_KEY?.startsWith('xai-')) {
  console.error('XAI_API_KEY missing or malformed. Paste it into bridge/.env');
  process.exit(1);
}

let ws = null;
let mic = null;
let speaker = null;
let sessionReady = false;

const micBuffer = [];
let bufferedBytes = 0;
const MAX_BUFFER_BYTES = SAMPLE_RATE * 2 * 10;

function makeSpeaker() {
  return new Speaker({ channels: 1, bitDepth: 16, sampleRate: SAMPLE_RATE });
}

function interrupt() {
  if (speaker) {
    try { speaker.destroy(); } catch {}
    speaker = null;
  }
  try {
    ws?.send(JSON.stringify({ type: 'response.cancel' }));
  } catch {}
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

function startMic() {
  mic = record.record({
    sampleRate: SAMPLE_RATE,
    channels: 1,
    audioType: 'raw',
    recorder: 'sox',
  });
  mic.stream().on('data', (chunk) => {
    if (sessionReady) {
      sendAudioChunk(chunk);
    } else if (bufferedBytes + chunk.length <= MAX_BUFFER_BYTES) {
      micBuffer.push(chunk);
      bufferedBytes += chunk.length;
    }
  });
  mic.stream().on('error', (err) => console.error('[mic error]', err.message));
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
        instructions: 'You are Pocket, a voice companion. Keep answers short and conversational.',
        turn_detection: { type: 'server_vad' },
        input_audio_transcription: { model: 'grok-2-audio' },
        audio: {
          input:  { format: { type: 'audio/pcm', rate: SAMPLE_RATE } },
          output: { format: { type: 'audio/pcm', rate: SAMPLE_RATE } },
        },
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
        process.stdout.write('\n[you speaking...] ');
        interrupt();
        break;

      case 'conversation.item.input_audio_transcription.completed':
        console.log(`\n[you] ${event.transcript}`);
        break;

      case 'response.output_audio.delta': {
        if (!speaker) speaker = makeSpeaker();
        const pcm = Buffer.from(event.delta, 'base64');
        try { speaker.write(pcm); } catch {}
        break;
      }

      case 'response.output_audio_transcript.done':
        console.log(`[grok] ${event.transcript}`);
        break;

      case 'response.done':
        if (speaker) {
          try { speaker.end(); } catch {}
          speaker = null;
        }
        break;

      case 'error':
        console.error(`\n[error] ${event.code ?? '?'}: ${event.message ?? JSON.stringify(event)}`);
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
  try { mic?.stop(); } catch {}
  try { speaker?.destroy(); } catch {}
  try { ws?.close(); } catch {}
  setTimeout(() => process.exit(0), 150);
}

process.on('SIGINT', () => { console.log('\n[shutdown]'); shutdown(); });
process.on('SIGTERM', shutdown);

startMic();
connect();
