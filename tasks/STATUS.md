# Status

## Current Milestone
M0 — Understand OpenClaw on this Mac

## In Progress
Nothing yet. Project just bootstrapped on the Mac Mini. First task is inspecting the local OpenClaw install to decide the integration strategy.

## Done
- Pivoted away from an overbuilt consumer-hardware plan to a weekend-sized personal project
- VISION.md written (LAN-only companion for existing OpenClaw on existing Mac Mini, existing ESP32-S3 AMOLED board)
- todo.md has 3 milestones: M0 understand OpenClaw, M1 bridge stub + idle screen, M2 real integration + morning brief

## Context

**Hardware already owned, no purchases needed:**
- Mac Mini runs OpenClaw today (user's existing setup, do not disrupt)
- Waveshare ESP32-S3 1.8" AMOLED board (368×448, SH8601 driver, FT3168 touch, QMI8658 IMU, Wi-Fi + BLE, USB-C)

**Scope guardrail — read this before every decision:** v0 is one user, one device, one Mac, LAN-only. No cloud. No iOS app. No voice. No enclosure. If a proposal adds any of those, push back and route it to backlog.md.

**First-hour question to answer in M0:** how does OpenClaw on this Mac expose events / tool calls / hooks? Answer dictates everything downstream. User is not sure — need to inspect the install directly.

## Next Action

Ask the user for the OpenClaw install path on the Mac Mini, then read its README + source to answer the three M0 questions (approval gating, plugin/tool registration, event emission). Write findings to `docs/openclaw-integration.md` and pick the integration strategy.
