# GPT Image 2.6 for character animation: a trial, 6 November 2026

> **Kept as a record.** This is the write-up of a finished study. Its scripts (under `packages/server/src/cli/_exp/`), its data and most of the pictures it names were removed for the 1.0 release and are in
> git history at the tag `pre-1.0-experiments`, as are the other studies it cites that are no longer in
> `docs/experiments/` or `docs/baselines/`. Paths that begin with `<study data>` or `<tools>` were on the author's own
> machine and are in neither.

OpenAI released GPT Image 2.6 on 4 November 2026. The question was whether Daydream's animation should move to it
from GPT Image 2.5 Flare, and whether its new GIF mode makes better animations. Today's pipeline
(`docs/world-art.md`, "Characters in motion") paints a turnaround and per-view clip sheets with 2.5 Flare at low
quality through the Batch API, and paints the walks as Wan 2.2 videos on the local GPU.

## The short answer

- **The clip sheets (turnaround, attack, hit, death): no reason to move yet.** With the game's prompts unchanged, 2.6
  Flare and 2.6 Sunburst paint sheets that look and measure about the same as 2.5's: the same poses (the knight's
  attack comes out almost pose for pose the same), the same clean transparency, and no better match to the painting.
  They cost about twice as much per actor. On the same request at the same size, 2.6 bills about 4.2 times as many
  output tokens as 2.5, but 2.5's price is mostly the input picture and prompt, so the bill only doubles (see "Why 2.6
  costs more").
  Moving is a one-line model change whenever 2.5 is retired.
- **GIF mode: a real candidate for walks, not for the other clips.** Asked for a looping walk, a 2.6 GIF gives an
  even 8-frame cycle that keeps the painting's look better than any sheet, for $0.014 per view through Batch (the
  same price for 4 frames or 8) and no GPU time. For attacks it is weaker than a sheet: smaller wind-ups, and
  effects such as muzzle flashes are often missing. Shooting attacks were also refused by moderation now and then;
  sheets never were.
- **Wan or GIF for walks: your call by eye.** Wan still walks with the most weight and the most even motion by the
  measures. The GIF walks are close behind, keep identity a little better, cost about $0.07 an actor, and save about
  5 GPU minutes an actor (about 3.5 GPU hours a world). Sunburst GIFs keep the painting's colours best of all.
- **Transparency: keep PNG sheets wherever soft alpha matters.** 2.6's PNG transparency is as clean as 2.5's. A GIF
  has 1-bit alpha and 256 colours: outlines are hard (acceptable once scaled to game size), but see-through bodies
  turn solid (the jellyfish loses its glass) and glows cannot be drawn.
- **Size and quality: stay at low.** Against low, medium costs 1.5 times as much, high 1.7, xhigh 2.7 and max 5.6,
  with nothing visible at the size the game draws figures (about 82 px tall). Xhigh even painted smoke round the
  frames, which the game's pale-haze check would reject. A twice-as-large answer costs 1.9 times as much and is scaled
  down anyway.

**Recommended:** keep 2.5 Flare sheets as they are. If you prefer the GIF walks by eye, replace the Wan walk videos
with 2.6 GIF walks of 8 frames (Sunburst, or Flare when Batch speed matters), and keep Wan, or sheets, for
see-through and glowing actors. Everything else stays.

## What the documentation says, and what the API does

Read from the image generation guide and the announcement, then checked against the API itself (refused requests
cost nothing):

- **Model IDs:** `gpt-image-2.6-flare` (fast) and `gpt-image-2.6-sunburst` (detail, "greater consistency across
  edits"). Both are available on `/v1/images/generations`, `/v1/images/edits` and the Batch API.
- **Prices:** the same token rates as 2.5 ($30 per million image output tokens, $8 image input, $5 text input), and
  half that through Batch. Measured at low quality through Batch: a turnaround $0.0088, a 2 × 2 sheet $0.012, a
  three-clip sheet $0.014, the four-clip W sheet $0.018, and a GIF $0.0136. 2.5 averaged $0.0066 a call in the
  October space-world build (about 128 output tokens an image; 2.6 paints about 330 to 670).
- **GIF mode:** `output_format: "gif"` with `frame_count` (2 to 16, default 9) and `frame_duration_ms` (20 to 2000,
  default 200). `size` is one frame. It is 2.6 only ("GIF output is not enabled for the model
  'gpt-image-2.5-flare'"). Requested timings and looping (loop 0, forever) come back exactly. The API's own error
  shows how it works: "No supported sheet fits 4 GIF frames at size '1000x1000'". The model paints a sprite sheet,
  and the API cuts it into frames, so frames × frame size must fit one image (no edge over 3840 px). An 8-frame GIF
  costs the same as a 4-frame one.
- **GIF with `background: "transparent"`** is accepted. Frames come back with 1-bit alpha (no partly transparent
  pixel) and GIF's 256-colour palette.
- **Quality** low, medium, high, xhigh and max all work on Flare, despite an error message that lists only low to
  high. `complexity` (low, medium, high; default high) is accepted on sheets.
- **Batch API:** one model per batch ("Each batch must contain requests for a single model"). GIFs work through it.
  Flare batches of 25 to 85 requests came back in 2.5 to 10 minutes. A Sunburst batch of 25 took 41 minutes,
  stalled at 19 of 25 for twenty of them. Direct calls take 8 to 25 seconds.
- **Moderation:** two of the gunner's 12 GIFs (shooting attacks) were refused at the output stage for "violence".
  Retried with `moderation: "low"`, both came back, one at its second try. No sheet was refused.

## What was compared

Five actors from three worlds whose 2.5 sheets and Wan walks already existed (from the video trial,
`../video-animation/`), so nothing was rebuilt:

| Name | Actor | World and body |
|---|---|---|
| gunner | `spr_hero_cl_gunner_k_driftborn` | inked sci-fi; a person with a rivet gun |
| knight | `spr_mon_f0_the_hushed_procession_brute` | storybook coast; an armoured man carrying a coffin |
| crab | `spr_mon_f1_pilingshell_brood_brute` | storybook coast; an eight-legged crab |
| fox | `spr_mon_f3_trial_beasts_brute` | watercolour winter; a four-legged animal |
| jelly | `spr_mon_f3_trial_beasts_caster` | watercolour winter; a see-through floater |

Every variant starts from the same painting and brief, and goes through the game's own steadying and packing
(`anim/assemble.ts`, or the video trial's copy for separate frames), so only the painter differs:

| Variant | What it is |
|---|---|
| gpt | 2.5 Flare low sheets: the game today |
| wan4 | Wan 2.2 walk videos, 4 frames: the game's walks today |
| f26 | 2.6 Flare low, the game's requests unchanged (its own turnaround) |
| s26 | 2.6 Sunburst low, the game's requests unchanged (its own turnaround) |
| f26lc | f26 with `complexity: "low"` (f26's turnaround) |
| gif8 | one 2.6 Flare GIF of 8 frames per view and clip, from that view's turnaround figure; "gif8:out4" keeps 4 frames |
| gifS8 | the walks alone as 2.6 Sunburst GIFs of 8 frames |
| w8 | the walk as an ordinary 4 × 2 PNG sheet of 8 frames (2.6 Flare): GIF mode's frame count with soft alpha |

The measures (`metrics.ts`, on the assembled sheets, each frame on the actor's anchor, averaged over views and
actors) are these. Move is how much consecutive frames differ. Even is how evenly that change is spread (1 is
perfectly even). Seam is the last-to-first change against the average step (about 1 loops cleanly). Colour is how
far the frames' colours are from the painting (lower is closer).

| Walks | move | even | seam | colour |
|---|---|---|---|---|
| gpt (2.5) | .371 | .78 | .98 | .321 |
| wan4 | .457 | .90 | 1.04 | .292 |
| f26 | .422 | .86 | .88 | .322 |
| s26 | .471 | .87 | .89 | .346 |
| f26lc | .359 | .86 | 1.09 | .355 |
| gif8, 4 of its frames | .378 | .84 | .99 | .301 |
| gif8, 8 frames | .339 | .79 | .69 | .300 |
| gifS8, 8 frames | .350 | .75 | .76 | .280 |
| w8, 8 frames | .267 | .67 | .96 | .330 |

With 8 frames, each step is half the motion of a 4-frame step if the cycle is the same. The 8-frame GIFs' steps are
nearly as large as the 4-frame ones, so they cover more motion per cycle. Attacks, hits and deaths measured about
level between gpt, f26, s26 and the GIFs (`metrics.json`). Wan moved most and most evenly there too, but it is not
used for them.

By eye (contact sheets and players in `play/` and `img/`):

- **Turnarounds** are about even. 2.6 is a little tidier and paints the crab's back views better. It keeps the
  radially symmetric jellyfish alike in every view (2.5 tilted it into a swimming pose in two). Both 2.6 models
  paint a stretched front view of the fox.
- **Sheet walks.** 2.6 moves the legs a little more than 2.5, with a shorter stride than Wan's. It redraws the fox
  a little fluffier than its painting.
- **GIF walks** alternate the legs readably in every view, keep the suit's patterns (Wan's gunner drifts in
  colour), and loop. The PNG-sheet version of the same idea (w8) moves less and loops less cleanly, so GIF mode is
  tuned for motion beyond being a sheet.
- **Attacks.** 2.6 sheets match 2.5's (the knight's lift, slam and ice burst come out alike). The GIFs are tamer:
  the gunner barely raises the gun and fires no flash, and the knight skips the overhead lift.

## Transparency

Measured on the raw answers (`alpha.ts`). 2.5 sheets: 0 of 42 pale-hazed; 2.6 Flare: 1 of 30 (it would be
repainted); Sunburst: 0 of 30. Edges are anti-aliased and very slightly darker than the inside in all three (no light
fringe). Figures are never fully opaque in either model (alpha tops out at 253), as before.

GIF frames have no soft alpha. Scaled to game size the outline looks acceptable (`img/edges_*.png`), but the
see-through jellyfish turns solid (on dark ground its tentacles look painted, not glassy), and a muzzle flash or
glow cannot fade into the scene. GIF mode cannot replace a cut-out step: the animation pipeline already has none
(sheets come with alpha from the model), and the walk videos' cut-out works on 24-bit frames that GIF cannot match.

## Quality and size (gunner's W sheet: move, attack, hit and death, 1472 × 1152)

| Setting | Output tokens | Price direct (Batch) | Seen at game size |
|---|---|---|---|
| low (the game's) | 811 | $0.038 ($0.019) | the baseline |
| medium | 1393 | $0.056 ($0.028) | no difference |
| high | 1665 | $0.064 ($0.032) | no difference |
| xhigh | 2957 | $0.103 ($0.051) | smoke round the frames (pale haze 0.089: rejected) |
| max | 6653 | $0.214 ($0.107) | no difference |
| low, answered 1.5× larger | 1273 | $0.052 ($0.026) | no difference once scaled down |
| low, answered 2× larger | 1920 | $0.072 ($0.036) | no difference once scaled down |

The game draws a figure about 82 px tall, from sheets about 164 px tall, so detail beyond low is thrown away. As
with 2.5, low also moves the most.

## Why 2.6 costs more

The gunner's W sheet was sent unchanged to 2.5 Flare (`sizeprobe.ts`), to compare it with the 2.6 numbers above.

| Request | 2.5 Flare output tokens | 2.6 Flare output tokens | 2.5 price direct | 2.6 price direct |
|---|---|---|---|---|
| 1472 × 1152, low | 193 | 811 | $0.020 | $0.038 |
| 2944 × 2304, low | 457 | 1920 | $0.028 | $0.072 |

The returned picture has the same number of pixels from either model. What is billed is not pixels, though. It is
the image tokens the model generates, which are its internal, coarser picture, and a decoder then turns them into the
pixels requested. At low quality 2.6 generates about 4.2 times as many tokens for the same picture, about twice as
fine a grid along each edge. OpenAI does not document the internals, so this is a reading of the bills. The token
count is fixed by the size and the quality, not by what is painted: every request of one size billed the same count.
The bill doubles rather than quadruples because the input (the figure and a long prompt, about $0.014 here) costs the
same on both models and is most of 2.5's price.

## GIF frame size and frame count (gunner's W walk, 2.6 Flare, low)

| Frame (px) | Frames | Output tokens | Batch price | Five views (an actor's walk) |
|---|---|---|---|---|
| 320 × 256 | 8 | 450 | $0.0088 | $0.044 |
| 496 × 384 | 2 | 593 | $0.0127 | $0.064 |
| 496 × 384 | 8 (the trial's) | 593 | $0.0127 | $0.064 |
| 496 × 384 | 16 | 1021 | $0.0191 | $0.096 |
| 656 × 512 | 8 | 790 | $0.0158 | $0.079 |
| 976 × 768 | 8 | 1344 | $0.0243 | $0.122 |

The price follows the size of the hidden sheet the model paints. From 2 to 8 frames at one frame size the sheet is the
same, so the price is the same; 16 frames need a larger sheet. A larger frame costs more, with no gain at game size:
the figure in a 256 px frame is still about twice the size the game draws it. Smaller frames show their stair-stepped
1-bit edges sooner when enlarged, but not at game size. Resizing the GIF afterwards costs nothing, and the game
already does it when it packs the frames into sheets. A 256 px frame would save about a third of the GIF walk's
price; this was seen on one actor only.

## Cost and time per world

For a world of 25 actors that fight and 15 townspeople, OpenAI at the Batch price. The brief's few cents are not
counted.

| Plan | OpenAI per world | GPU per world | Quality |
|---|---|---|---|
| Today: 2.5 sheets, Wan walks | about $0.75 | about 3.5 hours | the baseline |
| 2.6 sheets in place of 2.5, Wan walks | about $1.50 | about 3.5 hours | about the same |
| 2.5 sheets, 2.6 GIF walks (8 frames) in place of Wan | about $3.45 | none | walks a little less weighty, identity a little better |
| 2.6 sheets and GIF walks | about $4.20 | none | as above |
| 2.6 GIFs for every clip | about $5.50 | none | weaker attacks, no glows, see-through bodies solid |

Per actor: 2.5 today about $0.026 for one that fights (turnaround, S, W and N sheets), or $0.005 for a townsperson
(turnaround alone). GIF walks add $0.068 an actor (five views). Wall-clock time: GIF walks come back with the other
batches, in minutes, where Wan's videos queue on the one GPU for hours.

## What was adopted

After judging every variant by eye (the viewer page), the author chose, for all five actors, 2.6 Sunburst GIF walks
and 2.5 Flare sheets for attack, hit and death. That is now the game's pipeline (docs/world-art.md, "Characters in
motion"): the `image.walk` purpose paints one 8-frame GIF per view at 256 px frames with moderation low, in a
Sunburst batch of its own; the GIF frames go through the same steadying as a painted walk and play at 12 frames a
second. The Wan walk videos were removed, so animation no longer uses the GPU.

The real job was then run on the five actors (`pipeline.ts` makes a test world from their saved 2.5 turnarounds
and sheets, so only the walks were painted): all five came out animated. The 25 GIFs cost $0.241 through Batch
(about $0.0096 each, a little above the estimate from Flare's tokens), and the batch took 43 minutes. Each actor's
walk sheet holds 2.9 to 7.8 MB decoded at full sheet size, 1.2 to 3.6 MB more than its 4-frame Wan walk (the fox's
less, since its video drifted across a wide box); a whole actor holds 6.6 to 16 MB, well inside the client's 160 to
384 MB budget for sheets, and the client decodes them at screen size, which is usually smaller.

## Spend

$3.47 of OpenAI in all, counted per call by the trial's own ledger (`data/g26/spend.jsonl`; the CLI bypasses the
game's ledger). By part: probes $0.06; f26 $0.39; s26 $0.39; GIFs of every clip $0.84; the quality and size probe
$0.56; w8 $0.21; Sunburst GIF walks $0.68 (direct, at full price); complexity low $0.35. A later size probe (2.5 on
the same sheet, GIF frame sizes and counts) added $0.21, and the real job on five actors $0.24, for $3.92 in all. No GPU was used, and no world was changed.

## Files

- `play/`: animated WebPs, a column per variant and a row per view, at about game size: `<actor>_walk.webp` (gpt,
  wan4, f26, gif8:out4, gif8), `<actor>_walk_gifs.webp` (wan4, gif8, gifS8), `<actor>_walk_8f.webp` (wan4, gif8,
  w8), `<actor>_attack_sheets.webp` (gpt, f26, s26), `<actor>_attack.webp` (gpt, f26, gif8:out4, gif8) and others.
- `img/`: turnarounds side by side (2.5, 2.6 Flare, 2.6 Sunburst), edges magnified at game size, the quality sweep,
  and frame contact sheets.
- `viewer/index.html`: a page that shows every variant of every actor and clip side by side on a chosen ground, with
  its cost per character, and the GIF size probe. Its animations (`viewer/a/`, 16 MB) are not committed; make them
  with `node src/cli/_exp/g26/viewer.ts --scale 1` from `packages/server`.
- `metrics.json`: every measure by actor, variant and clip.
- Code: `packages/server/src/cli/_exp/g26/` (`api.ts` the client and ledger, `run.ts` painting and assembly,
  `compare.ts` players and contact sheets, `metrics.ts`, `alpha.ts`, `edges.ts`, `probe*.ts`, `qprobe.ts`).
  Painted parts are in this worktree's `data/g26/` (not committed).
