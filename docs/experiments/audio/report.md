# Audio bake-off: can open models make Daydream's sound effects and music?

> **Kept as a record.** This is the write-up of a finished study. Its scripts, prompt files and listening pages were removed for the 1.0 release and are in
> git history at the tag `pre-1.0-experiments`, as are the other studies it cites that are no longer in
> `docs/experiments/` or `docs/baselines/`. Paths that begin with `<study data>` or `<tools>` were on the author's own
> machine and are in neither.

Date: 2026-11-04. Machine: the GPU PC (RTX 4090 Laptop, 16 GB). OpenAI spend: none; every prompt was written by hand
and no model call went through the gateway.

## The answer

**Yes for both.** Daydream should generate its audio at build time rather than fall back to a library of pre-made
sounds.

- **Sound effects: Stable Audio 3 Small SFX** (Stability AI, May 2026). It was the best of the five models tested by
  ear (the author's listening) and by measurement. Its silent parts are clean (no hiss), it covers the full 20 kHz band
  in 44.1 kHz stereo, and it rarely clips. Prompts steer it clearly towards a world's materials. It makes a clip in
  about 0.8 seconds on 2 GB of VRAM. The author preferred it to the larger Stable Audio 3 Medium because its sounds are
  less extreme, which suits interface clicks, steps and pickups that a player hears hundreds of times.
- **Music: Stable Audio 3 Medium**, chosen by the author's listening. Its music was the most pleasant, more complex
  and closer to the prompt than Small's. Small sounded better for a few cues that should stay understated, but it had
  some high-frequency noise and unpleasant fight loops. ACE-Step 1.5 was rejected: it has the harsh high-frequency
  noise common to AI music models, even though it is the only model that keeps the tempo and key it is given. Tempo
  matters less than this report first assumed: a track that sounds pleasant and fits the theme is good, and loops are
  cut at the tempo measured from the audio anyway. Stable Audio 3 for both sound effects and music keeps the whole
  audio stage on one model family, one licence and ComfyUI nodes that already exist.
- **A library is at most a last resort.** A neutral (theme-free) set of every game event, made once with the same
  model and checked by a person, could stand in for a sound whose takes all fail the checks, for example when every
  take comes out silent. Retaking with new seeds should come first; whether the fallback set is worth keeping is
  undecided.

What makes this work for any theme is not the model alone but three general rules around it: fixed events with
per-event loudness, several takes per sound with measurable checks, and post-processing that does not depend on what
the sound is (described below). Without them the raw output is not game-ready: loudness varies by 45 dB between
clips, sounds start up to 0.3 seconds late, and some takes are silent or clipped.

## What was tested

### Models

| Model | Kind | Size | Licence and attribution | Verdict |
|---|---|---|---|---|
| Stable Audio 3 Small SFX | sound effects | ~1 B (2.3 GB file) | Stability AI Community License (see below) | **chosen for sound effects** |
| Stable Audio 3 Medium | sound effects and music | 1.4 B (9.2 GB file) | same | **chosen for music**; second for sound effects (more extreme sounds, clips more) |
| Woosh Flow and DFlow (Sony AI) | sound effects | ~1.4 GB each plus encoders | weights CC BY-NC 4.0 (credit Sony AI, non-commercial); code MIT | rejected: dull (stops at 11 kHz), hiss, off-prompt or game-unfit sounds, silent takes, 5 s maximum |
| MOSS-SoundEffect v2.0 (OpenMOSS) | sound effects | 1.3 B DiT plus a large Qwen3 text encoder | Apache 2.0 (keep the licence and notices) | rejected: worst by ear and by judge; mono; faint short sounds; 20-55 s a clip on the whole card |
| ACE-Step 1.5 turbo and XL turbo | music | 2 B and 4 B | MIT (keep the copyright notice) | rejected: harsh high-frequency noise |
| Stable Audio 3 Small Music | music | ~1 B (2.3 GB file) | Stability AI Community License | close second; high-frequency noise in fight loops |

Considered and not tested: Xiaomi's MiDashengLM-Gen (Apache 2.0, August 2026) makes 16 kHz mono audio, too low for
game sound. HeartMuLa (Apache 2.0) and YuE are song models built around lyrics, and this game wants instrumental cues.
No newer open sound-effect model than these appeared in searches up to November 2026.

**Stable Audio 3's licence**, which binds the chosen model: free for research, non-commercial use and organisations
under US $1M a year in revenue; generated audio belongs to the user. Anyone distributing the game (and so the model,
or a product that uses it) must ship a copy of the licence, keep a Notice file saying *"This Stability AI Model is
licensed under the Stability AI Community License, Copyright © Stability AI Ltd. All Rights Reserved"*, and show
"Powered by Stability AI" somewhere visible such as the about page or documentation. Its text encoder (T5Gemma) is
also under Google's Gemma Terms of Use, which ask for the same kind of notice. The weights are gated on Hugging Face;
the author accepted the terms on 2026-11-04. The files used are Comfy-Org's ComfyUI packaging of the same weights.

### Sounds and themes

Twenty sounds covering what the game has: interface (click, confirm, error, opening the pack), level up, quest
complete, fire, cold, lightning and healing spells, melee hit, miss and block, a creature's cry and death, footsteps on
soft and hard ground, picking up loot and gold, and a looping town ambience. Each was asked for three times: with no
theme (the control) and in two of the author's real worlds, **The Lantern of Thimblebrook** (a cosy woodland village of
mice and frost frogs) and **The Last Light of Kestrel Belt** (a grim mining belt of rusted machines). Prompts are in
`sfx-prompts.json`, two takes each.

Six music cues in four worlds (the two above plus **The Warm Below**, a melancholic sinking kingdom, and
**Bellwether**, an absurd office comedy): entering a place (10 s), quest accepted (4 s), quest complete (6 s), boss
beaten (8 s), defeat (6 s), and a boss fight loop of exactly 32 bars at its tempo (58-64 s). Prompts are in
`music-prompts.json`.

## Findings: sound effects

Measured over 120 clips per model (60 for MOSS):

| Model | Silent parts (median) | Clips that clip | Near-silent takes | Judge: steering (chance 33%) | Judge: family (chance 50%) |
|---|---|---|---|---|---|
| Stable Audio 3 Small SFX | -91 dBFS | 1 | 7 | 54% | 61% |
| Stable Audio 3 Medium | -88 dBFS | 12 | 0 | 61% | 69% |
| Woosh DFlow | -70 dBFS | 19 | 25 | 68% | 70% |
| Woosh Flow | -71 dBFS | 42 | 13 | 68% | 69% |
| MOSS-SoundEffect v2 | -89 dBFS | 7 | several | 60% | 53% |

The judge is LAION-CLAP, a text-audio matching model that none of the candidates use. "Steering" asks whether a clip
matches its own world's prompt better than the other worlds' prompts for the same sound; "family" asks whether, across
all sounds, a clip is closer to its own world's one-line palette than the other world's. **The judge is not a quality
measure.** It rated Woosh highest on meaning, while by ear Woosh was clearly worse: dull, hissy and often not a sound
a game could use. The judge is good for one thing here: showing that the theme really does steer every model, well
above chance. It should not pick takes.

Other findings:
- **Theme steering is real and audible.** The Kestrel melee hit is a ringing metallic clang; the Thimblebrook one is a
  short woody knock; the Thimblebrook level-up is little bells, the Kestrel one a power surge.
- **Prompt following is good but not perfect.** A "two-note" confirm can come out as one tone; a "single" hit
  sometimes as two. This is why several takes per sound and simple checks are needed.
- **Raw clips are not game-ready.** Loudness ranged from -56 to -10 LUFS; sounds started up to 0.3 s late; one-second
  clips carry a faint noise burst in their last 0.15 s; four-second footstep requests stopped after 2.3-2.8 s.
- **Fixed templates against hand-written prompts.** One template per event with only short world slots (materials,
  element, creature, ground, place, coins) matched the sound as well as hand-written prompts but carried the world
  less (judge steering 42% against 54%, family 54% against 61%). The shared production words seem to make the worlds
  converge. Page 6 lets the author judge; the likely middle way is a template for the *shape* of each event (length,
  attack, "game sound effect") with a fuller, world-written description of its *material*.

## Findings: music

| Model | 60 s boss track | Short cue | VRAM | Holds tempo | Band | Silent takes | Judge steering (chance 25%) |
|---|---|---|---|---|---|---|---|
| ACE-Step 1.5 turbo | 8 s | 2.5 s | ~13-14 GB | exactly | 16 kHz | 2 of 48 | 46% |
| ACE-Step 1.5 XL turbo | 10 s | 3 s | ~14 GB | exactly | 16 kHz | 0 | 52% |
| Stable Audio 3 Small Music | 1.5 s | 1.1 s | ~2.4 GB | no (80 or 128 for 120) | 20 kHz | 0 | 69% |
| Stable Audio 3 Medium | 3.4 s | 1.3 s | ~5.5-7.6 GB | no (85-160 for 120-128) | 20 kHz | 0 | 60% |

- **Every model overshoots full scale.** Raw music clipped on a third to a half of the takes. Taking 6 dB off inside
  the ComfyUI graph before the file is written removes it completely; a build should always do this.
- **Loops work with a bar-grid rule.** All four write in clear 8-bar sections and end with an outro, so a loop is cut
  from inside the track: a whole number of 8-bar phrases (at least 16 bars, 30-48 s), starting on the bar whose seam
  matches best by rhythm and timbre, crossfaded over one beat. The bars before it become an intro played once. The
  tempo is measured from the audio and used when the model did not keep the one it was asked for; this matters for
  Stable Audio 3.
- **Noise and artefacts** cannot be measured reliably by code. By ear, ACE-Step has harsh high-frequency noise, Stable Audio 3 Small some in fight loops, and Stable Audio 3 Medium sounds the most pleasant.

## Post-processing rules (in `postprocess.py`)

These rules do not depend on what the sound is, which is what makes the method work for any world:
- **One-shots:** keep the main sound (the stretch around the loudest moment, ending at the first silence longer than
  0.25 s, or 1 s for music), 3 ms fade-in, short fade-out, level to the category's target, sample peaks under
  -1.5 dBFS. Short sounds are levelled by their loudest 100 ms (K-weighted, as LUFS is), because integrated loudness
  means little under 0.4 s; long ones by integrated LUFS.
- **Rhythmic sounds (footsteps):** split into single events at onsets at least 0.25 s apart; the game plays one per
  step, at random, never the same twice running. Cutting a loop on whole steps was considered and rejected as a
  special case.
- **Textures (ambience):** equal-power crossfade of the last 1.5 s into the start.
- **Music loops:** the bar-grid rule above.
- Current targets: interface -18, rewards -12, loot -15, spells -12, combat -11, creatures -12, footsteps -20 (short
  sounds, loudest 100 ms); ambience -28, music cues -18, music loops -20 (integrated LUFS). These should become a
  target per game event, and a transparent peak limiter would let the sharpest hits reach their target (they now stop
  up to 6 dB short).

## Time and cost on this computer

| Model | First load | Per clip | Per second of audio | Peak VRAM |
|---|---|---|---|---|
| Stable Audio 3 Small SFX | 4 s | 0.8 s | 0.33 s | 2.1 GB |
| Stable Audio 3 Medium (sound effects) | 4 s | 1.1 s | 0.46 s | 5.4 GB |
| Woosh DFlow / Flow | 8 s | 0.26 s / 3.9 s | 0.11 s / 1.6 s | 4.1 GB |
| MOSS-SoundEffect v2 (12 s window) | 14 s | 20-27 s | 11 s | 15.7 GB (the whole card) |
| ACE-Step 1.5 turbo | 5-9 s | 2.6 s | 0.16 s | 13-14 GB |
| ACE-Step 1.5 XL turbo | 5-18 s | 3.8 s | 0.24 s | 14.3 GB |
| Stable Audio 3 Small Music | 4 s | 1.2 s | 0.08 s | 2.4 GB |
| Stable Audio 3 Medium (music) | 6 s | 1.8 s | 0.12 s | 7.5 GB |

(ACE-Step's VRAM is what ComfyUI kept resident with its language model loaded; the authors report it can run in far
less with offloading.)

**A whole world:** roughly 83 sounds (20 generic events, about 16 for damage types, about 33 for creatures, about 6
grounds, about 8 place ambiences) and about 15 music cues. At four takes each, that is about 330 sound clips × 0.8 s
plus 60 music takes, **under ten minutes of GPU time per world**, against hours for its art. Choosing among takes and
post-processing take a few seconds on the CPU.

## How audio could fit into a world build later

This is a sketch only; another session is changing how worlds are built.

1. **A fixed event catalogue in shared code.** Each game event (ui_click, level_up, hit for each damage type, a
   creature family's cry, a place's footsteps and ambience, the music cues) has a category, length, loudness target,
   number of takes and loop kind, and a template for the shape of the sound.
2. **One Luna call per world** writes the audio palette and slot values from what the build already knows: the
   world's genre, tone and art style, its damage types, creature families and bosses, places and their ground, and the
   music style per world, per place mood and per boss. A few cents of Luna.
3. **GPU through the broker.** Stable Audio 3 runs on ComfyUI's own nodes, so the broker's existing ComfyUI adapter
   serves it with no new adapter. Each sound is a checkpointed step, like art, so a restart resumes.
4. **Checks and picking.** Each take is measured (silent, clipped, late start, wrong length, high noise floor) and the
   best passing take kept; for repeated sounds (steps, hits, pickups) 3-6 passing takes are kept as variants. If all
   fail, new seeds are tried; only then, if kept at all, a neutral fallback sound fills in.
5. **Post-processing and storage.** The rules above, then encoding for the web (Ogg Opus or MP3) into the world's
   assets, with an audio manifest listing each event's files and loudness.
6. **The client.** Web Audio with volume groups (interface, combat, world, music), brief ducking (a level-up lowers
   the ambience), random variant choice and a small random pitch change for repeated sounds, and music only at key
   moments (boss fights, entering a place, quest events) with crossfades.

## The author's verdicts (2026-11-04)

- Sound effects: Stable Audio 3 Small SFX over Medium (less extreme sounds for repeated use); Woosh and MOSS clearly
  worse.
- Music: Stable Audio 3 Medium over Small; ACE-Step rejected for high-frequency noise.
- Templates (page 6): the hand-written prompts (left) sounded somewhat better on average. The page showed only the
  template prompt, which made the comparison hard to follow; future pages should show each column's own prompt.
  Prompts need more tuning either way.

## Next steps

1. **Done: which sounds the game has.** `event-audit.md` lists every moment a player meets; `sound-plan.md` is the
   agreed plan of which get a sound effect, music or nothing, and which fall back when a world's takes fail.
2. **Learn how the models respond to prompts, then teach Luna to write them.** One call per world writes each
   sound's prompt from the world's data, so the instructions must be built on what the models actually respond to.
   For music, the instructions say which cues stay understated and which may be rich, so Stable Audio 3 Medium serves
   every cue. Every listening page shows each clip's own prompt.
3. **Fill the event gaps the plan needs** (combat start and end, quests, item take and put, statuses applied, dodge),
   each a typed event next to the toast that already exists.
4. **Hear the sounds in the game.** `main` already has a client sound module with a limiter and voices
   (`packages/client/src/sound.ts`); add volume groups, ducking, random variants and slight pitch changes to it, and
   play one world's sounds in a real adventure to judge loudness and repetition.
5. **Add a transparent peak limiter** to the post-processing, so very sharp hits reach their loudness target instead
   of stopping up to 6 dB short under the peak cap.
6. **Then the build stage**, as sketched above, once the build changes in other sessions settle. First check that the
   broker's ComfyUI adapter returns audio files, not only images.
7. **Ship the Stability notices:** the licence copy, the Notice file and "Powered by Stability AI" on the about page.

## Reproducing

Everything installed is in `<tools>\audio-bakeoff`: model files under `models\`; `venv-moss` (MOSS-SoundEffect v2
from github.com/OpenMOSS/MOSS-TTS), `woosh\.venv` (Woosh from github.com/SonyResearch/woosh-sfx, with its released
weights), `venv-tools` (numpy, scipy, soundfile, pyloudnorm, matplotlib) and the LAION-CLAP weights in the Hugging
Face cache. Stable Audio 3 and ACE-Step ran in a second, private ComfyUI on port 8189 using the existing install at
`<tools>\ComfyUI` with `extra_models.yaml`; nothing in the main ComfyUI's model folders changed. Samples are in
`samples\` (sound effects, raw), `samples-h6\` (music with headroom), `ready\` and `ready-music\` (game-ready), and
listening pages in `pages\`.

Scripts here: `comfy_run.py`, `woosh_run.py` and `moss_run.py` (generation, timing, VRAM), `analyze.py`
(measurements and spectrograms), `postprocess.py` (game-ready rules), `clap_score.py` (the judge), `templates.py`
(template prompts) and `make_page.py` (listening pages).
