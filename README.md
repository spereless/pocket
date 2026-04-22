# Pocket

Pocketable voice companion for the [OpenClaw](https://openclaw.ai) agent.

A Waveshare ESP32-S3 AMOLED (onboard mic + speaker) talks over LAN to a Node bridge on a Mac. The bridge talks to [xAI Realtime](https://docs.x.ai/docs/guides/realtime) (Grok handles voice); Grok delegates real agent work to OpenClaw via a single `ask_openclaw` function tool.

One tap. One question. One answer.

```
[ESP32-S3 + mic/speaker/orb]  ←WiFi WebSocket→  [Bridge on Mac]
                                                      ↕
                                               [xAI Realtime]
                                                      ↕
                                               ask_openclaw(prompt)
                                                      ↕
                                               [OpenClaw gateway]
```

## Hardware

- A Mac (or any always-on machine) running OpenClaw
- A Waveshare **ESP32-S3-Touch-AMOLED-1.8** — 368×448 SH8601 QSPI display, FT3168 touch, QMI8658 IMU, **ES8311 codec with onboard mic + speaker**, AXP2101 PMIC, 16 MB flash + 8 MB PSRAM, Wi-Fi 2.4 GHz, USB-C

The firmware is written against this specific board. Porting to another ESP32-S3 dev board with an ES8311 + SH8601 is possible but not wired up.

## Repo layout

```
bridge/                Node service — xAI Realtime client + LAN WebSocket + OpenClaw client
  voice.js              main entrypoint: POCKET_MODE=device node voice.js
  openclaw_client.js    persistent WS to the OpenClaw gateway (ed25519 device auth)
  audio_io.js           Mac-local vs device-LAN audio IO abstraction
  device-ws.js          WS server the ESP32 connects to
firmware/pocket/       ESP-IDF 5.3 firmware — I2S audio, WS client, LVGL orb UI
  main/ui_orb.c         animated orb: core + two rotating arc rings, per-state motion
  main/bridge_ws.c      WS client to the Mac bridge, 512 KB PSRAM rx ring
  main/i2s_es8311_*.c   mic/speaker tasks + PTT button
docs/                  Design notes (orb UI spec)
tasks/                 todo.md / STATUS.md / lessons.md / backlog.md
```

## Setup

### 1. Bridge

```
cd bridge
npm install
cp env.example .env    # then put your XAI_API_KEY into .env
```

Run in "mac" mode first to verify the xAI side works via your laptop mic/speakers:

```
node voice.js
```

### 2. OpenClaw gateway

The bridge talks to the OpenClaw gateway at `ws://127.0.0.1:18789` and reuses the OpenClaw CLI's paired device identity at `~/.openclaw/identity/`. Install OpenClaw and run `openclaw gateway` once so that directory exists with an approved operator token; the bridge picks it up automatically.

### 3. Firmware

```
# Install ESP-IDF v5.3 somewhere; project assumes ~/esp/esp-idf.
# macOS: you need a modern Python (3.10+). Use the shim at ~/.idfshim — see firmware/activate-idf.sh.

source firmware/activate-idf.sh
cp firmware/pocket/main/secrets.h.example firmware/pocket/main/secrets.h
# Edit secrets.h with your Wi-Fi SSID/password and your Mac's LAN IP + port 8789

idf.py -C firmware/pocket set-target esp32s3
idf.py -C firmware/pocket build flash monitor -p /dev/cu.usbmodem<N>
```

### 4. Run the full loop

```
# On the Mac:
cd bridge
POCKET_MODE=device node voice.js

# Power the ESP32. The orb should settle on dim-indigo "idle" once it
# finds Wi-Fi and connects to the bridge.
# Hold BOOT on the board. Speak. Release. Wait for Grok's reply.
```

## Orb states

| State          | Look                                                     |
| -------------- | -------------------------------------------------------- |
| idle           | dim indigo core breathing, faint indigo arc drifting     |
| listening      | cyan core pulsing, both arcs counter-rotating            |
| thinking       | small amber core, arcs spinning opposite directions      |
| speaking       | soft-white core pulsing fast, rings sweeping behind      |
| error          | red core flashing, both rings spinning fast              |

See [`docs/orb-ui.md`](docs/orb-ui.md) for the full spec.

## Status

See [`tasks/STATUS.md`](tasks/STATUS.md) for the current milestone and what's in progress. [`tasks/todo.md`](tasks/todo.md) has the milestone plan; [`tasks/lessons.md`](tasks/lessons.md) is a running log of every dumb thing that bit us and how we fixed it — worth reading before reimplementing anything in here.

## Non-goals

Pocket is deliberately small. Things that are **not** v0 and live in `tasks/backlog.md` until they earn their keep:

- Wake-word — tap-to-talk is fine
- iOS companion app — the Mac is the server
- OTA firmware updates — `idf.py flash` over USB is fine
- Custom enclosure — the dev board is the product
- Multi-device / multi-user — single user, single device
- Anything in the "make this a startup" direction

## License

MIT. See [`LICENSE`](LICENSE).

## Credits

Built on top of:
- [OpenClaw](https://openclaw.ai) — the agent layer
- [xAI Realtime](https://docs.x.ai/docs/guides/realtime) — voice turn generation
- Espressif ESP-IDF 5.3, LVGL 8.4, esp_lcd_sh8601, esp_websocket_client
- Waveshare ESP32-S3-Touch-AMOLED-1.8 reference designs
