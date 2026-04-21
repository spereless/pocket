# Status

## Current Milestone
M2 — `ask_openclaw` function tool

## In Progress
Starting M2. M0 and M1 done this session. Next: add a single `function` tool to the xAI session config so Grok can delegate to OpenClaw. When Grok decides it needs the user's real data (email, calendar, files, personal context), it calls `ask_openclaw(prompt)`; the bridge shells out to the OpenClaw CLI, captures stdout, returns it as the function output, and lets Grok speak the answer.

## Done this session
- Pivoted vision from glance-and-tap cards to pocket voice agent (Grok voice + OpenClaw as a tool)
- Corrected CLAUDE.md hardware spec (board has onboard mic/speaker/ES8311/AXP2101/Li-ion header)
- Rewrote VISION / todo / backlog / CLAUDE around voice-first
- **M0 passed**: `smoketest.js` proves xAI Realtime auth + WebSocket + WAV roundtrip
- **M1 passed**: `voice.js` runs a full voice loop on the Mac — mic capture (sox + node-record-lpcm16), Speaker playback, VAD turn-taking, interruption, clean shutdown
- Logged the Speaker lifecycle fix in lessons.md (create-per-response, not create-once)

## Context

**Architecture (unchanged):**
```
[ESP32-S3 + mic/speaker/orb]  ←WiFi WebSocket→  [Bridge on Mac Mini]
                                                       ↕
                                                [xAI Realtime]
                                                       ↕
                                                ask_openclaw(prompt)
                                                       ↕
                                                [OpenClaw CLI]
```

**What M1 proved:** full voice pipeline works on commodity audio hardware. Mic PCM streams up, audio deltas stream down, server VAD handles turn-taking, interruption is immediate. When we flash the ESP32 in M3, we're porting a proven pipeline — not debugging it from scratch on device.

**What M2 adds:** the OpenClaw delegation. After M2, Grok stops answering from its own knowledge for anything user-specific and calls the tool instead. This is the moment Pocket becomes useful — voice in, real data out, voice back.

**Blocker before code:** need the actual OpenClaw CLI invocation shape. Specifically:
1. Command name (is it `openclaw`, `claw`, `npx openclaw`, something else?)
2. How do you pass a prompt — positional arg? `--prompt`? stdin?
3. Does it answer once and exit (one-shot), or is it interactive/streaming?
4. Where does the answer go — stdout? Or does it print logs mixed in?
5. Auth — does it read a config/key from somewhere? Already set up on this Mac?

Ask the user for the exact invocation that works today, or ask them to show one running.

**Key docs:**
- https://docs.openclaw.ai/start/getting-started — OpenClaw CLI docs (user-provided)
- https://github.com/openclaw/openclaw — source
- `/Users/jarvis/Desktop/instructions.md` §4 "Custom function call flow" for the xAI side

## Next Action

Ask the user for the OpenClaw CLI invocation shape (command, prompt arg format, one-shot vs streaming, stdout vs mixed). Do NOT guess the binary name. Once confirmed, add the `function` tool to `voice.js` session.update and handle `response.function_call_arguments.done` by spawning the CLI.
