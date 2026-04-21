# Backlog

Ideas that arrived too early. Don't touch until v0 (M0–M4) is in daily use and earning its keep.

## Voice UX
- Wake-word ("hey pocket") via onboard mic so tap-to-talk isn't required
- Push-to-talk physical button (BOOT or PWM button remapped)
- Face-down or pocket-in gesture via IMU to mute the mic
- Voice-level visualizer on the orb (RMS amplitude drives scale)
- Multiple voices selectable per session (Eve / Ara / Leo / Rex / Sal)

## Bridge features
- Transcript history on the device — scroll back through the day's exchanges
- A second function tool if some category of question turns out badly through OpenClaw
- Web dashboard on `localhost:3000` showing live transcript + token usage
- Local STT/TTS fallback (Whisper + Piper) for when the LAN has no internet
- Prompt caching on the xAI session to cut cost/latency for repeated system instructions
- **Pair the bridge as an OpenClaw device** so `ask_openclaw` can talk to the gateway over a persistent WebSocket (like Telegram does) instead of spawning `openclaw gateway call agent` per request. Saves ~1–2s per tool call. Blocked on: `openclaw devices approve` pairing flow, storing a device id + private key in `bridge/.env`, and handling the signed-nonce connect handshake. Only worth doing after M3 when every ms matters for pocket feel.

## Device capabilities
- Multiple ESP32s (bedroom, kitchen) sharing the same bridge, each claiming the session exclusively
- Haptic-style buzz via the speaker for notification attention-grabs
- Display the current weather / time / last message when idle (ambient mode)

## Integrations
- Stock market alert voice-push ("NVDA just moved 3%") — original idea that kicked the project off
- Home Assistant voice control via an extra function tool
- A "show this on pocket" tool OpenClaw can call to push a visual (map, image, QR) to the device during a voice session

## Pre-voice-pivot ideas (superseded but archived)
These were the original v0 before the pivot to voice-first. Keep here in case any of them become useful alongside the voice UI later.
- Idle screen: time, next scheduled routine, "OpenClaw is…" status, last action summary
- Approval screen: when an agent task needs yes/no, device wakes, shows the ask, big Approve/Deny touch targets
- Briefs screen: rotating cards for a morning brief (weather, watchlist, calendar, unread-important)
- Scheduled morning brief at 7:30 pushing cards to the device
- Card-history scrollback of today's agent activity

## Someday, maybe
- iOS companion (only if leaving the house becomes a real use case)
- Cloud hosting of the bridge (only if this stops being a single-user project — it won't)
- Custom enclosure (only once the software is so good you want to hide the dev board)
- Consumer-product version (only if many people ask to buy one — they won't, and that's fine)

## References for future variants (not v0)
- `sipeed/picoclaw` — ultra-lightweight Go agent, interesting if you ever build a fully offline fallback
- `memovai/mimiclaw` — OpenClaw-style experience on a bare ESP32 in pure C, interesting if you ever want no-Mac operation
