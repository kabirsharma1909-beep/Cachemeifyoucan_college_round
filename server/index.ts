import 'dotenv/config';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, rmSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import cors from 'cors';
import express from 'express';
import { GoogleGenAI, Type } from '@google/genai';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { z } from 'zod';

const app = express();
const port = Number(process.env.PORT ?? 3001);
let browserContext: BrowserContext | null = null;
let activePage: Page | null = null;
let launchPromise: Promise<BrowserContext> | null = null;
let cursorBridge: ChildProcessWithoutNullStreams | null = null;

app.use(cors({ origin: 'http://localhost:5173' }));
app.use(express.json({ limit: '2mb' }));

const actionSchema = z.object({
  type: z.enum(['navigate', 'open-tab', 'close-tab', 'search', 'youtube-search', 'type', 'write', 'key', 'scroll', 'pointer-move', 'click', 'back', 'forward', 'open-result', 'pause']),
  url: z.string().url().optional(),
  query: z.string().trim().min(1).max(300).optional(),
  text: z.string().min(1).max(1_000).optional(),
  pressEnter: z.boolean().optional(),
  key: z.string().min(1).max(30).optional(),
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
  direction: z.enum(['up', 'down']).optional(),
  resultIndex: z.number().int().min(1).max(20).optional(),
});

const commandSchema = z.object({ command: z.string().trim().min(1).max(500) });

const windowsCursorScript = String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FreeHandCursor {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
}
'@
[System.Threading.Thread]::CurrentThread.CurrentCulture = [System.Globalization.CultureInfo]::InvariantCulture
while (($line = [Console]::In.ReadLine()) -ne $null) {
  $parts = $line.Split(',')
  if ($parts[0] -eq 'move' -and $parts.Length -eq 3) {
    $width = [FreeHandCursor]::GetSystemMetrics(0)
    $height = [FreeHandCursor]::GetSystemMetrics(1)
    $x = [Math]::Round([Double]::Parse($parts[1], [System.Globalization.CultureInfo]::InvariantCulture) * ($width - 1))
    $y = [Math]::Round([Double]::Parse($parts[2], [System.Globalization.CultureInfo]::InvariantCulture) * ($height - 1))
    [FreeHandCursor]::SetCursorPos($x, $y) | Out-Null
  }
  if ($parts[0] -eq 'moveabs' -and $parts.Length -eq 3) {
    $ax = [Math]::Round([Double]::Parse($parts[1], [System.Globalization.CultureInfo]::InvariantCulture))
    $ay = [Math]::Round([Double]::Parse($parts[2], [System.Globalization.CultureInfo]::InvariantCulture))
    [FreeHandCursor]::SetCursorPos($ax, $ay) | Out-Null
  }
  if ($parts[0] -eq 'click') {
    [FreeHandCursor]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [FreeHandCursor]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  }
}
`;

function getCursorBridge() {
  if (process.platform !== 'win32') throw new Error('Visible hand cursor control is currently supported on Windows only.');
  if (cursorBridge && !cursorBridge.killed && cursorBridge.exitCode === null) return cursorBridge;

  cursorBridge = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsCursorScript], {
    stdio: 'pipe',
    windowsHide: true,
  });
  cursorBridge.on('exit', () => { cursorBridge = null; });
  cursorBridge.stderr.on('data', (data: Buffer) => console.error(`Cursor bridge error: ${data.toString()}`));
  return cursorBridge;
}

function moveVisibleCursor(screenX: number, screenY: number) {
  try {
    getCursorBridge().stdin.write(`moveabs,${screenX.toFixed(1)},${screenY.toFixed(1)}\n`);
  } catch (error) {
    console.error(`Visible cursor bridge error: ${String(error)}`);
  }
}

// The click target (Playwright) lives in page-viewport coordinates, but the visible cursor lives in
// screen coordinates. Reading the viewport's on-screen origin keeps the two in the same place, so
// the cursor you see is exactly where the click lands.
let viewportCache: { width: number; height: number; left: number; top: number; at: number } | null = null;
async function getViewport(page: Page, fresh = false) {
  const now = Date.now();
  if (!fresh && viewportCache && now - viewportCache.at < 1500) return viewportCache;
  const geo = await page.evaluate(() => {
    const w = globalThis as unknown as {
      innerWidth: number; innerHeight: number; outerWidth: number; outerHeight: number;
      screenX: number; screenY: number;
    };
    const border = Math.max(0, (w.outerWidth - w.innerWidth) / 2);
    return {
      width: w.innerWidth,
      height: w.innerHeight,
      left: w.screenX + border,
      top: w.screenY + (w.outerHeight - w.innerHeight) - border,
    };
  });
  viewportCache = { ...geo, at: now };
  return viewportCache;
}

// The hand cursor is drawn INSIDE the page at the exact viewport position Playwright moves the mouse to,
// so what you see is precisely where a click lands (no screen/DPI/toolbar offset to get wrong).
// The real Windows cursor is opt-in: set FREEHAND_OS_CURSOR=1 in .env if you also want it moved.
const OS_CURSOR = process.env.FREEHAND_OS_CURSOR === '1';

const cursorOverlayScript = String.raw`
(() => {
  if (window.top !== window || window.__fhCursor) return;
  window.__fhCursor = true;
  let el = null;
  function ensure() {
    if (el && el.isConnected) return el;
    const root = document.documentElement;
    if (!root) return null;
    el = document.createElement('div');
    el.setAttribute('data-freehand-cursor', '');
    el.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '24'); svg.setAttribute('height', '32'); svg.setAttribute('viewBox', '0 0 16 22');
    svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible;filter:drop-shadow(2px 2px 0 rgba(58,38,34,.55));transition:transform .1s;transform-origin:1px 1px;';
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M1 1 L1 17 L5 13 L8 20 L11 18.5 L8 12 L14 12 Z');
    path.setAttribute('fill', '#f5ecd9'); path.setAttribute('stroke', '#3a2622');
    path.setAttribute('stroke-width', '1.6'); path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    const ring = document.createElement('div');
    ring.style.cssText = 'position:absolute;left:-16px;top:-16px;width:32px;height:32px;border:3px solid #ee7a78;border-radius:50%;opacity:0;box-sizing:border-box;';
    el.appendChild(ring); el.appendChild(svg);
    el.__svg = svg; el.__ring = ring;
    root.appendChild(el);
    return el;
  }
  window.addEventListener('mousemove', (e) => {
    const c = ensure();
    if (c) c.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)';
  }, true);
  window.addEventListener('mousedown', () => {
    const c = ensure();
    if (!c) return;
    c.__svg.style.transform = 'scale(.7)';
    c.__ring.animate([{ opacity: 1, transform: 'scale(.4)' }, { opacity: 0, transform: 'scale(1.3)' }], { duration: 300 });
  }, true);
  window.addEventListener('mouseup', () => {
    const c = ensure();
    if (c) c.__svg.style.transform = '';
  }, true);
})();
`;

// All mouse work runs one at a time. Without this, a pointer-move could slip in between the
// mouse-down and mouse-up of a click and make the click miss or turn into a tiny drag.
let mouseChain: Promise<unknown> = Promise.resolve();
function withMouse<T>(task: () => Promise<T>): Promise<T> {
  const run = mouseChain.then(task, task);
  mouseChain = run.catch(() => undefined);
  return run;
}

// Tab actions are rate-limited so a misfiring gesture can never spam or mass-close tabs.
const TAB_ACTION_GAP_MS = 2000;
const MAX_TABS = 10;
let lastTabActionAt = 0;
function tabActionTooSoon() {
  const now = Date.now();
  if (now - lastTabActionAt < TAB_ACTION_GAP_MS) return true;
  lastTabActionAt = now;
  return false;
}

// Pointer moves happen ~30x/second, so skip bringToFront() and reuse the known page.
async function getPageFast(): Promise<Page> {
  if (activePage && !activePage.isClosed()) return activePage;
  return getActivePage();
}

const intentJsonSchema = {
  type: Type.OBJECT,
  properties: {
    type: {
      type: Type.STRING,
      enum: ['navigate', 'open-tab', 'close-tab', 'search', 'youtube-search', 'type', 'write', 'key', 'scroll', 'pointer-move', 'click', 'back', 'forward', 'open-result', 'pause'],
    },
    url: { type: Type.STRING },
    query: { type: Type.STRING },
    text: { type: Type.STRING },
    pressEnter: { type: Type.BOOLEAN },
    key: { type: Type.STRING },
    x: { type: Type.NUMBER },
    y: { type: Type.NUMBER },
    direction: { type: Type.STRING, enum: ['up', 'down'] },
    resultIndex: { type: Type.INTEGER },
  },
  required: ['type'],
} as const;

function formatKeyShortcut(key: string): string {
  return key
    .trim()
    .replace(/\bctrl\b/gi, 'Control')
    .replace(/\balt\b/gi, 'Alt')
    .replace(/\bshift\b/gi, 'Shift')
    .replace(/\bmeta\b/gi, 'Meta')
    .replace(/\bcmd\b/gi, 'Meta')
    .split('+')
    .map((part) => {
      const p = part.trim();
      if (/^(?:control|alt|shift|meta)$/i.test(p)) {
        return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
      }
      if (p.length === 1) {
        return p.toUpperCase();
      }
      return p;
    })
    .join('+');
}

function isAllowedKey(key: string): boolean {
  const formatted = formatKeyShortcut(key);
  if (!formatted) return false;

  const singleKeys = /^(?:Enter|Tab|Escape|Space|Backspace|Delete|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|F[1-9]|F1[0-2]|[a-zA-Z0-9])$/;
  if (singleKeys.test(formatted)) return true;

  const comboPattern = /^(?:Control|Alt|Shift|Meta)(?:\+(?:Control|Alt|Shift|Meta))*(?:\+[a-zA-Z0-9]|\+F[1-9]|\+F1[0-2]|\+ArrowUp|\+ArrowDown|\+ArrowLeft|\+ArrowRight|\+Tab|\+Enter|\+Escape|\+Space|\+Backspace|\+Delete|\+Home|\+End|\+PageUp|\+PageDown)$/;
  return comboPattern.test(formatted);
}

function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate));
}

function cleanupStaleLocks(dirPath: string) {
  const locks = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];
  for (const lock of locks) {
    const lockPath = resolve(dirPath, lock);
    if (existsSync(lockPath)) {
      try {
        unlinkSync(lockPath);
      } catch {
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // Ignore if file is currently locked by active OS process
        }
      }
    }
  }
}

async function launchBrowser(): Promise<BrowserContext> {
  if (browserContext && (browserContext.browser() ? browserContext.browser()?.isConnected() : true)) {
    return browserContext;
  }
  if (launchPromise) {
    return launchPromise;
  }

  launchPromise = (async () => {
    const profileDir = resolve('.freehand-chrome');
    const executablePath = findChromeExecutable();
    if (!executablePath) throw new Error('Chrome was not found. Install Chrome or set CHROME_PATH in .env.');

    const launchOpts = {
      executablePath,
      headless: false,
      viewport: null,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--start-maximized',
        '--disable-blink-features=AutomationControlled',
      ],
    };

    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(profileDir, launchOpts);
    } catch (err: unknown) {
      const msg = String(err);
      if (msg.includes('Opening in existing browser session') || msg.includes('profile is already in use')) {
        cleanupStaleLocks(profileDir);
        context = await chromium.launchPersistentContext(profileDir, launchOpts);
      } else {
        throw err;
      }
    }

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
    });

    await context.addInitScript({ content: cursorOverlayScript });
    for (const existing of context.pages()) {
      try { await existing.evaluate(cursorOverlayScript); } catch { /* page not ready yet; it will get the script on next navigation */ }
    }

    context.on('page', (page) => { activePage = page; });
    context.on('close', () => {
      browserContext = null;
      activePage = null;
      launchPromise = null;
    });

    browserContext = context;
    return context;
  })();

  try {
    return await launchPromise;
  } finally {
    launchPromise = null;
  }
}

async function getActivePage(): Promise<Page> {
  try {
    const isConnected = Boolean(browserContext && (browserContext.browser() ? browserContext.browser()?.isConnected() : true));
    if (!browserContext || !isConnected) {
      await launchBrowser();
    }

    if (!activePage || activePage.isClosed()) {
      const pages = browserContext!.pages().filter((p) => !p.isClosed());
      activePage = pages.at(-1) ?? await browserContext!.newPage();
    }
    await activePage.bringToFront();
    return activePage;
  } catch {
    browserContext = null;
    activePage = null;
    await launchBrowser();
    const pages = browserContext!.pages().filter((p) => !p.isClosed());
    activePage = pages.at(-1) ?? await browserContext!.newPage();
    await activePage.bringToFront();
    return activePage;
  }
}

async function createNewTab(url?: string): Promise<Page> {
  await getActivePage();
  const page = await browserContext!.newPage();
  activePage = page;
  await page.goto(url ?? 'https://www.google.com/');
  await page.bringToFront();
  return page;
}

function removeNullFields(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, fieldValue]) => fieldValue !== null));
}

function websiteUrlFromSpeech(value: string): string | null {
  const spokenUrl = value
    .trim()
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/\s+dot\s+/g, '.')
    .replace(/\s+slash\s+/g, '/')
    .replace(/\s+/g, '');

  if (/^https?:\/\/[\w.-]+(?:\/[^\s]*)?$/i.test(spokenUrl)) return spokenUrl;
  if (/^[\w-]+(?:\.[\w-]+)+(?:\/[^\s]*)?$/i.test(spokenUrl)) return `https://${spokenUrl}`;
  return null;
}

async function ensureFocusedInput(page: Page) {
  const isInputFocused = await page.evaluate(() => {
    const win = globalThis as unknown as Record<string, any>;
    const active = win.document?.activeElement;
    if (!active || active === win.document?.body || active === win.document?.documentElement) return false;
    const tag = String(active.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || Boolean(active.isContentEditable) || active.getAttribute?.('role') === 'textbox';
  }).catch(() => false);

  if (!isInputFocused) {
    const selectors = [
      'input[type="search"]',
      'input[name="q"]',
      'input[name="search_query"]',
      'textarea',
      '[contenteditable="true"]',
      '[role="searchbox"]',
      '[role="textbox"]',
      'input[type="text"]',
      'input:not([type="hidden"])',
    ];

    for (const selector of selectors) {
      const element = page.locator(selector).first();
      if (await element.isVisible().catch(() => false)) {
        await element.focus().catch(() => {});
        return;
      }
    }
  }
}

function parseLocally(command: string) {
  const rawCommand = command.trim();
  const normalized = rawCommand.toLowerCase();
  const knownSites: Record<string, string> = {
    youtube: 'https://www.youtube.com',
    'youtube.com': 'https://www.youtube.com',
    google: 'https://www.google.com',
    'google.com': 'https://www.google.com',
    gmail: 'https://mail.google.com',
    chatgpt: 'https://chatgpt.com',
    'chat gpt': 'https://chatgpt.com',
    'chatgpt.com': 'https://chatgpt.com',
    github: 'https://github.com',
    'github.com': 'https://github.com',
    reddit: 'https://www.reddit.com',
    'reddit.com': 'https://www.reddit.com',
    wikipedia: 'https://www.wikipedia.org',
    'wikipedia.org': 'https://www.wikipedia.org',
  };

  const youtubeSearchMatch = rawCommand.match(/^(?:open|play|search for|search)\s+(.+?)\s+(?:on|in)\s+youtube$/i);
  if (youtubeSearchMatch) return { type: 'youtube-search' as const, query: youtubeSearchMatch[1].trim() };
  if (/^(?:open )?(?:a )?new tab$/i.test(rawCommand)) return { type: 'open-tab' as const };
  if (/^(?:close|close current|close this)(?:\s+(?:the\s+)?)?tab$/i.test(rawCommand)) {
    return { type: 'close-tab' as const };
  }

  const navigationMatch = rawCommand.match(/^(?:open|go to|navigate to|visit)\s+(.+)$/i);
  if (navigationMatch) {
    const destination = navigationMatch[1].trim();
    const knownSiteUrl = knownSites[destination.toLowerCase()];
    if (knownSiteUrl) return { type: 'navigate' as const, url: knownSiteUrl };
    const customUrl = websiteUrlFromSpeech(destination);
    if (customUrl) return { type: 'navigate' as const, url: customUrl };
  }

  // Write / dictate command for Google Docs and text editors
  const writeMatch = rawCommand.match(/^(?:write|dictate|insert)(?:\s+(?:within|in|into|to)\s+docs|\s+document)?\s+(.+)$/i);
  if (writeMatch) {
    const textToInsert = writeMatch[1].trim();
    if (/^(?:new line|paragraph)$/i.test(textToInsert)) {
      return { type: 'key' as const, key: 'Enter' };
    }
    return { type: 'write' as const, text: textToInsert };
  }

  // Explicit type in search bar
  const typeInSearchMatch = rawCommand.match(/^type\s+(.+?)\s+(?:in|into)\s+(?:the\s+)?search(?:\s+bar)?$/i);
  if (typeInSearchMatch) {
    return { type: 'type' as const, text: typeInSearchMatch[1].trim(), pressEnter: true };
  }

  // Type command (defaults to typing + enter execution)
  const typeWithEnterMatch = rawCommand.match(/^type\s+(.+?)(?:\s+(?:and|then)\s+(?:press|hit)\s+enter)?$/i);
  if (typeWithEnterMatch) {
    const rawText = typeWithEnterMatch[1].trim();
    if (normalized === 'type youtube' || normalized === 'open youtube') {
      return { type: 'navigate' as const, url: 'https://www.youtube.com' };
    }
    if (knownSites[rawText.toLowerCase()] && !rawCommand.toLowerCase().startsWith('type ')) {
      return { type: 'navigate' as const, url: knownSites[rawText.toLowerCase()] };
    }
    return { type: 'type' as const, text: rawText, pressEnter: true };
  }

  if (/^(?:press |hit )?enter(?: key)?$/i.test(rawCommand)) return { type: 'key' as const, key: 'Enter' };
  if (/^(?:click|submit|confirm)(?:\s+(?:focused|current))?(?:\s+(?:button|field|form))?$/i.test(rawCommand)) {
    return { type: 'click' as const };
  }

  const keyMatch = rawCommand.match(/^(?:press|hit|shortcut|key)\s+(.+)$/i);
  if (keyMatch) {
    const rawKeyStr = keyMatch[1].trim().replace(/\s+and\s+/gi, '+').replace(/\s+/g, '+');
    const formatted = formatKeyShortcut(rawKeyStr);
    if (isAllowedKey(formatted)) {
      if (formatted === 'Control+W') return { type: 'close-tab' as const };
      if (formatted === 'Control+T') return { type: 'open-tab' as const };
      return { type: 'key' as const, key: formatted };
    }
  }

  if (/^(?:alt|ctrl|control|shift|meta)\b/i.test(rawCommand)) {
    const formatted = formatKeyShortcut(rawCommand.replace(/\s+and\s+/gi, '+').replace(/\s+/g, '+'));
    if (isAllowedKey(formatted)) {
      return { type: 'key' as const, key: formatted };
    }
  }

  const site = normalized.replace(/^(?:open|go to|navigate to)\s+/, '').replace(/^the\s+/, '');
  if (knownSites[site]) return { type: 'navigate' as const, url: knownSites[site] };
  if (normalized.startsWith('search ')) return { type: 'search' as const, query: rawCommand.slice(7).trim() };
  if (/\b(?:scroll|move|go)\s+(?:the\s+)?(?:page\s+)?down\b|\bpage down\b/i.test(rawCommand)) {
    return { type: 'scroll' as const, direction: 'down' as const };
  }
  if (/\b(?:scroll|move|go)\s+(?:the\s+)?(?:page\s+)?up\b|\bpage up\b/i.test(rawCommand)) {
    return { type: 'scroll' as const, direction: 'up' as const };
  }
  if (normalized === 'back' || normalized.includes('go back')) return { type: 'back' as const };
  if (normalized === 'forward' || normalized.includes('go forward')) return { type: 'forward' as const };
  if (normalized.includes('pause')) return { type: 'pause' as const };

  const resultMatch = normalized.match(/(?:open|click) (?:result )?(\d+)/);
  if (resultMatch) return { type: 'open-result' as const, resultIndex: Number(resultMatch[1]) };
  return null;
}

async function parseWithGemini(command: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const client = new GoogleGenAI({ apiKey });
  const result = await client.models.generateContent({
    model: 'gemini-3.5-flash-lite',
    contents: `Convert this browser voice command into one safe action. Use open-tab to create a tab, close-tab to close the current tab, type to enter text into the focused page, key for a keyboard shortcut, and click to activate the currently focused control or submit the current form. Use youtube-search with the video title for requests to open, play, or search for a video on YouTube. Use search only for general web searches. Only use a URL for a public navigation target. Do not invent credentials, submit forms, buy anything, or send messages. Command: ${command}`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: intentJsonSchema,
    },
  });

  if (!result.text) throw new Error('Gemini did not return an action.');
  return actionSchema.parse(removeNullFields(JSON.parse(result.text)));
}

async function executeAction(action: z.infer<typeof actionSchema>) {
  if (action.type === 'navigate' && action.url) {
    const page = await getActivePage();
    await page.goto(action.url);
    return `Opened ${action.url} in the FreeHand Chrome window.`;
  }

  if (action.type === 'open-tab') {
    if (tabActionTooSoon()) return 'Ignored: a tab was just opened or closed.';
    const openCount = browserContext ? browserContext.pages().filter((candidate) => !candidate.isClosed()).length : 0;
    if (openCount >= MAX_TABS) return `Not opening another tab: ${MAX_TABS} tabs are already open.`;
    await createNewTab(action.url);
    return 'Opened a new tab in the FreeHand Chrome window.';
  }

  if (action.type === 'close-tab') {
    if (tabActionTooSoon()) return 'Ignored: a tab was just opened or closed.';
    const page = await getActivePage();
    const pages = browserContext!.pages().filter((candidate) => !candidate.isClosed());
    if (pages.length <= 1) {
      await page.goto('https://www.google.com/');
      return 'Kept the final tab open and returned it to Google.';
    }

    const nextPage = pages.find((candidate) => candidate !== page) ?? pages[0];
    await page.close();
    activePage = nextPage;
    await activePage.bringToFront();
    return 'Closed the current tab.';
  }

  if (action.type === 'search' && action.query) {
    const url = `https://www.google.com/search?q=${encodeURIComponent(action.query)}`;
    const page = await getActivePage();
    await page.goto(url);
    return `Opened Google search for “${action.query}” in the FreeHand Chrome window.`;
  }

  if (action.type === 'youtube-search' && action.query) {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(action.query)}`;
    const page = await getActivePage();
    await page.goto(url);
    return `Opened YouTube results for “${action.query}” in the FreeHand Chrome window.`;
  }

  if (action.type === 'type' && action.text) {
    const page = await getActivePage();
    if (page.url() === 'about:blank' || page.url() === '') {
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(action.text)}`;
      await page.goto(searchUrl);
      return `Opened Google search for “${action.text}” in the FreeHand Chrome window.`;
    }
    await ensureFocusedInput(page);
    await page.keyboard.type(action.text);
    if (action.pressEnter !== false) {
      await page.keyboard.press('Enter');
      return `Typed “${action.text}” into search bar and pressed Enter.`;
    }
    return `Typed “${action.text}” into the focused page element.`;
  }

  if (action.type === 'write' && action.text) {
    const page = await getActivePage();
    await page.keyboard.insertText(action.text);
    if (action.pressEnter) {
      await page.keyboard.press('Enter');
      return `Wrote “${action.text}” into document and pressed Enter.`;
    }
    return `Wrote “${action.text}” into active document.`;
  }

  if (action.type === 'key' && action.key) {
    const formattedKey = formatKeyShortcut(action.key);
    if (!isAllowedKey(formattedKey)) throw new Error(`Unsupported key command: ${action.key}`);
    if (formattedKey === 'Control+W') return executeAction({ type: 'close-tab' });
    if (formattedKey === 'Control+T') return executeAction({ type: 'open-tab' });
    const page = await getActivePage();
    await page.keyboard.press(formattedKey);
    return `Pressed ${formattedKey}.`;
  }

  if (action.type === 'scroll') {
    const page = await getActivePage();
    const distance = action.direction === 'up' ? -450 : 450;
    await page.evaluate((y) => {
      const win = globalThis as unknown as { scrollBy?: (options: { top: number; behavior: string }) => void };
      win.scrollBy?.({ top: y, behavior: 'smooth' });
    }, distance);
    return `Scrolled page ${action.direction ?? 'down'}.`;
  }

  if (action.type === 'pointer-move' && action.x !== undefined && action.y !== undefined) {
    const page = await getPageFast();
    const viewport = await getViewport(page);
    const vx = action.x * viewport.width;
    const vy = action.y * viewport.height;
    await withMouse(() => page.mouse.move(vx, vy));
    if (OS_CURSOR) moveVisibleCursor(viewport.left + vx, viewport.top + vy);
    return 'Moved the hand cursor.';
  }

  if (action.type === 'click') {
    const page = await getActivePage();
    if (action.x !== undefined && action.y !== undefined) {
      const viewport = await getViewport(page, true);
      const vx = action.x * viewport.width;
      const vy = action.y * viewport.height;
      await withMouse(async () => {
        await page.mouse.move(vx, vy);
        await page.mouse.down();
        await page.mouse.up();
      });
      if (OS_CURSOR) moveVisibleCursor(viewport.left + vx, viewport.top + vy);
      return 'Clicked at the hand cursor position.';
    }
    const clicked = await page.evaluate(() => {
      const win = globalThis as unknown as { document?: { activeElement?: unknown; body?: unknown; documentElement?: unknown } };
      const active = win.document?.activeElement as {
        tagName?: string;
        getAttribute?: (name: string) => string | null;
        click?: () => void;
      } | null;
      if (!active || active === win.document?.body || active === win.document?.documentElement) return false;

      const tag = (active.tagName ?? '').toLowerCase();
      const isClickable = tag === 'button' || tag === 'a' || tag === 'summary' ||
        active.getAttribute?.('role') === 'button' || active.getAttribute?.('role') === 'link' ||
        active.getAttribute?.('type') === 'submit';
      if (isClickable) {
        active.click?.();
        return true;
      }
      return false;
    });

    if (clicked) return 'Clicked the focused control.';
    await page.keyboard.press('Enter');
    return 'Submitted the focused field with Enter.';
  }

  if (action.type === 'back') {
    const page = await getActivePage();
    await page.goBack().catch(() => {});
    return 'Navigated back.';
  }

  if (action.type === 'forward') {
    const page = await getActivePage();
    await page.goForward().catch(() => {});
    return 'Navigated forward.';
  }

  if (action.type === 'pause') {
    const page = await getActivePage();
    await page.keyboard.press('Space');
    return 'Toggled media play/pause.';
  }

  if (action.type === 'open-result' && action.resultIndex) {
    const page = await getActivePage();
    const idx = action.resultIndex - 1;
    const clicked = await page.evaluate((targetIdx) => {
      const win = globalThis as unknown as Record<string, any>;
      const links = Array.from((win.document?.querySelectorAll('a[href]') || []))
        .map((node: any) => node as { getAttribute: (attr: string) => string | null; click: () => void })
        .filter((a) => {
          const href = a.getAttribute('href') || '';
          return href.startsWith('http') && !href.includes('google.com/search');
        });
      const target = links[targetIdx];
      if (target) {
        target.click();
        return true;
      }
      return false;
    }, idx);
    return clicked ? `Clicked search result #${action.resultIndex}.` : `Search result #${action.resultIndex} was not found on page.`;
  }

  return `Action ${action.type} executed successfully.`;
}

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, service: 'freehand-local-api' });
});

app.post('/api/actions', (request, response) => {
  const parsed = actionSchema.safeParse(request.body);

  if (!parsed.success) {
    response.status(400).json({ error: 'Invalid action', details: parsed.error.flatten() });
    return;
  }

  void executeAction(parsed.data)
    .then((message) => response.status(202).json({ accepted: true, action: parsed.data, message }))
    .catch((error: unknown) => response.status(500).json({ error: error instanceof Error ? error.message : 'Unable to open browser.' }));
});

app.post('/api/commands', async (request, response) => {
  const parsed = commandSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'A command is required.' });
    return;
  }

  try {
    const action = parseLocally(parsed.data.command) ?? await parseWithGemini(parsed.data.command);
    if (!action) {
      response.status(400).json({ error: 'Set GEMINI_API_KEY in .env for open-ended commands, or try a supported command.' });
      return;
    }

    const message = await executeAction(action);
    response.status(202).json({ accepted: true, action, message, parser: process.env.GEMINI_API_KEY ? 'Gemini or local rule' : 'local rule' });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : 'Unable to process command.' });
  }
});

app.listen(port, () => {
  console.log(`FreeHand local API listening on http://localhost:${port}`);
});
