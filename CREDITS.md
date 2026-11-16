# Credits

Daydream is free and open source: its code is under the MIT license (`LICENSE`). That license covers the code only.
The models the game runs and the fonts it shows keep their own terms, listed here with their sources. Each
installation downloads the models itself, or calls them as a service; none is part of this repository. The fonts are.

## Text, decisions and pictures

- **OpenAI's models**, called through OpenAI's API with each installation's own key and under OpenAI's terms: the
  GPT text models (Luna, with Sol as the stronger check) write a world and speak for its people, the decision and
  transcription models judge conversations and hear players, and **GPT Image** (2.5 Flare and 2.6 Sunburst) paints
  the characters, creatures, objects, icons and animation and reads painted places for walkable ground
  (`config/genai.example.json`).

## Places and backup painting

- **FLUX 3 Image Klein**, with its VAE and its Qwen3-VL text encoder: paints every place as a top-down map, and is
  the backup painter of the art (docs/places.md, docs/world-art.md). Under the FLUX Kommunity License, which is
  non-commercial, with an exception for commercial output by users with less than US $5M a year in revenue
  (docs/experiments/flux3-klein); see the model's page for the terms.
- **Qwen-Image 2.1 Turbo**, with its VAE and text encoder: the backup reader of painted places, for when GPT Image
  does not read them (docs/places.md). For its license, see the model's page.
- **ComfyUI** (GPL-3.0) runs them on the GPU PC, behind the GPU broker.

## Speech

- **Pocket TTS** by Kyutai: speaks every voice on the game server's CPU. Weights under
  [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/), code under the MIT license.
  [kyutai/pocket-tts](https://huggingface.co/kyutai/pocket-tts). Its voice-cloning weights are gated behind Kyutai's
  terms, which forbid cloning a real person's voice without their consent; Daydream's voices are designed for its
  characters, not taken from real people. Daydream exports it to ONNX (`packages/server/speech/pocket_export.py`)
  and runs it in the game server; its text front end is ported from pocket-tts.
- **ONNX Runtime** by Microsoft: runs Pocket TTS on the CPU. MIT license.
  [onnxruntime-node](https://www.npmjs.com/package/onnxruntime-node).
- **VoxCPM2** by OpenBMB: speaks voices on the GPU. Apache 2.0. [openbmb/VoxCPM2](https://huggingface.co/openbmb/VoxCPM2).
  Daydream runs it through a runner of its own (`packages/gpu-broker/speech/`).
- **Qwen3-TTS VoiceDesign** by the Qwen team, Alibaba Cloud: designs each character's voice from a written
  description when a world is built. Apache 2.0.
  [Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign). Daydream runs
  it through a port of its own (`packages/gpu-broker/speech/designer.py`).
- **Opus** (libopus, BSD license), through [@discordjs/opus](https://github.com/discordjs/opus) (MIT): encodes speech
  for players.

## Sound and music

**Powered by Stability AI.** Every world's sound effects and music, and the game's own sounds in
`packages/client/public/sounds/`, are made with Stable Audio 3, except the game's theme.

- **The game's theme** ("Daydream Theme", `theme.0.opus`) was composed with Google Gemini by the game's author.

- **Stable Audio 3 Small SFX** and **Stable Audio 3 Medium** by Stability AI: make the sound effects and the music
  when a world is built (docs/sound.md). Under the
  [Stability AI Community License](https://huggingface.co/stabilityai/stable-audio-3-small-sfx/blob/main/LICENSE.md),
  which allows research, non-commercial use, and organizations under US $1M a year in revenue; the audio made belongs
  to whoever makes it. Its notice: *"This Stability AI Model is licensed under the Stability AI Community License,
  Copyright © Stability AI Ltd. All Rights Reserved."* The weights are gated on Hugging Face; each installation
  accepts the license itself and downloads Comfy-Org's ComfyUI packaging of them,
  [Comfy-Org/stable-audio-3](https://huggingface.co/Comfy-Org/stable-audio-3). Daydream does not change the models.
- **T5Gemma** by Google: Stable Audio 3's text encoder. Gemma is provided under and subject to the
  [Gemma Terms of Use](https://ai.google.dev/gemma/terms).
- **ComfyUI** (GPL-3.0) runs them on the GPU PC, behind the GPU broker.

## Fonts

The game's interface and each world's look use these typefaces, all under the
[SIL Open Font License 1.1](https://openfontlicense.org/). Their files are in `packages/client/public/fonts/`, as
Google Fonts serves them:

- Cinzel
- Cormorant Garamond
- EB Garamond
- Exo 2
- Fraunces
- IM Fell English and IM Fell English SC
- Inter
- Lora
- Oswald
