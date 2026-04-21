# Lessons

## 2026-04-21 — FreeRTOS task with large local buffer → LoadProhibited bootloop

`mic_task` and `spk_task` were created with 4096-byte stacks and each declared `uint8_t buf[CHUNK_BYTES]` (= 4096 bytes) on that stack. The local array blew past the stack into the adjacent FreeRTOS task control block / list pointers. First `i2s_channel_read` called `xQueueReceive` → `vTaskPlaceOnEventList` → `vListInsert` which dereferenced a corrupted list pointer → LoadProhibited panic at very low addresses (EXCVADDR like 0x1e8, 0xffff). Panic repeated every boot so it looked like a firmware-init bug, not a stack issue.

**Fix:** bump stack to 8192 for both tasks.

**Rule:** if a FreeRTOS task's local variables are anywhere close to half the task's stack size, it WILL overflow into neighboring kernel structures and crash. Stack size = working space + locals + safety margin. Don't put 4 KB buffers on a 4 KB stack. When in doubt, heap-allocate.

**Also useful:** addr2line the panic PC via `xtensa-esp32s3-elf-addr2line -pfiaCe build/*.elf 0x4037f3e2 0x4037f97e ...`. That went straight from panic register dump to "mic_task at i2s_es8311_example.c:174" in seconds.

---

## 2026-04-21 — ES8311 mono RX gives duplicated stereo slots; audio arrives at 2× expected byte rate

Configured I2S RX with `I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(16BIT, MONO)` + slot_mask LEFT. Expected: 24 kHz × 2 bytes = 48 kB/s of mono samples. Observed: 96 kB/s, with every adjacent 16-bit pair exactly identical (100 % pair-duplication across 142k pairs). The codec puts its single mono mic on BOTH L and R slots; the driver in MONO-RX mode still delivers both. xAI saw half-speed audio, transcribed garbage.

**Fix in `bridge/audio_io.js`:** `dedupFromDevice(buf)` takes every other 16-bit sample before forwarding to xAI. Byte count halves; content rate is the correct 24 kHz mono.

**Asymmetry bonus gotcha:** TX/spk side does NOT need duplication. The I2S driver in MONO-TX mode writes the mono sample to both slots automatically. We tried bridge-side duplication on the spk path first — audio came out 2× slow and choppy. Pass-through is correct.

**Rule:** on ES8311 (and probably any mono codec) with ESP-IDF I2S `MONO` mode:
- **RX (mic):** you receive both slots; dedup in software.
- **TX (spk):** driver expands your mono stream to fill both slots; send raw mono.

Verify with a rolling PCM capture. Trust byte counts, not configs.

---

## 2026-04-21 — xAI Realtime bursts audio faster than realtime; firmware ringbuffer must buffer entire reply

Grok's TTS doesn't stream at playback rate. A 5-second reply gets delivered from the API in ~2 seconds, then the stream pauses until the next turn. If the device's rx ringbuffer is smaller than the reply, the tail overflows and gets dropped → reply is smooth for the first few seconds then goes choppy mid-sentence.

**Fix:** 512 KB ringbuffer (≈10 s of 48 kB/s audio) allocated from PSRAM via `xRingbufferCreateWithCaps(..., MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)`. Internal SRAM only has ~277 KB free — a 512 KB ring just doesn't fit.

**Required sdkconfig for the Waveshare ESP32-S3 AMOLED 1.8:**
```
CONFIG_SPIRAM=y
CONFIG_SPIRAM_MODE_OCT=y
CONFIG_SPIRAM_TYPE_AUTO=y
CONFIG_SPIRAM_SPEED_80M=y
CONFIG_SPIRAM_BOOT_INIT=y
CONFIG_SPIRAM_USE_MALLOC=y
```
Without these the chip boots but PSRAM is absent — MALLOC_CAP_SPIRAM returns NULL silently, and `xRingbufferCreateWithCaps` fails with a log like `ring alloc failed`.

**Rule:** any audio-streaming service whose cadence you don't control → size the device ringbuffer for the worst-case burst, not the average rate. On ESP32-S3 that means PSRAM.

---

## 2026-04-21 — ES8311 mic gain sweet spot is ~12 dB, NOT the default

The codec driver doesn't set mic gain unless `CONFIG_EXAMPLE_MODE_ECHO` is defined, and the default register value is near 0 dB. At 0 dB, speech is inaudible to xAI (~1 % full-scale even held to the mouth). At 36 dB, normal speech clips hard — 5000 saturated samples per second. The transcription model hallucinates plausible English from clipped noise.

**Fix:** unconditionally call `es8311_microphone_gain_set(handle, ES8311_MIC_GAIN_12DB)` in `es8311_codec_init`. At 12 dB, conversational speech held ~3 inches from the board peaks around 30 % and has RMS 6–8 %. Clean transcription.

**Rule for any unfamiliar audio codec:** record, plot peak + RMS, iterate. Don't guess gain. Add a peak-per-second logger to the bridge and keep it in; it'll pay for itself the next time something sounds off.

---

## 2026-04-21 — Bridge-side PCM recording + peak meter is THE audio debugging tool

Spent ~2 hours chasing bad transcription by tweaking mic gain blindly before adding `/tmp/pocket_rx.pcm` + a peak-percentage logger to the bridge. Once in, the answer was obvious in one test cycle: 38.9 % RMS + every-second clipping meant HARD clipping, not "too quiet" (my initial hypothesis). And the 100 % pair-duplication pattern jumped out immediately from a numpy print.

**Rule:** when diagnosing an unknown audio path, the FIRST debug change is "capture the bytes to a file + log peak". Not "adjust gain". Not "try different sample rate". Capture, analyze, then change one thing.

---

## 2026-04-20 — `speaker` npm package: lazy-create per response

First pass of `voice.js` created one Speaker on `session.updated` and reused it forever. Between responses, CoreAudio's callback kept firing with no data → `buffer underflow` warnings flooded the console. Audio itself worked, but the logs were noise.

**Fix:** create a new `Speaker` on the first `response.output_audio.delta` of each response, call `.end()` on `response.done`, `.destroy()` on interruption. The Speaker instance only exists while audio is actively streaming.

**Rule:** treat `speaker` as a per-utterance stream, not a persistent device handle.

---

## 2026-04-20 — xAI Realtime function calls need a deferred `response.create`

Function-tool cycle in xAI Realtime is a **two-response** pattern. When Grok invokes a tool:

1. `response.function_call_arguments.done` fires with `{ call_id, name, arguments }` (top-level, arguments is a JSON string).
2. The current response finishes with `response.done` — its `output` contains only the `function_call` item. 0 output tokens.
3. You submit the result via `conversation.item.create { item: { type: 'function_call_output', call_id, output } }`.
4. Only **after** step 2's `response.done` may you send `response.create` — that triggers a new response where Grok speaks the tool result.

**What bit us the first time:** sending `response.create` immediately after `function_call_output` (while the tool-call response was still `in_progress`) got silently dropped. No error, no second response, no assistant reply. Verified with `bridge/fn_smoketest.js`.

**Rule:** track `outputSent` + `toolTurnClosed` separately; only send `response.create` when both are true. Also: xAI emits both `response.function_call_arguments.done` and `response.output_item.done` for the same call — handle only the former or you'll double-submit.

---

## 2026-04-21 — OpenClaw CLI choice matters more than session warmth

Timed three ways to run a one-shot agent turn:

- `openclaw agent --agent main -m …` — **20s**. Loads the full agent runtime client-side even though it still routes through the gateway; ~10s of JS spin-up before the first byte of RPC.
- `openclaw gateway call agent --expect-final --json …` (cold session) — **11s**. Thin RPC client, no agent runtime in the CLI process.
- Same command, warm session (reused `sessionKey`) — **10s**. Extra ~1.5s shaved once memory/tools are loaded server-side.

**Rule:** for scripted callers, always prefer `openclaw gateway call agent` over `openclaw agent`. Pin a stable `sessionKey` (we use `agent:main:pocket`) so repeated calls hit a warm session.

**Output shape (confirmed across several runs):** real replies land at `result.meta.finalAssistantVisibleText`. My pong smoke test had me believing it was at `result.finalAssistantVisibleText` — that was eyeballing error. Safe fallback chain: `result.meta.finalAssistantVisibleText → result.meta.finalAssistantRawText → result.payloads[0].text`.

---

## 2026-04-21 — Gateway WS direct connection needs device pairing

Explored skipping the CLI subprocess entirely by opening a persistent WebSocket to `ws://127.0.0.1:18789` (like Telegram does internally). Handshake works — the `connect.challenge` → `req{method:"connect"}` → `hello-ok` dance completes in 2ms with the shared gateway token. But calling the `agent` method fails with `missing scope: operator.write`.

**Why:** plain-token clients have `connectParams.scopes` cleared server-side unless they present a paired-device identity. `agent` requires `operator.write`, which only proper devices (or `operator.admin`) hold.

**The right path to unblock this later:** pair the bridge as a real OpenClaw device (`openclaw devices approve` flow), store its private key in `bridge/.env`, and do the signed-nonce connect handshake. Then the WS route Just Works. Tracked in backlog — not worth doing until M3 firmware is live and every millisecond matters for pocket feel.

**Rule:** if you want to talk to the OpenClaw gateway directly as a first-class client, budget device pairing. Don't try to brute-force it with the raw token.

---

## 2026-04-21 — In-flight tool calls must be cancellable

First M2 pass: rephrasing a question mid-thought caused two `ask_openclaw` calls to run in parallel, so Grok answered both in sequence ("you have 11 files... you have 11 files dated Apr 8–18"). The second answer was correct, but the first one had already been spoken.

**Fix (now in `voice.js`):** maintain `activeToolCallId` + `activeToolProc`. When a newer `response.function_call_arguments.done` fires, or when `speech_started` fires (user interrupt), SIGKILL the older subprocess and drop its result on return.

**Rule:** treat every tool call as abortable. Any time the user speaks, or a newer call supersedes the current one, kill the subprocess and never submit its stale output back to Grok.

---

## 2026-04-21 — ES8311 + ESP-IDF 5.3: MCLK_MULTIPLE must be 256 at 24 kHz, not 384

Default `06_I2SCodec` sample uses `EXAMPLE_MCLK_MULTIPLE = 384` with `EXAMPLE_SAMPLE_RATE = 16000` (MCLK = 6.144 MHz). Bumping sample rate to 24000 while leaving multiplier at 384 (MCLK = 9.216 MHz) makes `es8311_init()` fail with `ESP_ERR_INVALID_ARG` during ESP_ERROR_CHECK, crashing the app into a bootloop.

**Fix:** drop `EXAMPLE_MCLK_MULTIPLE` to 256 for 16-bit data. The example's own comment flags this: "If not using 24-bit data width, 256 should be enough."

**Rule:** when changing I2S rates on this codec, recompute MCLK and verify it's one the driver accepts. 256× and 384× are the only two multipliers the ES8311 driver blesses; 384× only works for certain sample rates.

---

## 2026-04-21 — ESP32-S3 Wi-Fi power-save breaks sustained streaming

Default `esp_wifi_start()` leaves the radio in modem-sleep (listen every 3 beacons, ~300 ms gaps between wake windows). Fine for request/response HTTP, lethal for 48 kB/s continuous audio uplink — TCP retransmits stack up, the WS connection times out and disconnects every few seconds.

**Fix:** call `esp_wifi_set_ps(WIFI_PS_NONE)` right after `esp_wifi_start()`. Radio stays on, latency drops to single-digit ms, sustained uplink becomes stable.

**Trade-off:** noticeably higher current draw. When Pocket goes on-battery in M4, re-enable PS during idle and only disable it while a session is active (mic/speaker streaming). For now in M3b, PS=NONE is the right default — the device is USB-powered.

---

## 2026-04-21 — Small WS frames at 50 Hz flood xAI Realtime and flap the connection

First firmware pass sent 1024-byte I2S reads (~21 ms) as individual WS binary frames. Bridge then base64-encoded each and sent to xAI as `input_audio_buffer.append` JSON messages: ~50 messages/sec, ~1.4 KB each. Connection dropped after ~1 second of sustained streaming. With Wi-Fi PS off, survived ~8 s. With 4096-byte chunks (~85 ms, 12 Hz), dramatically better.

**Rule:** WS frame cadence for audio is 10–20 Hz, not 50 Hz. Each frame should carry 80–100 ms of audio minimum. xAI Realtime's server-side batching expects this shape — hammering it with sub-second fragments wastes its frame-parsing budget and appears to trigger a disconnect.

**Also log send failures.** Early mic_task silently dropped `send_bin` returns; when the socket went dead mid-stream the task happily hammered a closed connection at 50 Hz spewing `Websocket client is not connected` errors forever. Always check the return and back off (even 200 ms of `vTaskDelay`) on failure — not doing so burns CPU, floods the log, and masks the upstream cause.

---

## 2026-04-21 — Onboard mic+speaker will feedback on any simultaneous loopback

First attempt at M3a echo mode (raw mic→speaker live) produced an instant, painfully loud howl the moment the PA warmed up. Not a bug — the Waveshare board's mic and speaker share the same PCB housing, so any non-trivial loop gain oscillates. Volume 80 + 30dB mic gain was the worst case; lowering both just delayed the squeal.

**Fix:** use a **record-then-play** pattern instead of live duplex. Drive `GPIO_OUTPUT_PA` (pin 46) LOW during capture so the speaker amp is hard-muted, capture N seconds into a heap buffer, then drive PA HIGH and play the buffer back. Mic and speaker never run at the same time. No feedback is possible regardless of volume/gain.

**Rule:** never wire mic output directly to speaker input on hardware where the two transducers share enclosure. For Pocket this doesn't matter anyway — the real xAI flow is already record → network → play, not duplex. The firmware should match that shape from day one.

---

## 2026-04-21 — ESP32-S3 native USB doesn't auto-reset on pyserial open

Tried to read boot logs by `pyserial.Serial('/dev/cu.usbmodem31201')` and got nothing — the chip had booted long before the Python process opened the port, and native USB (USB-Serial-JTAG) doesn't toggle chip reset on DTR/RTS the way a CP210x/FT232 would.

**Fix:** force a reset before reading. `python -m esptool --chip esp32s3 -p /dev/cu.usbmodem31201 --after hard_reset run` — it reboots the chip and exits, leaving the serial line free for a follow-up pyserial open. Chain them in the same Bash invocation so there's no race.

**Rule:** for any "read boot logs" flow on this board, reset first, then read. Or just use `idf.py monitor`, which handles the native-USB reset sequence itself.

---

## 2026-04-21 — Wi-Fi secrets live in a gitignored header, not sdkconfig

First reflex was to put SSID/password in `sdkconfig.defaults`. Wrong — that file is committed. Second reflex: put them in `sdkconfig`, which is gitignored. Also wrong for this project: the workflow `rm sdkconfig && idf.py build` regenerates the file from defaults every time, wiping the creds.

**Fix:** `firmware/pocket/main/secrets.h` holds `#define POCKET_WIFI_SSID / POCKET_WIFI_PASSWORD`. Gitignored via `firmware/**/main/secrets.h`. Included by `wifi.c`. Survives sdkconfig rebuilds, never touches git, doesn't require menuconfig gymnastics.

**Rule:** for anything sensitive that needs to persist across clean builds, a gitignored source header beats any sdkconfig mechanism. Same pattern will apply to future provisioning tokens, xAI API keys on-device (never), etc.

---

## 2026-04-21 — ESP-IDF 5.3 + macOS system Python 3.9 = dead end

Fresh `install.sh esp32s3` succeeds, but `source export.sh` always fails with opaque errors like *"Error while checking requirement 'X'. Package was not found and is required by the application: ruamel.yaml.clib"*. Every fix I tried surfaced a different package name in the error; the text is misleading because `check_python_dependencies.py` uses a stale `req` loop variable when formatting the exception.

**Real cause:** Python 3.9's `importlib.metadata` can't resolve the legacy dotted distribution name `ruamel.yaml.clib` (which is a transitive dep of `ruamel.yaml`). IDF's walker iterates `requires()` for every package and crashes on that name. Python 3.10+ normalizes the name; 3.9 doesn't.

**Fix (now encoded in `firmware/activate-idf.sh`):**
1. `mkdir ~/.idfshim && ln -sf /opt/homebrew/bin/python3.12 ~/.idfshim/python3`
2. Before install or activate: `export PATH="$HOME/.idfshim:$PATH"` so IDF's `detect_python.sh` sees 3.12 first.
3. Rebuild the venv from scratch (`rm -rf ~/.espressif/python_env/idf5.3_py3.9_env`, re-run `install.sh esp32s3`).

**Rule:** never use macOS system Python for ESP-IDF 5.x. Force a modern Homebrew Python via the shim. `source firmware/activate-idf.sh` is the only supported way to enter an IDF shell in this repo.

---

## 2026-04-20 — Don't scope a weekend project like a startup

First pass at Pocket ballooned into a consumer-hardware product plan: Raspberry Pi, Fly.io per-user cloud nodes, iOS companion app with BLE provisioning, Mender OTA, custom enclosure, pilot users, subscription pricing. None of it was needed. The user already has the Mac Mini running OpenClaw and already owns the ESP32-S3 AMOLED board — that's the whole project.

**The rule going forward:** if the build plan requires hardware you don't have, accounts you don't have, or users who don't exist, it's wrong for v0. Start from what's already on the desk.

**The check:** every time a new concept enters the plan, ask "does this exist physically or in code on the Mac Mini right now?" If no, it goes to backlog until v0 earns it.
