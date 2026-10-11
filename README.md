# FreeHand

Control your computer with your **hand**, your **head** and your **voice**. Local-first: camera frames are processed in your browser and never uploaded.

![FreeHand landing page](\src\Docs\Images\1.jpeg)

## Features

- **Hand control**: move a cursor with your hand through your webcam, with smoothing and fist click.
- **Head control**: turn and tip your head to move your real Windows cursor.
- **Dwell click**: hold still and it clicks, exactly where the cursor is locked.
- **Custom signs**: record your own hand signs and map them to actions.
- **Voice commands**: say or type what you want; common commands work out of the box.

![What's inside]()

## How it works

Point, hold still, done. Move with your hand or head, keep the cursor still while a ring fills and FreeHand clicks, or use a voice command or custom sign for things a click can't do.

![How it works](\src\Docs\Images\2.jpeg)

## Quick start

1. Install Node.js 22 or newer and Google Chrome (Chrome is used for the browser window FreeHand controls).
2. Run `npm install`.
3. Optional: copy `.env.example` to `.env` and add `GEMINI_API_KEY` for Gemini-powered command parsing. Direct commands such as `open YouTube` work without it.
4. Run `npm run dev`.
5. Open `http://localhost:5173` for the landing page, or `http://localhost:5173/app.html` for the app, and allow camera access.

Head control of the real cursor supports **Windows only**.

## The app

![FreeHand app](\src\Docs\Images\5.jpeg)

The client uses MediaPipe in the browser for hand and face landmarks. A local Node service validates actions and drives a dedicated Chrome window through Playwright.

## Controls

### Hand control

- Move your hand inside the dashed box on the camera preview to move the cursor. Point with one finger to move without triggering scroll.
- **Fist click:** hold a closed fist for 0.3s. The cursor locks where it was just before the fist formed.
- Open palm scrolls down, two fingers scroll up (off by default, can be switched on in settings).

### Dwell click

Hold still and it clicks. After about a third of the dwell time the cursor freezes in place, so tremor cannot move it and the click lands exactly where you see it. "Dwell steadiness" controls how much wobble still counts as holding still. Palm and two-finger scrolling are off by default, because an open hand is a natural pose and used to scroll constantly.

![Settings](\src\Docs\Images\6.jpeg)

### Custom signs

In the `my_signs.exe` panel: name a sign, choose an action (click, scroll, back/forward, tabs, a key shortcut such as `Control+L`, typed text, or any voice command such as `open youtube`), press **Record**, and hold the pose through the 3-2-1 countdown. Hold the pose for about half a second later to trigger it.

Signs and settings are saved in this browser (localStorage). Tips: use clearly different hand shapes, keep the same hand you recorded with, and record in the lighting you will use. Custom signs take priority over the built-in gestures.

![My signs and head tuning](\src\Docs\Images\7.jpeg)

### Head control (moves your real PC cursor)

Pick **Head → PC cursor**, press **Start Head Control**, and look at the middle of your screen while it calibrates (about 2s). Turn and tip your head to move the cursor across the whole screen (primary monitor, Windows only).

- **Click:** hold still; a tick sounds when the click fires (dwell, same engine as hand mode).
- **Scroll:** tilt your head to a shoulder (right = down, left = up). Turn it off in `head_tuning.cfg`.
- **Recenter:** press the button or R if your resting position drifts. **Stop:** the button, or Esc with the page focused.
- Tune horizontal/vertical sensitivity and smoothing in `head_tuning.cfg`.

### Voice and typed commands

- `search <query>`
- `scroll down` / `scroll up`, `scroll the page up`, `page down`
- `back` / `forward`
- `open result <number>`
- `pause`
- `open YouTube` (opens in the default browser)
- `open ChatGPT`, `open github.com`, or `open reddit dot com`
- `play lofi hip hop radio on YouTube` (opens the matching YouTube results)
- `open a new tab`, `close tab` or `press Control W`
- `type hello world`
- `press Control L`, `press Enter`, `press Tab`, or `press ArrowDown`

## Privacy

- Camera frames are processed in your browser and never uploaded.
- Signs and settings are saved only in this browser.
- Head control works only while it is switched on, and switches itself off within about 6 seconds if the page stops sending its heartbeat.
- Things to know: the tracking models download once from public servers; voice input uses your browser's built-in speech recognition, which in Chrome may send audio to its provider; and if you add an optional Gemini key, typed or spoken commands that the built-in rules can't parse are sent to Gemini.
- Raw audio and video are not captured or logged by default.

## Safety guards

- The hand cursor is drawn inside the controlled Chrome page at the exact spot a click lands. To also move the real Windows cursor, add `FREEHAND_OS_CURSOR=1` to `.env`.
- Tab actions are rate-limited on the server (one per 2s, max 10 tabs), so a misfiring sign cannot spam or mass-close tabs.
- A custom sign must be clearly released (or the hand removed) before it can fire again. In `my_signs.exe`, the "Closest" line shows how near your hand is to each sign, so you can tune "Sign strictness".
- PC-cursor endpoints (`/api/os/*`) are separate from voice/Gemini commands and only work while armed by the page.
- Automation runs in a separate Chrome profile (`.freehand-chrome`, git-ignored). No passwords, cookies or profile files are stored by the web app.
- Gesture actions never fire from a single frame; they need several consistent frames plus a dwell or hold time.

Tracking runs on a Web Worker timer, so it keeps working while the page is behind other windows.

## Architecture

```text
React browser UI
  ├─ MediaPipe hand + face landmarks (webcam, local in browser)
  ├─ microphone / typed commands
  └─ settings and custom signs (localStorage)
          │ HTTP
Node + TypeScript local service (Express)
  ├─ intent parser and Zod action validation (optional Gemini fallback)
  ├─ Playwright adapter driving a separate Chrome profile
  └─ Windows cursor endpoints (/api/os/*), armed by the page
```

A web page cannot control other tabs or arbitrary sites by itself. That privileged work lives in the local service, which exposes a deliberately limited API to the page.

## Project layout

| Path | What it is |
| --- | --- |
| `index.html` | Landing page (`/`) |
| `app.html` | App entry (`/app.html`), loads `src/main.tsx` |
| `src/` | React app: tracking, gestures, settings |
| `server/index.ts` | Local API: command parsing, Playwright, cursor control |
| `docs/images/` | README screenshots |

## Roadmap

The original plan targeted a modest machine (Intel i5-8400, 20 GB RAM, integrated graphics). That rules out continuous screenshot-based visual agents and large vision models, so the roadmap stays with browser-side tracking, DOM actions and small local models.

**Done**
- Local MediaPipe hand tracking with smoothing, dwell click and fist click
- Head control of the real cursor (Windows)
- Dedicated Chrome profile driven by Playwright
- Constrained command set with schema validation, plus optional Gemini parsing
- Persistent local settings and custom signs

**Planned**
1. **Offline speech:** push-to-talk audio to a local `whisper.cpp` sidecar (`/api/transcribe`), starting with quantized `base.en`; try `small.en` only after measuring latency. This replaces the browser speech API.
2. **Confirmation cards:** show each parsed action in the UI before it runs, and require confirmation for form submission, downloads, account changes, messages, purchases and typed secrets.
3. **Domain allowlist and activity feed:** limit where automation can go during development, with a per-action log and timeout/error recovery.
4. **Accessibility-tree actions:** prefer DOM/accessibility-tree interaction over screenshots, which is faster and more reliable on modest hardware.
5. **Local natural language:** an optional quantized 1–3B text model via Ollama that maps a spoken request only onto the validated action schema, rejecting invalid, ambiguous or low-confidence output and asking the user to clarify.
6. **Calibration step:** an on-screen gesture calibration flow.