# Voices

Every character in a world speaks with a voice of its own, and a narrator voice made for that world tells the intro,
the story so far and everything not said by a character. This document describes how voices are made at build time, how
lines are spoken at play time, how players hear them, and what each part of the code does. The engines were chosen in
a bake-off; its report, with every measurement, is `docs/experiments/tts/README.md`.

## The one rule

> Speech never holds up the game. The text is always shown; the voice joins it if it can start in time, and is
> skipped quietly if it cannot.

From it:

- **Text first.** Every spoken line is also shown. Players who turn voices off lose nothing.
- **Fastest engine wins.** Each reply is spoken by whichever engine can start it soonest. The two engines sound alike
  (the user likened them to one voice through a better and a cheaper microphone), so speed matters more than sameness.
- **Builds come first.** A world build owns the GPU. While one runs, or while the GPU PC is off, speech comes from
  the server's CPU.
- **A late line is dropped.** A line that has not started six seconds after its text was ready is not spoken; a subtle
  mark on the line shows that the character could not be voiced.

## What speaks

| Text | Voice | Made | Who hears it |
|---|---|---|---|
| NPC replies in a conversation | the NPC | live, sentence by sentence as the model writes it | everyone in the conversation |
| First greetings | the NPC | at build time | everyone in the conversation |
| Return greetings | the NPC | at build time: the person's own three lines, or the stock ones in `dialogue.ts` that hold no hero's name | everyone in the conversation |
| Rule-based fallback replies (`simpleSpeech`) | the NPC | live | everyone in the conversation |
| Barks | the NPC | at build time | players whose hero is near, quieter with distance |
| Boss taunts | the boss | at build time | everyone in the fight |
| The intro | the narrator | at build time | the player joining |
| The story so far | the narrator | live, sentence by sentence | the player who asked |
| Arc revelations, the ending | the narrator | at build time | everyone the text is shown to |
| Signs and lore notes | the narrator | at build time | the player reading |
| The death line, town gatherings | the narrator | live (they hold the town's name and a reason written in play) | everyone the text is shown to |
| Legends of new legendary items | the narrator | live, once the legend is written | the player it is shown to |

Narration for a player talking with someone (an arc's revelation, the ending) waits until they leave the
conversation, so the narrator never speaks over the person (`Adventure.narrate`).

Not spoken: toasts, journal entries, the combat log, player chat, and the short system notes inside a conversation
("X gives you Y", "X joins the conversation"). AI-played heroes do not speak today and get no voice. A fixed line that
holds a name filled in at play time (a bark calling a hero by name) is spoken live.

Every text is spoken sentence by sentence, as the game cuts it at play time (`speech/text.ts`), so a line made at build
time is one sentence too, and is found by its voice and words: whatever text the game speaks, each sentence is played
from its file if the build made one and spoken live otherwise.

The browser reads nothing aloud itself. Players can speak instead of typing (`client/src/voice.ts`): the server's
transcription model when it has one (`/api/voice/transcribe`, charged to the speaker's AI budget), else the browser's
own speech recognition.

## Voices

- **Who has one.** Every NPC, every boss, and one narrator per world. Ordinary creatures do not speak.
- **The description.** The build writes how each one sounds: age, pitch, pace, accent, and texture, in a sentence or
  two, as in `packages/server/speech/cast.json`. It is the `voice` field of an NPC or a boss, and the concept's
  `narratorVoice`, chosen to suit the world's tone. The persona prompt uses the NPC's personality, not its voice
  description.
- **The reference clip.** Qwen3-TTS VoiceDesign turns each description into one ten-second clip of the voice saying
  a fixed passage (`REF_TEXT` in the runner). It is saved as `assets/voices/<voiceId>.wav` with the world and carried
  by `worldpack`. One clip per voice: choosing the most distinct of several candidates by voiceprint picked worse
  voices by ear than taking the first.
- **Both engines clone the clip.** VoxCPM2 and Pocket TTS both speak in the voice of the reference clip, so a
  character sounds like itself on either engine.
- **Loudness.** Each voice gets a gain per engine, measured once at build time from a few test lines, so every
  character and both engines play at the same loudness (−18 LUFS). A light limiter on the client catches peaks. Live
  lines cannot be measured before they play, which is why the gain belongs to the voice.

## The engines

| | VoxCPM2 runner | Pocket TTS |
|---|---|---|
| Where | the GPU PC, started and stopped by the GPU broker | the game box, inside the game server's process (one worker thread per line) |
| Code | `packages/gpu-broker/speech/` (Python) | `packages/server/src/speech/pocket*.ts` (TypeScript); the export, `packages/server/speech/pocket_export.py` |
| Environment | Python 3.14, torch 2.15 with CUDA 13.4 (`.venv-runner`) | ONNX Runtime 1.31 (`onnxruntime-node`); pocket-tts 4.0.1 exported to ONNX, the language model in int8 |
| Lines at once | up to 12 (16 slots) | 2 with the 100M model; the 18M model when lines are waiting |
| Heat-soaked speed | first audio 41 ms; 0.16× real time for one line, 0.43× each for twelve | first audio 45 ms; 0.19× for one line, 0.20× each for two (100M, one core each, on the PC's i9; the game box is slower) |
| Start-up | about 8 s, 6.6 GB of GPU memory | about 1 s; a voice's state takes about 1.5 s per model the first time, then is kept on disk |

**Pocket TTS on ONNX Runtime.** `pocket_export.py` turns Kyutai's PyTorch model into ONNX graphs once, at install:
one step of the language model (its weights in int8, a quarter of the memory traffic that limits a step on a small
CPU), the streaming Mimi decoder and the encoder that hears a voice's clip. The game server runs them with ONNX
Runtime and a TypeScript port of pocket-tts's generation and text front end; the export records PyTorch's audio and
tokens for `pocketcheck` to compare with (the same within -60 dB, the text identical). On the same cores it is faster
than PyTorch (0.19× real time against 0.33×, first audio 45 ms against 112 ms), sounds the same (word error under 1% and the same likeness to the clip,
over 60 lines in six voices), and needs no Python on the box. A voice's state (the model's keys and values after
hearing its clip) is made once per model and clip, shared in memory by both line slots and kept on disk under the
clip's hash (`<data>/cache/pocket/`), so a restart never makes it again.

The VoxCPM2 runner runs in FP8 with eight diffusion steps, and caches each voice's prompt (its clip and transcript)
up to a 512 MB budget. The same environment holds the VoiceDesign port (`designer.py`), loaded only for build work.

**The runner is Python; the broker is Node.** The runner is a long-lived Python child process of the broker, which
restarts it if it dies, and they speak one small protocol over a local socket:

- requests (JSON): `speak {lineId, voiceId, text, startWithinMs, priority}`, `cancel {lineId}`, `load`, `unload`, `status`
  (every `load` and `unload` is answered with `loaded` or `unloaded` and its `reqId`, with an error if a load failed)
  (a voice is named by its clip's hash and the clip is sent only when the service asks for it, `docs/gpu-broker.md`,
  "Speech");
- replies: a JSON header per line (`started`, `done`, `failed`, `expired`), then the line's audio as binary frames of
  16-bit PCM as they are made, each tagged with its `lineId`.

The game server talks to both through one `SpeechEngine` interface, so choosing an engine is one decision in one
place.

**Through the broker.** The broker has a `speech` adapter. Unlike ComfyUI work, speech is not queued behind other
GPU work:

- While no other adapter's work is queued or running, the adapter keeps the runner loaded and answers speak requests
  at once over a streaming connection.
- When build work arrives, the broker unloads the runner before starting it and says so in its status, and the game
  server chooses Pocket TTS for the replies that follow. A line that reaches the broker in the moment between is
  refused at once and stays unvoiced (its reply keeps its engine).
- When the queue empties, the broker loads the runner again (about 8 s).
- Build-time voice work (designing clips, speaking fixed lines, measuring loudness) is ordinary queued broker work for
  the same adapter, batched per world.
- `GET /broker/speech` reports whether the runner is loaded and how many slots are free, for the game server's
  choice and for the admin GPU page.

## Speaking a line at play time

1. **Text arrives.** For NPC replies and the story so far, the model's output is streamed (see "Streaming the
   reply"). Every finished sentence becomes a line to speak. Very short sentences are joined to the next, so the
   voice does not stop and start on "Ah." or "Well."
2. **A spoken line, not a written one.** Before speaking, the text loses what was never meant to be said aloud:
   stage directions in asterisks or brackets, and markup. The text on screen is unchanged. (A person's own name before
   their words, a speaker tag, is taken off the reply itself as it is written.)
3. **Choosing the engine, once per reply.** At the reply's first sentence the server picks:
   - the GPU, if GPU speech is switched on, the broker reports the runner loaded and a slot free;
   - otherwise Pocket TTS, if a line slot is free or the queue is short enough to start within the deadline;
   - otherwise nothing: the reply's lines are marked unvoiced.

   The reply's other sentences go to the same engine, so the voice does not change in the middle of a reply. The
   next reply chooses again.
4. **Pocket TTS's queue.** The game box has four threads, shared with the game server and the job worker, so Pocket TTS
   speaks at most two lines at once. Further lines wait in order. When lines are waiting, it switches to the 18M
   model, which clears them faster; when the queue is empty, it returns to the 100M model.
5. **Six seconds.** A line that has not started six seconds after its text was ready expires: it is not spoken and
   its line gets the unvoiced mark. By then the player has read it, and late speech would talk over the next line. A
   line that has started always finishes. The game server keeps this deadline itself, by its own clock, for both
   engines (`Speech.speak`), and cancels the line with its engine when it passes; the runner is told how long a line
   may still wait, not a time, because the GPU PC's clock is its own.
6. **Priority.** Lines someone is waiting to hear go before anything else.
7. **Canceling.** A player who closes the conversation, skips the line, or leaves stops hearing it at once. Skipping
   a line (clicking the text to show it all, or starting to speak) also skips the rest of that reply. The line keeps
   being spoken while anyone is still listening; when the last listener has gone it is canceled, which frees its slot.
8. **Streaming to players.** The server encodes each line to Opus once, as the PCM arrives, and sends the same frames
   to every listener. Who hears a reply is asked at each of its sentences, so someone who joins a conversation hears
   the rest of the reply and someone who left hears no more of it. A listener who joins while a line is being spoken
   is sent it from its start.

**Build-time lines.** Fixed lines are spoken once at build time on the GPU and saved as Ogg Opus files,
`assets/speech/<hash>.opus`, keyed by voice and text. Playing one is reading a file: it starts at once, costs
nothing, and is the same for every player and every adventure of the world. A rough estimate is 400 to 500 lines and
5 to 10 MB per world. Designing the voices and speaking the lines held the GPU 3.7 minutes for a world of 12 voices
and 5.9 for one of 17 (two builds of 2026-11-14). There is no other cache: lines written by the model almost
never repeat.

## Streaming the reply

A person's words come from one streamed call (`npc.decision`), made after the judge has decided what the person does
(docs/people.md), so the words never need to be checked against actions afterwards:

- **The schema puts `speech` first,** then, each only when asked for, the journal lead, whether the person agrees to
  a case, the reason for a change of heart, and the memory. A small
  incremental reader pulls the `speech` string out of the partial JSON as it arrives; sentences go to speech, and the
  text goes to the conversation as it grows. When the response is complete, the whole JSON is validated.
- **When the call fails** after the speech has been shown, the speech stands. Whatever was decided has already
  happened, so nothing is lost but the lead and the memory.
- **The story so far** (`recap.ts`, plain text) streams the same way, without JSON.

## What the player hears and sees

- **Sound.** One `AudioContext` with a gain per kind of sound (voices, effects, music, and ambience; docs/sound.md) feeding a
  master gain and a limiter. Opus frames are decoded with WebCodecs `AudioDecoder`, which current Chrome, Edge,
  Firefox and Safari support; a browser without it is sent 16-bit PCM instead. A short buffer (about 100 ms) keeps
  playback smooth.
- **Browsers block sound until the player interacts.** A gamepad press may not count as interaction, so sound is
  unlocked by the first click, tap, or key press (for example "Begin the adventure").
- **The dialog window.** Text grows as the model writes it, at a pace set by the voice when there is one. Voices are
  turned down or off in Settings, not here; the microphone button is in the field where the player writes.
- **Unvoiced lines.** A line that expired or failed gets a small, quiet mark (a muted speaker beside it), with
  "Could not be voiced" on hover or focus. No toast, no sound.
- **Barks and taunts** play from the speaker's position: players whose hero is within about 12 m hear a bark,
  quieter with distance.

## Settings

A **Settings** window, the first place for a player's own preferences:

- **Sound:** one volume each for the master, the interface, effects, music, ambience (docs/sound.md) and voices. Voices
  at 0% are off: the server sends that player no speech.
- Opened from the in-game menu (`MenuWindow`), and from the account menu outside the game.
- Saved to the player's account on the server, so it follows them to every device.
- Studio quality, matching the game's windows. It works with a mouse, the keyboard, and a controller: the d-pad or
  stick moves the focus ring (`input/spatial.ts`), and left and right move a slider. Its layout fits a narrow screen.
  Touch-specific handling for the rest of the game is a separate, larger job and is left for later.

The admin GPU page has a **GPU speech** switch for the whole game, beside the broker's speech status (loaded, slots
free) and counts of lines spoken per engine, expired and failed. Speech errors go to the admin Errors page like any
other.

## Building a world's voices

A build step, `worldgen/voices.ts`, beside the art once the world is assembled, on the GPU as one queued broker
session (`docs/gpu-broker.md`, "Speech"):

1. Luna writes the voice descriptions with the characters (story people, residents, and bosses) and the narrator's
   with the concept, in the steps that already write them (`voice`, `narratorVoice`).
2. VoiceDesign makes the reference clips, the whole world in one batch. Each clip is transcribed (`speech.input`), and
   one with fewer than 80% of its passage's words is designed again, up to twice.
3. The runner speaks every fixed line (see "What speaks") and a calibration passage per voice. Each voice's loudness
   on the GPU comes from those, and on the CPU from the passage spoken by Pocket TTS; the gains are kept with the
   world (`voices`), and the files are written at the game's level. The GPU is given back before the Pocket TTS
   part, so sounds can begin on it; the build page's Voices bar covers the GPU part to 90% and the CPU part after.

What exists is kept, so a stopped build resumes where it was; `worldpack` carries `assets/voices/` and
`assets/speech/` with the rest of the world. Without GPU speech configured (tests, an installation without the GPU) a
world gets no voices and plays with text alone.

**A world built before voices** gets them from a console tool, `voiceworld`: Luna describes everyone's voice (one
call per world; the old `voice` field was a speaking style or a copy of the personality), then it runs the same step.

## Installing

- **The GPU PC:** the runner's environment (`.venv-runner`) beside the broker, installed from the user's own terminal.
  The broker's config names the Python and the runner's folder.
- **The game box:** the Pocket TTS models exported to ONNX beside the server, made once with a Python environment that is
  deleted afterwards, from Kyutai's cloning weights (gated: they forbid cloning a real person's voice without consent;
  designed voices are not real people).
- Both are written up in `docs/hosting.md`.
- **Credits.** `CREDITS.md` in the repository names every model, its license, and its source: Pocket TTS (CC-BY-4.0),
  VoxCPM2 and Qwen3-TTS (Apache 2.0), and ONNX Runtime (MIT).

## How it was built

Voices were built in four stages, each playable on its own (November 2026).

1. **Pocket TTS end to end.** The speech service on the game box, the `SpeechEngine` interface, Opus streaming, playback in
   the client, the unvoiced mark, and the Settings window. Voices came from the bake-off's reference clips for a test
   world.
2. **Streaming replies.** The streamed `npc.decision` and story so far, sentence splitting and the growing text.
3. **The GPU.** The broker's `speech` adapter, the engine choice, the admin switch, and status.
4. **Building voices.** The voice descriptions, the build step, build-time lines, loudness, `voiceworld`, and the
   upgrade of existing worlds.

## Settled

- Builds own the GPU; during a build, or with the GPU PC off, speech comes from Pocket TTS on the game box.
- The engine is chosen per reply, by speed.
- Everyone in a conversation hears its lines, from one stream.
- Six seconds to start, or the line is dropped with a subtle mark.
- Sentence streaming from the start, in one call with `speech` first and no `thought`.
- Opus, with 16-bit PCM for a browser without WebCodecs.
- Fixed lines are spoken at build time; there is no other cache.
- Voices are on by default, with a volume, in a Settings window.
- A world built before voices is upgraded once with `voiceworld`; a world without voices plays with text alone.
- The Pocket TTS credit is in the repository, not in the game.
