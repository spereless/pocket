# Status

## Current Milestone
M3b — WebSocket bridge + full voice loop on real hardware

## In Progress
**Slices 2 + 4 are DONE. Next up: Slice 3 (orb UI).** The full voice loop works end-to-end on real hardware: user holds BOOT, speaks into the onboard mic, Grok transcribes correctly, Grok's reply plays smoothly through the onboard speaker. Verified today with phrase "What's the weather like in San Francisco today?" — transcribed exactly, reply was clean all the way through.

## Done in M3b

### Slice 1 — Bridge WS server + audio-IO refactor ✅
Unchanged from prior session. `bridge/device-ws.js`, `bridge/audio_io.js`, `bridge/voice.js`.

### Slice 2 — Firmware WS client ✅ (finally)
`firmware/pocket/main/bridge_ws.{c,h}`, `i2s_es8311_example.c`, `wifi.c`. WebSocket client on port 8789, I2S @ 24 kHz mono, PA gating in spk_task, Wi-Fi PS=NONE, WS keepalive ping 10 s.

### Slice 4 — PTT button ✅ (done ahead of Slice 3 — you can't sanely test without it)
BOOT (GPIO 0) gates mic uplink. Press → `{"action":"down"}` text frame → bridge clears xAI input buffer + interrupts. Release → `{"action":"up"}` → bridge commits + response.create. Server VAD disabled.

## Context / Gotchas from today

**The three bugs that blocked audio — in the order they bit:**

1. **Stack overflow** — mic_task/spk_task had 4 KB FreeRTOS stacks with a 4 KB `buf[CHUNK_BYTES]` declared on stack, clobbering list pointers → `vListInsert` null-deref on first `i2s_channel_read`. Fix: 8 KB stacks. Symptom was a LoadProhibited bootloop (EXCVADDR low address like 0x1e8).

2. **Stereo-slot duplication on mic** — Even with `I2S_SLOT_MODE_MONO` + slot_mask=LEFT, the driver reads *both* L and R slots on RX and the codec puts the mono mic signal on both. Result: every adjacent 16-bit pair is identical, byte rate is 2× expected. xAI interprets the stream as half-speed, transcribes mumbled garbage. Fix: **bridge-side dedup** — take every other 16-bit sample in `audio_io.js:dedupFromDevice`. MONO mode on the TX/spk side handles itself — **do not** double on output or you'll hear slow + choppy.

3. **Ring buffer too small for xAI's burst pacing** — xAI Realtime generates Grok's audio response faster than realtime (several seconds of content delivered in a short burst). The firmware's 96 KB rx ring overflowed mid-reply, dropping the tail → choppy end of sentence. Fix: **512 KB ring, allocated from PSRAM** via `xRingbufferCreateWithCaps(..., MALLOC_CAP_SPIRAM)`. PSRAM must be enabled in sdkconfig (OCT mode, 80 MHz) — previously the chip booted with internal SRAM only and the PSRAM malloc silently returned NULL.

**Mic gain sweet spot:** 12 dB (ES8311_MIC_GAIN_12DB). Below that (0–6 dB) the mic is inaudibly quiet; above (24–42 dB) loud speech clips hard. At 12 dB, normal conversational speech peaks around 30% of full-scale with RMS ~6–8%. Clean for xAI.

**Bridge instrumentation that saved us:**
- `/tmp/pocket_rx.pcm` — every device-mic byte written to disk for offline analysis
- Peak meter log every 2 s: `peak=NNNN (NN.N% of full-scale)` — makes clipping vs too-quiet obvious without plugging in ears
- `afplay /tmp/pocket_rx_24k.wav` on the Mac — lets us hear exactly what the device captured
These are staying in; they're cheap and invaluable for every future audio regression.

**Device not reconnecting after bridge restart** — was driving us crazy. Added `ping_interval_sec=10 / pingpong_timeout_sec=20` WS config to make the device detect dead bridges within ~30 s. Still not 100 % verified in the sense of being empirically reproduced post-fix, but no regressions observed and the Slice 3 UI will make it immediately visible if it breaks again.

**Mac IP:** `192.168.4.69` on en1 (Wi-Fi). Device IP: `192.168.4.86`.
**Bridge port:** 8789 (NOT 8787 — ghostload on 127.0.0.1 owns that).
**USB port:** `/dev/cu.usbmodem31101` currently. Port number renames after unplug/replug — if you can't find it, `ls /dev/cu.usbmodem*`.
**esptool + serial:** must use `/Users/jarvis/.espressif/python_env/idf5.3_py3.12_env/bin/python` explicitly (the `~/.idfshim` on PATH defeats the venv's bin dir and breaks `python -m esptool`).

**Stable dev flow:**
```
cd ~/Desktop/pocket
source firmware/activate-idf.sh                                    # once per shell
idf.py -C firmware/pocket build
idf.py -C firmware/pocket -p /dev/cu.usbmodem31101 flash
# In another terminal:
cd ~/Desktop/pocket/bridge && POCKET_MODE=device node voice.js
# Wait for [device-ws] connected: 192.168.4.86 — then hold BOOT + speak
```

## Next Action

**Slice 3 — orb UI (LVGL).** Port the SH8601 AMOLED panel init + LVGL setup from `firmware/lvgl-smoketest/main/example_qspi_with_ram.c`. Draw a single filled circle ~200 px radius, color-mapped to state (see `docs/orb-ui.md`). Add a FreeRTOS queue `ui_set_state(STATE)`; call from:
- `bridge_ws` connect/disconnect (connected/error)
- `button_task` down/up (listening when held)
- `spk_task` on first rx byte (speaking) and PA drop (idle)
- Bridge text frame `{"orb":"..."}` for thinking (no local signal for that one)

This is ~1.5–2 hours of focused LVGL work. Not trivial. Good breakpoint before starting if this session is already long.

After Slice 3: Slice 4.1 (screen tap → interrupt), Slice 5 (bridge state-event translation — mostly already wired via sendState hooks), Slice 6 (M3b final test + polish).
