import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { currentWays, questSteps, type QuestProgress } from '@daydream/shared';
import { Pipeline } from '../src/pipeline/index.ts';
import { exampleFacts } from '../src/pipeline/facts.ts';
import { follow } from '../src/pipeline/path.ts';
import { PIPELINE_DIR } from '../src/pipeline/project.ts';
import { resolve } from '../src/pipeline/schema.ts';
import { render } from '../src/pipeline/template.ts';
import { Scope, unmet } from '../src/pipeline/scope.ts';
import { repeats } from '../src/pipeline/names.ts';
import { noUsage } from '../src/pipeline/store.ts';
import type { Example } from '../src/pipeline/types.ts';

/** A pipeline of its own, in a temporary folder, with the given steps (and the repository's examples and constants). */
function scratch(steps: Record<string, string>, records = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-'));
  fs.cpSync(path.join(PIPELINE_DIR, 'examples'), path.join(dir, 'examples'), { recursive: true });
  fs.copyFileSync(path.join(PIPELINE_DIR, 'constants.yaml'), path.join(dir, 'constants.yaml'));
  fs.writeFileSync(path.join(dir, 'records.yaml'), records);
  fs.mkdirSync(path.join(dir, 'steps'));
  for (const [id, text] of Object.entries(steps)) fs.writeFileSync(path.join(dir, 'steps', `${id}.yaml`), text);
  return new Pipeline({ dir, runs: path.join(dir, 'runs'), cap: 0 });
}

describe('build pipeline', () => {
  it("checks the repository's own steps without a problem", () => {
    const p = new Pipeline({ cap: 0 });
    for (const ex of p.project.examples.keys()) {
      const an = p.analyze(ex);
      expect(an.problems).toEqual([]);
      for (const s of Object.values(an.steps)) expect(s.problems, `${ex} ${s.id}`).toEqual([]);
      for (const r of an.records) expect(r.problems, `${ex} record ${r.name}`).toEqual([]);
      expect(an.order.indexOf('concept')).toBeLessThan(an.order.indexOf('story'));
    }
  });

  it('reads paths with lists, filters, lengths and positions', () => {
    const root = { a: { list: [{ k: 'x', v: 1 }, { k: 'y', v: 2 }, { k: 'x', v: 3 }] }, n: null };
    expect(follow(root, 'a.list[k=x].v')).toEqual({ kind: 'many', items: [{ value: 1, owner: root.a.list[0] }, { value: 3, owner: root.a.list[2] }] });
    expect(follow(root, 'a.list[k=y].length')).toEqual({ kind: 'one', value: 1 });
    expect(follow(root, 'n.anything')).toEqual({ kind: 'one', value: null });
    expect(follow(root, 'missing')).toEqual({ kind: 'none' });
    const problems = new Set<string>();
    expect(render('{{#a.list[k=x]}}{{v}}{{^$last}}, {{/$last}}{{/a.list[k=x]}}', root, problems)).toBe('1, 3');
    expect(render('{{nope}}', root, problems)).toBe('');
    expect([...problems]).toEqual(['"nope" is not there']);
    // A null is no item, and a constant is a partial that reads what the template reads.
    expect(follow({ k: { a: { n: 1 }, b: null } }, 'k[*].n')).toEqual({ kind: 'many', items: [{ value: 1, owner: { n: 1 } }] });
    expect(render('{{#a.list[k=y]}}{{> say}}{{/a.list[k=y]}}', root, problems, { say: 'v is {{v}}' })).toBe('v is 2');
    // A list or an object prints only on purpose, as JSON.
    expect(render('{{json a.list[k=y]}} {{json words}}', { ...root, words: ['a', 'b'] }, problems)).toBe('[{"k":"y","v":2}] ["a","b"]');
    expect([...problems]).toEqual(['"nope" is not there']);
  });

  it('reads a list length from a path, per key', () => {
    const view = { tiers: [{ id: 't1', size: 2 }, { id: 't2', size: 1 }] };
    const problems = new Set<string>();
    const ctx = { root: (item: unknown) => ({ ...view, $: item }), problems };
    const r = resolve({ keys: { from: 'tiers[*].id' }, each: { type: 'array', minItems: { from: '$.size' }, maxItems: { from: '$.size' }, items: { type: 'string' } } }, ctx, undefined);
    expect([(r?.properties as Record<string, { minItems: number; maxItems: number }>).t1!.maxItems, (r?.properties as Record<string, { minItems: number }>).t2!.minItems]).toEqual([2, 1]);
    expect([...problems]).toEqual([]);
  });

  it('finds the names of an answer that repeat earlier ones or each other, keeping the first', () => {
    const names = { own: ['s[*][*].name'], taken: ["Giant's Twitch"] };
    const answer = { a: [{ name: 'giants twitch' }, { name: 'Ember' }], b: [{ name: 'EMBER' }, { name: 'Ash' }] };
    expect(repeats(names, answer)).toEqual([
      { at: ['a', 0, 'name'], name: 'giants twitch' },
      { at: ['b', 0, 'name'], name: 'EMBER' },
    ]);
    expect(repeats({ own: ['s[*][*].name'], taken: [] }, { a: [{ name: 'Ash' }] })).toEqual([]);
  });

  it('asks again for an answer that lacks what its checks need', () => {
    const checks = [{ says: 'No attribute raises', in: ['attrs[*].main', 'attrs[*].also[*]'], has: ['health', 'dodge'] }];
    expect(unmet(checks, { attrs: [{ main: 'health', also: ['speed'] }] })).toBe('No attribute raises: dodge');
    expect(unmet(checks, { attrs: [{ main: 'speed', also: ['dodge', 'health'] }] })).toBeNull();
  });

  it('cuts the map into stretches that start at a town', () => {
    const ex: Example = { id: 'k', input: { theme: 'A sinking kingdom', size: 'medium', length: 'short', communication: 2 } };
    const { map } = exampleFacts(ex);
    expect(map.arcs.map((a) => a.stretch[0]!.kind)).toEqual(['town', 'town']);
    expect(map.arcs.flatMap((a) => a.stretch)).toEqual(map.places);
    expect(map.arcs[0]!.cast.every((c) => c.town === map.towns[0])).toBe(true);
  });

  it('joins keyed outputs to their places, notes what is read, and flags what is not', () => {
    const p = scratch(
      {
        plan: `purpose: world.design\nsystem: ''\nuser: plan\nschema:\n  type: object\n  properties:\n    places:\n      keys: { from: 'map.places[*].id' }\n      each:\n        type: object\n        properties:\n          name: { type: string }\n          secret: { type: string }\n`,
        tale: `purpose: world.design\nsystem: ''\nuser: |\n  {{#map.places}}\n  - {{plan.name}}\n  {{/map.places}}\nschema:\n  type: object\n  properties:\n    where: { enum: { from: 'map.places[kind=town].plan.name' } }\n`,
        loop1: `purpose: world.design\nsystem: ''\nuser: '{{loop2.x}}'\nschema: { type: object, properties: { x: { type: string } } }\n`,
        loop2: `purpose: world.design\nsystem: ''\nuser: '{{loop1.x}}'\nschema: { type: object, properties: { x: { type: string } } }\n`,
      },
    );
    const ex = [...p.project.examples.keys()][0]!;
    const an = p.analyze(ex);
    expect(an.steps.tale!.reads).toEqual(['plan']);
    expect(an.steps.plan!.readBy).toContain('tale');
    expect(an.steps.plan!.unread).toEqual(['plan.places[*].secret']);
    expect(an.steps.tale!.unread).toEqual(['tale.where']);
    expect(an.problems.some((x) => /read each other/.test(x))).toBe(true);
    const pv = p.preview(ex, 'tale', 'sample');
    expect(pv.calls[0]!.user).toContain('⟨plan.places.t0_0.name⟩');
    expect(p.status(ex).tale).toEqual({ state: 'missing' });
  });

  it('flags a path to a field that the step it reads has in no world, not one that is off in this world', () => {
    const p = scratch({
      sys: `purpose: world.design\nsystem: ''\nuser: sys\nschema: { type: object, properties: { mode: { enum: [plain, magic] } } }\n`,
      core: `purpose: world.design\nsystem: ''\nuser: core\nschema:\n  type: object\n  properties:\n    kinds:\n      type: object\n      properties:\n        blade: { type: object, properties: { damage: { type: string } } }\n        healer: { type: object, properties: { heal: { type: string } } }\n    magic: { type: object, when: 'sys.mode=magic', properties: { power: { type: string } } }\n`,
      // Some kinds have damage and magic is off in this world: both are fine. No kind has an element, and core
      // has no "gone": both find nothing, as the others do, and are problems.
      fight: `purpose: world.design\nsystem: ''\nuser: |\n  {{#core.kinds[*].damage}}{{.}}{{/core.kinds[*].damage}}\n  {{#core.magic}}{{power}}{{/core.magic}}\n  {{#core.kinds[*].element}}{{.}}{{/core.kinds[*].element}}\nschema:\n  type: object\n  properties:\n    x: { type: string }\n    y: { type: string, when: core.gone }\n`,
    });
    const steps = p.analyze('office').steps;
    expect(steps.core!.problems).toEqual([]);
    expect(steps.fight!.problems).toEqual(['"core.gone" is not a field of core', '"core.kinds[*].element" is not a field of core']);
  });

  it("runs a step for each item, joins entries keyed inside its answer, and positions plain items", () => {
    const p = scratch({
      life: `purpose: world.design\nsystem: ''\nforEach: map.towns\nuser: '{{$.id}}'\nschema:\n  type: object\n  properties:\n    residents:\n      keys: { from: '$.residents[*].id' }\n      each: { type: object, properties: { name: { type: string } } }\n`,
      roll: `purpose: world.design\nsystem: ''\nuser: |\n  {{#map.towns}}{{#residents}}{{life.name}}; {{/residents}}{{/map.towns}}\n  {{#input.systems.revive}}{{.}}{{^$last}}, {{/$last}}{{/input.systems.revive}}\nschema: { type: object, properties: { x: { type: string } } }\n`,
    });
    // A step's id is found after the item's own fields (a resident's `town` is the place it is in).
    const ex = 'office';
    const an = p.analyze(ex);
    expect(an.steps.roll!.reads).toEqual(['life']);
    expect(an.steps.life!.unread).toEqual([]);
    const user = p.preview(ex, 'roll', 'sample').calls[0]!.user;
    expect(user).toContain('⟨life.t0_0.residents.t0_0_r1.name⟩; ');
    // A list of texts knows its last item too.
    expect(user).toContain('heal, special, after_combat');
    expect(p.preview(ex, 'life', 'sample').calls.map((c) => c.item)).toEqual(p.facts(ex).map.towns.map((t) => t.id));
  });

  /** A pipeline whose every step "ran" with the answer its schema makes up, in order, so later steps' enums choose from it. */
  function madeUp(ex: string) {
    const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-runs-'));
    const p = new Pipeline({ runs, cap: 0 });
    for (const id of p.analyze(ex).order) {
      const value = new Scope(p.project, p.example(ex), p.store, 'saved').output(id)!.value;
      p.store.save({ step: id, example: ex, at: Date.now(), ms: 0, fingerprint: { sent: '', reads: [] }, requests: [], usage: noUsage(), output: value });
    }
    return p;
  }

  it("assembles the repository's steps into a world, from made-up answers", () => {
    const ex = 'sinkingKingdom';
    const p = madeUp(ex);
    const w = p.world(ex);
    const facts = p.facts(ex);
    expect(w.zones.map((z) => z.id)).toEqual(facts.map.places.map((x) => x.id));
    expect(w.npcs.length).toBe(facts.map.cast.length + facts.map.residents.length);
    expect(w.quests.filter((q) => !q.main).length).toBe(facts.map.towns.reduce((n, t) => n + t.quests.length, 0));
    // Every reference is to something that exists.
    const npcs = new Set(w.npcs.map((n) => n.id));
    for (const q of w.quests) {
      expect(npcs.has(q.giverNpcId!)).toBe(true);
      for (const o of q.objectives) if (o.npcId) expect(npcs.has(o.npcId), `${q.id} ${o.id}`).toBe(true);
    }
    expect(w.ruleset.classes.length).toBeGreaterThan(0);

    // An answer made before the places were named again says so, instead of failing somewhere inside.
    const people = structuredClone(p.store.latest(ex, 'people')!.output) as Record<string, { cast: Record<string, { secrets: { stash?: unknown }[] }> }>;
    const someone = Object.values(Object.values(people)[0]!.cast)[0]!;
    someone.secrets = [{ ...someone.secrets[0], stash: { place: 'The Old Name', thing: 'a key' } }];
    p.store.save({ step: 'people', example: ex, at: Date.now(), ms: 0, fingerprint: { sent: '', reads: [] }, requests: [], usage: noUsage(), output: people });
    expect(() => p.world(ex)).toThrow('An answer names the place "The Old Name", which placePlan no longer has');
  });

  it('lets the clever way stand for everything the fighting way does, finding what the fight wins included', () => {
    const ex = 'sinkingKingdom';
    const p = madeUp(ex);
    const w0 = p.world(ex);
    const story = structuredClone(p.store.latest(ex, 'story')!.output) as { arcs: Record<string, { quests: { giver: string; steps: unknown[] }[] }> };
    const quest = Object.values(story.arcs)[0]!.quests[0]!;
    const wild = w0.zones.find((z) => z.kind !== 'town')!.name;
    const member = w0.families[0]!.members[0]!.name;
    quest.steps = [
      { kind: 'either', otherwise: { kind: 'persuade', person: quest.giver, to: 'let the stairs vote without the token' },
        fight: [{ kind: 'foe', name: 'Count Tumbleturn', who: 'a spinning count', member, where: wild, taunt: 'Round we go!', voice: 'dizzy' }, { kind: 'bring', item: 'the brass token', from: wild, to: quest.giver }] },
    ];
    p.store.save({ step: 'story', example: ex, at: Date.now(), ms: 0, fingerprint: { sent: '', reads: [] }, requests: [], usage: noUsage(), output: story });
    const def = p.world(ex).quests.find((q) => q.main && q.objectives.some((o) => o.type === 'persuade'))!;
    const choice = questSteps(def).find((ways) => ways.length === 2);
    expect(choice!.map((way) => way.map((o) => o.type))).toEqual([['kill_unique', 'collect', 'deliver'], ['persuade']]);
    // Won over, the person asks for nothing more of that step: the token is no longer wanted.
    const persuade = choice![1]![0]!;
    const done = [...def.objectives.filter((o) => o.step! < persuade.step!), persuade];
    const prog: QuestProgress = { questId: def.id, status: 'active', objectives: Object.fromEntries(done.map((o) => [o.id, { progress: 1, done: true }])), log: [], startedDay: 1 };
    expect(currentWays(def, prog).map((o) => o.description)).toEqual([expect.stringMatching(/^Return to /)]);
  });

  it('keeps edits to a step and makes variants that nothing reads', () => {
    const p = scratch({ one: `# A comment that stays.\npurpose: world.design\nsystem: ''\nuser: hello\nschema: { type: object, properties: { x: { type: string } } }\n` });
    p.project.saveStep('one', { user: 'line one\nline two', maxTokens: 900 });
    const text = p.project.stepText('one');
    expect(text).toContain('# A comment that stays.');
    expect(text).toContain('user: |-\n  line one\n  line two');
    expect(p.project.steps.get('one')!.maxTokens).toBe(900);
    const copy = p.project.duplicateStep('one');
    expect(copy).toBe('one_2');
    expect(p.project.steps.get(copy)!.user).toBe('line one\nline two');
    expect(() => p.project.saveStep('../escape', { user: 'x' })).toThrow();
  });

  it('lists the steps by order.yaml, checks the list, and keeps it up to date', () => {
    const step = (user: string) => `purpose: world.design\nsystem: ''\nuser: '${user}'\nschema: { type: object, properties: { x: { type: string } } }\n`;
    const p = scratch({ a: step('hello'), b: step('{{a.x}}'), c: step('hello') });
    const ex = [...p.project.examples.keys()][0]!;
    const order = path.join(p.project.dir, 'order.yaml');
    fs.writeFileSync(order, '# Kept.\nLater: [b]\nFirst: [a, ghost]\n');
    p.project.reload();
    let an = p.analyze(ex);
    expect(an.groups.map((g) => [g.name, g.steps])).toEqual([['Later', ['b']], ['First', ['a']], ['Not in order.yaml', ['c']]]);
    expect(an.problems).toEqual(['order.yaml lists "ghost" in First, and there is no such step', 'order.yaml lists "b" before "a", which it reads', 'order.yaml does not list "c"']);
    expect(an.order.indexOf('a')).toBeLessThan(an.order.indexOf('b'));

    fs.writeFileSync(order, '# Kept.\nFirst: [a, c]\nLater: [b]\n');
    p.project.reload();
    expect(p.analyze(ex).problems).toEqual([]);
    p.project.duplicateStep('a');
    p.project.createStep('d');
    p.project.deleteStep('c');
    an = p.analyze(ex);
    expect(an.groups.map((g) => g.steps)).toEqual([['a', 'a_2'], ['b', 'd']]);
    expect(an.order).toEqual(['a', 'a_2', 'b', 'd']);
    expect(fs.readFileSync(order, 'utf8')).toContain('# Kept.');
  });
});
