/**
 * Building worlds in tests: the real build, with a mock model server for every text step (schema-valid filler from
 * each step's own schema, see `fake`) and places laid out as plain open ground instead of being painted and read.
 */
import http from 'node:http';
import { vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LENGTH_PROFILES, Nav, PX_PER_METER, Rng, classShape, makeNav, type CharacterSpec, type ClassRole, type GameLength, type WorldSize, type Ruleset, type Vec2, type WorldDefinition, type WorldInput, type ZoneDef } from '@daydream/shared';
import { reloadGenAI } from '../src/genai/service.ts';
import { WorldGenJob, places, runGeneration } from '../src/worldgen/build.ts';
import { populate, type Painted } from '../src/worldgen/zones.ts';
import { compileWorldRules } from '../src/rules/worldRules.ts';
import type { Records } from '../src/pipeline/world.ts';
import crypto from 'node:crypto';
import { activateUser, claimInvite, createUser, getUser, loadWorld, setAdmin, setPassword, type User } from '../src/storage.ts';

type Json = Record<string, unknown>;

/**
 * Waits until `check` stops throwing (its expects hold) and returns what it returns: for what the game or a server does
 * on its own clock, which a busy machine slows down. The limit only matters when the check would never hold.
 */
export const until = <T>(check: () => T | Promise<T>, timeout = 20_000) => vi.waitFor(check, { timeout, interval: 10 });
let counter = 0;

/** An instance of a JSON schema: every required field, half of the optional ones, mid-range numbers, each choice of a union in turn. */
export function fake(schema: Json, root: Json, key = 'value'): unknown {
  if (schema.$ref) {
    const ref = String(schema.$ref).replace(/^#\/(\$defs|definitions)\//, '');
    const defs = (root.$defs ?? root.definitions) as Record<string, Json>;
    return fake(defs[ref]!, root, key);
  }
  // A union: each of its choices in turn (a nullable value is given), so a filler world has every kind of quest step.
  for (const k of ['anyOf', 'oneOf'] as const) {
    if (!Array.isArray(schema[k])) continue;
    const choices = (schema[k] as Json[]).filter((s) => s.type !== 'null');
    return fake(choices.length ? choices[counter++ % choices.length]! : (schema[k] as Json[])[0]!, root, key);
  }
  if (Array.isArray(schema.enum)) return (schema.enum as unknown[])[counter++ % (schema.enum as unknown[]).length];
  if (schema.const !== undefined) return schema.const;
  const type = Array.isArray(schema.type) ? (schema.type as string[]).find((t) => t !== 'null') : schema.type;
  switch (type) {
    case 'object': {
      const out: Json = {};
      const props = (schema.properties ?? {}) as Record<string, Json>;
      for (const [k, v] of Object.entries(props)) if ((schema.required as string[] | undefined)?.includes(k) || counter++ % 2 === 0) out[k] = fake(v, root, k);
      return out;
    }
    case 'array': {
      const min = Number(schema.minItems ?? 1), max = Number(schema.maxItems ?? Math.max(min, 3));
      // A list of several kinds begins with the first of them (a class's first skills begin with one used on an enemy,
      // as the rules' check asks); the rest are each kind in turn, as any union is.
      const items = (schema.items ?? {}) as Json;
      const kinds = ((items.anyOf ?? items.oneOf) as Json[] | undefined)?.filter((s) => s.type !== 'null');
      return Array.from({ length: Math.min(max, Math.max(min, 3)) }, (_, i) => fake(i === 0 && kinds?.length ? kinds[0]! : items, root, key));
    }
    case 'string': {
      if (schema.pattern && String(schema.pattern).includes('0-9a-fA-F')) return '#7a6a5a';
      // (Strict schemas reach the model without their length limits: prose fields long enough for their minimums.)
      const max = Number(schema.maxLength ?? 400);
      const base = `${key} ${++counter} of the mock world, written plainly`;
      const min = Number(schema.minLength ?? (/prompt|text|description|intro|summary|plan|ground/i.test(key) ? 120 : 1));
      return base.padEnd(min, ' x').slice(0, Math.max(min, Math.min(max, base.length)));
    }
    case 'integer':
    case 'number': {
      const min = Number(schema.minimum ?? 1), max = Number(schema.maximum ?? 5);
      return Math.max(min, Math.min(max, Math.round((min + max) / 2)));
    }
    case 'boolean':
      return counter++ % 2 === 0;
    default:
      return `${key} ${++counter}`;
  }
}

export interface MockModels {
  /** Every structured call answered, by schema name. */
  seen: string[];
  stop(): void;
}

/**
 * A mock of OpenAI's Responses API for the text purposes. It answers like a weak model would: valid JSON with filler
 * text. Every id and name a step must use is an enum of its schema, so filler holds together as a world.
 * `junkOnce` names schemas whose first answer is broken JSON (to exercise retries).
 */
export async function mockModels(opts: { junkOnce?: string[]; npc?: (prompt: string) => Json } = {}): Promise<MockModels> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const data = JSON.parse(body);
      if (req.url?.endsWith('/decisions')) {
        // The judge: the first choice, held fairly sure; the hero is believed, asks for work and is offered nothing personal.
        const answers = (data.questions as Json[]).map((q) => {
          if (q.type === 'choice') {
            const values = (q.choices as Json[]).map((c) => c.value as string);
            const choice = values[0]!;
            return { type: 'choice', name: q.name, choice, confidence: 0.9, probabilities: [{ value: choice, probability: 0.9 }] };
          }
          if (q.type === 'score') return { type: 'score', name: q.name, score: 3, confidence: 0.9 };
          return { type: 'predicate', name: q.name, probability: ['believes', 'accepts', 'asksWork'].includes(q.name as string) ? 0.9 : 0.1 };
        });
        seen.push('decision');
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ answers, usage: { input_tokens: 100 } }));
      }
      const format = data.text?.format;
      const name: string = format?.name ?? 'text';
      let content: string;
      if (!format) content = 'Well met, traveler.';
      else if (name === 'npc_turn' && opts.npc) content = JSON.stringify(opts.npc(JSON.stringify(data.input)));
      else if (opts.junkOnce?.includes(name) && !seen.includes(name)) content = 'Sure! Here it is: {"arcs": [ oops';
      else {
        const out = fake(format.schema, format.schema, name) as Json;
        content = JSON.stringify(out);
      }
      seen.push(name);
      const response = { status: 'completed', output_text: content, usage: { input_tokens: 100, output_tokens: 50 } };
      if (!data.stream) {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify(response));
      }
      // Streamed as the real API does it: the text in pieces, then the whole response.
      res.setHeader('content-type', 'text/event-stream');
      const event = (type: string, ev: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...ev })}\n\n`);
      for (let i = 0; i < content.length; i += 7) event('response.output_text.delta', { delta: content.slice(i, i + 7) });
      event('response.completed', { response });
      res.end();
    });
  });
  // Idle connections stay open as a real API's do. With Node's 5 s default, a connection the mock closed while the
  // build's balancing kept the event loop busy was reused afterwards, and that call hung until the test timed out.
  server.keepAliveTimeout = 120_000;
  await new Promise<void>((r) => server.listen(0, () => r()));
  const port = (server.address() as { port: number }).port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daydream-models-'));
  const before = process.env.DAYDREAM_GENAI_CONFIG;
  fs.writeFileSync(path.join(dir, 'genai.json'), JSON.stringify({
    // A local mock: free (no pricing), so no budget applies.
    providers: {
      mock: { type: 'openai-responses', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock', apiKey: 'test', concurrency: 8, pricing: { inputPerM: 0, outputPerM: 0 } },
      judge: { type: 'openai-decision', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock', apiKey: 'test', concurrency: 8, pricing: { inputPerM: 0, outputPerM: 0 } },
    },
    purposes: {
      ...Object.fromEntries(['world.design', 'world.content', ...(opts.npc ? ['npc.decision', 'narration'] : [])].map((p) => [p, { provider: 'mock', retries: 1 }])),
      ...(opts.npc ? { 'npc.judge': { provider: 'judge', retries: 1 } } : {}),
    },
  }));
  process.env.DAYDREAM_GENAI_CONFIG = path.join(dir, 'genai.json');
  reloadGenAI();
  return {
    seen,
    stop() {
      server.close();
      if (before === undefined) delete process.env.DAYDREAM_GENAI_CONFIG;
      else process.env.DAYDREAM_GENAI_CONFIG = before;
      reloadGenAI();
    },
  };
}

/**
 * Places as plain open ground (a walled square), with the ways out around its edge and everyone
 * spread over the middle; monsters by the real rules. Returns a function that restores painting.
 */
export function plainPlaces(): () => void {
  const real = { ...places };
  places.paint = async () => ({}) as Painted;
  places.settle = async (w, z) => layOut(w, z);
  return () => Object.assign(places, real);
}

function layOut(w: WorldDefinition, z: ZoneDef) {
  const S = 44;
  const nav = makeNav(S, S, (x, y) => x > 1.4 && y > 1.4 && x < S - 1.4 && y < S - 1.4);
  z.nav = nav;
  z.width = z.height = S;
  z.painting = { image: `place_${z.id}`, width: Math.round(S * PX_PER_METER), height: Math.round(S * PX_PER_METER), ox: 0, oy: 0 };
  z.look = { ...z.look, weather: 'none' };
  const ways = z.features.filter((f) => f.kind === 'exit');
  ways.forEach((f, i) => {
    const a = (i / Math.max(1, ways.length)) * Math.PI * 2;
    [f.x, f.y] = [S / 2 + Math.cos(a) * (S / 2 - 3), S / 2 + Math.sin(a) * (S / 2 - 3)];
  });
  const taken: Vec2[] = ways.map((f) => ({ x: f.x, y: f.y }));
  let n = 0;
  const spot = () => {
    const per = Math.floor((S - 12) / 2.5);
    const p = { x: 6 + (n % per) * 2.5, y: 6 + Math.floor(n / per) * 2.5 };
    n++;
    taken.push(p);
    return p;
  };
  for (const f of z.features) if (f.kind !== 'exit') Object.assign(f, spot());
  for (const p of w.npcs) if (p.zoneId === z.id) Object.assign(p, spot());
  z.entry = { x: S / 2, y: S / 2 };
  if (z.kind === 'wilderness' || z.kind === 'dungeon') populate(w, z, new Nav(nav), new Rng(`${w.id}:${z.id}`), S * S * 0.8, taken);
}

let models: Promise<MockModels> | null = null;
const built = new Map<string, WorldDefinition>();

/** A world built by the real build from mock model answers, on plain ground (cached per setup; a fresh copy each call). */
export async function genWorld(setting: string, size: WorldSize = 'small', length: GameLength = 'short'): Promise<WorldDefinition> {
  const key = `${setting}|${size}|${length}`;
  if (!built.has(key)) {
    models ??= mockModels();
    await models;
    const restore = plainPlaces();
    try {
      const job = new WorldGenJob(`w_test_${Math.random().toString(36).slice(2, 8)}`, { theme: setting, size, length, communication: 2 }, { id: 'u1', name: 'Tester' });
      await runGeneration(job);
      built.set(key, loadWorld(job.worldId)!);
    } finally {
      restore();
    }
  }
  return structuredClone(built.get(key)!);
}

/** Problems with a world's links, quests and places (none means it can be played through). */
export function validateWorld(w: WorldDefinition) {
  const zoneIds = new Set(w.zones.map((z) => z.id));
  const npcIds = new Set(w.npcs.map((n) => n.id));
  const errors: string[] = [];
  for (const z of w.zones) {
    const spawnIds = z.spawns.map((s) => s.id);
    if (new Set(spawnIds).size < spawnIds.length) errors.push(`${z.id}: spawns share an id`);
    if (!z.nav || !z.painting) {
      errors.push(`${z.id}: not painted`);
      continue;
    }
    const nav = new Nav(z.nav);
    for (const f of z.features) {
      if ((f.kind === 'exit') && (!f.targetZoneId || !zoneIds.has(f.targetZoneId))) errors.push(`${z.id}: bad exit ${f.id} -> ${f.targetZoneId}`);
      if (f.targetFeatureId) {
        const tz = w.zones.find((x) => x.id === f.targetZoneId);
        if (!tz?.features.some((x) => x.id === f.targetFeatureId)) errors.push(`${z.id}: exit ${f.id} target feature ${f.targetFeatureId} missing`);
      }
    }
    // Every way out can be walked to from the entry.
    for (const f of z.features.filter((x) => x.kind === 'exit'))
      if (!nav.path(z.entry, f, { stopWithin: 1.5, allowBlockedGoal: true })) errors.push(`${z.id} (${z.kind}): exit ${f.id} unreachable from entry`);
  }
  for (const n of w.npcs) if (!zoneIds.has(n.zoneId)) errors.push(`npc ${n.id} zone ${n.zoneId} missing`);
  for (const q of w.quests) {
    if (!q.objectives.length) errors.push(`quest ${q.id} has no objectives`);
    for (const o of q.objectives) {
      if (o.npcId && !npcIds.has(o.npcId)) errors.push(`quest ${q.id} objective ${o.id} npc ${o.npcId}`);
      if (o.zoneId && !zoneIds.has(o.zoneId)) errors.push(`quest ${q.id} zone ${o.zoneId}`);
      if (o.itemUniqueId && !w.uniqueItems[o.itemUniqueId]) errors.push(`quest ${q.id} item ${o.itemUniqueId}`);
      if (o.targetId && !w.bosses.some((b) => b.id === o.targetId)) errors.push(`quest ${q.id} boss ${o.targetId}`);
      if (o.type === 'collect') {
        const placed = w.zones.some((z) => z.features.some((f) => f.items?.includes(o.itemUniqueId!))) || w.bosses.some((b) => b.drops.includes(o.itemUniqueId!));
        if (!placed) errors.push(`quest ${q.id} collect item ${o.itemUniqueId} not placed`);
      }
    }
  }
  for (const b of w.bosses) if (!w.zones.find((z) => z.id === b.zoneId)?.spawns.some((s) => s.bossId === b.id)) errors.push(`boss ${b.id} not spawned`);
  return errors;
}

/**
 * The rules an example world's rules steps wrote (test/fixtures/rules/, saved from its pipeline runs), compiled: a small,
 * short woodland or a medium, long office. `change` alters the records first (a world that chose otherwise).
 */
export function fixtureRules(example: 'woodland' | 'office', change?: (records: Records) => void): Ruleset {
  const { length, records } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'rules', `${example}.json`), 'utf8')) as { length: WorldInput['length']; records: Records };
  change?.(records);
  const maxLevel = LENGTH_PROFILES[length].maxLevel;
  return compileWorldRules(records, { maxLevel, tiers: classShape(maxLevel).tiers, seed: example, id: `rules_${example}` });
}

/** A character spec for the world's class with the given role (or the first class). */
export function hero(w: WorldDefinition, name: string, role: ClassRole = 'melee'): CharacterSpec {
  const cls = w.ruleset.classes.find((c) => c.role === role) ?? w.ruleset.classes[0]!;
  return { name, classId: cls.id, kinId: w.ruleset.kins[0]!.id };
}

/** An active account set up as a player would from an invite: a fresh user name and a password. */
export function activeUser(isAdmin = false, password = 'a-chosen-password'): User {
  const u = createUser({ displayName: 'Tester' });
  claimInvite(u.id, { username: `t_${crypto.randomBytes(5).toString('hex')}` });
  setPassword(u.id, password);
  activateUser(u.id);
  // The first account set up on an empty server becomes its administrator: hand that to another one.
  if (getUser(u.id)!.isAdmin !== isAdmin) {
    if (!isAdmin) activeUser(true);
    setAdmin(u.id, isAdmin);
  }
  return getUser(u.id)!;
}
