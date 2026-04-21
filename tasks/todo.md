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

## M2: `ask_openclaw` function tool

Wire OpenClaw in as the actual agent. Grok routes, OpenClaw answers.

- [ ] Add `function` tool `ask_openclaw(prompt: string)` to `session.update`
- [ ] System instruction: "For anything about the user's email, calendar, files, tasks, or personal context, call ask_openclaw. Otherwise answer from your own knowledge."
- [ ] On `response.function_call_arguments.done`: spawn OpenClaw CLI with the prompt, capture stdout, return via `conversation.item.create` with `function_call_output`
- [ ] Send `response.create` to let Grok continue with the tool output
- [ ] Handle CLI errors (nonzero exit, timeout > 30s) — return the error string so Grok can explain it to the user
- **Test:** Ask "what emails did I get today?" — Grok calls ask_openclaw → OpenClaw returns real data → Grok speaks it. Same question in Telegram returns the same facts.

## M3: ESP32 firmware — I2S audio + orb + WebSocket

The actual pocket device. Big milestone; split if it gets unwieldy.

- [ ] ESP-IDF project scaffold based on Waveshare's AMOLED-1.8 demo (start from their reference, not from scratch)
- [ ] Wi-Fi station mode with stored creds; reconnect on drop
- [ ] ES8311 init over I2C; I2S peripheral configured full-duplex 24kHz 16-bit mono
- [ ] WebSocket client to the bridge; binary frames for PCM, JSON frames for orb state
- [ ] LVGL orb: one animated sphere that scales/glows based on `{idle, listening, speaking, thinking}`
- [ ] Tap input via FT3168: tap anywhere toggles session start/stop
- [ ] Mic → bridge streaming; bridge → speaker playback
- [ ] Bridge forwards xAI state events (`speech_started`, `response.created`, `function_call.created`, `response.done`) to device as orb-state JSON
- **Test:** Power on, orb idles. Tap → listening, speak → thinking → speaking, Grok answers audibly through the onboard speaker. Walk across the house; Wi-Fi reconnects cleanly. Works on USB power.

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
