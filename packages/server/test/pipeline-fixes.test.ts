/**
 * The build pipeline's finer rules (docs/build-pipeline.md): what a made-up answer holds, names asked for again, checks
 * that only need something to be there, runs kept whole and read from the newest back, answers kept across tries, and
 * what the world makes of the answers (the workbench, foes of one name, what a note is).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { genai } from '../src/genai/service.ts';
import { Pipeline } from '../src/pipeline/index.ts';
import { schemaAt } from '../src/pipeline/names.ts';
import { PIPELINE_DIR } from '../src/pipeline/project.ts';
import { Scope, unmet } from '../src/pipeline/scope.ts';
import { noUsage, RunStore } from '../src/pipeline/store.ts';
import { placeTiles } from '../src/pipeline/world.ts';
import { TILE_RANGE } from '../src/worldgen/mapdraw.ts';
import { SIZE_PROFILES } from '@daydream/shared';
import type { Resolved } from '../src/pipeline/types.ts';
import { mockModels, type MockModels } from './helpers.ts';

/** A pipeline of its own, in a temporary folder, with the given steps (and the repository's examples and constants). */
function scratch(steps: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-'));
  fs.cpSync(path.join(PIPELINE_DIR, 'examples'), path.join(dir, 'examples'), { recursive: true });
  fs.copyFileSync(path.join(PIPELINE_DIR, 'constants.yaml'), path.join(dir, 'constants.yaml'));
  fs.writeFileSync(path.join(dir, 'records.yaml'), '');
  fs.mkdirSync(path.join(dir, 'steps'));
  for (const [id, text] of Object.entries(steps)) fs.writeFileSync(path.join(dir, 'steps', `${id}.yaml`), text);
  return new Pipeline({ dir, runs: path.join(dir, 'runs'), cap: 1 });
}

/** A pipeline whose every step "ran" with the answer its schema makes up, in order. */
function madeUp(ex: string, change: Record<string, (answer: never) => unknown> = {}) {
  const p = new Pipeline({ runs: fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-runs-')), cap: 0 });
  // (`change` alters a step's answer before the steps after it are made up from it.)
  for (const id of p.analyze(ex).order) {
    const value = new Scope(p.project, p.example(ex), p.store, 'saved').output(id)!.value;
    save(p, ex, id, change[id] ? change[id]!(value as never) : value);
  }
  return p;
}
const save = (p: Pipeline, ex: string, step: string, output: unknown) => p.store.save({ step, example: ex, at: Date.now(), ms: 0, fingerprint: { sent: '', reads: [] }, requests: [], usage: noUsage(), output });
const answer = <T>(p: Pipeline, ex: string, step: string) => structuredClone(p.store.latest(ex, step)!.output) as T;

describe('the pipeline, checked', () => {
  it("finds a reader for every field of the repository's steps, whatever a list may hold", () => {
    const p = new Pipeline({ cap: 0 });
    // A quest's steps are of more kinds than a quest may have steps: a made-up answer still holds one of each.
    for (const ex of p.project.examples.keys()) for (const s of Object.values(p.analyze(ex).steps)) expect(s.unread, `${ex} ${s.id}`).toEqual([]);
  });

  it('starts a new step with the system prompt every step has, filled in', () => {
    const p = scratch({ ownerStyle: `purpose: world.design\nsystem: ''\nuser: style\nschema: { type: object, properties: { speech: { type: string, nullable: true } } }\n` });
    p.project.createStep('fresh');
    const system = p.preview('office', 'fresh', 'sample').calls[0]!.system;
    expect(system).toContain("You're designing the world of a role-playing game");
    expect(system).not.toContain('{{');
  });

  it("keeps a name's limits when it is asked for again, through the unions on the way", () => {
    const name: Resolved = { type: 'string', minLength: 1, maxLength: 24 };
    const status = (kind: string): Resolved => ({ type: 'object', properties: { kind: { type: 'string', const: kind }, name } });
    const weapon: Resolved = { type: 'object', properties: { name: { ...name, maxLength: 32 } } };
    const schema: Resolved = {
      type: 'object',
      properties: {
        statuses: { type: 'array', items: { anyOf: [status('buff'), status('debuff')] } },
        melee: { description: 'A class', anyOf: [{ type: 'object', properties: { name } }, { type: 'null' }] },
        weapons: { anyOf: [{ type: 'object', properties: { one_handed: weapon } }, { type: 'object', properties: { two_handed: weapon } }] },
      },
    };
    const out = { statuses: [{ kind: 'buff', name: 'A' }, { kind: 'debuff', name: 'B' }], melee: { name: 'C' }, weapons: { two_handed: { name: 'D' } } };
    expect(schemaAt(schema, out, ['statuses', 1, 'name'])).toEqual(name);
    expect(schemaAt(schema, out, ['melee', 'name'])).toEqual(name);
    expect(schemaAt(schema, out, ['weapons', 'two_handed', 'name']).maxLength).toBe(32);
  });

  it('asks again for an answer in which none of several fields is there', () => {
    const checks = [{ says: 'Give this world a class that deals damage', in: ['classes.physical.melee.name', 'classes.physical.ranged.name', 'classes.magical.melee.name'] }];
    expect(unmet(checks, { classes: { physical: { melee: null, ranged: null } } })).toBe('Give this world a class that deals damage');
    expect(unmet(checks, { classes: { physical: { melee: null, ranged: { name: 'Archer' } } } })).toBeNull();
    // The repository's rules ask it of their classes.
    const core = new Pipeline({ cap: 0 }).project.steps.get('rulesCore')!;
    expect(core.checks?.[0]?.in).toContain('classes.physical.melee.name');
  });
});

describe('runs', () => {
  it('are written whole, and read from the newest back to the first with an answer', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-store-'));
    const store = new RunStore(dir);
    const run = (at: number, more: object) => store.save({ step: 's', example: 'e', at, ms: 0, fingerprint: { sent: '', reads: [] }, requests: [], usage: noUsage(), ...more });
    const old = run(1000, { output: { n: 1 } });
    const good = run(2000, { output: { n: 2 } });
    const failed = run(3000, { error: 'no' });
    expect(fs.readdirSync(path.join(dir, 'e', 's')).every((f) => f.endsWith('.json'))).toBe(true);
    expect(store.list('e', 's').map((r) => r.id)).toEqual([failed.id, good.id, old.id]);
    expect(store.newest('e', 's')!.id).toBe(failed.id);
    // The oldest run is never opened: one that cannot be read does not stop the newest answer from being found.
    fs.writeFileSync(path.join(dir, 'e', 's', `${old.id}.json`), '{ "cut off');
    expect(store.latest('e', 's')!.id).toBe(good.id);
    // A write that stopped halfway left only its unfinished file, which is no run.
    fs.writeFileSync(path.join(dir, 'e', 's', '99990101-000000-000-ffff.json.tmp'), '{ "cut off');
    expect(store.newest('e', 's')!.id).toBe(failed.id);
  });

  describe('with a model', () => {
    let models: MockModels;
    beforeAll(async () => {
      models = await mockModels();
    });
    afterAll(() => models.stop());

    it('keep the answers a try got, and ask again only for the items that failed', async () => {
      const p = scratch({ each: `purpose: world.design\nsystem: ''\nforEach: map.places\nuser: 'Name {{$.id}}'\nschema: { type: object, properties: { name: { type: string } } }\n` });
      const places = p.facts('office').map.places.map((x) => x.id);
      expect(places.length).toBeGreaterThan(1);
      const real = genai().structured.bind(genai());
      const asked: string[] = [];
      let fail = true;
      const spy = vi.spyOn(genai(), 'structured').mockImplementation(async (purpose, opts) => {
        const item = opts.prompt.replace('Name ', '');
        asked.push(item);
        if (item === places[0] && fail) {
          fail = false;
          throw new Error('The model was busy');
        }
        return real(purpose, opts);
      });
      try {
        const steps: string[] = [];
        const runs = await p.runAll('office', { tries: 2, onStep: (_id, state) => steps.push(state) });
        expect(steps).toEqual(['running', 'done']);
        expect(runs[0]!.error).toBeUndefined();
        expect(Object.keys(runs[0]!.output as object)).toEqual(places);
        // Every place was asked once, and the one that failed once more.
        expect(asked.sort()).toEqual([...places, places[0]!].sort());
        // The try that failed is kept as a run of its own, with its error.
        expect(p.store.list('office', 'each').map((r) => !!r.error)).toEqual([false, true]);
        expect(p.status('office').each).toEqual({ state: 'fresh' });
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe('the world from the answers', () => {
  const ex = 'sinkingKingdom';

  it('puts a workbench in each town when gear can be improved or enchanted, though nothing is crafted', () => {
    const p = madeUp(ex);
    const benches = () => p.world(ex).zones.filter((z) => z.kind === 'town').map((z) => z.features.some((f) => f.kind === 'craft_station'));
    const systems = answer<Record<string, unknown>>(p, ex, 'rulesSystems');
    save(p, ex, 'rulesSystems', { ...systems, crafting: false, upgrades: true, enchanting: false });
    expect(benches().every(Boolean)).toBe(true);
    save(p, ex, 'rulesSystems', { ...systems, crafting: false, upgrades: false, enchanting: true });
    expect(benches().every(Boolean)).toBe(true);
  });

  it('keeps two foes of one name apart, each in its own place, whatever the name is written in', () => {
    const p = madeUp(ex);
    const w0 = p.world(ex);
    const wilds = w0.zones.filter((z) => z.kind !== 'town');
    const member = w0.families[0]!.members[0]!.name;
    const story = answer<{ arcs: Record<string, { quests: { giver: string; steps: unknown[] }[] }> }>(p, ex, 'story');
    const quest = Object.values(story.arcs)[0]!.quests[0]!;
    const foe = (where: string) => ({ kind: 'foe', name: 'Ёж', who: 'a hedgehog', member, where, taunt: 'Фыр!', voice: 'small' });
    quest.steps = [foe(wilds[0]!.name), { kind: 'bring', item: 'ключ', from: wilds[0]!.name, to: null }, { kind: 'bring', item: 'замок', from: wilds[0]!.name, to: null }, foe(wilds.at(-1)!.name)];
    save(p, ex, 'story', story);
    const w = p.world(ex);
    const def = w.quests.find((q) => q.main)!;
    const kills = def.objectives.filter((o) => o.type === 'kill_unique');
    expect(kills.length).toBe(2);
    expect(kills[0]!.targetId).not.toBe(kills[1]!.targetId);
    for (const k of kills) expect(w.bosses.find((b) => b.id === k.targetId)!.zoneId).toBe(k.zoneId);
    // The two things to find are two things, each with a spot of its own.
    const finds = def.objectives.filter((o) => o.type === 'collect').map((o) => o.itemUniqueId);
    expect(new Set(finds).size).toBe(2);
    expect(new Set(w.zones.flatMap((z) => z.features.map((f) => f.id))).size).toBe(w.zones.flatMap((z) => z.features).length);
    // The quest starts by going to the one who asks, who tells what is going on.
    expect(def.objectives[0]).toMatchObject({ type: 'talk', npcId: quest.giver, step: 0 });
    expect(def.objectives[1]!.step).toBe(1);
  });

  it('says what each note is, for placing it', () => {
    const p = madeUp(ex);
    const w = p.world(ex);
    const areas = answer<Record<string, { notes: Record<string, { what: string }> }>>(p, ex, 'areas');
    const [area, a] = Object.entries(areas)[0]!;
    const [note, n] = Object.entries(a.notes)[0]!;
    expect(w.zones.find((z) => z.id === area)!.features.find((f) => f.loreId === note)!.text).toBe(n.what);
  });

  it('offers a person opinions only of the people their prompt shows', () => {
    const p = new Pipeline({ cap: 0 });
    const facts = p.facts(ex);
    expect(facts.map.towns.length).toBeGreaterThan(1);
    const [first, second] = p.preview(ex, 'people', 'sample').calls;
    const text = JSON.stringify(first!.schema);
    const elsewhere = (facts.map.towns[1] as unknown as { residents: string[] }).residents[0]!;
    expect(first!.user).not.toContain(`- ${elsewhere}:`);
    expect(text).not.toContain(`"${elsewhere}"`);
    expect(JSON.stringify(second!.schema)).toContain(`"${elsewhere}"`);
  });
});

describe('the sizes of places', () => {
  it('offers each place the sizes its kind allows, and takes the one its plan chose', () => {
    const p = new Pipeline({ cap: 0 });
    for (const ex of p.project.examples.keys()) {
      const facts = p.facts(ex);
      for (const place of facts.map.places) {
        const { min, max } = TILE_RANGE[place.kind];
        expect(place.sizes[0]).toBe(`${min[0]}x${min[1]}`);
        expect(place.sizes.at(-1)).toBe(`${max[0]}x${max[1]}`);
        expect(place.sizes.length).toBe((max[0] - min[0] + 1) * (max[1] - min[1] + 1));
      }
      // The plan chooses among them, and is told how many tiles all places share.
      const call = p.preview(ex, 'placePlan', 'sample').calls[0]!;
      const first = facts.map.places[0]!;
      expect((call.schema as { properties: { places: { properties: Record<string, { properties: { size: { enum: string[] } } }> } } }).properties.places.properties[first.id]!.properties.size.enum).toEqual(first.sizes);
      expect(call.user).toContain(`${SIZE_PROFILES[p.example(ex).input.size].tiles} tiles to share`);
    }
  });

  it("makes every example's places fit its tiles, whatever sizes are chosen", () => {
    const p = new Pipeline({ cap: 0 });
    const area = (ts: [number, number][]) => ts.reduce((n, t) => n + t[0] * t[1], 0);
    for (const ex of p.project.examples.keys()) {
      const places = p.facts(ex).map.places;
      const budget = SIZE_PROFILES[p.example(ex).input.size].tiles;
      // Every place at its largest: more than there is, cut back to what there is, no place under its least.
      const largest = placeTiles(places.map((x) => ({ kind: x.kind, size: x.sizes.at(-1)! })), budget);
      expect(area(largest), ex).toBeLessThanOrEqual(budget);
      largest.forEach((t, i) => {
        const { min } = TILE_RANGE[places[i]!.kind];
        expect(t[0] >= min[0] && t[1] >= min[1], `${ex} ${places[i]!.id}`).toBe(true);
      });
      // Sizes that fit are kept as chosen.
      const smallest = places.map((x) => ({ kind: x.kind, size: x.sizes[0]! }));
      expect(placeTiles(smallest, budget).map((t) => t.join('x'))).toEqual(smallest.map((x) => x.size));
    }
    // The largest place gives way first, a column or a row at a time, and a size outside its kind's range is held to it.
    expect(placeTiles([{ kind: 'town', size: '3x3' }, { kind: 'wilderness', size: '4x4' }, { kind: 'dungeon', size: '9x9' }], 30)).toEqual([[3, 3], [3, 4], [3, 3]]);
  });

  it('gives the world the sizes its plan chose', () => {
    const ex = 'sinkingKingdom';
    const p = madeUp(ex);
    const plan = answer<{ places: Record<string, { size: string }> }>(p, ex, 'placePlan');
    const facts = p.facts(ex);
    for (const place of facts.map.places) plan.places[place.id]!.size = place.sizes[0]!;
    const big = facts.map.places.find((x) => x.kind === 'wilderness')!;
    plan.places[big.id]!.size = '4x3';
    save(p, ex, 'placePlan', plan);
    const w = p.world(ex);
    expect(w.zones.find((z) => z.id === big.id)!.tiles).toEqual([4, 3]);
    expect(w.zones.find((z) => z.kind === 'town')!.tiles).toEqual([2, 2]);
  });
});

describe('what a world is made from', () => {
  it('needs every step of the repository, and not a variant left beside one', () => {
    const p = new Pipeline({ cap: 0 });
    expect(p.needed('office').sort()).toEqual([...p.project.steps.keys()].sort());
    const s = (user: string) => `purpose: world.design\nsystem: ''\nuser: '${user}'\nschema: { type: object, properties: { x: { type: string } } }\n`;
    const q = scratch({ a: s('hello'), b: s('{{a.x}}'), c: s('hello') });
    fs.writeFileSync(path.join(q.project.dir, 'records.yaml'), 'concept: b\n');
    q.project.reload();
    q.project.duplicateStep('b');
    expect(q.needed('office')).toEqual(['a', 'b']);
  });

  it('offers a skill only the effects that fit whom it is used on, and only what the world has', () => {
    const p = new Pipeline({ cap: 0 });
    type Kind = { properties: { target: { const: string }; effects: { items: { anyOf: { const?: string; properties?: { on: { enum?: string[]; const?: string } } }[] } } } };
    for (const ex of p.project.examples.keys()) {
      const schema = p.preview(ex, 'rulesSkills', 'sample').calls[0]!.schema as { properties: Record<string, { properties: Record<string, { items: { anyOf: Kind[] } }> }> };
      for (const [cls, tiers] of Object.entries(schema.properties))
        for (const kind of Object.values(tiers.properties)[0]!.items.anyOf) {
          const target = kind.properties.target.const;
          const effects = kind.properties.effects.items.anyOf;
          const consts = effects.flatMap((e) => (e.const ? [e.const] : []));
          const on = effects.flatMap((e) => e.properties?.on.enum ?? (e.properties?.on.const ? [e.properties.on.const] : []));
          const hurts = consts.some((c) => /damage/.test(c));
          const what = `${ex} ${cls} ${target}`;
          expect(hurts, what).toBe(target === 'enemy');
          if (target === 'enemy') expect(consts.some((c) => c === 'heal' || c === 'revive' || c === 'removes_statuses'), what).toBe(false);
          expect(on.includes('allies'), what).toBe(target === 'ally' && on.length > 0);
          expect(on.includes('enemies'), what).toBe(target === 'enemy' && on.length > 0);
          if (target === 'self') expect(on.every((o) => o === 'self'), what).toBe(true);
        }
    }
  });
});

describe('brewing', () => {
  const ex = 'sinkingKingdom';
  type Systems = { crafting: boolean; upgrades: boolean; enchanting: boolean; potions: Record<string, boolean> };
  const systems = (potions: boolean) => (s: Systems): Systems => ({ ...s, crafting: false, upgrades: false, enchanting: false, potions: Object.fromEntries(Object.keys(s.potions).map((k) => [k, potions])) });

  it('follows the consumables: a world with them and no gear crafting has a reagent, a brewing craft, recipes, a workbench, and a seller', () => {
    const p = madeUp(ex, { rulesSystems: systems(true) });
    const items = answer<{ materials: Record<string, unknown>; crafts: Record<string, unknown> }>(p, ex, 'rulesItems');
    expect(Object.keys(items.materials)).toEqual(['reagent']);
    expect(Object.keys(items.crafts)).toEqual(['brew']);
    const w = p.world(ex);
    expect(w.ruleset.crafting.enabled).toBe(false);
    expect(w.ruleset.crafts.map((c) => c.id)).toEqual(['brew']);
    expect(w.ruleset.recipes.length).toBe(w.ruleset.items.filter((i) => i.category === 'potion').length);
    expect(w.ruleset.recipes.length).toBeGreaterThan(0);
    const towns = w.zones.filter((z) => z.kind === 'town');
    for (const z of towns) {
      expect(z.features.some((f) => f.kind === 'craft_station'), z.id).toBe(true);
      expect(w.npcs.some((n) => n.zoneId === z.id && n.merchantKind === 'materials'), z.id).toBe(true);
    }
  });

  it('is not there in a world with no consumables and no craft: no materials, recipes, workbench, or seller', () => {
    const p = madeUp(ex, { rulesSystems: systems(false) });
    const items = answer<{ materials: object; crafts: object }>(p, ex, 'rulesItems');
    expect(items.materials).toEqual({});
    expect(items.crafts).toEqual({});
    const w = p.world(ex);
    expect(w.ruleset.crafts).toEqual([]);
    expect(w.ruleset.recipes).toEqual([]);
    expect(w.ruleset.items.some((i) => i.category === 'material')).toBe(false);
    expect(w.zones.some((z) => z.features.some((f) => f.kind === 'craft_station'))).toBe(false);
    expect(w.npcs.some((n) => n.merchantKind === 'materials')).toBe(false);
    // The one who would have sold materials lives there all the same.
    expect(w.npcs.length).toBe(p.facts(ex).map.cast.length + p.facts(ex).map.residents.length);
  });
});

describe('a first tier to fight with', () => {
  it('asks each class that deals damage for a skill used on an enemy in its first tier', () => {
    const p = new Pipeline({ cap: 0 });
    const checks = new Scope(p.project, p.example('office'), p.store, 'sample').prepare('rulesSkills').calls[0]!.checks;
    expect(checks.length).toBeGreaterThan(0);
    const skill = (target: string) => ({ target });
    const helpOnly = { physical_melee: { tier_1: [skill('ally'), skill('self')] }, physical_ranged: { tier_1: [skill('self')] }, magic_melee: { tier_1: [skill('ally')] }, magic_ranged: { tier_1: [skill('ally')] } };
    expect(unmet(checks, helpOnly)).toContain('needs a skill used on an enemy in tier_1');
    const fights = Object.fromEntries(Object.keys(helpOnly).map((k) => [k, { tier_1: [skill('ally'), skill('enemy')] }]));
    expect(unmet(checks, fights)).toBeNull();
  });
});
