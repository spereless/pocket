# Pocket

Glance-and-tap companion for the OpenClaw agent running on the Mac Mini. ESP32-S3 AMOLED on the LAN, tiny Node sidecar on the Mac. Single user, single device, weekend-sized.

## On Boot
1. Read `tasks/STATUS.md` — cold start briefing
2. Read `tasks/lessons.md` — what not to repeat
3. Say the current milestone and what's in progress
4. Say the next action: one sentence

If STATUS.md feels stale, check `git log --oneline -10` and `tasks/todo.md` checkboxes, then update STATUS before continuing.

---

## Workflow

Work one milestone at a time in `tasks/todo.md`. Each milestone ends with a **Test:** line that must be true before moving on.

1. Start the current milestone
2. Work through tasks, check them off
3. Prove the Test is true
4. Update tasks, move on

Milestones are living. Split them, cut them, change them. New ideas mid-build go to `tasks/backlog.md`.

---

## Repo layout (to be created in M0)

```
bridge/    Node service on the Mac Mini, sits next to OpenClaw
firmware/  ESP32-S3 firmware (Arduino or ESP-IDF + LVGL)
docs/      Notes as they become useful — not a dumping ground
tasks/     todo.md / STATUS.md / lessons.md / backlog.md
```

---

## Hardware (already owned)

- **Mac Mini** — already runs OpenClaw. Do not disrupt it. Add sidecar service alongside.
- **Waveshare ESP32-S3 1.8" AMOLED board** — 368×448, SH8601 display driver (QSPI), FT3168 capacitive touch, QMI8658 6-axis IMU, Wi-Fi 2.4 GHz, BLE 5, USB-C, JST Li-ion connector.

Same LAN, talking over WebSocket. No cloud.

---

## Ground rules

- Plan before building. Confirm scope with the user before touching code.
- **First task of M0 is figuring out how OpenClaw exposes events on this Mac** — everything downstream depends on it. Do not guess. Inspect the install, read its docs, or ask the user.
- One milestone at a time.
- Never mark done without proving the **Test:** line.
- Log failures to `lessons.md` immediately.
- If it starts feeling like a startup again, stop and re-read VISION.md.
- No iOS app, no cloud hosting, no OTA pipeline, no custom enclosure. If the answer gets complicated, the question is wrong.

---

## Updating tasks

When the user says "update tasks" at the end of a session:
1. Rewrite `STATUS.md` as a fresh cold-start briefing — specific, not vague
2. Check off completed items in `todo.md`, revise milestones if scope shifted
3. Log any failure or surprise from this session in `lessons.md`
