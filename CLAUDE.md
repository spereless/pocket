# Pocket

Pocketable voice companion for the OpenClaw agent on the Mac Mini. Waveshare ESP32-S3 AMOLED (onboard mic + speaker + battery) talks to a Node bridge on the Mac over LAN; the bridge talks to xAI Realtime (Grok handles voice), which delegates real agent work to OpenClaw via a single `ask_openclaw` function tool. Single user, single device.

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
bridge/    Node service on the Mac Mini — xAI Realtime client + LAN WebSocket server + OpenClaw tool
firmware/  ESP32-S3 firmware (ESP-IDF + LVGL) — I2S audio, WebSocket, orb UI
docs/      Notes as they become useful — not a dumping ground
tasks/     todo.md / STATUS.md / lessons.md / backlog.md
```

---

## Hardware (already owned)

- **Mac Mini** — already runs OpenClaw. Do not disrupt it. Add bridge service alongside.
- **Waveshare ESP32-S3-Touch-AMOLED-1.8** — 368×448 AMOLED (SH8601 QSPI), FT3168 capacitive touch, QMI8658 6-axis IMU, **ES8311 mono audio codec**, **onboard microphone**, **onboard speaker**, AXP2101 PMIC, MX1.25 Li-ion header, 16MB flash + 8MB PSRAM, Wi-Fi 2.4 GHz, BLE 5, USB-C.

Self-contained: device captures and plays audio on its own. LAN WebSocket to the bridge; bridge is the only thing that talks to the cloud.

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

---

## Ground rules

- Plan before building. Confirm scope with the user before touching code.
- One milestone at a time. Don't start M1 before M0's Test passes.
- Never mark done without proving the **Test:** line.
- Log failures to `lessons.md` immediately.
- Bridge holds the xAI API key. **Never** put it on the ESP32 or in client-exposed code.
- If it starts feeling like a startup again, stop and re-read VISION.md.
- No iOS app, no multi-device, no OTA pipeline, no custom enclosure, no second routines. Pocket is one tap, one question, one answer.

---

## Updating tasks

When the user says "update tasks" at the end of a session:
1. Rewrite `STATUS.md` as a fresh cold-start briefing — specific, not vague
2. Check off completed items in `todo.md`, revise milestones if scope shifted
3. Log any failure or surprise from this session in `lessons.md`
