# Art by GPT Image instead of Klein (13 November 2026)

> **Kept as a record.** This is the write-up of a finished study. Its scripts (under `packages/server/src/cli/_exp/`), its data and most of the pictures it names were removed for the 1.0 release and are in
> git history at the tag `pre-1.0-experiments`, as are the other studies it cites that are no longer in
> `docs/experiments/` or `docs/baselines/`. Paths that begin with `<study data>` or `<tools>` were on the author's own
> machine and are in neither.

## The question

A world's art (heroes, people, creatures, bosses, the objects drawn over the maps and the item icons) is painted with
FLUX 3 Klein on the GPU (`docs/world-art.md`). Each asset is painted on a chroma-key backdrop Luna picks, keyed out,
checked by Luna's checker, and repainted until it passes.

The author asked to move this to GPT Image 2.5:

- **Cost:** through the Batch API at half price.
- **Resolution:** the best trade between quality and price, per kind of asset if needed.
- **Animation:** walks stay on GPT Image 2.6's GIF mode.

The study had $8 for this. It spent $0.33.

## Answer

**GPT Image 2.5 Flare paints the art as well as Klein, at low quality, on its own transparent background, at the
least size it paints, through the Batch API: about $0.0024 an actor and $0.0032 an object or icon.** It is wired in:
pointing `image.sprite` and `image.icon` at an `openai-image` provider switches it on (`genai/images.ts`).

- **Transparency, not the chroma key.** GPT's own alpha is the cut, so the key can never take a subject's colours for
  backdrop.
  - A pale blue-green frog on the green key came out see-through, its body gone, in both chroma-key paintings, and
    whole in all four transparent ones (`img/frog_key_vs_transparent.jpg`).
  - The townsperson on the magenta key kept a magenta fringe in her hair (`img/person_settings.jpg`, second).
- **The least size and low quality.**
  - **Sizes:** actors are painted at 672 × 976 (side views 976 × 672), objects and icons at 816 × 816. This is the
    least GPT Image paints, 655,360 px.
  - **The kept image:** it is trimmed to at most 768 px for actors, 512 for objects and 256 for icons anyway.
  - **What more buys:** Klein's sizes cost 10 to 15% more, and medium quality twice as much. Neither was better at the
    size the game draws them (actors about 82 px tall, icons about 48), nor at full size by eye (the sheets in
    `img/`).
- **Flare, not Sunburst, for batches.** The two looked the same on all six assets of the batch test
  (`img/batch_sunburst_vs_flare.jpg`: Sunburst above, Flare below). Flare's batches came back in 1.5 to 7.5 minutes.
  Sunburst's took 1, 24 and 59 minutes, as long as an hour while the build waits.
- **The checker sees the painting on its key colour.** Luna still picks a backdrop colour for each asset, and the
  checker is shown the transparent painting on it. The checker is calibrated on such backdrops: on grey or white it
  scored the same transparent paintings 2 to 5 points lower (the frog 3.0 on grey and 8.1 on its key).

| | Klein (today) | GPT Image 2.5 Flare, low, transparent |
|---|---|---|
| An actor | 832 × 1216, GPU | 672 × 976, $0.0048 direct, **$0.0024 batched** |
| An object or icon | 1024 × 1024, GPU | 816 × 816, $0.0063 direct, **$0.0032 batched** |
| Cut-out | chroma key, scored for clashes | its own alpha |
| Time | about 10 s of GPU an icon | a batch: 1.5 to 7.5 minutes for the round |

For the art of a small world (about 72 assets, 1.07 attempts each, the October build), that is about **$0.22**
batched. It replaces about 15 GPU minutes of Klein (`docs/baselines/2026-10-30-klein`).

## The default, and the art step rebuilt (13 November)

GPT Image is now the default for the art, with Klein as the backup (`config/genai.example.json`: the art purposes on
the gpt-image provider; the comfyui provider brings Klein back).

**At full size.** Before the switch, the art was checked where GPT's places had failed: up close, at its full kept size
(768 px, which is also what animation starts from). GPT's faces, buckles, cables and patches are as crisp as Klein's,
with none of the melted look of its maps; Klein's are a little more painterly (`img/actors_fullsize.jpg`: Klein above,
GPT Image below).

**Flare against Sunburst, side by side.** Three batches of three paintings for each model were submitted at the same
moment, interleaved, so both met the same load (`batchrace.ts`, `race.jsonl`):

- **Flare:** 2.6, 2.6 and 4.9 minutes.
- **Sunburst:** 1.8, 22.7 and 108 minutes.

Together with the first runs (Flare 1.5 to 7.5 minutes, Sunburst up to 59), Flare's batches have no long tail so far.
OpenAI calls Flare the fast model of the two; nothing is published on batch times.

**The art step rebuilt** (`genai/images.ts`, `worldgen/art.ts`):

- **Two painters.** One interface (`Painter`: canvas, prompt, paint a round, cut) with two implementations:
  `gptImage` and `klein`, chosen by the purpose's provider.
- **One round flow for both.**
  - Every pending asset is painted: GPT Image's in one batch per purpose, Klein's one per GPU turn.
  - Every painting is cut out and checked at once (the checks used to run one after another).
  - The rejects are painted again.
- **Steps side by side.** Each art step (characters, creatures, objects, icons) runs its rounds at the same time as
  the others, so a world's first round is a handful of batches in parallel. Klein's paintings still take their turns
  on the GPU queue.
- **Repairs** run through the same flow. Their batches are noted in the world's assets folder, so a stopped build picks
  up their answers too.
- **Tested.** Six assets ran with GPT Image (165 s, $0.017, all passed on the first try), and two with Klein through
  the same code (25 s of GPU).

## Animation

Animation was already GPT Image's and is unchanged (`anim/job.ts`, `docs/world-art.md`, "Characters in motion"):

- **Clip sheets:** GPT Image 2.5 sheets for the turnaround, attack, hit and death.
- **Walks:** GPT Image 2.6 Sunburst GIFs, through the `image.walk` purpose.

Both go through the Batch API. Nothing in animation runs on Klein. With the art on GPT too, a world uses Klein only if
its places are painted by Klein (the `image.place` purpose turns that off: `../gpt-paint/README.md`), and the GPU only
for Qwen's reading (unless `image.read` is set), SeedVR2, sound and the GPU voices.

## How it was tested

**The subjects.** Seven assets of built worlds, each with the prompt and backdrop Luna wrote for it, painted under
each setting by direct calls (`probe.ts`):

- **From the space world** (`w_6fb9ee2727`, built with Klein): a townsperson, a hostile caster, a boss, the chest, an
  air gauge and a gel flask.
- **From Thimblebrook:** a side-view frog.

**The settings.**

| Setting | Model | Quality | Background | Size |
|---|---|---|---|---|
| keyF | 2.5 Flare | low | chroma key | Klein's |
| keyS | 2.5 Sunburst | low | chroma key | Klein's |
| trS | 2.5 Sunburst | low | transparent | Klein's |
| trSsmall | 2.5 Sunburst | low | transparent | the least |
| trSmedSmall | 2.5 Sunburst | medium | transparent | the least |
| trFsmall | 2.5 Flare | low | transparent | the least |

**How each was judged.** It was cut out as the build cuts it and checked by the build's checker (`results.jsonl`),
then judged by eye beside Klein's kept image, at full size and at game size (`sheet.ts`; `img/*_settings.jpg`, Klein
first).

**The build's own art step.** It then ran on six of the assets of a scratch copy of the space world, once with each
2.5 model, through the Batch API (`buildart.ts`). Every asset passed on its first attempt with both models, for $0.017
a run.

## Prices measured

| Size | Low quality | Medium |
|---|---|---|
| 832 × 1216 (Klein's actor size) | $0.0053 | – |
| 672 × 976 (the least, actors) | $0.0048 | $0.0094 |
| 1024 × 1024 (Klein's object and icon size) | $0.0072 | – |
| 816 × 816 (the least, objects and icons) | $0.0063 | – |

All prices are direct; the Batch API halves them. Flare and Sunburst bill the same. Most of the price at low quality is
the prompt's text, so a smaller picture saves little: 10 to 15%.

## What changed in the code

- **`genai/images.ts`:**
  - `byGpt`: an asset's purpose is on an OpenAI image model.
  - `promptOf`: the transparent sentence in place of the backdrop sentence.
  - `canvasOf`: the least sizes.
  - The alpha cut, and the painting on its key colour for the checker.
  - `gptPaintings`: each round's paintings in one batch per purpose, noted in `.gpt-batches.json` so a stopped build
    picks up its answers. `batch: false` on the purpose calls directly instead.
- **`worldgen/art.ts`:** GPT Image's assets are painted a step at a time (characters, creatures, objects, icons), all
  at once and off the GPU queue, and so are their repairs. Klein's assets stay one per GPU turn.
- **The gateway (`genai/providers.ts`, `service.ts`, `types.ts`):**
  - Paintings take `transparent`.
  - The Batch API takes the generations endpoint (`paintBody`).
  - `providerType` names a purpose's provider type.

## Not tested

- **A whole world's art.** Six assets ran through the build's art step. Heroes, the repair passes' rewritten prompts,
  and batches of 70 or more were not tried.
- **Other art styles.** The subjects come from two worlds, an industrial sci-fi one and a watercolour one.
- **Animating GPT Image's art.** It should behave as Klein's art does, since the sheets start from the kept image, but
  no actor was animated from it.

## Spend

$0.33:

- $0.29 for 42 direct paintings.
- $0.034 for the two batch runs.
- The checks.

Each direct call is in `spend.jsonl`.
