/**
 * The game's world from the pipeline's records: what a build makes of the steps' answers, before anything is
 * painted. Every reference in a record is exact (an engine id, or a name a step chose from what an earlier step
 * made), so nothing here is guessed: a person is found by their id, a place or a creature family by its name.
 *
 * The rules records become the world's ruleset (rules/worldRules.ts). Places are as the game knows them before
 * painting: open ground with everyone near its middle and its creatures standing about, so the world can be played in
 * before it is painted. Painting sets each place's ground, size, light, and where things stand. The build assembles
 * every world this way, and the editor and the CLI talk with an example's people through it (chat.ts).
 */
import {
  LENGTH_PROFILES, Nav, Rng, SIZE_PROFILES, makeNav,
  type ArcDef, type BossDef, type FeatureDef, type LoreNote, type MonsterFamily, type NpcDef, type NpcRole,
  type QuestDef, type QuestObjective, type Ruleset, type UniqueItemDef, type WorldDefinition, type ZoneDef,
} from '@daydream/shared';
import type { z } from 'zod';
import { bindWorld, questRewards, uniqueBase } from '../rules/bind.ts';
import { compileWorldRules, type TierShape } from '../rules/worldRules.ts';
import { TILE_RANGE, fitTiles, type Tiles } from '../worldgen/mapdraw.ts';
import { populate } from '../worldgen/zones.ts';
import type { Facts, Place } from './facts.ts';
import type { RECORDS, RecordName } from './records.ts';
import type { Example } from './types.ts';

/** Every record, as its shape gives it. */
export type Records = { [K in RecordName]: z.infer<(typeof RECORDS)[K]> };

type Step = Records['story']['arcs'][string]['quests'][number]['steps'][number];
/** One thing the heroes do: a step itself, or part of one side of a choice. */
type Act = Exclude<Step, { kind: 'either' }>;

/** How a place looks until its painting sets the light. */
const unpainted = (kind: Place['kind'], indoor: boolean): ZoneDef['look'] => ({ ambient: kind === 'dungeon' ? 0.5 : indoor ? 0.8 : 0.92, lightColor: '#ffe8c0', fogColor: '#101418', outdoor: !indoor, weather: 'none' });
/** A place before painting: open ground (meters), everyone standing near its middle. */
const OPEN = { width: 40, height: 30 };
const middle = { x: OPEN.width / 2, y: OPEN.height / 2 };
const openGround = makeNav(OPEN.width, OPEN.height, () => true);
/** The engine's class id for a class key of the rules steps (physical_melee and the rest). */
const classId = (key: string) => `cl_${key}`;
/** What a later answer names by an earlier step's name: a name that is not there means it was answered before that step ran again. */
function found<T>(named: Map<string, T>, name: string, what: string, step: string): T {
  const v = named.get(name);
  if (v === undefined) throw new Error(`An answer names the ${what} "${name}", which ${step} no longer has: run again the steps marked out of date`);
  return v;
}

/**
 * Each place's map in tiles: the size its plan chose ("3x2", held to what its kind allows), made to fit the tiles all
 * places share. While they use too many, the largest place that can still shrink loses a column or a row from its
 * longer side (the later of two as large, so the places a party starts in keep their room).
 */
export function placeTiles(places: { kind: Place['kind']; size: string }[], budget: number): Tiles[] {
  const tiles = places.map((p) => fitTiles(p.kind, p.size.split('x').map(Number)));
  const area = (t: Tiles) => t[0] * t[1];
  for (let used = tiles.reduce((n, t) => n + area(t), 0); used > budget; ) {
    let at = -1;
    tiles.forEach((t, i) => {
      const { min } = TILE_RANGE[places[i]!.kind];
      if ((t[0] > min[0] || t[1] > min[1]) && (at < 0 || area(t) >= area(tiles[at]!))) at = i;
    });
    if (at < 0) break;
    const t = tiles[at]!, { min } = TILE_RANGE[places[at]!.kind];
    const side = t[1] > min[1] && (t[1] > t[0] || t[0] <= min[0]) ? 1 : 0;
    used -= t[1 - side]!;
    t[side]!--;
  }
  return tiles;
}

/** A world's rules from its records alone (the rules steps' answers), as assembling the world makes them. */
export function compileRules(ex: Example, facts: Facts, rec: Records): Ruleset {
  return compileWorldRules(rec, { maxLevel: LENGTH_PROFILES[ex.input.length].maxLevel, tiers: facts.input.tiers as TierShape[], seed: ex.id, id: `rules_${ex.id}` });
}

export function assemble(ex: Example, facts: Facts, rec: Records): WorldDefinition {
  const input = ex.input;
  const rng = new Rng(`${ex.id}:assemble`);
  const maxLevel = LENGTH_PROFILES[input.length].maxLevel;
  const r = compileRules(ex, facts, rec);

  // ------------------------------------------------------------------ places
  const placeName = (id: string) => rec.places[id]!.name;
  const tiles = placeTiles(facts.map.places.map((p) => ({ kind: p.kind, size: rec.places[p.id]!.size })), SIZE_PROFILES[input.size].tiles);
  const zones: ZoneDef[] = facts.map.places.map((p, i) => ({
    id: p.id,
    name: placeName(p.id),
    kind: p.kind,
    description: rec.places[p.id]!.description,
    regionIndex: p.region,
    levelRange: p.levels,
    look: unpainted(p.kind, rec.places[p.id]!.indoor),
    tiles: tiles[i]!,
    ...OPEN,
    nav: openGround,
    features: [],
    spawns: [],
    indoor: rec.places[p.id]!.indoor || undefined,
    mapPos: p.mapPos,
    links: p.links.map((l) => l.id),
    entry: middle,
    familyIds: [],
  }));
  const zone = new Map(zones.map((z) => [z.id, z]));
  const zoneNamed = new Map(zones.map((z) => [z.name, z]));
  const placeNamed = (name: string) => found(zoneNamed, name, 'place', 'placePlan');
  /** Where things stand is chosen when the place is painted. */
  const add = (z: ZoneDef, f: Omit<FeatureDef, 'x' | 'y'>) => z.features.push({ ...f, ...middle });
  for (const p of facts.map.places) for (const l of p.links) add(zone.get(p.id)!, { id: `${p.id}_exit_${l.id}`, kind: 'exit', targetZoneId: l.id, targetFeatureId: `${l.id}_exit_${p.id}`, name: `To ${placeName(l.id)}` });

  // ------------------------------------------------------------------ creatures and bosses
  const families: MonsterFamily[] = facts.map.families.map((slot) => {
    const f = rec.creatures[slot.id]!;
    return { id: slot.id, name: f.name, description: f.description, members: f.members.map((m) => ({ fighter: m.fighter, classId: classId(m.class), name: m.name, description: m.description, appearance: m.appearance })) };
  });
  const familyNamed = new Map(families.map((f) => [f.name, f]));
  const familyOf = (name: string) => found(familyNamed, name, 'creature family', 'creatures');
  for (const slot of facts.map.families) for (const name of rec.creatures[slot.id]!.lives) placeNamed(name).familyIds.push(slot.id);

  const bosses: BossDef[] = [];
  const bossOf = (id: string, s: Extract<Act, { kind: 'boss' }>) => {
    const z = placeNamed(s.where);
    bosses.push({ id, name: s.name, description: s.who, familyId: z.familyIds[0] ?? families[0]!.id, fighter: 'soldier', classIds: s.classes.map(classId), level: Math.min(maxLevel, z.levelRange[1] + 1), zoneId: z.id, appearance: s.looks, drops: [], taunt: s.taunt, voice: s.voice });
    return id;
  };
  /** A named foe: one of a family, drawn as that creature and fought as a strong one of them, not a boss. */
  const memberNamed = new Map(families.flatMap((f) => f.members.map((m) => [m.name, { f, m }] as const)));
  const foeOf = (id: string, s: Extract<Act, { kind: 'foe' }>) => {
    const z = placeNamed(s.where);
    const { f, m } = found(memberNamed, s.member, 'creature', 'creatures');
    if (!z.familyIds.includes(f.id)) z.familyIds.push(f.id);
    bosses.push({ id, name: s.name, description: s.who, familyId: f.id, fighter: m.fighter, classIds: [m.classId], member: m.name, level: z.levelRange[1], zoneId: z.id, appearance: m.appearance, drops: [], taunt: s.taunt, voice: s.voice });
    return id;
  };

  // ------------------------------------------------------------------ people
  const npcs: NpcDef[] = [];
  const materials = r.items.some((i) => i.category === 'material');
  const life = (l: Records['people'][string]['cast'][string]) => ({
    want: l.want,
    life: l.life,
    manner: l.manner,
    values: { likes: l.likes, dislikes: l.dislikes },
    opinions: l.opinions.map((o) => ({ npcId: o.of, text: o.text })),
    knowledge: l.knowledge,
    secrets: l.secrets.map((s, i): NpcDef['secrets'][number] => {
      if (!s.stash) return { text: s.text, tellsWhen: s.tellsWhen };
      // A secret that tells of a stash puts the stash there, unseen until it is told.
      const z = placeNamed(s.stash.place);
      const id = `${z.id}_stash_${npcs.length}_${i}`;
      add(z, { id, kind: 'chest', name: s.stash.thing.charAt(0).toUpperCase() + s.stash.thing.slice(1), hidden: true, lootTier: z.levelRange[1] + 1 });
      return { text: s.text, tellsWhen: s.tellsWhen, leadsTo: id };
    }),
    greeting: l.greeting,
    returning: l.returning,
    barks: l.barks,
  });
  for (const town of facts.map.towns) {
    const t = rec.towns[town.id]!;
    const inner = rec.people[town.id]!;
    const person = (id: string, role: NpcRole, o: Records['towns'][string]['cast'][string] & { name: string }, essential: boolean): NpcDef => ({
      id,
      name: o.name,
      title: o.title,
      role,
      zoneId: town.id,
      // Around the middle, a step apart, until painting places them.
      x: middle.x + ((npcs.length % 5) - 2) * 1.5,
      y: middle.y + (Math.floor(npcs.length / 5) % 3) * 1.5 - 1.5,
      pronouns: o.pronouns,
      personality: o.personality,
      appearance: o.appearance,
      backstory: o.backstory,
      voice: o.voice,
      ...life((essential ? inner.cast : inner.residents)[id]!),
      level: Math.max(1, town.levels[0] + 1),
      essential,
      questIds: [],
      // Merchants keep to their shops; everyone else walks about.
      wanders: role !== 'merchant',
    });
    for (const c of town.cast) npcs.push(person(c.id, 'story', { ...t.cast[c.id]!, name: rec.story.cast[c.id]!.name }, true));
    for (const slot of town.residents) {
      const o = t.residents[slot.id]!;
      // The seller of materials has a slot before the rules are written: in a world that came out with no craft, and
      // so no materials, they are a resident like any other.
      const sells = slot.merchant === 'materials' && !materials ? null : slot.merchant;
      const n = person(slot.id, sells ? 'merchant' : 'resident', o, false);
      if (sells) n.merchantKind = sells as NpcDef['merchantKind'];
      npcs.push(n);
    }
    const z = zone.get(town.id)!;
    z.buildings = t.buildings.filter((b) => b.keeper).map((b, i) => ({ id: `${town.id}_b${i}`, name: b.name, purpose: b.purpose, npcId: b.keeper! }));
    add(z, { id: `${town.id}_sign`, kind: 'sign', name: 'Sign', text: t.sign });
    // Gear is made, improved, and enchanted at the workbench, and consumables brewed: a town has one when the world
    // has any craft at all.
    if (r.crafting.enabled || r.crafting.upgrades.enabled || r.crafting.enchanting.enabled || r.recipes.length) add(z, { id: `${town.id}_craft`, kind: 'craft_station', name: 'Workbench' });
    if (r.inventory.storage !== 'none') add(z, { id: `${town.id}_storage`, kind: 'storage', name: 'Storage' });
    if (r.systems.fastTravel) add(z, { id: `${town.id}_waypoint`, kind: 'waypoint', name: `${z.name} Waypoint` });
  }
  const npc = new Map(npcs.map((n) => [n.id, n]));
  const nameOf = (id: string) => npc.get(id)?.name ?? id;

  // ------------------------------------------------------------------ quests
  const uniqueItems: Record<string, UniqueItemDef> = {};
  const quests: QuestDef[] = [];
  /**
   * An item a quest has the heroes bring, found in a place. It has a spot of its own, which placement chooses from
   * what it is (where such a thing would be kept, dropped or hidden), and appears once its quest has begun.
   */
  const item = (id: string, name: string, z: ZoneDef, questId: string): { id: string } => {
    const baseId = uniqueBase(r, 'relic', rng.fork(id));
    uniqueItems[id] = { id, baseId, name, description: name, rarityId: r.rarities[2]!.id, mods: [], questItem: true };
    add(z, { id: `${z.id}_find_${id}`, kind: 'chest', name: name.replace(/^(the|a|an) /i, '').replace(/^./, (c) => c.toUpperCase()), items: [id], questId });
    return { id };
  };
  /** A name inside a sentence: "Fight the Lintlings", "Find the market register", not "the The" or "Find The". */
  const inLine = (name: string) => name.replace(/^(the|a|an) /i, (m) => m.toLowerCase());
  const bare = (name: string) => name.replace(/^the /i, '');
  /**
   * A quest's steps as the game's objectives, each step shown once the one before it is done. A step's ways are kept
   * apart (`step`, `way`), each its objectives in order: the fighting way of a choice can be a fight and then finding
   * what it wins, and bringing something takes two objectives, finding it and handing it over. With `goTo`, the quest
   * starts by going to that person, who tells what is going on.
   */
  const objectives = (questId: string, steps: Step[], goTo?: string): QuestObjective[] => {
    const out: QuestObjective[] = [];
    if (goTo) out.push({ id: 'o0', type: 'talk', npcId: goTo, description: `Talk to ${nameOf(goTo)}`, step: 0, way: 0, hidden: false });
    // Foes and things are numbered within their quest: an id never comes from a name, which two may share.
    let foes = 0, things = 0;
    steps.forEach((s, at) =>
      (s.kind === 'either' ? [s.fight, [s.otherwise]] : [[s]]).forEach((acts: Act[], way) => acts.forEach((w) => {
        const step = at + (goTo ? 1 : 0);
        const push = (o: Omit<QuestObjective, 'id' | 'step' | 'way' | 'hidden'>) => out.push({ id: `o${out.length}`, step, way, hidden: step > 0, ...o });
        if (w.kind === 'persuade')
          // The clever way around a fight is shown as someone to see; the plan itself comes out in talking with them.
          push(s.kind === 'either'
            ? { type: 'persuade', npcId: w.person, agree: w.to, description: `Find another way with ${nameOf(w.person)}` }
            : { type: 'persuade', npcId: w.person, description: `Persuade ${nameOf(w.person)} to ${w.to.replace(/[.!]$/, '')}` });
        else if (w.kind === 'fight') {
          const z = placeNamed(w.where);
          const fam = familyOf(w.foes);
          if (!z.familyIds.includes(fam.id)) z.familyIds.push(fam.id);
          push({ type: 'kill', familyId: fam.id, zoneId: z.id, count: 4, description: `Fight the ${bare(fam.name)} in ${z.name}` });
        } else if (w.kind === 'boss') push({ type: 'kill_unique', targetId: bossOf(`b_${questId}_${++foes}`, w), zoneId: placeNamed(w.where).id, description: `Defeat ${w.name} in ${w.where}` });
        else if (w.kind === 'foe') push({ type: 'kill_unique', targetId: foeOf(`b_${questId}_${++foes}`, w), zoneId: placeNamed(w.where).id, description: `Defeat ${w.name} in ${w.where}` });
        else {
          const z = placeNamed(w.from);
          const it = item(`u_${questId}_${++things}`, w.item, z, questId);
          push({ type: 'collect', itemUniqueId: it.id, zoneId: z.id, count: 1, description: `Find ${inLine(w.item)} in ${w.from}` });
          // Right after finding it, the thing is "it": its name is on the line before.
          if (w.to) push({ type: 'deliver', itemUniqueId: it.id, npcId: w.to, count: 1, description: `Bring it to ${nameOf(w.to)}` });
        }
      })),
    );
    return out;
  };
  /** Every quest ends by going back to the one who asked. */
  const andBack = (o: QuestObjective[], giver: string) => {
    const last = o.at(-1);
    const alone = !!last && !o.some((x) => x.step === last.step && x.way !== last.way);
    if (!last || !alone || !(last.npcId === giver && (last.type === 'talk' || last.type === 'deliver' || last.type === 'persuade')))
      o.push({ id: `o${o.length}`, type: 'talk', npcId: giver, description: `Return to ${nameOf(giver)}`, step: (last?.step ?? -1) + 1, way: 0, hidden: o.length > 0 });
    return o;
  };
  /**
   * The level a quest is done at, where its experience counts in the curve (solveProgression): a party is sent to a
   * place on arriving at the bottom of its range, and beats a boss or named foe at its level.
   */
  const levelOf = (o: QuestObjective[], fallback: number) =>
    Math.max(fallback, ...o.map((x) => (x.type === 'kill_unique' ? bosses.find((b) => b.id === x.targetId)?.level ?? 0 : x.zoneId ? zone.get(x.zoneId)!.levelRange[0] : 0)));

  const arcs: ArcDef[] = [];
  let prev: QuestDef | undefined;
  facts.map.arcs.forEach((arc, a) => {
    const st = rec.story.arcs[arc.id]!;
    const def: ArcDef = { index: a, title: st.title, revelation: rec.telling.arcs[arc.id]?.closing ?? '', questIds: [], regionIndex: arc.stretch[0]!.region };
    st.quests.forEach((q, i) => {
      const id = `q_${arc.id}_${i + 1}`;
      // A story quest starts by itself: the heroes go to the one who asks, unless they are with them already.
      const atGiver = prev?.giverNpcId === q.giver;
      const o = andBack(objectives(id, q.steps, atGiver ? undefined : q.giver), q.giver);
      const quest: QuestDef = {
        id, title: q.title, summary: q.background, main: true, arcIndex: a, level: levelOf(o, Math.max(arc.stretch[0]!.levels[0], prev?.level ?? 1)), giverNpcId: q.giver,
        objectives: o, rewards: { xp: 0, gold: 0, items: [] }, prerequisites: prev ? [prev.id] : [], autoStart: true,
      };
      quests.push(quest);
      def.questIds.push(id);
      npc.get(q.giver)?.questIds.push(id);
      prev = quest;
    });
    arcs.push(def);
  });
  for (const town of facts.map.towns)
    for (const slot of town.quests) {
      const q = rec.towns[town.id]!.quests[slot.id]!;
      // A side quest is taken by talking to the one who asks, so it starts with what they ask.
      const o = andBack(objectives(slot.id, q.steps), q.giver);
      quests.push({ id: slot.id, title: q.title, summary: q.background, main: false, level: levelOf(o, town.levels[0]), giverNpcId: q.giver, zoneId: town.id, objectives: o, rewards: { xp: 0, gold: 0, items: [] }, prerequisites: [] });
      npc.get(q.giver)?.questIds.push(slot.id);
    }

  // ------------------------------------------------------------------ what is written in the wild places
  const lore: LoreNote[] = [];
  for (const p of facts.map.areas)
    for (const slot of p.notes) {
      const n = rec.areas[p.id]!.notes[slot.id]!;
      lore.push({ id: slot.id, title: n.title, text: n.text });
      // What it is (a carving on a post) goes with it, for placement to choose where such a thing would be.
      add(zone.get(p.id)!, { id: `${slot.id}_lore`, kind: 'lore', loreId: slot.id, name: n.title, text: n.what });
    }

  const world: WorldDefinition = {
    id: `pipeline_${ex.id}`,
    ownerId: 'pipeline',
    ownerName: 'pipeline',
    public: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'ready',
    input,
    concept: {
      title: rec.concept.title,
      pitch: rec.telling.pitch,
      genre: rec.concept.genre,
      tone: rec.concept.tone,
      artStyle: rec.art.artStyle,
      intro: rec.telling.intro,
      narratorVoice: rec.telling.narratorVoice,
      speech: rec.ownerStyle.speech ?? undefined,
      palette: { ...rec.art.palette, ui: '#1a1a22' },
    },
    ruleset: r,
    maxLevel,
    origins: [],
    uniqueItems,
    families,
    bosses,
    zones,
    npcs,
    quests,
    arcs,
    finalQuestId: prev?.id ?? '',
    ending: rec.telling.ending,
    lore,
    assets: {},
    startZoneId: facts.map.places[0]!.id,
  };
  bindWorld(world, r);
  for (const q of quests) questRewards(r, q);
  // Who each person talks with (news travels along these): everyone they have an opinion of, and everyone who has one of them.
  for (const n of npcs) {
    const linked = new Set([...n.opinions.map((o) => o.npcId), ...npcs.filter((m) => m.opinions.some((o) => o.npcId === n.id)).map((m) => m.id)]);
    linked.delete(n.id);
    n.relations = [...linked];
  }
  // Until painting places them, creatures and bosses stand on the open ground, so a world can be fought in too.
  for (const z of zones) if (z.kind !== 'town') populate(world, z, new Nav(openGround), rng.fork(`spawns:${z.id}`), OPEN.width * OPEN.height, []);
  return world;
}
