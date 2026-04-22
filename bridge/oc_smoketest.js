// Smoke-test the persistent OpenClaw client. Compares latency vs the
// spawn-based CLI path we had in voice.js.
//
//   node oc_smoketest.js "how many files in my nightly brainstorms folder?"

import { OpenclawClient } from './openclaw_client.js';

const prompt = process.argv.slice(2).join(' ') || 'say hi in five words';
const oc = new OpenclawClient();

oc.on('error', (e) => console.error('[oc] error:', e.message));
oc.on('disconnected', (d) => console.log('[oc] disconnected:', d));

const tStart = Date.now();
oc.once('ready', async () => {
  console.log(`[oc] ready in ${Date.now() - tStart}ms`);
  const t0 = Date.now();
  try {
    const reply = await oc.askAgent(prompt, { timeoutMs: 60000 });
    console.log(`[oc] agent replied in ${Date.now() - t0}ms`);
    console.log('---');
    console.log(reply);
    console.log('---');
  } catch (err) {
    console.error('[oc] agent error:', err.message);
  } finally {
    oc.stop();
    process.exit(0);
  }
});

oc.start();
