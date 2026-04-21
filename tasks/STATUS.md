# Status

## Current Milestone
M3b — WebSocket bridge + full voice loop on real hardware

## In Progress
**Slice 2 (firmware WebSocket client) is in progress and flaky.** The firmware builds and flashes, and the device has successfully connected to the bridge and streamed PCM in prior test runs, but the connection flaps repeatedly under sustained audio and the current flashed state is not reliably reaching the bridge. Slice 1 (bridge side) is solid.

## Done in M3b so far

### Slice 1 — Bridge WS server + audio-IO refactor ✅

Files created/modified under `bridge/`:
- `device-ws.js` — WebSocketServer on port **8789** (NOT 8787 — that port is claimed by a `ghostload` process on 127.0.0.1). Single client. Binary = PCM16 @ 24kHz mono. Text = JSON control/state.
- `audio_io.js` — factory returns `createMacAudioIo` (default) or `createDeviceAudioIo` (when `POCKET_MODE=device`). Interface: `start / onChunk / play / endResponse / stopPlayback / stop / sendState`.
- `device_loopback.js` — throwaway test client: captures Mac mic and streams to bridge, plays received PCM on Mac speakers. Used to validate bridge plumbing without firmware.
- `voice.js` — refactored: no longer imports `record`/`Speaker` directly; delegates to `audio_io`. Mac mode is unchanged behavior, still the default.

**Test: PASSED** — ran `POCKET_MODE=device node voice.js` + `node device_loopback.js`, spoke into Mac mic → saw `[you speaking...]` → `[you] Hello?` → `[grok] Hello! How can I help you today?` → heard reply through Mac speakers via loopback. Byte counters climbed on both sides (`mic→bridge 581632 B`, `bridge→spk 117600 B`). Speaker buffer-underflow warnings in loopback are cosmetic (same M1 `speaker` lifecycle quirk, logged in lessons) — won't ship since firmware uses I2S not CoreAudio.

### Slice 2 — Firmware WS client ⚠️ FLAKY

Files created/modified under `firmware/pocket/main/`:
- `bridge_ws.{c,h}` — wraps `esp_websocket_client`. API: `bridge_ws_start / send_pcm / receive_pcm / last_rx_audio_us / connected`. Uses an 96 KB FreeRTOS ringbuf for rx PCM. Logs cumulative rx/tx bytes every 2s.
- `wifi.c` — added `esp_wifi_set_ps(WIFI_PS_NONE)` after `esp_wifi_start()` (power-save was preventing sustained uplink).
- `secrets.h` — added `POCKET_BRIDGE_URL "ws://192.168.4.69:8789"` (Mac Mini's en1 Wi-Fi IP — en0 Ethernet has the SAME IP but Ethernet↔Wi-Fi ARP bridging is unreliable. Mac and ESP32 both on Wi-Fi works.).
- `example_config.h` — `EXAMPLE_SAMPLE_RATE` 16000 → 24000; `EXAMPLE_MCLK_MULTIPLE` 384 → **256**. The 256× is required: ES8311 driver rejects MCLK=24000×384=9.216 MHz with ESP_ERR_INVALID_ARG.
- `i2s_es8311_example.c` — replaced record-then-play `i2s_echo` task with streaming `mic_task` (reads I2S → sends WS binary) + `spk_task` (drains WS rx → I2S write). 4096-byte chunks (~85 ms at 24 kHz mono — 1024 was too chatty, flooded xAI with small frames). PA (GPIO 46) hard-muted at boot; `spk_task` raises it on first incoming byte, drops after 500 ms of no rx. Mic task has a 1-second echo gate using `last_rx_audio_us`. Dead `err_reason[]` const and the `#if CONFIG_EXAMPLE_MODE_MUSIC` branch still present — music task no longer compiled but dead-code refactor was out of scope.
- `CMakeLists.txt` — added `bridge_ws.c`; PRIV_REQUIRES gained `esp_timer esp_ringbuf`.
- `idf_component.yml` — added `espressif/esp_websocket_client: "^1.2.0"`.

**Test results so far (automated, run by Claude):**
- Build clean
- Device boots, Wi-Fi connects at 192.168.4.86, RSSI -35 dBm, codec init OK
- First connect to bridge fails with `EHOSTUNREACH errno=119` for a few seconds while Wi-Fi finishes DHCP — auto-reconnect every 2s eventually succeeds
- With 1024-byte chunks: connection established, streamed ~40 KB then dropped, reconnect loop. After PS-disable: 400+ KB of sustained streaming before drop (big improvement).
- With 4096-byte chunks + send-backoff (**last flashed state**): not verified live — user ran `voice.js` in device mode and saw **zero device connections** in the bridge log during a ~10s window. Unknown whether device is crashed, off Wi-Fi, or in a reconnect spin.

**Known unverified:**
- Does the device now connect reliably with 4 KB chunks?
- Does downlink audio play on the onboard speaker?
- Does the 1-second echo gate actually prevent self-trigger feedback?

## Context / Gotchas

**Mac IP:** `192.168.4.69` on en1 (Wi-Fi). en0 (Ethernet) reports the same address but Ethernet↔Wi-Fi routing on the router is unreliable, so the device must talk to the Wi-Fi interface specifically.

**Bridge port:** 8789. Do NOT use 8787 (something called `ghostload` listens there on 127.0.0.1).

**Firewall:** macOS application firewall is ON. The earlier successful connections prove it doesn't block Node's WS server in practice, but if a fresh session sees "connection refused" from outside, check `socketfilterfw --getappblocked` for Node.

**The device has no button yet.** Mic is always-on whenever connected. This means:
- xAI's VAD fires on any sound, including ambient
- After a reply plays, speaker output leaks into the onboard mic and can re-trigger VAD. The 1-second echo gate after last rx audio is a crude fix; the real fix is Slice 4 (button-gated uplink only when user is speaking).
- Until Slice 4, testing should be in a quiet room and speak promptly after the device connects.

**Display:** unchanged and showing stale LVGL-smoketest content. The current firmware doesn't drive the AMOLED at all. This is Slice 3 (orb UI). Nothing's broken, just unrefreshed.

**Stable dev flow:**
```
cd ~/Desktop/pocket
source firmware/activate-idf.sh
idf.py -C firmware/pocket build
idf.py -C firmware/pocket -p /dev/cu.usbmodem31201 flash
# In a separate terminal:
cd ~/Desktop/pocket/bridge && POCKET_MODE=device node voice.js
# To read device serial programmatically (native-USB quirk — see lessons):
python -m esptool --chip esp32s3 -p /dev/cu.usbmodem31201 --after hard_reset run
# (then read from serial — see prior session for pyserial snippet)
```

## Next Action

**First step in a fresh session:** diagnose current device state before editing anything. In one terminal run the bridge (`POCKET_MODE=device node voice.js`). In another, capture device serial after a hard reset. Look for:
1. Does Wi-Fi connect? (expect `wifi: connected: ip=192.168.4.86`)
2. Does `bridge_ws` connect? (expect `bridge_ws: connected to ws://192.168.4.69:8789`)
3. Does the bridge see `[device-ws] connected: 192.168.4.86`?
4. Do rx/tx counters on both sides climb?

If the device never connects, check that the Mac's IP is still `192.168.4.69` on en1 (DHCP may have shuffled). If the connection establishes but flaps, the 4 KB chunk + backoff fix may need more tuning — next thing to try would be: send from mic_task via a FreeRTOS queue to a dedicated sender task, so mic reads don't block on network. Also worth trying: reduce xAI input rate further by accumulating ~100-200 ms of audio per `input_audio_buffer.append` call (buffer in voice.js between `audio.onChunk` and `sendAudioChunk`).

After Slice 2 is truly verified (user speaks, Grok's reply plays from onboard speaker), proceed to Slice 3 (LVGL orb UI per [docs/orb-ui.md](docs/orb-ui.md)), then Slice 4 (BOOT button + screen tap), Slice 5 (bridge state-event translation), Slice 6 (final M3b test).
