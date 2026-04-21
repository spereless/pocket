# Backlog

Ideas that arrived too early. Don't touch until v0 (M0–M2) is in daily use and earning its keep.

## Device capabilities
- Voice push-to-talk via USB mic on the Mac (firmware side: button triggers streaming to bridge)
- Wake-word detection on the ESP32 using the onboard mic footprint (if present on this SKU — verify)
- Haptic-style buzz via the IMU + speaker for attention grabs
- Multiple ESP32 devices around the house (bedroom, kitchen) sharing the same bridge

## Bridge features
- Card history — scroll back through today's agent activity from the device
- Second scheduled routine (TBD — whichever one you actually want after M2)
- Per-category notifications with different priorities (Slack DM vs GitHub vs spam)
- Web dashboard on `localhost:3000` showing what's been sent to the device

## Integrations
- Stock market alert screen (the original idea that kicked this off — revisit after approvals work)
- Home Assistant read-only tiles
- A "quick pocket tool" OpenClaw can call: "show this on the device for me"

## Someday, maybe
- iOS companion (only if leaving the house with the device becomes a real use case)
- Cloud hosting (only if it stops being a single-user project)
- Custom enclosure (only once the software is so good you want to hide the dev board)
- Consumer-product version (only if many people ask to buy one — they won't, and that's fine)

## References for future variants (not v0)
- `sipeed/picoclaw` — ultra-lightweight Go agent, interesting if you ever build a fully offline fallback
- `memovai/mimiclaw` — OpenClaw-style experience on a bare ESP32 in pure C, interesting if you ever want no-Mac operation
