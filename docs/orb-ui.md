# Orb UI — M3b design

The only visible UI in Pocket is a single filled circle on the 368×448 AMOLED. It has five states, each a flat color. No text, no icons, no animation in M3b. Any motion is deferred to M4 after daily use tells us which states warrant it.

---

## States and colors ("Night desk" palette)

| State | Color | Hex | Meaning |
|---|---|---|---|
| `idle` | dim indigo | `#1a1a3a` | no active session — default |
| `listening` | cyan | `#00d8ff` | mic streaming to bridge |
| `thinking` | amber | `#ffb020` | xAI generating, or `ask_openclaw` running |
| `speaking` | soft white | `#f0f0ff` | speaker playing Grok response |
| `error` (transient) | red | `#ff3030` | one failed response — auto-clears to `idle` after 3 s |
| `error` (persistent) | red | `#ff3030` | Wi-Fi or bridge unreachable — stays red until resolved |

The distinction between transient and persistent errors is not visual (both red). It's in the firmware's recovery behavior.

## Rendering

- Full-screen filled circle on the AMOLED, centered, ~200 px radius.
- Background is black (AMOLED true-black = zero pixel power, which matters for M4 battery life).
- No text anywhere — not even during errors. The color is the message.

## Inputs

| Input | Action |
|---|---|
| **BOOT button (GPIO 0)** | Toggle session. From `idle` → `listening`. During `listening` → stop mic, enter `thinking`. Ignored during `thinking` and `speaking`. |
| **Screen tap (FT3168)** | Interrupt. During `speaking` → cancel playback, send `response.cancel` to bridge, return to `idle`. During `error/persistent` → retry (force Wi-Fi reconnect and re-open bridge WebSocket). Ignored in other states. |

Rationale for the split: the most-used action (start talking) gets the physical button because it works by feel, through fabric, with no look at the screen. The less-used action (interrupt Grok) gets the touchscreen because it's only relevant when you're already looking at the lit orb.

GPIO 0 is shared with USB download mode: holding it during power-on enters the bootloader. That's fine — during normal operation it's just a readable GPIO. Don't poll it until after boot is complete.

## State machine

Two sources drive transitions: (1) firmware-local inputs (button, tap, Wi-Fi events), which fire immediately for responsiveness, and (2) bridge JSON frames, which confirm and override the local state once the server-side pipeline has progressed.

**Firmware-local (optimistic) transitions:**
```
idle              --button-->   listening    (also: start mic stream to bridge)
listening         --button-->   thinking     (also: send end-of-turn signal to bridge)
speaking          --tap-->      idle         (also: send response.cancel to bridge)
error/persistent  --tap-->      (retry — reconnect Wi-Fi, reopen bridge WS; stays error until recovered)
any               --wifi_lost-->            error/persistent
any               --bridge_ws_closed-->     error/persistent
(wifi recovered AND bridge WS reopened)     --> idle
```

**Bridge-driven transitions (overrides local):**
```
any(not error) <-- {orb: "listening"}  (bridge confirms mic is streaming)
any(not error) <-- {orb: "thinking"}   (xAI started generating / tool call running)
thinking       <-- {orb: "speaking"}   (first audio chunk arrived)
speaking       <-- {orb: "idle"}       (response.done, no new response yet)
any            <-- {orb: "error", ...}
```

Button input during `thinking` and `speaking` is ignored. Tap input outside `speaking` and `error/persistent` is ignored.

## Bridge → device JSON contract

The bridge translates xAI Realtime events into orb states and sends them to the device as JSON frames alongside the binary audio frames.

```json
{ "orb": "idle" }
{ "orb": "listening" }
{ "orb": "thinking" }
{ "orb": "speaking" }
{ "orb": "error", "kind": "transient",  "msg": "xai: response.failed" }
{ "orb": "error", "kind": "persistent", "msg": "bridge: openclaw cli exited 1" }
```

`orb` is the only required field. `kind` and `msg` are only present on `error`. `msg` is for serial-log debugging on the firmware side; the orb never renders it.

**Mapping from xAI events to bridge-sent orb states:**
- `input_audio_buffer.speech_started` → `listening` (echoes the device's optimistic local state; used to recover if they got out of sync)
- `response.created` → `thinking`
- `response.function_call_arguments.done` → stay `thinking` (tool call running; no frame change needed)
- first `response.output_audio.delta` of a response → `speaking`
- `response.done` → `idle` (unless another response is already in flight)
- `response.error` or `ask_openclaw` failure → `error` with `kind: "transient"` — auto-clears after 3 s

**Firmware-local transitions that do NOT come from bridge JSON:**
- Wi-Fi `WIFI_EVENT_STA_DISCONNECTED` → `error/persistent` until `GOT_IP` again AND bridge WS reopens
- Bridge WebSocket close without a preceding `{orb: "idle"}` from the bridge → `error/persistent`

## Out of scope for M3b

- Animation of any kind (breathing idle, thinking pulse, audio-envelope speaking).
- Low-battery indicator overlay (deferred to M4).
- IMU-based face-down mute (backlog).
- Any text rendering, even for errors.

## Implementation notes for M3b

- LVGL `lv_obj_t` as a styled `lv_arc` or `lv_obj` with `lv_obj_set_style_bg_color` is sufficient. No custom canvas.
- Orb state is updated on the LVGL task (core 1 by convention). WebSocket RX task pushes state changes via a FreeRTOS queue; LVGL task drains the queue and applies `lv_obj_set_style_bg_color` + `lv_obj_invalidate`.
- BOOT button read by a dedicated GPIO ISR + debouncer task. Minimum debounce 30 ms. Only report the edge to the session state machine, never the raw level.
- Touch events come through the FT3168 driver (already pulled in as a managed component from the LVGL smoketest). A single tap anywhere on the screen counts — no geometry check in M3b.
