# FreeHand Browser

Local-first prototype for voice- and gesture-guided browsing.

## Run locally

1. Install Node.js 22 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and add `GEMINI_API_KEY` for Gemini-powered command parsing. This is optional for direct commands such as `open YouTube`.
4. Run `npm run dev`.
5. Open `http://localhost:5173` for the landing page, or `http://localhost:5173/app.html` for the app.

The client uses MediaPipe in the browser for hand landmarks. The server currently validates browser actions but does not automate a browser yet. See [PLAN.md](./PLAN.md) for the staged implementation plan.

## Current commands

- `search <query>`
- `scroll down` / `scroll up`
- `back` / `forward`
- `open result <number>`
- `pause`
- `open YouTube` (opens in the default browser)
- `open ChatGPT`, `open github.com`, or `open reddit dot com`
- `scroll down`, `scroll the page up`, or `page down`
- `play lofi hip hop radio on YouTube` (opens the matching YouTube results)
- `open a new tab`
- `close tab` or `press Control W`
- `type hello world`
- `press Control L`, `press Enter`, `press Tab`, or `press ArrowDown`

## Hand controls

- Move your hand inside the dashed box on the camera preview to move the cursor. Point with one finger to move without triggering scroll.
- **Dwell click:** hold the cursor still; a ring fills and it clicks (default 0.9s, adjustable in `settings.cfg`).
- **Fist click:** hold a closed fist for 0.3s. The cursor locks where it was just before the fist formed.
- Open palm scrolls down, two fingers scroll up (can be switched off in settings).

## Custom signs

In the `my_signs.exe` panel: name a sign, choose an action (click, scroll, back/forward, tabs, a key shortcut such as
`Control+L`, typed text, or any voice command such as `open youtube`), press **Record**, and hold the pose through the
3-2-1 countdown. Hold the pose for about half a second later to trigger it. Signs and settings are saved in this
browser (localStorage). Tips: use clearly different hand shapes, keep the same hand you recorded with, and record in
the lighting you will use. Custom signs take priority over the built-in gestures.

## Cursor, safety guards

- The hand cursor is drawn inside the controlled Chrome page at the exact spot a click lands. To also move the real Windows cursor, add `FREEHAND_OS_CURSOR=1` to `.env`.
- Tab actions are rate-limited on the server (one per 2s, max 10 tabs), so a misfiring sign cannot spam or mass-close tabs.
- A custom sign must be clearly released (or the hand removed) before it can fire again. In `my_signs.exe`, the "Closest" line shows how near your hand is to each sign, so you can tune "Sign strictness".

## Head control (moves your real PC cursor)

Pick **Head → PC cursor**, press **Start Head Control**, and look at the middle of your screen while it calibrates (about 2s).
Turn and tip your head to move the cursor across the whole screen (primary monitor, Windows only).

- **Click:** hold still; a tick sounds when the click fires (dwell, same engine as hand mode).
- **Scroll:** tilt your head to a shoulder (right = down, left = up). Turn it off in `head_tuning.cfg`.
- **Recenter:** press the button or R if your resting position drifts. **Stop:** the button, or Esc with the page focused.
- Tune horizontal/vertical sensitivity and smoothing in `head_tuning.cfg`.
- Safety: PC-cursor endpoints (`/api/os/*`) are separate from voice/Gemini commands, only work while armed by the page,
  and disarm themselves within about 6 seconds if the page stops sending its heartbeat.

## Dwell click

Hold still and it clicks. After about a third of the dwell time the cursor freezes in place, so tremor cannot move it and
the click lands exactly where you see it. "Dwell steadiness" controls how much wobble still counts as holding still.
Palm/two-finger scrolling is off by default, because an open hand is a natural pose and used to scroll constantly.

Tracking runs on a Web Worker timer, so it keeps working while this page is behind other windows.
