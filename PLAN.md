# FreeHand Browser Plan

## Goal

Build a local-first web application that lets a user browse with voice and hand gestures while keeping browser automation explicit, reviewable, and under the user's control.

## Target machine

- Intel i5-8400 (6 CPU cores)
- 20 GB DDR4 RAM
- Intel integrated graphics

This hardware is suitable for browser-based hand tracking, a local Node service, and CPU speech-to-text. It is not a good fit for continuous screenshot-based visual agents or large vision-language models.

## Architecture

```text
React browser UI
  ├─ MediaPipe Hand Landmarker (webcam, local in browser)
  ├─ microphone capture
  └─ browser action review / confirmation
          │ HTTP / WebSocket
Node + TypeScript local service
  ├─ whisper.cpp sidecar adapter (offline STT)
  ├─ intent parser and Zod action validation
  └─ Browser Use / Playwright adapter using a separate Chrome profile
```

The web page cannot directly automate arbitrary sites or control other browser tabs. That privileged work belongs in the local service, which exposes a deliberately limited API to the page.

## Phase 1 — Input and safe commands

1. Keep the current MediaPipe hand-preview working locally.
2. Replace the temporary browser speech API with push-to-talk audio sent to a local `whisper.cpp` server.
3. Support direct `open YouTube` and search actions in the user's default browser, plus a constrained command set: search, scroll, back, forward, open result number, pause.
4. Show each parsed action in the UI before it reaches the automation adapter.

Recommended STT starting point: `whisper.cpp` with quantized `base.en`. Test `small.en` only after measuring latency. Defer Parakeet TDT 0.6B until CPU performance is measured.

## Phase 2 — Browser integration

1. Launch a dedicated Chrome/Chromium profile from the local service.
2. Use Playwright or Browser Use's local TypeScript tooling to read the accessibility tree and interact through DOM selectors.
3. Keep a domain allowlist and visible browser window during development.
4. Add a per-action activity feed and timeout/error recovery.

DOM/accessibility-tree actions are preferred over screenshots because they are faster and more reliable on the target CPU.

## Phase 3 — Natural language

1. Introduce an optional local, quantized 1–3B text model through Ollama.
2. Ask it to map a spoken request only to the validated action schema.
3. Reject invalid, ambiguous, or low-confidence output and ask the user to clarify.
4. Use page text selectively for summaries; do not continuously run a visual model.

## Gesture mapping

| Gesture | Initial purpose |
| --- | --- |
| Open palm | enter scroll mode |
| Pinch | click / confirm focused element |
| Two-finger point | next / previous navigation gesture |
| Hand absent | stop gesture input |

Gesture recognition needs smoothing and dwell-time thresholds before triggering browser actions. Never fire an action from a single frame.

## Safety rules

- Require confirmation for form submission, downloads, account changes, messages, purchases, and any typed secret.
- Do not capture or log raw audio/video by default.
- Store no passwords, cookies, or browser profile files in the web app.
- Run automation in a separate, visible Chrome profile.
- Default to a domain allowlist during development.

## Next implementation tasks

1. Add a `whisper.cpp` sidecar setup and `/api/transcribe` endpoint.
2. Add gesture smoothing plus an on-screen calibration step.
3. Add the local Playwright adapter and a visible dedicated Chrome browser.
4. Add action confirmation cards and persistent local settings.
