/** HTTP + WebSocket server entry point. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express, { type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { DIFFICULTIES, MAX_HEROES, MAX_OWN_HEROES, type AdventureState, type CharacterState, type ClientMessage, type ServerMessage, type WorldDefinition } from '@daydream/shared';
import { CLIENT_DIST } from './paths.ts';
import * as store from './storage.ts';
import { auth, cookie, ownSiteOnly, sameOrigin, SESSION_COOKIE, type AuthedRequest } from './auth.ts';
import { ports } from './checkout.ts';
import { mountAccounts } from './accounts.ts';
import { mountAdmin } from './admin.ts';
import { mountGpuAdmin, worldAnimation } from './gpu/admin.ts';
import { mountWorldDeletion } from './worlddelete.ts';
import { mountWorldViewer } from './worldview.ts';
import { mountWorldCreation } from './creation.ts';
import { setProcessRole } from './gpu/presence.ts';
import { genai } from './genai/service.ts';
import { sendAsset, sendSound } from './assetroute.ts';
import { soundsDir } from './worldgen/sounds.ts';
import { activeJob, ACTIVE, enqueue, JobConflict, latestJob, logSince, logTail, queuePosition, requestCancel } from './jobs/queue.ts';
import { startWorker, type Worker } from './jobs/worker.ts';
import { installSpendLedger } from './spending.ts';
import { withCallContext } from './genai/context.ts';
import { BudgetExceeded } from './genai/spend.ts';
import { incompatibility, adventures } from './game/manager.ts';
import type { Adventure } from './game/adventure.ts';
import { speech, startSpeech } from './speech/speech.ts';
import { clientStack } from './sourcemap.ts';
import { activity, count, log, seenFrom, reportClientError, reportProcessErrors, routeError, setLogSource, startStats, warn } from './log.ts';

setLogSource('server');
reportProcessErrors();

const PORT = ports().server;
/** Development: the Vite client's address (pages are served there, and it opens game connections from there). */
const devClient = process.env.DAYDREAM_DEV_CLIENT;
/** The address to listen on: 127.0.0.1 behind a reverse proxy on the same machine; every interface when unset. */
const HOST = process.env.DAYDREAM_HOST || undefined;
const app = express();
// Behind a reverse proxy on this machine (Caddy), the client's address and https come from its X-Forwarded headers:
// the sign-in lockout is per address, and the session cookie is marked Secure on https.
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: '2mb' }));
// Only this site's own pages change anything (auth.ts).
app.use('/api', ownSiteOnly(devClient));
// Requests are counted; the failed and the slow are logged (where, who, from which address; never bodies or queries).
app.use((req, res, next) => {
  const t0 = Date.now();
  count('requests');
  res.on('finish', () => {
    const ms = Date.now() - t0;
    const failed = res.statusCode >= 500, slow = ms > 3000 && !req.path.includes('/assets/');
    if (failed) count('failed');
    if (slow) count('slow');
    if (failed || slow) warn(failed ? 'request failed' : 'slow request', { method: req.method, path: req.path, status: res.statusCode, ms, user: (req as AuthedRequest).user?.id, ip: req.ip });
  });
  next();
});

// ------------------------------------------------------------------------------ auth (middleware in auth.ts)

// The administrators' pages, and the one guard on everything under /api/admin (admin.ts), before any other route.
mountAdmin(app);
mountAccounts(app, { sameOrigin: (req) => sameOrigin(req, devClient), devClient, endGames });

/** Speech to text for conversations: a short recording in, its words out (charged to the speaker's AI budget). */
app.get('/api/voice', auth, (_req, res) => {
  res.json({ speechInput: genai().configured('speech.input') });
});

app.post('/api/voice/transcribe', auth, express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '6mb' }), async (req, res) => {
  const u = (req as AuthedRequest).user;
  if (!genai().configured('speech.input')) return void res.status(404).json({ error: 'No speech model is configured.' });
  const audio = req.body as Buffer;
  if (!Buffer.isBuffer(audio) || audio.length < 400) return void res.status(400).json({ error: 'No audio received.' });
  try {
    const lang = typeof req.query.lang === 'string' ? req.query.lang.slice(0, 2) : undefined;
    const text = await withCallContext({ priority: 'interactive', userId: u.id }, () => genai().transcribe('speech.input', audio, String(req.headers['content-type'] ?? 'audio/webm'), lang));
    res.json({ text });
  } catch (e) {
    res.status(e instanceof BudgetExceeded ? 402 : 502).json({ error: (e as Error).message });
  }
});

// ------------------------------------------------------------------------------ GPU administration

mountGpuAdmin(app);

// The world viewer (administrators only): worldview.ts.
mountWorldViewer(app);

// ------------------------------------------------------------------------------ worlds

/** A world's own art for its card: the painting of its first place and a few of its people and foes. */
function coverArt(w: WorldDefinition): { scene?: string; figures: string[] } | undefined {
  const ok = (k: string) => (w.assets[k]?.status === 'ok' ? w.assets[k]!.file : undefined);
  const scene = ok(`place_${w.startZoneId}`);
  const keys = [...w.bosses.map((b) => `spr_boss_${b.id}`), ...w.npcs.filter((n) => n.essential).map((n) => `spr_npc_${n.id}`), ...w.origins.flatMap((o) => Object.values(o.assets ?? {})), ...w.npcs.map((n) => `spr_npc_${n.id}`)];
  const figures = [...new Set(keys.map(ok).filter((f): f is string => !!f))].slice(0, 4);
  return scene || figures.length ? { scene, figures } : undefined;
}

/** A world as its card and page show it; `manage`: for its owner or an administrator, who also see why a job failed. */
function worldSummary(w: WorldDefinition, manage: boolean) {
  const latest = latestJob(w.id);
  const job = latest && ACTIVE.includes(latest.status) ? latest : undefined;
  return {
    id: w.id,
    title: w.concept.title,
    pitch: w.concept.pitch,
    ownerId: w.ownerId,
    ownerName: w.ownerName,
    // An unfinished world is being dreamed only while a job works on it; with none (stopped or failed) it can be resumed.
    // A ready world stays ready whatever is being made for it: `job` says what.
    status: w.status === 'ready' ? 'ready' : job ? 'generating' : 'failed',
    input: { size: w.input.size, length: w.input.length },
    // (`balance.at` tells the page its rules changed, so it reads them again.)
    rules: w.ruleset ? { name: w.ruleset.name, balance: w.ruleset.balance ? { at: w.ruleset.balance.at } : undefined } : undefined,
    palette: w.concept.palette,
    coverArt: coverArt(w),
    theme: w.sounds?.theme,
    artProgress: { ok: Object.values(w.assets).filter((a) => a.status === 'ok').length, total: Object.keys(w.assets).length },
    animated: Object.values(w.assets).some((a) => !!a.anim),
    job: latest && (job || latest.status === 'failed') ? { status: latest.status, progress: latest.progress, step: latest.step, error: manage ? latest.error : undefined, queuePosition: queuePosition(latest) } : undefined,
  };
}

/**
 * Who sees a world. Every world is public today (a build makes it so and nothing changes it), so every signed-in
 * player sees every world; the rest of the rule is what a world that was not public would follow.
 */
const canSee = (w: WorldDefinition, u: store.User) => w.public || w.ownerId === u.id || u.isAdmin || store.memberInWorld(w.id, u.id);

/** Its owner, and administrators looking after someone else's world. */
const canManage = (w: WorldDefinition, u: store.User) => w.ownerId === u.id || u.isAdmin;

/** A world the user may see (answers 404 for one they may not, as if it did not exist). */
function visibleWorld(req: Request, res: Response): WorldDefinition | undefined {
  const w = store.loadWorld(String(req.params.id));
  if (!w || !canSee(w, (req as AuthedRequest).user)) return void res.status(404).json({ error: 'World not found.' });
  return w;
}

/** The user's own adventures in a world: how many, and the one played last (with where its party is). */
function playedBy(w: WorldDefinition, userId: string) {
  const mine = adventures.list(w.id, userId);
  const last = mine.reduce<(typeof mine)[number] | undefined>((a, b) => (!a || b.updatedAt > a.updatedAt ? b : a), undefined);
  return { count: mine.length, last: last && { ...last, where: w.zones.find((z) => z.id === last.players[0]?.zone)?.name } };
}

app.get('/api/worlds', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  res.json(store.listWorlds().filter((w) => canSee(w, u)).map((w) => ({ ...worldSummary(w, canManage(w, u)), played: playedBy(w, u.id) })));
});

// Making a world: the concept and rules its owner reviews, then its build (creation.ts).
mountWorldCreation(app);

app.get('/api/worlds/:id', auth, (req, res) => {
  const w = visibleWorld(req, res);
  // Its animation's progress is read from every actor's files (kept a while: the page asks every second), so only here, not in the list.
  if (w) res.json({ ...worldSummary(w, canManage(w, (req as AuthedRequest).user)), animation: w.status === 'ready' ? worldAnimation(w).progress : undefined });
});

/**
 * The latest job on a world. Everyone who sees the world sees how far it is; its log and why it failed (which name
 * what is in the world, and the services behind it) are for its owner and administrators.
 */
app.get('/api/worlds/:id/job', auth, (req, res) => {
  const w = visibleWorld(req, res);
  if (!w) return;
  const manage = canManage(w, (req as AuthedRequest).user);
  const job = latestJob(w.id);
  if (!job) return void res.json({ status: w.status === 'ready' ? 'done' : w.status, progress: w.status === 'ready' ? 1 : 0, step: '', log: manage ? (w.generationLog ?? []).map((msg) => ({ t: 0, msg, kind: 'info' })) : [], preview: {} });
  const since = Number(req.query.since ?? 0);
  const log = !manage ? [] : since ? logSince(job.id, since) : logTail(job.id);
  res.json({ id: job.id, kind: job.kind, status: job.status, progress: job.progress, step: job.step, error: manage ? job.error : undefined, log, preview: job.preview, phases: job.phases, queuePosition: queuePosition(job) });
});

app.post('/api/worlds/:id/cancel', auth, (req, res) => {
  const job = activeJob(String(req.params.id));
  const u = (req as AuthedRequest).user;
  if (job && (job.ownerId === u.id || u.isAdmin)) requestCancel(job.id);
  res.json({ ok: true });
});

// Deleting a world (administrators only): worlddelete.ts.
mountWorldDeletion(app);

/** The world's rules, for its page and its codex. Writing them anew or rebalancing them is a console tool (cli/rules.ts). */
app.get('/api/worlds/:id/rules', auth, (req, res) => {
  const w = visibleWorld(req, res);
  if (!w) return;
  res.json({ ruleset: w.ruleset ?? null });
});


app.post('/api/worlds/:id/art', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  const w = store.loadWorld(String(req.params.id));
  if (!w || w.status !== 'ready') return void res.status(404).json({ error: 'Not found.' });
  if (w.ownerId !== u.id && !u.isAdmin) return void res.status(403).json({ error: 'Not your world.' });
  if (!genai().configured('image.sprite')) return void res.status(400).json({ error: 'No image model is configured (config/genai.json).' });
  try {
    enqueue('art', w.id, { id: u.id, name: u.displayName }, {}, { priority: 5, step: 'Waiting for a free worker' });
  } catch (e) {
    // Something is already being made for this world.
    if (!(e instanceof JobConflict)) throw e;
    return void res.status(409).json({ error: e.message });
  }
  // Only once the job is queued (it reads the world when a worker starts it): the pictures that failed are asked for again.
  if (req.body?.retryFailed) {
    for (const a of Object.values(w.assets)) if (a.status !== 'ok') delete w.assets[a.key];
    store.saveWorld(w);
  }
  res.json({ ok: true });
});

/** Everything character creation needs. */
app.get('/api/worlds/:id/setup', auth, (req, res) => {
  const w = visibleWorld(req, res);
  if (!w) return;
  if (w.status !== 'ready') return void res.status(404).json({ error: 'This world is not ready yet.' });
  res.json({
    id: w.id,
    concept: { title: w.concept.title, pitch: w.concept.pitch, tone: w.concept.tone, palette: w.concept.palette, genre: w.concept.genre },
    ruleset: w.ruleset,
    origins: w.origins,
    assets: Object.fromEntries(Object.values(w.assets).filter((a) => a.status === 'ok').map((a) => [a.key, a.file])),
  });
});

/*
 * A world's pictures and sounds are served without sign-in, on purpose: they are what browsers and caches keep, and
 * a world's id is what it takes to ask for them. A smaller copy (`?w=`) is made by the server on first asking, so
 * that is for signed-in players.
 */
app.get('/api/worlds/:id/assets/:file', (req, res) => {
  const id = String(req.params.id);
  if (!/^[\w-]+$/.test(id)) return void res.status(400).end();
  const w = req.query.w === undefined ? undefined : Number(req.query.w);
  if (w !== undefined && !store.sessionUser(cookie(req, SESSION_COOKIE))) return void res.status(401).setHeader('Cache-Control', 'no-store').end();
  void sendAsset(res, store.worldAssetDir(id), String(req.params.file), w);
});

app.get('/api/worlds/:id/sounds/:file', (req, res) => {
  const id = String(req.params.id);
  if (!/^[\w-]+$/.test(id)) return void res.status(400).end();
  sendSound(res, soundsDir(id), String(req.params.file));
});

// ------------------------------------------------------------------------------ adventures

/*
 * An adventure is played by its creator and the players they give a place in it (docs/multiplayer.md). The creator
 * alone gives and takes places and deletes it; inside, every player is equal. An administrator can give themselves a
 * place in someone else's, or delete it, but only by asking for it (`admin=1`), so it never happens by a slip.
 */
const asAdmin = (req: Request, u: store.User) => u.isAdmin && req.query.admin === '1';
const mayPlay = (s: AdventureState, u: store.User) => s.ownerId === u.id || s.members.includes(u.id);
const mayManage = (s: AdventureState, u: store.User, req: Request) => s.ownerId === u.id || asAdmin(req, u);

/** An adventure the user may play, or (administrators asking for it) manage (answers 404 otherwise, as if it did not exist). */
function playable(req: Request, res: Response): AdventureState | undefined {
  const s = store.loadAdventure(String(req.params.id));
  const u = (req as AuthedRequest).user;
  if (!s || !(mayPlay(s, u) || asAdmin(req, u))) return void res.status(404).json({ error: 'Adventure not found.' });
  return s;
}

/** Changes to one's heroes are made outside the game. */
function notInGame(res: Response, adventureId: string, userId: string): boolean {
  if (!adventures.onlineUsers(adventureId).includes(userId)) return true;
  res.status(409).json({ error: 'Leave the game first: heroes are chosen and made outside it.' });
  return false;
}

/**
 * Change an adventure outside the game (`adventures.edit`): what `fn` returned, as `{ out }`. An adventure that cannot
 * be opened (its world is not ready, or its heroes are of rules the world no longer has) is refused with the reason.
 */
function change<T>(res: Response, s: AdventureState, fn: (adv: Adventure) => T): { out: T } | undefined {
  const done = adventures.edit(s.id, fn);
  if (done) return done;
  res.status(409).json({ error: incompatibility(s, store.loadWorld(s.worldId)) ?? 'This adventure cannot be opened while its world is being made.' });
  return undefined;
}

const CharSpecSchema = z.object({
  name: z.string().trim().min(1).max(24),
  classId: z.string().max(60),
  kinId: z.string().max(60),
});

app.get('/api/worlds/:id/adventures', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  const w = visibleWorld(req, res);
  if (w) res.json(adventures.list(w.id, u.id, asAdmin(req, u)));
});

app.post('/api/worlds/:id/adventures', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  const w = visibleWorld(req, res);
  if (!w) return;
  if (w.status !== 'ready') return void res.status(404).json({ error: 'This world is not ready yet.' });
  const body = z.object({ name: z.string().max(60).default(''), party: z.array(CharSpecSchema).min(1).max(MAX_HEROES), difficulty: z.enum(DIFFICULTIES as [string, ...string[]]).optional(), members: z.array(z.string().max(40)).max(50).optional() }).safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid party.' });
  const adv = adventures.create(w, u.id, u.displayName, body.data.name, body.data.party, body.data.difficulty as never);
  const members = [...new Set(body.data.members ?? [])].filter((id) => id !== u.id && store.getUser(id)?.status === 'active');
  if (members.length) adventures.edit(adv.state.id, (a) => void (a.state.members = members));
  activity('adventure started', u.id, { world: w.id, adventure: adv.state.id }, { party: body.data.party.length, difficulty: adv.state.difficulty, ...(w.ownerId !== u.id ? { worldOwner: w.ownerId } : {}) });
  res.json({ adventureId: adv.state.id });
});

/** An adventure's page: who plays it, your heroes (in the party and left out), who may join, and the room in the game. */
app.get('/api/adventures/:id', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  const s = playable(req, res);
  if (!s) return;
  const world = store.loadWorld(s.worldId);
  const figure = (c: CharacterState) => (world?.assets[c.sprite]?.status === 'ok' ? world.assets[c.sprite]!.file : undefined);
  const calling = (c: CharacterState) => world?.ruleset?.classes.find((x) => x.id === c.classId)?.name ?? '';
  const hero = (c: CharacterState) => ({ id: c.id, name: c.name, level: c.level, classId: c.classId, className: calling(c), kinId: c.kinId, figure: figure(c), ai: !!c.ai });
  const online = adventures.onlineUsers(s.id);
  const me = s.players[u.id];
  res.json({
    ...adventures.summary(s),
    isCreator: s.ownerId === u.id,
    canManage: mayManage(s, u, req),
    party: me?.party.map(hero) ?? [],
    bench: me?.bench.map(hero) ?? [],
    others: Object.values(s.players).filter((p) => p.userId !== u.id).map((p) => ({ userId: p.userId, name: getUserName(p.userId, p.name), online: online.includes(p.userId), heroes: p.party.map(hero) })),
    // (Other players' heroes: a player's own heroes that are still in the game come back to them on joining.)
    inGame: adventures.heroesInGame(s.id, u.id),
    maxHeroes: MAX_HEROES,
    newHeroLevel: adventures.newHeroLevel(s.id),
  });
});

const getUserName = (id: string, fallback: string) => store.getUser(id)?.displayName ?? fallback;

/** Make heroes for an adventure (the first ones join it; later ones join your party, or wait when it is full). */
app.post('/api/adventures/:id/heroes', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  const s = playable(req, res);
  if (!s || !notInGame(res, s.id, u.id)) return;
  const body = z.object({ heroes: z.array(CharSpecSchema).min(1).max(MAX_HEROES) }).safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid heroes.' });
  const done = change(res, s, (adv) => {
    const kept = adv.settleAway(u.id);
    if (kept) return kept;
    const p = adv.state.players[u.id];
    if (!p) return adv.addPlayer(u.id, u.displayName, body.data.heroes).party.length;
    if (p.party.length + p.bench.length + body.data.heroes.length > MAX_OWN_HEROES) return 'You have made enough heroes for one adventure.';
    for (const spec of body.data.heroes) {
      const ch = adv.makeHero(u.id, spec);
      if (p.party.length > MAX_HEROES) p.bench.push(...p.party.splice(p.party.indexOf(ch), 1));
    }
    return p.party.length;
  });
  if (!done) return;
  if (typeof done.out === 'string') return void res.status(400).json({ error: done.out });
  activity('heroes made', u.id, { world: s.worldId, adventure: s.id }, { heroes: body.data.heroes.length });
  res.json({ ok: true });
});

/** Choose which of your heroes come into the game (in order: the first leads); the rest wait. */
app.put('/api/adventures/:id/party', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  const s = playable(req, res);
  if (!s || !notInGame(res, s.id, u.id)) return;
  const body = z.object({ party: z.array(z.string().max(40)).min(1).max(MAX_HEROES) }).safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: `Bring one to ${MAX_HEROES} heroes.` });
  const done = change(res, s, (adv) => {
    const kept = adv.settleAway(u.id);
    if (kept) return kept;
    const p = adv.state.players[u.id];
    if (!p) return 'Make your heroes first.';
    const all = [...p.party, ...p.bench];
    const party = [...new Set(body.data.party)].map((id) => all.find((c) => c.id === id));
    if (party.some((c) => !c)) return 'No such hero.';
    p.party = party as CharacterState[];
    p.bench = all.filter((c) => !p.party.includes(c));
    if (!p.party.some((c) => c.id === p.leaderId)) p.leaderId = p.party[0]!.id;
    return null;
  });
  if (!done) return;
  if (done.out) return void res.status(400).json({ error: done.out });
  res.json({ ok: true });
});

/** Let a hero go for good (one left out of the party). */
app.delete('/api/adventures/:id/heroes/:heroId', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  const s = playable(req, res);
  if (!s || !notInGame(res, s.id, u.id)) return;
  const done = change(res, s, (adv) => {
    const p = adv.state.players[u.id];
    const i = p?.bench.findIndex((c) => c.id === req.params.heroId) ?? -1;
    if (!p || i < 0) return 'Only a hero who waits outside the party can be let go.';
    p.bench.splice(i, 1);
    return null;
  });
  if (!done) return;
  if (done.out) return void res.status(400).json({ error: done.out });
  res.json({ ok: true });
});

/** Players who could be given a place in an adventure (everyone with an account here). */
app.get('/api/players', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  res.json(store.listUsers().filter((x) => x.status === 'active' && x.id !== u.id).map((x) => ({ id: x.id, name: x.displayName, username: x.username })));
});

/** Give a player a place in an adventure (its creator). */
app.post('/api/adventures/:id/members', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  const s = playable(req, res);
  if (!s) return;
  if (!mayManage(s, u, req)) return void res.status(403).json({ error: 'Only the one who began this adventure decides who may join.' });
  const body = z.object({ userId: z.string().max(40) }).safeParse(req.body);
  const who = body.success ? store.getUser(body.data.userId) : undefined;
  if (!who || who.status !== 'active') return void res.status(400).json({ error: 'No such player.' });
  if (who.id !== s.ownerId && !change(res, s, (adv) => void (adv.state.members.includes(who.id) || adv.state.members.push(who.id)))) return;
  if (who.id === u.id && s.ownerId !== u.id) log('administrator joined an adventure', { user: u.id, adventure: s.id, owner: s.ownerId });
  activity('adventure shared', u.id, { world: s.worldId, adventure: s.id }, { with: who.id });
  res.json({ ok: true });
});

/** Take a player's place away (the creator), or leave an adventure (a player themselves). Their heroes stay saved with it. */
app.delete('/api/adventures/:id/members/:userId', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  const s = playable(req, res);
  if (!s) return;
  const who = String(req.params.userId);
  if (who !== u.id && !mayManage(s, u, req)) return void res.status(403).json({ error: 'Only the one who began this adventure decides who may join.' });
  const opened = adventures.edit(s.id, (adv) => {
    adv.state.members = adv.state.members.filter((m) => m !== who);
    adv.kick(who, who === u.id ? 'You left this adventure.' : 'You are no longer part of this adventure.');
  });
  // An adventure that cannot be opened is not running either: the place is taken away in its save, so it can still be left.
  if (!opened) store.saveAdventure({ ...s, members: s.members.filter((m) => m !== who) });
  res.json({ ok: true });
});

app.delete('/api/adventures/:id', auth, (req, res) => {
  const u = (req as AuthedRequest).user;
  const s = store.loadAdventure(String(req.params.id));
  if (!s || !mayManage(s, u, req)) return void res.status(404).json({ error: 'Not found.' });
  adventures.end(s.id, 'This adventure was deleted.');
  store.deleteAdventure(s.id);
  activity('adventure deleted', u.id, { world: s.worldId, adventure: s.id });
  res.json({ ok: true });
});

// ------------------------------------------------------------------------------ errors

/** A player's browser reports an error (signed in only, a few a minute at most). */
const ClientError = z.object({
  message: z.string().max(2000),
  stack: z.string().max(12000).optional(),
  where: z.string().max(200).optional(),
  /** The page, and in a game where the player was (see the client's report.ts). */
  context: z.record(z.string().max(40), z.union([z.string().max(300), z.number(), z.boolean()])).optional(),
  /** What the player did just before. */
  trail: z.array(z.string().max(200)).max(40).optional(),
  /** The code the page runs (a tab left open runs an older build than the server's). */
  version: z.string().max(40).optional(),
});
const clientReports = new Map<string, { n: number; since: number }>();
app.post('/api/errors', auth, (req, res) => {
  const body = ClientError.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: 'message is required.' });
  const user = (req as AuthedRequest).user;
  const r = clientReports.get(user.id);
  if (r && Date.now() - r.since < 60_000 && r.n >= 10) return void res.status(429).json({ error: 'Too many reports.' });
  clientReports.set(user.id, r && Date.now() - r.since < 60_000 ? { n: r.n + 1, since: r.since } : { n: 1, since: Date.now() });
  const e = Object.assign(new Error(body.data.message), { stack: clientStack(body.data.stack ?? '') });
  reportClientError(e, body.data, { user: user.id, ip: req.ip, browser: req.get('user-agent')?.slice(0, 200) });
  res.json({ ok: true });
});

// ------------------------------------------------------------------------------ static client

// In development the live client is Vite's (its API calls come here); a built client in dist/ would be stale.
if (devClient) app.get(/^\/(?!api|ws).*/, (req, res) => res.redirect(devClient + req.originalUrl));
else if (fs.existsSync(CLIENT_DIST)) {
  // The client's source maps are for reading its error reports here (sourcemap.ts), not served.
  app.use((req, res, next) => (req.path.endsWith('.map') ? res.status(404).end() : next()));
  app.use(express.static(CLIENT_DIST));
  // A bundle that is not there (an older build's, asked for by a page still open) is missing, not the page.
  app.use('/assets', (_req, res) => void res.status(404).end());
  app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html'), { dotfiles: 'allow' }));
}

// ------------------------------------------------------------------------------ websocket

const server = http.createServer(app);
/** The longest message a client may send (no message of the game's is near it). */
const MAX_MESSAGE = 64_000;
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MESSAGE });

/** The game connections open now, by account. */
const connections = new Map<string, Set<{ send: (m: ServerMessage) => void; close: () => void }>>();

/** End an account's game connections (it was disabled or reset: its sessions are gone, and so is its place at the table). */
function endGames(userId: string, message: string) {
  for (const c of connections.get(userId) ?? []) {
    c.send({ t: 'error', message });
    c.close();
  }
}

/** The player's address: from Caddy's X-Forwarded-For when it comes through Caddy on this machine. */
function clientAddress(req: http.IncomingMessage): string | undefined {
  const direct = req.socket.remoteAddress;
  const loopback = direct === '127.0.0.1' || direct === '::1' || direct === '::ffff:127.0.0.1';
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim();
  return loopback && forwarded ? forwarded : direct;
}

/** A message from the client, or null when it is not one (a closed vocabulary with a string tag). */
function parseMessage(data: unknown): ClientMessage | null {
  if (String(data).length > MAX_MESSAGE) return null;
  try {
    const m = JSON.parse(String(data)) as unknown;
    return m && typeof m === 'object' && !Array.isArray(m) && typeof (m as { t?: unknown }).t === 'string' ? (m as ClientMessage) : null;
  } catch {
    return null;
  }
}

wss.on('connection', (ws: WebSocket, req) => {
  // A page of another site may not open a game connection with the player's cookie.
  if (!sameOrigin(req, devClient)) return ws.close();
  const user = store.sessionUser(cookie(req, SESSION_COOKIE));
  const url = new URL(req.url ?? '', 'http://x');
  const adventureId = url.searchParams.get('adventure') ?? '';
  const send = (m: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  const sendBinary = (data: Uint8Array) => {
    if (ws.readyState === ws.OPEN) ws.send(data, { binary: true });
  };
  if (!user) {
    send({ t: 'error', message: 'Please sign in.' });
    return ws.close();
  }
  // Its creator and the players given a place in it play an adventure, each as themselves.
  const st = store.loadAdventure(adventureId);
  if (!st || !mayPlay(st, user)) {
    send({ t: 'error', message: 'Adventure not found.' });
    return ws.close();
  }
  const adv = adventures.get(adventureId);
  if (!adv) {
    send({ t: 'error', message: incompatibility(st, store.loadWorld(st.worldId)) ?? 'Adventure not found.' });
    return ws.close();
  }
  const audio = url.searchParams.get('audio');
  const conn = { userId: user.id, name: user.displayName, send, sendBinary, audio: audio === 'opus' || audio === 'pcm' ? audio : null, close: () => ws.close() } as const;
  if (!adv.join(conn)) {
    adventures.release(adventureId);
    return ws.close();
  }
  const joinedAt = Date.now();
  const mine = connections.get(user.id) ?? new Set();
  connections.set(user.id, mine.add(conn));
  count('joins');
  seenFrom(user.id, clientAddress(req));
  log('game joined', { user: user.id, adventure: adventureId, world: st.worldId, ip: clientAddress(req) });
  let reload = false;
  ws.on('message', (data) => {
    const msg = parseMessage(data);
    if (!msg) return;
    if (msg.t === 'ping') return send({ t: 'pong', serverTime: Date.now(), clientTime: msg.clientTime });
    if (msg.t === 'dev') {
      // Administrators only, as the account stands now (it may have changed since the socket opened).
      if (!store.getUser(user.id)?.isAdmin) return send({ t: 'dev_result', reqId: msg.reqId, ok: false, text: 'Developer commands are for administrators.' });
      // Reload: the client reconnects by itself and gets a fresh copy of the world from disk.
      if (msg.action === 'reload') {
        reload = true;
        send({ t: 'dev_result', reqId: msg.reqId, ok: true, text: 'Reloading the world.' });
        return ws.close();
      }
    }
    adv.handle(user.id, msg);
  });
  ws.on('close', () => {
    const p = adv.state.players[conn.userId];
    activity('played', user.id, { world: st.worldId, adventure: adventureId }, {
      minutes: Math.round((Date.now() - joinedAt) / 6000) / 10,
      ...(p ? { levels: p.party.map((c) => c.level).join('/'), zone: p.zoneId } : {}),
    });
    adv.leave(conn);
    mine.delete(conn);
    if (!mine.size) connections.delete(user.id);
    if (reload) adventures.reload(adventureId);
  });
});

// Anything a route throws (log.ts).
app.use(routeError);

server.listen(PORT, HOST, () => {
  const g = genai();
  setProcessRole('server', `web server :${PORT}${process.env.DAYDREAM_WORKER !== 'external' ? ' + worker' : ''}`);
  console.log(`Daydream server on http://${HOST ?? 'localhost'}:${PORT}`);
  // Jobs run here unless a separate worker process runs them (DAYDREAM_WORKER=external, as `npm run dev` does).
  if (process.env.DAYDREAM_WORKER !== 'external') {
    worker = startWorker();
    console.log('Job worker: in this process');
  } else console.log('Job worker: separate process (npm run worker)');
  installSpendLedger();
  startSpeech(g.config);
  startStats(() => adventures.stats());
  // Deleted worlds past their time in the trash are removed for good: now, then twice a day.
  const purge = () => {
    const n = store.purgeTrash();
    if (n) console.log(`Trash: removed ${n} world(s) deleted more than ${store.TRASH_DAYS} days ago`);
  };
  purge();
  setInterval(purge, 12 * 3600_000).unref();
  const first = store.ensureAdmin();
  if (first) console.log(`
No accounts yet. Open this invite link within 5 days to set up the administrator (a user name, then a password, a
passkey or both):
  <this site>/#/invite/${first}
(a new link any time: npm run users -w @daydream/server -- list, then reset <its id>)
`);
  console.log('GenAI purposes:');
  for (const p of g.describe()) console.log(`  ${p.purpose.padEnd(14)} → ${p.provider} (${p.type}${p.model ? `, ${p.model}` : ''})`);
});

/** The job worker, when it runs in this process. */
let worker: Worker | undefined;

// Games are saved at once; a worker in this process then pauses its jobs at their next safe point, as the separate
// one does (worker.ts), so they are queued again instead of waiting out their lease.
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  adventures.saveAll();
  speech().stop();
  await worker?.drain();
  // (Whatever was played while the jobs paused.)
  adventures.saveAll();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
