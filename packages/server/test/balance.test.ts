import { describe, expect, it } from 'vitest';
import { FIGHTER_KINDS, Rng, canAllocate, knot, chanceAt, characterStats, cleanseCount, codexSections, nextRankLines, rx, skillLines, skillRank, worstFirst, type Effect, type Ruleset, type SkillDef } from '@daydream/shared';
import { balanceRuleset, ruleFindings } from '../src/rules/balance.ts';
import { DESIGN_PARTY, MAX_PACK, buildPack, fitPack } from '../src/rules/encounters.ts';
import { makeParty, runFight } from '../src/rules/sim.ts';
import { fixtureRules as rules } from './helpers.ts';

/** The two example worlds whose rules are saved for tests (test/fixtures/rules/). */
const EXAMPLES = ['woodland', 'office'] as const;

/** Every reference inside a compiled ruleset points at something that exists. */
function referenceErrors(r: Ruleset): string[] {
  const ix = rx(r);
  const errs: string[] = [];
  for (const s of r.skills) {
    for (const e of s.effects) {
      if (e.kind === 'status' && !ix.status.has(e.statusId)) errs.push(`${s.id}: status ${e.statusId}`);
      if (e.kind === 'damage' && e.typeId && !ix.type.has(e.typeId)) errs.push(`${s.id}: type ${e.typeId}`);
    }
  }
  for (const c of r.classes) {
    if (!ix.type.has(c.damageTypeId)) errs.push(`${c.id}: damage ${c.damageTypeId}`);
    if (!c.startingSkills.length) errs.push(`${c.id}: no first skill`);
    for (const id of c.startingSkills) if (!ix.skill.has(id)) errs.push(`${c.id}: starting skill ${id}`);
    for (const n of c.nodes) {
      if (n.classId !== c.id) errs.push(`${c.id}: node ${n.id} of ${n.classId}`);
      if (n.skillId && !ix.skill.has(n.skillId)) errs.push(`${c.id}: node ${n.id} skill ${n.skillId}`);
    }
    for (let t = 0; t < r.progression.tierRequirements.length; t++) if (!c.nodes.some((n) => n.tier === t)) errs.push(`${c.id}: tier ${t} is empty`);
    for (const [slot, base] of Object.entries(c.startingGear)) if (!ix.slot.has(slot) || !ix.item.has(base)) errs.push(`${c.id}: gear ${slot}=${base}`);
  }
  for (const i of r.items) if (i.slotId && !ix.slot.has(i.slotId)) errs.push(`${i.id}: slot ${i.slotId}`);
  for (const k of FIGHTER_KINDS) if (!r.fighters[k]) errs.push(`no ${k}`);
  if (r.slots.filter((s) => s.kind === 'weapon').length !== 1) errs.push('exactly one weapon slot');
  return errs;
}

describe('generated rulesets', () => {
  it("compiles every example world's rules into a consistent ruleset", () => {
    for (const ex of EXAMPLES) {
      const r = rules(ex);
      expect(referenceErrors(r), ex).toEqual([]);
      expect(r.classes.length, ex).toBeGreaterThanOrEqual(3);
      // Tiers open by the points spent in a class, the first at once.
      expect(r.progression.tierRequirements[0], ex).toBe(0);
      expect(r.statuses.every((s) => !s.control || ['root', 'silence', 'disarm', 'stun'].includes(s.control)), ex).toBe(true);
    }
  });

  it('gives each skill one pick in its tree, whose ranks strengthen everything it does', () => {
    for (const ex of EXAMPLES) {
      const r = rules(ex);
      const ix = rx(r);
      for (const s of r.skills.filter((x) => x.id !== r.basicAttackId)) {
        const picks = r.classes.flatMap((c) => c.nodes).filter((n) => n.skillId === s.id);
        expect(picks.map((n) => n.kind), `${ex} ${s.name}`).toEqual(['skill']);
        // Every skill has ranks, and its ranks change what it does (a control leaves room to grow; a cleanse removes more).
        expect(s.maxRank, `${ex} ${s.name}`).toBeGreaterThan(1);
        expect(picks[0]!.maxRank, `${ex} ${s.name}`).toBe(s.maxRank);
        const stats = characterStats(r, { classId: s.owner, kinId: '', level: 3, tree: {}, equipment: {}, statuses: [] });
        expect(nextRankLines(r, s, 1, stats).length, `${ex} ${s.name}`).toBeGreaterThan(0);
        for (const e of s.effects) if (e.kind === 'status' && ix.status.get(e.statusId)?.control) {
          const chances = Array.from({ length: s.maxRank }, (_, i) => chanceAt(e, s, i + 1));
          expect(chances[0], `${ex} ${s.name}`).toBeLessThan(1);
          for (let i = 1; i < chances.length; i++) expect(chances[i], `${ex} ${s.name} rank ${i + 1}`).toBeGreaterThan(chances[i - 1]!);
          expect(chances.at(-1), `${ex} ${s.name}`).toBe(1);
        }
      }
      // The last rank of a control is certain whatever its first-rank chance and the balance loop's correction, and
      // the skill says so.
      const controlled = r.skills.find((x) => x.effects.some((e) => e.kind === 'status' && ix.status.get(e.statusId)?.control));
      if (controlled) {
        const weak: SkillDef = { ...controlled, tune: 0.85, effects: controlled.effects.map((e) => (e.kind === 'status' && ix.status.get(e.statusId)?.control ? { ...e, chance: 0.74 } : e)) };
        const e = weak.effects.find((x) => x.kind === 'status' && ix.status.get(x.statusId)?.control) as Extract<Effect, { kind: 'status' }>;
        expect(chanceAt(e, weak, 1)).toBe(0.74);
        expect(chanceAt(e, weak, weak.maxRank)).toBe(1);
        const name = ix.status.get(e.statusId)!.name;
        expect(skillLines(r, weak, 1).some((l) => l.startsWith(`74% chance to put ${name}`)), ex).toBe(true);
        expect(skillLines(r, weak, weak.maxRank).some((l) => l.startsWith(`Puts ${name}`)), ex).toBe(true);
      }
      // Every gate leaves a choice: the tiers before it offer more picks than it asks, even to a hero of the class
      // (whose first skill comes free).
      for (const c of r.classes) {
        const picks = (tier: number) => c.nodes.filter((n) => n.tier === tier).reduce((sum, n) => sum + n.maxRank, 0) - (tier === 0 ? 1 : 0);
        let before = 0;
        r.progression.tierRequirements.forEach((gate, tier) => {
          if (tier > 0) expect(before, `${ex} ${c.name} tier ${tier + 1}`).toBeGreaterThan(gate);
          before += picks(tier);
        });
      }
      // A class's first skill comes free; each point in its pick is a rank, up to its last.
      const cls = r.classes[0]!;
      const first = ix.skill.get(cls.startingSkills[0]!)!;
      const pick = ix.skillNode.get(first.id)!;
      const ch = { classId: cls.id, tree: {} as Record<string, number>, treePoints: 10 };
      expect(skillRank(r, ch, first.id)).toBe(1);
      for (let rank = 2; rank <= first.maxRank; rank++) {
        expect(canAllocate(r, ch, pick.id)).toBeNull();
        ch.tree[pick.id] = (ch.tree[pick.id] ?? 0) + 1;
        expect(skillRank(r, ch, first.id)).toBe(rank);
      }
      expect(canAllocate(r, ch, pick.id)).not.toBeNull();
      // A cleanse removes the worst harmful statuses first, one more each rank and all at the last.
      const harmful = r.statuses.filter((x) => x.harmful);
      const control = harmful.find((x) => x.control), other = harmful.find((x) => !x.control && !x.dot);
      const cleanse = r.skills.find((x) => x.effects.some((e) => e.kind === 'cleanse'));
      if (control && other && cleanse) {
        const on = [{ id: other.id, turns: 3 }, { id: control.id, turns: 1 }];
        expect(worstFirst(r, on).map((x) => x.id)).toEqual([control.id, other.id]);
        expect(cleanseCount(cleanse, 1)).toBe(1);
        expect(cleanseCount(cleanse, cleanse.maxRank)).toBe(Infinity);
      }
      // A status's stat changes follow the strength of the skill that applied it.
      const st = r.statuses.find((x) => x.modifiers?.some((m) => m.stat.startsWith('dmg:')));
      if (st) {
        const stat = st.modifiers!.find((m) => m.stat.startsWith('dmg:'))!.stat;
        const hero = { classId: cls.id, kinId: '', level: 3, tree: {}, equipment: {} };
        const at = (strength: number) => characterStats(r, { ...hero, statuses: [{ id: st.id, turns: 2, power: 1, strength }] }).pct[stat] ?? 0;
        expect(at(1.3) - at(0)).toBeCloseTo((at(1) - at(0)) * 1.3, 5);
      }
    }
  });

  it('writes a complete codex for every example world', () => {
    for (const ex of EXAMPLES) {
      const r = rules(ex);
      const text = JSON.stringify(codexSections(r));
      expect(text, ex).not.toMatch(/undefined|NaN|\[object/);
      expect(codexSections(r).map((s) => s.id)).toContain('classes');
    }
  });

  it('the simulator runs real fights deterministically', () => {
    const r = rules('woodland');
    const members = r.classes.slice(0, 3).map((c) => ({ fighter: 'soldier' as const, classId: c.id }));
    const fight = () => {
      const rng = new Rng('det');
      const party = makeParty(r, { classes: r.classes.slice(0, 4).map((c) => c.id), level: 3, rng });
      return runFight(r, { party, pack: buildPack(r, rng, { heroes: 4, level: 3, kind: 'normal', members }), potions: 0, difficulty: 'normal', seed: 'x' });
    };
    const a = fight(), b = fight();
    expect(a).toEqual(b);
    expect(a.rounds).toBeGreaterThan(1);
  });

  it('balances a world toward its targets for any party size, and makes difficulty matter', async () => {
    const r = rules('woodland');
    // The suite's longest test, so on four threads: the answers do not depend on the threads.
    const rep = await balanceRuleset(r, { seed: 'test', size: 'quick', threads: 4 });
    const normal = rep.scenarios.filter((s) => s.difficulty === 'normal' && s.id.includes(':normal:'));
    expect(normal.length).toBeGreaterThan(0);
    // Ordinary fights are winnable but cost something, for one hero, four or six. (A quick balance fits each setting in
    // two steps on a few fights, so it lands near its targets, not in them: a quarter of its fights may be lost. A full
    // balance of these rules wins 96 to 100% of them.)
    for (const s of normal) {
      expect(s.winRate, s.label).toBeGreaterThanOrEqual(0.75);
      expect(s.hpLost, s.label).toBeGreaterThan(0.05);
    }
    expect(normal.some((s) => s.heroes === 1) && normal.some((s) => s.heroes === 6)).toBe(true);
    expect(rep.scenarios.filter((s) => s.ok).length / rep.scenarios.length).toBeGreaterThanOrEqual(0.5);
    // Brutal's creatures are stronger than Story's at every tuned level: Health and damage together, since a fit may
    // carry the difference in either.
    const strength = (d: 'story' | 'brutal', level: number) => knot(r.difficulty[d].enemyHp, level) * knot(r.difficulty[d].enemyDmg, level);
    for (const k of r.difficulty.brutal.enemyDmg) expect(strength('brutal', k.level)).toBeGreaterThan(strength('story', k.level));
  }, 240_000);

  it('fits packs to fewer or more heroes than the world was built for', () => {
    const r = rules('woodland');
    // Powers a balance could settle on (the mechanism is tested, not the starting values).
    r.party = { packFewer: 1.6, packMore: 1.6, bossFewer: 2.2, bossMore: 2.2 };
    const members = [0, 1, 2, 3].map((i) => ({ id: `m${i}`, fighter: 'brute' as const }));
    const threat = r.fighters.brute.threat;
    const design = fitPack(r, members, { heroes: DESIGN_PARTY, difficulty: 'story', rand: () => 0.99 });
    expect(design).toEqual({ absent: [], scale: 1, bossScale: 1, extras: [] });
    const solo = fitPack(r, members, { heroes: 1, difficulty: 'story', rand: () => 0.99 });
    expect(solo.absent.length).toBeGreaterThan(0);
    expect(solo.scale).toBeLessThanOrEqual(1);
    // More heroes meet more of the pack, never more than a place holds; the rest of the gap makes them stronger.
    const six = fitPack(r, members, { heroes: 6, difficulty: 'story', rand: () => 0.99 });
    expect(six.extras.length).toBeGreaterThan(0);
    expect(members.length + six.extras.length).toBeLessThanOrEqual(MAX_PACK);
    expect((members.length + six.extras.length) * threat * six.scale).toBeCloseTo(members.length * threat * Math.pow(1.5, r.party.packMore), 0);
    const big = fitPack(r, [...members, ...members.map((m) => ({ ...m, id: `${m.id}b` }))], { heroes: 6, difficulty: 'story', rand: () => 0.99 });
    expect(8 + big.extras.length).toBeLessThanOrEqual(MAX_PACK);
    expect(big.scale).toBeGreaterThan(1);
    // A boss always stays, weaker for fewer heroes and stronger for more, on a steeper curve than its followers.
    const boss = fitPack(r, [{ id: 'b', fighter: 'brute', boss: true }, ...members], { heroes: 1, difficulty: 'normal', rand: () => 0.99 });
    expect(boss.absent).not.toContain('b');
    expect(boss.bossScale).toBeLessThan(boss.scale);
    expect(fitPack(r, [{ id: 'b', fighter: 'brute', boss: true }, ...members], { heroes: 6, difficulty: 'normal', rand: () => 0.99 }).bossScale).toBeGreaterThan(1.5);
    // A named foe always stays too (a quest may send the heroes to defeat it), and is never copied.
    const named = fitPack(r, [...members, { id: 'n', fighter: 'brute', named: true }], { heroes: 1, difficulty: 'normal', rand: () => 0.99 });
    expect(named.absent).not.toContain('n');
    expect(fitPack(r, [...members, { id: 'n', fighter: 'brute', named: true }], { heroes: 6, difficulty: 'normal', rand: () => 0.99 }).extras).not.toContain('n');
  });

  it('names what numbers cannot fix in the rules themselves', () => {
    const r = rules('woodland');
    const before = ruleFindings(r).length;
    // A class with no healing skill learns to heal better.
    const fighter = r.classes.find((c) => !r.skills.some((s) => s.owner === c.id && s.effects.some((e) => e.kind === 'heal' || e.kind === 'revive')))!;
    const passive = fighter.nodes.find((n) => n.kind === 'passive')!;
    passive.modifiers = [{ stat: 'healing', value: 5 }];
    const found = ruleFindings(r);
    expect(found.length).toBeGreaterThan(before);
    expect(found.some((f) => f.kind === 'dead_passive' && f.classId === fighter.id && f.text.includes(passive.name))).toBe(true);
  });
});
