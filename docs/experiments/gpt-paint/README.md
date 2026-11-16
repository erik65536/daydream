# Painting places with GPT Image instead of Klein (13 November 2026)

> **Kept as a record.** This is the write-up of a finished study. Its scripts (under `packages/server/src/cli/_exp/`), its data and most of the pictures it names were removed for the 1.0 release and are in
> git history at the tag `pre-1.0-experiments`, as are the other studies it cites that are no longer in
> `docs/experiments/` or `docs/baselines/`. Paths that begin with `<study data>` or `<tools>` were on the author's own
> machine and are in neither.

## The question

The build paints each place as one big top-down map with FLUX 3 Klein on the GPU (`docs/places.md`,
`worldgen/mapdraw.ts`):

1. Klein paints the whole place closed by its barrier, at full size (40 pixels per metre).
2. The walk reader judges each painting, and Klein repaints until one is sound.
3. Klein's box edits, in 1024-pixel windows at the edge, cut the planned ways out.
4. The barrier's texture and a box edit close any other way off the map.

The author asked whether GPT Image can do this instead:

- painting each place whole, as Klein does, enlarged locally if needed;
- with edges, closings and openings made by whatever method works;
- whether a smaller edit area saves money;
- with maps that stay close to a straight-down view;
- with passages wide enough for a character.

Any method that is better, cheaper, faster or better-looking was allowed. The budget was $6.

## Verdict (after the study): Klein stays the painter

**Up close, GPT Image's maps have a melted look that Klein's do not, so places stay on Klein, edges included.** The
study below judged layout, scale, passages and edges, and looked at full size only for scale. The author then compared
detail at game scale (`img/detail_klein_vs_gpt.jpg`):

- **Klein** (top left and top middle): every crate, cable coil and machine is a distinct, hard-edged object.
- **GPT Image 2.5, low or medium quality** (top right, bottom left, bottom right): the market goods, stall contents and
  machinery are half-formed blobs.
- **GPT Image 2.6** (bottom middle): crisp, but seen from a three-quarter angle with large building fronts, at about
  four times the price and 100 s a painting.

GPT's strip edits are 2.5 at low quality, so they would leave the same soft patches in a crisp Klein map, at the ways
in and out. The `image.place` option that was built from this study was removed again. What it found that still holds:

- GPT Image follows a prompt's edge layout well (12 of 13 ways out painted where asked).
- An edit's price follows its window's area.
- SeedVR2 enlarges a painting 1.42× cleanly.

## What the study found

**GPT Image paints places as well as Klein for about four cents each, at about a third of Klein's time, and with no
GPU except for enlarging the largest sizes.** (Not so up close: see the verdict above.) The route it recommended:

1. **Paint.**
   - **Model and settings:** GPT Image 2.5 Sunburst at low quality, at the largest size it paints in the map's shape.
   - **The prompt:** the build's whole-place prompt without Klein's layout boxes, with the planned ways out written in
     ("broken in exactly two places, the middle of the left edge and the middle of the top edge, where a way out
     about four metres wide leads off the edge of the picture").
   - **The result:** GPT painted 12 of 13 planned ways out where asked, so the ways-out step is almost never needed.
2. **Judge.** The build's own rules decide whether a painting is kept. GPT's paintings are almost never cut up, but the
   rule that at least 40% of the map is walkable should drop to 25% for them (below).
3. **Seal.** A 1024 × 640 strip edit closes any other way off the map, the smallest area GPT Image paints. Each strip
   costs $0.009, against $0.015 for Klein's 1024 square window and about $0.03 for an edit of the whole map, and it is
   pasted back over a box with soft edges as Klein's edits are. Long openings are closed in pieces. A closing box keeps
   clear of the ways out.
4. **Enlarge** to 40 px/m.
   - **2 × 2 and 3 × 2 places** are painted at full size.
   - **3 × 3 places** are painted at 2880 px and enlarged 1.07× by plain resampling.
   - **4 × 3 and 4 × 4 places** are enlarged 1.23 to 1.42×. For those, SeedVR2 on the GPU is clearly sharper than
     plain resampling.

All eight finished maps are in `img/finished_maps.jpg`.

| | Klein (30 October build) | GPT Image 2.5 Sunburst, low |
|---|---|---|
| A painting | 78 GPU-seconds (all sizes, average) | 22–31 s, no GPU, any number at once |
| Price of a painting | GPU | $0.015 (2048²), $0.023 (2880²), $0.014 (3072 × 2048) |
| Paintings per place to a sound one | 2.0 | 2.6 with the 40% rule, 1.75 with 25% |
| Way out | box edit, 26 GPU-seconds | painted in 12 of 13 times; otherwise a strip edit, 13 s, $0.009 |
| Closing | texture and box edit | strip edit, 13 s, $0.009 |
| Painting cost per place | GPU | about $0.05 (1.75 paintings and 1.25 edits) |
| Per world, small / medium / large | GPU: about 16 / 25 / 37 minutes | about $0.24 / $0.38 / $0.56, plus SeedVR2 minutes for 4 × 3 and 4 × 4 places |

Reading the paintings is a separate cost. Each painting the judge reads costs $0.06 with the GPT reader, or GPU time
with Qwen (`../gpt-read/README.md`).

## How it was tested

- **The places.** The eight places of the walk-prompt study (`<study data>/prompts/painted/worlds/wp1`), each with the
  plan Luna wrote for it (`plan.json`), so no new planning was needed:
  - **Towns:** Ledgefall, a cliff town with rope bridges; the Interchange, a freeway truck stop.
  - **Wilds:** the Long Ice, an arctic camp; Blackwater Fen, a marsh; the Clipped Garden, a hedge maze.
  - **Dungeons:** the Cinder Works, a lava foundry; the Gallows Mine; the Rime Cavern.

  They span 2 × 2 to 3 × 3 tiles. Their finished maps from October (Krea) are the older painter's baseline, measured the
  same way. Klein's figures come from the 30 October build (`docs/baselines/2026-10-30-klein`).
- **The measures.** Each painting is enlarged to 40 px/m and measured:
  - **Reading:** the build's GPT reader, with one 2.5 Sunburst plan, or both plans where the build would judge.
  - **The build's judge:** the share of the walkable ground cut off from the main region, the share of the map
    walkable, and Luna's view check.
  - **The edge:** where the planned ways out are open and where other ways off the map are (`mapdraw.exitSpots` and
    `strayOpenings`).
  - **Passage width:** how much of the main region a body 1 m or 1.5 m wide still reaches, keeping its distance from
    everything blocked.
  - **By eye:** full-size crops with a standing character's outline drawn in (1.75 m, as the game draws them).
- **The code.** It is in `packages/server/src/cli/_exp/gptpaint/`.
  - `run.ts`: paintings and their measures.
  - `edits.ts` and `win.ts`: the edge edits.
  - `pipeline.ts`: the whole route, run on all eight places.
  - `table.ts`, `sheet.ts`, `crop.ts` and `upscale.ts`: the tables and pictures.

## Painting a whole place

**The models.** The same closed prompt was painted on Ledgefall, the Cinder Works and Blackwater Fen
(`img/ledgefall_models.jpg`: the old map, then 2.5 Sunburst low, 2.5 Flare low, 2.5 Sunburst medium and 2.6 Sunburst
low).

| Model and quality | Price at 2880² | Time | What it did |
|---|---|---|---|
| 2.5 Flare, low | $0.023 | 20–25 s | Painted ramps through the barrier to the edge; narrower passages at Ledgefall (66% reachable for a 1.5 m body, against 86%) |
| **2.5 Sunburst, low** | **$0.023** | **22–31 s** | Closed, clean, wide passages |
| 2.5 Sunburst, medium | $0.048 | 31–85 s | No better: Blackwater Fen's boardwalks came out narrow (13% reachable for a 1.5 m body) |
| 2.6 Sunburst, low | $0.087 | 76–100 s | Richer, but narrower passages (Cinder Works 49%), and Luna saw large building fronts at Ledgefall |

2.5 Sunburst at low quality is the choice. At full size its maps are a little soft where they are enlarged, but clean
(`img/ledgefall_scale.jpg`).

**The view.** Luna's view check judged none of the 46 paintings too steep. Most show at most a thin strip of a
building's side ("thin"), which the build accepts. The orthographic sentence in the build's prompt works for GPT too.

**Scale and passages.** At full size the scale is right (`img/ledgefall_scale.jpg`, 5 m bar):

- Houses are 6 to 7 m across and a well is about 3 m.
- A standing character fits the streets and stairs comfortably.

Across the first paintings, a 1.5 m body reaches 72 to 96% of the main region, 85% on average. The old maps reach
21 to 99%. The hedge maze is the difference: GPT's paths stay wide (72%), where the old maze closed in (21%).
Paintings of one place vary a lot, and within one place a painting's passages can range from 40 to 99% reachable.
Asking for paths "at least three metres wide" did not change the average (85% either way).

**Soundness.** Of the eight first paintings:

- **Cut off:** 7 had under 4% of their walkable ground cut off, which the build calls sound. Of the old maps, 4 of 8
  did.
- **Walkable share:** GPT's maps read less walkable, 27 to 63%, against 41 to 77% for the old maps. The cliff town
  and the marsh are mostly gorge and water.

On the full route the build's 40% rule rejected all four paintings of Ledgefall (27 to 35%) and Blackwater Fen (21 to
33%), which were otherwise sound. That rule was set for Klein, which sometimes painted whole yards and rooms as solid
walls. GPT does not do that, and its paintings read less walkable because they are more detailed. At 25%, those two
places would have kept their first or third painting, and the route would need 1.75 paintings per place.

## Ways out: painted in, or cut

**Cutting with a strip edit.** The map is cut to a 1024 × 640 window at the edge, turned so the edge is at the top,
and edited with a mask over the box and the build's exit wording. The result is pasted back over the box with soft
edges.

- **The look.** On Ledgefall it cut a plank way through the cliff that carries on the town's paths
  (`img/exit_strip_edit.jpg`, before and after). The other exits look as good.
- **The cost.** A strip costs $0.0094 (640 image tokens in, 107 out) and takes 12 to 16 s. A 1024 square costs
  $0.0150 (1,024 in, 196 out).
- **Why the window is small.** GPT Image bills its input picture by area, so the strip is 37% cheaper than the square.
  An edit of the whole 2880-pixel map would cost about $0.03, and GPT would repaint all of it.

**Painting them in.** GPT follows the edge better than Klein. Asked for the place closed except for its planned ways
out (`gatesPrompt`), it painted 12 of 13 at the planned spots, open to the edge (`img/garden_prompts.jpg`, third
picture). With the closed prompt, 5 of the 13 planned spots were already open by chance, where roads or paths ran off
the edge. Klein, asked for exits, closed the belt in 13 of 30 paintings. So the gates prompt makes the exit step almost
never needed, and the build keeps it for the rare miss.

## Closing stray openings

Some plans make GPT run roads to the edge whatever the prompt says. The Interchange's freeways left the picture on all
four sides in every painting, and its barrier was an inner belt with ground beyond it. Ledgefall and the Fen had a
path or boardwalk at the edge.

Each stray opening is closed with strip edits:

- **The edit.** The belt of barrier is made whole where it is masked, and the ground that led to the edge ends before
  it. A long opening is closed in pieces of at most 896 px.
- **The results.**
  - The Interchange's five openings took five strips ($0.047) and left none (`img/interchange_closed.jpg`).
  - Blackwater Fen went from 2 to 0 openings, Ledgefall from 2 to 1.
- **The fix.** The first run's closing boxes also closed two planned exits beside them, so a closing box now keeps
  clear of every way out on its side.

On the full route, the eight places needed 10 edits in all: 2 ways out and 8 closings.

## Enlarging

GPT Image paints at most 8.29 MP and 3840 px a side, so the larger places are painted smaller and enlarged to 40 px/m:

| Tiles | Map at 40 px/m | GPT paints | Enlarged |
|---|---|---|---|
| 2 × 1, 2 × 2, 3 × 2 | up to 3072 × 2048 | full size | – |
| 3 × 3 | 3072² | 2880² | 1.07× |
| 4 × 3 | 4096 × 3072 | 3328 × 2496 | 1.23× |
| 4 × 4 | 4096² | 2880² | 1.42× |

At 1.07× Lanczos resampling is enough. At 1.42× SeedVR2 (×2 on the GPU, then down to size) is clearly sharper than
Lanczos (`img/upscale_lanczos_vs_seedvr2.jpg`: Lanczos left, SeedVR2 right). Tent seams, sled slats and the ice's
edges are crisp, and some fine texture is a little grainy. It took 14 GPU-seconds for a 720-pixel crop, about 3 to 4
minutes for a whole 4 × 4 map. Only 4 × 3 and 4 × 4 places need it.

## The whole route on eight places

`pipeline.ts` ran the recommended route with the build's rules unchanged (40% walkable). Each painting was judged by
both GPT reader plans and Luna's view check, with at most four paintings per place and no Luna rewrite.

| Place | Paintings | Kept | Ways out painted in | Edits | Openings left |
|---|---|---|---|---|---|
| The Cinder Works | 1 | sound | 1 of 1 | 0 | 0 |
| The Gallows Mine | 1 | sound | 1 of 1 | 0 | 0 |
| The Interchange | 1 | sound | 2 of 2 | 4 closings | 0 |
| The Long Ice | 2 | sound | 1 of 2 | 1 way out | 0 |
| The Clipped Garden | 4 | best of four (walkable 39.7%, cut off 3.9%) | 2 of 2 | 0 | 0 |
| The Rime Cavern | 4 | best of four (cut off 2.6%, walkable 39.5%) | 1 of 1 | 0 | 0 |
| Ledgefall | 4 | best of four (walkable 27%) | 2 of 2 | 2 closings | 0 |
| Blackwater Fen | 4 | best of four (walkable 25%) | 1 of 2 | 1 way out, 2 closings | 1 boardwalk |

Every place was kept with nothing important cut off. The four "best of four" places failed only the 40% rule: two by
less than a point, two on ground that is mostly gorge or marsh. The Rime Cavern's other paintings had cut-off ice
pockets (13 to 59%). Each place took 2.5 to 10 minutes of wall time, nearly all of it judging repaints that the 25%
rule would not have needed.

## A 4 × 4 place

None of the eight places is 4 × 4, so Luna planned a new one exactly as the build plans a place (`extra.ts`,
`mapdraw.planMap`): the Windmill Downs, about 102 m across. It has a ring of standing stones on the crest, three
windmills, a hamlet of flint cottages round a dew pond, a chalk pit and hedged pastures, closed by a hawthorn hedge,
with ways out on the left, top and right.

It went through the whole route with the 25% minimum (`img/windmill_downs_4x4.jpg`; the full 4096-pixel map is
`<study data>/gptpaint/send/the_windmill_downs_4x4.png`):

- **Painting.** GPT painted it at 2880 px. The first two paintings had 23% and 10% of their ground cut off, and the
  third was sound (2.2%). Each cost $0.024 and took about 30 s.
- **Ways out.** All three were painted in where planned.
- **Enlarging.** SeedVR2 enlarged the kept painting to 4096 px (40 px/m). The cottages, windmill sails and hedge stay
  crisp at full size, and the scale holds: cottages about 5 m across, the pond about 12 m.
- **Sealing.** Two strip edits closed the barrier's two real gaps.
- **Cost.** About $0.09 of painting and edits (three paintings, two strips), plus the readings.

**A fault this place found in the stray rule.** GPT drew the hedge as a line about 1 to 1.5 m wide, 2.5 m in from the
edge, with a strip of grass outside it. That strip joins the inside through the three ways out, so `mapdraw`'s rule,
which counts main-region ground within 1 m of the edge, found 7 "openings" all round. The first run spent 23 strip
edits on them, and the reading still saw them, because the snapped walk area loses parts of a hedge only a metre wide.

The build blocks the whole 3.2 m barrier band anyway, except at the ways out (`mapfix`), so this place was already
sealed for players. What matters is whether the painting shows the barrier whole. The rule used now (`crossings.ts`)
counts a gap only where:

- the main region reaches the inner side of the band;
- the plans show nothing solid or water anywhere across the band;
- it is away from the ways out and from the corners, which lie in the next side's band too.

On the Downs it finds the 2 real gaps. On the eight places it finds what the old rule found, except 2 more on the
Clipped Garden.

## In the build (13 November)

The route is now an option in the build: the `image.place` purpose (`mapdraw.ts`: `gatesPrompt`, `gptPaint`,
`enlargeFine`, `barrierGaps`, `gptExits`, `gptClose`).

A 4 × 3 dungeon, the Drowned Clockworks, was made by the build's own code (`zones.paintAndRead`, `buildplace.ts`) with
GPT painting and reading on (`img/drowned_clockworks_4x3.jpg`):

- Luna planned it.
- The first painting (3328 × 2496) was sound.
- Both ways out were painted in, so none was cut, and its barrier had no gaps.
- SeedVR2 enlarged it to 4096 × 3072 in about 160 GPU-seconds.
- The final reading named ten landmarks.

It took 5 minutes and cost $0.075.

## Not tested

- **A whole world build.** One place went through the build's code; mist, lighting and settling people and things on
  GPT's maps are untried.
- **Luna's rewrite** after two failed paintings. It was left out, since repainting changes the layout anyway.
- **Places in other art styles**, such as claymation or pixel art. The eight share one hand-painted style.
- **Moderation.** None of the 81 calls was refused.

## Spend

$4.18 of the $6:

- $1.25 for 49 paintings.
- $0.56 for 60 edge edits, 25 of them on the Windmill Downs (23 under the old stray rule).
- $2.36 for readings and Luna's view checks and plans through the game's gateway.

Each direct call is in `spend.jsonl`. The paintings' measures are in `results.jsonl`, and the full route's rows in
`pipeline.jsonl`.

## Summary

- **Painting.** GPT Image 2.5 Sunburst at low quality paints a whole place in one call: top-down, in theme, closed
  and almost always connected, at about $0.02 and 25 s, with no GPU. 2.6, medium quality and Flare were each worse
  for this.
- **Ways out.** Written into the painting prompt, GPT paints them where they are planned (12 of 13), so cutting them is
  rarely needed.
- **Smaller edits.** A smaller window does save money. A 1024 × 640 strip costs $0.009, a 1024 square $0.015 and the
  whole map about $0.03. A strip both closes stray openings and cuts the rare missing way out, without touching the
  rest of the map.
- **Passages and scale.** Both are right at 40 px/m. The build's 40%-walkable rule should drop to about 25% for GPT
  paintings, which are more detailed and almost never walled shut.
- **Enlarging.** 3 × 3 places enlarge 1.07× by resampling. 4 × 3 and 4 × 4 places want SeedVR2, a few GPU minutes
  each. A 4 × 4 place made through every step (the Windmill Downs) came out crisp and in scale at 4096 px.
- **Strays.** The stray rule should look across the barrier band, not at the edge: GPT sometimes draws a thin barrier
  inside the band, with ground beyond it, which the build blocks anyway.
- **Cost.** About $0.05 per place in painting and edits, or $0.24 to $0.56 per world. That replaces 16 to 37 GPU
  minutes of Klein. Reading the paintings is extra, $0.06 each with the GPT reader.
