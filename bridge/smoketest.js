import 'dotenv/config';
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_RATE = 24000;

const prompt = process.argv.slice(2).join(' ') || 'Hello! Say one short sentence.';

if (!process.env.XAI_API_KEY || !process.env.XAI_API_KEY.startsWith('xai-')) {
  console.error('XAI_API_KEY missing or malformed. Paste it into bridge/.env');
  process.exit(1);
}

const audioChunks = [];
let doneReceived = false;
let sessionUpdated = false;

const ws = new WebSocket('wss://api.x.ai/v1/realtime', {
  headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` },
});

const timeout = setTimeout(() => {
  console.error('\nTimeout: no response.done in 60s.');
  ws.close();
  process.exit(2);
}, 60_000);

ws.on('open', () => {
  console.log('[open] connected to xAI Realtime');
  ws.send(JSON.stringify({
    type: 'session.update',
    session: {
      voice: 'Eve',
      instructions: 'Answer concisely in one or two short sentences.',
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
      console.log(`[session.created] id=${event.session.id} model=${event.session.model}`);
      break;

    case 'session.updated':
      if (sessionUpdated) break;
      sessionUpdated = true;
      console.log(`[session.updated] sending prompt: ${JSON.stringify(prompt)}`);
      ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: prompt }],
        },
      }));
      ws.send(JSON.stringify({ type: 'response.create' }));
      break;

    case 'response.output_audio.delta':
      audioChunks.push(Buffer.from(event.delta, 'base64'));
      process.stdout.write('.');
      break;

    case 'response.output_audio_transcript.done':
      console.log(`\n[transcript] ${event.transcript}`);
      break;

    case 'response.done':
      doneReceived = true;
      console.log(`[response.done] tokens: ${event.response?.usage?.total_tokens ?? '?'}`);
      finish();
      break;

    case 'error':
      console.error(`\n[error] ${event.code ?? '?'}: ${event.message ?? JSON.stringify(event)}`);
      clearTimeout(timeout);
      ws.close();
      process.exit(3);
  }
});

ws.on('error', (err) => {
  console.error(`[ws error] ${err.message}`);
  clearTimeout(timeout);
  process.exit(4);
});

ws.on('close', () => {
  if (!doneReceived) console.error('[ws close] before response.done');
});

function finish() {
  clearTimeout(timeout);
  const pcm = Buffer.concat(audioChunks);
  if (pcm.length === 0) {
    console.error('No audio received.');
    ws.close();
    process.exit(5);
  }
  const wav = wrapWav(pcm, SAMPLE_RATE);
  const outPath = join(HERE, 'out.wav');
  writeFileSync(outPath, wav);
  const seconds = pcm.length / (SAMPLE_RATE * 2);
  console.log(`[saved] ${outPath} (${(wav.length / 1024).toFixed(1)} KB, ${seconds.toFixed(2)}s)`);
  ws.close();
  process.exit(0);
}

function wrapWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  const dataLen = pcm.length;
  header.write('RIFF', 0);
  header.writeUInt32LE(dataLen + 36, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcm]);
}
