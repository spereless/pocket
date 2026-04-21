// Audio I/O abstraction for voice.js.
// Two implementations, same interface. The factory picks based on POCKET_MODE.
//
// Interface:
//   start()              begin capturing (mic) or await device connect
//   onChunk(cb)          register PCM16 mic-chunk callback
//   play(pcm)            send a PCM chunk to the output
//   endResponse()        signal end of current assistant response (flush speaker in Mac mode)
//   stopPlayback()       immediately stop playback (interrupt)
//   stop()               shutdown
//   sendState(obj)       push orb-state JSON (device mode only; no-op on Mac)

import record from 'node-record-lpcm16';
import Speaker from 'speaker';
import fs from 'node:fs';
import * as deviceWs from './device-ws.js';

export function createAudioIo({ sampleRate, port = 8789 } = {}) {
  const mode = process.env.POCKET_MODE === 'device' ? 'device' : 'mac';
  console.log(`[audio-io] mode=${mode}`);
  if (mode === 'device') return createDeviceAudioIo({ sampleRate, port });
  return createMacAudioIo({ sampleRate });
}

function createMacAudioIo({ sampleRate }) {
  let mic = null;
  let speaker = null;
  let chunkCb = null;

  return {
    start() {
      mic = record.record({ sampleRate, channels: 1, audioType: 'raw', recorder: 'sox' });
      mic.stream().on('data', (c) => chunkCb?.(c));
      mic.stream().on('error', (err) => console.error('[mic]', err.message));
    },
    onChunk(cb) { chunkCb = cb; },
    play(pcm) {
      if (!speaker) speaker = new Speaker({ channels: 1, bitDepth: 16, sampleRate });
      try { speaker.write(pcm); } catch {}
    },
    endResponse() {
      if (speaker) {
        try { speaker.end(); } catch {}
        speaker = null;
      }
    },
    stopPlayback() {
      if (speaker) {
        try { speaker.destroy(); } catch {}
        speaker = null;
      }
    },
    stop() {
      try { mic?.stop(); } catch {}
      this.stopPlayback();
    },
    sendState() { /* no-op in Mac mode */ },
    onControl() { /* no-op in Mac mode */ },
  };
}

/* The device's I2S is reading both L and R slots of each PHILIPS stereo frame
 * even though we configured MONO mode. Both slots carry the same mono mic
 * signal, so every odd 16-bit sample is a duplicate of the even one, and the
 * byte rate is exactly 2x what 24 kHz mono should be (96 kB/s instead of 48).
 *
 *   mic (device -> xAI): drop every other sample (L only), halving byte count
 *   spk (xAI -> device): duplicate each sample (goes into both L and R), doubling byte count
 *
 * Result: xAI sees clean 24 kHz, device sees the 2x-rate stream it expects.
 */
function dedupFromDevice(buf) {
  const n = buf.length / 2;          /* 16-bit samples in */
  const half = Math.floor(n / 2);    /* samples out (drop R slot) */
  const out = Buffer.alloc(half * 2);
  for (let i = 0; i < half; i++) {
    out[i * 2]     = buf[i * 4];
    out[i * 2 + 1] = buf[i * 4 + 1];
  }
  return out;
}

/* No spk-side transform: ESP-IDF I2S driver's MONO mode on tx writes the
 * incoming mono sample to both L and R slots of the PHILIPS frame itself.
 * Duplicating at the bridge layered on top of that, making playback 2x slow. */

function createDeviceAudioIo({ sampleRate, port }) {
  let chunkCb = null;
  let controlCb = null;
  let rxBytes = 0, txBytes = 0, rxLastReport = Date.now();
  /* Debug: write all received PCM to /tmp/pocket_rx.pcm so we can listen to it. */
  const rxFile = fs.createWriteStream('/tmp/pocket_rx.pcm');
  let peakSinceReport = 0;
  deviceWs.start(port);
  deviceWs.on('pcm', (rawBuf) => {
    const buf = dedupFromDevice(rawBuf);
    rxBytes += buf.length;
    rxFile.write(buf);
    /* Track peak amplitude (PCM16 LE) to know if mic is too hot or too quiet. */
    for (let i = 0; i + 1 < buf.length; i += 2) {
      const s = buf.readInt16LE(i);
      const a = s < 0 ? -s : s;
      if (a > peakSinceReport) peakSinceReport = a;
    }
    const now = Date.now();
    if (now - rxLastReport > 2000) {
      const pct = ((peakSinceReport / 32768) * 100).toFixed(1);
      console.log(`[audio-io] rx ${rxBytes} B  tx ${txBytes} B  peak=${peakSinceReport} (${pct}% of full-scale)`);
      rxLastReport = now;
      peakSinceReport = 0;
    }
    chunkCb?.(buf);
  });
  deviceWs.on('control', (msg) => controlCb?.(msg));
  deviceWs.on('connected', () => console.log('[audio-io] device connected'));
  deviceWs.on('disconnected', () => console.log('[audio-io] device disconnected'));

  return {
    start() {
      console.log(`[audio-io] awaiting device on ws://0.0.0.0:${port} (pcm16 @ ${sampleRate} Hz mono)`);
    },
    onChunk(cb) { chunkCb = cb; },
    onControl(cb) { controlCb = cb; },
    play(pcm) {
      txBytes += pcm.length;
      deviceWs.sendPcm(pcm);
    },
    endResponse() { /* device plays whatever it has; orb-state will handle UX later */ },
    stopPlayback() { /* no bridge-side buffer to drop */ },
    stop() { deviceWs.stop(); },
    sendState(obj) { deviceWs.sendState(obj); },
  };
}
