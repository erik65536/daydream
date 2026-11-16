/**
 * A browser for playtests: the computer's own Chrome (or Edge), driven over the DevTools protocol with Node's
 * WebSocket, so the harness needs no browser library. One Chrome holds every player; each player has a browser
 * context of their own (their own cookies), with one page in it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  process.env.PLAYTEST_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function findChrome(): string {
  const found = CANDIDATES.find((p) => p && fs.existsSync(p));
  if (!found) throw new Error('No Chrome or Edge found: set PLAYTEST_CHROME to a Chromium-based browser.');
  return found;
}

type Waiter = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** One DevTools connection: commands to any target through its session id, and the events they send back. */
class Connection {
  private ws: WebSocket;
  private next = 0;
  private waiting = new Map<number, Waiter>();
  private listeners = new Set<(method: string, params: Record<string, unknown>, sessionId?: string) => void>();
  readonly opened: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('Could not connect to the browser.'));
    });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      if (m.id !== undefined) {
        const w = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        if (m.error) w?.reject(new Error(m.error.message));
        else w?.resolve(m.result);
      } else if (m.method) for (const fn of this.listeners) fn(m.method, m.params ?? {}, m.sessionId);
    };
    this.ws.onclose = () => {
      for (const w of this.waiting.values()) w.reject(new Error('The browser closed.'));
      this.waiting.clear();
    };
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = ++this.next;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(fn: (method: string, params: Record<string, unknown>, sessionId?: string) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close() {
    this.ws.close();
  }
}

interface Viewport {
  width: number;
  height: number;
}

/** A page in its own browser context. */
export class Page {
  /** The page's console errors and uncaught exceptions since they were last read. */
  errors: string[] = [];
  private conn: Connection;
  readonly sessionId: string;
  readonly contextId: string;

  constructor(conn: Connection, sessionId: string, contextId: string) {
    this.conn = conn;
    this.sessionId = sessionId;
    this.contextId = contextId;
    conn.on((method, params, sid) => {
      if (sid !== sessionId) return;
      if (method === 'Runtime.exceptionThrown') {
        const d = params.exceptionDetails as { text?: string; exception?: { description?: string } };
        this.errors.push(d.exception?.description?.split('\n')[0] ?? d.text ?? 'An uncaught exception');
      } else if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
        const args = params.args as { value?: unknown; description?: string }[];
        this.errors.push(args.map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? ''))).join(' ').slice(0, 300));
      }
    });
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) {
    return this.conn.send<T>(method, params, this.sessionId);
  }

  async goto(url: string) {
    await this.send('Page.navigate', { url });
  }

  /** The value of an expression in the page (awaited when it is a promise), or the error it threw. */
  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  async screenshot(): Promise<Buffer> {
    const r = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(r.data, 'base64');
  }

  async click(x: number, y: number, button: 'left' | 'right' = 'left') {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
  }

  async scroll(x: number, y: number, deltaY: number) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
  }

  /** A key by its name as `KeyboardEvent.key` has it ("Enter", "Escape", "i", "1"), held for a moment. */
  async key(key: string) {
    const single = key.length === 1;
    const code = single ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : /\d/.test(key) ? `Digit${key}` : '') : key;
    const keyCode = single ? key.toUpperCase().charCodeAt(0) : (KEY_CODES[key] ?? 0);
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await this.send('Input.dispatchKeyEvent', { type: single ? 'keyDown' : 'rawKeyDown', ...base, ...(single ? { text: key } : {}) });
    await new Promise((r) => setTimeout(r, 60));
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async type(text: string) {
    await this.send('Input.insertText', { text });
  }

  async viewport(): Promise<Viewport> {
    return this.evaluate<Viewport>('({ width: innerWidth, height: innerHeight })');
  }
}

const KEY_CODES: Record<string, number> = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Space: 32, ' ': 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 };

/** Chrome, started for the harness with a profile of its own, removed when it closes. */
export class Browser {
  private proc: ChildProcess;
  private conn: Connection;
  private profile: string;
  readonly viewport: Viewport;

  private constructor(proc: ChildProcess, conn: Connection, profile: string, viewport: Viewport) {
    this.proc = proc;
    this.conn = conn;
    this.profile = profile;
    this.viewport = viewport;
  }

  static async launch(o: { show?: boolean; viewport?: Viewport } = {}): Promise<Browser> {
    const viewport = o.viewport ?? { width: 1280, height: 800 };
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'daydream-playtest-'));
    const args = [
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `--window-size=${viewport.width},${viewport.height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      ...(o.show ? [] : ['--headless=new', '--mute-audio']),
      'about:blank',
    ];
    const proc = spawn(findChrome(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const url = await new Promise<string>((resolve, reject) => {
      let err = '';
      const timer = setTimeout(() => reject(new Error(`The browser did not start: ${err.slice(0, 500)}`)), 20_000);
      proc.stderr!.on('data', (d) => {
        err += String(d);
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      });
      proc.on('exit', () => reject(new Error(`The browser exited: ${err.slice(0, 500)}`)));
    });
    const conn = new Connection(url);
    await conn.opened;
    return new Browser(proc, conn, profile, viewport);
  }

  /** A page in a new browser context, with these cookies set before it opens anything. */
  async newPage(cookies: { name: string; value: string; url: string }[]): Promise<Page> {
    const { browserContextId } = await this.conn.send<{ browserContextId: string }>('Target.createBrowserContext', { disposeOnDetach: true });
    for (const c of cookies) await this.conn.send('Storage.setCookies', { browserContextId, cookies: [{ ...c, path: '/', httpOnly: true, sameSite: 'Lax' }] });
    const { targetId } = await this.conn.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', browserContextId, width: this.viewport.width, height: this.viewport.height });
    const { sessionId } = await this.conn.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this.conn, sessionId, browserContextId);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: this.viewport.width, height: this.viewport.height, deviceScaleFactor: 1, mobile: false });
    // Every frame drawn, as if the page were in front (a hidden page's animation frames would stop).
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    return page;
  }

  async closePage(page: Page) {
    await this.conn.send('Target.disposeBrowserContext', { browserContextId: page.contextId }).catch(() => {});
  }

  async close() {
    await this.conn.send('Browser.close').catch(() => {});
    this.conn.close();
    await new Promise((r) => setTimeout(r, 500));
    this.proc.kill();
    fs.rmSync(this.profile, { recursive: true, force: true, maxRetries: 5 });
  }
}
