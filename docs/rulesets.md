# Generated rulesets

Every world has its own **ruleset**: pure data, written with the world, played by one deterministic engine. No code
is generated. The build's rules steps (`pipeline/steps/rules*.yaml`, docs/build-pipeline.md) choose what the world's
rules are made of and what they are called; the engine owns every number.

```
rules steps ── records ──► compiler (power budget) ──► Ruleset ──► balance loop (simulation) ──► final Ruleset
  systems, classes,          rules/worldRules.ts          numbers      rules/balance.ts            + report
  statuses, skills,                                                    tuned settings              + findings
  passives, gear, items
```

The steps write in the game's own terms: which optional systems the world has, its words for Health, money, and the
rest, its kinds of damage and the classes that deal them, the statuses its skills can put on a target, each class's
skills and passives tier by tier, its gear and its potions and materials. Every choice a step makes is from the game's
fixed lists (an effect, a stat, an area), so a record cannot ask for something the engine cannot play.

## Engine invariants (not data)

| Area | Invariant |
|---|---|
| Combat | Always turn-based. Turn model is engine code; the ruleset picks one and sets its parameters. Implemented: `ap` (action points). Planned: `rounds` (action + bonus + move). |
| Death | When every hero in a fight falls, they wake in the last town. What that costs is the owner's choice, each on or off (`death` in the ruleset): the pack (not equipment, not quest items) stays where they fell to be fetched, a quarter of the gold is lost, a quarter of the experience toward the next level is lost. |
| Downed | Allies are downed at 0 health and only die if the whole party falls. Revive mode: `heal` (any healing skill revives), `special` (only revive effects), `after_combat` (1 health after combat). A skill that revives exists only under `special`. Downed allies always get up at 1 health after a won fight. |
| Resolution | Random rolls: damage variance, crit chance, dodge chance (either can be 0 / disabled). No armor-as-health. |
| Recovery | Health always regenerates out of combat, and a won fight clears its statuses and cooldowns, so encounters are balanced individually. (After a defeat or a retreat cooldowns run down outside the fight.) |
| Statuses | "For N turns" means N of the bearer's own turns: a status counts down at the end of each of its bearer's turns, and one gained during a turn starts counting with the next (`wearStatuses` in `game/effects.ts`). Damage and healing over time come at the start of each of those turns, with regeneration and cooldowns (`startTurn`). So a one-turn root holds a foe for its next turn, a one-turn blessing covers an ally's next turn, and a stun for one turn loses one. |
| Order | Each fighter rolls 0 to 6 on its initiative when it joins: 10 for a hero, and for a creature 10 with its kind's own term (soldier +2, brute 0, swarm +3, stalker +5, guardian -2). Level gives no edge. |
| Decisions | Nothing forces a target (no taunt or charm). Control restricts options (`blockedBy` in `shared/ruleset/math.ts`): root stops moving and dashing; disarm stops the basic attack and the skills of the classes that deal the first kind of damage; silence stops every other skill (those of the magic classes, so only a world with magic has one); a stun loses the turn. Control is followed by immunity for two of the bearer's own turns, counted from the end of the last turn it held. |
| Party | One to six heroes in the game, each played by its player or the AI (docs/multiplayer.md). Packs are built for four and fitted to the heroes in their place; the balance loop fits that for each world. |
| Space | Line of sight for every ranged effect, a thrown consumable included; no attacks of opportunity, flanking, or cover (yet). |
| Inventory | Slot-limited (no weight); stacking materials and potions; purchasable inventory upgrades. One currency. |
| Out of scope | Durability, ammo, hunger/survival, factions/reputation, stealth (later), summons (later), respec. |

## What a ruleset contains

Health (always), action points, one or two kinds of damage (physical, and magic where the world has it) each with
its defense, statuses built from primitives (a stat raised or lowered, damage or healing over time, control, thorns,
life steal), equipment slots, item bases, affixes and rarities, potions, materials, optional crafting, upgrades and
enchanting (learned as crafts), fast travel, one to four races (each one gender, with its own look and names), classes as skill trees,
kinds of fighter for creatures, progression (the experience curve solved from the world's content), economy,
inventory, difficulty profiles, and the world's words.

There are no attributes and no resource pools: a skill costs action points and waits out a cooldown, and base stats
grow with level and gear.

### Classes are trees

A world has up to six classes, one for each kind the rules steps fill: physical damage up close and from a distance,
magic damage up close and from a distance (in a world with magic), a healer, and a buff and debuff class. Each class
is one tree of tiers; the number of tiers grows with the level cap (three to five, `classShape` in shared). A tier has
two skills (the last tier one) and three passives, and opens by the points spent in that class's tree.

A skill is one pick in its tree: its first point learns it and each further point is a rank (three ranks, two in the
deepest tier). A rank makes everything the skill does 15% stronger (`potency` in `shared/ruleset/math.ts`): its damage
and healing, the stat changes of the statuses it applies (a status carries the strength of the skill that put it on),
a revive, and life steal. The balance loop's correction on a skill works the same way. A class's first skill comes
free at rank 1 to its own heroes.

Every effect a skill can have grows with its rank, so every skill has ranks and every tier offers the same picks:
- **A control** (a stun, root, silence, or disarm) lands at its first rank with the chance its share of the skill's
  budget buys, at most 77% for a skill of three ranks (87% for two), and each rank closes an even part of the gap
  until the last makes it certain (`chanceAt`). The chance follows the rank alone, so neither a budget that bought a
  little less nor the balance loop's correction keeps the last rank from landing every time; only the world's
  immunity window after a control wears off does.
- **A cleanse** removes the worst harmful statuses first (what stops its target acting, then damage over time, then
  weakenings): one at rank 1, one more each rank, every one at the last (`cleanseCount`, `worstFirst`). A cleansing
  potion removes them all.

The compiler does not cover for a record the rules steps should not have written: a silence in a world without
magic, a skill that revives where the world's revive mode is not `special`, a status "on allies" in a skill that deals
damage or "on enemies" in one that heals. Each fails the compile with a sentence naming the skill or status
(`rules/worldRules.ts`); the rules steps do not offer them.

Nothing is added to a skill that its designer did not choose. (A cleanse that also healed was tried and dropped: a
world or a class without healing should not gain it.)

A tier's gate never asks for more points than the tiers before it offer, less a tier's passives (`classShape`): a
hero opening the next tier always has a choice of what to buy, even in the class whose first skill they have free.
Gates are 3 or 4 points apart in short worlds and at most 6 in long ones.

A hero has two points at the start and two more each level, and may spend them in any class's tree, so a hero who
heals and fights up close is a real build. The hero's own class is where they start: its first skill, its weapon, how
they are drawn, and the class's health and damage. A class's skills reach as the class does and deal its kind of
damage whatever weapon is in hand, so a skill learned from another tree works the same for anyone; the weapon gives
the basic attack.

### Creatures fight as classes

Creatures, bosses, and named foes have no skills of their own. Each is a **kind of fighter** and fights as one or more
of the world's classes. The kind of fighter is its body: a soldier is even, a brute heavy and slow, a swarm weak alone
and many, a stalker quick and fragile, a guardian tough and patient (`FIGHTER_KINDS` and `FIGHTER_LOOK` in shared).
The class gives its reach, its kind of damage, and its skills, those of the tiers open at its level. A boss fights as
the classes the story gave it. Nothing in a fight is designed for one creature alone, so every creature is priced
and balanced by the same rules as the heroes.

### Crafts: the utility tree

Crafting, brewing, upgrading, and enchanting are learned, each where the world has it: four crafts of four ranks,
named by the rules' items step in the world's own words (an office's enchanting is Configuration Drift). Craft
points belong to the player and are shared by all their heroes, so a party of six does not out-craft a player with
one hero; they come with the player's highest hero level, from one at the start to about three fifths of every rank
at the level cap, so a player chooses what they are good at. The engine sets what each rank does
(`shared/ruleset/crafting.ts`):

| Craft | Rank 1 | Each rank after |
|---|---|---|
| Crafting | makes gear at a workshop, of common quality, at the first level where the world has upgrading | a quality better (never the best) |
| Brewing (in every world with consumables, with gear crafting or without) | makes consumables, one at a time | one more at a time |
| Upgrading | raises an item's level by one, up to the player's own | one level more at once, for the cost of one improvement |
| Enchanting | rerolls an effect on gear | 15% cheaper; the top rank rolls twice and keeps the better |

### Gear

Gear is Diablo-style: a base (a weapon's damage, armor's defenses) and random bonuses, as many as its quality gives
(none on a common item, one more with each quality). Everything on an item follows the item's level: its damage and
defenses grow with the level curves and its bonuses grow with them, so one item reads the same whether it was found at
a level or improved to it. A few rules keep every piece worth wearing (`affixPool` and `affixCount` in
`shared/ruleset/stats.ts`):

- An accessory has no damage or defense of its own, so it rolls one bonus more than its quality gives: a common ring
  still does something, in a world with enchanting or without.
- A weapon's damage bonus is for its own kind of damage, so a staff never rolls a bonus to blows nor a sword one to
  spells. Bonuses to every kind (Power) and the rest stay open to weapons.
- A bonus never repeats a stat the base already gives.

Upgrading (improving, in the game) raises an item's level, so it becomes the item found at its new level. It goes up
to the player's own level, as often as they like but never past it, so improved gear is never stronger than gear found
at the player's level: it keeps a favorite piece in step. Crafting sets an item's quality and upgrading its level, so
where the world has upgrading, gear made at a workshop starts at the first level and is improved from there
(`craftedLevel`); a world without it makes gear at the player's level. The balance simulation's heroes wear gear of
their level, which is what improved gear is. Enchanting rerolls one bonus, or adds one while the item has fewer than
its quality's most plus one.

A weapon belongs to the class whose gear made it (`classId`), and its card names the class ("Fine Hunter rifle").
Classes are open to every hero, so weapons follow the trees: a hero wields their own class's weapons and those of any
class they have spent a point in (`wieldBlock`). In the pack, the shops, and at the workbench, a weapon the chosen hero
cannot wield is dimmed, and its card says what would let them.

### Gear bonuses

Every bonus is fight power, priced in one unit: a bonus on a common item at the first level is worth 5% of a hero's
power (as much as +5% Damage), and its amount is that worth over its stat's price (`statPrice` in
`rules/worldRules.ts`). An item's quality multiplies it (1 to 1.62), its roll by 0.8 to 1.2, and its level by up to
a quarter more at the world's last level, the same share in a world of five levels as in one of thirty. No bonus has a
cap of its own; the engine's caps on the totals stay (critical chance 60%, dodge 45%, life steal 25%, a defense 85%).
Passives and statuses are priced with the same prices.

A world rolls only bonuses its fights use: Healing only where heroes heal with skills (the owner's Healing skills
choice), regeneration, life steal, reflected damage, critical hits, and dodge only where the world has them. A
weapon's damage bonus is for its own kind of damage.

The prices were measured on 15 November 2026 with `combatlab/affixes.ts`: every hero's weapon was given one stat, as
much as its price said was worth 20% Damage, and 400 of the balance loop's ordinary fights were played with it, with
nothing, and with 20% Damage, on the same seeds, on three worlds at a middle level and the last. A stat priced right
saves the party as much Health as the Damage does. A second run, on the prices below, measured every stat at 20 to 25
on average over the six world-levels where 20 was intended (one reading's error is about 3 to 5); critical chance is
priced by arithmetic. Healing serves only the heroes who heal, so it is priced for them (about 11 in a party with a
healer two fights in three, at its earlier price of 0.3). A defense follows how much of the creatures' damage is of
its kind, which differs by world: a physical defense measured 11 in one world and 38 in another, 23 on average.

| Bonus | Price (power % a unit) | Common, first level | Before |
|---|---|---|---|
| Health | 1 | +5% | +8.3% |
| Damage | 1 | +5% | +5% |
| Damage of a kind | 1 | +5% | +7.1% |
| Healing (with healing skills only) | 0.2 | +25% | +10% in every world |
| Movement | 12 | +0.42 m a step | +0.33 m |
| A defense | 85 × its kind's share of creature damage | 0.06 of the level's scale in a world of one kind | 0.08 |
| Health each turn (regeneration) | 800 | 0.6% of a hero's Health | 2.1% |
| Reflected damage | 20 | 0.25 of the level's damage | 0.13 |
| Life steal | 3.5 | 1.4% | 8.3%, at most 8% on one item |
| Critical chance | a crit's extra damage (0.5) | +10% | +10%, at most 15% on one item |
| Critical damage | 0.2 | +25% | +50% |
| Dodge | 2 | +2.5% | +7.1%, at most 12% on one item |

Removed: **Better prices** and **Loot find** acted outside fights, so no fight price could weigh them; prices come from
how a party deals with the world's people, and Loot find added gold the economy (solved from what the world pays) never
counted, and found 70% or more on good items. **Initiative** measured at nothing: going first in a fight's order changes
nothing that matters.

Two rules of the fight changed with them. A dodge avoids any blow, a skill's as much as an attack's, with what the blow
would put on its target; it used to avoid only basic attacks, which made it worth a third of its price. Damage over time
and healing over time are dealt with the bonuses the hero's own blows and heals have (`statusPower`), so +Damage
strengthens a poison and +Healing a mending.

### Consumables

A world has at most one consumable of each kind it uses: one healing, one cleansing, a few buffs, and debuffs (one for
each helpful or harmful status it has) and up to two bombs. A potion is used on the one who drinks it; a bomb or a
thrown debuff reaches 8 m, needs a line of sight, and catches everyone of the side it is for within 1.6 m of where it
lands, as its card says. Consumables have no level and no quality, so every one of
a kind is alike and shares a stack. A healing potion mends 15% of its drinker's most Health, less than a healer's heal
at any level; the others' strength follows the level of the hero who uses it and nothing else of theirs
(`consumableStats`: no bonuses to damage or healing, no critical hits, no life steal), so a consumable is the same for
everyone and a bomb deals about a quarter of a hero's Health at every level. Its
price follows the level of the player buying or selling it, growing as the gold a kill pays does (`fightGold`), so
one costs about the same number of fights all game; materials, valuables, and a gear recipe's gold grow the same way.
Gold per level is not the measure, since the time a player spends at a level follows how much content the world puts
there. Brewing makes more of them, never better ones, and merchants pay a quarter of the usual share for consumables,
so a brewer's batch does not sell for more than its materials cost.

### The economy

Prices and costs are solved from what the world pays, as the experience curve is solved from what it holds
(`solveEconomy` in `rules/bind.ts`): the gold a player gathers clearing the world (every creature placed, as loot
pays it, every chest, and every quest), spread over its levels. At the middle level a common weapon costs about two
fifths of a level's gold, an upgrade or an enchantment about an eighth, and the first bag upgrade most of a level's
gold; costs grow with item level. Only fights are simulated; the economy follows from the content.

## Numbers: the power budget

Everything is priced in one unit: a fraction of a reference character's combat power at its level.

* Reference curves per level: health `H(L)`, damage per AP `D(L)`, mitigation rating scale `K(L)`.
* Mitigation % = rating / (rating + K(L)) — gear rated for a lower level gets worse as you out-level it.
* A skill's power comes from its cost, priced per AP against the basic attack (100% weapon damage for 2 AP). A class's
  first skill is its everyday move: 2 AP and no cooldown, so it is no better than attacking. Later skills wait two
  or four turns and hit harder for it; a large area or a deep tier costs 3 AP. Area damage is shared among the
  targets it is likely to catch, and a status or control rider takes its price out of the damage.
* Reach follows movement (2 m an AP): a skill from a distance reaches 6 m and a bow 7, so a melee fighter closes on
  an archer in a turn. A melee skill may dash: it rushes up to 5.5 m to its enemy and strikes, always on a cooldown,
  and the walk it saves is taken out of its damage.
* Healing is priced as damage of the same size (`HEAL_PER_DAMAGE`), and a skill that heals always waits a turn or
  more. At a third of that price a healer gave back 2 to 11% of the Health its party lost, and a potion out-healed its
  heal six to one; at this price, after the balance loop has evened the classes out, it gives back 14 to 25% in
  ordinary fights, one heal mends a tenth to a fifth of its target, and potions give back less than the healer in
  boss fights; both worlds tried kept 25 or more of 26 scenarios on target (`combatlab healing`, 15 November 2026).
* Each passive, affix, status, and potion is worth a fixed budget, split over its effects.
* Creatures use the same curves, times their kind of fighter's weights, times tuned per-level multipliers.

## Balance loop

Headless combat (the same code the game runs) on small arenas, in `rules/balance.ts`. A party of four with
level-typical gear and builds meets generated packs, starting as a fight in the game starts: the pack standing as the
build places packs, its nearest member just inside the distance at which creatures notice a party, and the party in
its fighting positions (`fightPositions` in `game/space.ts`), and the loop fits a few settings toward targets for each kind of
fight and difficulty (win rate, Health lost, rounds). Both sides are played by the game's combat AI
(`docs/combat.md`), which plays about as well as an attentive player, so the targets describe a competent player's
fights. It works in the order the settings depend on each other:

1. **Classes.** Each class's strength is measured in parties where it is half the heroes: the factor on creatures'
   Health and damage at which ordinary fights cost the party the middle of the target. Classes are corrected toward
   the average in two passes, the second learning from the first how strongly a correction tells.
2. **Skills.** A skill that takes most of a class's turns is toned down and one the AI almost never picks gets
   stronger (bounded). Random builds at the highest level are compared with typical ones (four heroes of the class in
   ordinary fights); the passive or skill that carries a far better build is weakened.
3. **Creatures** at the tuned levels: Health against the rounds a fight lasts, damage against the Health lost per
   round. Fitted that way the two settings barely disturb each other. The tuned levels are the first, about a third and
   two thirds of the way, the last, and, since heroes grow by steps where a deeper tier's first skill can be taken
   (and creatures learn a tier's skills at that same level), each such level and the one before it. Between tuned
   levels the settings are interpolated, which is only right where heroes grow smoothly; without the steps, a
   tiny world's level-3 bosses were fitted halfway to level 4's, against heroes who did not yet have level 4's skills.
4. **Bosses** at each tuned level (multipliers on the creatures' curve). There are no elites: packs are ordinary
   creatures of their kinds, and a named foe is one of its kind leading a pack of them.
5. **Difficulties** (Story, Easy, Hard, Brutal) at the middle and highest level.
6. **Party sizes**: the four powers by which a pack follows the number of heroes (see "Party size" below).

How a fit works:
- **The same fights every step.** Every step of a fit replays the same fights (the same seeds), so two settings are
  compared on equal terms rather than on luck.
- **Solved, not nudged.** Each step moves a setting by the gap, in log terms, over how strongly the setting answered
  the last step (a secant estimate). It moves at most a doubling or a halving at once, and keeps the best step.
- **Aimed at the middle.** A fit aims at the middle half of the Health and rounds bands, so other fights still land
  inside them. Boss and Brutal fights swing more from fight to fight, so they are fitted and reported on more fights
  (three times as many for a boss, twice for Brutal).
- **Counted in fights, never minutes.** A fixed number of fights bounds the work, so a world balances the same on any
  machine. A full balance plays about 4,000 to 5,000 fights. Nearly all of the time is the combat AI choosing moves.
  A small world's balance took about seven minutes on one thread of a fast desktop.
- **Played on worker threads.** The fights run off the main thread, so the server keeps serving the game
  (`rules/simPool.ts`). The fits, measures, and evaluations run on the loop's own thread and hand their fights to one
  queue, so a stage's fits run side by side and every thread stays busy until the stage's last fight. The default is
  half the machine's threads: two on the four-thread server, where the worker runs at a lower priority than the game.
  `DAYDREAM_BALANCE_THREADS` asks for another number. Each fight is a pure function of the ruleset, the settings it
  tries, and its seed, so the answers are the same on any number of threads. Measured on 15 November 2026, the same
  world was tuned bit for bit the same on 1, 2, 3, and 10 threads, in 383, 210, 143, and 76 seconds.

The report plays other fights than those fitted and is stored with the ruleset, shown on the world page. A scenario
that misses with a setting at its limit is marked: there the rules, not the fitting, are at fault.

### What numbers cannot fix

The report's findings are what the loop cannot fix with numbers. The world's page shows them to its owner, who can
write the rules anew.

| Finding | What it means |
|---|---|
| A skill the AI rarely uses | Its effects do not matter in a fight, or it costs too much for what it does. |
| A skill that takes most of a class's turns | The class plays as one button. |
| A class that mostly uses the basic attack | Its skills do too little for their cost. |
| A class far weaker or stronger than the others | Its correction cannot even it out, or only at a limit. |
| A build that carried an outlier | The passive or skill that carried it, after the loop weakened it. |
| A target out of reach | A setting at its limit could not reach it, for example bosses' damage at its lowest and heroes still losing. The classes lack something: healings, area damage. |
| A passive that cannot help its class | Healing on a class with no healing skill. |

## Party size

Packs are built for four heroes (`DESIGN_PARTY`) and fitted at play time to the heroes in their place, when it goes live or another party arrives, while the pack has never fought (`fitPack`):
fewer members and weaker ones for fewer heroes, more of the pack's kind (up to eight creatures) and then stronger ones
for more. A side's strength grows faster than its numbers, so a pack's strength follows the heroes' ratio to four to
a power: one for fewer heroes and one for more, for packs and for bosses (the ruleset's `party`). How much faster
strength grows depends on the world's classes, so the balance loop fits the four powers for each world: parties of
one and two, and of six, should lose the Health four do. The report shows ordinary and boss fights for one hero and
for six.

Why per world and per side: on 1 November 2026 a single power of 1.6 for every world (measured once on two default
rulesets) left a lone hero losing 15–28% of their Health in ordinary fights and six heroes 43–56%, where four lost about
30%. One fitted power per world evened most worlds out, but not all: in one world, the power that suited six heroes
made a lone hero lose half their Health. Fewer heroes and more need their own power.

Experience follows the same rule: a fight's experience is split among the heroes in it, and the experience curve
counts a hero's share of the world's content (`solveProgression`), so heroes level at the same pace in a party of any
size.

## Words

Players must understand every rule word at first sight. Rules use plain, familiar game words (Health, Experience,
Gold, Fire, Poison, Strength...) and rename one only when the theme truly calls for it, to a word anyone recognizes
(Credits on a space station, Hull for a ship). The theme shows in skills, items, classes, and descriptions. The
points heroes spend in the classes' trees are named with the world too (`talent_point` and `talent_points` in the
core step's words): most worlds keep Skill Points, a woodland's are Skill Seeds. Action points stay AP everywhere.

## Regenerating

There are no migrations: a world made under other rules can **write its rules anew** (its rules steps run again in
the world's own pipeline store, then compile and balance; lore and art stay, and its heroes are painted again for the
new classes and races) or **rebalance** (its rules records compiled by the current engine and balanced again;
nothing anyone sees changes and no art is painted). Adventures begun under rules written anew cannot be continued.
