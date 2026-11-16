# Lining GPT Image's plans up with the painting (15 November 2026)

> **Kept as a record.** This is the write-up of a finished study. Its scripts (under `packages/server/src/cli/_exp/`), its data and most of the pictures it names were removed for the 1.0 release and are in
> git history at the tag `pre-1.0-experiments`, as are the other studies it cites that are no longer in
> `docs/experiments/` or `docs/baselines/`. Paths that begin with `<study data>` or `<tools>` were on the author's own
> machine and are in neither.

## The question

The build reads where people can walk on a painted place from two six-colour plans of the map, one each from GPT
Image 2.5 Sunburst and 2.6 Sunburst, voted per quarter-metre cell (`docs/places.md`, "Reading the map"). On the
office-tower world "The Forty-Second Copy" it read badly:

- **The Cubicle Expanse and the Service Corridors** were the worst places: walkable ground ran over cubicle
  partitions, box stacks and short walls.
- **Meridian Tower Lobby** read walkable ground straight through walls.

What is the root cause, and what are robust ways to fix it, without making other worlds worse? The budget was $6 of
OpenAI spend.

## Answer

**The plans do not line up with the painting.** GPT Image keeps a map's layout when it redraws it as a plan, but not
its exact place: its plans come back shifted and stretched. Over the 24 places the author marked, the mean
displacement is:

| Plans | Mean drift |
|---|---|
| GPT Image 2.5 Sunburst (two answers per place) | 0.37 m and 0.44 m, up to 1.2 m on a place |
| GPT Image 2.6 Sunburst (two answers) | 0.09 m and 0.12 m, up to 0.8 m |
| Qwen-Image 2.1, for comparison (three plans) | 0.10 to 0.15 m, up to 0.66 m |

2.5 Sunburst mostly moves its plans up by 10 to 20 plan pixels and stretches or shrinks them by 1 to 2%; 2.6 mostly
stretches them vertically. On The Forty-Second Copy, 2.5's plans were 0.7 to 1.2 m off.

An office's walls and partitions are 0.1 to 0.3 m thick. When the two plans draw the same wall most of a metre apart,
each cell along it gets one "solid" vote and one "floor" vote, the guided filter (`mapedge.ts`) smooths the rest
away, and walkable ground runs through the wall. A town hardly notices: a house is far bigger than the drift.

**The fix: move each plan back onto the painting before reading it** (`worldgen/mapalign.ts`). The painting and the
plan are reduced to edge maps at the plan's size; in each of about 24 tiles the shift of the plan that best matches
the painting is found by normalized correlation; and one affine map (shift, scale and shear on each axis) is fitted
to those shifts, weighted by how well each tile matched, with tiles far off the first fit left out of the second. The
plan is then redrawn in the painting's frame (nearest pixel, so its flat colours stay flat). It takes no model calls
and about a second per plan.

On the 3,574 points the author marked by eye on 24 places of four worlds (`../walk-prompts/`), from the six plan pairs
the gpt-read study cached, through the build's own later steps without Luna:

| Reader | Marked points right | Against today |
|---|---|---|
| Today: one 2.5 and one 2.6 plan, voted as drawn | 95.71% | |
| The same plans, lined up | 96.20% | +0.49 (90% interval +0.12 to +0.84) |
| Lined up by a smooth warp instead of one affine map | 96.24% | +0.04 over affine (-0.07 to +0.14) |
| Two 2.5 plans, voted as drawn | 94.71% | |
| Two 2.5 plans, lined up | 96.25% | +0.05 over the lined-up pair (-0.50 to +0.59) |
| **One 2.5 and one 2.6 plan, lined up, without seams (the build now)** | **96.27%** | **+0.56 over today; +0.07 over lined up with seams (+0.03 to +0.11)** |

The interval comes from redrawing the 24 places with replacement 4,000 times. Every one of the six plan pairs gains
(+0.34 to +0.78 points); lined up, a pair is better on 6 to 10 places and worse on 2 to 6. The biggest gains are on
the places with thin walls: Bellwether HQ, an office, goes from 95.7% to 98.1%; a mine (wp1_d1_0) from 93.2% to 96.0%;
a drowned town's wilds (warm_w0_1) from 98.2% to 100%.

The marked points are mostly away from walls, where alignment changes nothing, so the gain on the points understates
what changes along walls. The pictures show it better.

## The three office places

Before (left: the plans as drawn, with seams) and after (right: lined up, without seams), read from the build's own
plans through the same steps, Luna's crossing looks left out on both sides:

- **The Cubicle Expanse** (`img/cubicles_before_after.jpg`, `img/cubicles_closeup.jpg`). The partitions round each
  cubicle block are blocked again; before, the reading ran across them where the two plans' partitions missed each
  other. Walkable ground fell from 47.0% of the map to 39.5%, almost all of it partitions and desks.
- **The Service Corridors** (`img/corridors_before_after.jpg`, `img/corridors_closeup.jpg`). The walkable ground now
  stops at the box stacks, copiers and half-walls instead of running most of a metre over them.
- **Meridian Tower Lobby** (`img/lobby_before_after.jpg`, `img/lobby_closeup.jpg`). The room walls are blocked again
  where the two plans' walls had missed each other. Two faults remain that alignment cannot fix (below).

## What alignment does not fix

- **Wall faces.** The painter draws walls in a slight perspective, so a tall wall shows its side face, a strip about a
  metre wide beside the dark line of its top. Both models outline that face and fill it as floor, so they agree and
  it opens. A prompt sentence asking for walls "across their whole width, with any side face the view shows" did not
  change it (tried on the three office places, $0.16). It is a painting convention more than a reading error: the
  painting's view check, or a reader told about it, would be the place to fix it.
- **A glass partition in the lobby** (a thin dark line with a door marked by floor tape) is painted as a walkway
  (magenta) by 2.5 and as a wall by 2.6.

## Can the drift be prevented?

Not fully. The Images API answers at exactly the size it is sent, so nothing is resized on the way; the drift happens
in the model, which regenerates the picture rather than tracing it.

- **Wording.** Opening the prompt with "trace this image in place, as an exact overlay: every edge stays at exactly the
  same pixel position and size, no shift, no zoom, no crop" cut 2.5's mean drift from 1.17 to 0.76 m on the Service
  Corridors and from 0.68 to 0.48 m on the lobby, and did not change 2.6's (one answer each, $0.11). It helps a little
  and leaves the drift several times the 0.25 m cell, so checking each plan against the painting is needed anyway.
- **Measuring against the painting** works whatever the model does, costs nothing, and would catch a new model that
  drifts differently.

## Two simpler or cheaper options measured

- **Two 2.5 Sunburst plans** ($0.038 a painting instead of $0.059). The gpt-read study rejected them at a point below
  the mixed pair. Lined up, they read as well (96.25% against 96.20%, +0.05 with an interval of -0.50 to +0.59): much
  of the advantage of mixing two models was that their drifts differ. They do differ place by place: on the Cinder
  Works' sister mine (wp1_d0_0) the 2.5 pair reads 92.6% against 96.8%, and 2.6 is the model that paints lava as a
  hazard. The build keeps the mixed pair; two 2.5 plans are one setting away (the `image.read` purpose's `models`).
- **Seams.** The build opens a blocked line one cell wide between open ground when some plan saw it as ground: made
  for Qwen, which drew curbs and painted lines as solid strips. GPT's plans do not, and lined up, the rule only
  reopened walls one plan missed. Without it the reader gains 0.07 points (interval +0.03 to +0.11; better on 8
  places, worse on 1), so the GPT reader no longer opens seams. It does not close the lobby's glass partition, which
  the vote and the guided filter open between them.

## In the build

- `worldgen/mapalign.ts`: `planFrame` (the affine fit), `alignPlan` (the plan redrawn in the painting's frame), and
  `tileShifts`, the per-tile matches they share.
- `zones.ts`: `readOpenGpt` lines up every GPT plan before reading it, for judging paintings and for the finished map,
  and no longer opens seams;
  `gptDoors` lines up the door plan before reading its marks. The GPT reader's tag is now `g2`, so a built place is
  read again by `resettle`.
- `test/mapalign.test.ts`: a synthetic map of rooms, drawn shifted and stretched, is found and moved back.

## Spend

$0.26 of the $6 budget, all on GPT Image (`<study data>/office/spend.jsonl`): the trace wording and the wall-face
wording, each read by both models on two or three office places. Every accuracy number above comes from plans the
gpt-read study had already paid for.

## Where things are

- **Code:** `packages/server/src/cli/_exp/office/`.
  - `register.ts`: per-tile shifts of a plan against its painting.
  - `score.ts`: the 24-place scorer for each variant (in parallel processes; `sum` prints the totals), `paired.ts`
    the paired intervals.
  - `driftall.ts`: the drift table; `drift.ts`: the wording tests (with a spend cap and ledger).
  - `field.ts`: the smooth-warp variant.
  - `reread.ts`, `compare.ts` and `sheet.ts`: re-reading a built place and the pictures.
- **Outputs:** `<study data>/office` (scores per variant and place, masks, aligned plans).
- **Pictures:** `img/`. Each is the painting with the walkable ground in green, before on the left and after on the
  right.
