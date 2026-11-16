# Marking town doors with GPT Image (13 November 2026)

> **Kept as a record.** This is the write-up of a finished study. Its scripts (under `packages/server/src/cli/_exp/`), its data and most of the pictures it names were removed for the 1.0 release and are in
> git history at the tag `pre-1.0-experiments`, as are the other studies it cites that are no longer in
> `docs/experiments/` or `docs/baselines/`. Paths that begin with `<study data>` or `<tools>` were on the author's own
> machine and are in neither.

## The question

The build reads every painted place for where people can walk. With the `image.read` purpose configured, GPT Image
does that reading instead of Qwen-Image (`../gpt-read/README.md`), so a build should not need Qwen on the GPU at all.
One step still used Qwen: in every town, a **door plan** marks each door with a yellow square (`docs/places.md`,
"Entrances and landmarks"). The steps around it are:

- Luna lists every building's entrance on gridded crops of the map (`findEntrances`).
- Each of her spots then moves onto the nearest door mark within 3 m (`fuseDoors`).
- A mark she missed is kept as "a building" where the plan painted a building beside it.
- Spots closer than 4.5 m are shown to Luna in pairs, and she keeps one per building (`dropSameBuilding`).

So every town still loaded Qwen during a build. The author noticed this and expected GPT Image only.

The question: can GPT Image draw the door plan at least as accurately as Qwen, so a build with `image.read` never loads
Qwen? Reader accuracy comes before price and speed. The budget was about $2.

## Answer

**Yes. GPT Image 2.6 Sunburst, asked for one yellow square per painted door, marks town doors better than Qwen.** In
the build's own entrance steps, it gives a spot at the door to **61% and 62%** of the labelled buildings in two
answers, where two Qwen seeds give **55% and 53%**. It finds a spot for 97 to 99% of the buildings, against Qwen's 91%.
It costs about **$0.031 and 34 seconds per town**, against about 22 seconds of GPU for Qwen.

It is now the door plan whenever `image.read` is configured. A build with `image.read` loads no Qwen.

## Ground truth

In October 2026 the entrance study hand-labelled five towns (`<study data>/ents/gt/<town>.json`). For each building it
recorded:

- the building's box;
- the points on the ground in front of each of its doors that count as "at the door" (a long tent can have several);
- whether the building is optional: small or ambiguous enough that missing it costs nothing.

| Town | Buildings (required) | Character |
|---|---|---|
| Brinewake | 42 (35) | A fishing town on stilts, painted doors |
| Cliff-top city | 54 (39) | Dense, joined rows, few painted doors |
| Gingerbread village | 40 (33) | Separate houses, doors mostly on the lower side |
| Sporewick (mushroom village) | 24 (22) | Mushroom houses |
| Redcleft Bazaar (canyon) | 29 (23) | Tents, yurts and cave dwellings |

The paintings are the October 3072 × 2048 maps at 40 px per metre (`<study data>/tiles/...`). Luna's entrance spots are
the study's cached ones (`<study data>/ents/markers`). Every reader below was fed the same paintings and the same Luna
spots, so only the door marks differ.

## How it was scored

Three measures, all against the 152 required buildings:

- **Marks alone.**
  - A building counts as *marked at its door* when a mark lies within 1.5 m of one of its door points.
  - Marks and buildings are matched one to one, closest pairs first.
  - A mark more than 3 m from every labelled door counts as *stray*.
- **Fused.** As the build does it: Luna's spots moved onto the marks, plus marks she missed that lie beside a building.
- **End to end.**
  - The fused spots after Luna's same-building pairs (`dropSameBuilding`, run for real).
  - A building is *found* when a spot lies within 2 m of its box or 3 m of a door point.
  - A spot is *at the door* when it lies within 1.5 m of a door point.
  - *Extra* spots match no labelled building: a building's second spot, or a spot near no building.

The build's step that moves spots onto walkable ground (`ontoWalk`) was left out, for every reader alike, since it
needs a walk reading. It moves spots by up to 3 m.

## What was tried

Every GPT plan was made at low quality, with the map at 1.4 MP (1456 × 960), as the walk reader asks for its plans.

| Variant | Model | Prompt |
|---|---|---|
| `q`, `q2` | Qwen-Image 2.1 (October's seed 0, and seed 2) | The build's door plan (`DOOR_PLAN`) |
| `d25` | GPT Image 2.5 Sunburst | Qwen's door plan |
| `d26`, `d26b` | GPT Image 2.6 Sunburst | Qwen's door plan |
| `k25`, `k26` | 2.5 / 2.6 Sunburst | The walk reader's six-colour kind plan, with yellow squares at doors added |
| `o25` | 2.5 Sunburst | One square per painted door (`GPT_DOOR_PLAN`) |
| `o26`, `o26b` | 2.6 Sunburst | One square per painted door (`GPT_DOOR_PLAN`) |

The kind-plan variants were tried because they would cost nothing extra: the walk reader already asks GPT for that
plan, so it could have carried the doors too.

## Results

**End to end** (after Luna's pairs), the measure that decides what the game gets:

| Variant | Found | At the door | Spots | Extra |
|---|---|---|---|---|
| Qwen `q` | 91% | 55% | 218 | 56 |
| Qwen `q2` | 91% | 53% | 215 | 52 |
| 2.6, Qwen's prompt `d26` | 97% | 59% | 244 | 70 |
| 2.6, Qwen's prompt `d26b` | 98% | 53% | 258 | 81 |
| **2.6, one per door `o26`** | **99%** | **61%** | 245 | 69 |
| **2.6, one per door `o26b`** | **97%** | **62%** | 241 | 66 |
| 2.6, kind plan with doors `k26` | 97% | 50% | 238 | 66 |
| 2.5, one per door `o25` | 98% | 50% | 262 | 84 |
| 2.5, kind plan with doors `k25` | 99% | 42% | 272 | 92 |
| 2.5, Qwen's prompt `d25` | 98% | 39% | 258 | 82 |

**Per town, at the door, end to end** (two answers each):

| Town | Qwen `q` / `q2` | 2.6 one per door `o26` / `o26b` |
|---|---|---|
| Brinewake | 63% / 54% | 60% / 54% |
| Cliff-top city | 44% / 46% | 41% / 51% |
| Gingerbread village | 58% / 61% | 70% / 70% |
| Sporewick | 82% / 77% | 91% / 91% |
| Redcleft Bazaar | 35% / 30% | 52% / 52% |

**Marks alone and fused** (before Luna's pairs):

| Variant | Marks | Marked at door | Within 3 m | Stray | Fused: found | Fused: at the door |
|---|---|---|---|---|---|---|
| Qwen `q` | 171 | 51% | 63% | 31 | 93% | 62% |
| Qwen `q2` | 139 | 41% | 55% | 26 | 91% | 58% |
| 2.6, Qwen's prompt `d26` | 346 | 61% | 82% | 99 | 98% | 68% |
| 2.6, Qwen's prompt `d26b` | 266 | 54% | 83% | 86 | 99% | 63% |
| 2.6, one per door `o26` | 228 | 55% | 78% | 68 | 99% | 64% |
| 2.6, one per door `o26b` | 242 | 61% | 80% | 62 | 97% | 70% |
| 2.6, kind plan `k26` | 218 | 48% | 72% | 66 | 97% | 59% |
| 2.5, one per door `o25` | 281 | 46% | 78% | 78 | 99% | 58% |
| 2.5, kind plan `k25` | 282 | 32% | 72% | 111 | 99% | 49% |
| 2.5, Qwen's prompt `d25` | 357 | 43% | 81% | 130 | 99% | 53% |

What the tables show:

- **GPT Image 2.6 Sunburst marks doors on every side of a building.** Qwen marks almost only a building's lower side.
  That is where most of the gain comes from: on the canyon, whose tents and caves open every way, 2.6 puts spots at
  the door for 52% of the buildings against Qwen's 30 to 35% (`img/canyon_spots.jpg`). On the gingerbread village,
  where 2.6 finds the doors on the sides, it is 70% against 58 to 61% (`img/gingerbread_spots.jpg`).
- **Asked as Qwen is asked, 2.6 rings each building with squares.** Where a front has no painted door, it lines the
  front with small squares (`img/city_ring.jpg`, the dense city: 173 marks for 39 buildings). Luna's pairs prune most
  of them, but the two answers varied widely (59% and 53% at the door).
- **Asking for one square per painted door fixes that.** The city's marks fall from 173 to 91 (`img/city_one.jpg`),
  stray marks over all five towns fall from 86-99 to 62-68, and the two answers agree (61% and 62%).
- **2.5 Sunburst is clearly worse at doors,** whatever the prompt: 39 to 50% at the door, below Qwen.
- **Doors on the walk reader's kind plan are worse than a door plan of their own.** The combined plans put fewer
  spots at the door (2.6: 50%; 2.5: 42%). Adding doors would also change the walk plan, whose 95.7% accuracy was
  measured without them. Saving $0.031 a town is not worth either.
- **GPT leaves a few more extra spots.** Two or three more per town than Qwen, after Luna's pairs (66 to 69 against 52
  to 56 over the five towns). Some are small stalls or sheds the labels left out, others a second spot on a long
  building more than 4.5 m from the first. Placement chooses among all the spots by their descriptions, so a few more
  candidates is a small cost next to finding a building's door.
- **Neither reader marks the dense city well.** It has few painted doors, and Qwen and 2.6 both reach 41 to 51% at
  the door there.

## Cost and time per town

| Door plan | Price | Time |
|---|---|---|
| Qwen-Image 2.1 | GPU | 20 to 25 s, plus loading Qwen when nothing else needs it |
| GPT Image 2.5 Sunburst | $0.0165 | 18 s |
| **GPT Image 2.6 Sunburst** | **$0.031** | **34 s** |

Prices are from each answer's token usage: image input at $8, text input at $5 and image output at $30 a million
tokens. GPT's door plan runs at the same time as Luna's entrance search, which takes longer, so the 34 seconds adds
little to a town. GPT's extra marks give Luna about twice as many pairs to look at, which costs under a fifth of a
cent a town.

## In the build

With `image.read` configured, the build now:

- asks GPT Image 2.6 Sunburst for the door plan with `GPT_DOOR_PLAN` (`mapspots.ts`);
- reads its marks as Qwen's were read (`doorMarks`);
- saves the plan's picture in the place's draft, so a resumed build pays for it once (`zones.ts` `gptDoors`).

The plan goes through the Batch API like the walk plans, unless the purpose says `batch: false`, as the main
configuration does. Without `image.read`, Qwen draws the door plan as before. The build estimate
(`packages/shared/src/rules/estimate.ts`) now counts $0.031 per town for the door plan and no GPU time for it.

## Limits

- **Five towns, two answers per reader.** The gain at the door (about 7 points end to end) is larger than either
  reader's spread between answers (2 to 6 points). 2.6 is level or better on four towns and 1.5 points lower on
  Brinewake, averaged over the two answers. Five towns cannot rule out a kind of town where it does worse.
- **October's paintings.** The labelled towns were painted by the October painter. Today's Klein paintings were not
  labelled, so they were not scored.
- **No real build.** The door plan was scored through the build's own functions on saved paintings, not in a full
  build, which the brief ruled out.

## Spend

The study cost **$1.16 of the $2 budget**:

- **$1.015 for 40 GPT Image door plans.** These were 15 from 2.5 Sunburst and 25 from 2.6 Sunburst, each logged in
  `<study data>/gptdoors/spend.jsonl`.
- **$0.143 for 2,145 Luna looks.** These were the pair checks of the end-to-end runs, counted from the meter log.

Qwen's plans ran on the local GPU.

## Where things are

- **Code:** `packages/server/src/cli/_exp/gptdoors/`.
  - `run.ts`:
    - `make <variant>` asks GPT for the plans, under a spend cap.
    - `qwen [seed]` makes Qwen's plans.
    - `score` scores the marks alone and fused.
    - `e2e` runs and scores the end-to-end step.
  - `sheet.cjs` and `zoom.cjs` draw the pictures.
- **Plans and results:** `<study data>/gptdoors/`.
  - `plans/<town>_<variant>.png` holds the plans.
  - `e2e/` holds the final spots.
  - `score.json` holds the scores.
- **Pictures:** `img/`.
  - `canyon_spots.jpg` and `gingerbread_spots.jpg` compare Qwen's end-to-end spots (left) with 2.6's (right). Cyan
    rings mark the labelled door points, 1.5 m across. Green spots are within 1.5 m of a labelled door; orange spots
    are not.
  - `city_ring.jpg` shows the city with 2.6's plan from Qwen's prompt.
  - `city_one.jpg` shows the same crop with 2.6's plan from the one-per-door prompt.
