# Lessons

## 2026-04-20 — `speaker` npm package: lazy-create per response

First pass of `voice.js` created one Speaker on `session.updated` and reused it forever. Between responses, CoreAudio's callback kept firing with no data → `buffer underflow` warnings flooded the console. Audio itself worked, but the logs were noise.

**Fix:** create a new `Speaker` on the first `response.output_audio.delta` of each response, call `.end()` on `response.done`, `.destroy()` on interruption. The Speaker instance only exists while audio is actively streaming.

**Rule:** treat `speaker` as a per-utterance stream, not a persistent device handle.

---

## 2026-04-20 — Don't scope a weekend project like a startup

First pass at Pocket ballooned into a consumer-hardware product plan: Raspberry Pi, Fly.io per-user cloud nodes, iOS companion app with BLE provisioning, Mender OTA, custom enclosure, pilot users, subscription pricing. None of it was needed. The user already has the Mac Mini running OpenClaw and already owns the ESP32-S3 AMOLED board — that's the whole project.

**The rule going forward:** if the build plan requires hardware you don't have, accounts you don't have, or users who don't exist, it's wrong for v0. Start from what's already on the desk.

**The check:** every time a new concept enters the plan, ask "does this exist physically or in code on the Mac Mini right now?" If no, it goes to backlog until v0 earns it.
