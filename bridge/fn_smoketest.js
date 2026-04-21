import 'dotenv/config';
import WebSocket from 'ws';

const SAMPLE_RATE = 24000;
const PROMPT = process.argv.slice(2).join(' ') || 'What time is it in Tokyo right now?';

if (!process.env.XAI_API_KEY?.startsWith('xai-')) {
  console.error('XAI_API_KEY missing or malformed. Paste it into bridge/.env');
  process.exit(1);
}

const ws = new WebSocket('wss://api.x.ai/v1/realtime', {
  headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` },
});

const timeout = setTimeout(() => {
  console.error('\n[timeout] no response.done in 45s');
  ws.close();
  process.exit(2);
}, 45_000);

let sessionUpdated = false;
let outputSent = false;
let replyCreated = false;

ws.on('open', () => {
  console.log('[open] connected');
  ws.send(JSON.stringify({
    type: 'session.update',
    session: {
      voice: 'Eve',
      instructions:
        'You are a test harness. When the user asks the current time in any city, you MUST call the get_time function. Do not answer from your own knowledge.',
      turn_detection: { type: 'server_vad' },
      input_audio_transcription: { model: 'grok-2-audio' },
      audio: {
        input:  { format: { type: 'audio/pcm', rate: SAMPLE_RATE } },
        output: { format: { type: 'audio/pcm', rate: SAMPLE_RATE } },
      },
      tools: [
        {
          type: 'function',
          name: 'get_time',
          description: 'Return the current local time in a given city.',
          parameters: {
            type: 'object',
            properties: {
              location: { type: 'string', description: 'City name, e.g. Tokyo' },
            },
            required: ['location'],
          },
        },
      ],
      tool_choice: 'auto',
    },
  }));
});

ws.on('message', (raw) => {
  const event = JSON.parse(raw.toString());

  // Log everything except audio deltas (too noisy). Print the whole event so we
  // can see every field name.
  if (event.type !== 'response.output_audio.delta') {
    console.log(`\n[event] ${event.type}`);
    const copy = { ...event };
    delete copy.type;
    console.log(JSON.stringify(copy, null, 2));
  }

  if (event.type === 'session.updated' && !sessionUpdated) {
    sessionUpdated = true;
    console.log(`\n[send] user prompt: ${JSON.stringify(PROMPT)}`);
    ws.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: PROMPT }],
      },
    }));
    ws.send(JSON.stringify({ type: 'response.create' }));
    return;
  }

  if (event.type === 'response.function_call_arguments.done') {
    console.log(`\n[function_call detected] name=${event.name} call_id=${event.call_id}`);
    console.log(`[function_call args] ${event.arguments}`);
    const fakeOutput = JSON.stringify({ time: '14:37', tz: 'JST' });
    console.log(`[send] function_call_output: ${fakeOutput}`);
    ws.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: event.call_id,
        output: fakeOutput,
      },
    }));
    outputSent = true;
    return;
  }

  if (event.type === 'response.done') {
    if (outputSent && !replyCreated) {
      console.log('[note] tool-call turn closed — sending response.create for assistant reply');
      ws.send(JSON.stringify({ type: 'response.create' }));
      replyCreated = true;
      return;
    }
    console.log('[note] final response.done — exiting');
    clearTimeout(timeout);
    setTimeout(() => { ws.close(); process.exit(0); }, 200);
  }

  if (event.type === 'error') {
    clearTimeout(timeout);
    setTimeout(() => { ws.close(); process.exit(3); }, 200);
  }
});

ws.on('error', (err) => {
  console.error(`[ws error] ${err.message}`);
  clearTimeout(timeout);
  process.exit(4);
});
