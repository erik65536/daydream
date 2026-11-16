# NPC voices: research and bake-off (November 2026)

> **Kept as a record.** This is the write-up of a finished study. Its samples, listening pages and scripts were removed for the 1.0 release and are in
> git history at the tag `pre-1.0-experiments`, as are the other studies it cites that are no longer in
> `docs/experiments/` or `docs/baselines/`. Paths that begin with `<study data>` or `<tools>` were on the author's own
> machine and are in neither.

This experiment asks how Daydream's people and creatures could speak aloud. Luna writes NPC lines live during play, so
most speech has to be made at play time, a second or so after each line is written. Voices, on the other hand, can be
chosen or designed once, when a world is built. The goal is a different voice for each character that fits their
description and stays the same across sessions, and that costs little and starts quickly.

The listening page, `index.html`, plays every sample side by side. The samples
and their measurements are in `samples/`.

## Summary

**Recommendation: design each character's voice once at build time, and speak every line at play time with VoxCPM2
on the GPU, falling back to Pocket TTS on the CPU whenever a world build holds the GPU.** (Revised after the GPU round;
the first round, CPU only, recommended Pocket TTS alone.)

- A world build already writes a persona for every character. It would add a one-sentence voice description. A
  voice-design model (Qwen3-TTS VoiceDesign, Apache 2.0) turns that description into a ten-second reference clip, the
  character's voice asset.
- During play, VoxCPM2 (OpenBMB, 2B, Apache 2.0) clones that clip for each new line, through the GPU broker. On this
  laptop's GPU, held at a third of its top clock by its 75°C limit, it started speaking after about **250 ms** and
  finished lines at **0.83 times real time**. By ear it has the best audio quality of the fast models with the fewest
  distortions, and the voiceprint check gave it the most distinct cast of any engine. Qwen3-TTS Base 0.6B is the
  close alternative: slightly more expressive, a little less clean.
- Through a lean runner of our own (`runner/`, plain PyTorch with CUDA graphs and FP8), the same GPU, measured
  after a minute of full load, starts speaking after **42 ms** at **0.16 times real time**, and speaks **twelve lines at once**
  at 0.37 times real time each (FP8 with 8 diffusion steps, which the author could not tell from bfloat16 with 10, and
  each voice's prompt prefix cached), over twice as fast as Nano-vLLM-VoxCPM, OpenBMB's batching engine, and without
  its flash-attn build. The reference test shows it computes the same model as VoxCPM2's own code.
- When a world build holds the GPU, Pocket TTS (Kyutai, about 100M parameters) clones the same clip instead. On this PC's CPU it
  started speaking after a median of **97 ms** and finished lines at **0.21 times real time** on **one thread**. It is
  free per line, works offline, and needs no GPU.
- In the speaker-recognition check, this pipeline gave the **most distinct cast of any engine tested** while keeping each
  character steady from line to line. OpenAI cannot give one voice per character: it has 10 to 13 preset voices, and
  its instructions change the delivery but not who is speaking.
- OpenAI's `gpt-4o-mini-tts` (about $1.10 per hour of speech) is the obvious cloud fallback, but it **shuts down on 6
  January 2027**. Its replacement, `gpt-realtime-2.1-mini`, costs about $1.60 per hour and is slower to start.

Judge the quality by ear on the listening page. I can measure speed, accuracy and how distinct the voices are, but not
how pleasant they sound.

## What exists now

### OpenAI

- **`gpt-4o-mini-tts`** is the speech endpoint the game would call today:
  - 13 preset voices: alloy, ash, ballad, coral, echo, fable, onyx, nova, sage, shimmer, verse, marin and cedar. OpenAI
    recommends marin and cedar.
  - An `instructions` field that steers accent, emotion, pace, tone and whispering.
  - It streams.
  - It costs $0.60 per million text tokens and $12 per million audio tokens. The bake-off measured **$1.10 per hour of
    speech, or $0.0024 per line**, with a median of 430 ms to first audio.
- **It is deprecated.** On 1 October 2026 OpenAI announced that `tts-1`, `tts-1-hd` and `gpt-4o-mini-tts` shut down on
  **6 January 2027**. The named replacement is `gpt-realtime-2.1-mini`:
  - The speech endpoint does not accept it. It runs over the Realtime API, a WebSocket.
  - It is a conversational model, so it has to be told to read the text verbatim. It did so for all 28 lines.
  - It has 10 voices; fable, nova and onyx are gone.
  - Audio output costs $20 per million tokens. The bake-off measured **$1.60 per hour of speech**, with a median of
    990 ms to first audio including the connection. A connection kept open would save part of that.
- **Custom voices do not solve one voice per character:**
  - A voice made from a text prompt (`POST /v1/audio/voices`, type `prompt`) is free and open to everyone, but it works
    only with GPT-Live, not with the speech or Realtime APIs.
  - A voice cloned from a recording does work with speech and Realtime, but it needs approval from OpenAI's sales team
    and a recorded consent statement from a real speaker. It is limited to 20 per organisation.

### ElevenLabs

This was not tested, at the author's request; the figures are from its published pricing.

- ElevenLabs is the quality benchmark and has the most complete toolset:
  - **Voice Design** (`eleven_ttv_v3`) makes a voice from a description.
  - The voice library has thousands of voices.
  - The new flagship, **Eleven v4**, covers 90+ languages and takes audio tags such as `[whispers]` and `[laughs]`.
- **API prices per 1,000 characters:**
  - v4, v3 and Multilingual v2: $0.08.
  - v4 Turbo, v3 Conversational and Flash: $0.04.
  - The fast models publish about 75 to 100 ms to first audio.
- **Plans:**
  - Free gives 10,000 characters a month; the commercial licence starts at Starter.
  - Paid plans are Starter $6, Creator $22, Pro $99 (600,000 credits), Scale $299 and Business $990 a month.
  - The number of saved custom voices depends on the plan.
- **Estimated cost.** At the bake-off's speaking rate of 13 characters a second, one hour of speech is about 47,500
  characters. That is **$3.80 per hour with v4, or $1.90 with Flash**, on top of the plan.

### Other cloud services

- **Inworld TTS-2**: about $10 per million characters at scale ($25 on demand), with instant cloning and text-based
  voice design included. It is aimed at game characters, and works out to about $0.50 per hour of speech.
- **Hume Octave 2**: about $7.60 per million characters, steered by plain-language emotion prompts.
- **Cartesia Sonic 3.6**: the fastest service, at about 40 ms to first audio, and top of the Artificial Analysis
  speech arena in late August. It is priced in credits, which works out to roughly $40 to $50 per million characters.

### Open-weight models

| Model | Size | Licence | Voices | CPU |
|---|---|---|---|---|
| Kokoro 82M | 82M | Apache 2.0 | 54 presets, no cloning | Yes |
| **Pocket TTS** (Kyutai) | ~100M | MIT code, CC-BY-4.0 weights (gated: accept terms) | Clones a 5 s clip; 20 presets | Built for it, streams |
| **Qwen3-TTS** 1.7B VoiceDesign / 0.6B Base | 1.7B / 0.6B | Apache 2.0 | Designs from a description / clones a 3 s clip | Slow (4× real time) |
| Ming-3.0-tts 0.5B (inclusionAI, last week) | 0.5B | MIT | Designs, clones, emotion, speed and pitch controls | Very slow (30× real time) |
| VoxCPM2 (OpenBMB) | 2B | Apache 2.0 | Designs and clones, 30 languages | Needs a GPU in practice |
| Kitten TTS 2 | 1.7B | Free under $1M revenue | 115 presets, cloning, 20 emotion tags | Yes, with a llama.cpp port |
| Supertonic 3 | 99M | OpenRAIL-M | Presets only | Yes, ONNX |
| Phonon 40M (Gradium, this week) | 40M | CC BY-NC (fine for a free game) | ~100 presets, no cloning | Phone-class |
| Fish Audio Drama 3 (October) | 35B MoE | Free under $500k revenue | Cloning, acting directions | No |
| Breeze TTS 2, Voxtral TTS, OmniVoice, Higgs v3, Fish S2 Pro | 0.6B to 5B | Non-commercial (fine for a free game) | Cloning; Breeze also designs | GPU models |

Two kinds of model matter for Daydream:

- Models that **design a voice from a description** turn the persona the build already writes into a voice. Examples
  are Qwen3 VoiceDesign, Ming, VoxCPM2 and ElevenLabs Voice Design.
- Models that **clone a short clip quickly** can then speak any new line in that voice. Examples are Pocket TTS, Qwen3
  Base and Ming.

Put together, a world build designs each character's voice once and keeps a reference clip, and play time clones it
for every line.

## The bake-off

### Cast and lines

Seven characters from four built worlds were chosen for range:

- Wrenna, an older mouse who keeps a tea shop.
- Pell Ansel, an elderly boatman.
- Juniper Wisp, a tiny wren. She stands in for a child, since no built world has one.
- Ysabet Vael, a queen.
- Graham Sleet, a corporate executive.
- Rootknock, a root-and-clay monster.
- H9 Foreman Unit, a mining robot.

Each says three shared lines (a greeting, a quest and a line of grief) and one line of their own. Bosses use their
real taunt. The voice descriptions, the presets picked for OpenAI and Kokoro, and the lines are in `cast.json`.

### Engines and method

| Engine | How a character gets a voice | Where |
|---|---|---|
| OpenAI `gpt-4o-mini-tts` | Best-fitting preset + voice description and delivery note as `instructions` | Cloud |
| OpenAI, one voice | Marin for everyone, steered only by `instructions` | Cloud |
| OpenAI `gpt-realtime-2.1-mini` | Preset + description, told to read verbatim | Cloud |
| Kokoro 82M | Preset | CPU |
| Qwen3-TTS VoiceDesign 1.7B | A voice designed from the description for every line | CPU |
| **Pocket TTS** | Clones the Qwen3-designed reference clip | CPU |
| Qwen3-TTS Base 0.6B | Clones the Qwen3-designed reference clip | CPU |
| Ming-3.0-tts 0.5B | Designs its own reference clip, then clones it (one character only; too slow) | CPU |

- All local runs were on this PC's CPU (an i9-13900H with 14 cores and 64 GB), with no GPU. Production will run here
  too.
- Times are from the request to the first audio and to the last.
- "Real time" is seconds of work per second of speech; below 1 means faster than speaking.
- Every sample was transcribed with `gpt-4o-mini-transcribe` to measure words heard correctly.
- A speaker-recognition model (CAM++, which ships with Ming) measured how alike two lines sound. "Between characters"
  is the mean similarity of lines from two different characters, and lower means a more distinct cast. "Same
  character" is the mean similarity of two lines from one character, and higher means a steadier voice.

### Results

| Engine | Per hour of speech | First audio (median) | Real time | Between characters | Same character |
|---|---|---|---|---|---|
| OpenAI `gpt-4o-mini-tts` | $1.10 | 430 ms | 0.18× | 0.67 | 0.88 |
| OpenAI, one voice | $1.12 | 478 ms | 0.21× | **0.87** | 0.85 |
| OpenAI `gpt-realtime-2.1-mini` | $1.60 | 993 ms | 0.23× | 0.60 | 0.86 |
| Kokoro 82M | free | 1,738 ms | 0.27× | 0.44 | 0.92 |
| Qwen3 VoiceDesign, every line | free | 32 s | 4.25× | 0.43 | **0.61** |
| **Pocket TTS + designed voice** | free | **97 ms** | **0.21×** (1 thread) | **0.46** | 0.86 |
| Qwen3 Base + designed voice | free | 27 s | 3.67× | 0.45 | 0.87 |
| Ming 0.5B (Wrenna only) | free | 156 s | ~30× | (one character) | 0.90 |
| ElevenLabs v4 (estimate) | $3.80 | ~100 ms | | | |
| ElevenLabs Flash (estimate) | $1.90 | ~75 ms | | | |

Every engine was clear: the speech recogniser heard at least 99.4% of the words correctly on every engine, and no
single line had more than 15% wrong. Word accuracy therefore does not separate them; listening and the voiceprints do.

**Many voices at once.** Pocket TTS runs one stream per CPU thread, so the CPU can speak several lines at the same
moment, each in its own worker process:

| Lines spoken at once | First audio (median / worst) | Real time (median) |
|---|---|---|
| 1 | 97 / 115 ms | 0.22× |
| 4 | 170 / 204 ms | 0.46× |
| 8 | 232 / 311 ms | 0.77× |
| 12 | 327 / 420 ms | 1.03× |
| 16 | 378 / 490 ms | 1.36× |
| 24 | 582 / 739 ms | 2.06× |

Up to about ten lines at the same moment keep up with playback. An NPC line lasts about seven seconds and is spoken
once for everyone who hears it, so this is far more than six-player groups need, even with world builds using some of
the CPU.

What the numbers say:

- **Instructions change delivery, not identity.** With one OpenAI voice for everyone, two different characters sound
  more alike (0.87) than two lines from the same character usually do. Giving each character its own OpenAI preset
  helps (0.67), but a world has 13 to 23 people and OpenAI has 10 to 13 voices, so they would repeat.
- **Design once, then clone.** Designing a fresh voice for every line gives a distinct cast, but the same character
  drifts from line to line (0.61). Cloning one designed reference clip keeps the cast just as distinct (0.45 to 0.46)
  and the voice steady (0.86 to 0.87).
- **Pocket TTS is the only local model fast enough for play time on a CPU.** It starts in about 100 ms, faster than
  OpenAI's 430 ms, and finishes a line in about a fifth of its length. Qwen3 and Ming are fine for build-time design
  but far too slow for live lines on a CPU.
- **Kokoro** is steady and distinct, but it has only 54 presets (about 20 in English) and cannot be designed or cloned.
  On this CPU it was also slower to start than Pocket TTS, because it speaks a whole line before returning any audio.
- **Creatures.** An effect applied after the speech (a pitch drop with an echo for the monster, a metallic ring for
  the robot) was tried and dropped: the ffmpeg filters lowered the quality, and the voices sound right on their own.

### Follow-up: Pocket TTS's small models, and a second look at the field

The author's verdict after listening was that Qwen3 has the most variety and expression, and that Pocket TTS cloning the
Qwen3-designed clip is noticeably lower in quality but still good, and unbeatable at speed. Ming was poor, and Kokoro
was slower and lower in quality. OpenAI was good but had less variety.

**Kyutai's small models.** In October 2026 Kyutai released smaller English Pocket TTS models: 18.2M, 6.9M and 1.9M
parameters, each also in a reward fine-tuned ("refl") version. They ship in the installed pocket-tts 4.0.1 (selected
with `language="english_18m_2026-10"` and similar), so they needed no new install. Each one cloned the same reference
clips, one thread each:

| Model | First audio (median) | Real time (median) | Words right | Between characters | Same character |
|---|---|---|---|---|---|
| Pocket TTS, 100M (the original run) | 97 ms | 0.21× | 99.8% | 0.46 | 0.86 |
| 18M | 49 ms | 0.14× | 99.7% | 0.48 | 0.88 |
| 18M, reward-tuned | 47 ms | 0.13× | 100% | 0.48 | 0.89 |
| 7M | 39 ms | 0.11× | 99.5% | 0.49 | 0.88 |
| 7M, reward-tuned | 38 ms | 0.11× | 99.8% | 0.50 | 0.89 |
| 2M | 24 ms | 0.11× | 99.2% | 0.54 | 0.87 |
| 2M, reward-tuned | 23 ms | 0.11× | 99.7% | 0.55 | 0.88 |

- The smaller models start sooner and stay steadier, but each step down also makes the cast slightly less distinct,
  because they copy less of what makes each reference clip unique. The 2M model is clearly the least distinct (0.54).
- Below 7M the real-time factor stops improving, at about 0.11. The part of the work that does not shrink, such as
  decoding the audio, takes most of the time from then on.
- The 18M reward-tuned model looks like the best trade on paper: half the startup time and two-thirds of the work of
  the original, with nearly the same distinctness. By ear, the author found it identical to the original in some clips
  but slightly distorted in others. It is worth using only if speech has to run on a smaller machine, such as the
  game server, instead of this PC (measured next).

**Pocket TTS on the game server.** The game server is a small machine: an Intel Core i3-7350K from 2017 with
2 cores, 4 threads and 14 GB, running Ubuntu Server. It got the same versions as this PC (torch 2.15.0 for the CPU,
pocket-tts 4.0.1, Python 3.12) in a throwaway folder, `~/tts-bake-off`, which also holds uv, its Python and a copy
of the Kyutai weights, about 3 GB in all. Nothing of the game's was touched, and the game was idle during the runs.
The scripts were `local.py` (every model, the whole cast, one thread) and `concurrency.py` (several voices speaking at
once, one process and one thread each). The numbers are in `samples/game-server.json`.

Speaking one voice at a time, the game server is as fast as this PC with the small models, and the original is about 40% slower:

| Model | First audio (median) | Real time (median) | This PC, for comparison |
|---|---|---|---|
| Pocket TTS, 100M | 120 ms | 0.29× | 97 ms, 0.21× |
| 18M | 50 ms | 0.13× | 49 ms, 0.14× |
| 18M, reward-tuned | 49 ms | 0.14× | 47 ms, 0.13× |
| 7M | 36 ms | 0.11× | 39 ms, 0.11× |
| 7M, reward-tuned | 37 ms | 0.11× | 38 ms, 0.11× |
| 2M | 21 ms | 0.09× | 24 ms, 0.11× |
| 2M, reward-tuned | 21 ms | 0.09× | 23 ms, 0.11× |

With several voices at once, the game server's four threads are the limit. A voice keeps up with playback while its real-time
factor stays below 1:

| Voices at once | 100M: first audio, real time | 18M | 7M |
|---|---|---|---|
| 1 | 129 ms, 0.30× | 52 ms, 0.13× | 38 ms, 0.12× |
| 2 | 229 ms, 0.50× | 89 ms, 0.22× | 62 ms, 0.18× |
| 3 | 308 ms, 0.73× | 112 ms, 0.30× | 81 ms, 0.24× |
| 4 | 362 ms, 0.99× | 144 ms, 0.37× | 111 ms, 0.32× |
| 6 | 595 ms, 1.46× | 244 ms, 0.56× | 156 ms, 0.47× |
| 8 | | 315 ms, 0.74× | 202 ms, 0.62× |

- The original 100M model keeps up with three voices at once on the game server; a fourth puts it at the edge. This PC managed
  about eleven.
- The 18M model keeps up with eight voices at once (0.74×, with first audio after about 300 ms), so it would serve
  a six-hero game on the game server with room to spare.
- These runs had the game server to themselves. In play the game server and the job worker share the same four threads, so
  real headroom is somewhat lower.

**The rest of the field (November 2026).** Four up-to-date benchmarks were read:
- the community [tts-bench](https://5uck1ess.github.io/tts-bench/mac-default/speed.html), which measures about 40
  open models on an Apple M4 CPU and GPU, with cloning similarity scores;
- [Picovoice's on-device benchmark](https://picovoice.ai/blog/on-device-tts/), updated in August 2026 and run on a
  Ryzen 7 CPU;
- a [CPU report from July 2026](https://github.com/gauravvij/kokoro-tts-vs-supertonic-3-tts) that compares Kokoro,
  Supertonic 3, Inflect-Nano and Pocket TTS;
- the [Artificial Analysis Speech Arena](https://artificialanalysis.ai/text-to-speech/leaderboard), which ranks
  models by blind human votes.

They agree that Pocket TTS is alone in its class. It is the only open model that clones a voice and runs several
times faster than real time on a CPU.

| Model | Clones? | CPU speed (tts-bench, M4) | Why it does not replace Pocket TTS |
|---|---|---|---|
| Piper, Kokoro, Kitten, Soprano, Supertonic 3, MeloTTS | No | 5× to 32× real time | Fixed preset voices only. Supertonic 3 (31 languages) keeps its voice builder closed. |
| Inflect-Nano (4.6M) | No | ~7× | One voice; output is capped at about 15 seconds. |
| NeuTTS Nano | Yes | 3.1×, 266 ms first audio, 5.8 GB of memory | Weaker cloning (similarity 0.34 against Pocket's 0.44) and 32% wrong words in tts-bench's cloning test. |
| NeuTTS Air | Yes | 2.2×, 6 GB | Slower and heavier, with similar cloning to Pocket. |
| StyleTTS 2 | Yes | 3.8×, 2.2 s first audio | Weak cloning (0.30), and it does not stream. |
| Chatterbox Turbo (350M, MIT) | Yes | 1.1×, 6.5 s first audio | Much better cloning (0.67), but barely real time on a CPU. It is a GPU model. |
| LuxTTS, MOSS-TTS-Nano | Yes | Not measured there | tts-bench could not install LuxTTS on Windows, but it installs fine with its own requirements file. MOSS-TTS-Nano is Apache 2.0. Both were tried here (see the next section). |
| Audio8 (0.6B, October 2026) | Yes | Not measured | Too large for a CPU. |

- The stronger open models in the Arena are GPU models: Fish Audio Drama 3, Breeze TTS 2, Ming-3.0 (the full model,
  not the 0.5B tried here) and Fish S2 Pro. They are many times slower than real time on a CPU.
- **No CPU model was rejected for its licence alone.** The CPU-capable cloners with non-commercial weights (XTTS-v2,
  OmniVoice, F5-TTS) take seconds to start a line or run slower than real time on a CPU, so they fail on speed anyway.
- **The real alternative is the GPU, not another CPU model.** Qwen3-TTS, the author's favourite, scores 0.75 on
  cloning similarity in tts-bench, against Pocket's 0.44, but runs at 0.24× real time on a CPU. Production runs on a
  PC with an RTX 4090, where Qwen3 is reported to stream its first audio in about 100 ms. Through the GPU broker,
  Qwen3 could clone at play time with its full quality, and Pocket TTS on the CPU would be the fallback while a world
  build holds the GPU. This has not been measured yet.

### LuxTTS and MOSS-TTS-Nano on the CPU

Both clone the same Qwen-designed reference clips, and both have Apache 2.0 licences. Their samples are on the
listening page. Another job was using every CPU core while they ran, so their timings are not yet comparable with the
others. A second MOSS-TTS-Nano run had a quiet CPU for its first twelve lines (Wrenna, Pell and Juniper): on one
thread it reached first audio in 520 to 990 ms (680 ms typically) and made speech at about 1.1 times real time, which
is slightly slower than playback, so a long line would stall unless it starts with a little buffer or gets a second
thread. Pocket TTS, on the same thread, takes about 100 ms and runs five times faster than playback. The CPU then got
busy again, and the rest of the run is not comparable.

| Model | Between characters | Same character | Notes |
|---|---|---|---|
| Pocket TTS 100M (for comparison) | 0.46 | 0.86 | |
| LuxTTS (ZipVoice distilled, 48 kHz) | 0.47 | 0.89 | Does not stream: a line plays only once all of it is made. |
| MOSS-TTS-Nano 100M (ONNX) | **0.41** | 0.83 | Streams. The most distinct cast of any cloner here, but the least steady. |

By ear (the author): LuxTTS is lower in quality, and without streaming its latency would be too high. MOSS-TTS-Nano is
interesting: not bad in quality and more expressive than Pocket TTS, but with distortion on some high-pitched speech,
worst on Juniper.

- **LuxTTS installs on Windows.** Its requirements file points pip at a page with Windows builds of piper_phonemize,
  so tts-bench's failure was most likely their own setup.
- **LuxTTS's default pace is wrong for a long reference clip.** It works out a line's length by stretching the
  reference clip and the new text together by its speed setting, and then cutting the clip's length back off. Its
  built-in speed-up of 1.3 times therefore shortened lines to about half their natural length with a ten-second clip.
  Asking for a speed of 1 / 1.3 keeps the pace of the reference clip, which is what these samples use.
- **MOSS-TTS-Nano** ran through its ONNX runtime without its text normaliser (WeTextProcessing), which the plain
  English lines here do not need.

### Candidates for a GPU test

Play-time speech on the production PC would go through the GPU broker, which frees ComfyUI's memory and runs only one
GPU model at a time on the machine. A speech model therefore gets the whole RTX 4090 Laptop GPU (16 GB) while it holds
it, but it waits whenever a world build has the GPU, and then Pocket TTS on the CPU speaks instead. Two things matter
for the choice: the model must fit in 16 GB, and it must stream, with a few hundred milliseconds to first audio at
most. Loading time also matters, because the broker swaps models in and out. Daydream is a free, open-source game, so
non-commercial licences are acceptable. These are the models worth testing, best first.

| Model | Size | Why test it | Licence | Notes |
|---|---|---|---|---|
| **Breeze TTS 2** (BreezeBlue) | 3B | Rank 13 in the Arena, the best open model that fits this card. It both **designs** voices from a description and clones them, takes "voice direction" for tone, emotion and pace, and supports tags such as (sigh). Its maker reports under 40 ms to first audio, streaming. | Research and non-commercial | About 7.7 GB in its normal mode, 14.4 GB in its fastest. Could replace Qwen3 for design as well as speak at play time. |
| **Qwen3-TTS Base 0.6B and 1.7B** (clone the designed clip) | 0.6B / 1.7B | The author's favourite for variety and expression, and the best cloning similarity in tts-bench (0.75). Qwen reports about 100 ms to first audio when streaming. | Apache 2.0 | Already installed. Its fast streaming path is vLLM-Omni, which on Windows may need WSL. |
| **Fish Audio S2 Pro** | 4.6B | Rank 40 in the Arena; first audio about 100 ms on an H200 and 360 ms on an RTX 5090 (community figure). | Research, non-commercial | About 10 GB at 16-bit, 5 GB at 8-bit. |
| **Higgs Audio v3** (Boson AI) | 4B | Rank 74 in the Arena; cloning with inline emotion and style control, 100+ languages. | Research and non-commercial | Served through SGLang-Omni. |
| **Chatterbox Turbo** (Resemble AI) | 350M | Good cloning (0.67), one-step decoder, reported under 200 ms; tags such as `[laugh]` and `[cough]`. About 4 GB of VRAM. | MIT | Small, so it should load quickly when the broker swaps it in. |
| **Fun-CosyVoice 3** (Alibaba) | 0.5B | Streams text in and audio out, reported 150 ms; takes spoken instructions for emotion and speed. | Apache 2.0 | Nine languages. |
| **OmniVoice** | not checked | Strong cloning in tts-bench (0.77) with few wrong words (4%); about 0.2 times real time on a GPU. | CC-BY-NC weights | Streams only a sentence at a time. |
| **Voxtral TTS** (Mistral) | 4B | Rank 48 in the Arena; about 90 ms to first audio (Mistral's figure). | CC-BY-NC | The open release may ship only preset voices without cloning, which would rule it out; to be checked. |
| **MOSS-TTS-Nano** on the GPU | 100M | Already installed; the author found it more expressive than Pocket TTS, with distortion on some high voices. Its ONNX runtime has a CUDA option. | Apache 2.0 | |
| **IndexTTS-2** (bilibili) | not checked | The highest cloning similarity in tts-bench (0.81), and emotion that can be set apart from the voice. | Bilibili model licence | Probably not streaming; may fit better at build time. |
| **VoxCPM2** | 2B | Few wrong words (2.3%) and solid cloning (0.53); also designs voices. | Apache 2.0 | |
| **Ming-3.0-tts tiny** (MoE, 7.9B total, 1.3B active) | 18 GB | Rank 24 in the Arena. | MIT | Too large for 16 GB unless quantised; the 0.5B version tested here was poor. |
| **Fish Audio Drama 3** | 35B MoE, 3B active | The best open model in the Arena (rank 6). | Fish Audio Community Licence | About 70 GB of weights at 16-bit, so far too large for this card even quantised. |

Not worth a GPU slot: LuxTTS (the author found it lower in quality, and it does not stream), F5-TTS and XTTS-v2 (older,
slower and weaker than the models above). Step-Audio-EditX (3B) edits emotion in finished speech rather than speaking
quickly, and might suit build-time work later.

### The GPU round

Eleven of those candidates were installed on this PC and spoke the same cast and lines, each cloning the same
Qwen-designed reference clip, so the difference heard is the speaker model alone. `gpu.py` runs them; each model has its
own Python environment under `<tools>\tts-bakeoff`. The GPU broker was skipped for these tests (with ComfyUI stopped),
so every model had the whole GPU. The samples are on the local listening page, `listen.html`, which has every engine of
both rounds and a pair of model pickers for comparing two at a time. Start it with the `voices` entry of
`.claude/launch.json`, or with `python -m http.server 8765` in this folder, and open `http://localhost:8765/listen.html`.

**How the timings were taken.** The full-cast runs happened while another job held most of the CPU, which also slows
GPU models, because they wait on the CPU between steps. The figures below come from a second pass with a quiet CPU:
each model spoke Wrenna's and H9's lines (eight lines) after a throwaway warm-up line, one model after another with no
rest, so the GPU was warm throughout. That is deliberately the worst case. This laptop's GPU has a target temperature of
75°C and a power limit of 105 W, so once warm it holds its clock at about 930 MHz, a third of its 3,105 MHz top speed.
A performance power mode would raise both limits and make every model faster. (While idle, the laptop GPU reports stale
sensor values, so only readings under load mean anything.)

| Model | First audio | Real time | Distinct / steady | Peak VRAM | Load | Verdict |
|---|---|---|---|---|---|---|
| MOSS-TTS-Nano 100M (ONNX on CUDA) | **100 ms** | **0.56×** | 0.40 / 0.85 | small | 6 s | Fastest by far; Pocket-like speed with MOSS's expressiveness (and its distortion on high voices). |
| VoxCPM2 2B | 250 ms | 0.83× | **0.38** / 0.87 | 5.7 GB | 29 s | The most distinct cast of any engine in either round, and steady. |
| Qwen3-TTS Base 1.7B (faster-qwen3-tts) | 360 ms | 0.78× | 0.44 / 0.83 | 4.5 GB | 10 s | Fast enough, and the author's favourite family. |
| Qwen3-TTS Base 0.6B (faster-qwen3-tts) | 430 ms | 0.80× | 0.45 / 0.85 | 2.6 GB | 9 s | No faster than 1.7B: its time goes on driving each step from Python, not on the model's size. |
| OmniVoice | 1.9 s (whole line) | 0.33× | 0.44 / 0.90 | 4.5 GB | 6 s | Fast, but it does not stream, so a player waits for the whole line. Borderline. |
| IndexTTS-2 (fp16) | 10 s (whole line) | 1.7× | 0.42 / 0.90 | 6.8 GB | 25 s | Ruled out for play time: too slow to start. Could still speak fixed lines at build time. |
| Fish Audio S2 Pro | 28 s* | 4.2×* | 0.44 / 0.88 | 19 GB | 68 s* | Ruled out: it needs more than the card's 16 GB, so Windows spills into system memory. |
| Breeze TTS 2 | 1.3 s* | 17 to 20×* | — | 7.7 GB | 17 s* | Ruled out: far slower than real time. Its maker reports 3× faster than real time on an H100, so its fast path may not be working on Windows; not investigated further. |
| Chatterbox Turbo | 12.8 s* | 2.1×* | 0.43 / 0.90 | 3.0 GB | 174 s* | Ruled out by ear (quality). |
| Fun-CosyVoice 3 0.5B | 8.7 s* | 1.4×* | 0.42 / 0.90 | 3.4 GB | 28 s* | Ruled out by ear (quality). |

\* From the full-cast run on a busy CPU; these models were ruled out before the quiet pass. Load times are with the
weights already in the system's file cache; a first load from disk takes longer. "Distinct / steady" is the CAM++
voiceprint measure from the first round: how alike two different characters sound (lower is more distinct), then how
alike two lines of one character sound (higher is steadier). For comparison, Pocket TTS on the CPU scored 0.46 / 0.86
and Qwen3 VoiceDesign 0.43 / 0.61.

Not tested: Higgs Audio v3 and Voxtral TTS are served only through SGLang-Omni or vLLM, which need Linux (WSL on this
PC), and Voxtral's open weights ship preset voices without cloning.

**Setting up on Windows.** Every survivor installs with pip, but a few details cost time:
- faster-qwen3-tts needs `transformers==5.15.1`; the newest transformers (5.22) breaks the Qwen3 tokenizer.
- VoxCPM2 compiles with torch.compile, which on Windows needs `triton-windows` (3.7 for torch 2.11).
- MOSS-TTS-Nano on CUDA needs `onnxruntime-gpu` 1.23.2, the last build for CUDA 12 (1.31 wants CUDA 13), with torch
  imported first so its CUDA libraries load. torchaudio 2.11 reads audio only through torchcodec, so `gpu.py` reads the
  reference clips with soundfile instead.
- Windows Defender scanning every unpacked file made the installs, and the first loads, several times slower.

**By ear (the author):**
- **VoxCPM2** makes better-quality audio than Qwen3, with fewer distortions. Qwen3 slightly edges it on expressiveness,
  but VoxCPM2 is better overall.
- **Qwen3 Base 0.6B** sounds better than 1.7B, oddly.
- **OmniVoice** is no better than Qwen3, perhaps slightly worse, and does not stream: out.
- **MOSS-TTS-Nano on the GPU** has some bad distortions: out on quality, despite being the fastest.
- **Chatterbox Turbo** and **Fun-CosyVoice 3** are out on quality.

### VoxCPM2 designing the voices and taking delivery notes

VoxCPM2 can do more than clone. It takes a style instruction in brackets at the start of the text, such as
"(Pleasantly surprised, a little teasing.)", and with no reference clip, the same brackets holding a voice description
design a new voice. Two more runs tested both, each changing one thing:

| Run | How each line is spoken | First audio | Real time | Distinct / steady |
|---|---|---|---|---|
| VoxCPM2 (as above) | The Qwen-designed clip and its transcript continue into the line; no delivery note | 370 ms | 0.96× | **0.38** / **0.87** |
| VoxCPM2 + delivery notes | The Qwen-designed clip sets only the timbre; the line's delivery note goes in as a style instruction | 150 ms | 0.78× | 0.44 / 0.76 |
| VoxCPM2, its own designed voices | VoxCPM2 designs each clip from the `voice` description, then speaks as in the run above | 170 ms | 0.84× | 0.43 / 0.82 |
| VoxCPM2, its own designed voices, no notes | VoxCPM2's own clips, continued into each line as in the first row | 420 ms | 1.0× | 0.44 / **0.89** |

These timings come from full-cast runs on a warm GPU with a mostly quiet CPU. Designing one ten-second clip took 7 to
11 seconds, so a world's cast would be designed in minutes.

The delivery notes cannot be used with continuation, which copies the clip's own delivery, so that run switches to
timbre-only cloning. Its voiceprints are less steady and less distinct. Some of that is the point (a line delivered in
grief should sound different from a greeting), and some may be the voice drifting; only listening can tell which.
VoxCPM2's own designed voices are about as distinct as Qwen3's (0.43 against 0.43), with Graham and Rootknock its
closest pair.

By ear (the author): the delivery notes are great when they work, adding much more emotion and expressiveness, but about
one or two lines in ten change the voice significantly or come out far too intense. Qwen3 is the clear winner at designing voices:
VoxCPM2 made some acceptable ones, but Juniper's was terrible and it made no deep voices, as Qwen3 did. So the pipeline
keeps Qwen3 VoiceDesign at build time and VoxCPM2 for speaking.

Ways to tame the over-intense lines, as weighed with the author:
- A voiceprint guard (compare each spoken line with the character's clip, and speak it again without the note if it
  drifts) would catch voice changes, but it is not worth the complexity, nor the delay when a line fails.
- Milder notes from Luna would not fix every case, and would leave some scenes with too little emotion.
- Gentler guidance, a lower `cfg_value`, is the safer fix if it works. Two more runs repeated the delivery notes at
  guidance 1.6 and 1.3 (against 2.0):

  | Guidance | First audio | Real time | Distinct / steady |
  |---|---|---|---|
  | 2.0 | 150 ms | 0.78× | 0.44 / 0.76 |
  | 1.6 | 200 ms | 0.83× | 0.45 / 0.73 |
  | 1.3 | 190 ms | 0.82× | 0.47 / 0.71 |

  Lower guidance made the voices slightly less steady and less distinct, because guidance sets how closely VoxCPM2
  follows everything it is given, the reference voice included, not only the note. The voiceprint measures who is
  speaking, not how intense a line is, so whether the over-intense lines calm down is for the ear. VoxCPM2 samples
  randomly, so judge the rate of bad lines across the cast rather than any single line.

  Decision (the author): keep VoxCPM2's default guidance (2.0) for now. Lower guidance may return later, perhaps as a
  player preference.

### VoxCPM2 speaking several lines at once

In multiplayer, several players can talk to different characters at the same moment. The question was whether
VoxCPM2 on the GPU can speak several lines at once, or whether they should be queued. `voxcpm_concurrency.py` starts
N voices together, each a different character speaking the three shared lines, on the warm laptop GPU held at its
thermal limit (about 930 MHz). The numbers are in `samples/gpu-concurrency.json`.

| How | Voices at once | First audio (median) | Real time (median) |
|---|---|---|---|
| One process | 1 | 195 ms | 0.72× |
| Two processes, one model each | 2 | 731 ms | 2.68× |
| Threads sharing one model | 2 to 4 | not usable | not usable |

- **Threads do not work.** VoxCPM2's own code keeps each line's state inside the model, so two voices sharing one
  model trample each other. With three or four threads some voices failed outright (a tensor size mismatch, then a
  CUDA assert), so even the runs that finished cannot be trusted.
- **Separate processes make it worse, not better.** Each holds its own 5.5 GB copy of the model, so two is the most
  that fits in 16 GB. Two voices at once each ran at 2.7 times real time, almost four times slower than one alone,
  because they fight over a GPU that is already at its power and heat limit.
- **So with VoxCPM2's own code, queue the lines:** one at a time on the GPU, with Pocket TTS on the game server taking whatever
  waits too long.

**A batched engine would change that.** OpenBMB publishes [Nano-vLLM-VoxCPM](https://pypi.org/project/nano-vllm-voxcpm/)
(version 2.0.5), an inference engine for VoxCPM2 that batches many requests through one copy of the model, with a
paged cache so each line keeps its own state. Its README reports, on a desktop RTX 4090:

| Voices at once | First audio (median) | Real time per voice |
|---|---|---|
| 1 | 36 ms | 0.09× |
| 8 | 44 ms | 0.11× |
| 16 | 57 ms | 0.16× |
| 32 | 77 ms | 0.25× |

That is several times faster than VoxCPM2's own code even for a single voice, and eight voices cost little more
than one. A desktop card is faster than this throttled laptop one, so the real figures here would be higher, but
probably still far below 1×. [vLLM-Omni](https://voxcpm.readthedocs.io/en/latest/deployment/vllm_omni.html) is the
heavier official route, for Linux only.

**Nano-vLLM-VoxCPM on this PC.** It runs, after some setup:
- It needs flash-attn, which has no official Windows build. flash-attn 2.8.3 was built from Dao-AILab's official
  source, for Ampere kernels only (which the RTX 4090 Laptop runs). The build took about 45 minutes.
- CUDA 12.8 accepts compilers up to Visual Studio 2022. With Visual Studio 2026's compiler (MSVC 14.51), CUDA's front
  end crashed on every file, so the author added the VS 2022 build tools (v143, MSVC 14.44) beside it.
- On Windows it wants triton-windows below 3.5, so torch 2.8. It has its own environment, `.venv-nanovllm`, beside
  VoxCPM2's own on torch 2.11. The built wheel is kept in `<tools>/tts-bakeoff/wheels`.
- `nanovllm.py` speaks the whole cast (engine `voxcpm2-nanovllm` on the listening page) and then several voices at
  once, cloning the clips exactly as VoxCPM2's own code did. The engine takes 85% of the GPU's memory and fills the
  rest of it with its cache.

The voices are the same: the voiceprints give the same distinctness as plain VoxCPM2 (0.376 for both) and nearly the
same steadiness (0.861 against 0.874).

| Voices at once | First audio (median) | Real time per voice (median) | VoxCPM2's own code |
|---|---|---|---|
| 1 | 141 ms | 0.74× | 195 ms, 0.72× |
| 2 | 243 ms | 0.77× | 731 ms, 2.68× (two processes) |
| 4 | 282 ms | 0.82× | |
| 8 | 456 ms | 1.03× | |
| 12 | 383 ms | 0.99× | |

- **One voice is no faster.** On this laptop the GPU sat at 930 MHz and about 47 W for the whole run, held there by
  its thermal limit. A single voice is bound by that, so the desktop card's 0.09× does not carry over.
- **Extra voices come almost free.** Four voices at once each keep up with playback (0.82×), and twelve at once
  still produce about twelve seconds of speech per second of work, roughly nine times what VoxCPM2's own code
  manages on the same GPU. Four to six voices at once is a safe limit for this laptop; beyond that each voice falls
  slightly behind playback.
- Load takes about 27 s and warm-up 4 s, as with VoxCPM2's own code.

**CUDA graphs back on.** On Windows, Nano-vLLM-VoxCPM switches off its CUDA graphs and torch.compile
(`model_runner.py` forces eager mode and disables dynamo when `sys.platform == "win32"`), and the runs above were
made that way. CUDA graphs record the GPU work of one decoding step once and replay it, which removes Python's and
the kernel launches' overhead from every step. For this test the installed package was patched so that two
environment variables keep them: `NANOVLLM_WIN_GRAPHS=1` keeps the CUDA graphs and `NANOVLLM_WIN_COMPILE=1` keeps
torch.compile. Without them it behaves as shipped, and the original file is kept as
`<tools>/tts-bakeoff/model_runner.orig.py`. The runs are under `nanovllm-graphs` and `nanovllm-graphs-compile` in
`samples/gpu-concurrency.json`.

| Voices at once | Eager (as shipped) | CUDA graphs | CUDA graphs and torch.compile |
|---|---|---|---|
| 1 | 141 ms, 0.74× | 72 ms, 0.20× | 68 ms, 0.20× |
| 2 | 243 ms, 0.77× | 98 ms, 0.23× | 102 ms, 0.23× |
| 4 | 282 ms, 0.82× | 104 ms, 0.26× | 101 ms, 0.26× |
| 8 | 456 ms, 1.03× | 129 ms, 0.35× | 139 ms, 0.35× |
| 12 | 383 ms, 0.99× | 204 ms, 0.52× | 177 ms, 0.53× |

Each cell is the median time to first audio and the median real-time factor per voice.

- **CUDA graphs make it three to four times faster** at every count, on the same throttled laptop GPU. So eager
  mode, not the heat limit, was what held a single voice at 0.74×: it was bound by launching thousands of small
  kernels from Python, not by the GPU's arithmetic. Twelve voices at once now each keep up with playback.
- **The voices are unchanged.** The whole cast spoken with CUDA graphs on (engine `voxcpm2-nanovllm-graphs` on the
  listening page) gives distinctness 0.375 and steadiness 0.876, against 0.376 and 0.874 for VoxCPM2's own code.
  Spoken one line at a time, the cast had a median first audio of 82 ms and a median of 0.26× real time, against
  157 ms and 0.85× without the graphs.
- **torch.compile adds nothing** on top of the graphs. On Windows it also needed a workaround: PyTorch 2.8's own
  kernel launcher fails with "Python int too large to convert to C long" (a C `long` is 32 bits on Windows), so it ran
  with `TORCHINDUCTOR_USE_STATIC_CUDA_LAUNCHER=0`, which uses Triton's launcher instead. Since it gains nothing, it is
  best left off; that also means Triton barely matters on Windows.
- Capturing the graphs adds about 5 s to the load, which is now about 32 s.
- Nothing went wrong in these runs, but the engine's authors switched the graphs off on Windows for a reason they do
  not state, so a longer soak test (hours of mixed line lengths) should come before relying on it.

So with Nano-vLLM-VoxCPM, the GPU can speak a whole party's lines at once instead of queueing them, and Pocket TTS
on the game server is needed only while a build holds the GPU.

### A lean VoxCPM2 runner of our own

Nano-vLLM-VoxCPM speaks a dozen lines at once, but on Windows it ties play-time speech to torch 2.8, a flash-attn
built from source (45 minutes, with Visual Studio 2022's compiler beside 2026's) and a patch to its model runner.
`runner/` replaces it with a runner of our own: VoxCPM2 only, in plain PyTorch, on the latest stable releases
(Python 3.14, torch 2.15 with CUDA 13.4, in `<tools>/tts-bakeoff/.venv-runner`), with nothing built from source.
It needs `torch`, `numpy`, `safetensors`, `soundfile`, `soxr` and `tokenizers`.

**How every number here was measured.** This laptop GPU throttles under sustained load: within a minute its core
clock falls from about 1,455 to 930 MHz and its memory clock from 9,001 to 6,001 MHz, with the driver's thermal
slowdown flag set. Speaking one line is limited by how fast the weights can be read from memory, so it slows by about
a third. Earlier comparisons in this report mixed cool and hot runs without knowing it. From here on, every
benchmark first runs a minute of full load, then measures in that throttled steady state, which is also where a busy
game session lives; each result records the clocks it ran at (930 and 6,001 MHz for all of the tables below). A
single line after a quiet spell runs at full clocks for its first second or two, so a lone character's first audio
is in practice somewhat better than these figures.

#### Where Nano-vLLM's time goes

`runner/profile_nanovllm.py` drove the patched engine (CUDA graphs on) in-process under PyTorch's profiler, for one,
four and twelve lines speaking at once (`runner/profile-nanovllm.json`). One step makes one audio token, 160 ms of
speech, for every line.

| Lines at once | Time per step | GPU busy in it | Real-time factor |
|---|---|---|---|
| 1 | 33.1 ms | 26.2 ms | 0.21× |
| 4 | 38.4 ms | 31.9 ms | 0.24× |
| 12 | 69.3 ms | 58.4 ms | 0.43× |

So the GPU's own work is most of each step, and the rest (6 to 11 ms) is Python between steps, including the
AudioVAE, which Nano-vLLM decodes outside its graphs with a Python loop per line and layer. A second run with the
graphs off split the GPU's kernel time between the parts of the model:

| Part | 1 line | 12 lines |
|---|---|---|
| Local diffusion: 10 steps with guidance (9 passes of a 12-layer transformer, each over twice the batch) | 59% | 66% |
| Base language model (28 layers) | 21% | 13% |
| AudioVAE decoder | 7% | 14% |
| Residual language model (8 layers) | 6% | 4% |
| Feature encoder (12 layers, turns each new latent patch into the language models' input) | 6% | 3% |
| Stop head | under 0.1% | under 0.1% |

The diffusion is the bulk at every batch size; with more lines, the AudioVAE's share grows.

#### The design

`runner/runner.py` is about 950 lines:
- **Fixed slots.** Sixteen slots, each holding one line, with a static key/value cache allocated once for the longest
  line allowed (1,024 positions, about 100 seconds of prompt and speech; 0.6 GB for all sixteen). No paged cache.
  When a line finishes, the last busy slot moves into its place, so the busy slots are always the first ones.
- **One CUDA graph per batch size** (1, 2, 4, 8, 12 and 16), each making one audio token for every busy slot
  entirely on the GPU: the diffusion with guidance, the stop head, the AudioVAE decoding the new chunk, the feature
  encoder and both language models. Positions and noise are indexed on the GPU, so a step needs no input from the
  CPU and one copy back (each line's 160 ms of audio and its stop flag).
- **The AudioVAE runs beside the language models** on a second stream inside the graph, since both need only the new
  latent patch. Its causal convolutions carry each slot's left context as static state, so each step decodes one
  patch per line; the decoder runs in float16 (55 dB or more below float32's audio, and 40% faster).
- **Attention through `scaled_dot_product_attention` alone.** For the language models' attention over the cache,
  the eight query heads that share a key/value head attend as a group, as if they were eight positions, so
  grouped-query attention needs no copies of the cache; cuDNN's kernel is a little faster there than the
  memory-efficient one. The unmasked attention (diffusion, encoder, prefill) keeps PyTorch's choice, flash attention,
  which torch 2.15 now ships on Windows. Varlen attention and FlexAttention were not needed.
- **Fewer, larger kernels, with the same maths.** q/k/v and gate/up are each one matrix; RMSNorm is PyTorch's fused
  kernel; the rotary embedding is one complex multiply on queries and keys together (each head's query and key rows
  are reordered at load so that the pairs it rotates sit side by side, which leaves the attention scores unchanged).
  The diffusion's timestep embeddings depend only on the step, so they are computed once at load.
- **The voice is prepared once.** A character's reference clip is encoded to latents and run through the feature
  encoder when the voice is loaded, not in every line's prefill, which takes the prefill from 56 to 35 ms in
  bfloat16. Every line's prompt also starts with the same positions for one voice, the reference clip and its
  transcript (96 of a typical 188), and both language models are causal, so those positions' keys and values never
  depend on the line: they are computed once per voice and copied into the line's slot, and the prefill runs only
  the rest (below). It runs from a CUDA graph for that rest's length (padded at the end, which causal attention
  ignores).
- **FP8, with 8 diffusion steps, by default.** The four transformers' matrices in FP8: weights with one scale per matrix (which gives the same
  2.65% error as one scale per row, the format's own rounding, because VoxCPM2 has no outlier rows), and activations
  cast with fixed scales calibrated from the cast's lines (`bench.py calibrate`, `runner/fp8-amax.json`). Each scale
  is folded into the weight before it, so every conversion is one saturating cast. The author heard no difference
  between FP8 with 8 diffusion steps and bfloat16 with VoxCPM2's 10, so that, the fastest setting, is the default
  (`RUNNER_FP8=0` and `RUNNER_STEPS=10` in the benchmarks give the other).
- **A silence stop.** Once in a while the stop head never fires and the model makes near-digital silence until
  VoxCPM2's length cap (ten seconds of it in one test). VoxCPM2's own code has no rule for this: it caps each line at
  six audio tokens per text token plus ten, and its retry for over-long lines is switched off when streaming; Nano-
  vLLM caps lines at 320 s. The runner ends a line after three seconds of silence once it has spoken. Real pauses are
  just as silent and last up to 1.4 s in the cast's lines, so only their length tells them apart.
- **Streaming** per line through a callback for each 160 ms chunk; a single process with a plain request loop
  (`runner.add(line)`, `runner.step()`); weights loaded straight to the GPU; clone mode as in `nanovllm.py`.

#### Reference test: the same model as VoxCPM2's own code

`runner/reference.py` records VoxCPM2's own code (voxcpm 2.0.3, without torch.compile) speaking four lines, keeping
every input, the noise it draws at each step and each step's tensors; `runner/test_reference.py` compares the runner
with that recording (`runner/reference-test*.json`).

- **Inputs are identical.** The same tokens and masks; resampling the clip with `soxr` gives exactly the samples
  `librosa` gives; the runner's own AudioVAE encoder gives the same latents to within 0.04% (convolutions run in
  TF32 by default on both sides).
- **Each step's maths matches.** Fed the reference's own latent at every step (teacher forcing), so that each step's
  difference is that step's alone: with both sides in float32, the base language model's output differs by a median
  of 0.01%, the diffusion's by 0.04%, and the feature encoder's not at all. In bfloat16 every tensor differs by about
  1%, which is the format's rounding through 28 layers. All the stop decisions agree in both (180 in bfloat16, 187 in float32).
- **The step loop matches.** Running freely through the real CUDA graphs in float32, with the reference's noise
  replayed, the runner tracks VoxCPM2's own run to within a few percent for 37 of the line's 48 steps, and both end
  at step 48. In bfloat16 the two part ways after 3 to 13 steps: generation is sampled, and rounding sends each run
  down its own path, just as Nano-vLLM's runs differ from VoxCPM2's.
- **FP8 moves each step about 5% instead of 1%,** and every stop decision still agrees.

**Voiceprints and likeness.** The whole cast spoken by each engine, one take per line (`samples/voiceprint.json`),
with "likeness" the mean voiceprint similarity between each line and the clip it cloned (`runner/likeness.json`):

| Engine | Steadiness (same character) | Distinctness (lower is better) | Likeness to the clip |
|---|---|---|---|
| VoxCPM2's own code | 0.874 | 0.376 | 0.866 |
| Nano-vLLM | 0.861 | 0.376 | 0.858 |
| Nano-vLLM, CUDA graphs | 0.876 | 0.375 | 0.872 |
| Runner, bfloat16 | 0.864 | 0.376 | 0.863 |
| Runner, FP8 | 0.877 | 0.382 | 0.868 |
| Runner, bfloat16, 8 diffusion steps | 0.864 | 0.364 | 0.858 |
| Runner, FP8, 8 diffusion steps | 0.850 | 0.369 | 0.856 |

The two Nano-vLLM rows are the same maths, so about 0.015 is what sampling alone moves these numbers.

**By ear, and several takes.** The author heard only small differences between the engines: Juniper's bad-news line
breaking and sounding slightly robotic through the runner, Ysabet differing most, and no clear winner between FP8
and bfloat16. One take per line cannot separate an engine from the model's randomness, so `runner/takes.py` speaks
the same lines with many seeds through each engine (`takes.html` plays them side by side) and
`runner/expressiveness.py` measures each take's pitch range, loudness movement and length. On Juniper's bad-news
line, VoxCPM2's own code first looked more expressive: over six and then 18 takes its pitch moved over a median of
11.5 semitones against the runner's 9.5. The runner in float32, with VoxCPM2's own rounding and attention kernel, or
with VoxCPM2's exact noise did not close the gap, so 36 more takes each settled it: over 54 takes the medians are 9.9
and 9.8 semitones, and a permutation test puts the difference at p = 0.21. The first 18 takes of VoxCPM2 had simply
been expressive ones. On the other lines the spreads overlapped from the start.

#### The numbers against Nano-vLLM

Heat-soaked, at 930 MHz and 6,001 MHz (`samples/gpu-concurrency.json`); each cell is the median first audio and the
median real-time factor per line, with each voice speaking the three shared lines in turn as in `nanovllm.py voices`:

| Lines at once | Nano-vLLM, CUDA graphs | Runner, first version | Runner, bfloat16 | Runner, FP8 | Runner, FP8, 8 steps |
|---|---|---|---|---|---|
| 1 | 114 ms, 0.32× | 121 ms, 0.34× | 73 ms, 0.24× | 41 ms, 0.16× | 44 ms, 0.16× |
| 2 | | | 85 ms, 0.30× | 55 ms, 0.20× | |
| 4 | 210 ms, 0.44× | 207 ms, 0.47× | 127 ms, 0.35× | 71 ms, 0.23× | 56 ms, 0.21× |
| 8 | | | 138 ms, 0.45× | 90 ms, 0.32× | |
| 12 | 266 ms, 0.85× | 250 ms, 0.84× | 170 ms, 0.67× | 105–207 ms, 0.43× | 82 ms, 0.40× |

The 72 ms and 0.20× measured for Nano-vLLM earlier came from a cooler GPU; under the same throttling it is the 114 ms
and 0.32× above. With FP8, twelve lines at once each take under half their own length to make, so twelve players
could hear twelve characters at once with room to spare. The median first audio at twelve lines varies between runs
(105 to 207 ms) because the benchmark's lines start in bursts and their prefills queue; the worst case stays under
300 ms.

| | Nano-vLLM, CUDA graphs | Runner, bfloat16 | Runner, FP8 |
|---|---|---|---|
| Start-up (load and warm-up) | 35 s | 7 to 8 s, of which 2.5 s capturing 12 graphs | 8 s |
| GPU memory | 85% of 16 GB (it fills the rest with cache) | 8.8 GB | 6.6 GB |
| Environment | torch 2.8, flash-attn from source, a patch | torch 2.15 from PyPI | the same |

#### Each voice's prefix, cached

`runner/cache_test.py` compares a line's prefill using its voice's cached prefix with the whole prompt's prefill,
for every character and the three shared lines (`runner/cache-test.json`). In float32 the two give the same states
and cache entries (a median difference of 0.0001%, at most 0.04%), so the cache changes no maths. In bfloat16 they
differ by up to 3.6%: the prefix computed on its own rounds differently from the same positions inside a longer
prompt, and the quantizer before the language model's output (VoxCPM2's FSQ) turns a few of those differences into
whole steps. That is rounding of the same size as bfloat16's against VoxCPM2's own code: rerun with the cache, the
reference test's teacher-forced errors stay at a median of about 1% per step for all four lines, and all 180 stop
decisions still agree.

Hot (930 and 6,001 MHz), with FP8 and 8 diffusion steps:

| | Whole prompt | Cached prefix |
|---|---|---|
| One line's prefill (188 positions, 96 of them cached), bfloat16 | 38.7 ms | 27.1 ms |
| The same, FP8 | 21.6 ms | 15.9 ms |
| First audio, one line (median) | 47 ms | 42 ms |
| First audio, four lines starting together (median, slowest) | 73, 123 ms | 49, 95 ms |
| First audio, twelve lines starting together (median, slowest) | 97, 322 ms | 89, 244 ms |

The real-time factor per line is unchanged (0.16×, 0.20× and 0.37× at one, four and twelve lines). Bursts gain most,
since each new line waits behind the prefills before it.

A cached voice holds 3.9 MB of GPU memory, and building one (encoding its clip, then its prefix) takes about
190 ms. A game with hundreds of characters should not keep them all, so `Voices` in `runner.py` holds voices up to a
memory budget (512 MB, over a hundred voices, by default), drops the least recently used one beyond it, and rebuilds a
dropped voice from its clip when it is next asked for. A line keeps its own voice while it speaks, whatever the store
drops. A voice coming back after being dropped costs its first line about 190 ms more, so a service would ask for the
voices of the characters near the players before they speak.

#### What did not help

- **torch.compile** (Inductor, with triton-windows in the runner's environment), with the CUDA graphs still captured
  around the compiled code: a few percent faster for one line, clearly slower for twelve (0.84× against 0.71× in
  bfloat16), and one to eight minutes of compiling at start-up. Once the graphs remove the launch overhead there is
  little left to fuse, and Inductor's choices for the large multiplies are worse than cuBLAS's. Dropped, as for
  Nano-vLLM.
- **Other attention kernels:** cuDNN for the unmasked attention, or the memory-efficient kernel everywhere, were each
  slower than the mix above. cuBLASLt instead of cuBLAS made no difference, and PyTorch cannot switch on Windows.
- **Graphing the prefill on its own** saved only 2 of 56 ms: the prefill is limited by arithmetic, not by launching
  kernels. Removing the feature encoder from it (above) is what helped.
- **Batching the prefills of lines that arrive together** was not built. With each voice's prefix cached, a line's
  prefill is 92 positions and 16 ms in FP8, so a burst of twelve waits at most about 250 ms; batching would shorten
  that further, but a line's text from the language model takes far longer to arrive.

#### Soak test

The FP8 runner (`bench.py soak 65` with `RUNNER_FP8=1`) spoke random lines for 64 logged minutes on the hot GPU: the
cast's lines, single sentences cut from them and runs of three lines joined, for every voice, arriving in bursts of
1 to 16 whenever the slots ran below a randomly chosen level. That keeps the runner busier than a game would: at
74 ms a step for 160 ms of audio per slot, the speech rate below means about fourteen lines at once on average. The log is `runner/soak-runner-fp8.json`.

- **Work done:** 14,027 lines and 32.7 hours of speech in 64 minutes, about 219 lines and 30 minutes of speech every
  minute, with no errors.
- **No drift:** the mean step stayed between 73.7 and 75.1 ms from the first minute to the last, the median real-time
  factor per line was 0.47 in every minute, and the median first audio stayed between 106 and 130 ms (the slowest
  single line in any minute waited 262 ms, behind a burst of prefills).
- **No leak:** PyTorch's allocated memory (3.41 GB), its reserved memory (4.97 GB) and the GPU's used memory
  (6.62 GB) were identical in every minute.
- **Runaways:** none of the 14,027 lines hit the length cap or needed the silence rule. An earlier attempt with the
  same seed did meet one: in its sixth minute a line ran into silence and the three-second rule ended it, which is
  how the soak found a bug in its own logging (the flag was a NumPy boolean that the JSON writer refused). That
  attempt's five completed minutes matched the numbers above.

#### Files and commands

- `runner/runner.py`: the runner. `runner/bench.py`: `voices 1 2 4 8 12`, `samples`, `soak <minutes>` and
  `calibrate`, with `RUNNER_FP8=0` for bfloat16, `RUNNER_STEPS=10` for VoxCPM2's own diffusion steps,
  `RUNNER_CACHE=0` to prefill whole prompts and `RUNNER_HEAT=<seconds>`. `runner/cache_test.py`: the prefix cache.
- `runner/reference.py` (in `.venv-voxcpm`) and `runner/test_reference.py`: the reference test, with
  `REF_DTYPE=float32` for the float32 comparison and `RUNNER_FP8=1` for FP8.
- `runner/profile_nanovllm.py` (in `.venv-nanovllm`) and `runner/profile_runner.py`: the profiles.
- `runner/takes.py`, `runner/expressiveness.py`, `runner/likeness.py` and `takes.html`: several takes per engine and
  their measures.
- The samples are on the listening page as "VoxCPM2 via our runner", with FP8 and 8-step variants.

**Still open.** The batched prefill, if bursts of lines ever need to start faster. VoiceDesign now has a runner of
its own in the same environment; see the next section.

### Qwen3-TTS VoiceDesign beside the VoxCPM2 runner

A world build designs each character's reference voice with Qwen3-TTS VoiceDesign 1.7B: from a written description of
how someone sounds, the model reads a short text in that voice, and the clip becomes the voice VoxCPM2 clones for every
line in play. The question here was whether VoiceDesign can live in the VoxCPM2 runner's Python environment and
service, so that Daydream needs one environment and one GPU service for speech instead of two, while never staying
loaded next to the play-time runner.

Speed alone would not have justified any work. A world has a few dozen characters, a build takes hours of GPU, and
even VoiceDesign's own code on the GPU designs a voice in a few seconds. What matters is the environment it needs,
and what a cheap batch makes possible: designing several candidates per character and keeping the best.

#### Its own code does not fit the runner's environment

- `qwen-tts` 0.1.1 pins `transformers==4.57.3`. Its transformers-5 fork, `qwen-tts-hf`, installs into
  `.venv-runner` with the newest transformers (5.22.1), but then the model fails to load: its speech tokenizer's
  encoder assigns to an attribute that transformers 5.22 made read-only. That is the same break the GPU round met with
  faster-qwen3-tts. The version that works, 5.15.1, needs `huggingface_hub` below 2.0 and `tokenizers` at most 0.23.0,
  both older than the runner's.
- The package also pulls in gradio, librosa (with scipy, numba and scikit-learn), onnxruntime, torchaudio and sox:
  about 60 packages for a step that runs once per character. torchaudio's last release (2.11) was built for an older
  torch than the runner's 2.15. Only the package's unused 25 Hz tokenizer needs the last three, but the package
  imports that tokenizer at the top.
- After this trial, `.venv-runner` was put back to exactly its earlier 31 packages. The official code still runs in
  `.venv-fastqwen` (torch 2.11, transformers 5.15.1), which serves here as the reference and the baseline.

#### A lean runner of our own

`runner/designer.py` (about 500 lines) does what `Qwen3TTSModel.generate_voice_design` does in its default mode. It
needs nothing beyond the VoxCPM2 runner's packages (torch, numpy, safetensors and tokenizers). The model has three
parts:
- **The talker:** a 28-layer Qwen3 language model. It reads the description and the text, then makes the first of
  16 codebooks for each 80 ms frame of audio.
- **The code predictor:** a 5-layer transformer that runs 15 times per frame, once for each remaining codebook.
- **The 12 Hz codec's decoder:** turns the frames into 24 kHz audio.

The runner is built like the VoxCPM2 one:
- **Fixed slots.** It has 32 slots, each designing one voice. Each slot has a static key/value cache for 553
  positions: a prompt of up to 192 tokens, plus up to 360 frames (29 s, a cap that no clip has reached). When a voice
  finishes, the next waiting voice takes its slot, and the busy slots are always the first ones.
- **One CUDA graph per batch size** (1, 2, 4, 8, 12, 16, 24 and 32). Each graph makes one frame for every busy slot
  entirely on the GPU:
  - the code predictor's 15 passes, at positions that are the same for every slot;
  - the frame's embedding;
  - the talker's step;
  - sampling the next frame's first codebook, with the original's repetition penalty (1.05), the control tokens
    suppressed, and the stop held back until two frames exist.

  Sampling (temperature 0.9, top 50) draws with Gumbel noise, so it runs inside the graph.
- **An eager prefill** for each new voice, written straight into its slot.
- **Decoding** of each finished voice's codes, four voices at a time. The voices are padded at the end, which a
  causal decoder ignores. The decoder runs in float32, which is more exact than the original's bfloat16.
- **Tokenizer.** It builds Qwen2's tokenizer from the model's own `vocab.json` and `merges.txt`.
- **`close()`** drops the weights, cache and graphs. Measured after it, PyTorch holds no GPU memory at all; the
  process keeps 0.3 GB, which is CUDA's own.

**Reference test.** `runner/design_reference.py record` records the original speaking two of the cast's voices: the
prompt's tokens, the codes it sampled, every logit of its talker and code predictor for the first 48 frames, and the
decoded audio. `runner/test_design.py` feeds the same codes through our runner and compares
(`runner/design-test*.json`):

| Both sides in | Talker logits | Code predictor logits | Decoder audio |
|---|---|---|---|
| float32 | within 0.005% of their range, the same top code every frame | within 0.005%, the same top code every time | 65 dB SNR |
| bfloat16 (as used) | KL 0.0005, the same top code every frame | KL 0.002, the same top code 95% of the time | 31.6 and 36.5 dB SNR (ours in float32, theirs in bfloat16) |

So the maths is identical. The bfloat16 differences are rounding, as small as the sampling distributions are wide.

#### The numbers

The runner is heat-soaked, as described above, at 930 MHz SM and 6,001 MHz memory. The original never loads the
GPU enough to throttle: it is limited by Python and its clocks stayed at 1,230 and 7,001 MHz. Both measurements use
the cast's seven descriptions, repeated to reach N, each reading the 10-second reference text (`runner/design.json`).

| Voices at once | Ours: total | Ours: per voice | Original: total | Original: per voice |
|---|---|---|---|---|
| 1 | 3.4 s | 3.4 s | 17.2 s | 17.2 s |
| 7 (a small world) | 6.5 s | 0.93 s | 31.4 s | 4.5 s |
| 14 | 7.9 s | 0.56 s | 35.1 s | 2.5 s |
| 28 | 12.2 s | 0.43 s | 84.3 s | 3.0 s |
| 64 (through 32 slots) | 23.7 s | 0.37 s | | |

- **Speed.** One voice makes a frame in 30 ms, which is 2.7 times faster than real time. Batched, it is 9 times
  faster per voice than one at a time, and 4.5 to 7 times faster than the original's best batch.
- **Decoding** is a third of the time in large batches. It could run in bfloat16, but nothing here needs that.
- **Load time.** Both load in about 4.5 s with the weights in the file cache. Our 4.4 s includes 1.3 s capturing
  the graphs.
- **Memory.** Our runner holds 6.4 GB with 32 slots (3.8 GB of weights and 2 GB of cache) and peaks at 9 GB while
  decoding. The original peaked at 12.5 GB for 28 voices.

#### Best of several candidates

Because a batch is cheap, a build can design several candidates for each character and keep the ones that make the
cast most distinct. `runner/candidates.py` designed four candidates for each of the seven characters in one batch
(28 voices in 11 s). It then compared their voiceprints with the CAM++ speaker model that `voiceprint.py` uses
(`runner/candidates.json`; similarity is cosine, so lower means more distinct):

- One character's four candidates are far apart: 0.66 similar to each other, where two different characters average
  0.47. The description fixes the kind of voice, not the voice itself.
- Taking the first candidate of each character gives a cast whose two most alike characters are at 0.74 (Pell and
  Rootknock), and whose mean is 0.47.
- Choosing greedily (each character's candidate least like the others' choices, repeated until nothing changes)
  brings the closest pair to 0.61 (Graham and Rootknock) and the mean to 0.43. The best of all 2,401 possible casts
  reaches 0.58.

The candidates are in `samples/qwen-design-candidates/<character>-<k>.mp3`. The greedy choice was Wrenna 3, Pell 2,
Juniper 3, Ysabet 0, Graham 3, Rootknock 0 and H9 0.

**By ear, distinctness is the wrong rule.** The author listened to all 28 candidates (1 November 2026):
- All of them sounded distinct from the other characters, and none had a quality problem (no garbled words, cut-offs
  or long silences).
- What separates the candidates is how well each one fits its description:

| Character | Greedy choice | The author's choice | Why |
|---|---|---|---|
| Wrenna | 3 | 3 or 1 (tied) | The description asks for both old and bright, which is hard |
| Pell | 2 | 0 or 1 | 2 does not sound very old, or hoarse enough |
| Juniper | 3 | 0 or 1 | They sound like a real child; 3 is inhumanly high even for a child |
| Ysabet | 0 | 1 | 1 is regal and commanding; 0 is acceptable but too flat |
| Graham | 3 | 2 or 3 | |
| Rootknock | 0 | 3 (0 is not bad) | 3 is deep and wise |
| H9 | 0 | 0 | The most robotic |

The greedy choice matched the author's in three cases out of seven, and missed clearly in two (Pell and Juniper).
Pushing each voice away from the others pushed it towards an extreme: a child too high to be human, an old man too
young to sound old. Taking each character's first candidate would have done at least as well. The author would have
chosen it for Pell, Juniper and H9, and found it acceptable for Ysabet and Rootknock.

So a build should design one voice per character and keep it. Distinctness can stay as a guard: redesign a voice only
when two characters' voiceprints are too close. Choosing among several candidates is only worth doing with a judge
of how well each one fits its description, such as an audio-capable model listening to the clip beside the text
(untested, and it would cost a little per voice). The speaker model for such a guard would have to live in the
runner's environment. CAM++ needs onnxruntime, but Qwen3-TTS Base, already downloaded, has its own speaker encoder
(an ECAPA-TDNN in plain PyTorch weights) that could be ported in the same way; that is untested.

#### Recommendation: one environment, one service

Merge them.
- **Environment.** `.venv-runner` and one Python process serve all speech on the GPU, holding one model at a time.
- **Build jobs.** A build's voice step asks the service to design a world's voices. The service closes the VoxCPM2
  runner (8 s to start again), loads the designer (4.4 s), designs every character's candidates in one batch
  (seconds), and closes the designer.
- **Players during builds** already get Pocket TTS, because the broker runs one GPU task at a time.
- **Memory.** The designer must never stay loaded beside the play-time runner. Its 9 GB peak and the runner's 6.6 GB
  do not fit together on the 16 GB card, let alone with anything else.

**The trade-off.** Daydream now owns about 500 lines that copy Qwen's model. A new release of the model would need
porting, and the reference test is what keeps the copy honest. In return:
- the official package's 60 dependencies and its transformers version pins go away (those pins have broken twice in
  this report);
- designs are 5 to 45 times faster;
- the speed would make several candidates per character cheap, if a judge of fit is ever added.

Further speed work (profiling, FP8, a faster decoder) is not worth doing: a world of 20 characters designs in under
10 seconds.

**Files and commands.**
- `runner/designer.py`: the runner.
- `runner/design.py`: `time 1 7 14 28 32 64`, `samples` and `unload`, with `DESIGN_SLOTS` and `DESIGN_HEAT`; run it
  in `.venv-runner`.
- `runner/design_reference.py`: `time` and `record` with the original, with `REF_DTYPE=float32`; run it in
  `.venv-fastqwen`.
- `runner/test_design.py`: the reference test, with `REF_DTYPE=float32`.
- `runner/candidates.py`: `design 4` in `.venv-runner`, then `score <campplus.onnx>` in `.venv`.

## Recommendation and how it fits the game

### At build time

1. The build writes a `voice` for every speaking character and creature family. It already writes a `voice` field for
   NPCs, but today that is a copy of the personality. The new text describes how the character sounds: age, pitch,
   pace, accent and texture, as in `cast.json`.
2. A voice-design step makes a ten-second reference clip for each voice. Qwen3 VoiceDesign took 40 to 110 s per clip on
   this CPU. On the GPU, our runner designs a whole world's voices in one batch, in under half a second each, in the
   same environment and service as the VoxCPM2 runner (see "Qwen3-TTS VoiceDesign beside the VoxCPM2 runner"). It
   keeps the first voice designed for each character: by ear, choosing the most distinct of several candidates picked
   worse voices than that. The clip is saved as a world asset
   (`assets/voices/<npcId>.wav`).
   - A check step could transcribe the clip and compare its voiceprint with the others in the world. It would redo
     clips that are garbled or too close to another character's, the way the art pipeline checks images.
3. Fixed lines (greetings, barks, boss taunts, quest summaries) can be spoken once at build time and saved, so they
   play instantly.

### At play time

1. When an NPC replies, the server shows the text right away, as it does now. It speaks each sentence as soon as the
   model has written it, rather than waiting for the whole reply, which hides most of the wait for the text.
2. Each reply is spoken by whichever engine can start soonest (the author's plan of 1 November 2026):
   - VoxCPM2 on the GPU, through the broker, cloning the character's reference clip. VoxCPM2 takes about 30 s to load
     (with its weights in the file cache), so the broker keeps it loaded between lines while no build needs the GPU.
     The broker runs one GPU task at a time, so during a world build players get Pocket TTS until the build is done.
     With VoxCPM2's own code, lines wait in a queue for the GPU. Through our own runner (`runner/`, see "A lean
     VoxCPM2 runner of our own"), a dozen lines can be spoken at the same time, each in under half its own length,
     on the throttled laptop GPU.
   - Pocket TTS on the game server's CPU when the GPU is busy, switched off or offline: the 100M model for up to two lines at
     once, and the 18M model for up to four when more are waiting. Beyond four, lines queue.
   - Every sentence of one reply goes to the same engine, so the sound does not change mid-reply. Between replies it
     may change; the author found VoxCPM2 and Pocket TTS close, like one voice through a better and a cheaper
     microphone.
   - Pocket TTS's voice state takes about 1 s to load once per character and is then kept in memory.
3. A line that has not started within about 10 seconds is dropped, and a subtle mark shows that the character could
   not be voiced. The line the player is waiting on goes ahead of anything prepared in advance, and skipping or
   leaving cancels it at once, which frees its slot.
4. An administrator switch turns GPU speech on or off for the whole game, next to an automatic check that the broker
   answers.
5. The audio streams to every player in earshot over the game's existing connection, as small Opus or PCM chunks. In
   multiplayer, one NPC line is spoken once and the same stream goes to everyone, so cost and CPU do not grow with
   the number of listeners, and a second listener does not wait for the clip to finish.
6. A cache on disk, per world and capped in size, keyed by voice, engine, guidance, text and delivery note, plays
   repeated lines without speaking them again.
7. Skipping or closing the dialogue stops the audio. Text stays on screen, so speech is never required to play.
8. Every clip is brought to the same loudness, so characters and engines match, and a per-player setting sets the
   volume, turns voices off, or limits them to main characters.

### Fallbacks and costs

- Pocket TTS needs one CPU thread per line being spoken. On the game server (four threads) the 100M model keeps up with three
  lines at once and the 18M model with eight; on this PC about ten of the 100M model keep up (see "Pocket TTS on
  the game server").
- If the server is busy, or for languages Pocket TTS does not cover (English, French, German, Spanish, Portuguese,
  Italian and Dutch), the game could fall back to OpenAI's speech model. It would pick the preset closest to the
  description, until that model shuts down in January 2027.
- **Spend:** this experiment cost about $0.34 of OpenAI: $0.27 for speech and $0.07 for transcription.

### Licences

- **Pocket TTS** weights are CC-BY-4.0, which needs a credit line in the game. The cloning weights are gated behind
  Kyutai's terms, which forbid cloning a real person's voice without consent. Designed voices are not real people.
- **VoxCPM2** and **Qwen3-TTS** are Apache 2.0, **Kokoro** Apache 2.0 and **Ming** MIT.
- Daydream is a free, open-source game, so non-commercial licences (Breeze TTS 2, Higgs Audio v3, Voxtral, OmniVoice,
  Fish Audio, F5-TTS, XTTS-v2) are acceptable. What still matters is attribution, gated downloads that each installation
  must accept, and any ban on hosting the model as a service for other people.

### Open questions

- Our runner replaces Nano-vLLM-VoxCPM and its torch 2.8, flash-attn and patch with plain torch 2.15, and is faster
  at every batch size. Whether its FP8 and 8-step settings sound as good is for the author's ears.
- Whether an audio-capable model can judge how well a designed voice fits its description, well enough to choose
  among candidates (the author's choices in "Best of several candidates" would be its test).
- How fast VoxCPM2 runs with the laptop in a performance power mode.
- Invented names (Rootknock, Ysabet and every generated place) were not tested for pronunciation; set aside for now.

- Quality by ear: the author should listen, especially to Juniper, Rootknock and H9 on Pocket TTS.
- Whether Pocket TTS can take delivery cues. It has no instruction input. Emotion comes from the reference clip and the
  punctuation, so a build could design two or three clips per main character (calm, angry, grieving).
