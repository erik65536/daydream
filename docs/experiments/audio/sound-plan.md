# Which moments get a sound: the agreed plan

> **Kept as a record.** This is the write-up of a finished study. Its scripts, prompt files and listening pages were removed for the 1.0 release and are in
> git history at the tag `pre-1.0-experiments`, as are the other studies it cites that are no longer in
> `docs/experiments/` or `docs/baselines/`. Paths that begin with `<study data>` or `<tools>` were on the author's own
> machine and are in neither.

Date: 2026-11-04. Agreed with the author after two rounds of review. This plan goes through every moment found in
`event-audit.md` and says whether it gets a sound effect, a music cue or nothing, and what happens when a world's
takes for it all fail. The one open question is place ambience, to be decided by trying it in the game. Nothing here
is built yet.

## Rules behind the choices

**A moment gets a sound only if it tells the player something they would otherwise miss, or marks a moment that
should feel big.** Moments heard constantly get the fewest and quietest sounds. A moment already covered by a nearby
sound gets none of its own.

**Sounds are shared wherever the meaning is the same.** One "success" sound serves every small success (a trap
disarmed, a lock picked, an objective done); one "refusal" sound serves every refusal; one pair of panel sounds
serves every panel. This keeps the count low, keeps the world consistent and teaches the player what each sound means.

**When every take for a world fails, after retakes with new seeds, a sound either falls back or stays silent.** A
fallback is a neutral sound made once for the whole game, checked by ear, simple and quiet. Most sounds fall back,
because a missing sound feels broken. Sounds that describe a place or a creature stay silent instead, because a
neutral version would contradict the world: birds and a stream in an airless moon colony are worse than nothing.
Only three kinds stay silent: place ambience, creature deaths, and all music. Creature cries do fall back, to an
abstract fight-start sound, because a cry now announces that a fight has begun.

**Music never falls back**, because neutral music still has a style. Only the game's own theme is made once.

**When two prominent sounds land together, only the bigger one plays.** A quest reward that levels a hero up plays
the level-up, not both. A priority
order per category does this without special cases.

Key: **SFX** = sound effect; **Music** = a music cue; **None** = no sound. A **stinger** is a short piece of music, a
few seconds long, that marks a moment and does not loop (a fanfare is one). A **loop** plays until the moment ends.

## Music: three pieces carry most of it

The world page, starting an adventure and a world finishing its build all want music at the same time, so they share
one piece rather than three.

- **The game's theme** (made once, understated but catchy): the sign-in and home pages. It also keeps playing on a
  world's page while the world is still being built.
- **The world's theme** (one per world): plays on that world's page. When a build finishes while the player watches,
  the game's theme fades into the world's theme; the world's own music arriving *is* the moment the world comes
  alive, so the build's end needs no sound of its own. When the player starts or returns to an adventure, the theme
  carries on without restarting behind the intro or "the story so far", then fades out as the place takes over. It
  plays once and ends; it does not loop on the page. It plays again at **the end** of the story.
- **Boss loops** (one per boss): a boss fight. When the boss falls, the loop fades out under the killing blow. A
  boss-beaten stinger was tried and dropped on 2026-11-05: it did not sound good, would not match the boss loop, and
  was too much on top of the fight's own end.

Other music:
- **Entering a place:** a short cue on the first entry and after being away a while, not on every entry. It also
  marks the first discovery.
- **Quest complete:** a stinger. A story arc revealed is a main quest completing, so it plays the same stinger; the
  narration card carries the revelation.
- **Defeat** (waking in town): a stinger.

I think world music is worth it: the world's theme is the one piece of music every player of that world hears, it
makes a world feel made for its theme from the first page, and a single piece serving three moments costs little.

## Interface

- **Tap on any control:** SFX, fallback. Varies by the world's interface material.
- **Panel opens / closes:** SFX, fallback. One open and one close sound shared by every panel, including talking to
  someone and trading with a merchant.
- **Refusal** (not your turn, not enough gold, bag full, a locked chest, a broken lock pick): SFX, fallback. Shared.
- **Hover, tooltips, switching tabs, aiming and cancelling, "Too far" while aiming, confirm dialogs, information
  toasts, connection lost:** None.

## Multiplayer

- **A friend joins or leaves:** SFX, fallback. One soft cue for both.
- **A chat message arrives:** SFX, fallback. Quiet.
- **Turn timer about to run out:** SFX, fallback. A few ticks in the last seconds.

## Items, gold and crafting

Items need only two sounds, both shared, and gold one more.

- **Take** (picking up an item, equipping): SFX, fallback.
- **Put** (dropping an item, unequipping): SFX, fallback. Dropping makes a sound so an accidental drop is noticed.
- **Gold** (picking up, selling, buying, paying to improve or enchant): SFX, fallback. Simple and quiet.
- **A legendary item found or forged:** SFX, fallback. A shimmer over the take sound.
- **Crafting, improving, enchanting:** the success sound.
- **Assigning the hotbar, saving a copy:** None.

On equipping by item kind: the data exists (category, equipment slot, weapon type), but I would not do it now. Gear is
changed in a menu a few times an hour, and a separate sound for blades, armour, cloth and jewellery adds four sounds
and a branch for very little. It can come later if equipping feels flat.

## Progress and story

- **Small success** (an objective done or changed, a trap disarmed, a lock picked, a talent learned, crafting): SFX,
  fallback. Shared.
- **Quest accepted:** SFX, fallback.
- **Quest failed or set back:** SFX, fallback. A short falling tone.
- **Level up:** SFX, fallback. The most prominent sound effect.
- **Experience gained, narration cards, reading signs and lore:** None.

## The world

- **Place ambience:** see the open question below. Silent when it fails.
- **Footsteps:** None. They would be heard constantly, the game has no ground data and no foot-contact frames, and
  playing them for some bodies and not others would be inconsistent. I agree with leaving them out.
- **Spotting a trap:** SFX, fallback. An abstract warning, because it is easy to miss on screen.
- **A trap springs:** its element's hit sound.
- **Opening a chest:** SFX, fallback. A neutral latch fits most worlds well enough.
- **Taking an exit, fast travel, walking into a wall, night, creatures idling:** None.

## Combat

- **A fight starts:** a cry from one creature in the enemy group, chosen at random, replaces a separate start sound. It
  says both "a fight" and "what you are fighting" in one sound. Fallback: if that family's cry failed, an abstract,
  game-wide start sound plays instead, so a fight never starts unannounced. Ordinary fights get no music.
- **A boss fight:** the boss loop. The boss's taunt is already spoken.
- **My turn:** SFX, fallback.
- **Casting a skill or spell:** SFX per element, fallback. The fallback is a very abstract whoosh. Basic attacks use a
  swing.
- **A hit:** SFX per damage type in two sizes, normal and heavy, fallback (a dull impact). Critical hits and killing
  blows play the heavy hit, following the game's existing "big moment" rule.
- **Dodge** (and a miss, if the rules add one): SFX, fallback. Air swishing past.
- **A barrier absorbs / breaks:** SFX, fallback.
- **Healing and revival:** SFX, fallback.
- **A status applied:** SFX in two kinds, harmful and helpful, fallback.
- **A creature dies:** SFX per creature family, silent when it fails (the killing blow still plays).
- **One of my heroes falls:** SFX, fallback. It must never go unnoticed.
- **Damage over time, enemy turns, new rounds, a status ending, surfaces, push and teleport, projectiles in flight,
  victory, fleeing:** None. Victory in particular is already covered by the last death, the end of the fight on screen
  and often a level-up.

## Talk

- **Opening and closing a conversation, an answer arriving:** None. The panel sounds cover opening and closing, and
  answers stream in.
- **Outcomes** (a gift, an item or gold given, a quest offered): the matching take, gold or quest sound.

## Open question: place ambience

You found ambience the most fragile of the test sounds, and it is the one heard longest. I still think the game needs
something under it: without footsteps, and with music only at key moments, a place would otherwise be silent between
clicks and fights. I would try it in the game before deciding, with four safeguards:
- **Quiet:** well under everything else (the test target was -28 LUFS), and its own volume control.
- **Long and layered:** a long bed of 45 to 60 seconds plus a second short layer whose loop length does not divide
  the first, so the two never line up the same way twice.
- **Calm prompts:** "steady, continuous, no sudden sounds, no voices, no music", and no one-off events (a single bird
  call, a distant bell) that the ear catches on every loop. Checks reject takes with loud peaks above the bed.
- **Silent when it fails.**

If it still annoys in the game, drop it; nothing else depends on it.

## What this adds up to

**Per world:**
- **Sound effects:** about 17 shared sounds (interface, items, gold, progress, multiplayer, combat basics), a cast and
  two hits per element, a cry and a death per creature family, and an ambience per place. With 6 elements, 10
  families and 8 places that is about 63 sounds, 3 to 6 variants for the frequent ones.
- **Music:** the world's theme, a cue per place (or per kind of place), the quest-complete and defeat stingers, and a
  loop per boss. That is about 10 to 14 cues.

**Game-wide:** about 25 fallback sounds and the game's theme, each made once.

**Events the game would need to add:** combat start and end, quest events, item take and put events, statuses
applied (harmful or helpful), and a dodge event in place of the "Dodged" text. Ground per place is no longer needed.
