# Pocket

A small, always-on companion surface for the OpenClaw agent already running on the Mac Mini. Uses the Waveshare ESP32-S3 1.8" AMOLED board (already owned) as a glance-and-tap device on the same LAN.

**What it is:** a pocketable screen + button for the agent that lives on the Mac. Shows what the agent is doing, surfaces approvals, displays scheduled briefs. Taps flow back to OpenClaw.

**What it is not:** a product. Not a startup. No cloud, no iOS app, no enclosure, no OTA, no pilot users, no subscription. Single user, LAN-only, one device, one Mac.

**Why bother:** today, when OpenClaw needs your attention (an email drafted, a task finished, a decision needed), you have to open the laptop to see it. Pocket closes that loop on a small screen you can glance at without switching context.

---

## v0 scope

Three screens on the ESP32:

1. **Idle** — time, next scheduled routine, "OpenClaw is…" status, last action summary.
2. **Approval** — when an agent task needs yes/no, device wakes, shows the ask, big Approve/Deny touch targets.
3. **Briefs** — rotating cards for a morning brief routine (weather, watchlist, calendar, unread-important).

Two pieces of software:

- **`bridge/`** — tiny Node service on the Mac Mini that sits next to OpenClaw, relays events to the ESP32 over a LAN WebSocket, and exposes approval responses back to OpenClaw (integration path TBD in M0).
- **`firmware/`** — ESP32-S3 firmware (Arduino or ESP-IDF + LVGL). WebSocket client, three-screen state machine, touch input, brightness/IMU-wake.

**Deploy:** `pm2 restart pocket-bridge` on the Mac. `esptool flash` on the ESP32.

---

## Out of scope for v0

Voice, wake-word, iOS app, cloud hosting, multi-user, per-device auth, OTA updates, custom enclosure, battery, HomeKit/Matter, skills marketplace. Earn each of these by actually using v0 for a week first.

---

## Success criteria

- You use it unprompted at least 3 days in the first week after it works.
- At least one OpenClaw outbound action this month gets approved/denied from the ESP32 instead of the laptop.
- Morning brief lands on the device by 7:30 daily without you triggering it.

If none of these are true after two weeks, Pocket is the wrong idea — don't keep building.
