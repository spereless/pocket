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

### M3a: Audio loopback + Wi-Fi on device (no bridge)

Goal: prove the board can capture mic, play back through speaker, and connect to Wi-Fi. Zero network traffic to the bridge yet.

- [ ] Scaffold `firmware/pocket/` from Waveshare's `06_I2SCodec` demo as the audio base
- [ ] Confirm ES8311 init over I2C works (mic+speaker both live)
- [ ] Configure I2S full-duplex at 24kHz mono, 16-bit
- [ ] Plain loopback test: tap → capture 3s from mic → play back through speaker immediately
- [ ] Add Wi-Fi station mode (SSID/password from sdkconfig or NVS), reconnect on drop
- [ ] Print IP + signal strength over serial once connected
- **Test:** Power on, wait for "Wi-Fi connected [ip]" on serial. Tap or trigger → hear your own voice replayed from the onboard speaker cleanly.

### M3b: WebSocket bridge + full voice loop

Goal: board streams mic to bridge, bridge streams audio back, Grok answers audibly.

- [ ] Add LAN WebSocket server to `bridge/` (new file, separate from xAI client) — binary frames for PCM, JSON for orb state
- [ ] Replace Mac's mic/speaker (`sox`/`node-record-lpcm16`/`speaker`) in `voice.js` with the device's WebSocket as input/output
- [ ] Firmware WebSocket client: stream mic PCM → bridge, decode audio frames from bridge → I2S speaker
- [ ] Bridge forwards xAI state events (`speech_started`, `response.created`, `function_call.created`, `response.done`) to device as orb-state JSON
- [ ] Minimal LVGL orb: static circle whose color changes with orb-state JSON (animation comes later — M4 territory if at all)
- [ ] Tap via FT3168 to start/stop the session
- **Test:** Power on, orb idles. Tap → speak → Grok answers through onboard speaker. Wi-Fi drop + reconnect doesn't brick it. Works on USB power (battery is M4).

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
