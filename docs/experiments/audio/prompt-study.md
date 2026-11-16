# Prompt study, stage 1: how Stable Audio 3 responds to the form of a prompt

> **Kept as a record.** This is the write-up of a finished study. Its scripts, prompt files and listening pages were removed for the 1.0 release and are in
> git history at the tag `pre-1.0-experiments`, as are the other studies it cites that are no longer in
> `docs/experiments/` or `docs/baselines/`. Paths that begin with `<study data>` or `<tools>` were on the author's own
> machine and are in neither.

Date: 2026-11-04. GPU only (the GPU PC); no OpenAI calls, so no spend. Scripts: `prompt_study.py` (the prompts),
`comfy_run.py` (generation, now with `--cfg` and `--folder`), `postprocess.py`, `analyze.py`, `study_summary.py`
(the automatic checks) and `make_page.py` (pages, now with `--column-prompts`).

## Why

A build will have Luna write every prompt from a world's data. Before writing Luna's instructions we need to know
what the two chosen models respond to: Stable Audio 3 Small SFX for sound effects and Stable Audio 3 Medium for
music. Stage 2 then teaches Luna to write prompts in the form that works.

## What Stability's own guide says

From Stability's prompt guide (stability.ai/guides/stable-audio-3-prompt-guide) and the repository's
`docs/guides/prompting.md` and `docs/workflows/inference.md`:
- **Sound effects:** describe the source (what makes the sound), the action (how it is triggered and how long it
  lasts), then the production (microphone, room, processing). Starting with the tag `TrackType: SFX` "tends to produce
  more semantically reasonable sound effects".
- **Music:** genre first, then the instruments and how they are played, then mood and energy, arrangement and
  production, with the tempo written as "120 BPM". Starting with `TrackType: Music, VocalType: Instrumental` "tends to
  produce higher quality, more semantically coherent outputs". Genre tags (`Genre: Funk`) and describing where you would
  hear the music ("for the final scene of a slow-burning sci-fi film") are also suggested.
- **Training data:** Freesound and AudioSparx with their metadata, which is where the tags come from. Prompts that read
  like those descriptions work best.
- **No length or key tag.** Length is set by the latent size, not by the prompt, and should fit what is described.
- **Settings:** 8 steps for the released models; prompt strength (cfg) 1 by default, "try 7.0 for stronger prompt
  adherence". The models are built for instrumental music and do not make intelligible vocals.
- **Nothing** on stingers, short loops or words to avoid.

## What was made

Each sound was written once per world as parts (source, action, production, short tags; for music: genre,
instruments, mood, arrangement, production, BPM) and each variant assembles the same parts differently, so a
difference between variants is the prompt's form, not its content. Two worlds (The Lantern of Thimblebrook and The
Last Light of Kestrel Belt), two takes per prompt, no negative prompt. Every clip went through the game-ready step, so
loudness is equal on the pages.

- **Sound effects** (Small SFX), 9 sounds from the agreed plan (tap, refusal, small success, level up, gold, hit, fire
  spell, creature cry, place ambience), 8 variants, 288 clips:
  - description only, the sound's name first ("Level up sound effect: ..."), the `TrackType: SFX` tag, tag and name;
  - the description ending with the kind of game it is for; short tags only;
  - tag and name at prompt strength 3 and 7.
- **Short cues as sound effects or music** (quest accepted, quest complete, level up, defeat), 48 clips: Small SFX with
  the SFX tag, Medium with the SFX tag, Medium with the music tag.
- **Music** (Medium), 4 cues (world theme 45 s, entering a place 10 s, boss loop 64 s, quest complete 6 s), 5
  variants, 80 clips: description only, music tag, music and genre tags, tag and where it plays, tag and the cue's name.

## Automatic checks

Counts of takes a build would have to reject or repair. "Late" is a start more than 0.1 s into the file; "kept" is the
median length of the main sound kept by the game-ready step, as a share of the length asked for.

| Sound-effect variant | Takes | Silent | Late | Clipped | Noise floor | Kept |
|---|---|---|---|---|---|---|
| Description only | 36 | 0 | 4 | 0 | -91 dB | 0.42 |
| Name first | 36 | 0 | 1 | 3 | -91 dB | 0.42 |
| SFX tag | 36 | 0 | 2 | 0 | -91 dB | 0.41 |
| Tag and name | 36 | 0 | 1 | 1 | -91 dB | 0.30 |
| Description + the game | 36 | 0 | 0 | 1 | -91 dB | 0.46 |
| Short tags only | 36 | 0 | 5 | 0 | -91 dB | 0.38 |
| Tag and name, strength 3 | 36 | 0 | 2 | 10 | -91 dB | 0.37 |
| Tag and name, strength 7 | 36 | 0 | 0 | **34** | -95 dB | 0.71 |

| Short cues | Takes | Silent | Late | Clipped | Kept |
|---|---|---|---|---|---|
| Small SFX, SFX tag | 16 | 0 | 1 | 0 | 0.61 |
| Medium, SFX tag | 16 | 0 | 3 | 0 | 0.65 |
| Medium, music tag | 16 | 0 | 1 | 0 | 0.65 |

| Music variant | Takes | Silent | Late | Clipped | Noise floor |
|---|---|---|---|---|---|
| Description only | 16 | 0 | 3 | 0 | -61 dB |
| Music tag | 16 | 0 | 3 | 0 | -62 dB |
| Music and genre tags | 16 | 0 | 3 | 0 | -65 dB |
| Tag + where it plays | 16 | 0 | 2 | 0 | -56 dB |
| Tag + the cue's name | 16 | 0 | 6 | 0 | -63 dB |

What the checks already show:
- **Strength 7 is unusable and strength 3 is doubtful:** 34 of 36 takes at strength 7 hit full scale, 10 of 36 at
  strength 3, against at most 3 at strength 1. At 8 steps a higher strength overdrives the output. Unless the pages
  show strength 3 following prompts clearly better, strength stays at 1.
- **No form made silent takes**, and the noise floor of sound effects does not depend on the prompt.
- **Short tags only** start late most often; the description forms are steadier.
- The "kept" share is low for every sound-effect form because the asked length (1-3 s) is longer than a tap or a hit;
  it is a measure of padding, not of quality. The checks cannot judge whether a sound is right: that is the listening.

## Listening pages

In `<tools>\audio-bakeoff\pages\`, each asking one question, each column showing its own prompt:
1. `study-1-sfx-tag-and-name.html`: description only, name first, SFX tag, both.
2. `study-2-sfx-wording.html`: description, description + the game, short tags.
3. `study-3-sfx-strength.html`: strength 1, 3 and 7.
4. `study-4-stingers-sfx-or-music.html`: short cues as Small SFX, Medium SFX and Medium music.
5. `study-5-music-tags.html`: no tag, music tag, music and genre tags.
6. `study-6-music-context.html`: music tag, + where it plays, + the cue's name.

## Verdicts (the author's listening, 2026-11-04)

1. **SFX tag and naming.** Many sounds came out nearly the same whatever the form, a few very differently. The
   `TrackType: SFX` tag was best overall; tag and name together was worst. Some sounds were bad because the description
   clashed with the sound's purpose, most of all in Kestrel Belt: its level-up sounded nothing like a level-up, and
   its description did not describe one either. The prompts were too stylised for the world.
2. **Wording.** Short tags were too simple and sounded generic. Adding the game it is for seemed to confuse the model.
   The plain description was best.
3. **Strength.** 7 is random noise; 3 is louder and sometimes breaks; 1 is clearly best.
4. **Short cues.** Small SFX does poorly at anything musical; Medium as music makes longer, more complex cues.
   Quest accepted, quest complete and level up were better as sound effects: short and simple (music was a little too
   much). A level-up should be short in most worlds; a long one is over the top. Kestrel's quest complete sounded
   anxious, not positive. Defeat was better as music: it is a big moment that takes the player to another place, like
   entering a place, and these fitted their context well.
5. **Music tags.** Description only was worst. The genre tag added a little to the music tag: good for longer music,
   not for short stingers. Thimblebrook's world theme was unpleasant: the guitar picking did not sit with the flute.
6. **What the music is for.** The cue's name first was worst (confused). Saying where it plays added character and
   complexity and was liked in most places, but sometimes added layers that do not fit; undecided. Many Thimblebrook
   pieces were unpleasant because they sit so high: steady high-pitched music from Stable Audio 3 has a scratching,
   chalkboard quality.

## What this means for the prompts

- **Sound effects:** `TrackType: SFX, ` followed by a plain description; no name, no game, no tag lists; strength 1.
- **Music:** `TrackType: Music, VocalType: Instrumental, ` followed by the description; a `Genre:` tag only for long
  pieces; strength 1. Whether to say where it plays is still open.
- **Purpose before style.** The biggest failures were not about form but content: the world's style overrode what the
  sound must say. A level-up must sound rising and rewarding, a quest complete positive, whatever the world's tone.
  The mood and shape of a sound should come from the event, and the world should only choose what it is made of.
- **Register.** Music should rest on low and middle instruments and avoid steady high lines (high flutes, whistles,
  high fiddle).
- **Which model for short cues:** quest accepted, quest complete and level up as short sound effects; defeat as music.
  (Whether "sound effect" means Small SFX or Medium with the SFX tag is tested in round 2.)

Round 2 (`prompt_study2.py`) tests these: purpose-first against stylised descriptions in four worlds, short cues by
Small SFX against Medium as sound effects, and music with the register rule, with and without saying where it plays.

## Round 2: what was made and the checks

Four worlds (adding The Warm Below, melancholic, and Bellwether, an absurd office comedy), two takes per prompt, 240
clips, about 4 GPU-minutes. Pages in `<tools>\audio-bakeoff\pages\`:
7. `study-7-purpose-first.html`: eight sounds, stylised (the world leads) against purpose first (a fixed purpose per
   sound, then what this world makes it from).
8. `study-8-short-cues-small-or-medium.html`: quest accepted, quest complete and level up as sound effects, by Small SFX
   and by Medium.
9. `study-9-music-register-and-where.html`: world theme, entering a place, boss loop and defeat, with low and middle
   instruments and the mood taken from the cue, with and without a sentence on where it plays.

| Variant | Takes | Silent | Late | Clipped |
|---|---|---|---|---|
| Sound effects, stylised | 64 | 0 | 4 | 5 |
| Sound effects, purpose first | 64 | 0 | 8 | 0 |
| Short cues, Small SFX | 24 | 0 | 1 | 1 |
| Short cues, Medium | 24 | 0 | 0 | 0 |
| Music, tag | 32 | 0 | 8 | 0 |
| Music, tag + where | 32 | 0 | 7 | 0 |

Purpose-first prompts never clipped (the stylised ones did five times) but started late twice as often; the game-ready
step trims late starts, so clipping is the worse fault. A late start in music is usually a soft entry, not a fault.

## Round 2 verdicts (the author's listening, 2026-11-05)

7. **Purpose first is a clear winner.** It carries the right intent. The stylised descriptions sometimes work but
   often make a sound that does not fit what it is for. The one bad purpose-first sound was Kestrel Belt's success
   ("a single short bright positive ding, as a clean synth chime with a soft relay click, dry"): it sits too high.
8. **Short cues.** Medium as a sound effect is better for quest accepted: more complex and of higher quality. No quest
   complete was liked by either model (Small SFX may be the better start). A level-up should not be a big musical
   production, which would confuse players; whether it needs a sound at all is open.
9. **Music.** The music tag with where it plays was better: more complexity, and closer to the world's theme. Some
   pieces sound like big modern film scores, which is good, but they could be more pleasant to listen to.

So the prompt form now has: purpose first for every sound effect; where it plays for all music; Medium for quest
accepted. Round 3 (`prompt_study3.py`) tests what is still open: pitch words for the sounds that went high, plainer
non-musical quest complete and level-up sounds by both models, and music asked to be melodic and pleasant.

## Round 3: what was made and the checks

Same four worlds, two takes per prompt, 128 clips, about 3 GPU-minutes. Pages in `<tools>\audio-bakeoff\pages\`:
10. `study-10-pitch.html`: the success ding and the gold pickup, round 2's bright purpose against a warm, soft, middle
    pitch (Small SFX).
11. `study-11-plain-rewards.html`: quest complete as two or three warm notes rising to a settled ending, and level up as
    a short rising shimmer rather than a melody, by Small SFX and by Medium.
12. `study-12-pleasant-music.html`: round 2's winning music form against the same instruments, tempo and place with
    the mood asking for a warm, memorable melody over consonant harmony.

| Variant | Takes | Silent | Late | Clipped |
|---|---|---|---|---|
| Success and gold, bright | 16 | 0 | 0 | 0 |
| Success and gold, middle pitch | 16 | 0 | 0 | 0 |
| Plain rewards, Small SFX | 16 | 0 | 6 | 0 |
| Plain rewards, Medium | 16 | 0 | 2 | 0 |
| Music, where it plays | 32 | 0 | 7 | 0 |
| Music, asked to be pleasant | 32 | 0 | 5 | 0 |

Brightness was also measured as the spectral centroid (the average frequency of the sound's energy, higher meaning
brighter). The middle-pitch wording lowered every success ding (Thimblebrook from about 9.7 to 6.5 kHz, Kestrel Belt
from 9.9 to 8.4 kHz) but barely moved the gold pickup, which is mostly the noise of small metal pieces whatever the
pitch words say. Asking the music to be pleasant changed its brightness little either way, so any difference on page 12
is in the writing of the music, not its register.

## Round 3 verdicts (the author's listening, 2026-11-05)

10. **Pitch words made very little difference**, and there is no clear winner. Kestrel Belt's success still sounds
    like static.
11. **Quest complete by Medium as a sound effect sounds great.** Both level-ups are terrible: each is a frequency
    sweep. A level-up should be something simple, such as a proud ding.
12. **Round 2's music form is better.** Asking for a warm, memorable melody added complexity that makes the music
    confused and a little off. Short music is now right; long music (the world theme and the boss loop) is of
    acceptable quality but not studio quality.

So: quest accepted and quest complete are made by Medium as sound effects; music keeps round 2's form; pitch words are
dropped. Round 4 tests a proud ding for the level-up, Kestrel Belt's success without the relay click, and whether more
sampling steps lift the long music.

## Round 4: what was made and the checks

Same four worlds, two takes per prompt, 80 clips, about 2 GPU-minutes. Pages in `<tools>\audio-bakeoff\pages\`:
13. `study-13-proud-ding.html`: the level-up as a single proud ding, and the success ding with Kestrel Belt's relay
    click taken out ("a soft clean electronic chime"), by Small SFX and by Medium as sound effects.
14. `study-14-long-music-steps.html`: the world theme and the boss loop in round 2's form at 8, 16 and 32 sampling
    steps, same prompt and seed.

| Variant | Takes | Silent | Late | Clipped |
|---|---|---|---|---|
| Dings, Small SFX | 16 | 0 | 0 | 0 |
| Dings, Medium | 16 | 0 | 0 | 0 |
| Long music, 8 steps | 16 | 0 | 2 | 0 |
| Long music, 16 steps | 16 | 0 | 3 | 0 |
| Long music, 32 steps | 16 | 0 | 2 | 0 |

A long piece takes about 2.5 s to make at 8 steps, 3.0 s at 16 and 5.3 s at 32 (median, without the first, which
loads the model), so even 32 steps would cost a build almost nothing. The checks show no fault that depends on the
steps; whether the quality changes is the listening.

## Round 4 verdicts (the author's listening, 2026-11-05)

13. **Success: Medium as a sound effect is better.** Small SFX made very similar sounds that did not sound like
    success. **Level-up: Small SFX is better**, pleasant and simple.
14. **Steps: 8 is best.** 32 steps is more complex but everything sounds overcooked; 16 sometimes adds complexity in
    parts but sometimes loses the plot. 10 or 12 might be a small tweak, not a fix.

## Stage 1 result: the recipe so far

- **Form.** Sound effects: `TrackType: SFX, ` + the event's fixed purpose + what this world makes it from, plain words,
  no name, no game, no tag lists. Music: `TrackType: Music, VocalType: Instrumental, ` (+ `Genre: X, ` for long pieces)
  + the genre words and instruments + the cue's fixed mood + `N BPM.` + `It plays <where> in <the kind of game>.`
- **Content.** The mood and shape come from the event and are the same in every world; the world chooses only the
  material, the instruments and the genre. Music rests on low and middle instruments. No pitch words, no requests for
  extra beauty or melody (they made music busier and worse), no negative prompt.
- **Settings.** Prompt strength 1, 8 sampling steps.
- **Which model.** Medium as a sound effect for tonal reward sounds (success, quest accepted, quest complete); Small
  SFX for the level-up and, as tested in round 2, the noise-based sounds (tap, refusal, gold, hit, spells, cries);
  Medium as music for every music cue, including defeat.
- **Quality.** Sound effects and short music are good. Long music (the world theme and boss loops) is acceptable but
  not studio quality, and neither prompts nor steps fixed that.

The author chose not to try best-of-several takes for long music: nothing could choose among them, and although some
takes are better than others, none is studio quality. Long music stays acceptable for now.

# Stage 2: Luna writes the prompts

Date: 2026-11-05. The branch was first brought up to date with `main` (the local branch; `origin/main` is stale).

## How it works

`packages/server/src/cli/_exp/soundprompts.ts` is an experiment tool, not part of a build. It reads world files and
makes one `world.content` call (Luna) per world. The game owns everything stage 1 settled: each sound's purpose, the
tags, the model per sound, prompt strength and steps, and each music cue's mood and where it plays. Luna writes only:
- the **soundtrack** it chooses for the world, in one sentence (its genre and instrument palette), written first so the
  rest follows from it, plus the `Genre:` tag and the kind of game in plain words;
- a **material** for each of the game's sounds, a lowercase phrase that continues the purpose ("on hollow wood, close
  and dry"). Tonal sounds must be made on something with a clear pitch, with no clicks or noise;
- a **spell sound per element**, starting with what the element clearly sounds like ("of fire, a whoosh into
  crackling flame") and then what this world makes it from;
- a **cry per creature family**, describing the creature physically, since the generator does not know invented
  names;
- **style, instruments and tempo** for the world theme, defeat, each place's first-arrival cue and each boss's loop.

The code joins these into stage 1's form and writes the runner's prompt files (`stage2/small.json`,
`stage2/medium-sfx.json`, `stage2/music.json`; Luna's raw answers are in `stage2/luna.json`).

Two drafts were fixed before any sound was made:
- Luna wrote whole sentences where the form needs a continuing phrase, so the instructions now give the form with
  examples.
- With a single music example, every world became "industrial folk" with cello, bassoon and frame drum. Asking Luna
  to choose the soundtrack first, from the world's tone and as a film composer would, with contrasting examples from
  other worlds, gave four distinct soundtracks:
  - Thimblebrook: acoustic folk with wooden flutes, guitar, cello and dulcimer;
  - Kestrel Belt: tense industrial ambient with muted strings, piano, handpan and analog synth;
  - The Warm Below: melancholic folk-orchestral with cello, harp and horn;
  - Bellwether: dry chamber jazz with piano, bassoon and muted brass.

**Cost:** four calls of about 20 s each, about $0.002 in all (the meter's estimate). Making the sounds took about 6
GPU-minutes for 222 clips.

## Pages and checks

Pages in `<tools>\audio-bakeoff\pages\`:
15. `study-15-luna-or-hand.html`: every sound both sides have, in four worlds, set against stage 1's hand-written
    winner with the same purpose and model.
16. `study-16-luna-spells-and-cries.html`: every element's spell and every family's cry.
17. `study-17-luna-music.html`: the world theme, defeat, every place's cue and every boss loop.

| Variant | Takes | Silent | Late | Clipped |
|---|---|---|---|---|
| Luna, Small SFX (interface, rewards, spells, cries) | 110 | 0 | 25 | 6 |
| Luna, Medium as sound effects | 24 | 0 | 0 | 0 |
| Luna, music | 88 | 0 | 13 | 0 |
| Compared sounds, hand-written | 112 | 0 | 15 | 0 |
| Compared sounds, Luna | 110 | 0 | 11 | 4 |

- **Late starts** are all spells and cries, and the cleanup step trims them.
- **Clipping:** the six clipped takes are loud sounds:
  - Warm Below's fire and Thimblebrook's lightning, both takes each;
  - Kestrel Belt's first creature cry, one take;
  - Bellwether's level-up bell, one take.

  A build should make spells and cries with the same 6 dB of headroom as music, or rely on the peak limiter on the
  report's list.

## Stage 2 verdicts (the author's listening, 2026-11-05)

15. **Luna generally sounded as good as the hand-written prompts or better** on most sounds. The exceptions:
    - Quest accepted and quest complete were much better hand-written, more musical. In three of the four worlds Luna
      made them on a single instrument (a marimba, a harp, a synth tone, a dulcimer), where the hand-written prompts
      named two instruments that answer each other ("on a wooden flute and plucked harp").
    - Success was slightly better hand-written, but both are a little too much for a simple interface sound.
    - The hand-written music was generally better, though Luna's was not bad.
16. **Spells and cries are mostly good** (not all were heard). Cold was bad, probably because "crackle" sounds like
    electricity.
17. **Luna's music is not bad, but slightly worse** than the hand-written music.

Music may need a human ear. So the next step is a prompt playground
(`playground.py`, below): the author writes and plays prompts against the same data Luna is given, and the takes and
notes are logged for turning into Luna's instructions.

# The prompt playground

`playground.py` (with `playground.html`) is a local page for writing Stable Audio 3 prompts by ear. Start it with
`python docs/experiments/audio/playground.py` (or the "sound playground" entry of `.claude/launch.json`) and open
http://localhost:8190. It needs the private ComfyUI on 8189.

- **Left side:** pick a world to see exactly what Luna is given (its instructions, the world's brief and the answer's
  schema, from `stage3/inputs.json`), what Luna answered, and a starting prompt for every sound. Each sound offers
  Luna's prompt and, where one exists, stage 1's hand-written winner, each with its model and length.
- **Right side:** edit the prompt, choose the model (Medium, made with 6 dB of headroom as in the study, or Small
  SFX), the length, the number of takes, the seed, the steps and the strength, then Make (or Ctrl+Enter). Takes
  appear newest first, the first one playing at once. Each can be rated Good, Fine or Bad, given a note, or loaded
  back into the editor.
- **What is kept:** every take is in `<tools>\audio-bakeoff\playground\` as `<n>.flac`. `log.jsonl` there holds each
  take's prompt and settings, and every rating and note (the latest wins). That log is what turns the author's listening
  into Luna's instructions.
- **Safety:** the server listens on 127.0.0.1 only and accepts only same-origin JSON posts.

## What the playground taught (2026-11-05)

The author's conclusion after an evening in the playground: the prompts were not the problem. Stable Audio 3 is not
great at making memorable music, and that is acceptable: it will work. One finding carried over: interface sounds
that came out wrong were better with "UI sound" (or "UI click") at the end of the prompt. The takes are in
`log.jsonl` (32 of them, unrated), most of them the Thimblebrook success ding on Small SFX with and without that
ending.

# Stage 3: Luna's final instructions

Stage 3 settles Luna's instructions for every kind of sound and tests them on five worlds: the four of stage 2 and
The Last Light of Vesper, a science-fiction salvage world nothing was tuned on. The changes since stage 2, each from a
verdict above:

- **Interface sounds end with "UI sound".** Tap, refusal, success and gold are interface feedback; the game adds the
  ending, so Luna does not write it. Level-up, the hit and the quest cues do not get it.
- **Success is one simple source struck once.** Both stage 2's takes were "a little too much" for small feedback.
  The same success prompt is also made by Small SFX (`success_small` on the pages), since the playground tried it
  there and "UI sound" may suit the smaller model.
- **The quest cues are two instruments answering each other.** That is what the hand-written prompts did and Luna's
  did not. Luna is given an example per cue ("on a wooden flute answered by a plucked harp, clean").
- **Cold is ice forming, not a crackle.** Luna's example for cold is now "a glassy ring and creak of ice forming,
  never crackle or sizzle, which sound like fire or electricity".
- **Small SFX gets 6 dB of headroom**, like Medium, because four of stage 2's spells and cries clipped. The game-ready
  step sets every sound's level afterwards, so the headroom changes nothing else.
- **Music is unchanged.** Its instructions held up in stage 2, and the playground found no wording that does better.

Luna's sound-specific guidance is a `source` field on each of the game's events in `soundprompts.ts`, shown both in
the world's brief and in the answer's schema, so a future sound with its own needs gets one line, not a new rule.
`stage3/` holds what Luna wrote and `stage3/run.sh` makes it into sound; `stage3_compare.py` arranges the takes for
the pages. Luna's five calls cost about $0.003.

## Stage 3 checks and pages

GPU time was about 7 minutes for all five worlds. The checks, against stage 2:

| Takes | Stage 2 | Stage 3 |
|---|---|---|
| Small SFX | 110 takes, 25 late, 6 clipped | 148 takes, 27 late, 0 clipped |
| Medium as sound effects | 24 takes, no faults | 30 takes, no faults |
| Music | 88 takes, 13 late | 106 takes, 21 late, none clipped |

The headroom ended the clipping. The four "silent" takes the summary reports are the soft taps of Thimblebrook and
The Warm Below: with 6 dB of headroom their raw loudness is about -55 LUFS, under the check's -45, but their peaks are
-28 to -32 dBFS and the game-ready step levels them like every other tap. The late spells and cries start 0.11 to
0.17 s into the file, just past the 0.1 s limit, as in stage 2.

- Page 18, `study-18-luna-final-fixes.html`: the sounds the stage 2 notes changed, stage 2's take beside the final
  one, and success made by Small SFX.
- Page 19, `study-19-luna-final-sounds.html`: every final sound effect of all five worlds.
- Page 20, `study-20-luna-final-music.html`: the world theme, defeat, start place and first boss of all five worlds.

## Stage 3 verdicts and the cold spell (2026-11-05)

Every final sound and piece of music was good except cold, where the author heard "creak" break the sound. Page 21
(`study-21-cold.html`, made from `stage3/cold.json`) tries three ways to say what cold sounds like, each followed by
the world's own material that Luna wrote in stage 3, for the four worlds with a cold element, two takes each:

- A: "a bright crystalline shimmer of ice forming with a cold breathy whoosh";
- B: "a cold wind gust into the glassy shatter of ice shards";
- C: "a frosty swirl of glassy chimes and a soft icy hiss".

None clipped. Half start 0.11 to 0.15 s into the file, a soft swell into the sound, spread evenly over the three.
The winner becomes Luna's example for cold.

The author liked A best, so Luna's example for cold is now "a bright crystalline shimmer of ice forming with a cold
breathy whoosh, never crackle, creak or sizzle". With that, every kind of sound has its final instructions in
`soundprompts.ts`.

# Stage 4: the rest of the agreed sounds

Stage 4 adds every sound of the agreed plan (`sound-plan.md`) that stages 1 to 3 did not cover, with the same recipe:
the game owns each sound's purpose and Luna writes what this world makes it from. It runs on the same five worlds.

- **Shared sounds** (one per world): a panel opening and closing, a friend joining, a chat message, the turn timer's
  tick, "my turn", taking and putting an item, a legendary find, opening a chest, spotting a trap, a failed quest
  (Medium, two answering instruments like the other quest cues), the basic swing, a dodge, a barrier absorbing and
  breaking, healing, a harmful and a helpful status, and a hero falling. The interface ones end with "UI sound".
  Several carry a `source` hint naming what to make them from ("the weapon most heroes of this world carry"), and
  each closing sound names what its opening sound opens.
- **Per element:** a hit in two sizes. Luna writes one impact phrase per element ("of cold, an icy shatter on impact,
  like a frozen coolant shell breaking against steel, close"); the game puts "One short punchy impact" or "One heavy
  crushing impact" in front.
- **Per creature family:** a death, from the creature of its cry, physically described again.
- **Per place:** an ambience of two or three continuous layers ("of a low hearth fire, gentle kettle simmer and faint
  wind around snug wooden doors"), which the game frames with "A steady continuous ambience" and "no sudden sounds, no
  voices, no music". Luna is told to leave out bird calls, bells, voices and footsteps, which would repeat on every
  loop. Small SFX makes 30 seconds, looped by crossfade. Only the first two places of each world are made in the study.
- **Per boss:** the boss-beaten stinger, using the boss loop's instruments and the cue mood "a short triumphant phrase
  of a battle won, ending on a strong held chord". It needs nothing new from Luna.

Fallbacks and the game's own theme are made once for the whole game, not by Luna, so they are not in this stage.

**One flaw fixed before making anything.** Luna's first answer wrote paired sounds as "of the same oak map case
closing" and deaths as "from the same squat mining machine". Each sound is made on its own, so the generator cannot
know what "the same" refers to. The instructions now say every sound names its source in full and never writes "the
same", "it" or "again"; the second answer had none. The two calls cost about $0.008.

## Stage 4 checks and pages

GPU time was about 4 minutes. Only the sounds new in stage 4 were made, two takes each.

| Takes | Count | Quiet | Late | Clipped |
|---|---|---|---|---|
| Small SFX (shared sounds, hits, deaths) | 332 | 11 | 42 | 0 |
| Medium (quest failed) | 10 | 0 | 0 | 0 |
| Ambience (first two places) | 20 | 1 | 6 | 0 |
| Music (first boss beaten) | 10 | 0 | 0 | 0 |

- **The "silent" takes are soft sounds, not empty ones.** The eleven Small SFX takes under -45 LUFS are taking an item
  (six of the ten), the timer's tick in Vesper, and single panel and "my turn" takes, with peaks of -23 to -34 dBFS.
  The game-ready step levels them like the rest. The one quiet ambience, Thimblebrook's second place (take 2, about
  -49 LUFS), is the exception: raising it to the ambience level also raises its noise, so it should be listened for.
- **Late starts** are mostly soft sounds that swell in (taking and putting an item, panels, a hero falling, deaths).
  For a game they would be trimmed to the first sound, which the game-ready step does not do yet.
- **One game-ready file could not be decoded by ffmpeg** (Thimblebrook's panel closing, take 1), though soundfile reads
  it: a rare disagreement between libsndfile's FLAC encoder and ffmpeg's decoder. Re-encoding it with ffmpeg fixed it.
  The real pipeline should encode its final files with ffmpeg (or in the format the game ships), not libsndfile.

- Page 22, `study-22-shared-sounds.html`: the rest of the shared sounds.
- Page 23, `study-23-hits-and-deaths.html`: each element's normal and heavy hit, then each family's death.
- Page 24, `study-24-ambience-and-victory.html`: two place ambiences per world, looped three times round, and the
  first boss's victory stinger.

## Stage 4 verdicts and a second try at three sounds (2026-11-05)

From page 22: the harmful status sounded like ripping (Luna had made it from paper sliding, a servo scraping, a valve
hissing), the helpful status like a positive interface tone rather than a spell, and a hero falling too hard, "like
a rock hitting a cloth". The boss-beaten stinger is made by Medium, as all music is.

The three were rewritten as follows, and Luna wrote their materials again (`stage5/`, about $0.004):
- **Harmful status:** "A quick dark spell effect of a curse taking hold, a low wavering magical swell that sinks
  down". Its source hint asks for a magical sound, "not a physical object tearing, scraping or breaking": a low hum,
  a dark breathy swell or a detuned drone ("like a cold draught wavering through a root cellar").
- **Helpful status:** "A quick spell effect of a blessing taking hold, a warm glowing magical swell", made from "a
  soft airy swell, a warm hum or a gentle sparkle of energy", "not a chime, bell or ding". It is no longer marked
  tonal, since the tonal rule sends Luna to bells and chimes.
- **A hero falls:** "A soft heavy thud of a body slumping to the ground", from "a body and its clothes" on the
  world's ground, "never rocks, metal or hard objects striking" ("of a person in office clothes slumping onto
  carpet, close and muffled").

Page 25 (`study-25-status-and-fall.html`, from `stage5/retry.json`) puts two wordings of the game's part beside each
other, with the same material from Luna: _a is the wording above, and _b is "A short ominous magical drone of a curse
taking hold, fading out", "A short soft magical whoosh of energy wrapping around someone, warm and gentle" and "A
short muffled collapse of a body falling, cloth rustling and a soft thud". 60 takes, none clipped; 28 start a little
late, as swells do.

## Page 25 verdicts, the boss-beaten stinger dropped, and the helpful status again (2026-11-05)

- **Harmful status:** wording A won ("a low wavering magical swell that sinks down"). It is what the instructions
  already say.
- **A hero falls:** the two wordings sounded much alike; A is preferred and already in the instructions.
- **Helpful status:** neither worked. A sounded like "a bell urinating" and B like "a pixie sliding".
- **The boss-beaten stinger is dropped** from the plan and from Luna's script. The takes did not sound good; even if
  they did, a separately made stinger would not match the boss loop, and it is too much on top of the fight's own
  end. The boss loop now fades out under the killing blow.

Page 26 (`study-26-helpful-status.html`, from `stage5/helpful.json`) tries the helpful status built like the spells,
which have worked from the start, four takes each:
- c: "A quick spell burst of protection, a soft rising whoosh of air with a gentle magical shimmer", then Luna's
  material for each world;
- d: the same with no material from Luna, one sound for every world;
- e: "A soft rising magical whoosh with a gentle sparkle, a protective spell, light and airy", also with no material.

If d or e wins, the helpful status becomes one of the few sounds made once for the whole game rather than per world.

The author chose c: the helpful status is now "A quick spell burst of protection, a soft rising whoosh of air with a
gentle magical shimmer", with each world's material from Luna.

# In the game

The final instructions are the game's own now: `packages/server/src/sound/prompts.ts` (docs/sound.md, "Prompts").
The study's script that wrote stages 2 to 5 (`packages/server/src/cli/_exp/soundprompts.ts`) is gone; the prompt
files it wrote stay in `stage2/` to `stage5/` as the record of what was heard.
