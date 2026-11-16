# Reading walkable ground with GPT Image (12 November 2026)

> **Kept as a record.** This is the write-up of a finished study. Its scripts (under `packages/server/src/cli/_exp/`), its data and most of the pictures it names were removed for the 1.0 release and are in
> git history at the tag `pre-1.0-experiments`, as are the other studies it cites that are no longer in
> `docs/experiments/` or `docs/baselines/`. Paths that begin with `<study data>` or `<tools>` were on the author's own
> machine and are in neither.

## The question

The build reads every painted place for where a person can walk (`docs/places.md`, "Reading the map"). Qwen-Image
2.1 redraws the map as four flat plans on the GPU: three three-colour walk plans and one six-colour "kind" plan. The
walk plans are voted per quarter-metre cell, and Luna settles the areas the plans disagree about. The kind plan only
stops Luna opening cells it paints solid ("quiet"). This reader, called today_quiet below, gets **95.7%** of the 3,574
points the author marked by eye on 24 places of four worlds (`docs/experiments/walk-prompts/`).

The author asked:

- Which GPT Image model reads best?
- Can cached reads save money?
- Can GPT readings, alone or stacked, read as well as Qwen?

The budget was $6.

## Answer

**Two GPT six-colour plans, one from GPT-Image-2.5 Sunburst and one from GPT-Image-2.6 Sunburst, voted per cell
with no Luna, read as well as today's Qwen reader with Luna.** Six such pairs, made from three 2.5 and two 2.6 answers,
score 95.3% to 96.1% of the marked points, 95.7% on average. That is the same as today_quiet.

The paired test redraws the 24 places with replacement (4,000 draws). It puts the best pair 0.2 points above
today_quiet, with a 90% interval of -2.0 to +2.4, and the weakest pair 0.4 below, with an interval of -2.8 to +2.0.
The pairs are better than today_quiet on 12 or 13 places and worse on 8 to 11.

| Reader (no Luna unless stated) | Plans per painting | Price per painting | Marked points right |
|---|---|---|---|
| Qwen: today's three walk plans | 3 (GPU) | GPU | 89.7% |
| Qwen: today's three walk plans, with Luna | 3 (GPU) | GPU + Luna | 93.4% |
| **Qwen: today_quiet, with Luna (the build)** | **4 (GPU)** | **GPU + Luna** | **95.7%** |
| Qwen: six-colour plan alone | 1 (GPU) | GPU | 89.9% |
| GPT 2.5 Sunburst six-colour plan alone (3 answers) | 1 | $0.019 | 92.1 to 94.2% (mean 93.5) |
| GPT 2.6 Sunburst six-colour plan alone (2 answers) | 1 | $0.040 | 93.8 to 94.3% (mean 94.0) |
| Two 2.5 Sunburst answers (3 pairs) | 2 | $0.038 | 94.2 to 95.3% (mean 94.7) |
| Two 2.6 Sunburst answers | 2 | $0.080 | 94.7% |
| **One 2.5 and one 2.6 Sunburst answer (6 pairs)** | **2** | **$0.059** | **95.3 to 96.1% (mean 95.7)** |
| Three or four GPT answers, mixed models | 3 or 4 | $0.08 to $0.12 | 95.7 to 96.0% |
| Two 2.5 Sunburst answers, with Luna | 2 | $0.038 + Luna | 94.1% |

What the table shows:

- **A single GPT plan already beats Qwen's three plans without Luna,** by 4 to 5 points. The plans are far cleaner:
  - Rugs come out as floor and furniture as solid, filled to its outline (`img/hq_models.jpg`).
  - The walls are crisp lines.
  - 2.6 Sunburst is the first reader to paint the Cinder Works' lava as a hazard (blue) instead of a walkway
    (`img/cinder_works_models.jpg`).
- **Two plans from different models vote better than two answers from one model,** by about a point (95.7% against
  94.7%). The same was true of Qwen, whose different prompts voted better than seeds of one prompt. Two models make
  different mistakes; two answers from one model make the same ones.
- **More than two plans adds nothing.** Three or four plans score within 0.3 points of the best pair.
- **Luna makes GPT readings worse.** Luna can only open cells, so every area she is asked about is a chance to open
  something solid. GPT's plans leave little in doubt. On the two-plan reader she fixed the Unfinished Bellfoundry's
  flooded floors (70% to 80%) but opened Lantern Shoals' pond (99% to 84%) and the Cinder Works' lava (97% to 85%).
  The net effect was 95.3% to 94.1%.

**Recommendation.** If reading moves to OpenAI:

- Read each painting with one 2.5 Sunburst and one 2.6 Sunburst six-colour plan, both at low quality and 1.4 MP.
- Vote the two plans as today's walk plans are voted, and keep the guided filter, the seams and mapfix.
- Drop Luna's doubt looks.
- The six-colour plan's red is the building plan, so the separate building plan goes too.

A cheaper choice is two 2.5 Sunburst answers: $0.038 a painting, about a point lower (94.7%, or -1.1 against
today_quiet, with an interval of -3.6 to +1.3).

## Which model

On the six hardest places (Bellwether HQ, the Business Corridor, the Cinder Works, Rimefen, Lantern Shoals and the
Interchange), each model read the same six-colour prompt once, at low quality and 1.4 MP. On these places
today_quiet with Luna gets 91.9%.

| Model | Price per reading | Six hard places | All 24 |
|---|---|---|---|
| Qwen-Image 2.1 (the study's six-colour plan) | GPU, about 27 s | 85.4% | 89.9% |
| GPT-Image-2.5 Flare | $0.019, 13 s | 90.6% | |
| GPT-Image-2.5 Sunburst | $0.019, 19 s | 93.1% | 94.2% |
| GPT-Image-2.6 Flare | $0.040, 10 s | 93.5% | |
| GPT-Image-2.6 Sunburst | $0.040, 35 s | 95.1% | 94.3% |

Sunburst reads better than Flare on both versions. 2.6 Sunburst led on the hard places, but over all 24 places and
two answers it is only half a point above 2.5 Sunburst alone, at twice the price. Its value is as the second voter.

Every model kept the map's layout: overlaid on the map, walls, rooms and paths line up across the whole picture
(the bottom rows of `img/hq_models.jpg` and `img/cinder_works_models.jpg`). Moderation refused none of the 174 calls.

**Settings that made no difference.** Each was tried on the six hard places:

- Medium quality ($0.027): 94.9%.
- The map at 2.4 MP ($0.022): 94.7%.
- Two low-quality answers at 1.4 MP, for comparison: 93.1% and 94.4%.

Both settings are inside the spread between two answers to the same request, so low quality at 1.4 MP stays.

**Prompts.**

- **The three-colour walk prompt.** The build's first walk prompt, read by 2.5 Sunburst, scores 92.9% alone, below
  the six-colour prompt. As a third voter it adds 0.1 to 0.4 points.
- **Shallow water as floor.** A six-colour prompt naming shallow, wadeable water as floor was tried for the
  Bellfoundry. It made the Bellfoundry worse (64% against 71%) and nothing better.
- **No answer repeats.** The API takes no seed, so a second request gets a different answer. Single answers vary by
  up to 2 points over the 24 places; pairs vary by under 1.

## Cached reads

Cached image input is billed at $2 a million tokens instead of $8, but only through the Responses API's image tool.
It does not apply on `/v1/images/edits` (the image generation guide, "Cached input pricing").

One test was run on Lantern Shoals (`cache.jsonl`):

- **The test.** The map and the six-colour prompt went to `gpt-6-luna` with the image tool. A follow-up turn then
  asked for a second plan of the same map.
- **The image model was sent both pictures.** The second turn gave it the map and its own first plan as input: 2,738
  image tokens instead of 1,369. Even if every one were billed at the cached price, the second plan would cost about
  $0.016, against $0.019 direct, and it risks copying the first plan rather than reading the map again.
- **Cache hits cannot be checked from the answer.** The guide says cached image tokens are reflected in billing but
  not in the response's usage, and the usage showed none. Only the billing dashboard would show a saving.
- **The most it could save is small.** The map's input tokens are about $0.011 of a $0.019 2.5 reading, and caching
  could save at most three quarters of that, about $0.008 per reading. That is about 15% of a two-model pair, it
  cannot be verified, and the Responses route adds a mainline model.

**Not worth it.** The real saving is reading each painting twice instead of four times.

## What it would cost

These are per world, with the same paintings as the cost report (`../gpt-image-cost/README.md`): 2.0 paintings per
place, 5, 8 and 12 places, and a door plan per town.

| | Small | Medium | Large |
|---|---|---|---|
| Two plans per painting (2.5 + 2.6 Sunburst) | $0.59 | $0.94 | $1.41 |
| Door plans in towns (2.6 Sunburst, `../gpt-doors`; first estimated with 2.5) | $0.03 | $0.06 | $0.09 |
| **GPT reading per world** | **$0.62** | **$1.00** | **$1.50** |
| Four GPT plans per painting, as the cost report assumed | $0.87 | $1.41 | $2.11 |
| The cheaper choice: two 2.5 Sunburst answers | $0.40 | $0.65 | $0.97 |

It also saves:

- the Luna doubt looks, about 1.5 cents per map;
- about 24, 39 and 58 GPU minutes per small, medium and large world, the Qwen reading of the cost report.

The two calls of a painting run at once, so a painting is read in the time of its slower plan: about 35 seconds for
2.6 Sunburst. Qwen takes about 2 GPU minutes for four plans.

## In the build (13 November)

The reader is now an option in the build:

- **The switch.** It is the `image.read` purpose (`mapread.ts` `gptPlan`, `zones.ts` `readOpenGpt`).
- **What it runs.** Two kind plans per painting go through the game's own model gateway, are voted, filtered and
  fixed, with Luna's crossing looks kept and her doubt looks dropped.

Run that way on the 24 places with fresh plans (a seventh pair; `build.ts`, `score_build.json`), it scores 95.9%
without the crossing looks and **96.1% with them**. That is 0.3 points above today_quiet (90% interval -2.5 to
+3.0), better on 14 places and worse on 8. The run cost $1.42, plans and crossing looks together.

Two places were painted at 1456 × 960 (three by two tiles). Every pair of calls came back without a refusal.

## A Flare pair, for batching (13 November)

Sunburst's batches can take hours, and Flare's come back in minutes, so a pair of the Flare models (2.5 and 2.6 Flare,
one plan each, `gfF`) was measured on all 24 places for batched reading. It reads **94.1%**, 1.7 points below
today_quiet (90% interval -3.5 to +0.1), against 95.7% for the Sunburst pair. Alone, 2.5 Flare reads 92.1% and 2.6
Flare 92.5%. Quality comes first, so the reader stays on Sunburst, read directly by default. The Batch API is one
setting away (`docs/places.md`). The 18 more places of each model cost $1.06.

## Where it still misses

The Unfinished Bellfoundry is the one place GPT reads clearly worse: 73 to 75% for every pair, where Qwen's six-colour
plan gets 88% (`img/bellfoundry_plans.jpg`, `img/bellfoundry_misses.jpg`). The misses are matters of convention more
than layout:

- **The dark, unlit halls** in the middle of the map were marked blocked (magenta dots). GPT reads them as floor.
  Qwen's walk prompts paint "unlit dark areas" black, which happens to match the marks.
- **The stone under shallow teal water** was marked walkable (red dots). GPT paints it as water. Naming wadeable water
  as floor did not change that.

The next worst places for the recommended pair are the Gallows Mine (89 to 96% across the six pairs), the Frostglass
Grotto (91 to 97%) and Rimefen (93 to 96%). On these, the score depends most on which answers were drawn.

## Not tested

- **The door plan.** Only walk reading was tested here. The door plan was measured later (`../gpt-doors/README.md`):
  GPT Image 2.6 Sunburst now draws it, at about $0.031 a town.
- **The build itself.** The scores come from the walk-prompt study's scorer, which runs the build's own later steps
  (guided filter, openOf, seams and mapfix). The GPT reader is not wired into `mapread.ts`.
- **The painting judge.** The build reads each painting to judge it and keeps the first sound one. A reader with
  different mistakes would accept and reject different paintings. That only shows in real builds.

## Spend

The build test cost $1.42 of a further $5, counted in the walk studies' ledger. The study itself cost $4.69 of the $6
budget:

- $4.42 for 174 direct GPT Image readings.
- $0.05 for the cached-read test.
- $0.21 for one 24-place Luna run.

Each call is in `spend.jsonl`. Luna's spend is counted in the walk studies' ledger, `<study data>/seeds/spend.json`.

## Where things are

- **Code:** `packages/server/src/cli/_exp/gptread/`.
  - `lib.ts`: the GPT reading client, with a spend cap and ledger.
  - `readings.ts`: every reading and reader tried.
  - `run.ts`: `make` and `score`.
  - `paired.ts`: the interval against today_quiet.
  - `cache.ts`: the Responses API test.
  - `side.ts` and `errs.ts`: the pictures.

  The GPT plans are cached with the Qwen plans in `<study data>/prompts/qwen`, under their reading ids. One fix was needed
  to run the walk studies from the main checkout: `seeds/lib.ts` now finds the worlds there as well as from a worktree.
- **Scores:** `score_*.json`, each holding per-place marks. `score_qwen_baseline.json` holds Qwen's readers without
  Luna.
- **Pictures:** `img/`.
  - `hq_models.jpg` and `cinder_works_models.jpg` show, from the left, the map, Qwen's plan, 2.5 Flare, 2.5 Sunburst,
    2.6 Flare and 2.6 Sunburst. Below each plan is the plan laid over the map.
  - `bellfoundry_plans.jpg` shows Qwen's plan, 2.5 Sunburst, 2.6 Sunburst and 2.5 Sunburst's three-colour walk plan.
  - `bellfoundry_misses.jpg` shows the pair's walkable ground in green, with the marks:
    - cyan: walkable and read right;
    - yellow: blocked and read right;
    - red: walkable but read blocked;
    - magenta: blocked but read open.

## Summary

- **Accuracy.** GPT Image reads walkable ground as well as Qwen. One 2.5 Sunburst and one 2.6 Sunburst six-colour plan,
  voted per cell with no Luna, get 95.7% of the author's 3,574 marked points on 24 places. That is the same as today's
  Qwen reader with Luna, within an interval of about ±2.4 points.
- **Models.** Sunburst beats Flare. Mixing the two models beats two answers from one. More than two plans, a higher
  quality setting, a larger map and Luna each add nothing or make the reading worse.
- **Cached reads.** They are not worth it: Responses API only, unverifiable from usage, and about 15% at best. Reading
  twice instead of four times is the saving.
- **Cost.** The reading would cost about $0.62, $1.00 and $1.50 per small, medium and large world, saving 24 to 58
  GPU minutes and Luna's doubt looks. Two 2.5 Sunburst answers would cost a third less, for about a point of accuracy.
- **Remaining risk.** One place, the Unfinished Bellfoundry, reads clearly worse, over dark halls and shallow water.
  The door plan and real builds are untested.
