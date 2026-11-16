# Our own GPU runner instead of ComfyUI? Where a build's image time goes, 1 November 2026

> **Kept as a record.** This is the write-up of a finished study. Its scripts (under `packages/server/src/cli/_exp/`), its data and most of the pictures it names were removed for the 1.0 release and are in
> git history at the tag `pre-1.0-experiments`, as are the other studies it cites that are no longer in
> `docs/experiments/` or `docs/baselines/`. Paths that begin with `<study data>` or `<tools>` were on the author's own
> machine and are in neither.

The question: would Daydream's world builds get 20% faster or more if FLUX 3 Image Klein and Qwen-Image 2.1 ran in
a plain-PyTorch runner of our own instead of ComfyUI? The VoxCPM2 voice runner (`docs/experiments/tts/runner/`) got
three to four times faster than its stock version by removing per-step launch overhead, caching repeated prompts and
using FP8 multiplies, so the same might hold for images.

**Answer: no, a runner of our own would not gain 20%.** Klein spends 89–93% of every job in denoising steps that
ComfyUI already runs with int8 tensor-core multiplies, int8 attention and CUDA graphs. A runner could only shave the
remaining few percent. The real time goes elsewhere:
- **Heat.** The laptop GPU slows itself from about 1,550 MHz to 930 MHz within a minute of full load, which makes
  every step 57% longer. This is a setting and a cooling matter, not code.
- **Qwen's text encoder throws away half its work.** About 20% of every map reading can be saved, with identical
  pictures, by one small ComfyUI node (`config/comfyui/daydream-nodes/`, now used by the reader).
- **Rejected paintings.** Half the paintings a build makes, with their readings, are thrown away: about a third of
  the build's GPU time.
- **Step caching (EasyCache, built into ComfyUI)** paints a map 27% faster at a small cost in fine detail, which needs
  the author's eye.

All of these come without leaving ComfyUI. The recommendation is at the end.

## Machine and method

- **GPU:** the development laptop's RTX 4090 Laptop GPU (16 GB, power limit 80 W default and 105 W maximum, target
  temperature 75 °C), driver 617.42. ComfyUI 0.43.0 (portable build: Python 3.13, PyTorch 2.14 with CUDA 13.0,
  comfy-kitchen 0.2.40), started fresh, nothing else on the GPU.
- **Models, as the build uses them:** `flux3-image-klein-int8-convrot` (16 steps) with `qwen3vl_4b_int8_convrot`
  as its text encoder, and `qwen_image_2.1_turbo_int8_convrot` (8 steps, cfg 1) with `qwen3vl_8b_int8_convrot`.
  Workflows are the build's own (`config/comfyui/klein_t2i.json`, `qwen21_edit.json`).
- **Timing:** `comfytime.py` sends a workflow to ComfyUI, follows its websocket and records the time spent in each
  node and between sampler steps, while sampling `nvidia-smi` every 200 ms for SM and memory clocks, temperature
  and power. Each prompt's text carries its seed, so ComfyUI cannot reuse the last text encoding (a build never sends
  the same prompt twice). Every timing below was taken on a hot GPU: 60–75 s of full Klein load first, unless it
  says "cold". Raw results: `results.jsonl`.
- **Build data:** the 30 October Klein build of the space world (`docs/baselines/2026-10-30-klein/`). Its
  per-prompt meter and ComfyUI history went with its worktree, so the breakdown below uses that report's per-step
  tables, adjusted for the two changes merged since (the final reading reuses the judging read; the GPU queue groups
  work by model).

## Where a build's image time goes

The Klein build used 65.1 GPU-minutes. Since then the final reading dropped from 26 Qwen prompts to about 6 (−10
minutes), and model switches from 36 to about 12. Each switch costs only 2–3 s on this ComfyUI (below), not the
22 s seen in that build, so they are now about a minute in all. A build today spends roughly:

| Work | Prompts | GPU minutes | Share |
| --- | --- | --- | --- |
| Klein: whole map paintings | 10 | 13.0 | 27% |
| Klein: ways out cut (box edits) | 6 | 2.6 | 5% |
| Klein: characters, creatures, objects, icons, repairs | 80 | 14.6 | 30% |
| Qwen: soundness reads (4 plans of each painting) | 40 | 21.1 | 43% |
| Qwen: final reading (building and door plans) | ~6 | ~3 | 6% |
| Model switches | ~12 | ~1 | 2% |
| **Total** | | **~49** (hot GPU) | |

The shares add to a little over 100% because the build's step times include some of the loads.

**Thrown away:** five of the ten paintings failed the soundness check and were painted again, and each was read four
times before it was rejected: 5 × 78 s of Klein plus 20 × 32 s of Qwen, **about 17 minutes, a third of today's
GPU time.**

### Inside one job (hot GPU, 930 MHz)

| | Klein map 2048² | Klein character 832×1216 | Qwen read 1.4 MP | Qwen read 2.4 MP |
| --- | --- | --- | --- | --- |
| Whole job | 44.0 s | 7.8 s | 21.6 s | 41.8 s |
| Denoising steps | 40.7 s (16 × 2.54 s), **92.5%** | 6.8 s (16 × 0.43 s), **88%** | 9.4 s (8 × 1.18 s), 44% | 19.4 s (8 × 2.42 s), 46% |
| Sampler setup and first step | 0.3 s | 0.1 s | 1.6 s | 2.7 s |
| Text encoding | 0.4–0.5 s | 0.25 s | **9.1 s, 42%** | **17.2 s, 41%** |
| VAE encode (reference) | – | – | 0.35 s | 0.5 s |
| VAE decode | 2.2 s | 0.45 s | 1.2 s | 2.1 s |
| Saving the PNG | 0.5 s | 0.15 s | 0.2 s | 0.3 s |
| Peak GPU memory | 12.2 GB | 10.1 GB | 15.5 GB | 16.0 GB |

- **Model loads** cost 1.7 s for Klein and 3 s for Qwen after the broker's `/free`. On the first prompt from disk
  they cost 6.5 s. ComfyUI 0.43's dynamic VRAM keeps the weights staged in pinned system memory (68 GB here) and
  streams them back quickly. Keeping both models resident is impossible anyway: Klein with its encoder and Qwen with
  its encoder hold about 27 GB of weights.
- **Offloading and weight streaming** cost nothing measurable inside a job. Encoding the same Qwen prompt without
  the picture takes 0.4 s, so the 8B encoder's weights stay on the GPU while it works.
- **What ComfyUI already does:** both checkpoints are "convrot" int8. ComfyUI runs their linear layers as int8
  tensor-core multiplies (`torch._int_mm` through comfy-kitchen) and 31–33 attention blocks each with comfy-kitchen's
  int8 attention, a SageAttention-style kernel; the checkpoints ask for it themselves. Its model compiler captures
  CUDA graphs. A step is therefore pure compute: the step times above do not vary by more than 2%, and the time
  outside steps for Klein is 0.1–0.3 s per job.

## What each option gained

| Option | Where | Gain per job | Gain per build (est.) | Pictures |
| --- | --- | --- | --- | --- |
| A cooler GPU (no throttling) | settings and cooling | Klein map step 2.54 → 1.62 s (−36%) | **up to −35%** | same |
| Qwen: don't encode the unused negative | one ComfyUI node | 1.4 MP 21.6 → 17.5 s (−19%); 2.4 MP 41.8 → ~33 s (−20%) | −5 min (−10%) | **identical** |
| Qwen: reuse the picture's vision encoding across a map's plans | same node | 1.4 MP 17.5 → 15.8 s | −0.6 min | **identical** |
| Qwen: reuse the encoder's picture prefix (KV cache) | needs encoder surgery | ~2.5 s more per later plan (estimated) | −1 min | identical in principle |
| EasyCache on Klein (threshold 0.10) | built-in node | map 45.8 → 33.6 s (−27%) | −7 min (−15%) if used for maps and art | slightly softer detail (PSNR 31 dB) |
| Reject a bad painting after one plan, not four | build pipeline | – | about −6 min (−12%) | untested |
| Model swaps: keep models loaded, or never `/free` | broker | 2–3 s per switch | under −1 min | same |
| FP8 multiplies instead of int8 | – | none expected: Ada runs int8 and FP8 at the same rate, and int8 is already used | 0 | – |
| SageAttention | – | already in use (comfy-kitchen's int8 attention) | 0 | – |
| A plain-PyTorch runner for Klein | new code | at most the ~1 s per map outside steps, plus the PNG save | **under −3%** | – |

### The heat

Measured from a 55 °C start, the same 2048² map, back to back:

| Run | Mean SM clock | Power | Temperature | Step | Job |
| --- | --- | --- | --- | --- | --- |
| 1st | 1,551 MHz | 99 W | 69 °C | 1.62 s | 30.4 s |
| 2nd | 1,246 MHz | 82 W | 75 °C | 1.87 s | 34.3 s |
| 3rd and after | 936 MHz | 69 W | 77 °C | 2.54 s | 43.8 s |

`nvidia-smi` gives the reason as "SW Thermal Slowdown": the driver holds the GPU at its **75 °C target
temperature**. The memory clock also stays at 6,000 MHz against 9,001 MHz possible. The baseline build was throttled in
96% of its samples. Builds are compute-bound, so time follows the clock. Raising the laptop's GPU temperature target
(the maker's control software usually allows up to about 87 °C), running the fans at full speed, or a cooling pad
would gain more than everything else in this report together. Nothing was changed here: these are system settings and
the author's call.

### Qwen's text encoder

`TextEncodeQwenImage21` runs Qwen3-VL-8B over the system line, the whole reference picture (about 1,400 vision
tokens at 1.4 MP, 2,300 at 2.4 MP) and the prompt, **twice**: once for the prompt and once for the empty negative
prompt. The build samples at cfg 1, where ComfyUI never evaluates the negative (`samplers.py`, the cfg-1
optimisation), so the second pass is wasted. Split at 1.4 MP: vision tower 1.85 s, the LLM over the picture and
prompt 2.8 s, the same again for the negative, VAE encode 0.35 s.

`DaydreamQwenEncode` (`config/comfyui/daydream-nodes/`) replaces the stock node in the reader's workflow. It
encodes the positive only and keeps the vision tower's answer per picture, in system memory. The reader asks four
plans of each painting, three of them at the same 1.4 MP size, so the vision tower is reused within a painting. With
the same seed and prompt, its plan is **identical pixel for pixel** to the stock node's. Encoding is 42% of every
Qwen job, so it is the one place a custom path pays.

**Adopted** (after this study, in the same branch). A map's four plans read through the game's own `qwenEdit`
(`packages/server/src/cli/_exp/qwenread.ts`, a saved town of the space world, two seeds) took 30.0, 18.4, 15.6 and
16.2 s in ComfyUI. The same four with the stock node took 41.8 + 3 × 21.6 s: **107 s down to 80 s, −25%**. The
vision cache sits on the shared encoder, so in one ComfyUI process the stock node benefits from it too, still
exactly; the stock figures here come from a ComfyUI that never loaded the node. One of the twelve prompts in that
check failed with "CUDA error: device not ready" inside the sampler's int8 layers. That is the same error the 30
October build met once with the stock node, and the next reading succeeded.

**Can the LLM's work be cached too?** The reading prompts are the same fixed text for every place, but the encoder
reads the picture before the prompt, so its output for a prompt depends on the map and cannot be reused across
places. What repeats is the **prefix**: the system line and the picture are the same for all of a map's 1.4 MP plans.
A prefix KV cache would leave only the prompt's ~150 tokens per plan, about 0.4 s instead of 2.8 s. That needs
changes inside ComfyUI's Llama implementation and saves about a minute per build, so it is noted, not built.
Putting the prompt before the picture would make the prompt cacheable across places instead, but the picture is the
bulk of the tokens and the model was trained picture-first.

### EasyCache on Klein

ComfyUI's built-in `EasyCache` skips the model on steps whose input has barely changed and reuses the last step's
change. At threshold 0.10 a 2048² map ran 12 of its 16 steps (45.8 → 33.6 s); at 0.20, 11 (31.9 s). Layout, paths,
pools and colours are the same; fine detail (bark, frost, grass texture) is a little softer
(`easycache_compare.jpg`: full maps above, a 512 px crop below; stock, 0.10, 0.20). Klein was adopted partly for its
crisp detail, so this needs the author's eye, and a trial on a build's soundness rate before it is used for maps.
Icons and characters are a safer first use.

### Rejected paintings

A third of today's GPU time goes to paintings that fail the soundness check (cut-off ground 9–41% against a 4%
limit in the Klein build) and the four readings each received. A clear failure would show in one plan. Reading the
2.4 MP walk plan first and rejecting at, say, twice the limit before asking the other three would save about three
Qwen prompts per rejected painting. `docs/places.md` notes that one reading alone is noisy, so this needs a check
against saved paintings (`placetries`) before it is adopted. The same holds for painting fewer bad paintings in the
first place: most rejects are walled dungeon rooms with no visible door.

## Recommendation

1. **Do not build a runner for Klein or Qwen.** The VoxCPM2 runner won by removing per-step overhead from a small
   autoregressive model; image steps here are already compute-bound int8 kernels with CUDA graphs, and ComfyUI's
   dynamic VRAM handles loading well. The broker should keep ComfyUI as its image adapter, beside the voice runner.
   (A runner was built anyway, below, and confirmed this.)
2. **The Qwen encoder node: adopted.** It is in `qwen21_edit.json`, and ComfyUI runs an installed copy of
   `config/comfyui/daydream-nodes/` (`docs/gpu-broker.md`, "Daydream's ComfyUI nodes"). It saves about 12% of a build,
   with identical readings.
3. **The GPU's heat: left as it is** (the author's call). Cooling a laptop has limits, and raising its temperature target
   is not good for it in the long term.
4. **EasyCache: rejected** (the author's call after seeing `easycache_compare.jpg`): the softer detail is not worth it.
5. **Broker scheduling** needs no change for speed: switches cost 2–3 s now.

## Ideas for later

What is left that could still shorten builds, none of it started. Walk-reading accuracy comes first: an idea that
changes what the reader sees is out, however fast (`docs/experiments/qwen-steps/`).

- **Reject a bad painting after one reading instead of four** (about 12% of a build). Half of a build's paintings fail
  the soundness check, and each is read four times first; the failures are usually clear (9–41% cut off against a 4%
  limit). Read the 2.4 MP walk plan first and reject at a margin well past the limit before the other three. Kept
  paintings still get all four readings, so the reading of every map that ships is unchanged. Check it on the saved
  paintings of past builds (`placetries`) before adopting it: `docs/places.md` notes that one reading alone is noisy.
- **Keep the GPU busy while Luna works** (up to about 13% of a build). The 30 October build left the GPU idle 9.5 of
  74 minutes, in short gaps while Luna wrote art prompts and checked paintings (`docs/baselines/2026-10-30-klein/`,
  `gpu-idle.csv`). Queueing GPU work ahead of Luna's answers would fill most gaps: for example, write the next art
  prompts while the current painting runs, or start the next place's painting while Luna judges a view.
- **Reuse a map's encoding across its readings** (about a minute per build). The reader's prompts come after the
  picture, so the encoder's work on the system line and the picture is the same for a map's three 1.4 MP plans. A
  prefix key-value cache in `config/comfyui/daydream-nodes/` would leave only each prompt's ~150 tokens to encode. It is
  exact, but needs changes inside ComfyUI's language-model code.
- **Paint fewer bad paintings.** Most rejected paintings are walled dungeon rooms or yards with no visible way in
  (`docs/baselines/2026-10-30-klein/tries/`). A plan wording that asks for visible openings between areas would cut
  rejections at the source.

Tried and dropped, so they need not be tried again:
- a Klein runner of our own (level with ComfyUI);
- 4-bit matmuls and EasyCache (quality);
- smaller art paintings (an earlier experiment: quality);
- fewer Qwen reading steps (accuracy);
- FP8 matmuls (no rowwise scaling on this GPU in PyTorch, and int8 runs at the same rate);
- stacking `qkv` and `mlp_in` (more copies than it saves).

## A Klein runner of our own, built anyway

After the study above, the author asked for the runner to be built regardless: plain PyTorch in the same environment as
the voice runner (`<tools>/tts-bakeoff/.venv-runner`, Python 3.14, PyTorch 2.15 with CUDA 13.4), supporting only what
Daydream uses, and improving on ComfyUI where it could rather than copying it. The 20% target came from the brief and
was not a requirement. The code is in `klein/`.

**What it supports.** Text to image at any size that is a multiple of 16, and the box edit with one reference picture.
Both run at cfg 1 (no negative prompt), with Euler, the simple schedule, 16 steps and batch 1. Layout boxes are prompt
text, so they cost nothing. The text encoder is Qwen3-VL-4B's language model alone (prompts are text), stopped after
layer 32, the last one the DiT reads. Everything stays on the GPU between jobs: 9.1 GB of weights, with a peak of
10.3 GB for a character and 10.7 GB for a 2048 x 2048 map.

**It matches ComfyUI.** `klein/ref_dump.py` runs Klein through ComfyUI's own code and saves every intermediate result,
and `klein/check.py` compares the runner with it stage by stage:

| Stage | Runner against ComfyUI |
| --- | --- |
| Tokens, sigmas, starting noise | identical |
| Text conditioning | 0.6–1.0% relative difference |
| One DiT step, from ComfyUI's input | 1.6–1.7% |
| VAE decode of ComfyUI's latent | 59 dB PSNR |
| The whole picture, from the same seed | 28.9 dB PSNR, the same picture (`klein/fox_check.png`: ComfyUI left, runner right) |

The box edit has been checked only by eye (`klein/edit_check.png`: the reference on the left, then a frozen pond asked
for in a box). It costs about twice the steps time of text to image at the same size, because the reference adds as
many tokens again.

### How it got to ComfyUI's speed

All times are for one denoising step on a hot GPU at 930 MHz.

| Version | 1024 x 1024 step | 2048 x 2048 step | What changed |
| --- | --- | --- | --- |
| Straight port: `torch._int_mm`, PyTorch element-wise ops, flash attention | 994 ms | – | Two thirds of the time went to rotating and quantising activations in many passes, and to turning int32 results into float32 and then bfloat16 |
| Own Triton kernels: rotate-and-quantise in one pass, int8 matmul with scales in its epilogue | 670 ms | – | |
| Also LayerNorm, modulation and SwiGLU folded into the quantiser, QK norm with RoPE in one kernel, `qkv` and `mlp_in` stacked into one multiply | 544 ms | 4,917 ms | At 2048 x 2048, flash attention became two thirds of the step |
| Own int8 attention (SageAttention-style, fp16 PV) | – | 3,488 ms | 1.9 times faster than flash attention |
| comfy-kitchen's kernels (the ones ComfyUI runs), with the stacked multiply kept | – | 2,604 ms | |
| comfy-kitchen's kernels, `qkv` and `mlp_in` separate as in ComfyUI | 430 ms | 2,511 ms | Same kernels as ComfyUI: **2,475 ms** |

**Why ComfyUI was already fast.** ComfyUI 0.43 runs Klein on comfy-kitchen, NVIDIA's CUDA kernel package for it:
- one kernel rotates and quantises each linear's input, folding in the adaLN modulation, the RMS norm or the SwiGLU;
- the int8 matmuls are cutlass kernels that apply the scales, and the residual, in their epilogue;
- QK norm and RoPE are fused;
- attention is int8 for both QKᵀ and PV;
- its model compiler captures CUDA graphs.

Measured shape by shape at 2048 x 2048, comfy-kitchen beat each of the runner's own Triton kernels:

| Kernel | Mine | comfy-kitchen |
| --- | --- | --- |
| Attention | 52.9 ms | 35.8 ms |
| Stacked input linear | 29.4 ms | 22.9 ms |
| Attention output linear | 5.3 ms | 3.2 ms |
| MLP output linear | 15.0 ms | 14.5 ms (a tie) |

So the runner now calls comfy-kitchen, installed into the voice runner's environment with the author's agreement. It is
a 64 MB wheel with no dependencies, built for any Python from 3.12 on, and it works with PyTorch 2.15. The package list
from before the install is `<tools>/tts-bakeoff/runner-freeze-before-comfy-kitchen.txt`. Only the QK norm and RoPE
kernel of the runner's own remains (`klein/kernels.py`; the runner's first version, with all its own kernels, is
commit 3fc1240).

**Ideas that did not pay.**
- Stacking `qkv` and `mlp_in` into one multiply saves one quantisation of their shared input. comfy-kitchen's fused
  SwiGLU and attention then copy the stacked output's non-contiguous slices, which costs more (132 ms per step at
  2048 x 2048).
- Separate code paths for the simpler cases gain nothing on top of what already happens. Without a reference picture
  there is no reference stream at all, and boxes are only prompt text. What differs between jobs is the picture's size.
- Rowwise FP8 matmuls (`torch._scaled_mm`) are not supported on this GPU (sm_89) in PyTorch 2.15, and int8 runs at the
  same rate anyway.
- 4-bit matmuls (comfy-kitchen's convrot W4A4 on int4 tensor cores, quantised here from Klein's bfloat16 weights, since
  nobody publishes a 4-bit Klein). They are about three times the int8 multiply's speed, and they took 1024 x 1024
  steps from 6.9 to 5.5 s (−20%) and 2048 x 2048 from 40.8 to 36.6 s (−10%, attention dominates there). But the
  pictures suffer (`klein/w4_check.png`: int8, MLPs in 4 bits, every linear in 4 bits). The hedgehog's face melts, the
  fox loses its fur and the map its paths and detail: 17–22 dB against int8, and even with only the MLPs in 4 bits
  faces change expression and the map's layout shifts. Rejected (`klein/w4compare.py`; `DiT(w4=...)` keeps the
  option).
- Smaller art paintings: an earlier experiment found too much quality loss for the speed (the author's note).

**What it does that ComfyUI does not.**
- The text encoder runs 32 of its 36 layers and no vision tower: 0.05–0.2 s against ComfyUI's 0.25–0.5 s.
- Pictures come back as tensors, so the 0.15–0.5 s PNG save leaves the GPU's time (the caller encodes).
- When a big picture's VAE decode would not fit beside the weights, the text encoder's 3.4 GB leaves the card; a
  pinned copy in system memory brings it back in about 0.6 s at the next prompt. Bigger maps run their MLP in slices
  of 20,480 tokens. 3072 x 3072 peaked at 11.4 GB. Windows silently spills GPU memory into system memory, which made
  an early 2048 x 2048 test several times slower, so the runner checks free memory before each decode, and tiles the
  decode as a last resort.

### Measured against ComfyUI

Both heat-soaked (75 s of full load first) at the throttled 930 MHz, with a new prompt and seed each time. The
runner's rows are in `klein/runner-results.jsonl` (label `final`), ComfyUI's in `results.jsonl` (label `base`).

| Job | ComfyUI | Runner |
| --- | --- | --- |
| Character, 832 x 1216: whole job | 7.6–8.0 s | 7.3–8.1 s |
| its 16 steps | 6.74–7.08 s | 6.70–6.76 s |
| Map, 2048 x 2048: whole job | 43.8–44.1 s | 43.5–44.2 s |
| its 16 steps | 40.6–41.0 s | 40.8–40.9 s |
| its VAE decode | 2.2 s | 2.3 s |
| Loading | 6.5 s from disk; 1.7 s after the broker's `/free` | 30 s from disk (a resident service loads once) |

**The runner is level with ComfyUI.** It runs the same kernels, and the little it saves around the steps (text
encoding, PNG saving) is about what it spends bringing the text encoder back after a big map.

### What it would mean for Daydream

- **Speed: no gain worth a migration.** At best about 0.3 s per character (4%) and nothing per map, so 1–2% of a
  build. The study's recommendations stand.
- **Architecture: possible, with costs.**
  - One GPU service of our own could hold the voice runner and Klein in one environment, without ComfyUI's server,
    queue and node graph, and ask for exactly what it needs.
  - But Qwen-Image 2.1 (the map reader) would have to be ported the same way before ComfyUI could go, and the two
    image models plus voice cannot all stay resident on 16 GB. The service would need the same load-and-swap logic the
    broker and ComfyUI's dynamic VRAM already provide.
  - Its speed would come from comfy-kitchen either way: the runner's own kernels lost to it.
- **Recommendation.** Keep ComfyUI for images behind the broker, and keep this runner as a reference. Its value is in
  what it showed: where ComfyUI's speed comes from, that there is no hidden overhead left in it, and a checked,
  readable implementation of Klein to build on if the GPU service is ever consolidated.

**Running it.** comfy-kitchen was removed from the voice runner's environment afterwards (the runner is not used).
Install it again first: `uv pip install --python <tools>/tts-bakeoff/.venv-runner/Scripts/python.exe --no-deps
<tools>/klein-runner/wheels-check/comfy_kitchen-0.2.40-cp312-abi3-win_amd64.whl`. Then, in that environment, from
`klein/`:
- `python check.py <dump.pt> [out.png]`: compare with ComfyUI. Make the dump with ComfyUI's Python:
  `ref_dump.py <dump.pt> <w> <h> <seed>`.
- `python bench.py <out.jsonl> <label>`: the heat-soaked timing.
- `python profile_step.py <w> <h>`: one step's kernels.

Set `TRITON_DEFAULT_FP_FUSION=1` to quiet Triton's warning. No OpenAI calls were made for the runner. It used about
90 GPU-minutes, most of them benchmarks.

## Files

- `comfytime.py`: the timing harness (run with ComfyUI's Python).
- `config/comfyui/daydream-nodes/`: the Qwen encoder node. The trial's version also logged its own split and
  could still encode the negative, for the measurements above. For the trial, ComfyUI loaded it from the checkout through
  `--extra-model-paths-config`; in use, ComfyUI runs an installed copy instead.
- `packages/server/src/cli/_exp/qwenread.ts`: reads a saved map with every walk plan through the game's `qwenEdit`
  and times each one.
- `klein/`: the Klein runner (`klein.py`), its QK norm and RoPE kernel (`kernels.py`), the ComfyUI dump and stage
  check (`ref_dump.py`, `check.py`), `bench.py`, `profile_step.py`, `w4compare.py`, `pngio.py` and the check pictures.
- `results.jsonl`: every timed prompt (labels `base`, `encode`, `easycache`, `cold`, `node-identity`,
  `read-stock`). The `encode` rows came from the trial node's switches (`-dd`: both encodings; `-skip`: positive
  only; `-cache`: positive only with the vision cache), which `comfytime.py` no longer has.
- `easycache_compare.jpg`: stock against EasyCache 0.10 and 0.20.

No OpenAI calls were made. GPU time spent: about 35 minutes.
