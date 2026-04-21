# Status

## Current Milestone
M3a — Audio loopback + Wi-Fi on device (no bridge yet)

## In Progress
M3 bootstrap is complete: ESP-IDF toolchain installed, Waveshare's reference demo built and flashed, AMOLED screen confirmed lit. That's the "whole pipeline works on this Mac and this board" proof. Next real code step is scaffolding `firmware/pocket/` from Waveshare's `06_I2SCodec` audio demo and getting mic → speaker loopback running on the device.

## Done this session
- Verified Mac sees the board at `/dev/cu.usbmodem31201` (no driver needed — ESP32-S3 native USB)
- Installed ESP-IDF v5.3.2 under `~/esp/esp-idf` + toolchain under `~/.espressif`
- Worked around Python 3.9 dep-check bug via `~/.idfshim/python3 → python3.12` (see lessons.md)
- Wrote `firmware/activate-idf.sh` — sourced to enter an IDF shell cleanly
- Installed `cmake` + `ninja` via Homebrew
- Cloned Waveshare's reference repo and copied `05_LVGL_WITH_RAM` to `firmware/lvgl-smoketest/`
- Built it (~5 min, pulled display/LVGL components from Espressif component registry)
- Flashed via `idf.py -p /dev/cu.usbmodem31201 flash` — board reset, AMOLED lit up with demo content
- Split M3 into M3a (on-device loopback + Wi-Fi) and M3b (WebSocket to bridge + full voice loop) so each has a testable endpoint

## Context

**Architecture (still the plan):**
```
[ESP32-S3 + mic/speaker/orb]  ←WiFi WebSocket→  [Bridge on Mac Mini]
                                                       ↕
                                                [xAI Realtime] ↔ [openclaw gateway call agent]
```

**Dev workflow from here:**
```
cd ~/Desktop/pocket
source firmware/activate-idf.sh           # sets PATH, env, IDF_PATH
idf.py -C firmware/<project> set-target esp32s3   # once per project
idf.py -C firmware/<project> build
idf.py -C firmware/<project> -p /dev/cu.usbmodem31201 flash monitor
```

**Known-good reference:** `firmware/lvgl-smoketest/` — Waveshare's `05_LVGL_WITH_RAM` sample, unmodified. Keep it around as a sanity-check baseline if things break mysteriously later — rebuild/reflash it to isolate board-vs-code issues.

**Waveshare repo cloned to `/tmp/ws-amoled-peek`** (shallow clone, not committed). For M3a we want their `examples/ESP-IDF-v5.3.2/06_I2SCodec/` as the starting point. Copy it to `firmware/pocket/` when we're ready to start modifying code. Don't commit the whole Waveshare repo — just the files we fork from it.

**Biggest risks for M3a (in order):**
1. Waveshare's I2SCodec demo probably plays a bundled audio file, not mic loopback. We'll have to adapt it to capture from the onboard mic and route straight back to the speaker.
2. Wi-Fi credentials — board has to know the SSID/password. Easiest path: ESP-IDF `menuconfig` → Example Connection Configuration. Skip NVS provisioning until M4.
3. I2S full-duplex on ES8311 — needs both RX and TX channels on the same I2S peripheral. The demo may only configure TX. This is the one thing most likely to eat a chunk of time.

## Next Action

Copy `/tmp/ws-amoled-peek/examples/ESP-IDF-v5.3.2/06_I2SCodec/` to `firmware/pocket/`. Build it as-is and flash it to confirm the speaker plays the bundled audio. Only then start modifying — first change is mic-to-speaker loopback. Don't add Wi-Fi until audio works (one variable at a time).
