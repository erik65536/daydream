/**
 * The quest check: a static look at a finished world (every place furnished) for quests that cannot be finished.
 * Nothing is simulated. It asks whether everything each quest needs exists, can be reached from the start, and is
 * there by the time the quest needs it, not locked behind the same quest, a later one, or a ring of prerequisites:
 * - the people to talk to, persuade, or deliver to, and the bosses and creatures to defeat, placed in a place that can
 *   be reached (a boss or named foe a quest is sent to defeat appears once that quest has begun, and one defeated
 *   earlier counts when the quest comes to it, so neither can be missed);
 * - every item to collect or deliver: a chest, a boss, or a quest that rewards it, each available early enough and
 *   not used up by an earlier delivery;
 * - the main story: one chain from the opening quest to the final one.
 *
 * Quests are made finishable where they are written: a step can name only what exists (its schema's enums), and the
 * world is made around the quests (pipeline/world.ts brings the creatures a quest fights into its place and puts what
 * it asks for there). This check is the build's last guard, so a problem it finds is a bug in
 * the build, logged for the owner; it is also run on built worlds by cli/questcheck.ts.
 */
import type { QuestDef, QuestObjective, WorldDefinition, ZoneDef } from '@daydream/shared';

export interface QuestProblem {
  questId: string;
  objectiveId?: string;
  /** What is wrong, as a short sentence. */
  text: string;
}

/**
 * The check's verdict on a world, kept on it (`questProblems`, for the world viewer): the problems of its main story,
 * which keep it from being ready, and those of its side quests, which are warnings. A problem with no quest of its
 * own (the final quest missing, an arc naming a quest that does not exist) is the story's.
 */
export function questVerdict(w: WorldDefinition): { story: QuestProblem[]; side: QuestProblem[] } {
  const problems = checkQuests(w);
  const main = (p: QuestProblem) => w.quests.find((q) => q.id === p.questId)?.main ?? true;
  w.questProblems = problems.length ? problems : undefined;
  return { story: problems.filter(main), side: problems.filter((p) => !main(p)) };
}

export function checkQuests(w: WorldDefinition): QuestProblem[] {
  const out: QuestProblem[] = [];
  const zones = new Map(w.zones.map((z) => [z.id, z]));
  const npcs = new Map(w.npcs.map((n) => [n.id, n]));
  const bosses = new Map(w.bosses.map((b) => [b.id, b]));
  const families = new Map(w.families.map((f) => [f.id, f]));
  const quests = new Map(w.quests.map((q) => [q.id, q]));
  const name = (zoneId: string) => zones.get(zoneId)?.name ?? zoneId;

  // ---------------------------------------------------------------- places reached from the start through ways out
  const reachable = new Set<string>();
  const walk = [w.startZoneId];
  while (walk.length) {
    const id = walk.pop()!;
    if (reachable.has(id) || !zones.has(id)) continue;
    reachable.add(id);
    for (const f of zones.get(id)!.features) if (f.kind === 'exit' && f.targetZoneId) walk.push(f.targetZoneId);
  }

  // ---------------------------------------------------------------- when each quest can be finished
  // A quest's rank: main quests by their place in the story (prerequisites first), side quests at 0 (open at once).
  // A ring of prerequisites, or one on a quest that does not exist, can never start.
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const rankOf = (id: string): number => {
    if (rank.has(id)) return rank.get(id)!;
    const q = quests.get(id);
    if (!q || visiting.has(id)) return Infinity;
    visiting.add(id);
    const r = q.prerequisites.length ? Math.max(...q.prerequisites.map(rankOf)) + 1 : 0;
    visiting.delete(id);
    rank.set(id, r);
    return r;
  };
  /** Quest `a` is finished (or started) before quest `q` needs what it brings: earlier in the story, or a side quest. */
  const before = (a: string, q: QuestDef) => rankOf(a) !== Infinity && (rankOf(a) < rankOf(q.id) || (!quests.get(a)?.main && !q.main));
  for (const q of w.quests) {
    for (const pre of q.prerequisites) if (!quests.has(pre)) out.push({ questId: q.id, text: `its prerequisite ${pre} does not exist` });
    if (rankOf(q.id) === Infinity) out.push({ questId: q.id, text: 'its prerequisites form a ring (or lead to a missing quest), so it can never start' });
  }

  // ---------------------------------------------------------------- where each unique item comes from
  // Each source gives the item once: a chest, a boss's drop, a quest's reward.
  type Source = { what: string; zoneId?: string; rewardOf?: string; bossId?: string };
  const sources = new Map<string, Source[]>();
  const addSource = (u: string, s: Source) => sources.set(u, [...(sources.get(u) ?? []), s]);
  for (const z of w.zones)
    for (const f of z.features)
      if (f.kind === 'chest') for (const u of f.items ?? []) addSource(u, { what: `a chest in ${z.name}`, zoneId: z.id });
  for (const b of w.bosses) for (const u of b.drops) addSource(u, { what: b.name, zoneId: b.zoneId, bossId: b.id });
  for (const q of w.quests) for (const u of q.rewards.items) if (!u.includes(':')) addSource(u, { what: `the reward of ${q.title}`, rewardOf: q.id });
  /** A boss can be fought: it is placed in its place and the place is reachable. */
  const bossPlaced = (bossId: string) => {
    const b = bosses.get(bossId);
    return !!b && reachable.has(b.zoneId) && !!zones.get(b.zoneId)?.spawns.some((s) => s.bossId === bossId);
  };
  /** Why this source cannot give the item to quest `q`, or null when it can. */
  const unusable = (s: Source, q: QuestDef, usedBy: string | undefined): string | null => {
    if (s.zoneId && !reachable.has(s.zoneId)) return `${s.what} is in ${name(s.zoneId)}, which no way out leads to`;
    if (s.bossId && !bossPlaced(s.bossId)) return `${s.what} is not placed`;
    // A quest foe appears once a quest sent to defeat it has begun.
    const hunts = s.bossId ? w.quests.filter((x) => x.objectives.some((o) => o.type === 'kill_unique' && o.targetId === s.bossId)) : [];
    if (hunts.length && !hunts.some((x) => x.id === q.id || before(x.id, q))) return `${s.what} appears only with ${hunts[0]!.title}, which starts later`;
    if (s.rewardOf === q.id) return `it is the quest's own reward`;
    if (s.rewardOf && !before(s.rewardOf, q)) return `it comes from ${s.what}, which only finishes later`;
    if (usedBy && usedBy !== q.id) return `it was already handed over in ${quests.get(usedBy)?.title}`;
    return null;
  };

  // Items handed over in deliveries are used up: a source serves the first quest that delivers it.
  const deliveredBy = new Map<string, string>();
  const byRank = [...w.quests].sort((a, b) => rankOf(a.id) - rankOf(b.id));

  // ---------------------------------------------------------------- each quest and objective
  const person = (q: QuestDef, o: QuestObjective | undefined, id: string | undefined, role: string) => {
    if (!id) return;
    const n = npcs.get(id);
    if (!n) return out.push({ questId: q.id, objectiveId: o?.id, text: `${role} ${id} does not exist` });
    if (!reachable.has(n.zoneId)) out.push({ questId: q.id, objectiveId: o?.id, text: `${role} ${n.name} is in ${name(n.zoneId)}, which no way out leads to` });
  };
  const place = (q: QuestDef, o: QuestObjective, zoneId: string | undefined): ZoneDef | undefined => {
    const z = zoneId ? zones.get(zoneId) : undefined;
    if (!z) out.push({ questId: q.id, objectiveId: o.id, text: `the place ${zoneId ?? '(none)'} does not exist` });
    else if (!reachable.has(z.id)) out.push({ questId: q.id, objectiveId: o.id, text: `${z.name} is not reached by any way out from the start` });
    return z;
  };

  for (const q of byRank) {
    person(q, undefined, q.giverNpcId, 'the quest giver');
    if (!q.objectives.length) out.push({ questId: q.id, text: 'it has no objectives' });
    const ids = new Set<string>();
    for (const [i, o] of q.objectives.entries()) {
      const p = (text: string) => out.push({ questId: q.id, objectiveId: o.id, text });
      if (ids.has(o.id)) p(`two objectives share the id ${o.id}`);
      ids.add(o.id);
      switch (o.type) {
        case 'talk':
        case 'persuade':
          if (!o.npcId) p(`it says ${o.type} but names nobody`);
          person(q, o, o.npcId, 'the person');
          break;
        case 'kill': {
          const f = o.familyId ? families.get(o.familyId) : undefined;
          if (!f) {
            p(`the creature family ${o.familyId ?? '(none)'} does not exist`);
            break;
          }
          const home = o.zoneId ? place(q, o, o.zoneId) : undefined;
          if (o.zoneId && !home) break;
          const where = (home ? [home] : w.zones).filter((z) => reachable.has(z.id));
          if (!where.some((z) => z.spawns.some((s) => s.familyId === f.id && !s.bossId)))
            p(`no ${f.name} live ${home ? `in ${home.name}` : 'in any place the party can reach'}`);
          break;
        }
        case 'kill_unique': {
          const id = o.targetId ?? '';
          if (bosses.has(id)) {
            if (!bossPlaced(id)) p(`the boss ${bosses.get(id)!.name} is not placed in ${name(bosses.get(id)!.zoneId)}, or no way out leads there`);
          } else if (npcs.has(id)) p(`the foe ${npcs.get(id)!.name} is a person, and people are not fought`);
          else p(`the foe ${id || '(none)'} does not exist`);
          break;
        }
        case 'collect':
        case 'deliver': {
          if (o.type === 'deliver') person(q, o, o.npcId, 'the person to deliver to');
          const u = o.itemUniqueId;
          if (!u) {
            p('it asks for an item but names none');
            break;
          }
          if (!w.uniqueItems[u]) {
            p(`the item ${u} does not exist`);
            break;
          }
          // Collected earlier in the same quest: its sources were checked there.
          const collected = q.objectives.slice(0, i).some((x) => x.type === 'collect' && x.itemUniqueId === u);
          if (!collected) {
            const all = sources.get(u) ?? [];
            const reasons = all.map((s) => unusable(s, q, deliveredBy.get(u)));
            if (!reasons.some((r) => r === null)) {
              const item = w.uniqueItems[u]!.name;
              p(all.length ? `${item} cannot be had in time: ${reasons.join('; ')}` : `${item} is nowhere in the world: no chest, boss, or quest has it`);
            }
          }
          if (o.type === 'deliver') deliveredBy.set(u, q.id);
          break;
        }
      }
    }
  }

  // ---------------------------------------------------------------- the main story
  const main = w.quests.filter((q) => q.main);
  if (main.length) {
    if (!quests.get(w.finalQuestId)?.main) out.push({ questId: w.finalQuestId || '(none)', text: 'the final quest is not a main quest of this world' });
    const openers = main.filter((q) => !q.prerequisites.length);
    if (openers.length !== 1) out.push({ questId: main[0]!.id, text: `the story should open with exactly one quest; ${openers.length} main quests have no prerequisites` });
    for (const q of main) if (!q.autoStart && !q.giverNpcId) out.push({ questId: q.id, text: 'nobody gives this story quest and it does not start by itself' });
    for (const a of w.arcs) for (const id of a.questIds) if (!quests.has(id)) out.push({ questId: id, text: `arc "${a.title}" lists a quest that does not exist` });
  }
  return out;
}
