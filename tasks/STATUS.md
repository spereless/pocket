# Status

## Current Milestone
M3b — WebSocket bridge + full voice loop on real hardware

## In Progress
**Slice 3 done, Slice 3.5 (OpenClaw persistent gateway) done. Next: Slice 4.1 (screen-tap interrupt).** End-to-end voice loop works on device with visible orb states and ~5.6 s OpenClaw turns (was ~10 s via spawn'd CLI).

## Done in M3b

### Slices 1, 2, 4 (audio loop + PTT) ✅
As before. See earlier STATUS entries in git for detail.

### Slice 3 — Orb UI (LVGL) ✅
`main/ui_orb.{c,h}` + `main/components/esp_lcd_sh8601/`. Panel init copied from `firmware/lvgl-smoketest/`. LVGL 8.4 pulled in via `main/idf_component.yml`. Orb = core + two partial-arc rings, ≈130 px total footprint (70% smaller than the original 400 px flat circle).

Per-state animations (`apply_state` in `ui_orb.c`):
- idle: 64↔72 px breathing core, faint outer arc drifting 7 s/rev
- listening: faster pulse, both arcs counter-rotating
- thinking: dim small core, arcs spinning opposite directions (metamorphosis feel)
- speaking: fast speech-like pulse, rings sweeping behind
- error (not connected): opacity-flash core + both red rings spinning fast

Bridge → device state frames (`{"orb":"..."}`) in `voice.js` cover thinking/speaking/error. `response.done` deliberately does NOT send idle — the device's `spk_task` owns that when the PA actually drops, so the orb stays in "speaking" while the rx ring drains. `button_task` has a 10 s safety net that returns to idle if nothing ever comes back.

### Slice 3.5 — OpenClaw persistent gateway ✅ (pulled forward from backlog)
`bridge/openclaw_client.js` — ed25519-signed connect handshake, persistent WS to `ws://127.0.0.1:18789`, `askAgent()` helper. Protocol reverse-engineered from the CLI's dist bundle:
- Device identity reused from `~/.openclaw/identity/` (already paired as operator; gateway allows multiple sockets per device so no conflict with CLI)
- v3 signature payload: `v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily`
- `client.id` MUST be one of the enum values (`gateway-client` for backends); free-form strings get rejected with "must match a schema in anyOf"
- For `agent` method: set `expectFinal` so the client ignores the initial `{status:"accepted"}` ack and waits for the final res with the same id

`voice.js` now calls `openclaw.askAgent(prompt, {signal})` instead of spawning the CLI. Cancel/supersede uses `AbortController.abort()` instead of `SIGKILL`. Smoke test (`bridge/oc_smoketest.js`): 54 ms to ready, 5.6 s for a warm-session agent turn.

## Context / Gotchas from today

- **Transform_zoom on lv_obj leaves stale pixels** when scaling >100% because LVGL only invalidates the object's bbox. The scaled pixels drift outside and the next frame's erase doesn't cover them → "flashing / glitching". Fix: use `lv_obj_set_size` per-frame instead. (Also applies any time we're tempted to use transform for animated widgets — just resize.)
- **SH8601 has no `swap_xy`** — calling `esp_lcd_panel_swap_xy(panel, false)` raises `ESP_ERR_NOT_SUPPORTED`. Only `mirror(true, false)` is valid.
- **LVGL DMA draw buffers must stay small** — 368×20×2 B × 2 buffers = ~30 KB. 60 lines × 2 = ~88 KB already fails alloc once WiFi is up (internal SRAM is tight).
- **Panel's GRAM boots white** — unless you paint a full black frame (via `lv_refr_now` BEFORE `disp_on_off(true)`) the edges flash white at boot.
- **Port 8789 can silently EADDRINUSE** — if a stale `voice.js` is still bound, the new instance logs it but still connects its own xAI socket, looking like it's "running" while the device can't reach it.

## Running / rebuilding

Bridge (on the Mac Mini):
```
cd ~/Desktop/pocket/bridge
pkill -f "node voice.js"; sleep 1
POCKET_MODE=device node voice.js
```

Firmware (from project root):
```
source firmware/activate-idf.sh                                    # once per shell
idf.py -C firmware/pocket build
idf.py -C firmware/pocket -p /dev/cu.usbmodem31101 flash
```

## Next Action

**Slice 4.1 — screen-tap interrupt.** Wire the FT3168 touch controller (already in the LVGL indev chain for the smoketest). Tap anywhere during `speaking` → send `{"kind":"tap"}` to bridge → bridge calls `interrupt()` → audio stops, orb goes idle. I2C already shared with ES8311; touch driver reads via its own panel_io over the same bus. Budget ~45 min.

After 4.1: Slice 6 (final M3b test), then M4 (battery + dim + tap-to-wake).
