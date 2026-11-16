/**
 * The playtest driver: one process per checkout holding a Chrome with every player's page, signed in and in the game,
 * between an agent's commands. It listens on 127.0.0.1 only, for requests carrying the token it wrote to
 * data/playtests/driver.json; cli/play.ts and playtest/mcp.ts are its clients. See docs/playtesting.md.
 *
 *   node src/playtest/driver.ts [--show]     (cli/play.ts starts it when needed; --show opens a visible window)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, type Page } from './cdp.ts';
import { commandByName, describe, snapshot, type Answer, type Session } from './commands.ts';
import { DRIVER_FILE, PLAYTEST_DIR } from './files.ts';
import { MAX_PLAYERS, player, readDev, type Dev, type Player } from './players.ts';
import { Run, tally, type Verdict } from './run.ts';

const PAGE_HELPER = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'page.js'), 'utf8');

export interface Request {
  player: number;
  command: string;
  args: Record<string, string | undefined>;
  /** Take a screenshot (the default for commands that are not quiet), with things labelled (`marks`). */
  shot?: boolean;
  marks?: boolean;
}
export interface Reply {
  ok: boolean;
  text: string;
  shot?: string;
}

class Driver {
  private browser: Browser | null = null;
  private sessions = new Map<number, Session>();
  private busy = new Map<number, Promise<unknown>>();

  private dev: Dev;
  private show: boolean;

  constructor(dev: Dev, show: boolean) {
    this.dev = dev;
    this.show = show;
  }

  private async chrome() {
    this.browser ??= await Browser.launch({ show: this.show });
    return this.browser;
  }

  /** The server's API as a player. */
  private async api<T>(p: Player, method: string, url: string, body?: unknown): Promise<T> {
    const r = await fetch(`${this.dev.urls.server}${url}`, {
      method,
      headers: { cookie: `${p.cookie.name}=${p.cookie.value}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await r.json().catch(() => ({}))) as T & { error?: string };
    if (!r.ok) throw new Error(`${method} ${url}: ${data.error ?? r.status}`);
    return data;
  }

  private async heroSpecs(p: Player, worldId: string, heroes: string | undefined, agent: string) {
    const setup = await this.api<{ ruleset: { classes: { id: string; name: string }[]; kins: { id: string; name: string }[] } }>(p, 'GET', `/api/worlds/${worldId}/setup`);
    // A class or kin by its id or its name in this world (a part of the name will do); anything else is refused with
    // the world's own list, never quietly swapped for another.
    const find = (list: { id: string; name: string }[], want: string | undefined, what: string) => {
      if (!want) return list[0]!.id;
      const w = want.toLowerCase();
      const hit = list.find((x) => x.id.toLowerCase() === w || x.name.toLowerCase() === w) ?? list.find((x) => x.name.toLowerCase().includes(w));
      if (!hit) throw new Error(`No ${what} "${want}" in this world: ${list.map((x) => `${x.name} (${x.id})`).join(', ')}.`);
      return hit.id;
    };
    if (heroes && !/^\d+$/.test(heroes))
      return heroes.split(',').map((h) => {
        const [name, cls, kin] = h.split(':').map((x) => x.trim());
        return { name: name!, classId: find(setup.ruleset.classes, cls, 'class'), kinId: find(setup.ruleset.kins, kin, 'kin') };
      });
    const count = Math.min(4, Math.max(1, Number(heroes ?? 1)));
    const pick = <T>(list: T[], i: number) => list[(i + crypto.randomInt(list.length)) % list.length]!;
    const names = ['Ash', 'Bryn', 'Cato', 'Dara', 'Esk', 'Fen', 'Gale', 'Hale'];
    return Array.from({ length: count }, (_, i) => ({ name: `${names[(p.n * 2 + i) % names.length]} (${agent})`.slice(0, 24), classId: pick(setup.ruleset.classes, i).id, kinId: pick(setup.ruleset.kins, i).id }));
  }

  private async findWorld(p: Player, want?: string): Promise<string> {
    const worlds = await this.api<{ id: string; title: string; status: string }[]>(p, 'GET', '/api/worlds');
    const ready = worlds.filter((w) => w.status === 'ready');
    const title = (w: (typeof ready)[number]) => w.title.toLowerCase();
    const w = want ? ready.find((x) => x.id === want || title(x) === want.toLowerCase() || title(x).includes(want.toLowerCase())) : ready[0];
    if (!w) throw new Error(want ? `No ready world "${want}". Ready: ${ready.map((x) => `${x.id} (${title(x)})`).join(', ') || 'none'}.` : 'No world is ready here: run "npm run setup -- --world" to copy one in.');
    return w.id;
  }

  async start(n: number, a: Record<string, string | undefined>): Promise<Reply> {
    if (this.sessions.has(n)) throw new Error(`Player ${n} is already playing: "finish" first, or start as another player (--player ${[...Array(MAX_PLAYERS).keys()].map((i) => i + 1).find((i) => !this.sessions.has(i))}).`);
    const agent = a.agent || 'agent';
    const p = player(n, this.dev);
    let adventureId = a.adventure;
    if (a.join) {
      const host = this.sessions.get(Number(a.join));
      if (!host) throw new Error(`Player ${a.join} is not playing in this driver.`);
      adventureId = host.run.adventure;
    }
    if (adventureId) {
      // A place in it (test players are administrators: as the world page's folded-away section does), then heroes.
      await this.api(p, 'POST', `/api/adventures/${adventureId}/members?admin=1`, { userId: p.userId });
      const adv = await this.api<{ worldId: string; party: unknown[] }>(p, 'GET', `/api/adventures/${adventureId}`);
      if (!adv.party.length) await this.api(p, 'POST', `/api/adventures/${adventureId}/heroes`, { heroes: await this.heroSpecs(p, adv.worldId, a.heroes, agent) });
    } else if (a.menus !== 'yes') {
      const worldId = await this.findWorld(p, a.world);
      const party = await this.heroSpecs(p, worldId, a.heroes, agent);
      adventureId = (await this.api<{ adventureId: string }>(p, 'POST', `/api/worlds/${worldId}/adventures`, { name: `Playtest: ${agent}`.slice(0, 60), party })).adventureId;
    }

    const browser = await this.chrome();
    const page = await browser.newPage([{ ...p.cookie, url: this.dev.urls.game }]);
    try {
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_HELPER });
      await page.goto(`${this.dev.urls.game}/#/${adventureId && a.menus !== 'yes' ? `play/${adventureId}` : ''}`);
      if (adventureId && a.menus !== 'yes') await this.waitForGame(page);
      else await new Promise((r) => setTimeout(r, 2500));
      // What happened while the game opened (the introduction is on screen anyway) is not news for the first command.
      await page.evaluate('window.__pt.takeEvents()');
    } catch (e) {
      // The game did not open: the player is not playing, and can start again.
      await browser.closePage(page).catch(() => {});
      throw e;
    }
    // Only a player whose game opened is playing: the run and its folder begin here.
    const run = new Run(agent, n, p.username, adventureId ?? '(menus)');
    const s: Session = { n, page, run, userId: p.userId, uiTargets: [] };
    this.sessions.set(n, s);
    const intro = [
      `Playing as player ${n} (${p.displayName}, user ${p.username}) in adventure ${adventureId ?? '(none yet)'}.`,
      `The run is written to ${run.dir} (report.md there).`,
      '',
    ].join('\n');
    return this.answer(s, 'start', a, { text: intro + describe(await snapshot(page), []) }, true);
  }

  private async waitForGame(page: Page) {
    for (let i = 0; i < 600; i++) {
      const ok = await page.evaluate<boolean>('!!(window.__gd && window.__gd.state.status === "connected" && window.__gd.state.zone && window.__gdView)').catch(() => false);
      if (ok) {
        await page.evaluate('window.__pt.settle({ minimum: 1500, timeout: 15000 })');
        return;
      }
      const err = await page.evaluate<string | null>('window.__gd?.state.error ?? null').catch(() => null);
      if (err) throw new Error(`The game did not open: ${err}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('The game did not open within a minute.');
  }

  async finish(n: number, a: Record<string, string | undefined>): Promise<Reply> {
    const s = this.session(n);
    const score = (v?: string) => (v ? Math.min(5, Math.max(1, Math.round(Number(v)))) || undefined : undefined);
    const verdict: Verdict = { summary: a.summary ?? '', fun: score(a.fun), clarity: score(a.clarity), looks: score(a.looks), best: a.best, worst: a.worst };
    if (!verdict.summary) throw new Error('Give your verdict in a few sentences ("finish <summary> --fun 4 --clarity 3 --looks 4 --best … --worst …").');
    s.run.record('finish', [verdict.summary], 'The run ended.');
    s.run.end(verdict);
    await s.page.evaluate('window.__gd?.send({ t: "leave" })').catch(() => {});
    await this.browser?.closePage(s.page);
    this.sessions.delete(n);
    const c = s.run.counts();
    return { ok: true, text: `Run finished with ${tally(c)}. Report: ${path.join(s.run.dir, 'report.md')}` };
  }

  status(): Reply {
    const lines = [...this.sessions.values()].map((s) => `Player ${s.n}: ${s.run.agent}, ${s.run.stepCount} steps, adventure ${s.run.adventure}, writing ${s.run.dir}`);
    return { ok: true, text: lines.join('\n') || 'Nobody is playing. "start <agent>" begins.' };
  }

  private session(n: number): Session {
    const s = this.sessions.get(n);
    if (!s) throw new Error(`Player ${n} is not playing: "start <agent>" first${this.sessions.size ? ` (playing: ${[...this.sessions.keys()].map((k) => `player ${k}`).join(', ')})` : ''}.`);
    return s;
  }

  /** Records the step (with a screenshot unless quiet), the page's errors included. */
  private async answer(s: Session, command: string, a: Record<string, string | undefined>, ans: Answer, shoot: boolean, marks = false): Promise<Reply> {
    let text = ans.text;
    let shot = ans.shot;
    if (!shot && shoot) {
      if (marks) await s.page.evaluate('window.__pt.markWorld()').catch(() => {});
      shot = s.run.shotPath(command);
      // The screen is drawn every frame; give the latest one a moment to be on it.
      await new Promise((r) => setTimeout(r, 150));
      const jpeg = await s.page.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 85 });
      fs.writeFileSync(shot, Buffer.from(jpeg.data, 'base64'));
      await s.page.evaluate('window.__pt.clearMarks()').catch(() => {});
    } else if (command !== 'ui') await s.page.evaluate('window.__pt?.clearMarks()').catch(() => {});
    if (s.page.errors.length) {
      text += `\nErrors in the page:\n${s.page.errors.map((e) => `  ${e}`).join('\n')}`;
      s.page.errors = [];
    }
    if (shot) text += `\nScreenshot: ${shot}`;
    s.run.record(command, Object.values(a).filter((v): v is string => !!v), text, shot);
    return { ok: true, text, shot };
  }

  async handle(req: Request): Promise<Reply> {
    const n = req.player || 1;
    // One command at a time per player (another player's commands run alongside).
    const prev = this.busy.get(n) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.run(n, req));
    this.busy.set(n, next);
    return next;
  }

  private async run(n: number, req: Request): Promise<Reply> {
    try {
      switch (req.command) {
        case 'start':
          return await this.start(n, req.args);
        case 'finish':
          return await this.finish(n, req.args);
        case 'status':
          return this.status();
        case 'stop':
          setTimeout(() => void this.stop(), 100);
          return { ok: true, text: 'The driver is stopping.' };
      }
      const cmd = commandByName.get(req.command);
      if (!cmd) throw new Error(`No command "${req.command}": "help" lists them.`);
      const s = this.session(n);
      // Labels drawn for the last screenshot (or the last "ui") come off first.
      await s.page.evaluate('window.__pt?.clearMarks()').catch(() => {});
      const out = await cmd.run(s, req.args, { marks: req.marks });
      const ans = typeof out === 'string' ? { text: out } : out;
      const marks = req.marks || (cmd.name === 'look' && req.args.how === 'marks');
      return await this.answer(s, cmd.name, req.args, ans, req.shot ?? (!cmd.quiet || marks), marks);
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      const s = this.sessions.get(n);
      s?.run.record(req.command, Object.values(req.args).filter((v): v is string => !!v), `Error: ${text}`);
      return { ok: false, text };
    }
  }

  async stop() {
    for (const s of this.sessions.values()) await s.page.evaluate('window.__gd?.send({ t: "leave" })').catch(() => {});
    await this.browser?.close();
    fs.rmSync(DRIVER_FILE, { force: true });
    process.exit(0);
  }
}

// ------------------------------------------------------------------------------------ the process

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dev = readDev();
  const driver = new Driver(dev, process.argv.includes('--show'));
  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer((req, res) => {
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    // Only this computer's tools, with the token: never a web page (another site cannot know it or set the header).
    if (req.headers['x-playtest-token'] !== token || !/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '')) return reply(403, { ok: false, text: 'Forbidden.' });
    if (req.method !== 'POST' || req.url !== '/command') return reply(404, { ok: false, text: 'Not found.' });
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let r: Request;
      try {
        r = JSON.parse(body) as Request;
      } catch {
        return reply(400, { ok: false, text: 'Not JSON.' });
      }
      driver.handle(r).then((out) => reply(200, out), (e) => reply(500, { ok: false, text: String(e) }));
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    fs.mkdirSync(PLAYTEST_DIR, { recursive: true });
    fs.writeFileSync(DRIVER_FILE, JSON.stringify({ port, token, pid: process.pid }, null, 2));
    console.log(`Playtest driver on 127.0.0.1:${port} for the game at ${dev.urls.game}.`);
  });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void driver.stop());
}
