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
  };
}

function createDeviceAudioIo({ sampleRate, port }) {
  let chunkCb = null;
  let rxBytes = 0, txBytes = 0, rxLastReport = Date.now();
  deviceWs.start(port);
  deviceWs.on('pcm', (buf) => {
    rxBytes += buf.length;
    const now = Date.now();
    if (now - rxLastReport > 2000) {
      console.log(`[audio-io] rx ${rxBytes} B  tx ${txBytes} B (cumulative)`);
      rxLastReport = now;
    }
    chunkCb?.(buf);
  });
  deviceWs.on('connected', () => console.log('[audio-io] device connected'));
  deviceWs.on('disconnected', () => console.log('[audio-io] device disconnected'));

  return {
    start() {
      console.log(`[audio-io] awaiting device on ws://0.0.0.0:${port} (pcm16 @ ${sampleRate} Hz mono)`);
    },
    onChunk(cb) { chunkCb = cb; },
    play(pcm) { txBytes += pcm.length; deviceWs.sendPcm(pcm); },
    endResponse() { /* device plays whatever it has; orb-state will handle UX later */ },
    stopPlayback() { /* no bridge-side buffer to drop */ },
    stop() { deviceWs.stop(); },
    sendState(obj) { deviceWs.sendState(obj); },
  };
}
