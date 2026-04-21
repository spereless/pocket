# Pocket

ESP32-S3 AMOLED companion for OpenClaw running on the Mac Mini. Weekend-sized.

**Stack:** Node (Mac sidecar) + WebSocket on LAN + ESP32-S3 firmware with LVGL
**Deploy:** `pm2 restart pocket-bridge` on the Mac · `esptool flash` on the ESP32

## v0 Scope
- Idle screen, Approval screen, Briefs screen
- Mac sidecar that relays OpenClaw events → ESP32 and approval responses → OpenClaw
- One scheduled routine (morning brief) that pushes cards to the device

## Not v0 (go to backlog.md if tempted)
- Voice, wake-word, iOS app
- Cloud hosting, multi-user, per-device auth, OTA
- Custom enclosure, battery, HomeKit/Matter
- More than one ESP32 device
- Fancy memory / analytics / dashboards

---

## M0: Understand OpenClaw on this Mac

The most important hour of the project. Everything after depends on it.

- [ ] Find the OpenClaw install on the Mac Mini (ask user for path; likely a cloned repo or global npm)
- [ ] Skim its README + `docs/` to learn how it exposes events, hooks, or tools — answer these three:
  1. How does an outbound action (send email, etc.) get gated today? Is there an approval hook or does it just run?
  2. Can we register a custom tool/skill/plugin that OpenClaw will call (e.g. a `pocket.approve(...)` tool)?
  3. Does OpenClaw emit events anywhere (log file, SQLite, IPC, webhooks) that a sidecar could subscribe to?
- [ ] Write findings to `docs/openclaw-integration.md` — one page, concrete, with file paths and code references
- [ ] Pick the integration strategy (plugin / webhook / tool-call / log-tail) and note it in STATUS.md
- **Test:** You can describe in one paragraph exactly how a pending approval will get from OpenClaw to the bridge, and a tap-response from the bridge back to OpenClaw.

## M1: Bridge stub + ESP32 idle screen

End-to-end skeleton, no real OpenClaw integration yet.

- [ ] `bridge/`: Node project with `ws` server, a fake-event injector (`curl -X POST /fake-approval`), and a handler for device responses that just logs them
- [ ] `bridge/` runs under pm2 on the Mac Mini
- [ ] `firmware/`: ESP32-S3 project (Arduino-ESP32 + LVGL is the fastest path given Waveshare has demos for this exact board)
- [ ] Device connects to LAN Wi-Fi, opens WebSocket to the bridge, shows an idle screen (clock + "Connected to OpenClaw" + last-event line)
- [ ] Reconnect logic on the device (Wi-Fi drops, bridge restart)
- **Test:** Power on device → shows idle with current time → `curl` a fake approval → device renders it → tap Approve → bridge logs "approved: <id>".

## M2: Real OpenClaw integration + one useful routine

- [ ] Implement the integration strategy from M0 — the bridge now receives real approval requests from OpenClaw and sends real responses back
- [ ] One scheduled routine: morning brief at 7:30 — pushes 3 cards (weather / one market quote / today's calendar headline) to the device
- [ ] Brightness dim after 2 min idle; IMU tap-to-wake
- [ ] Pocket-sized "dismiss" gesture (swipe or double-tap IMU)
- **Test:** You've used Pocket for 3 consecutive days without opening the Mac to check OpenClaw, including approving at least one real outbound action from the device.

---

## After M2 (not milestones yet — review with user before promoting)

- A second routine you actually want (whatever emerged as useful during M2)
- Card history (scroll back through the day's agent activity)
- Voice-to-text push-to-talk *if* glance-and-tap feels insufficient
