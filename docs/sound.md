# Sound and music

Every world is built with sounds and music of its own. A tap on a button in a world of hedgerows is a hazelnut shell;
in a mining colony it is a rubber-coated switch. Its spells sound like their elements, its creatures cry and die in
their own voices, each place has a steady ambience and a short cue for arriving, each boss a battle loop, and the
world has a theme and a defeat. This doc describes what the sounds are, how a build makes them, how they become
game-ready, and how the player hears them. The models were chosen in a bake-off, and every prompt's wording was
settled by ear in a prompt study; both are written up in `docs/experiments/audio/` (`report.md`, `prompt-study.md`,
`sound-plan.md`).

## The sounds

The catalog is `packages/shared/src/sound.ts`. Each sound has a loudness group (`kind`), a volume in Settings
(`bus`: interface, effects, music, or ambience), a shape (one sound, a music loop, or an endless texture), and how many takes a
world keeps (sounds heard often keep two or three, one picked at random each time).

**The game's moments**, the same in every world, each made from that world's materials:

| Moment | Heard when |
|---|---|
| `tap` | any control is pressed (mouse, finger, or controller) |
| `panel_open`, `panel_close` | a window opens or closes, a conversation too |
| `refusal` | the game says no: not your turn, not enough gold, the bag is full |
| `success` | a small success: an objective done |
| `craft`, `improve`, `enchant` | something is made (crafted or brewed); gear is improved; gear is enchanted |
| `learn` | a talent point or a craft point is spent |
| `level_up` | one of your heroes reaches a new level |
| `gold` | gold is picked up |
| `take`, `put` | an item is picked up or equipped; dropped or unequipped |
| `legendary` | a legendary item is found or forged (heard over `craft`) |
| `chest_open` | a chest is opened |
| `quest_accept`, `quest_complete`, `quest_failed` | a quest is taken on, finished, failed, or set back |
| `friend` | a friend joins or leaves the adventure |
| `chat` | a friend's chat message arrives |
| `timer_tick` | each of the last five seconds of a timed turn |
| `my_turn` | your turn comes in a fight |
| `hit`, `swing` | a plain blow lands; a basic attack or a skill without an element is used |
| `dodge` | a blow is dodged |
| `heal` | a hero is healed (by at least 5% of their Health) |
| `status_harmful`, `status_helpful` | a status takes hold |
| `hero_falls` | a hero is downed |

**A world's own sounds**, named `<kind>:<id>`:

| Sound | One for each | Heard when |
|---|---|---|
| `cast:<element>` | element | a skill of that element is used |
| `hit:<element>`, `heavy:<element>` | element | a blow of that element lands; a critical, killing, or very large one |
| `cry:<family>` | creature family | a fight starts: one creature of the enemies, picked at random, cries |
| `death:<family>` | creature family | one of the family dies |
| `ambience:<place>` | place | always, while the party is there |
| `place:<place>` | place (music) | on arriving for the first time, and after ten minutes away |
| `boss:<boss>` | boss (music) | during its fight, looping; it fades out when the fight ends |
| `theme` | world (music) | on the world's page, carrying on into an adventure until the place takes over, and at the ending |
| `defeat` | world (music) | when the party falls |

Nothing else makes a sound: hovering, tooltips, the journal, narration cards, damage over time, victory
(the last death and the music say it), footsteps.

**When moments land together, only the highest plays** (`rank` in the catalog). A quest reward that levels a hero
up is heard as the level-up; opening a chest is heard as the chest, not the window it opens. A moment that comes a
quarter of a second after a higher one is dropped, and one asked for just before is cut when a higher one follows,
whether it is heard yet or still loading. Sounds of the fight always play.

**News waits for speech.** The server's notices (a quest taken on, finished or failed, a reward, a level-up) are
news: while someone is speaking to the player (a conversation or the narrator, not a passer-by's remark heard from a
place), their sounds are held, and a breath after the speaking stops the highest of them plays alone. A quest given in
a conversation is heard when its giver finishes; the server speaks a reply before it applies what the reply does, so
its lines arrive first. What answers the player's own action plays at once: taps, windows, equipping, refusals. With
voices at 0% nothing is spoken, so nothing waits.

## The game's own sounds

A neutral copy of every moment, an abstract spell burst (`cast`), an abstract fight starting (`fight`) and the game's
own theme are made once and shipped with the client in `packages/client/public/sounds/`, listed in its `index.json`.
They stand in for a world's sound it could not make (`standIn` in the catalog):

- every moment stands in for itself;
- a spell takes the abstract `cast`;
- an element's hit or heavy hit takes the world's plain `hit` (a heavy one 4 dB louder), then the game's;
- a creature's cry takes `fight`, so a fight never starts unannounced;
- **places, deaths, and music have no stand-in**. A neutral ambience, death, or tune would contradict the world (birds
  and a stream on an airless moon), so they stay silent.

The game's theme plays on the pages around the worlds (signing in, the home page, creating a world, the account and
settings pages) and on a world's page while it is being built. It plays for as long as the player stays, again
after a rest of a few seconds (it is a finished piece with an ending, not a loop), and a world's page plays the world's
theme the same way. The console tool
`soundkit` makes these sounds (`--again` to make them anew, `--only <id …>` for some; a sound whose new takes are
all refused keeps the one it had). The shipped ones were chosen
by ear from several materials for each, two takes of each, and the chosen take of the
chosen material was copied in as the sound's only take; its material is the `neutral` in `sound/prompts.ts`. Making a
sound again with `soundkit` gives a new take of that material, not the chosen one.

The theme is the exception: it was composed with Google Gemini, which writes far better music than Stable Audio,
and brought in with `soundkit --use theme <file.wav>`. That makes any of the game's sounds from a WAV made elsewhere
with the same game-ready step as a generated take (lowered 6 dB first, as the generator's takes are, since a mastered
file touches full scale). `soundkit` never makes the theme itself, and `--again` keeps it.

## Prompts

Stable Audio 3 makes every sound: **Small SFX** the sound effects, **Medium** the music and the moments that are small
pieces of music (`success`, the three quest moments). Both run in ComfyUI behind the GPU broker
(`config/comfyui/stable_audio_3.json`: 8 steps, cfg 1, an empty negative prompt, the take lowered 6 dB before it is
saved so loud takes keep their peaks).

A prompt is the game's part, then the world's (`packages/server/src/sound/prompts.ts`):

- **The game owns** every sound's purpose (its mood, shape, and length: "A single proud ding that rings out,
  rewarding and positive, simple and clear"), the generator's tags (`TrackType: SFX`, `TrackType: Music, VocalType:
  Instrumental`, a genre tag on long pieces), each music cue's mood and where it plays, and "UI sound" at the end of
  interface moments (it keeps them small and simple).
- **Luna writes**, in the build's sounds step (`pipeline/steps/sounds.yaml`, one call per world), what the world makes each moment from ("on a hazelnut
  shell, close and dry"), what each element sounds like as a spell and as a blow, each family's cry and death, each
  place's ambience, and the soundtrack: a genre and a palette of instruments chosen first, as a film composer would,
  then each piece's style, instruments, and tempo. Its rules (`soundCraft` in `pipeline/constants.yaml`) are the prompt study's findings: plain
  physical words and no names the generator cannot know, no mood words, clear-pitched sources for tonal sounds,
  middle pitches, every sound named in full (never "the same"), ambiences without one-off events, melodies on low and
  middle instruments.

Some moments carry a hint of their own (`source`): the quest moments are two instruments answering each other, a
success is one simple source struck once, a harmful status is a magical sound rather than something tearing.

## Building a world's sounds

`worldgen/sounds.ts`, the build's last GPU step (after the art, priority 30 in the build's GPU queue):

1. Luna's answer is the sounds step's, kept with the build's other steps (`draft/pipeline/sounds/`). Every moment,
   element, family, place and boss is a required key of its answer, so none is left out.
2. Every sound is ordered (`worldOrders`): about 30 moments, three per element, two per family, an ambience and a
   cue per place, a loop per boss, the theme and defeat. A world of six elements, four families, eight places, and two
   bosses has about 90.
3. Each take is generated on the GPU (Small SFX first, then Medium, so the model changes once), made game-ready on a
   thread of its own (`sound/worker.ts`), and kept or refused. A sound keeps as many takes as it has variants; refused
   takes are made again with new seeds, twice at most, and a sound with no good take is left out. A take's seed comes
   from the world, the sound, and the take's number among all ever made of that sound (counted in
   `assets/sounds.takes.json`), so a sound made again, after a refusal or with `--again`, gets new takes.
4. The files are Ogg Opus at 48 kHz, stereo (64 kbps for effects, 96 for ambience, 112 for music), in
   `assets/sounds/<key>.<take>.opus`, a loop's intro beside it as `<key>.intro.<take>.opus`; `world.sounds` lists
   them. What exists is kept, so a stopped build resumes where it was. `worldpack` carries them with the world.

It takes about five minutes of GPU time for a world of that size, and under a cent of OpenAI. Without a ComfyUI
provider (tests, an installation without the GPU) a world gets no sounds and plays with the game's own.

### Game-ready

`sound/ready.ts`, rules that do not depend on what the sound is (ported from the study's `postprocess.py`):

- **One sound** keeps its main sound: the stretch around the loudest moment up to the first silence (40 dB under
  the peak) longer than a quarter of a second, or a second for music, which has rests. Anything after such a gap is
  the model's padding or a stray artifact, and silence before it goes, so every sound starts at once. Then a 3 ms
  fade-in, a fade-out over the last 15% (at most 120 ms), and its loudness group's level.
- **An ambience** loops by crossfading its last 1.5 s into its start.
- **A music loop** is a whole number of 8-bar phrases at the piece's tempo (measured from the audio when the model
  did not keep the one asked for). The bar it starts on (the bars before become an intro, played once) and the number
  of phrases are chosen so the seam matches best by rhythm and timbre. The loop's last beat is crossfaded into the beat
  before its start, so the loop runs on into its start exactly as the intro does.
- **Levels** (`TARGET`): short sounds by their loudest 100 ms (K-weighted, like LUFS), long ones by integrated LUFS.
  Fights and spells sit highest (about -11 to -12), interface sounds at -18, music at -18 to -20, and ambience well
  under everything at -28. Sample peaks stay under -1.5 dBFS.
- **A take is refused** when it is clipped, nearly silent, too short to be a sound or (an ambience) to loop, an
  ambience with a moment more than 12 LU over its bed's usual level (a bell or a call would be heard again on every
  loop), or music too short to hold a loop of sixteen bars. The seam of a loop is the best the take has; it is not
  held to a least quality.

ComfyUI saves audio as FLAC; the server decodes it itself (`sound/flac.ts`), so it needs no tool or library for it.

## What the player hears

- **The engine.** One `AudioContext` (`client/src/sound.ts`) with a gain for voices, interface, effects, music and
  ambience under a master gain and a light limiter. `client/src/sounds.ts` loads, decodes, and plays the sounds: the browser
  decodes Ogg Opus, or WebCodecs where it cannot (Safari before 18.4). Effects load when a world opens, so the first of
  each plays at once; music and ambience load when they are needed.
- **Settings:** one volume each for the master, the interface (taps, windows, refusals, and the other small feedback),
  effects (fights, spells, rewards, quests), music, ambience, and voices, kept with the account. 0% is off, and what is
  off is not even loaded: its sounds are neither downloaded nor played, and with voices at 0% the server sends no
  speech. Raising a volume from 0% brings back what lasts: the place's ambience, a boss's battle loop while its fight
  goes on, a page's theme. Short cues (an arrival, defeat) belong to their moment and do not start late.
  Sound starts on the first click, tap, or key press, as browsers require; music asked for before that starts then.
- **The pages around the game** (signing in, the worlds, a world's page, making heroes, the account, and settings) play
  the game's own interface sounds: a tap on every control, and the opening and closing of the account menu, the
  game's questions and the Codex. **Their mute**, the round speaker button beside the account in the top bar (alone
  in the corner while signing in), silences them and their music on this device, whatever the volumes. It is kept in
  the browser, not the account (the room a device is in decides it, and it holds before signing in), and does not
  reach the game, which is heard by its volumes alone (`sound.setPlaying`). Muted pages count as 0%: nothing loads,
  and unmuting brings back what lasts.
- **In the world.** A sound with a place (a blow, a cry, a death, a spell) is heard from the middle of the view, so the
  player hears what they see: in a fight the camera shows whoever acts, however far from the player's own hero. It is
  quieter with distance, silent past earshot (12 m, or half the view's width when the view is zoomed out wider) and a
  little to the side it is on. A fight's sounds play when the blow is seen to land, not when it is sent: an arrow's
  hit sounds as it arrives. Sounds heard often are pitched a few percent up or down each time, and never the same
  take twice in a row.
- **Music** is one channel: a new piece crossfades from the last, and asking for the piece already playing changes
  nothing. While music plays, the place's ambience steps back to under half its level. Ambience crossfades between
  places and starts somewhere else in its loop on each visit. Only the current and the previous piece of music and of
  ambience stay decoded; older ones are let go and decoded again when they are next needed.
- `client/src/gamesounds.ts` follows the game (its effects, notices, the fight, the place, the roster) and plays
  what each moment calls for; the server says which moment a notice is when its kind does not (`toast.sound`), and
  the effects carry what the sounds need (a dodge, a status applied, a creature's family,
  a boss's id).

## Existing worlds

`soundworld` gives built worlds their sounds the way a build does (`<world id …>` or `--all`, `--again` to make
everything anew from the same plan, with new takes), backing up the world file first.

A world built before a moment was added (`craft`, `improve`, `enchant` and `learn` came on 2026-11-14) plays the
game's copy of that moment: its kept sound plan names no material for it. Running the world's sounds step again
(in the world's own pipeline, `worldPipeline(id).run(worldExample(world), 'sounds')` in `worldgen/build.ts`, under a
cent; the `pipeline` CLI works on the examples only, and no console tool runs one step of a world yet) and then
`soundworld` makes just the missing sounds; what the world has is kept.

## Installing

The GPU PC's ComfyUI needs Stable Audio 3 Small SFX and Medium and their text encoder, from Comfy-Org's packaging of
Stability AI's weights (`docs/hosting.md`, "GPU PC setup"). Stability's license binds the models; the attribution it
asks for is in `CREDITS.md`.
