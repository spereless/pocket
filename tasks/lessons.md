# Lessons

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
