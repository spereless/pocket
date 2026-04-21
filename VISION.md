# Pocket

A pocketable, always-on voice companion for the OpenClaw agent already running on the Mac Mini. Uses the Waveshare ESP32-S3 1.8" AMOLED (already owned, onboard mic + speaker + battery) as a handheld device on the LAN.

**What it is:** a small object you carry around. Tap to talk, speak naturally, get answers out loud. Under the hood, xAI's Grok handles realtime voice (STT + LLM + TTS + VAD + interruption) and delegates agent work to OpenClaw via a single function tool. A ChatGPT-style animated orb lives on the AMOLED.

**What it is not:** a product. No startup, no iOS app, no enclosure, no multi-user, no OTA, no cloud backend of our own. Single user, single device, single Mac, single cloud API (xAI).

**Why bother:** today OpenClaw is reached via Telegram — tethered to the phone, thumb-driven, not hands-free. Pocket makes the agent an object you can hold and talk to while doing something else.

---

## v0 scope

**Hardware:** Waveshare ESP32-S3-Touch-AMOLED-1.8. Onboard mic, speaker, ES8311 codec, AXP2101 PMIC, Li-ion header, 8MB PSRAM, Wi-Fi, touch, IMU. Self-contained — no add-ons needed.

**Device UI:** a single screen — a ChatGPT-style animated orb on black. State drives the animation: idle (still), listening (user speaking), speaking (assistant speaking), thinking (waiting on a tool call). Tap anywhere to start or stop a session.

**Software:**

- **`bridge/`** — Node service on the Mac Mini. Two WebSockets: one to the device over LAN (carries audio frames + orb state), one to xAI Realtime over WAN (carries Grok voice). Registers a single function tool, `ask_openclaw(prompt)`, which shells to the OpenClaw CLI and returns the result as the function output.
- **`firmware/`** — ESP32-S3 firmware (ESP-IDF + LVGL). Captures I2S audio from the onboard mic via ES8311, streams it to the bridge. Plays PCM received from the bridge through the onboard speaker. Renders the orb. Manages Wi-Fi, reconnect, and tap input.

**Deploy:** `pm2 restart pocket-bridge` on the Mac · `idf.py flash` on the ESP32.

---

## Architecture

```
[ESP32-S3 + mic/speaker/orb]  ←WiFi WebSocket→  [Bridge on Mac Mini]
                                                       ↕
                                                [xAI Realtime]
                                                       ↕
                                                ask_openclaw(prompt)
                                                       ↕
                                                [OpenClaw CLI]
```

The bridge is the brain-broker: it holds the xAI API key, runs OpenClaw invocations on the Mac where OpenClaw lives, and relays audio + orb state between device and cloud. The device is a dumb microphone/speaker/display on the LAN.

---

## Out of scope for v0

- Wake-word (tap-to-talk only; earn wake-word later if tap friction is real)
- iOS app, multi-device, multi-user, per-device auth
- OTA updates, cloud hosting of the bridge
- Custom enclosure (the dev board is the enclosure)
- Scheduled routines, morning briefs, card history, transcript UI — all from the old glance-and-tap vision, now in backlog
- Any function tool beyond `ask_openclaw`

---

## Success criteria

- You use Pocket daily for a week without going back to Telegram for OpenClaw.
- At least one real agent task completed fully by voice (no laptop, no phone) in that week.
- Latency feels conversational — you don't stop using it because the wait is annoying.

If none of these are true after two weeks, Pocket is the wrong idea — stop building and go back to Telegram.
