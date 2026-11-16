# Combat: the AI and how fights look

A fight is turn-based: each round every fighter acts in turn, spending its action points (AP) on moving, skills
and potions. No action spans more than one turn, and creatures do not announce what they will do. This document
covers who decides what the creatures, the AI-played heroes, and the balance simulation's parties do
(`packages/server/src/game/ai.ts`, `tactics.ts`), how well it plays and how that was measured
(`packages/server/src/cli/combatlab/`), what it means for balancing, and how fights are drawn and read
(the build's `fightLooks` step, `packages/client/src/render/fx.ts`, the camera in `render/view.ts`, effects shown
as they land in `render/fxshow.ts`, and the turn order in `ui/hud.tsx`).

## The AI

### One rule: an action is worth what it changes about how the fight ends

`tactics.ts` turns the fight into a *board* seen from the deciding fighter's side. For every fighter, the board
holds its Health, how much damage a round it deals to each foe (its best repeatable
damage per AP times its AP a round, plus what its cooldown skills add on average), how much it heals, where it
stands, how far it reaches in a round, and when its next turn comes. `project` plays the rest of the fight out in
continuous time:

- A fighter's damage a round counts a skill on a cooldown for as many uses as fit in what is left of the fight: when
  it is next ready (now, or once the cooldown running out), then every cooldown + 1 turns. How long the fight has
  left comes from a first projection.
- Every fighter attacks the foe it gains most from killing first. It weighs the foe's damage against the time the
  kill takes, walking included (Smith's rule: threat × rate ÷ (Health + rate × walk time)). So fighters focus fire
  on dangerous, fragile foes and don't wander off to reach a far one.
- A ranged fighter needs a line of sight; a melee fighter must first walk up to its target.
- Healers heal whoever is under the most fire.
- Statuses (slows, roots, damage over time, buffs, and weakenings) change the rates for as long as they last: through
  as many of their bearer's own turns as they are for (docs/rulesets.md, "Statuses"). They are measured through the
  real stat rules, so a status counts for exactly what it does in this world. A stunned fighter does nothing for the
  turns it loses and fights on from the one after; a rooted one cannot walk until its root's last turn is over.

A board's value is the share of Health its side keeps at the end minus the share the foes keep. Every possible
action is applied to a copy of the board (`applyUse`, `applyHeal`, `applyMove`), and its worth is the change in that
value. Focus fire, kill order, avoiding overkill, the timing of heals and buffs, and keeping a healer alive all
follow from this one rule; none of them is a special case. AP saved for later counts as more damage during the
fighter's next turn, so ending a turn early is a real choice and not a free one.

### The search

`weigh` lists the steps a fighter could take now:

- every skill against every target in reach from where it stands;
- moves to a few useful spots: the nearest spot in range of each foe, the closest approach to one out of reach,
  the best spot for each area skill, the safest spot to strike each foe from, and the safest spot of all. A
  creature's kind of fighter is its habit here: brutes and swarms never give ground, and a guardian holds its ground
  unless badly hurt (under 35% of its Health);
- a potion;
- ending the turn.

A short beam search (two steps deep, the best three kept) scores each first step by the best sequence that starts
with it. Each step is judged by the projection, less 0.06 of a fight's Health share for every round a fighter, on
either side, spends walking to a foe instead of striking (`WALK_COST`). After every step the fighter looks again, so
a dodge, a crit, or a kill changes the rest of its turn.

### Walking costs something

Stepping back is often the best play. It pulls a creature onto a sturdier ally, and it makes a crowd of melee foes
spend their turn closing in again, which costs them more than the step cost the one who took it. Judged by the
ending alone, it was taken for the smallest gain, and fights became chases. Rules about when a fighter could step
back (not two rounds running, only when badly hurt or with a melee foe on it) held that back case by case. The cost on
walking replaces them: stepping back is weighed like any other step, and is taken when it is worth more than the
walking it makes, the fighter's own and that of the foes who follow. A cost on the fight's length was tried first. It
shortened fights but did not stop kiting, since a creature that walks instead of hitting does not make the fight
longer. Having the projection choose targets again every round (in it a fighter keeps its target until someone
falls) made no measurable difference and was left out.

Measured with `bench` (three worlds, 16 fights per scenario) against the step-back rules, with cooldowns counted as
above:

- Fights are as long or shorter (normal fights 2.8 to 5.3 rounds, bosses 7.1 to 9.2), with as many wins or more
  (Bellward's boss fights 69% to 94%).
- Heroes step back less in most scenarios: in normal and elite fights 2 to 25 of their moves above half their Health
  against 10 to 22, and they walk away without striking in 0 to 11 turns of about 200 to 300. Bramblewood's boss
  fights fell from 87 to 60 such moves. Bellward's boss fights are the exception (43 against 41).
- Creatures step back in 6 to 23% of their moves, as before.
- Regret (oracle, 144 decisions): 2.6% for heroes and 2.7% for creatures, against 3.4% and 2.4%.

Two guards keep fights from stalling. If two rounds pass in which no one loses Health, the projection assumes the
foes hold their ground, so the side that has to close the distance does. The simulation also stops a fight after 40
rounds.

### Readable imperfection

On gentler difficulties creatures play below their best in the way of their kind (`habit`): brutes and swarms go for
whoever is nearest, stalkers for the most wounded, guardians for whoever is closest to their own, and a soldier has no
habit of its own; whatever its kind, a creature of a ranged class fights from where it stands, and one of a healer
class helps its own. The habit's weight is 0.3 of a fight's Health
share on Story, 0.18 on Easy, 0.08 on Normal, 0.03 on Hard and none on Brutal. It is added to each step's value, so a
creature follows its habit only when that costs little. A player can learn what a kind of creature does, and Brutal
plays it straight. Heroes played by the AI have no habit.

## How well it plays

The lab tools are console tools that need no models:

- `bench.ts` plays the balance loop's kind of fights (levels 3 and 8; normal and boss fights; the same parties,
  packs and dice whichever AI plays them) and compares wins, Health lost, rounds, and cost, and how the fighters
  move: the share of moves away from the nearest foe (and how many of them above half Health), turns spent walking
  away without striking, and step-backs two rounds running.
- `trace.ts` logs every step of one fight; with `WEIGH=1` it also prints each step's options and their values, and
  with `BOARD=1` the projection.
- `oracle.ts` measures regret with the real engine. At sampled moments it replays a fight up to a fighter's decision,
  tries every step worth considering there (the AI's top seven and three it ranks low), and plays each one out many
  times with fresh dice, using the same dice for every step so they are compared fairly. The steps are ranked on one
  set of playouts; the best one and the AI's own choice are then measured again on another set, so luck cannot
  flatter the best. Regret is how much more of its side's Health share the best step keeps. This is a measurement
  only: the game never plays out fights to decide.
- `balancelab.ts` runs the balance loop on built worlds' rules without model calls.
- `areas.ts` measures what damaging skills do in those fights: how many fighters an area catches against the 1.7 (small)
  and 2.4 (large) it is priced for, the share of the struck side's Health an area use and a single-target use take, the
  share of its own Health a struck fighter loses, the worst single action, and how often one downs two or more.
- `healing.ts` measures what healing does: the share of the Health a party with one healer loses that the healer
  gives back, and that potions give back, what one heal mends of its target, and how the fights end; it can scale
  healing and rebalance first, to try a price before building with it (docs/rulesets.md has its numbers).

Elites were removed on 15 November 2026: the measurements in this document that mention elite fights (here, under
"Walking costs something" above, and in the tables below) are from before, as is the kind of fighter they name.

Measured on the five development worlds (16 fights per scenario, Normal difficulty), against the AI before this one:

- **Heroes played by the new AI** lose 10 to 35% of their Health in fights the old AI's heroes lost 26 to 83% in,
  against the same creatures, winning nearly every one.
- **Creatures played by the new AI** are much deadlier: the old AI's heroes win only 13 to 44% of boss fights against
  them.
- **Cost.** A simulated fight costs 56 to 176 ms instead of 52 to 112 ms (one thread), within the twice-as-long
  budget.
- **Regret** (oracle, 120 sampled decisions, 12 playouts per step): the new AI's steps give up 4.1% of a fight's
  Health share on average for heroes and 4.3% for creatures, against 4.6% and 4.5% for the old AI. A single step
  matters less than whole fights show, because the next steps can make up for it. Most of the remaining regret comes
  from attacking where stepping elsewhere first would have kept more Health. For creatures, part of it is the
  deliberate Normal-difficulty habit. A single decision's measured regret is noisy (about ±10 points in boss fights
  with 12 playouts), so the per-decision figures are a guide, not a target to tune each case against.

## What it means for balancing

The balance loop (`docs/rulesets.md`) plays every fight with this AI on both sides, so the creatures' strength in the
simulation is their strength in the game. The heroes in the simulation now play about as well as an attentive player:
they focus fire, protect their healer, and use their skills for what they are worth. The targets therefore describe a
competent player's fights, and a newcomer does somewhat worse; Story and Easy are the difficulties for them. The skill
usage the loop reports (a skill nobody picks, a class that only uses its basic attack) now says what the skills are
worth, not what a weak AI happened to like.

### Balancing with this AI, measured

`balancelab.ts` ran the full balance loop on two development worlds' rules (Thimblebrook and Kestrel Belt), twice
each with different dice, and compared it with the balance they had from the old AI. "On target" counts the
report's 24 scenarios whose win rate, Health lost, and rounds fall inside their bands.

| | Old AI | New AI, as before | New AI, boss and elite fitted on more fights |
|---|---|---|---|
| Thimblebrook, on target | 22 of 24 | 19 and 14 of 24 | 20 and 20 of 24 |
| Kestrel Belt, on target | 23 of 24 | 21 and 21 of 24 | 23 and 24 of 24 |
| Fights in a balance | 2,700 to 3,000 | 3,400 to 3,900 | 4,500 to 5,000 |
| Time on one thread | 300 to 330 s | 270 to 320 s | 515 to 606 s (two worlds at once) |

What changed and why:

- **Creatures got stronger relative to their settings, so the loop turned them down.** Creatures played by the new
  AI focus fire and finish off the wounded, so bosses' Health multipliers fell from 6 to 8 to about 3 to 6, while the
  heroes, also playing better, let ordinary creatures keep or gain damage. The loop absorbed this on its own; no
  target had to change.
- **Boss and elite fights were the weak spot.** A boss fight is decided by a few blows. With the new AI on both sides,
  sixteen to twenty-four fights were too few to fit or report one: the fitted boss settings followed the dice of the
  fitted seeds (a level-1 boss ran 12 rounds with one seed), and the report missed on another set of dice. Boss fights
  are now fitted and reported on three times as many fights, elite and Brutal fights on twice as many
  (`swing` in `rules/balance.ts`). That recovered most of the misses at about 1.4 to 1.8 times the old time (the
  runs above shared the machine, which inflates their times), inside the budget of twice the old time.
- **What still misses.** Thimblebrook's level-1 elites (65 to 71% wins against a target of at least 75%) and its
  level-8 Hard and Brutal fights on one seed. These sit at the edges of their bands rather than far outside them.
  The ordinary creatures' settings differ by 10 to 25% between seeds while both land on target: Health lost
  answers weakly to them inside the band, so the fit has a range of good answers, not one.
- **Stability.** Rerunning a balance with other dice now changes the outcome of a few scenarios at the edges of their
  bands, not the character of a world. More fights would narrow it further at a proportional cost; the loop has no
  cheaper lever left that we found.

Rebalancing a built world with this AI is the world page's Rebalance (simulation only, no model calls). The
development worlds in the main checkout were not rebalanced here; their stored balance is still the old AI's.

### Area attacks, measured (14 November 2026)

Players found creatures' area attacks brutal at low levels: one blow could catch the whole party. `areas.ts` on The
Unfinished Garden (a tiny world, levels 1 to 5, 24 fights a scenario) found three causes, none of them in the area
rules or the range check:

- **Where fights began.** The party walks in a tight formation (followers 1.2 m behind the leader, half a meter to
  each side), and a fight began with it standing so: a small area (1.6 m) around the middle hero caught all four.
  The simulation started heroes in a looser column farther from the pack, so it saw fewer heroes caught than the
  game did, and the balance loop priced creatures against that. Now, in the game and the simulation alike, the party
  steps into fighting positions as a fight begins: a wedge behind the leader, two meters between neighbors
  (`fightPositions` in `game/space.ts`). A small area then catches one hero and a large one up to three, as they are
  priced.
- **Creatures learned deep tiers a level early.** A tier opens once its points are spent in a class, and a skill in it
  costs a point more, so a hero all-in on a class takes its first deep-tier skill the level after the tier opens. A
  creature knew the tier's skills at the level it opened: at level 3 every creature had the large areas and dashes no
  hero could have yet. Creatures now follow the hero's rule (`fighterSkills`).
- **Level 3 was never fitted.** The loop fitted creatures at levels 1, 2, 4, and 5 and interpolated level 3, halfway to
  level 4's settings, against heroes without level 4's skills. It now also fits each level where a tier's first skill
  can be taken and the level before it (docs/rulesets.md).

The client also drew a melee area as a slash on its one target, so the others it struck were hit by nothing visible;
every area now shows a ring on the ground it covers.

Before (main's rules and balance, fights starting from the walking formation) and after (both seeds' balances):

| | Before | After |
|---|---|---|
| Heroes a creature's area catches (priced: 1.7 small, 2.4 large) | 1.8 to 2.8 | 1.3 to 2.2 |
| Level 3 elite fights won (party wiped) | 33 to 46% (13 to 16 of 24) | 79 to 83% (3 to 5) |
| Level 3 boss fights won (party wiped) | 21% (19 of 24) | 58 to 63% (9 to 10) |
| Level 4 boss fights won | 33 to 50% | 67 to 71% |
| Worst single creature action at level 3, share of the party's Health | 47 to 52% | 26 to 35% |
| Balance report on target | 23 of 24, both seeds | 23 of 27, both seeds (level 3 is now fitted and reported) |
| Balance time, one seed | 162 to 182 s | 184 to 193 s |

What is left: elite fights at level 2 are won 69 to 73% (the band starts at 82%, less 5 points of slack), and bosses
lose a lone hero or six heroes slightly more than four. A boss or elite fight with the AI on both sides is often won or
lost by a few blows, so their fitted settings still differ by 10 to 20% between seeds.

## How fights look

### Each world's own effects

Every hit, heal, and status is drawn as a few small moving shapes. Luna chooses how they look once per world, in the
build's `fightLooks` step (one small call, about a tenth of a cent). For every kind of damage, healing,
and every status, Luna picks the shapes (one or two of 23: sparks, embers, shards, chunks, droplets,
bubbles, motes, flakes, petals, leaves, paper, pixels, glyphs, stars, smoke, dust, streaks, notes, bolts, feathers,
coins, crescents, halos, each said in a word in the step's schema), two or three colors, whether it gives off light, a motion (a burst, a splash, a
swirl, rising, falling, drifting) and a trail for what is thrown. So an office's blows throw paper scraps, coffee
droplets and pixels, and a pond's cold drifts as flakes. The looks are part of the ruleset, keyed by what they are
for, so a rebalance keeps them. A kind of damage Luna gave no look is drawn as plain sparks in its color.

In the same call Luna chooses how each kind of damage's skills move (`looks.moves`, keyed by damage type), each from
a fixed list the client draws in code:

- **A rush** (a skill that dashes to its target): *dash* runs low in a cloud of dust; *blur* leaves fading copies of the
  fighter behind; *blink* vanishes in a puff of the look and reappears beside the foe; *streak* flies as a bright line
  that lingers; *leap* jumps in an arc (the figure rises off its shadow) and lands with a ring, dust, and a small shake.
  The server says where the fighter lands (`land` on the skill's effect), the figure is carried there in a fifth to a
  half of a second, and the swing and its hits wait for the arrival, as a projectile's do.
- **A shot** (what a ranged skill sends): *arrow*, a fast shaft; *orb*, a ball of the look with its trail; *lob*, an
  arcing throw, bigger and spinning, with a shadow on the ground under it; *bolt*, a jagged flash at once; *ray*, a
  steady beam that swells and thins away; *swarm*, a stream of the look's shapes weaving to the target.
- **A blast** (an area skill landing): *ring* spreads over the ground; *pillar* bursts up as a column of light and
  rising shapes; *rain* falls from above; *vortex* draws the shapes in before it bursts; *quake* sends three shock
  rings out with thrown dust and a small shake.

On the six examples Luna gave the magic kinds a range (streak, blink; orb, bolt, ray; ring, pillar) and the physical
kinds mostly a dash, a lob, or an arrow, and a quake. A world built before the choice existed rushes in dust, shoots
arrows and lands in a ring with its first (physical) kind, and blinks, shoots orbs, and lands in a ring with the others.

Healing, buffs, and weakenings fly as orbs of their own look, and a buff or weakening is drawn in the look of the status
it brings, rising or falling. Magic struck up close swirls the kind's own look about the target with a sweep across it.

The moves add nothing to the cost below: a rush's copies are the figure drawn again at a lower opacity for a fifth of a
second, and a pillar's column is a stamp drawn once per color, like the shapes.

### How much to show

Feedback follows how much a moment matters, so the screen stays calm in an ordinary exchange and a big moment
stands out:

- Each hit carries its share of the target's most Health, and whether it took them to zero.
- A scratch is a few flecks and a small number. A heavy blow is a full burst, a flash where it lands, a flash of the
  struck figure in the color of the blow, a knock-back away from the attacker, and a bigger number.
- A kill bursts and rings on the ground.
- Only the big moments hold the action for a few hundredths of a second and shake the view: a blow taking 30% of
  someone's Health, a heavy crit, a fallen boss or named foe, or the player's own hero falling. They apply only to
  the player's own fight or to what is on their screen: a friend's fight elsewhere in the place never stops or
  shakes the view. Prefers-reduced-motion turns both off.
- A melee swing draws a crescent across the target. A projectile carries its look and trail, and its hits show when
  it lands, not when it is thrown. Until they do, the target's Health (over its head, in the party display and the
  turn order) and its fall wait too (`holdHealth` in `net/game.ts`, at most 1.5 seconds), so Health never drops before
  the blow is seen to land.
- Aiming an area, everyone it would catch there glows (foes red for a harmful area, allies green for a helping one),
  by the server's own rule. An area is aimed at the ground, where the player puts it: one that helps always, one that
  hurts from a distance; a melee area that hurts strikes about the foe it is used on.
- Lasting states are quiet: now and then a mote of a status drifts about whoever has it, and a helpful status that
  raises a defense or dodging holds a ring of its own shapes and colors (the world's look for it) about the figure's
  middle, turning slowly, the far side behind the figure. It was a glass bubble, the same in every world; a look tuned
  to the world comes from Luna's choices, and only generic effects are fixed. There are no barriers that
  absorb damage: they were too close to healing, and on melee fighters they made them far too strong.
- Glowing effects light the dark around them.

### Whose turn it is

A fight should always say whose turn it is, even in a crowd:

- **Over the one acting**, a bobbing pointer above their Health bar, gold over a hero (smaller over the player's
  other heroes sharing the turn) and red over a foe, and under them a soft pool of light inside their pulsing ring.
- **The turn order** (`TurnBar`) floats over the world like the rest of the HUD, without a panel. It starts from whoever
  acts now, drawn larger with their names under them (heroes whose turns come together act at the same time, joined
  by a gold link), then those still to act this round, a small mark with the next round's number, and those who have
  acted. On a shared turn the action bar says who else acts with the player. Each portrait is ringed in its side's color (a player's heroes in their
  player color), with a sliver of Health under it; the downed are grayed.
- **The party display** (`ui/party.tsx`) glows round the portrait of the hero acting, the player's own or a
  friend's, and an own hero's name turns gold. A hero's level sits in a
  small disc on a ring round their portrait that fills with experience toward the next level, so the two read as one
  thing. Their statuses are small chips, each the status's own shape in its colors with the turns it has left; the
  name and what it does are in the tooltip, and a harmful one has a red foot.

### Joining and watching

A hero is in a fight when within 8 meters of anyone in it and in sight of them, whether the fight is starting or under
way (`JOIN_DISTANCE`); a party joins whole, and a newcomer takes a place among the turns still to come this round. A
player whose heroes are not in a fight in the same place watches it: it is drawn in the world (whose turn it is, the
foes' rings), while they walk, talk and loot as usual (`watched` in `net/game.ts`).

### The camera in a fight

The camera follows whoever acts, whatever side they are on and whoever commands them: the player's own hero on their
turn, else the first of those acting, AI-played heroes and foes too (a foe out of sight is not looked for). It keeps
them within the middle of the view and moves only when they are not: when the turn passes to someone near the edge or
off screen, or as they walk out of the middle. What they strike or cast at is brought into view as well, for a moment,
while both fit. It glides on a critically damped spring (no jolt at the start, no overshoot), settling in about half a
second, and cuts at once to someone more than two screens away, which no glide shows usefully. The player can still
move the view in a fight (dragging, the arrow keys, the screen's edge, the controller's cursor); that holds until the
turn passes.

### Getting up

A downed hero who gets up (healed, revived, or after a won fight) does not pop up: their painted fall plays backwards,
a little quicker, while their healing's look rises about them and a soft ring spreads at their feet. A figure without
painted clips tips back up over half a second.

### Checking them by eye

The effects reel (`client/src/render/fxreel.ts`) plays every kind of effect in turn on the hero and the figures
nearest them, with a caption saying what each should look like: each damage kind as a scratch, a heavy blow, a
thrown shot, a rush, and a crit; every rush, shot, and blast whatever the world chose; misses and healing; the skill
effects; every status; kills and a boss's fall; falling and getting up; a level-up and a busy round. It runs on that screen only and sends nothing to the
server. Administrators start it from the developer panel (Creatures, Effects reel) or with
`window.__gd.fxReel()`; peaceful mode and three spawned creatures make a good stage.

### Cost

Shapes are drawn once into small stamps (glowing ones with their halo baked in) and copied, with no blur or
gradients per frame. Particles are capped: 700 at once on a desktop, 45% of that on a touch screen, and half again
with reduced motion. Matter has a soft dark edge so it reads on any ground; everything is drawn over the scene
rather than added as light, which washes out on a bright painting by day.
