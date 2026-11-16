# Which sounds the game should have: an audit and a draft catalogue

> **Kept as a record.** This is the write-up of a finished study. Its scripts, prompt files and listening pages were removed for the 1.0 release and are in
> git history at the tag `pre-1.0-experiments`, as are the other studies it cites that are no longer in
> `docs/experiments/` or `docs/baselines/`. Paths that begin with `<study data>` or `<tools>` were on the author's own
> machine and are in neither.

Date: 2026-11-04. This note lists every moment a player meets that could make a sound or change the music, then
proposes which of them get one. It was made by reading `main` (this experiment's branch is older; file references
below are to `main`). Nothing in the game was changed.

## What already exists

The game is not silent on `main`. `packages/client/src/sound.ts` already has one audio context with a master volume,
a limiter and a voice channel, unlocks audio on the first click or key, and places spoken lines in the world. The
Settings panel has master volume, voices on or off, and voice volume. `docs/voices.md` names music and ambient sound
as later work. The haptics module `packages/client/src/input/haptics.ts` already picks moments to vibrate on (every
control tap, the start of my turn, one of my heroes hurt, walking into a wall) and is the natural model for wiring
sounds: one global listener for controls and a few state diffs.

One timing rule matters: a projectile's hit is held back until the projectile lands on screen
(`render/renderer.ts`, the `inFlight` list). Combat sounds must hook what the renderer shows (`Renderer.showFx`), not
the network message, or a hit is heard before it is seen.

## How often each moment is heard

How often a sound is heard decides how understated it must be:
- **Constantly** (every click, every step): nearly subliminal, many variants, small random pitch changes.
- **Many times a fight** (casts, hits, heals, deaths): short, scaled by how big the moment is. The game already has a
  "big moment" rule for the camera (critical hits, killing blows, boss hits); sounds should follow the same rule.
- **Once a turn or a fight** (my turn, combat starts, victory): short and distinct.
- **Once a place** (entering, discovering, chests, traps): ambience and music change here.
- **Rarely** (level up, quests, legendary finds, defeat): can be prominent.
- **Once a story** (intro, revelations, the end): full musical cues.

## Draft catalogue (superseded by `sound-plan.md`, the agreed plan of what gets a sound)

"Varies by" is the world data that makes the sound belong to this world. "Hook" says whether the game already sends a
clean event for it; where it does not, a gap below says what to add.

### Interface (heard constantly; volume group: interface)

| Sound | When | Varies by | Hook |
|---|---|---|---|
| tap | any button or control | the world's interface material (`ruleset.ui.material`: parchment, wood, stone, metal, glass, organic, paper, neon) | yes, one global listener |
| panel open / close | pack, character, talents, quests, map, craft, menu | interface material | yes, a change of the open panel |
| refuse | every refusal ("Not your turn", "Not enough gold", "Too far") | interface material | yes, all refusals are `bad` toasts |
| confirm | dangerous confirm dialogs (abandon, delete, leave) | interface material | yes |
| equip / unequip | moving gear on or off | the item's kind: blade, cloth, armour plate, jewellery | **gap: no item event** |
| coins out | buying, and paying to improve or enchant | the world's money | **gap: no trade event** |
| coins in | selling | the world's money | **gap** |
| talent learned | a talent point spent | interface material | **gap** |
| notice | a plain information toast | interface material | yes |

Hover sounds: none. Tooltips appear too often.

### Rewards and progress (rare; volume group: interface, ducks the world)

| Sound | When | Varies by | Hook |
|---|---|---|---|
| level up | a hero levels up | world palette | yes, `levelup` event |
| quest accepted | a new quest | world palette | **gap: quests are only text toasts** |
| quest progress | an objective done or changed | world palette | **gap** |
| quest complete | a quest finished | world palette | **gap** |
| quest failed | a failed quest or setback | world palette | **gap** |
| discovery | a place first discovered | world palette | yes (journal entry) |
| craft / forge | an item made, improved or enchanted | world palette | toasts only, no item data |
| legendary | a legendary item found or forged | world palette | **gap: only the toast's text shows it** |
| saved | a copy of the adventure saved | interface material | yes, but the client ignores it today |

### Loot and the world (per place; volume group: world)

| Sound | When | Varies by | Hook |
|---|---|---|---|
| gold pickup | gold taken | the world's money | toast text only |
| item pickup | an item taken | item kind and rarity | **gap: no item data** |
| bag full | nothing more fits | interface material | toast text only |
| chest open / locked / lock picked / pick breaks | a chest | world materials | feature state and toasts |
| trap spotted | a hero notices a trap | world palette | toast text only |
| trap springs | a trap goes off | the trap's element | yes, `trap` event |
| trap disarmed / failed | disarming | world materials | toast text only |
| exit / travel | taking an exit or fast travel | where it leads (down into a dungeon, out to the wilds) | yes, a new `zone` |
| bump | walking into a wall | ground | yes, `onBump` |

### Movement (constantly; volume group: world)

| Sound | When | Varies by | Hook |
|---|---|---|---|
| footsteps | each stride of a walking hero | the place's ground, the body type (walks, hops, crawls, rolls, floats: floaters and fliers are silent) | **gap: no ground data and no foot-contact frames**; derive steps from the renderer's walk phase |
| creature movement | creatures moving nearby, sparingly | the creature family's body | entity motion only |

Ground: the game keeps no ground material per cell, only walkable or not. The simple rule is one ground per place,
written by Luna from the place's kind, description and painted look, plus the hero's body type. Several grounds
within one place (a wooden bridge over snow) would need the map reader to keep a ground layer; this is not worth it
yet.

### Combat (many times a fight; volume group: combat)

| Sound | When | Varies by | Hook |
|---|---|---|---|
| combat starts | a fight begins | boss present, the place's kind | **gap: only a change of the combat state** |
| my turn | one of my heroes may act | interface material | yes (already a haptic) |
| cast | a skill or spell starts | its visual kind (slash, arrow, bolt, nova, heal, buff, debuff, shadow, beam, cloud) and element, through the element's look (`ruleset.looks.kinds`) | yes |
| projectile flight / landing | arrows, bolts, beams | kind and element | yes (renderer callback) |
| hit | damage lands | damage type (each element and weapon kind its own family), how big the hit is (`share`), critical, killing blow | yes |
| critical hit | a critical hit | as hit, layered | yes |
| dodge | an attack dodged | weapon kind | weak: a "Dodged" text |
| miss | an attack misses | weapon kind | **gap: declared but never sent** |
| barrier absorbs / breaks | a barrier soaks or breaks | barrier element | yes |
| heal | Health restored | heal element | yes, but every source sounds alike |
| status applied | burning, frozen, poisoned, stunned and the rest | the status and its look (`looks.statuses`); harmful or helpful | **gap: only the status's display name** |
| status ends | a control effect wears off | the status | **gap: no event** |
| surface | fire, poison or ice laid on the ground; reactions between them | the surface type | **gap: declared but never sent** |
| push / dash / teleport | forced movement | element | **gap: no event** |
| creature cry | a creature's turn, or a boss taunt, sparingly | the creature family | yes (turn change; boss taunts are voiced) |
| creature death | a creature dies | the family; boss or elite | yes, `death` event |
| hero downed | one of my heroes falls | interface material, mine or a friend's | yes, `death` event |
| revive | a hero revived | heal element | weak: text event |
| victory | the fight is won | world palette | toast text only |
| flee | the party escapes | world palette | toast text only |

### Talk (volume group: interface)

| Sound | When | Varies by | Hook |
|---|---|---|---|
| talk opens / closes | starting and leaving a conversation | interface material | yes |
| answer arrives | the person starts answering (unvoiced lines) | interface material | yes, `thinking` turns off |
| outcome | a gift accepted, an item or gold given, a quest offered, guards called | as the matching reward sound | **gap: outcomes are narrator text only** |

### Ambience (per place; volume group: world)

| Sound | When | Varies by | Hook |
|---|---|---|---|
| place ambience | a loop while in a place | kind (town, wilderness, dungeon), indoor or outdoor, weather (rain, snow, ash, spores, embers, dust, fireflies), description, the families living there | yes, `zone` |
| night layer | after dusk outdoors | the place | computed from the clock on the client |

### Music (key moments only; volume group: music)

| Cue | When | Varies by | Hook |
|---|---|---|---|
| title / lobby theme | the lobby and world pages (the night backdrop) | none; one for the game | navigation |
| world theme | starting or returning to an adventure, behind the intro and "the story so far" | world palette | yes, `intro` narration |
| place entered | first entering a place, a short cue fading into ambience | the place's kind and mood | yes, `zone` |
| quest accepted / complete / failed stingers | quest moments | world palette | **gap** |
| fight loop | an ordinary fight (optional; may stay silent) | the region or place kind | **gap** |
| boss loop | a boss fight | the boss | **gap**, plus the `boss` flag |
| boss beaten | a boss falls | the boss or world palette | `death` with the boss flag |
| victory sting | an ordinary fight won (optional) | world palette | **gap** |
| defeat | the party wakes in town | world palette | yes, `death` narration |
| revelation / the end | story arcs revealed, the ending | world palette, the arc | yes, `arc` and `ending` narration |
| level up | a hero levels up | world palette | as the level-up sound, or one cue for both |

## What is missing from the test set, and what it had that does not fit

The twenty test sounds mostly hold up. Corrections from the audit:
- **Miss and block** were tested, but the game has neither: misses are never sent, and the only block is a barrier
  absorbing or breaking. Either the game adds a miss, or the catalogue uses dodge and barrier sounds.
- **Opening the pack** becomes one panel open and close sound for every panel.
- **Footsteps on two grounds** become one ground per place.

Not tested and worth adding: my turn, combat starts, victory, critical hit, status applied and ended, surfaces,
traps, chests, discovery, the quest stingers, crafting, legendary finds, equipping by item kind, coins in and out,
refusals, talk, the hero downed, defeat, and the world and lobby themes.

## Gaps the game would need to fill

Each is small and general; most replace a text toast with a typed event that the toast already sits next to:
1. A combat start and end event with its outcome (victory, flee, defeat).
2. A quest event (accepted, progress, complete, failed), sent where the quest toasts are made; `questEvent` already
   exists on the server.
3. An item event (picked up, equipped, unequipped, dropped, bought, sold, crafted) with the item's kind and rarity.
4. Status applied and ended, with the status's id.
5. Surface created and reacted, using the `surface` event kind that is declared but never sent.
6. Miss, if the rules want misses at all.
7. Talk outcomes as typed events next to their narrator text.
8. Separate narration styles for signs and lore, quest text and town gatherings, and for revelations and "the story
   so far".
9. One ground per place in the world data, written at build time.

## Rough count per world

About 12 interface sounds, 10 reward sounds, 12 loot and world sounds, footsteps for each place's ground (about 6),
about 8 sounds per damage type, a cry and death per creature family, statuses and surfaces per element, and an
ambience per place: roughly 120-180 sounds with 3-6 variants for the frequent ones. Music: a world theme, a cue per
place kind or region, three quest stingers, a boss loop and beaten cue per boss, defeat, revelations and the end:
about 15-25 cues. At the measured speeds this is still about 10-20 GPU-minutes per world.
