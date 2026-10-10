import { useCallback, useEffect, useRef, useState } from 'react';
import { FilesetResolver, GestureRecognizer } from '@mediapipe/tasks-vision';
import { createRoot } from 'react-dom/client';
import './styles.css';

type GestureName = 'No hand' | 'Open palm' | 'Closed fist' | 'Thumbs up' | 'Two-finger point';
type BrowserAction =
  | { type: 'search'; query: string }
  | { type: 'youtube-search'; query: string }
  | { type: 'open-tab' }
  | { type: 'close-tab' }
  | { type: 'type'; text: string; pressEnter?: boolean }
  | { type: 'write'; text: string; pressEnter?: boolean }
  | { type: 'key'; key: string }
  | { type: 'scroll'; direction: 'up' | 'down' }
  | { type: 'pointer-move'; x: number; y: number }
  | { type: 'click'; x?: number; y?: number }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'open-result'; resultIndex: number }
  | { type: 'pause' };

interface BrowserSpeechRecognition extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onresult: ((event: BrowserSpeechRecognitionResultEvent) => void) | null;
  start(): void;
  stop(): void;
}

interface BrowserSpeechRecognitionResultEvent extends Event {
  results: { length: number; [index: number]: { [index: number]: { transcript: string } } };
}

interface BrowserSpeechRecognitionErrorEvent extends Event {
  error: string;
}

interface BrowserSpeechRecognitionConstructor {
  new (): BrowserSpeechRecognition;
}

const WSS_FILES_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/wasm';
const HAND_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function classifyGesture(landmarks: Array<{ x: number; y: number }>): GestureName {
  const wrist = landmarks[0];
  const thumbTip = landmarks[4];
  const indexTip = landmarks[8];
  const middleTip = landmarks[12];
  const ringTip = landmarks[16];
  const pinkyTip = landmarks[20];
  const handScale = Math.max(distance(wrist, middleTip), 0.01);

  const raisedFingers = [indexTip, middleTip, ringTip, pinkyTip].filter(
    (tip) => tip.y < landmarks[tip === indexTip ? 6 : tip === middleTip ? 10 : tip === ringTip ? 14 : 18].y,
  ).length;

  if (raisedFingers >= 4) return 'Open palm';
  if (indexTip.y < landmarks[6].y && middleTip.y < landmarks[10].y) return 'Two-finger point';
  return 'No hand';
}

function recognizedGesture(categoryName: string | undefined, landmarks: Array<{ x: number; y: number }>): GestureName {
  const recognized: Record<string, GestureName> = {
    Closed_Fist: 'Closed fist',
    Open_Palm: 'Open palm',
    Thumb_Up: 'Thumbs up',
    Victory: 'Two-finger point',
  };
  return recognized[categoryName ?? ''] ?? classifyGesture(landmarks);
}



type SignActionKind =
  | 'scroll-up' | 'scroll-down' | 'click' | 'back' | 'forward'
  | 'new-tab' | 'close-tab' | 'key' | 'type' | 'command' | 'toggle-dwell';

interface Sign {
  id: string;
  name: string;
  kind: SignActionKind;
  param: string;
  repeat: boolean;
  samples: number[][];
}

interface Settings {
  signsEnabled: boolean;
  dwellEnabled: boolean;
  dwellMs: number;
  fistClick: boolean;
  scrollGestures: boolean;
  smoothing: number; // 1 (snappy) .. 10 (very smooth)
  signThreshold: number; // lower = stricter matching
  signHoldMs: number;
}

const DEFAULT_SETTINGS: Settings = {
  signsEnabled: true,
  dwellEnabled: true,
  dwellMs: 900,
  fistClick: true,
  scrollGestures: true,
  smoothing: 7,
  signThreshold: 0.22,
  signHoldMs: 450,
};

const ACTION_OPTIONS: Array<{ kind: SignActionKind; label: string; needs?: 'key' | 'text' | 'command' }> = [
  { kind: 'click', label: 'Click at cursor' },
  { kind: 'scroll-down', label: 'Scroll down' },
  { kind: 'scroll-up', label: 'Scroll up' },
  { kind: 'back', label: 'Go back' },
  { kind: 'forward', label: 'Go forward' },
  { kind: 'new-tab', label: 'New tab' },
  { kind: 'close-tab', label: 'Close tab' },
  { kind: 'key', label: 'Press a key / shortcut', needs: 'key' },
  { kind: 'type', label: 'Type some text', needs: 'text' },
  { kind: 'command', label: 'Run a command (like voice)', needs: 'command' },
  { kind: 'toggle-dwell', label: 'Toggle dwell click' },
];

const PARAM_HINT: Record<'key' | 'text' | 'command', string> = {
  key: 'e.g. Control+L or Enter',
  text: 'text to type',
  command: 'e.g. open youtube',
};

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? ({ ...(typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : {}), ...JSON.parse(raw) } as T) : fallback;
  } catch {
    return fallback;
  }
}

function loadSigns(): Sign[] {
  try {
    const raw = localStorage.getItem('freehand.signs');
    const parsed = raw ? (JSON.parse(raw) as Sign[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ---- Custom signs: pose fingerprints --------------------------------------
// A pose is the 20 non-wrist landmarks relative to the wrist, divided by hand size, so it does not
// depend on how far you are from the camera or where your hand is in the frame.
function poseVector(lm: Array<{ x: number; y: number; z: number }>): number[] {
  const w = lm[0];
  const scale = Math.max(Math.hypot(lm[9].x - w.x, lm[9].y - w.y), 0.01);
  const out: number[] = [];
  for (let i = 1; i < 21; i += 1) {
    out.push((lm[i].x - w.x) / scale, (lm[i].y - w.y) / scale, ((lm[i].z - w.z) / scale) * 0.5);
  }
  return out.map((v) => Math.round(v * 1000) / 1000);
}

// RMS distance across landmarks, so one finger being different still counts clearly.
function poseDistance(a: number[], b: number[]) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 3) {
    const dx = a[i] - b[i];
    const dy = a[i + 1] - b[i + 1];
    const dz = a[i + 2] - b[i + 2];
    sum += dx * dx + dy * dy + dz * dz;
  }
  return Math.sqrt(sum / (a.length / 3));
}

function signDistance(vec: number[], sign: Sign) {
  let d = Infinity;
  for (const sample of sign.samples) d = Math.min(d, poseDistance(vec, sample));
  return d;
}

// Signs that keep acting while held (or are harmless to repeat) get shorter holds and cooldowns.
const isContinuous = (sign: Sign) => sign.kind === 'click' || sign.kind === 'scroll-up' || sign.kind === 'scroll-down';

function pickEvenly<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  return Array.from({ length: count }, (_, i) => items[Math.floor((i * (items.length - 1)) / (count - 1))]);
}

// ---- Cursor stabilisation -------------------------------------------------
// One Euro filter: heavy smoothing when the hand is slow (kills jitter),
// light smoothing when it moves fast (keeps the cursor responsive).
class OneEuro {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;
  constructor(public minCutoff = 1.2, private beta = 6, private dCutoff = 1) {}

  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  reset() {
    this.xPrev = null;
  }

  filter(x: number, tMs: number) {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.dxPrev = 0;
      this.tPrev = tMs;
      return x;
    }
    const dt = Math.max((tMs - this.tPrev) / 1000, 1 / 120);
    this.tPrev = tMs;
    const dx = (x - this.xPrev) / dt;
    const dxHat = this.dxPrev + OneEuro.alpha(this.dCutoff, dt) * (dx - this.dxPrev);
    this.dxPrev = dxHat;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const xHat = this.xPrev + OneEuro.alpha(cutoff, dt) * (x - this.xPrev);
    this.xPrev = xHat;
    return xHat;
  }
}

// Only the middle of the camera frame maps to the screen, so the screen edges
// are reachable without stretching your arm out of frame.
const REGION = { x0: 0.18, x1: 0.82, y0: 0.14, y1: 0.78 };
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const toScreen = (cx: number, cy: number) => ({
  x: clamp01((cx - REGION.x0) / (REGION.x1 - REGION.x0)),
  y: clamp01((cy - REGION.y0) / (REGION.y1 - REGION.y0)),
});

const POINTER_INTERVAL_MS = 33; // ~30 Hz
const POINTER_DEADZONE = 0.0025; // fraction of screen; ignores sub-pixel wobble
const CLICK_LOOKBACK_MS = 350; // click where the hand was BEFORE the fist formed
const CLICK_DWELL_MS = 300;
const GESTURE_CONFIRM_FRAMES = 3;
const DWELL_RADIUS = 0.018; // how still (fraction of screen) the cursor must stay to dwell-click
const SIGN_CONFIRM_FRAMES = 4; // frames a pose must match before the sign activates
const SIGN_EXIT_FRAMES = 6; // frames of mismatch before an active sign is dropped
const SIGN_EXIT_FACTOR = 1.4; // an active sign tolerates a looser match than it needed to start
const SIGN_RELEASE_FACTOR = 1.8; // after firing, the pose must be at least this far off...
const SIGN_RELEASE_MS = 500; // ...for this long before the sign can fire again
const DISCRETE_HOLD_MS = 700; // tab/key/text/command signs need a longer deliberate hold
const DISCRETE_COOLDOWN_MS = 2000; // and a cooldown after any sign fires
const RECORD_COUNTDOWN = 3;
const RECORD_MS = 1600;

function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const landmarkerRef = useRef<GestureRecognizer | null>(null);
  const animationRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const autoListenRef = useRef(false);

  const lastGestureRef = useRef<GestureName>('No hand');
  const gestureStartTimeRef = useRef<number>(0);
  const lastActionTimeRef = useRef<number>(0);
  const lastPointerTimeRef = useRef<number>(0);
  const clickReadyRef = useRef(true);
  const cursorElRef = useRef<HTMLDivElement>(null);
  const filterX = useRef(new OneEuro());
  const filterY = useRef(new OneEuro());
  const historyRef = useRef<Array<{ t: number; x: number; y: number }>>([]);
  const lastSentRef = useRef<{ x: number; y: number } | null>(null);
  const pointerBusyRef = useRef(false);
  const lockedPosRef = useRef<{ x: number; y: number } | null>(null);
  const candidateRef = useRef<{ g: GestureName; n: number }>({ g: 'No hand', n: 0 });
  const handLostAtRef = useRef(0);
  const lastVideoTimeRef = useRef(-1);

  // dwell click
  const dwellRef = useRef<{ x: number; y: number; since: number; armed: boolean } | null>(null);

  // custom signs
  const signCandRef = useRef<{ id: string | null; n: number }>({ id: null, n: 0 });
  const activeSignRef = useRef<string | null>(null);
  const signSinceRef = useRef(0);
  const signFiredRef = useRef(false);
  const signLastFireRef = useRef(0);
  const signMissRef = useRef(0);
  const signCooldownUntilRef = useRef(0);
  const signDebugAtRef = useRef(0);
  const signStateRef = useRef(new Map<string, { needsRelease: boolean; farSince: number | null }>());
  const recordRef = useRef<{ phase: 'idle' | 'countdown' | 'capturing'; frames: number[][] }>({ phase: 'idle', frames: [] });
  const timersRef = useRef<number[]>([]);

  const [cameraState, setCameraState] = useState<'idle' | 'starting' | 'ready' | 'error'>('idle');
  const [gesture, setGesture] = useState<GestureName>('No hand');
  const [command, setCommand] = useState('');
  const [lastAction, setLastAction] = useState('No browser action sent yet.');
  const [actionTimestamp, setActionTimestamp] = useState<string>('');
  const [listening, setListening] = useState(false);

  const [settings, setSettings] = useState<Settings>(() => loadJson('freehand.settings', DEFAULT_SETTINGS));
  const [signs, setSigns] = useState<Sign[]>(loadSigns);
  const [activeSignId, setActiveSignId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; kind: SignActionKind; param: string; repeat: boolean }>({
    name: '',
    kind: 'click',
    param: '',
    repeat: false,
  });
  const [rec, setRec] = useState<{ phase: 'idle' | 'countdown' | 'capturing'; count: number }>({ phase: 'idle', count: 0 });
  const [signMessage, setSignMessage] = useState('');
  const [signDebug, setSignDebug] = useState<{ name: string; d: number } | null>(null);

  // The video loop reads these refs, so it always sees the latest values without restarting.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const signsRef = useRef(signs);
  signsRef.current = signs;
  const fireSignRef = useRef<(sign: Sign) => void>(() => undefined);

  useEffect(() => {
    try { localStorage.setItem('freehand.settings', JSON.stringify(settings)); } catch { /* storage full or blocked */ }
    const cutoff = 2.5 - (settings.smoothing - 1) * 0.2;
    filterX.current.minCutoff = cutoff;
    filterY.current.minCutoff = cutoff;
  }, [settings]);

  useEffect(() => {
    try { localStorage.setItem('freehand.signs', JSON.stringify(signs)); } catch { /* storage full or blocked */ }
  }, [signs]);

  const updateSetting = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }));

  const stopCamera = useCallback(() => {
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    landmarkerRef.current?.close();
    landmarkerRef.current = null;
    setCameraState('idle');
    setGesture('No hand');
    setActiveSignId(null);
    activeSignRef.current = null;
    if (cursorElRef.current) cursorElRef.current.style.opacity = '0';
  }, []);

  const sendAction = useCallback(async (action: BrowserAction, reportResult = true) => {
    try {
      const response = await fetch('/api/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action),
      });
      const result = (await response.json()) as { message?: string; error?: string };
      if (reportResult) {
        setLastAction(result.message ?? result.error ?? 'Action sent to local browser service.');
        setActionTimestamp(new Date().toLocaleTimeString());
      }
    } catch {
      setLastAction('Could not reach the local browser service.');
    }
  }, []);

  const runCommand = useCallback(async (spokenCommand: string) => {
    if (!spokenCommand.trim()) return;
    setLastAction(`Running “${spokenCommand}”…`);
    setActionTimestamp(new Date().toLocaleTimeString());
    try {
      const response = await fetch('/api/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: spokenCommand }),
      });
      const result = (await response.json()) as { message?: string; error?: string };
      setLastAction(result.message ?? result.error ?? 'The local service did not return a result.');
      setActionTimestamp(new Date().toLocaleTimeString());
    } catch {
      setLastAction('Could not reach the local browser service. Is `npm run dev` still running?');
    }
  }, []);

  fireSignRef.current = (sign: Sign) => {
    const at = lastSentRef.current ?? undefined;
    switch (sign.kind) {
      case 'click': void sendAction({ type: 'click', x: at?.x, y: at?.y }); break;
      case 'scroll-down': void sendAction({ type: 'scroll', direction: 'down' }); break;
      case 'scroll-up': void sendAction({ type: 'scroll', direction: 'up' }); break;
      case 'back': void sendAction({ type: 'back' }); break;
      case 'forward': void sendAction({ type: 'forward' }); break;
      case 'new-tab': void sendAction({ type: 'open-tab' }); break;
      case 'close-tab': void sendAction({ type: 'close-tab' }); break;
      case 'key': void sendAction({ type: 'key', key: sign.param }); break;
      case 'type': void sendAction({ type: 'type', text: sign.param }); break;
      case 'command': void runCommand(sign.param); break;
      case 'toggle-dwell':
        setSettings((prev) => ({ ...prev, dwellEnabled: !prev.dwellEnabled }));
        setLastAction('Toggled dwell click.');
        setActionTimestamp(new Date().toLocaleTimeString());
        break;
    }
  };

  const detectHands = useCallback(() => {
    const video = videoRef.current;
    const landmarker = landmarkerRef.current;
    if (!video || !landmarker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      animationRef.current = requestAnimationFrame(detectHands);
      return;
    }
    // The camera runs slower than the screen refresh; processing the same frame twice only adds noise.
    if (video.currentTime === lastVideoTimeRef.current) {
      animationRef.current = requestAnimationFrame(detectHands);
      return;
    }
    lastVideoTimeRef.current = video.currentTime;

    const cfg = settingsRef.current;
    const now = performance.now();
    const results = landmarker.recognizeForVideo(video, now);
    const landmarks = results.landmarks[0];
    const recording = recordRef.current.phase !== 'idle';

    // ---- built-in gesture, debounced ----
    const rawGesture = landmarks
      ? recognizedGesture(results.gestures[0]?.[0]?.categoryName, landmarks)
      : 'No hand';
    const cand = candidateRef.current;
    if (rawGesture === cand.g) cand.n += 1;
    else candidateRef.current = { g: rawGesture, n: 1 };
    const confirmed = candidateRef.current.n >= GESTURE_CONFIRM_FRAMES;
    const currentGesture = confirmed ? candidateRef.current.g : lastGestureRef.current;
    setGesture((prev) => (prev === currentGesture ? prev : currentGesture));

    // ---- custom signs: sticky activation, release before re-arming, cooldowns ----
    const vec = landmarks ? poseVector(landmarks) : null;
    if (vec && recordRef.current.phase === 'capturing' && recordRef.current.frames.length < 80) {
      recordRef.current.frames.push(vec);
    }
    const T = cfg.signThreshold;
    const allSigns = signsRef.current;
    const signsOn = cfg.signsEnabled && !recording && allSigns.length > 0;
    const dists = vec && signsOn ? allSigns.map((sign) => ({ sign, d: signDistance(vec, sign) })) : [];

    const deactivateSign = () => {
      activeSignRef.current = null;
      signMissRef.current = 0;
      signCandRef.current = { id: null, n: 0 };
      setActiveSignId(null);
    };

    // A sign that just fired must be clearly left (or the hand removed) before it can fire again.
    // Borderline poses that flicker in and out of a match therefore can never re-trigger it.
    for (const sign of allSigns) {
      const st = signStateRef.current.get(sign.id);
      if (!st || !st.needsRelease) continue;
      const entry = dists.find((x) => x.sign.id === sign.id);
      if (!vec || !entry || entry.d > T * SIGN_RELEASE_FACTOR) {
        st.farSince ??= now;
        if (now - st.farSince >= SIGN_RELEASE_MS) {
          st.needsRelease = false;
          st.farSince = null;
        }
      } else {
        st.farSince = null;
      }
    }

    let active = activeSignRef.current ? allSigns.find((sign) => sign.id === activeSignRef.current) ?? null : null;
    if (activeSignRef.current && (!active || !signsOn)) {
      deactivateSign();
      active = null;
    }

    if (active) {
      const entry = dists.find((x) => x.sign.id === active!.id);
      if (entry && entry.d <= T * SIGN_EXIT_FACTOR) signMissRef.current = 0;
      else signMissRef.current += 1;
      if (signMissRef.current >= SIGN_EXIT_FRAMES) {
        deactivateSign();
        active = null;
      }
    } else if (dists.length) {
      const sorted = [...dists].sort((x, y) => x.d - y.d);
      const best = sorted.find((x) => x.d <= T && !signStateRef.current.get(x.sign.id)?.needsRelease);
      const runnerUp = best ? sorted.find((x) => x.sign.id !== best.sign.id)?.d ?? Infinity : Infinity;
      if (best && runnerUp - best.d >= 0.03) {
        if (signCandRef.current.id === best.sign.id) signCandRef.current.n += 1;
        else signCandRef.current = { id: best.sign.id, n: 1 };
        if (signCandRef.current.n >= SIGN_CONFIRM_FRAMES) {
          activeSignRef.current = best.sign.id;
          active = best.sign;
          signSinceRef.current = now;
          signFiredRef.current = false;
          signMissRef.current = 0;
          setActiveSignId(best.sign.id);
        }
      } else {
        signCandRef.current = { id: null, n: 0 };
      }
    }

    if (active) {
      const hold = isContinuous(active) ? cfg.signHoldMs : Math.max(cfg.signHoldMs, DISCRETE_HOLD_MS);
      const due = !signFiredRef.current || (active.repeat && now - signLastFireRef.current >= 700);
      if (now - signSinceRef.current >= hold && due && now >= signCooldownUntilRef.current) {
        signFiredRef.current = true;
        signLastFireRef.current = now;
        signCooldownUntilRef.current = active.repeat ? 0 : now + (isContinuous(active) ? 500 : DISCRETE_COOLDOWN_MS);
        if (!active.repeat) signStateRef.current.set(active.id, { needsRelease: true, farSince: null });
        fireSignRef.current(active);
      }
    }
    const activeSign = active;

    // Live readout of the closest sign so you can see why something matched (or didn't).
    if (now - signDebugAtRef.current > 250) {
      signDebugAtRef.current = now;
      const nearest = dists.length ? dists.reduce((x, y) => (x.d <= y.d ? x : y)) : null;
      const next = nearest ? { name: nearest.sign.name, d: Math.round(nearest.d * 100) / 100 } : null;
      setSignDebug((prev) => (prev?.name === next?.name && prev?.d === next?.d ? prev : next));
    }

    // ---- cursor ----
    const cursorEl = cursorElRef.current;
    const fistFreezes = currentGesture === 'Closed fist' && cfg.fistClick;
    const frozen = fistFreezes || Boolean(activeSign) || recording;

    if (landmarks) {
      if (now - handLostAtRef.current > 400) {
        filterX.current.reset();
        filterY.current.reset();
        historyRef.current = [];
        dwellRef.current = null;
      }
      handLostAtRef.current = now;

      // Knuckles barely move when you close your hand, unlike the fingertip.
      const rawX = 1 - (landmarks[5].x + landmarks[9].x) / 2; // mirrored preview
      const rawY = (landmarks[5].y + landmarks[9].y) / 2;
      const fx = filterX.current.filter(rawX, now);
      const fy = filterY.current.filter(rawY, now);

      const history = historyRef.current;
      history.push({ t: now, x: fx, y: fy });
      while (history.length && now - history[0].t > 1000) history.shift();

      if (cursorEl) {
        cursorEl.style.opacity = '1';
        cursorEl.style.left = `${fx * 100}%`;
        cursorEl.style.top = `${fy * 100}%`;
      }

      const target = toScreen(fx, fy);
      if (!frozen && now - lastPointerTimeRef.current >= POINTER_INTERVAL_MS && !pointerBusyRef.current) {
        const last = lastSentRef.current;
        if (!last || Math.hypot(target.x - last.x, target.y - last.y) > POINTER_DEADZONE) {
          lastPointerTimeRef.current = now;
          lastSentRef.current = target;
          pointerBusyRef.current = true;
          void sendAction({ type: 'pointer-move', x: target.x, y: target.y }, false).finally(() => {
            pointerBusyRef.current = false;
          });
        }
      }

      // ---- dwell click: hold the cursor still to click ----
      const isScrollPose = currentGesture === 'Open palm' || currentGesture === 'Two-finger point';
      const dwellEligible = cfg.dwellEnabled && !frozen && !(isScrollPose && cfg.scrollGestures);
      let progress = 0;
      if (dwellEligible) {
        let anchor = dwellRef.current;
        if (!anchor || Math.hypot(target.x - anchor.x, target.y - anchor.y) > DWELL_RADIUS) {
          anchor = { x: target.x, y: target.y, since: now, armed: true };
          dwellRef.current = anchor;
        }
        if (anchor.armed) {
          progress = Math.min(1, (now - anchor.since) / cfg.dwellMs);
          if (progress >= 1) {
            anchor.armed = false;
            progress = 0;
            lastActionTimeRef.current = now;
            // Click where the cursor visibly is, not where the dwell started.
            const at = lastSentRef.current ?? { x: anchor.x, y: anchor.y };
            cursorEl?.classList.add('click');
            window.setTimeout(() => cursorEl?.classList.remove('click'), 250);
            void sendAction({ type: 'click', x: at.x, y: at.y });
          }
        }
      } else {
        dwellRef.current = null;
      }
      cursorEl?.style.setProperty('--p', `${progress * 360}deg`);
      cursorEl?.style.setProperty('--ring', progress > 0.04 ? '1' : '0');
    } else if (cursorEl) {
      cursorEl.style.opacity = '0';
      dwellRef.current = null;
    }

    // ---- built-in gesture actions ----
    if (currentGesture !== lastGestureRef.current) {
      lastGestureRef.current = currentGesture;
      gestureStartTimeRef.current = now;
      if (currentGesture === 'Closed fist') {
        // Lock the click target to where the cursor was just before the fist formed.
        const hist = historyRef.current;
        let pick = hist[hist.length - 1];
        for (let i = hist.length - 1; i >= 0; i -= 1) {
          if (now - hist[i].t >= CLICK_LOOKBACK_MS) {
            pick = hist[i];
            break;
          }
        }
        if (pick) lockedPosRef.current = toScreen(pick.x, pick.y);
      } else {
        clickReadyRef.current = true;
        lockedPosRef.current = null;
      }
    } else if (currentGesture !== 'No hand' && !activeSign && !recording) {
      const dwellTime = now - gestureStartTimeRef.current;
      const timeSinceLastAction = now - lastActionTimeRef.current;

      if (currentGesture === 'Closed fist') {
        const target = lockedPosRef.current;
        if (cfg.fistClick && clickReadyRef.current && dwellTime >= CLICK_DWELL_MS && timeSinceLastAction >= 450 && target) {
          clickReadyRef.current = false;
          lastActionTimeRef.current = now;
          lastSentRef.current = target;
          cursorEl?.classList.add('click');
          window.setTimeout(() => cursorEl?.classList.remove('click'), 250);
          void sendAction({ type: 'click', x: target.x, y: target.y });
        }
      } else if (cfg.scrollGestures && dwellTime >= 300 && timeSinceLastAction >= 650) {
        if (currentGesture === 'Open palm') {
          lastActionTimeRef.current = now;
          void sendAction({ type: 'scroll', direction: 'down' });
        } else if (currentGesture === 'Two-finger point') {
          lastActionTimeRef.current = now;
          void sendAction({ type: 'scroll', direction: 'up' });
        }
      }
    }

    animationRef.current = requestAnimationFrame(detectHands);
  }, [sendAction]);

  const startCamera = useCallback(async () => {
    try {
      setCameraState('starting');
      const [vision, stream] = await Promise.all([
        FilesetResolver.forVisionTasks(WSS_FILES_URL),
        navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 }, audio: false }),
      ]);
      const landmarker = await GestureRecognizer.createFromOptions(vision, {
        baseOptions: { modelAssetPath: HAND_MODEL_URL },
        runningMode: 'VIDEO',
        numHands: 1,
      });

      streamRef.current = stream;
      landmarkerRef.current = landmarker;
      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      lastVideoTimeRef.current = -1;
      setCameraState('ready');
      animationRef.current = requestAnimationFrame(detectHands);
    } catch (error) {
      console.error(error);
      setCameraState('error');
    }
  }, [detectHands]);

  useEffect(() => () => {
    autoListenRef.current = false;
    recognitionRef.current?.stop();
    timersRef.current.forEach((id) => window.clearTimeout(id));
    stopCamera();
  }, [stopCamera]);

  // ---- sign recording ----
  const needsParam = ACTION_OPTIONS.find((option) => option.kind === draft.kind)?.needs;
  const canRepeat = draft.kind === 'scroll-down' || draft.kind === 'scroll-up' || draft.kind === 'key';

  function finishRecording() {
    const frames = recordRef.current.frames;
    recordRef.current = { phase: 'idle', frames: [] };
    setRec({ phase: 'idle', count: 0 });

    if (frames.length < 15) {
      setSignMessage('I could not see your hand clearly. Keep it in frame and try again.');
      return;
    }
    // Reject shaky recordings: samples should cluster tightly around their average.
    const centroid = frames[0].map((_, i) => frames.reduce((sum, f) => sum + f[i], 0) / frames.length);
    const spread = frames.reduce((sum, f) => sum + poseDistance(f, centroid), 0) / frames.length;
    if (spread > 0.2) {
      setSignMessage('Your hand moved too much while recording. Hold the pose steady and try again.');
      return;
    }
    const samples = pickEvenly(frames, 24);
    const cfg = settingsRef.current;
    for (const sign of signsRef.current) {
      const d = Math.min(...sign.samples.map((sample) => poseDistance(centroid, sample)));
      if (d < cfg.signThreshold * 1.2) {
        setSignMessage(`That pose is too similar to “${sign.name}”. Pick a clearly different hand shape.`);
        return;
      }
    }
    const name = draft.name.trim() || `Sign ${signsRef.current.length + 1}`;
    setSigns((prev) => [...prev, { id: crypto.randomUUID(), name, kind: draft.kind, param: draft.param.trim(), repeat: canRepeat && draft.repeat, samples }]);
    setDraft((prev) => ({ ...prev, name: '', param: '' }));
    setSignMessage(`Saved “${name}”. Hold the pose to try it.`);
  }

  function startRecording() {
    if (cameraState !== 'ready') {
      setSignMessage('Turn the camera on first.');
      return;
    }
    if (needsParam && !draft.param.trim()) {
      setSignMessage('Fill in the value for this action first.');
      return;
    }
    setSignMessage('');
    activeSignRef.current = null;
    setActiveSignId(null);
    recordRef.current = { phase: 'countdown', frames: [] };
    let count = RECORD_COUNTDOWN;
    setRec({ phase: 'countdown', count });
    const tick = () => {
      count -= 1;
      if (count > 0) {
        setRec({ phase: 'countdown', count });
        timersRef.current.push(window.setTimeout(tick, 1000));
      } else {
        recordRef.current = { phase: 'capturing', frames: [] };
        setRec({ phase: 'capturing', count: 0 });
        timersRef.current.push(window.setTimeout(finishRecording, RECORD_MS));
      }
    };
    timersRef.current.push(window.setTimeout(tick, 1000));
  }

  function cancelRecording() {
    timersRef.current.forEach((id) => window.clearTimeout(id));
    timersRef.current = [];
    recordRef.current = { phase: 'idle', frames: [] };
    setRec({ phase: 'idle', count: 0 });
    setSignMessage('Recording cancelled.');
  }

  function deleteSign(id: string) {
    setSigns((prev) => prev.filter((sign) => sign.id !== id));
    if (activeSignRef.current === id) {
      activeSignRef.current = null;
      setActiveSignId(null);
    }
  }

  function parseCommand() {
    void runCommand(command);
  }

  function handleChipClick(chipCommand: string) {
    setCommand(chipCommand);
    void runCommand(chipCommand);
  }

  function toggleHandsFreeListening() {
    if (autoListenRef.current) {
      autoListenRef.current = false;
      recognitionRef.current?.stop();
      return;
    }

    const SpeechRecognitionConstructor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SpeechRecognitionConstructor) {
      setLastAction('Browser speech recognition is unavailable in this browser.');
      return;
    }

    const recognition = new SpeechRecognitionConstructor();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.continuous = true;
    autoListenRef.current = true;
    recognitionRef.current = recognition;
    recognition.onstart = () => setListening(true);
    recognition.onend = () => {
      if (!autoListenRef.current) {
        setListening(false);
        return;
      }
      window.setTimeout(() => recognition.start(), 250);
    };
    recognition.onerror = (event) => {
      if (event.error === 'no-speech') return;

      autoListenRef.current = false;
      setListening(false);
      const message = event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? 'Microphone permission was denied. Allow microphone access for localhost.'
        : `Voice recognition stopped: ${event.error}.`;
      setLastAction(message);
    };
    recognition.onresult = (event) => {
      const transcript = event.results[event.results.length - 1][0].transcript;
      setCommand(transcript);
      void runCommand(transcript);
    };
    recognition.start();
  }

  const activeSign = signs.find((sign) => sign.id === activeSignId) ?? null;
  const gestureLabel = (g: GestureName) => {
    switch (g) {
      case 'Open palm': return settings.scrollGestures ? 'Open palm · scroll down' : 'Open palm';
      case 'Two-finger point': return settings.scrollGestures ? 'Two fingers · scroll up' : 'Two fingers';
      case 'Closed fist': return settings.fistClick ? 'Fist · click' : 'Fist';
      case 'Thumbs up': return 'Thumbs up';
      default: return 'Pointing / idle';
    }
  };
  const statusLabel = cameraState === 'ready' ? 'CAMERA ON' : cameraState.toUpperCase();
  const actionLabel = (sign: Sign) => {
    const base = ACTION_OPTIONS.find((option) => option.kind === sign.kind)?.label ?? sign.kind;
    return sign.param ? `${base}: ${sign.param}` : base;
  };

  return (
    <main>
      <header>
        <div className="sticker"><span className="pixel-heart" /> LOCAL-FIRST</div>
        <h1>FREEHAND</h1>
        <p className="subtitle">
          Browse with your hand and your voice. Everything runs on your machine.
        </p>
      </header>

      <section className="grid">
        <article className="win teal">
          <div className="titlebar">
            <span>hand_control.exe</span>
            <span className="winbtns"><i>_</i><i>□</i><i>×</i></span>
          </div>
          <div className="win-body">
            <div className="row between">
              <span className={`status ${cameraState}`}>● {statusLabel}</span>
              <span className={`gesture ${activeSign || gesture !== 'No hand' ? 'active' : ''}`}>
                {activeSign ? `Sign · ${activeSign.name}` : gestureLabel(gesture)}
              </span>
            </div>

            <div className="video-wrap">
              <video ref={videoRef} muted playsInline />
              <div className="region-box" title="Keep your hand inside this box" />
              <div className="cursor-dot" ref={cursorElRef}>
                <div className="dwell-ring" />
                <svg viewBox="0 0 16 22" width="22" height="30" aria-hidden="true">
                  <path d="M1 1 L1 17 L5 13 L8 20 L11 18.5 L8 12 L14 12 Z" fill="#f5ecd9" stroke="#3a2622" strokeWidth="1.6" strokeLinejoin="round" />
                </svg>
              </div>
              {cameraState !== 'ready' && <div className="video-empty">NO SIGNAL</div>}
              {rec.phase !== 'idle' && (
                <div className="rec-overlay">
                  <span className="rec-dot" />
                  {rec.phase === 'countdown' ? <b>{rec.count}</b> : <b>HOLD</b>}
                  <small>{rec.phase === 'countdown' ? 'get your pose ready' : 'keep it steady'}</small>
                </div>
              )}
            </div>

            <ul className="howto">
              <li><b>Move</b> your hand inside the dashed box.</li>
              <li><b>Click</b> by holding still {settings.dwellEnabled ? `for ${(settings.dwellMs / 1000).toFixed(1)}s (watch the ring fill)` : '(dwell is off)'}{settings.fistClick ? ', or hold a fist 0.3s' : ''}.</li>
              <li><b>Scroll</b> {settings.scrollGestures ? 'with open palm (down) or two fingers (up). Point with one finger to move without scrolling.' : 'with your own signs or voice (gesture scroll is off).'}</li>
            </ul>

            <button onClick={cameraState === 'ready' ? stopCamera : startCamera} disabled={cameraState === 'starting'}>
              {cameraState === 'ready' ? 'Stop Camera' : cameraState === 'starting' ? 'Starting…' : 'Enable Camera Control'}
            </button>
          </div>
        </article>

        <article className="win yellow">
          <div className="titlebar">
            <span>voice_commands.exe</span>
            <span className="winbtns"><i>_</i><i>□</i><i>×</i></span>
          </div>
          <div className="win-body">
            <label htmlFor="command">Spoken or typed command</label>
            <div className="command-row">
              <input
                id="command"
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && parseCommand()}
                placeholder="e.g. open youtube"
              />
              <button className={`secondary ${listening ? 'listening' : ''}`} onClick={toggleHandsFreeListening}>
                {listening ? '■ Stop' : '● Voice'}
              </button>
            </div>

            <button className="wide" onClick={parseCommand}>Execute</button>

            <div className="chips-label">Quick actions</div>
            <div className="chips-grid">
              <button className="chip" onClick={() => handleChipClick('open youtube')}>▶ YouTube</button>
              <button className="chip" onClick={() => handleChipClick('open google')}>⌕ Google</button>
              <button className="chip" onClick={() => handleChipClick('open a new tab')}>+ New tab</button>
              <button className="chip" onClick={() => handleChipClick('scroll down')}>↓ Scroll down</button>
              <button className="chip" onClick={() => handleChipClick('scroll up')}>↑ Scroll up</button>
              <button className="chip" onClick={() => handleChipClick('press enter')}>↵ Enter</button>
            </div>

            <div className="activity">
              <div className="activity-header">
                <span>Local service output</span>
                {actionTimestamp && <span>{actionTimestamp}</span>}
              </div>
              <strong>{lastAction}</strong>
            </div>
          </div>
        </article>
      </section>

      <section className="grid">
        <article className="win coral">
          <div className="titlebar">
            <span>my_signs.exe</span>
            <span className="winbtns"><i>_</i><i>□</i><i>×</i></span>
          </div>
          <div className="win-body">
            <p className="blurb">
              Teach FreeHand your own hand signs. Hold a pose, and it runs the action you pick. Custom signs take
              priority over the built-in gestures.
            </p>

            {signs.length === 0 ? (
              <div className="empty">No signs yet. Record one below.</div>
            ) : (
              <ul className="sign-list">
                {signs.map((sign) => (
                  <li key={sign.id} className={sign.id === activeSignId ? 'sign active' : 'sign'}>
                    <div>
                      <strong>{sign.name}</strong>
                      <small>{actionLabel(sign)}{sign.repeat ? ' · repeats while held' : ''}</small>
                    </div>
                    <button className="mini" onClick={() => deleteSign(sign.id)} aria-label={`Delete ${sign.name}`}>×</button>
                  </li>
                ))}
              </ul>
            )}

            <div className="form">
              <label htmlFor="sign-name">Sign name</label>
              <input id="sign-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Rock on" />

              <label htmlFor="sign-action">When I hold this sign…</label>
              <select id="sign-action" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as SignActionKind, repeat: false })}>
                {ACTION_OPTIONS.map((option) => <option key={option.kind} value={option.kind}>{option.label}</option>)}
              </select>

              {needsParam && (
                <input
                  aria-label="Action value"
                  value={draft.param}
                  onChange={(e) => setDraft({ ...draft, param: e.target.value })}
                  placeholder={PARAM_HINT[needsParam]}
                />
              )}

              {canRepeat && (
                <label className="check">
                  <input type="checkbox" checked={draft.repeat} onChange={(e) => setDraft({ ...draft, repeat: e.target.checked })} />
                  Repeat while I keep holding it
                </label>
              )}

              {rec.phase === 'idle' ? (
                <button className="wide" onClick={startRecording}>● Record sign (3s countdown)</button>
              ) : (
                <button className="wide" onClick={cancelRecording}>■ Cancel recording</button>
              )}
              {signMessage && <div className="note">{signMessage}</div>}
              {signs.length > 0 && (
                <div className="note dim">
                  {signDebug
                    ? `Closest: ${signDebug.name} · distance ${signDebug.d.toFixed(2)} (matches at ≤ ${settings.signThreshold.toFixed(2)})`
                    : 'Closest sign: show your hand to see how near each pose is.'}
                </div>
              )}
            </div>
          </div>
        </article>

        <article className="win green">
          <div className="titlebar">
            <span>settings.cfg</span>
            <span className="winbtns"><i>_</i><i>□</i><i>×</i></span>
          </div>
          <div className="win-body">
            <label className="check">
              <input type="checkbox" checked={settings.signsEnabled} onChange={(e) => updateSetting('signsEnabled', e.target.checked)} />
              Custom signs on
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.dwellEnabled} onChange={(e) => updateSetting('dwellEnabled', e.target.checked)} />
              Dwell click (hold still to click)
            </label>
            <label className="slider" htmlFor="dwell-ms">
              <span>Dwell time <b>{(settings.dwellMs / 1000).toFixed(1)}s</b></span>
              <input id="dwell-ms" type="range" min={400} max={2000} step={100} value={settings.dwellMs} onChange={(e) => updateSetting('dwellMs', Number(e.target.value))} />
            </label>

            <label className="check">
              <input type="checkbox" checked={settings.fistClick} onChange={(e) => updateSetting('fistClick', e.target.checked)} />
              Fist click
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.scrollGestures} onChange={(e) => updateSetting('scrollGestures', e.target.checked)} />
              Palm / two-finger scrolling
            </label>

            <label className="slider" htmlFor="smoothing">
              <span>Cursor smoothing <b>{settings.smoothing}</b></span>
              <input id="smoothing" type="range" min={1} max={10} step={1} value={settings.smoothing} onChange={(e) => updateSetting('smoothing', Number(e.target.value))} />
            </label>
            <label className="slider" htmlFor="sign-threshold">
              <span>Sign strictness <b>{settings.signThreshold <= 0.17 ? 'strict' : settings.signThreshold >= 0.28 ? 'loose' : 'normal'}</b></span>
              <input id="sign-threshold" type="range" min={0.12} max={0.36} step={0.02} value={settings.signThreshold} onChange={(e) => updateSetting('signThreshold', Number(e.target.value))} />
            </label>
            <label className="slider" htmlFor="sign-hold">
              <span>Sign hold time <b>{(settings.signHoldMs / 1000).toFixed(2)}s</b></span>
              <input id="sign-hold" type="range" min={200} max={1200} step={50} value={settings.signHoldMs} onChange={(e) => updateSetting('signHoldMs', Number(e.target.value))} />
            </label>

            <button className="secondary" onClick={() => { setSettings(DEFAULT_SETTINGS); }}>Reset to defaults</button>
          </div>
        </article>
      </section>

      <section className="win orange safety">
        <div className="titlebar">
          <span>privacy.txt</span>
          <span className="winbtns"><i>_</i><i>□</i><i>×</i></span>
        </div>
        <div className="win-body">
          <p>
            Camera frames and speech are processed locally in your browser. Your signs and settings are stored only in
            this browser. Actions run in an isolated, visible Chrome window with non-destructive validation.
          </p>
        </div>
      </section>
    </main>
  );
}

declare global {
  interface Window {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  }
}

createRoot(document.getElementById('root')!).render(<App />);
