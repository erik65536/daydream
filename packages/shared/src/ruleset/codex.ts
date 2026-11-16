/** Player-facing rule documentation, generated entirely from a ruleset. */
import { CRAFT_RANKS, craftRankLine } from './crafting.ts';
import { DIFFICULTY_TEXT, type DifficultyId, type Ruleset } from './types.ts';
import { MAX_HEROES } from '../rules/progression.ts';
import { rx } from './stats.ts';
import { statusLines, talentPoints } from './describe.ts';
import { listing } from '../util/words.ts';

interface CodexEntry {
  title: string;
  color?: string;
  /** Short flavor or explanation. */
  text?: string;
  /** Mechanical facts. */
  lines: string[];
}

interface CodexSection {
  id: string;
  title: string;
  intro?: string;
  entries: CodexEntry[];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** A rule word in the plural ("Class" → "Classes", "Calling" → "Callings"). */
const plural = (w: string) => (/(s|x|ch|sh)$/i.test(w) ? `${w}es` : `${w}s`);

export function codexSections(r: Ruleset): CodexSection[] {
  const ix = rx(r);
  const t = r.terminology;
  const out: CodexSection[] = [];

  // ---------------------------------------------------------------- basics
  const basics: CodexEntry[] = [];
  basics.push({
    title: 'Turns',
    text: `Combat is turn-based. Everyone acts in order of initiative; on your turn you spend ${t.actionPoints} to move, attack, and use skills, in any order. Alone, thinking is free: nothing happens until you act.`,
    lines: [
      `You start a fight with ${r.turn.apStart} ${t.actionPoints} and gain ${r.turn.apPerTurn} each turn (up to ${r.turn.apMax}). Unspent points carry over.`,
      `Moving costs 1 ${t.actionPoints} per ${r.turn.tilesPerAp} tiles, plus extra for difficult ground.`,
      'Skills cost action points, and the strongest wait a few turns before they can be used again.',
      'Ranged attacks and skills, and anything thrown, need a clear line of sight.',
      'Heroes whose turns come one after another act together, each player with their own. With friends in the fight a shared turn has a time limit; after it, the heroes still to act fight on their own.',
      'Out of combat, time flows normally and skills that work outside combat can be used freely.',
    ],
  });
  const res: string[] = [`Damage varies by ±${pct(r.resolution.variance)} each hit.`];
  if (r.resolution.crit) res.push(`Critical hits (base ${pct(r.resolution.baseCrit / 100)}, at most ${pct(r.resolution.critCap)}) deal ${pct(r.resolution.critMult)} damage.`);
  else res.push('There are no critical hits in this world.');
  if (r.resolution.dodge) res.push(`Any blow can be dodged, with what it would put on its target (base ${pct(r.resolution.baseDodge / 100)}, at most ${pct(r.resolution.dodgeCap)}).`);
  else res.push('Attacks never miss.');
  basics.push({ title: 'Hits', lines: res });
  basics.push({
    title: 'Falling in battle',
    lines: [
      `A character reduced to 0 ${r.health.name} is downed, not dead.`,
      r.revive === 'heal' ? 'A healing skill brings a downed ally back up.' : r.revive === 'special' ? 'Only reviving skills and items can bring a downed ally back during a fight.' : 'Downed allies get back up when the fight ends.',
      'Downed allies always recover after a won fight.',
      `If every hero in a fight falls, they wake in the last ${t.town.toLowerCase()} they visited, and friends elsewhere carry on.`,
      ...(r.death.recover ? [`Equipment stays with them, but each player's pack lies where they fell: go back and recover it.`] : []),
      ...(r.death.goldLoss ? [`Each player loses ${Math.round(r.death.goldLoss * 100)}% of their ${t.currency}.`] : []),
      ...(r.death.xpLoss ? [`Each hero loses ${Math.round(r.death.xpLoss * 100)}% of the ${t.xp.toLowerCase()} earned toward its next ${t.level.toLowerCase()}.`] : []),
    ],
  });
  basics.push({
    title: 'Recovery',
    lines: [
      `Out of combat, ${r.health.name} refills completely in about ${Math.round(r.recovery.secondsToFull)} seconds.`,
    ],
  });
  out.push({ id: 'basics', title: 'How it works', entries: basics });

  // ---------------------------------------------------------------- damage
  const dmg: CodexEntry[] = r.damageTypes.map((d) => ({
    title: d.name,
    color: d.color,
    lines: [`Reduced by ${d.mitigationName}. Higher ${d.mitigationName} gives diminishing returns, up to 85% reduction.`],
  }));
  out.push({ id: 'damage', title: 'Damage', intro: r.damageTypes.length > 1 ? 'Every hit has a kind of damage, and each kind has its own defense.' : 'Every hit is reduced by the defense against it.', entries: dmg });

  // ---------------------------------------------------------------- statuses
  if (r.systems.statuses && r.statuses.length) {
    out.push({
      id: 'statuses',
      title: 'Conditions',
      intro: `A condition for a number of turns lasts through that many of its bearer's own turns, and one gained during a turn starts counting with the next. Damage and healing over time come as each of those turns begins.${r.control.enabled ? ` After a condition that stops someone acting wears off, none can be put on them again for ${r.control.immunityTurns} of their turns.` : ''}`,
      entries: r.statuses.map((s) => {
        const lines = statusLines(r, s);
        return { title: s.name, color: s.color, text: s.description, lines: lines.length ? lines : [s.harmful ? 'Harmful.' : 'Beneficial.'] };
      }),
    });
  }

  // ---------------------------------------------------------------- characters
  out.push({
    id: 'classes',
    title: plural(t.calling),
    intro: `Each ${t.calling.toLowerCase()} is a tree of skills and passives. Anyone can put points into any ${t.calling.toLowerCase()}: your own is only where you start, and mixing them makes a hybrid. A ${t.kin.toLowerCase()} is who you are and how you look; it gives no bonuses.`,
    entries: [
      ...r.classes.map((c) => ({
        title: c.name,
        text: c.description,
        lines: [
          `${c.reach === 'melee' ? 'Fights up close' : 'Fights from a distance'} with ${ix.type.get(c.damageTypeId)?.name ?? ''} damage.`,
          `Starts with ${listing(c.startingSkills.map((s) => ix.skill.get(s)?.name ?? s))}.`,
        ],
      })),
      ...r.kins.map((k) => ({ title: k.name, text: k.description, lines: [] })),
    ],
  });

  const pr = r.progression;
  out.push({
    id: 'progression',
    title: 'Growing stronger',
    entries: [
      {
        title: `${t.level}s`,
        lines: [
          `${t.xp} comes from defeating foes and, above all, finishing ${t.quest.toLowerCase()}s. The highest ${t.level.toLowerCase()} is ${pr.maxLevel}.`,
          `A fight's ${t.xp.toLowerCase()} is shared among the heroes in it, those downed too, so a hero levels at the same pace in a party of any size. ${t.quest}s give their ${t.xp.toLowerCase()} to every hero in full.`,
          `A hero below the highest ${t.level.toLowerCase()} in the game earns extra ${t.xp.toLowerCase()} until they catch up.`,
          `You start with ${talentPoints(r, pr.treePointsStart)} and gain ${pr.treePointsPerLevel} each ${t.level.toLowerCase()}.`,
        ],
      },
      {
        title: 'Talents',
        lines: [
          `Spend ${t.talentPoints} to learn skills, to raise the rank of skills you know, or to take passive bonuses.`,
          'Each rank of a skill makes everything it does stronger: its damage and healing, the effects of the conditions it causes, and the chance of one that stops a foe. A skill that removes harmful effects removes one more each rank, and all of them at its last.',
          `Deeper tiers of a ${t.calling.toLowerCase()} open after spending ${listing(pr.tierRequirements.slice(1).map(String))} ${t.talentPoints} in it.`,
          'Choices are permanent, so plan your build.',
        ],
      },
    ],
  });

  // ---------------------------------------------------------------- items
  const items: CodexEntry[] = [
    { title: 'Equipment', lines: [`Slots: ${r.slots.map((s) => s.name).join(', ')}.`, 'Better items appear deeper in the world, and from tougher foes.'] },
    {
      title: 'Rarity',
      lines: [
        ...r.rarities.map((x) => `${x.name}: ${!x.affixes[1] ? 'no bonuses' : `${x.affixes[0] === x.affixes[1] ? x.affixes[0] : `${x.affixes[0]}–${x.affixes[1]}`} bonus${x.affixes[1] === 1 ? '' : 'es'}`}`),
        ...(r.slots.some((s) => s.kind === 'accessory') ? ['Accessories carry one bonus more, since they have no damage or defense of their own.'] : []),
        "An item's level makes everything on it stronger.",
      ],
    },
    {
      title: 'Your pack',
      lines: [
        `Each player has one pack for all their heroes. It holds ${r.inventory.slots} stacks${r.inventory.upgrades ? `; merchants can enlarge it ${r.inventory.upgrades} times (+${r.inventory.slotsPerUpgrade} each)` : ''}.`,
        `${t.quest} items and keys go in a pouch everyone shares, so a ${t.quest.toLowerCase()} never waits on whoever carries them. They are under Story in your inventory.`,
        'To give something to another player, stand near them and choose it in your pack.',
        `Merchants buy at about ${pct(r.economy.sellRatio)} of the price, and consumables for a quarter of that.`,
        ...(r.inventory.storage === 'none' ? [] : [`Each ${t.town.toLowerCase()} has storage for what you want to keep but not carry: ${r.inventory.storageSlots} stacks, ${r.inventory.storage === 'shared' ? `the same store in every ${t.town.toLowerCase()}` : `each ${t.town.toLowerCase()} holding only what was left there`}. It stays safe when you fall.`]),
      ],
    },
  ];
  const craft: string[] = [];
  if (r.recipes.length) craft.push(`${r.recipes.length} recipes turn materials into useful things.`);
  if (r.crafting.upgrades.enabled) craft.push(`Improving an item raises its level, up to your own level: it becomes as strong as if it had been found at its new level.${r.crafting.enabled ? ' Gear made at a workshop starts at the first level, ready to be improved.' : ''}`);
  if (r.crafting.enchanting.enabled) craft.push('Enchanting replaces one bonus on an item with a new random one.');
  for (const c of r.crafts) craft.push(`${c.name}: ${c.description} Learned with craft points, which come with levels and are shared by all your heroes (${CRAFT_RANKS} ranks: ${Array.from({ length: CRAFT_RANKS }, (_, i) => craftRankLine(r, c.id, i + 1).toLowerCase()).join('; ')}).`);
  if (craft.length) items.push({ title: 'Crafting', lines: craft });
  out.push({ id: 'items', title: 'Gear', entries: items });

  // ---------------------------------------------------------------- playing together
  out.push({
    id: 'together',
    title: 'Playing together',
    intro: `Friends play one adventure and live one story. Up to ${MAX_HEROES} heroes are in the game at once.`,
    entries: [
      { title: 'Fights', lines: ['Every fight is made for the heroes in it: fewer heroes meet fewer and weaker foes, more heroes meet more of them (up to about eight) and then stronger ones. Bosses grow and shrink on their own.', 'Heroes close by join a fight; those further away can walk over.'] },
      { title: 'Rewards', lines: ['Each foe’s loot goes to one player in the fight, in turn, weighted by how many of their heroes fought. Every player opens a chest for themselves.', `${t.quest} rewards go to every player in the game when it is finished.`] },
      { title: 'Your heroes in a fight', lines: ['You command each of your heroes in fights, or let any of them fight on their own: the blade-and-star mark on their portrait, or the choice in their window. Let them all, and they fight for you.', 'Out of fights your party follows your lead either way.'] },
      { title: 'Coming and going', lines: ['A player who drops out keeps their heroes in the game for a minute: they fight on their own and walk after a friend nearby. Back in time, nothing has changed. Leaving on purpose takes them out at once.', 'To trail a friend yourself, follow them from the list of friends.'] },
    ],
  });

  // ---------------------------------------------------------------- difficulty
  // (How hard foes hit and how much they can take is fitted to each difficulty's feel by simulation, so it is told by
  // the feel rather than as multipliers that trade one against the other.)
  out.push({
    id: 'difficulty',
    title: 'Difficulty',
    intro: 'Each adventure has its own difficulty, which the player who began it can change at any time. It changes your foes, not you.',
    entries: (Object.keys(r.difficulty) as DifficultyId[]).map((id) => {
      const d = r.difficulty[id];
      return {
        title: d.name,
        text: DIFFICULTY_TEXT[id],
        lines: [
          ...(d.extraEnemyChance ? [`${pct(d.extraEnemyChance)} chance of an extra foe in each group.`] : []),
          ...(d.lootMult !== 1 ? [`${pct(d.lootMult - 1)} more loot.`] : []),
        ],
      };
    }),
  });
  return out;
}
