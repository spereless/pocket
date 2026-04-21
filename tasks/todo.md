# Pocket

Pocket voice agent on the ESP32-S3 AMOLED. Grok handles voice (xAI Realtime), OpenClaw handles agent work (via `ask_openclaw` function tool).

**Stack:** Node (Mac bridge) + xAI Realtime WebSocket + ESP-IDF/LVGL firmware
**Deploy:** `pm2 restart pocket-bridge` on the Mac · `idf.py flash` on the ESP32

## v0 Scope
- Bridge on Mac Mini: xAI Realtime client, LAN WebSocket server for the device, one function tool wired to the OpenClaw CLI
- ESP32 firmware: I2S mic/speaker via ES8311, WebSocket client, orb UI, tap-to-talk
- One end-to-end path: tap → speak → Grok answers (or calls ask_openclaw → OpenClaw answers → Grok speaks it)

## Not v0 (go to backlog.md if tempted)
- Wake-word, multi-device, iOS app, OTA
- Scheduled routines (morning brief, etc.)
- Card history, transcript display, non-voice UI
- Custom enclosure, deep battery optimization
- Multiple function tools beyond ask_openclaw
- Anything not on the path tap → speak → answer

---

## M0: xAI Realtime — text loop on the bridge ✅

Prove the API works. No audio capture yet.

- [x] Confirm xAI API key with Voice endpoint enabled (console.x.ai → API Keys)
- [x] `bridge/` scaffold: Node project, `ws` + `dotenv`, `.env` with `XAI_API_KEY`, `.gitignore` the env
- [x] `bridge/smoketest.js`: connect to `wss://api.x.ai/v1/realtime`, send `session.update` with voice + `input_audio_transcription`
- [x] Send a text message via `conversation.item.create` + `response.create`
- [x] Log every event type received; accumulate `response.output_audio.delta` chunks into a WAV file
- **Test: PASSED** — `node smoketest.js "Say hello from Pocket..."` wrote `out.wav` (1.47s), played back Grok (voice: Eve) saying "Hello from Pocket!"

## M1: Voice loop on the Mac ✅

Prove the full voice pipeline using the Mac's own mic/speakers. Firmware still untouched.

- [x] Mic capture: `node-record-lpcm16` + `sox` (`brew install sox`) at 24kHz 16-bit mono
- [x] Speaker playback: `speaker` npm package at 24kHz
- [x] Stream mic PCM → base64 → `input_audio_buffer.append`
- [x] On `response.output_audio.delta`: decode base64 → write to speaker
- [x] Handle `input_audio_buffer.speech_started`: destroy speaker, send `response.cancel`
- [x] Graceful shutdown on Ctrl-C (stop mic, close WS, end speaker)
- [x] Lazy-create speaker per response (fixes CoreAudio buffer-underflow warnings)
- **Test: PASSED** — `node voice.js`, spoke to Mac, Grok (Eve) answered through Mac speakers, interruption worked, no audio artifacts.

## M2: `ask_openclaw` function tool ✅

Wire OpenClaw in as the actual agent. Grok routes, OpenClaw answers.

- [x] Add `function` tool `ask_openclaw(prompt: string)` to `session.update`
- [x] System instruction: route personal-data questions to `ask_openclaw`, answer everything else directly
- [x] Handle `response.function_call_arguments.done`: spawn OpenClaw, capture stdout, return `function_call_output`
- [x] **Deferred `response.create`**: only fire after the tool-call turn's own `response.done`, otherwise Grok never speaks the result (see lessons.md)
- [x] Use `openclaw gateway call agent --expect-final --json` with stable `sessionKey: agent:main:pocket` for session warmth + ~2× speedup over `openclaw agent`
- [x] Parse `result.meta.finalAssistantVisibleText` with fallbacks to `.finalAssistantRawText` and `.payloads[0].text`
- [x] Error handling: nonzero exit, timeout, JSON parse fail all return a readable error string for Grok to speak
- [x] Cancel in-flight tool calls on user interrupt or when superseded by a newer call (SIGKILL subprocess, drop stale result)
- **Test: PASSED** — asked "how many nightly brainstorms do I have?" → ask_openclaw fired → OpenClaw returned "11 files Apr 8–18" → Grok spoke it. Math questions stayed direct. Supersede/cancel proven by rephrase mid-question (only the final answer was spoken).

## M3: ESP32 firmware — split into M3a / M3b

**Toolchain ready (done):** ESP-IDF v5.3.2 at `~/esp/esp-idf`, Python-3.12 shim at `~/.idfshim`, activation via `source firmware/activate-idf.sh`. Verified by building + flashing Waveshare's `05_LVGL_WITH_RAM` demo — screen lit up with their LVGL content. `firmware/lvgl-smoketest/` holds that build as a known-working reference.

### M3a: Audio loopback + Wi-Fi on device (no bridge) ✅

Goal: prove the board can capture mic, play back through speaker, and connect to Wi-Fi. Zero network traffic to the bridge yet.

- [x] Scaffold `firmware/pocket/` from Waveshare's `06_I2SCodec` demo as the audio base
- [x] Confirm ES8311 init over I2C works (mic+speaker both live) — I2C 14/15, I2S MCK 16/BCK 9/WS 45/DO 8/DI 10, PA 46 all match ESP-BOX defaults
- [x] Configure I2S — currently 16kHz stereo-16 per Espressif demo; bump to 24kHz mono in M3b when we match xAI's PCM format
- [x] ~~Plain loopback test~~ → replaced with **record-then-play** (feedback-safe): capture 3s with PA gated off, then play buffer with PA on. Live loopback squealed on onboard mic/speaker (see lessons.md)
- [x] Add Wi-Fi station mode (creds in gitignored `main/secrets.h`), reconnect on disconnect event
- [x] Print IP + signal strength over serial once connected
- **Test: PASSED** — on boot, serial shows `wifi: connected: ip=192.168.4.86 rssi=-36 dBm ssid=PerelessWifi`. Record-then-play cycle captures clean mic audio and plays it back through the onboard speaker at volume 80, mic gain 24dB. Audio task currently `#if 0`'d in app_main to keep the board silent between sessions — re-enable when starting M3b.

### M3b: WebSocket bridge + full voice loop

Goal: board streams mic to bridge, bridge streams audio back, Grok answers audibly.
Broken into 6 slices, each independently testable. See STATUS.md for current progress.

**Slice 1 — Bridge WS server + audio-IO refactor ✅**
- [x] `bridge/device-ws.js` — WS server on port 8789, single client, binary = PCM16 @ 24 kHz mono
- [x] `bridge/audio_io.js` — MacAudioIo / DeviceAudioIo behind `POCKET_MODE` env flag
- [x] `bridge/device_loopback.js` — test client proving bridge plumbing before firmware
- [x] `bridge/voice.js` — refactored to use the audio_io abstraction
- **Test: PASSED** — `POCKET_MODE=device node voice.js` + `node device_loopback.js`, Mac→bridge→xAI→bridge→Mac loop sounded like M1

**Slice 2 — Firmware WebSocket client ⚠️ FLAKY**
- [x] Bump I2S to 24 kHz mono (match xAI's PCM format); MCLK_MULTIPLE = 256 (384 fails for ES8311)
- [x] `firmware/pocket/main/bridge_ws.{c,h}` — esp_websocket_client wrapper with 96 KB rx ringbuf
- [x] `secrets.h` gains `POCKET_BRIDGE_URL`
- [x] Disable Wi-Fi power-save (PS=NONE) for sustained uplink
- [x] Replace record-then-play with continuous `mic_task` + `spk_task`. 4 KB chunks (~85 ms). PA gated off when no rx. 1 s echo gate.
- [ ] Live verify: user speaks into onboard mic → Grok reply plays from onboard speaker, no connection flap over a full session
- **Test:** connection holds for ≥30 s under continuous streaming; user's question is transcribed on the bridge; reply is audible from the onboard speaker

**Slice 3 — Orb UI (LVGL)**
- [ ] Single filled circle, ~200 px radius, centered on AMOLED
- [ ] Color per state per `docs/orb-ui.md` (`#1a1a3a` / `#00d8ff` / `#ffb020` / `#f0f0ff` / `#ff3030`)
- [ ] Bridge sends `{ "orb": "..." }` JSON — firmware parses text frames and updates a FreeRTOS queue the LVGL task drains
- [ ] Clears the stale LVGL-smoketest content that's currently stuck on the panel
- **Test:** bridge-driven state changes visibly update the orb color with no obvious flicker

**Slice 4 — Inputs**
- [ ] Read BOOT button (GPIO 0) via ISR + debouncer; edge = session toggle. Send `{"kind":"button"}` to bridge.
- [ ] FT3168 touch event on screen = interrupt. Send `{"kind":"tap"}` to bridge.
- [ ] Firmware-local optimistic transitions match `docs/orb-ui.md` (button → listening; button again → thinking; tap during speaking → idle).
- [ ] Gate mic uplink so it only streams during `listening`.
- **Test:** button press flips orb to cyan and starts mic uplink; press again stops mic; tap during reply cancels playback and returns to idle

**Slice 5 — Bridge state translation**
- [ ] voice.js maps xAI events → `audio.sendState({orb: "..."})`: speech_started→listening, response.created→thinking, first output_audio.delta→speaking, response.done→idle, response.error→error (transient)
- [ ] On Wi-Fi/bridge-WS lost events (server side knows via `disconnected` event), no-op — device handles those locally as error/persistent
- **Test:** orb color sequence during a full voice turn goes idle → listening → thinking → speaking → idle

**Slice 6 — Full test + polish**
- [ ] Full M3b Test (see below) passes cleanly
- [ ] Log any lessons. Decide what (if anything) to promote into M4.
- **Test:** Power on, orb idles. Press BOOT → speak → Grok answers through onboard speaker. Wi-Fi drop + reconnect doesn't brick it. Works on USB power (battery is M4).

## M4: Portable polish

Make it actually pocketable for daily use.

- [ ] Li-ion cell connected via MX1.25; verify charging over USB-C via AXP2101
- [ ] Screen dim + CPU idle after 30s of no session
- [ ] IMU tap-to-wake (don't require a screen touch when device is in a pocket)
- [ ] Low-battery indicator on the orb when < 20%
- **Test:** Fully charge, unplug USB, use for a full day (≥5 sessions spread out). Battery survives, device stays responsive.

---

## After M4 (not milestones yet — review with user before promoting)

- Wake-word (only if tap friction becomes the real limiter)
- Transcript scrollback (re-read what was said earlier in the day)
- A second function tool if OpenClaw turns out to be the wrong answer for some category
- Face-down mute gesture via IMU
