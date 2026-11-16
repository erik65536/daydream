# FLUX 3 Image Klein in the world-building pipeline: a trial, 27 October 2026

> **Kept as a record.** This is the write-up of a finished study. Its scripts (under `packages/server/src/cli/_exp/`), its data and most of the pictures it names were removed for the 1.0 release and are in
> git history at the tag `pre-1.0-experiments`, as are the other studies it cites that are no longer in
> `docs/experiments/` or `docs/baselines/`. Paths that begin with `<study data>` or `<tools>` were on the author's own
> machine and are in neither.

Black Forest Labs released FLUX 3 Image Klein on 15 October 2026: a 5.6B image model that paints from text, edits from
up to ten reference images, and places elements with bounding boxes written into the prompt. ComfyUI supports it
natively. This trial asks whether it can replace or improve the parts of the world build that use the GPU, measured on
the development laptop (RTX 4090 Laptop GPU, 16 GB) against the baseline build of "The Last Light of Vesper"
(`w_f7adb684a0`, report in `docs/baselines/2026-10-27-space/README.md`), on that build's own saved steps.

The baseline spent 161 GPU-minutes: 94 painting the five maps, 45 painting art, 13 reading maps, 9 on mist. Everything
in it after the first 16 minutes waited on the GPU, so GPU time is build time.

## The short answer

Klein is two and a half to three times faster than Krea 2 Turbo at the same picture size, and it paints a whole map
at its full size in one pass with far more fine detail than the current enlarge-and-detail chain. Its layout boxes
place set pieces and exits where they are asked for. Its art is as good as Krea's by the pipeline's own checks. It is
worse than Qwen at reading maps, and it cannot take a style from a reference picture without copying the picture.

| Stage | Baseline GPU min | Recommendation | What it would take with Klein |
|---|---|---|---|
| Whole-place candidates | 26 | **Try further**, likely adopt | Klein paints a candidate in 10–15 s instead of 34–41 s; its wilds are far more on theme, but its towns and dungeons are judged connected less often (see below) |
| Enlarge + detail (SeedVR2, 58 Krea windows) | 31 | **Adopt** | Klein's own candidate resized, then one Klein img2img pass at the map's size (48 s for 2048², 86 s for 3072×2048, throttled); or paint at full size directly (33–47 s for 2048², 330 s for 4096²) |
| Ways out and barrier band | 31 | **Adopt "paint closed, then open the exits"**; try further on built barriers | 11 of 15 closed pictures had no stray opening; exits are then opened by box edit (about 20 s each) |
| Fixes (closing, opening, adding, removing) | in the above | **Adopt Klein's box edit** for adding, removing and reshaping; keep a texture-first patch for closing | 20–25 s per 1024 window against Krea's 30–38 s |
| Art: characters, creatures, objects, icons | 45 | **Adopt** | Same scores (5.83 against 5.87 over 20 assets), 10–12 s a painting against about 30 s |
| Reading: walk and building plans | 13 | **Reject** (keep Qwen) | Klein does not flatten the map into a plan; 61–71% at the labelled points against Qwen's 83–86% |
| A world overview map | – | **Try further** | 28–55 s; places land at their atlas positions, short names are spelled right |
| Style from a reference picture | – | **Reject** as tried | Any reference is copied, layout and all |

The GPU time this could save, against the baseline's 161 minutes, is summed in [What it would save](#what-it-would-save).

## Setup (question 1)

**Files** (from `black-forest-labs/flux-3-image-klein-comfy`, gated; the author downloaded them), in
`<ComfyUI's models folder>`:

| File | Size | Used for |
|---|---|---|
| `diffusion_models/flux3-image-klein-int8-convrot.safetensors` | 5.8 GB | Everything (the distilled model, 16 steps, no guidance) |
| `diffusion_models/flux3-image-klein-base-int8-convrot.safetensors` | 5.8 GB | The base model (50 steps, CFG 3.5), compared once |
| `diffusion_models/flux3-image-klein-bf16.safetensors` | 11.1 GB | Precision comparison |
| `text_encoders/qwen3vl_4b_int8_convrot.safetensors` | 4.9 GB | Klein's text encoder |
| `vae/flux2-vae.safetensors` | 0.3 GB | The image autoencoder |

The prompt expander (`qwen3.5_9b_flux3_prompt_upsampler`, also downloaded) was not used: the pipeline's prompts are
already full captions written by Luna. ComfyUI 0.43.0 has the model built in (commit `20b46065`, "Support Flux3-image")
and ships the official templates (`image_flux3_klein_*`); no custom node or Python package was needed. The workflows
here are built in ComfyUI's API format by `packages/server/src/cli/_exp/klein/lib.ts`, and the art pipeline's
workflow is `config/comfyui/klein_cutout.json`.

**Licence.** The FLUX Kommunity License is non-commercial, with an exception for commercial output by users with less
than US$5M a year in revenue. That needs a look before Klein ships in production.

**Things the brief said that turned out differently.** ComfyUI's layout node (`Flux3LayoutPrompt`) only appends a JSON
list of boxes to the prompt; there are no "keep, move, new, remove" rows in it. Those rows exist in the model's own
prompt format for edits (`from`, `src_bbox`, `tgt_bbox`; a `null` target removes), which this trial writes directly.
Boxes are `[top, left, bottom, right]` on a 0–1000 grid.

**Time and memory.** Times are GPU seconds from ComfyUI's own start and finish stamps. The laptop throttles as it warms
(78–79 °C, the core clock down from 3.1 GHz to 930 MHz, driver reason "thermal slowdown"), so the same picture took
40–50% longer later in the day than at the start; the first table below was measured cool.

| Size | Pixels | Seconds (16 steps) | Peak GPU memory |
|---|---|---|---|
| 1024×1024 | 1.0 MP | 7.5 | 9.9 GB |
| 1536×1024 | 1.5 MP | 10.4 | 10.4 GB |
| 1440×1440 | 2.0 MP | 13.0 | 10.3 GB |
| 2048×1360 | 2.7 MP | 18.5 | 11.1 GB |
| 2048×2048 | 4.0 MP | 33.1 | 12.2 GB |
| 3072×2048 | 6.0 MP | 74.8 | 13.5 GB |
| 2896×2896 | 8.0 MP | 122.3 | 14.9 GB |
| 4096×2720 | 10.6 MP | 179.4 | 16.0 GB |
| 4096×4096 | 16.0 MP | 326.7 | 15.2 GB |

Every size up to 16 MP rendered; time grows faster than the pixel count (attention costs the square of it), and
nothing spilled into system memory. The largest map the game makes, a 4×4 wild place at 4096×4096, is one 5½-minute
pass. `img/setup_sizes.jpg`, `img/sizes_large_crops.jpg`.

- **Load:** the first prompt after another model takes about 6–7 s longer (12.4 s against 6.5–6.8 s at 1 MP), against
  about 25 s for Qwen and 12 s for Krea.
- **Steps:** at 1.5 MP, 4 steps 3.9 s, 8 steps 6.4 s, 12 steps 9.7 s, 16 steps 12.8 s. Eight steps keep the layout of
  sixteen but are a little softer (`img/setup_quality_crops.jpg`); the author judged the difference noticeable, so 16 stays
  the default for anything kept.
- **Base against distilled:** the base model needs 50 steps with CFG 3.5: 63 s at 1.5 MP, five times the distilled
  model, with no visible gain. Not worth using.
- **int8 against bf16:** the pictures are nearly identical pixel for pixel (`img/setup_quality_crops.jpg`), and bf16 is
  twice as slow (20.7 s against 10.3 s at 1 MP, 98.6 s against 43.9 s at 4 MP, both first loads) and needs about 5 GB
  more. int8 it is. NVFP4 needs a Blackwell GPU and was not tried.
- **Sharing a text encoder with Krea:** Krea loads the same Qwen3-VL-4B (as an fp8 file); Klein given that file paints
  nearly the same picture as with its own (`img/setup_quality_crops.jpg`, right pair). If both models were kept, they
  could share it.

**Krea against Klein in the same state.** Because absolute times drift with heat, both models were run alternately,
three rounds, at 79 °C (`calibrate.ts`, `data/calibrate.json`):

| Same prompt, same GPU state (median of 3) | Krea 2 Turbo | Klein | Klein faster by |
|---|---|---|---|
| Whole-place candidate, 1504×1008, model loaded | 41.1 s | 14.9 s | 2.8× |
| The same, Klein at 8 steps | – | 7.7 s | 5.3× |
| First prompt after the other model | 47.3 s | 22.3 s | – |
| Masked repaint of a 1024 window at 0.3 | 28.6 s | 10.7 s | 2.7× |
| A full 2048×2048 map | – | 46.4 s | (about one Krea candidate) |

Krea took 34 s per candidate in the cooler baseline build, so the build ran about 20% faster than this table; Klein's
figures scale the same way.

**Staying loaded beside Krea or Qwen** was not measured: it needs ComfyUI driven directly, past the GPU broker's
unloading, and the trial kept to the broker. From the memory peaks (Klein 10–12 GB at 1.5–4 MP, Krea about 10 GB,
Qwen more), the two do not fit together on 16 GB at working sizes; the broker's unload between models stays.

## Whole-place maps from text (question 2)

Klein painted eight candidates for each of the five places from exactly the prompt Krea had (`mapdraw.ts wholePrompt`
from the saved `plan.json`), at the same size (about 1.5 MP), and each was judged exactly as `chooseWhole` judges it:
Luna's view check and Sol's connectivity. Krea's eight keep their judgements from the build. `wholes.ts`;
`img/wholes_base_<place>.jpg`, best first, Krea above and Klein below.

| Place | Connected, Krea / Klein | Theme score, Krea / Klein |
|---|---|---|
| Latchkey (town) | 5 / 0 | 0.64 / 0.77 |
| Shiverglass Flats (wilds) | 2 / 4 | 0.30 / 0.76 |
| Cinderwake (wilds) | 5 / 4 | 0.34 / 0.76 |
| Hollow Nine (dungeon) | 8 / 2 | 0.91 / 0.92 |
| Choir Spindle (dungeon) | 2 / 0 | 0.72 / 0.68 |
| **All** | **22 / 10 of 40** | **0.58 / 0.78** |

- **Neither model painted a steep view**: no candidate was judged steep, and Luna's "hidden ground" was 0.06 on
  average for both.
- **Wild places: Klein is clearly better.** Shiverglass Flats is a field of shattered dark glass with the drill-marker
  rings of its plan; Krea's is a generic dark lake with paths. More of Klein's are connected.
- **Towns and dungeons: Klein draws walled compounds and closed rooms.** Sol's reasons name "enclosed courtyards with no
  open entrance" in Latchkey and "rooms enclosed by continuous walls" in Choir Spindle. Some of those outlines are kerbs
  and railings, but most yards are drawn closed. Klein's dungeon also fills the whole rectangle with rooms, where
  Krea's floats bold chambers in darkness, a stronger silhouette.
- **Klein writes names on the map.** It renders text well, so the plan's building names ("Patchbay Workshop",
  "Nera's Inn") appear as labels despite "no text, no labels". The house rule that the painter gets appearance, not
  names, matters even more for Klein.
- **Klein frames the place itself**: almost every candidate has its own surrounding wall, often in a strip of forest,
  though the prompt says the painting fills the picture edge to edge.

A second round had Luna rewrite each plan with every name replaced by a description of the thing, and added one
sentence that every yard and room opens onto the routes through wide gaps (`--denamed --suffix`): 11 of 40 connected,
no better (`img/wholes_open_<place>.jpg`). The closed compounds are Klein's way of drawing a town, not something one
sentence changes; laying the main routes out as boxes is the stronger lever to try.

## Control with layout boxes (question 3)

**Exits and the barrier band** (`control.ts frame`, `img/frame_<place>.jpg`): the band was asked for as one box per
stretch of edge, broken round each way out, and each way out as a box running into the place; at the build's planned
exits and at moved ones (another side, a third of the way along, plus one more opposite). Thirty pictures at whole-map
size, checked as `checkAndClose` checks a finished map (Sol on a crop of each exit; Sol's review for unplanned
openings).

| | Pictures | Exits asked | Judged open | Band closed | All exits open and nothing extra |
|---|---|---|---|---|---|
| Planned exits | 15 | 18 | 12 | 5 | 3 |
| Moved exits | 15 | 33 | 26 | 8 | 6 |

- **Exits land where asked.** On four places, 38 of 42 exits were judged open at their side and spot. Choir Spindle
  scored 0 of 9, but by eye Klein drew a corridor through the wall at every tick; each ends in a doorway-like gap in the
  thick dungeon wall, which Sol would not call open (a doorway is also the wrong look for a way off the map).
- **The closed band is the weak part:** only 13 of 30 were judged closed, the rest with a stray lane or two carried off
  an edge. The plan's own words cause some of it (Latchkey's plan says lanes "continue through gaps in the enclosing
  bulkhead").

**Paint closed, then open the exits** (the author's idea; `control.ts frame --variants closed,edge,free`,
`img/frame_<place>_closed_edge_free.jpg`). Three more variants, three seeds per place, the same seeds in each:
"closed" (one unbroken band, no exits), "edge to edge" (one box over the whole picture saying the place runs on past
every edge, no wall, border or surrounding land) and "free" (the build's prompt with nothing said about the edge).

| Edge asked for (15 pictures each) | Closed with no stray opening | Connected inside |
|---|---|---|
| **Closed** | **11** (both dungeons 6 of 6) | **8** |
| Edge to edge | 4 | 5 |
| Free | 3 | 5 |
| Planned or moved exits (above) | 13 of 30 | 12 of 30 |

- **The inside hardly changes with the edge.** For a given seed, the layout of Latchkey or Cinderwake is nearly the
  same closed, edge to edge or free; only the outer strip differs. Asking for a closed edge does not disturb the place.
- **Klein will not paint edge to edge.** Even the whole-picture box did not stop it framing the place, usually with
  forest. Closed turns that frame into the barrier (rubble rock round Cinderwake, the bulkhead round Latchkey).
- So the route is: paint the place closed, then open each exit with Klein's box edit (it opened a clean lane through
  Latchkey's wall in the fixes below). A stray opening, when there is one, is closed with the texture-first patch.

**Set pieces** (`control.ts pieces`, `img/pieces_<place>.jpg`): a plaza, a gate and an arena (described by look, in
the place's own materials) asked for in three cells of a 3×3 grid, two arrangements per place, two seeds; Luna said
where each one is.

| Set piece | In its box | In or next to it |
|---|---|---|
| Plaza | 18 of 20 | 19 of 20 |
| Arena | 17 of 20 | 20 of 20 |
| Gate | 13 of 20 (4 missing) | 16 of 20 |
| **All** | **48 of 60** | **55 of 60** |

This is the control the project has lacked: the plan can say where the boss arena, the plaza and the gate go, and the
painter lays out the rest round them. Each fills its box closely (Latchkey's sheet shows it best). A gate, a thin thing
across a route, is the hardest.

## Large maps (question 4)

`img/latchkey_direct_vs_build.jpg`, `img/sizes_large_crops.jpg`, `img/large_<place>_crops.jpg`.

- **Painting at full size directly gives the most detail by far.** Latchkey at 2048×2048 from text in 33 s (46 s
  throttled) is crisp at 100%: pipes, grates, crates, roof plates. The build's detailed map after SeedVR2 and 58 Krea
  windows is soft, and nearly the same as SeedVR2 alone: the detail pass at strength 0.3 changes little.
- **Starting from Krea's picture keeps Krea's softness.** Klein re-painting at full size with the build's small
  candidate as the reference (`refup`, 71 s for Latchkey, 112 s for Choir Spindle at 3072×2048), and one-pass img2img
  over the SeedVR2 enlargement (0.3 or 0.45, with or without the reference, 48–111 s), all keep the layout exactly and
  sharpen a little, but add little detail. They beat the 58-window pass on time and on drift, but not on detail.
- **A reference is copied closely**, layout and all: Klein given Krea's finished map reproduces it almost exactly at
  full size and a little crisper (`img/style_latchkey.jpg`, `img/style_other.jpg`).
- **Scale does not hold by itself.** A larger canvas does not paint the same place finer: it paints more, slightly
  smaller things, and at 16 MP the picture is flatter in light and contrast. Painting at the map's own size from a
  prompt that gives its size in metres works at 4–6 MP; above that the scale needs checking against the character.

**Klein's own candidate keeps its crispness when enlarged** (`large.ts --source klein`,
`img/large_klein_<place>_crops.jpg`). Starting from Klein's best whole-place candidate (1232 px for Latchkey):

- A plain Lanczos resize to the map's size is already sharp at 100%: Klein draws clean edges, and they enlarge well.
- Img2img at 0.45 over that resize adds real detail and keeps the layout: 48 s for Latchkey (2048²), 86 s for Choir
  Spindle (3072×2048), throttled. At 0.6 it begins to redraw buildings.
- Re-painting with the candidate as the reference (70 and 111 s) is about the same as the resize: a faithful copy.

So two routes replace SeedVR2 and the 58-window detail pass (31 GPU-minutes in the baseline):
1. **Candidates small, then one pass at full size:** eight Klein candidates at 1.5 MP, judged as now, then one img2img
   pass at the map's size at about 0.45. About 2 minutes of candidates and under a minute (2048²) to two and a half
   minutes (3072²) for the pass.
2. **Paint at full size directly**, if full-size candidates can be judged cheaply: one 4 MP map costs about three 1.5 MP
   candidates.

The first keeps the cheap choice among eight and gets most of the detail; it is the one to build first.

## Fixes by editing (question 5)

Six repairs on the baseline's own maps, each on a 1024 window round the problem and pasted back only inside its box
(`fixes.ts`, `img/fixes.jpg`): Klein editing the window with box rows and no mask; Klein's masked repaint with the
window as its reference; Krea's masked repaint as the build makes its repairs.

| Fix | Klein box edit | Klein masked | Krea masked (build) |
|---|---|---|---|
| Open Cinderwake's blocked left exit (a real failure of the build) | no: it recast the wreck as a long vehicle | no | yes (an odd watery crossroads) |
| Close Latchkey's right exit | partly | partly | no |
| Open a new exit at Latchkey's top | yes | no | yes |
| Add a refuelling station to the empty dock (Sol's complaint) | yes, 0.96 | no, 0.08 | yes, 0.91 |
| Remove a cart from the plaza | yes, 0.93 | no, 0.24 | yes, 0.94 |
| Widen the walkway round Hollow Nine's shafts (Sol's complaint) | yes, 0.72 | no, 0.07 | no, 0.03 |
| GPU seconds per fix | 20–27 | 18–20 | 34–38 (includes loading Krea) |
| Change outside the box before pasting (0–255) | 5–8 | 1.6–2 | 1–1.6 |

- **Where Klein's box edit works it is the best of the three**: the refuelling station is crisp and in the dock's
  style, the cart is gone with the paving continuing, the shafts shrink inside a proper walkway.
- **Klein's masked repaint copies its reference** and ignores the change; as set up here it is a dead end.
- **The box edit redraws the whole window slightly** (a mean change of 5–8 outside the box), so its result must be
  pasted back inside the box, as here.
- **Closing an exit is the hard direction for every method.** The author read Klein's two closings as partly closed:
  something that could pass for wall, not a clean barrier.

**Closing with the barrier texture laid first** (the author's follow-up; `close.ts`, `img/close.jpg`): as
`closeOpening` does, the build's own barrier texture is pasted into the band at the opening, then the patch is
repainted, on Latchkey's right exit (a station bulkhead) and Hollow Nine's top exit (bedrock).

| Method | Hollow Nine (rock) | Latchkey (bulkhead) | GPU s |
|---|---|---|---|
| Klein box edit on the pasted window | closed: a clean block of bedrock | not closed (the lane mostly kept) | 14–23 |
| Klein masked, 0.6 | closed (odd built pieces) | not closed | 8–9 |
| Klein masked, 0.85 | closed (odd built pieces) | not closed (by eye, a wall across the lane) | 8 |
| Krea masked, 0.85 (the build) | closed | not closed | 35–38 |

Sol's reasons on Latchkey point at gaps elsewhere along the window's edge ("exposed ground along the upper-left
border"), so that verdict is partly about Latchkey's own lit, gappy bulkhead. On a natural barrier, the texture plus
Klein's box edit closes cleanly; on a built one, none of the methods is reliable yet. Painting closed in the first
place avoids most of the need.

## Art (question 6)

The build's own art pipeline (`produceAssets`: chroma-key backdrop, BiRefNet's mask, the cut-out, Luna's score, up to
three tries) with Klein as the painter, from the baseline's saved image prompts and backdrops, so only the painter
differs (`art.ts`, `img/art_s16_a.jpg`, `img/art_s16_b.jpg`): five people and heroes, four creatures, two bosses,
three objects, six icons.

- **The same quality**: Luna's mean score 5.83 for Klein against 5.87 for Krea; Klein better on 8, worse on 10, the
  rest within 0.3. Klein needed 26 paintings for the 20 (4 assets retried).
- **Nearly three times as fast**: 10–12 GPU s a painting with its cut-out, against about 30 s.
- **By eye:** Klein's creatures are more convincing (the archer drone, the harvester, and the swarm, which finally
  reads as a swarm of small drones). Its figures are more rendered, close to 3D, with a more uniform teal-and-rust
  palette: consistent as a set, less varied. Krea's icons are bolder and read better small. The cut-outs from Klein's
  flat backdrops are clean.

**Nine icons on one sheet** (`icons.ts`, `img/icons_compare_2048.jpg`): one 2048 picture with nine boxes on flat
green, 50 s, plus 13 s to cut all nine out with BiRefNet, about 7 s an icon. But the items did not keep to their own
boxes: the mining suit landed in the med patch's cell, the toolkit appears twice, and some items are missing. A Luna
pass matching cells to items would rescue part of it. Try further; painting icons one at a time at about 10 s each is
the simple win.

## A world overview map (question 7)

`world.ts`, `img/world_view.jpg`: the five places at their atlas positions (`zones[].mapPos`) as boxes, routes between
linked places, the region's description and the world's art style, 2048×1360.

- **It works:** each place lands at its position, dotted routes join them, a swollen red star hangs over the belt.
- **Short names are spelled right** (Latchkey, Shiverglass Flats, Cinderwake, Hollow Nine, Choir Spindle and Pale
  Door); the long description and the title come out as garbled lettering. The game should write labels itself.
- **With the five finished maps as references** (51–55 s), Klein draws each place as a small inset of its actual map: a
  "map of maps" that matches the game exactly. Without references (28–36 s) the view is a slanted three-quarter one.

## Reading maps (question 8)

Klein's editing was asked for the reader's four plans (`mapread.ts WALK_READINGS` and `BUILDING_PLAN`) on the five maps
the walkability study labelled, at the same sizes, and scored at the 400 labelled points next to the Qwen pictures that
study saved, with the reader's own pixel rule (`read.ts`, `img/read_plain.jpg`).

| Reading | Qwen strict | Klein strict | Klein: no answer |
|---|---|---|---|
| Three-colour plan, 2.4 MP | 86% | 68% | 6% |
| Walk mask, 1.4 MP | 85% | 71% | 8% |
| Pathing mask, 1.4 MP | 83% | 70% | 12% |
| Building plan, 1.4 MP | 84% | 61% | 12% |
| Vote of the three walk plans | 87% | 80% | 1% |

- **Klein does not flatten the map.** Qwen paints clean flat plans; Klein keeps much of the painting's texture and
  outlines with the colours laid over them, and 6–12% of its pixels are off the plan's palette.
- **Slower here too:** 57 s at 2.4 MP and 29 s at 1.4 MP (the reference doubles the work), against Qwen's 21–23 s with
  its model loaded. Klein's model switch is cheap (about 6 s against Qwen's 25 s), which does not make up for it.
- **The labelled points sit on edges.** Counting a reading right when the label's answer is within 0.5 m of the point,
  every reader, Qwen and Klein alike, scores 91–100% on almost every map: most of the 400 points lie within half a metre
  of an edge, as the author suspected, so the strict score largely measures where an edge falls. A set of points well
  inside clear areas would be a better test for future reader work.

**Prompting and references** (at the author's question; `read.ts --style caption`, `--fewshot`, `--swatch`), all on
the walk-mask prompt at 1.4 MP:

| Variant | Strict | Off-palette | GPU s |
|---|---|---|---|
| Qwen (for comparison) | 85% | 2% | 21–23 |
| Klein, the reader's prompt as it is | 71% | 8% | 29 |
| Klein, worded as a caption of the plan | 73% | 7% | 20–27 |
| Klein, an example map and Qwen's plan of it as references | 51% | 1% | 62–74 |
| **Klein, a drawn swatch** of flat white, black, blue and red shapes as the style reference (the author's idea) | **77%** | 3% | 30–32 |

The swatch made Klein's plans much flatter (the city and the dungeon look nearly like Qwen's,
`img/read_swatch.jpg`), but it still painted the gingerbread town's candy pattern through its streets and drew
Brinewake's marsh water as walkable. The example pair made Klein copy the example's layout into the target, as in
the style tests. Reading stays with Qwen.

## Style (question 9, at the author's request)

The author pointed out that Klein looks more drawn than Krea, which makes it look lower in quality, and asked how far its
style can be steered (`style.ts`, `style2.ts`; `img/style_latchkey.jpg`, `img/style_other.jpg`, `img/style2.jpg`).

- **A style sentence barely moves it.** Latchkey with its plan's style, the same without the inking, a soft painterly
  description written to match Krea, and heavy painterly brushwork came out nearly the same at one seed. The rest of
  the caption (a tabletop battle map of an industrial station) sets the look.
- **Across themes it is not one style.** The gingerbread town comes out soft and painted, close to Krea's; the drowned
  temple dark and moody; the frozen wilds nearly photographic (and slanted, with a skeleton in the middle).
- **A reference picture is copied, not borrowed from.** Krea's whole map as a "style reference" was reproduced, layout
  and all. The author's idea of a small sample instead: one 512 px crop had no visible effect; a sheet of four crops was
  painted as a map of its four quadrants; another place's map made Klein copy that place's layout. Steering Klein's
  look would need a style LoRA, not a reference.

# Round two, 28 October 2026

The author reviewed round one and asked for six more things: an audit of the "connected" check they doubted, many more
maps, a wide range of styles, a fair comparison of the ways to make a large map, transparency, and (dropped after
discussion) a style LoRA. Along the way the author spotted that the build's own prompt names trees, which explained
several round-one findings. Each part below says what was run, what it showed, and what it changes above.

## The prompt names trees and streets in every world

Round one used "the free prompt" for most map tests: the build's whole-place prompt (`mapdraw.ts wholePrompt`) with
only the edge-to-edge sentence removed. For Latchkey, in full:

> A top-down game map seen from high above, looking almost straight down like a tabletop battle map: roofs, treetops
> and the ground between them are in plain view, and every street, path and open space is clearly visible. No horizon.
> The whole of Latchkey in one picture, the entire place seen at once from high above, about 51 by 51 metres across, so
> everything in it is small and there are many of each thing: A cramped 51 m square settlement fills one exposed
> station module, with a large octagonal refueling cradle dominating the middle and slightly left. Its open service
> apron and broad pipe-fed approach make it the unmistakable heart of Latchkey. A crooked main aisle loops around the
> cradle and branches into smaller lanes, all plainly visible and at least 1.5 m wide. Upper left holds Patchbay
> Workshop beside the compact Dock Drill Bay; upper right has Tallow's Useful Things and a water-still nook. Lower left
> gathers Nera's Inn around a shared hot-water counter. Lower right holds Bex's Shop, Kett's Safe End, and Piri's
> Workshop. A public scrap exchange occupies a small open court just below the dock: sorted salvage heaps ring a clear
> central patch. About nine low, distinct roofed pods and work sheds sit off the routes, with open aprons and no hidden
> paths. Short cross-aisles connect all four quarters to the central loop; three broad, clear floor lanes continue
> through gaps in the enclosing bulkhead. Open, walkable station decking in scuffed grey-green metal plates,
> interrupted by mismatched pressure-seal strips, bolted repair patches, narrow amber floor guides, grated service
> trenches, and visibly capped pipe runs. The central dock apron has broad circular fuel couplings, hose loops, drain
> grates, and scraped arcs in the plating. Scatter small sorted piles of salvage, loose washers, cable coils, tool
> trays, canisters, and patched seal panels in work zones only; keep every aisle broad, uncluttered, and visible.
> Roofed pods have distinct top-down patchwork roofs and clear open paved aprons, never hidden walkways. Every area is
> joined to the others by open paths, streets or corridors: one connected network with no cut-off rooms or areas. Art
> style: Illustrated 2D sci-fi tabletop map, almost straight-down view, crisp inked outlines and hand-painted worn
> industrial detail. Muted rust, dirty steel grey, deep teal, and tired amber lamps; hard pools of shadow, scratched
> plate edges, repaired seams, and delicate pipework. Lonely, cramped, lived-in atmosphere beneath sickly amber station
> light; no lettering.. No grid, no text, no labels, no people, no creatures.

None of the five space plans mentions a tree; the trees come from the fixed lead-in (`LEAD` in `mapdraw.ts`), which
says "roofs, treetops" for every town and "the tops of trees and rocks" for every wild place, in every world. The fixed
text also names streets (the town lead-in, the joining sentence "open paths, streets or corridors", the plan writer's
example of a "main street", the exit texture "joining the streets"), which is why an office-building world had
streets. The double full stop after the style is a small bug: the plan's style already ends with one.

`lead.ts`, `img/lead_space_z_t0_0.jpg`, `img/lead_space_z_w0_0.jpg`: the same seeds with a lead-in that names no trees.

- **The forest frame was ours, not Klein's.** With the build's lead-in Klein framed Latchkey in forest at all four
  seeds; without the tree words the forest is gone, the layout is nearly unchanged, and the station runs out to its
  own bulkhead. Shiverglass Flats and Cinderwake lose their conifer rims the same way. Krea drops its patches of
  greenery too. Round one's "Klein will not paint edge to edge" and "Klein frames the place itself" are withdrawn: it
  was painting the treetops it was asked for.
- A third variant names nothing at all in the fixed text (no roofs, streets or corridors: "all the ground a person can
  walk on is clearly visible", "joined to the others by open walkable ground"), for every kind of place.
  Judged at full size on the space and coast worlds (`lead.ts`, two seeds each, `data/klein/lead`): like the
  tree-free lead-in it drops the forest frame and leaves each seed's layout nearly unchanged, in towns, wild places
  and dungeons alike, so it can replace every kind's lead-in. Names from the plan are still written as labels.

The general fix is to make every fixed sentence in `mapdraw.ts` name no things and leave the things to the plan.

## Is "connected" right? An audit

The build keeps the candidate Sol (the stronger OpenAI model) calls connected, asked on the picture shrunk to 1024 px
whether every area can be walked to. In round one Sol called 22 of 40 Krea candidates connected and only 10 of 40
Klein ones, and the author doubted the check. `connect.ts` measured reach directly instead: the build's own walk reader
(Qwen's second walk plan, 1.4 MP) read on 0.5 m cells; walkable regions of at least 4 m² are counted, and the share of
walkable ground outside the largest region is ground a player could not reach. A roofed building or a machine reads as
solid, so it never counts as a cut-off area. Each candidate was also put to Sol twice more: the build's question again
(is the answer stable?) and a reworded one that tells Sol to ignore scenery (roofed buildings, machines, ponds,
enclosures) and low edges (kerbs, lines, steps).

Per world, Sol's "connected" count, the candidates the walk plan finds sound (under 2% of the walkable ground cut
off) and the mean share cut off (`audit_<world>.json` in `data/klein`):

| World | Sol connected, Krea / Klein | Walk plan sound, Krea / Klein | Mean cut off, Krea / Klein |
|---|---|---|---|
| Space (40 each) | 22 / 10 | 23 / 8 | 7.4 / 25.4% |
| Coast (64 each) | 37 / 31 | 32 / 14 | 16 / 23.8% |
| Wood (40 each) | 29 / 12 | 25 / 16 | 7.8 / 10.3% |

- **Sol is a poor judge of "connected"**: its answers and the walk plan's disagree on many candidates, in both
  directions. Choosing a candidate should use the walk reader itself.
- **By the reader, Klein's towns and dungeons are cut up more than Krea's**, as Sol said, but less than Sol said in
  the woodland world.
- **One reading is noisy.** The same map read again with another seed (1.4 MP) agrees with the first only as well
  as a reading at half the size does: walkable cells overlap 0.72 against 0.69–0.72, the "sound" verdict agrees on
  79–86% of candidates, and the two readings choose the same candidate in only 2 of 5 space places and 2 of 8 coast
  places (`sizes.ts`, `img/sizes_coast.jpg`). Reading at 0.7 MP is as close to 1.4 MP as a second 1.4 MP reading
  is; 0.4 MP is worse and sometimes reads no walkable ground at all. So a candidate should be chosen on the build's
  full reader (three plans combined), or on two or more readings, never on one.

## Many more maps (variety)

Klein painted eight candidates for each of the 13 places of two more worlds, a coastal one (`w_d6283243c5`, 8 places)
and a woodland one (`w_f9a22f8b9c`, 5 places), from the build's own prompts, judged exactly as `chooseWhole` judges,
next to the eight Krea candidates each build kept (`wholes.ts --world`, `img/wholes_coast_<place>.jpg`,
`img/wholes_wood_<place>.jpg`).

| World | Sol "connected", Krea / Klein | Places with a sound candidate, Krea / Klein | Theme, Krea / Klein | Hidden ground, Krea / Klein |
|---|---|---|---|---|
| Coast (8 places, 64 each) | 37 / 31 | 8 / 7 | 0.76 / 0.82 | 0.16 / 0.29 |
| Wood (5 places, 40 each) | 29 / 12 | 4 / 4 | 0.75 / 0.83 | 0.11 / 0.09 |

("Sound" is the build's test: connected, not steep, detailed. The build only needs one sound candidate per place.)

- **Klein's candidates vary; Krea's barely do.** For most places Krea's eight are one layout repeated with small
  changes (Bellroot Burrows and Veyr show it best); Klein's eight are eight different places. Eight Krea candidates are
  close to one candidate with eight chances at the judge; eight Klein candidates are a real choice.
- **Klein is on theme more often** in both worlds, as in round one.
- **Klein paints coastal towns steeply.** On Veyr seven of its eight were judged steep, with 51–94% of the streets hidden
  behind buildings (Krea 9–59%); the Cathedral of Saint Orra two of eight. No woodland candidate was steep, and none in
  the space world. Something in those towns' plans or style asks for a three-quarter view; it needs looking at with
  the raw prompts before blaming the model.
- **By Sol's count Klein is weaker on dungeons and burrows** (Bellroot Burrows 0 of 8, Frostglass Grotto 1 of 8,
  Bellfoundry 0 of 8), yet by eye many of those burrows look joined by their tunnels; the audit above is the better
  measure.

## Style range

The author asked whether Klein can paint the looks an owner might ask for: watercolour, painterly, claymation,
photographic and so on. `style3.ts` swapped only the style sentence of the build's map prompt (with the tree-free
lead-in) for eight styles on a town, a wild place and a dungeon from the three worlds, at two seeds
(`img/style3_<world>_<place>.jpg`, 100% crops `_crops.jpg`).

Three ways of asking for a style were compared at the same seed, for claymation, a drone photograph, pixel art and
low-poly, on Latchkey, Brackenway and the Sinking Royal Quarter. The author judged them at full size
(`data/klein/stylefull_<world>_<place>.jpg`, 1232 px per map; small sheets `img/style4_*.jpg`, `img/style5_*.jpg`):

| Way | What it is | The author's verdict |
|---|---|---|
| Style sentence swapped (`style3.ts`) | The build's map prompt with only "Art style: …" replaced | Works, but the style could be stronger |
| Short prompt (`style4.ts`) | Lead-in, the place's name, the plan's first sentence, the style, the tail | Bad: the style is so strong that the picture stops being a game map |
| Ground rewritten in the style (`style5.ts`) | Luna rewrites the plan's ground paragraph so every surface is described in the style ("smooth grey-green modelling-clay plates, softly scuffed with faint fingerprints"), and a matching style sentence | **Best**: the style holds and so does the game-map layout |

Two smaller findings: moving the style sentence to just after the lead-in, or giving it at both ends
(`_position.jpg`), made no visible difference; and dropping the ground text altogether moves the look part of the way
but loses the place's materials (Latchkey loses its metal). My first reading of the small sheets, that the rewrite
changed little, was wrong; at full size it is clearly the best of the three.

**Recommendation:** when an owner's style is far from the default illustrated look, have Luna write the plan's ground
paragraph in that style's own terms (one extra Luna call per place, or better, ask the plan writer to describe the
materials in the world's style in the first place). The layout text stays as it is.

- **Art has not been tried this way yet.** Jessa Rill and the chest through the build's art pipeline with only the
  style sentence in front of their saved image prompts (`img/style3_art.jpg`) come out as nearly the same
  semi-realistic render in every style. The same rewrite (describe the character's materials and surfaces in the style)
  is the obvious next test.

A style LoRA was discussed and dropped as not worth it.

## Large maps, again

The author doubted round one's verdict that img2img over the resized candidate beats re-painting with the candidate as
the reference. `large.ts --source klein` was rerun from Klein's own best candidate on four places, now with direct
painting at full size too (`img/large_klein_<place>_crops.jpg`; columns: the candidate resized, reference re-paint,
img2img at 0.45 and 0.6 without and with the reference, direct).

- **The reference re-paint is the faithful one,** crisp and true to the chosen candidate, as the author expected.
- **Plain img2img invents.** At 0.45 it already adds new clutter and changes buildings; at 0.6 it redraws them. Img2img
  with the reference ends up nearly the same as the reference re-paint.
- **Direct painting has the finest detail but is a different place**, at a smaller scale; it cannot keep a candidate
  that was chosen.
- Times (throttled): Latchkey 2048² direct 47 s; Hollow Nine reference re-paint 72 s, img2img 49 s, direct 48 s;
  Shiverglass Flats 3072² reference re-paint 195 s, img2img 160 s, direct 154 s.

This reverses round one's recommendation: **choose among small candidates, then re-paint the chosen one at full size
with itself as the reference.** A seed cannot stand in for the reference: the same seed at another size paints an
unrelated layout.

## Cut-outs: smoke, steam, glass and threads

The build cuts art out of one painting on a chroma-key colour (green, blue or magenta, chosen per subject by the
prompt writer): BiRefNet's mask says where the subject is, the key says how opaque its edge pixels are, and the
backdrop is un-mixed from them (`genai/cutout.ts`). Everything inside BiRefNet's mask is solid, so see-through
things keep the key's colour: Klein's campfire smoke comes out blue and a ghost's hem pink. The 20 October cut-out
bake-off did not see this as a problem because it scored every subject as if it were solid; there a matting model
that made a potion's glass see-through was marked down, when see-through glass, un-mixed, is the right answer.

Two other ways were tried first and dropped:
- **Two backdrops** (`alpha.ts`): Klein paints the subject on white, an edit puts it on black, and the difference
  gives the opacity. Klein's edit repaints see-through things (denser smoke with a hard light edge, invented rim
  light), which no solve can undo, and it doubles the painting time.
- **Swapping BiRefNet for a matting model** in the build's cut changes nothing: outside the mask's confident inside
  the cut takes the key's opacity, and the key calls grey smoke solid.

`mattes.ts` compared, on one Klein painting each of 14 subjects (fur, a ghost, a glass potion, smoke, a glowing
lantern, flowing hair, a jellyfish, crystals, a fire spirit, a spider on its thread, a white owl, a steaming teacup,
polished armour and a soap bubble; `img/mattes_<subject>.jpg`, full size):
- the build's cut;
- **the classic chroma key**: a pixel's key strength is how far the key's channel exceeds the others (green:
  G − max(R, B); blue: B − max(R, G); magenta: min(R, B) − G), its opacity 1 − strength ÷ the backdrop's strength,
  the backdrop un-mixed (F = (C − (1−a)·B) ÷ a) and the key's spill clamped, either inside BiRefNet's region or over
  the whole frame (with the usual clip of the backdrop's grain, opacity under 6%);
- the same key with BiRefNet's confident inside kept solid;
- matting models: BiRefNet dynamic-matting, BiRefNet-matting, BiRefNet_HR-matting, RMBG-2.0 and Lucida, alone and
  through the build's cut with the lower of their opacity and the key's.

**The classic key over the whole frame is the best cut-out.**
- See-through things come out right: grey smoke that thins to nothing, the teacup's steam, clear glass, the soap
  bubble see-through with its colours. It is the only method that keeps the spider's silk thread and the steam,
  both of which BiRefNet leaves outside its mask.
- Solid subjects are as clean as today's cut: fur, hair, the owl's white feathers, the armour, the crystals.
- It needs no model at all (BiRefNet becomes unnecessary) and about a second of CPU.
- **Its weakness is a subject that carries the key's own hue.** A lavender ghost on magenta has a magenta
  component in its own colour, and its hem comes out teal once the spill is clamped; the mage's grey-green cloak on
  green loses a little. The prompt writer already picks the key the subject uses least; with this cut that choice
  matters more (green would suit a pale-blue ghost). The backdrop's grain leaves a few faint specks.
- **The spill is removed along the backdrop's own hue, on see-through pixels only.** Klein's hot magenta is far
  redder than it is blue, and what shows through glass or steam is painted as a lighter pink with even more red
  than a true mix. The classic clamp (min(R, B) ≤ G) evens red and blue only, which left the potion's glass and the
  steam pinkish. Removing any colour along the backdrop's hue (its colour minus its grey) from pixels that are not
  fully opaque makes them neutral; solid pixels keep their colour, so the red cork stays red. On green and blue keys
  it changes almost nothing.
- The key with BiRefNet's inside kept solid is worse: the smoke turns solid, the ghost's hem red, the bubble grey.
- The matting models help where the key does not reach and nowhere else: alone they over-correct the colour
  (a teal ghost and potion), through the build's cut they keep some of the key's tint, and none keeps the thread or
  the steam.
- The two new matting models and RMBG-2.0 add nothing over the key; RMBG-2.0 behaves like BiRefNet (solid smoke).

**Built in** (`genai/cutout.ts`; `docs/world-art.md` describes it): the art workflows no longer run a cutter. The score
no longer counts see-through parts as missing; it rejects a backdrop too dull to key and a clash, a subject carrying
the key's own hue, which un-mixing turns into the key's opposite (the teal ghost: 3.6% of its opacity, against at
most 0.6% for the other 13 subjects; the limit is 2%). The prompt writer now picks the key a see-through subject's
tint uses least, where it used to pick the nearest. Ten real assets of the space world through the art pipeline
with Klein (`art.ts --tag key`) cut cleanly, with no fringe; two findings came from them: Klein paints the keys
muted in a desaturated style (magenta about (223, 87, 137)), so the "too dull" limit is a key strength of 25, not
50; and the baseline had put a green glass icon on green under the old rule, which the key turns clear and grey,
a case no colour score can see.

## Coast towns painted at a steep angle

On Veyr seven of eight candidates were judged steep, and the Cathedral of Saint Orra two of eight. The lead-in is not
the cause: with the lead-in naming nothing Veyr stays a three-quarter view. `view.ts` tried the prompt, always with
that lead-in, on the same seeds, judged by the build's view check (Luna: how much front face shows, whether walkable
ground is hidden; steep = large fronts and hidden ground).

- **Taking words out does nothing.** Veyr's plan, unlike the flat towns', has "steep-roofed houses", "amber window
  lamps", "finely brushed roof tiles" and "storybook realism". Removed one after another (four seeds), the paintings
  barely change: each seed paints nearly the same town at the same angle. One general sentence, "Everything is seen
  from directly above: only the tops of things show, never their sides", did nothing either.
- **Adding words does** (two seeds each, after the lead-in): "An orthographic overhead view with no perspective, like
  a satellite image: the camera points straight down" took Veyr from 2 of 2 steep (hidden ground 0.92) to 0 of 2
  (0.20). Describing roofs as flat shapes split by ridge lines also helped, but names things only towns have; a
  classic RPG map, a site plan and a flat map style helped less; "not isometric, no perspective" did nothing.
- **The two general additions on six places** (`data/klein/view/`): the orthographic sentence, and
  the same with "Flat 2D top-down map illustration, " put in front of the place's own style.

| Place | As written: steep, hidden | Orthographic | Orthographic + flat map style |
|---|---|---|---|
| Veyr (coast town) | 2/2, 0.92 | 0/2, 0.20 | 0/2, 0.18 |
| Cathedral of Saint Orra (coast town) | 1/2, 0.80 | 0/2, 0.18 | 0/2, 0.08 |
| Saltglass Causeway (coast wilds) | 0/2, 0.08 | 0/2, 0.14 | 0/2, 0.10 |
| Latchkey (space town) | 0/2, 0.07 | 0/2, 0.07 | 0/2, 0.06 |
| Hollow Nine (space dungeon) | 0/2, 0.07 | 0/2, 0.06 | 0/2, 0.04 |
| Thimblebrook (woodland town) | 0/2, 0.13 | 0/2, 0.16 | 0/2, 0.13 |

By eye the coast towns turn from a tilted three-quarter view to a near-overhead one, more so with the flat map style,
and the places that were already flat are unchanged; the world's style is kept. Pitched-roof cottages (Thimblebrook,
Veyr's houses) still show a little of their fronts, which the view check allows. Both additions name no things, so
they can go in the fixed text for every place.

**Without naming a medium.** The author worried that "illustration" (and "2D") would fight styles that are not
illustrations. `flatstyle.ts` painted style5's four styles (claymation, photograph, 16-bit pixel art, low-poly 3D,
with the ground text rewritten in the style by Luna) on three maps, orthographic only, with "Flat 2D top-down map
illustration, " and with "Flat top-down map, " before the style: the three are nearly identical in every style (the
rewritten ground text carries the style), and all were flat. On the two coast towns "Flat top-down map, " gives
pictures nearly identical to the "illustration" wording (0 of 4 steep; Luna's hidden-ground score varied from 0.15 to
0.49 between near-identical pictures, so it is noisy here). **Recommended fixed text:** the lead-in naming nothing,
the orthographic sentence after it, and "Flat top-down map, " before the place's style. **Built in** (`mapdraw.ts`
`LEAD` and `mapStyle`, every painting prompt); the trial's scripts now build on it, so rerunning them paints with the
new fixed text, not the text their results were measured with.

## Painting art at the size it is kept

The build paints people and creatures on 832×1216 (side views 1216×832) and props and icons on 1024², then keeps them
at most 768, 512 and 256 px tall. `artsize.ts` painted eleven of the space world's assets also nearer the kept size
(people 544×800, props 640², icons 512² and 320²), cut and trimmed as the build does (`data/klein/artsize_<key>.png`).
It saves about a third of the time (people 13–17 s → 8–9 s, props 13–16 s → 9–11 s, icons 11–19 s → 6–9 s; 320² is no
faster than 512², since each painting has about 6 s of fixed cost), but **the author sees a clear loss of quality at the
smaller sizes**, most of all on people and creatures (my first look at reduced pictures missed it). Decision: keep
painting all art at today's size; the few props and icons are not worth the loss either. One by-product: an upright
creature planned as a side view gets a landscape canvas and is kept only as tall as that canvas allows.

## Are full-size paintings' passages wide enough?

Painting directly at full size gives the finest detail but paints more, smaller things, so the worry was that its
passages are too narrow for a character, which would favour re-painting a small candidate at full size instead.
`passages.ts` compared three routes on the space world's four places (Latchkey, Shiverglass Flats, Hollow Nine,
Choir Spindle), twelve maps each: painted directly at full size (three seeds), Klein's three best 1.5 MP candidates
only resized, and the same candidates re-painted at full size with themselves as the reference. Every map was read
by the build's three walk plans, combined and snapped to the painting exactly as `readPlace` does (without Luna's
looks). For a passage width w, a character's centre walks the largest region it can while keeping w/2 from anything
not open, and its body covers that region grown back by w/2; "reach" is the share of the open ground it covers.
0.5 m is the game's own rule (`CLEARANCE`), 1 m a comfortable person, 1.5 m what the plan writer asks for.
(`img/passages_space_<place>.jpg`; green reachable at 1.5 m, yellow at 1 m, orange only at 0.5 m, red cut off.)

| Route | Maps | Open ground (m²) | Reach at 0.5 / 1 / 1.5 m | Reach lost to width, at 1 / 1.5 m |
|---|---|---|---|---|
| Direct at full size | 12 | 1453 | 85 / 82 / 65% | 3 / 23% |
| Candidate resized | 12 | 1539 | 76 / 70 / 61% | 7 / 18% |
| Candidate re-painted | 12 | 1483 | 77 / 70 / 57% | 10 / 23% |

- **Direct full-size paintings are not narrower.** At the game's rule and at 1 m they reach as much ground as the
  candidates or more, and width costs them the least at 1 m. Their passages are as wide as the plan asked.
- **The re-paint does not narrow a candidate either:** re-painted and resized candidates reach about the same.
- **At 1.5 m every route loses about a fifth,** mostly on the wild place, whose trails are painted close to the
  1.5 m the plan asks for and so split at exactly that width. A character is far narrower than 1.5 m.
- **The differences between maps are connectedness, not width:** a map that reaches little at 0.5 m (Choir Spindle's
  candidates, one direct painting of each wild place and dungeon) has whole areas cut off, not tight passages.

So passage width is no reason to prefer the re-paint: painting directly at full size, with its finer detail, is
safe on this sample. Choosing among full-size paintings then needs them read whole (about 100 s of Qwen per map here).

## Built in: the map route, 30 October

The route is now `mapdraw.ts` (described in `docs/places.md`): Luna plans the place, Klein paints it closed at full
size, one painting at a time, each judged by the walk reader (sound when under 2% of its walkable ground is cut off; raised to 4% afterwards by the author
from the main region and the view is not too steep), with Luna rewriting the layout after two failures; then the
exits are cut and unplanned openings closed. `route.ts` ran it on the space world's four places in this checkout
(planned afresh; `img/route_<zone>.jpg`, each painting with its reading and the finished map):

| Place | Size | Paintings | Minutes, start to finish |
|---|---|---|---|
| Latchkey (town) | 2×2 | 1 | 7.2 |
| Shiverglass Flats (wilds) | 3×3 | 1 | 13.5 |
| Hollow Nine (dungeon) | 2×2 | 3 (3%, 9% cut off, then sound after the rewrite) | about 15 |
| Choir Spindle (dungeon) | 3×2 | 4 (8%, 8%, 2% after the rewrite, then sound) | 20.7 |

Against the baseline build's 19 minutes a place (94 for five), the town and the wilds take well under half; the
dungeons, whose walled rooms Klein paints without doorways, take their extra paintings. A whole place's OpenAI cost
was about $0.03–0.05 (Luna's plan, looks, view checks, rewrite and exit descriptions; no Sol).

- **The rewrite trades variety for reach.** After it, both dungeons were painted with fewer walled rooms and more open
  floor: sound, and the author judged Hollow Nine's third painting the most playable, but plainer. The author's call: a
  room nobody can enter counts against a painting, not joined through its wall.
- **Exits** (`exits.ts`, `img/exits_z_t0_0.jpg`): Klein draws whatever a box asks for as a closed object filling it.
  The plan's exit look ("a pale anti-slip strip with amber guide strips") came back as a capsule with a rim across
  its inner end on all six tries of three wordings, and Sol called all six blocked. A box running 4 m deeper, pasted
  back only through the barrier, opened all four tries but looked faded; the author preferred Klein's own drawing.
  Built: Luna, shown the window, describes the ground just inside and the barrier's cut ends (the author's idea), the
  box runs 1.5 m past where the open ground starts, and it is pasted back whole, with no check (the walk area opens
  every exit anyway; Sol's "is it open?" disagreed with what a person sees). Latchkey's and Shiverglass Flats'
  exits came out convincing on the first try.

## What it would save

Against the baseline's 161 GPU-minutes, with Klein's times scaled to the baseline's cooler GPU (about 20% faster than
the calibration table):

| Stage | Baseline GPU min | With Klein (estimate) | How |
|---|---|---|---|
| Painting the maps | 94 | about 15–22 | Per place: eight 1.5 MP candidates (about 1.6 min), one img2img pass at the map's size (0.7–2.5 min), opening each exit by box edit (about 20 s each) and an occasional closing patch; about 3–4.5 min a place against 19 |
| Art | 45 | about 16 | The same paintings and retries at about 11 s instead of 30 s |
| Reading | 13 | 13 | Unchanged: Qwen stays |
| Mist | 9 | not tested | Krea's AnyPaint and text to image; Klein's text to image is about 2.8× faster, AnyPaint has no Klein counterpart tested |
| Model switches | about 15 | about 12 | Klein loads in about 6 s against Krea's 12, but most of the cost is Qwen's 25 s load, which stays |
| **Total** | **161** | **about 65–75** | |

The build would go from about 2 h 40 min of GPU to a little over one hour, before any grouping of Qwen's readings
(which the baseline report puts at most of the 15 switch minutes). These are estimates from per-prompt times; the next
step is to build the Klein route into `mapdraw.ts` and `art.ts` and measure a whole build the way the baseline was
measured.

## What to try next

1. **The map route:** plan with set pieces as boxes, eight closed Klein candidates (de-named prompts, appearance only),
   judge as now, one img2img pass at full size, open each exit by box edit, Sol's check. Then a full build measured
   with the meter.
2. **Connectivity of Klein's towns and dungeons:** the main routes laid out as boxes from the plan, since one sentence
   did not open Klein's walled yards.
3. **Scale:** check the character against Klein's passages at 40 px/m; Klein paints smaller things on larger canvases.
4. **Icons on a sheet:** a Luna pass matching cells to items, and fewer, larger boxes.
5. **Style:** have the plan writer (or Luna afterwards) describe the ground's materials in the world's style; try the same on art prompts.
6. **Licence:** confirm the FLUX Kommunity terms before production.

## OpenAI spend

Only Luna and Sol, judging and rewriting text, as the pipeline does: **$2.97** in total over both rounds ($1.35 in
round one), under the $6.50 cap (`data/klein/spend.json`, every script's calls together).

## Files

- **Scripts** (each documented at its top), `packages/server/src/cli/_exp/klein/`: `lib.ts` (workflows, timing, memory,
  spend cap, the baseline places), `setup.ts`, `calibrate.ts`, `wholes.ts`, `control.ts`, `large.ts`, `fixes.ts`,
  `close.ts`, `art.ts`, `icons.ts`, `world.ts`, `read.ts`, `style.ts`, `style2.ts`, `crops.ts`; round two `connect.ts`,
  `sizes.ts`, `lead.ts`, `style3.ts`, `style4.ts`, `style5.ts`, `alpha.ts`, `passages.ts`, `mattes.ts`, `view.ts`,
  `artsize.ts`, `flatstyle.ts`. `mapdraw.ts`
  now exports its prompt builders and judges so the scripts use them unchanged.
- **Art workflow:** `config/comfyui/klein_cutout.json`.
- **Timings:** `timings.csv` here (every Klein prompt: label, size, steps, GPU seconds, whether it loaded the model,
  peak GPU memory), and `results.json` (the summaries behind each table).
- **Pictures:** eleven small ones are committed in `img/`; every other picture the text names is in
  `data/klein/docs_img_full/` on the machine that ran the trial, with the trial's other outputs in `data/klein/`
  (git-ignored).
