# Narrow and many-colour walk prompts (29 to 30 October 2026)

> **Kept as a record.** This is the write-up of a finished study. Its scripts (under `packages/server/src/cli/_exp/`), its data and most of the pictures it names were removed for the 1.0 release and are in
> git history at the tag `pre-1.0-experiments`, as are the other studies it cites that are no longer in
> `docs/experiments/` or `docs/baselines/`. Paths that begin with `<study data>` or `<tools>` were on the author's own
> machine and are in neither.

## The question

The build reads each place's walkable ground from three Qwen-Image edit plans of the whole map (`WALK_READINGS` in
`packages/server/src/worldgen/mapread.ts`, called p0, p1 and p2 below). Each plan paints the map in three colours
(white walkable, black solid, blue water), and the three are combined per quarter-metre cell. The walk-seeds study
(`docs/experiments/walk-seeds/README.md`) found that the remaining errors come from the prompts disagreeing in
systematic ways, not from seed noise. This study works on the prompts.

The author judged the readers by eye on the study's places and named the big misses:

- **The Business Corridor.** Every reader misses its asphalt roads.
- **Bellwether HQ.** Every reader except one leaves most rooms closed. That one, a_sure_today_cutP, cuts a few walls,
  which is acceptable.
- **The Cinder Works.** Every reader struggles with the stairs.

The author's guidance on approach:

- Prefer simple, general rules, and don't combine many masks unless they are needed.
- Not being perfect is better than not generalising.
- "Fully connected does not imply the walkability mask is accurate."

## Answer

**Keep today's three walk plans, add one six-colour plan, and use it only to tell Luna which patches not to open.
With Luna, as the build runs, this gets 95.7% of the marked points on 24 places right, against 93.4% for today's
reader.** (The table just below is from the first 20 places; "Final evaluation" has all 24, including four places
marked after every reader was settled.)

A six-colour plan names what each thing is (floor, way, plant, building, obstacle, water) rather than whether it is
walkable. The rule, called "quiet" below, is one line: where the six-colour plan paints a cell solid, the plans'
evidence that the cell might be walkable is cleared, so Luna is not asked to open it. Luna only ever opens cells, so
the rule can only stop her opening something.

| Reader, with Luna | All | Tuned | Held out | Worst places |
|---|---|---|---|---|
| today (p0, p1, p2) | 94.1% | 92.8 | 95.0 | HQ 79, Cinder Works 81, Lantern Shoals 88 |
| today_quiet | **95.9%** | 96.3 | 95.7 | Cinder Works 81, Lantern Shoals 88, Morrow Annex 92 |
| a_sure_today_cutP (best earlier reader) | 95.1% | 95.2 | 95.0 | Lantern Shoals 83, Cinder Works 86 |
| a_sure_today_cutP_quiet | 96.1% | 96.6 | 95.7 | Lantern Shoals 83, Cinder Works 85 |

The held-out places improve too, so the gain is not just fitted to the places the prompts were shaped on. today_quiet
is the simpler of the two top readers by far (a_sure adds three narrow masks), so it is the recommendation. It costs
one more Qwen picture per place (about 27 seconds at 1.4 MP), and slightly less Luna, since she is asked fewer
questions.

**The reader recommended before Luna was tried is not the best with Luna.** Without Luna, D01_six3_plusWays (two
rewritten walk prompts and the six-colour plan voting, its ways opened as sure ground) led with 93.2% against 88.5%
for today's reader. With Luna it falls to 91.6%, below today's 94.1%. Luna already fixes most of today's misses
(the Business Corridor goes from 66% to 96% and the Interchange from 66% to 95%), and the ways rule opens things she
would have kept closed. The sections below describe how the six-colour plan was found; "Luna" gives the scores, and "Final evaluation" weighs every idea again with Luna, with intervals, and finds today_quiet the best combination.

## How it was measured

- **Places.** The 21 places of the earlier walkability studies, plus 8 new places painted alone with the build's
  place pipeline (`zones.paintAndRead`, script `packages/server/src/cli/_exp/prompts/paint.ts`, world `wp1` in
  `<study data>/prompts/painted`):
  - Ledgefall: houses on cliff ledges joined by rope bridges.
  - The Interchange: a truck stop in a freeway interchange.
  - The Long Ice: an arctic camp with crevasses.
  - Blackwater Fen: boardwalks over a marsh.
  - The Clipped Garden: a hedge maze.
  - The Cinder Works: a lava foundry.
  - The Gallows Mine.
  - The Rime Cavern.

  Painting cost $0.031 of OpenAI. Every reading since has used only the GPU.
- **Marks.** The author marked walkable and blocked points on 20 places in the labelling page
  (`packages/server/src/cli/_exp/prompts/labeller.ts`). The points are kept in `<study data>/prompts/labels.json`.
  - **Tuned places.** The first 9 marked places were used while shaping the prompts: thim_t0_0, thim_w0_0, warm_t0_0,
    warm_w0_1, bell_t0_0 (HQ), bell_w0_0, bell_w0_1 (the Business Corridor), bell_t1_0 (the Morrow Annex) and
    thim_d0_1.
  - **Held-out places.** The other 11 were marked later and are reported apart: the 8 new places, thim_d0_0,
    warm_w0_0 and warm_d0_0.
- **The reader's later steps.** Every reader is the plans' combination followed by the build's own later steps
  without Luna: the guided filter, `openOf`, the seams and `mapfix`. Scores are the share of marked points the "open"
  map gets right (`packages/server/src/cli/_exp/prompts/score.ts`; `split.ts` prints the tuned and held-out split).
- **Pictures.** Readers are compared by eye in unmarked 2×2 pictures (`side.ts` with `MARKS=0`), as the author asked,
  because the point scores hid big misses before.

## What was tried, and what was learned

### Removing the wording that dark means blocked

Today's prompts paint "unlit dark areas" black (p1) and "the empty darkness" blue (p0). Qwen marks dark ground black
or blue whatever else the question asks, so dark asphalt, dark carpet and iron floors are lost.

The three prompts were rewritten without that wording, with ground of any colour named walkable (walkD0, walkD1 and
walkD2). Their vote, todayD, rises from 88.5% to 90.0%. On their own they still blacken the Business Corridor's roads
(walkD1) or paint them blue (walkD2). Without the dark wording, Qwen painted HQ's dark carpets blue, so two variants
kept blue for real water only (walkD0w and walkD1w); they changed little.

Evening out the map's brightness before Qwen sees it (CLAHE) barely changed the Business Corridor, whose road is
mid-grey rather than dark. It is on hold; the author also felt it "smells like a hack".

### A "ways" mask

A prompt asking only for what people walk along (roads, stairs, bridges, docks, catwalks and so on) opens the roads.
But it also paints roofs white. Added as sure ground it drops the reader to 72%, and as a fourth vote to 87.6%.

### Six colours (the author's idea)

With three colours, Qwen must force every patch into floor, solid or water. A dark road or carpet is none of the
three to it, so it guesses, and the guess changes from prompt to prompt. Given a colour per kind of thing, Qwen only
has to say what each thing is, which it does well, and the reader decides what is walkable:

| Colour | Kind of thing | Read as |
|---|---|---|
| White | Floors and open ground, carpets and rugs included | Walkable |
| Magenta | Ways (roads, paths, stairs, bridges, catwalks, grates) | Walkable |
| Green | Dense plants | Solid |
| Red | Buildings and roofs | Solid |
| Black | Walls, furniture, vehicles, rocks | Solid |
| Blue | Water, lava, pits, outside | Water |

Each pixel is read as its nearest palette colour, and a pixel near none of them is no answer.

The six-colour plans of HQ are the clearest plans of it so far: the corridors are a way, the rooms are floor and the
furniture is solid (`img/hq_six_colour_plans.jpg`).

Three versions were made, each fixing what the one before showed:

1. **six: ways in yellow.**
   - HQ's blue rugs came out blue, which reads as water.
   - The Cinder Works' lava came out yellow, which reads as a way.
   - The Morrow Annex's wooden desks came out yellow too (`img/morrow_annex_six_colour_plans.jpg`). Qwen keeps a
     thing's own hue when it is near a palette colour.
2. **six2: rugs named as floor.** Little changed. The same prompt at 2.4 MP (six2b) was worse: dark corridors came out
   green.
3. **six3: ways in magenta, a colour maps hardly use.** Yellow and orange now count as no answer.
   - The desks no longer read as walkable.
   - The lava still comes out magenta (`img/cinder_works_six_colour_plans.jpg`). Qwen really does take the lava
     channels for ways, so this is a confusion of kinds, not of hue. The author rates lava as a minor issue.

On its own a six-colour plan is not better than today's reader. six3 gets 90.0%, but only 87.7% on the held-out
places, and voting it against itself at three seeds gets 90.8%. Its strength is in a vote with the other prompts:

| Reader | Pictures | Tuned | Held out | All | Worst places |
|---|---|---|---|---|---|
| today (p0, p1, p2) | 3 | 85.8 | 90.4 | 88.5 | HQ 62, Business Corridor 66, Interchange 66 |
| a_sure_today_cutP (best earlier reader) | 3 + 3 masks | 90.3 | 93.4 | 92.1 | Cinder Works 72, Business Corridor 72 |
| todayD (the three rewritten prompts) | 3 | 89.5 | 90.4 | 90.0 | Interchange 55, HQ 68 |
| todayD_six3 (four-plan vote) | 4 | 91.4 | 92.3 | 91.9 | HQ 78, Interchange 80 |
| todayD_six3_plusWays | 4 | 92.9 | 92.9 | 92.9 | Interchange 80, warm_w0_1 83, HQ 83 |
| **D01_six3_plusWays** | **3** | **94.0** | **92.6** | **93.2** | **Interchange 80, warm_d0_0 84, Morrow Annex 85** |
| todayD_six3x3_plusWays (six3 at three seeds) | 6 | 95.2 | 91.7 | 93.1 | Interchange 79, Long Ice 80 |
| today_six3_plusWays (today's plans + six3) | 4 | 91.3 | 94.3 | 93.0 | HQ 71, Cinder Works 83 |

What the table shows:

- **Opening the ways works with magenta, not yellow.** With yellow ways the same rule drops to 91.5%, because the
  yellow desks open.
- **Giving the six-colour plan more weight overfits.** Counting it twice, or at three seeds, lifts the tuned places
  and lowers the held-out ones.
- **Dropping walkD2 keeps the reader at three pictures with no loss.** The other three-picture votes do worse:
  walkD0 + walkD2 + six3 gets 90.6%, walkD1 + walkD2 + six3 91.0%, and p1 + p2 + six3 91.2%.

The differences among the top rows are about one point, about the size of the noise on these marks. The pictures
decide between them, and they favour D01_six3_plusWays.

### The pictures

Each picture shows today's reader (top left), a_sure_today_cutP (top right), the four-plan vote with the ways opened
(bottom left) and D01_six3_plusWays (bottom right). Green is walkable.

- `img/business_corridor_readers.jpg`: the roads and parking lots open only with the six-colour plan.
- `img/hq_readers.jpg`: D01_six3_plusWays opens the corridor cross and nearly every room.
- `img/cinder_works_readers.jpg`: the stairs, the catwalks and the octagon open. So does the lava, as with every
  reader.
- `img/ledgefall_readers.jpg`: the three bridges open. A few market-stall awnings open too.
- `img/interchange_readers.jpg`: the roads are as good as a_sure's, but many trucks open.
- `img/morrow_annex_readers.jpg` and `img/gallows_mine_readers.jpg`: much the same as before. A few beams of the
  mine's headframe open over its shaft.

## Luna

Luna is the build's later step that settles the cells the plans argue about (`judgeDoubts` and `judgeRoute` in
`mapread.ts`). She is asked only about blocked patches of 2 m² or more where some plan saw walkable ground, and she can
only open cells. Every reader below was scored with her, through the same `finish()` steps as without her.

| Reader, with Luna | All | Tuned | Held out |
|---|---|---|---|
| a_sure_today_cutP_quiet | 96.1% | 96.6 | 95.7 |
| **today_quiet** | **95.9%** | 96.3 | 95.7 |
| a_sure_today_cutP | 95.1% | 95.2 | 95.0 |
| today | 94.1% | 92.8 | 95.0 |
| today_six3_plusWays | 92.9% | 92.5 | 93.2 |
| D01_six3_plusWays with outlines filled | 92.8% | 92.7 | 92.9 |
| D01_six3_plusWays_quiet | 92.3% | 92.9 | 91.9 |
| D01_six3_plusWays | 91.6% | 91.0 | 92.1 |
| todayD_six3_plusWays | 90.8% | 90.1 | 91.4 |

What the scores show:

- **Luna does not lean towards walkable on her own,** but she can only open, so every doubt a reader sends her is a
  chance to open something. The ways rule and the rewritten walk prompts send her more doubtful patches, and she opens
  some that are solid: the Morrow Annex's desks and part of Lantern Shoals' pond (blocked points right fall from 1393
  to 1312 with D01_six3_plusWays).
- **Quieting mostly helps HQ.** On today's reader with Luna it lifts HQ from 78.6% to 97.0% of the author's marks, above
  the ways rule's 93.6%, because Luna no longer opens its desks and tables. The Rime Cavern gains 5 points and the
  Interchange 2. No place loses more than a point.
- **The older ground truth disagrees at HQ.** The 400 points of the first walkability study (`<study data>/walk/gt`,
  marked on the 21 older places only) fall at HQ from 88.9% to 77.8% with quieting, and at Thimblebrook and Lantern
  Shoals by about 3 points, while the Headquarters Parking Lot and the Business Corridor gain about 3. Those points
  were marked before the author's marks and are fewer per place, so the author's marks are what this report scores by,
  but HQ is worth a look by eye before quieting goes into the build.

Luna's spend for these runs is in "Spend" below.

## Further tests of the six-colour plan

These ran after the Luna scores, all without Luna and on the GPU only, to find out whether the six-colour plan itself
could be made better. None beat it, except the outline filling of the next section.

### Four colours

The author asked whether six colours were too many. A four-colour plan merges plants and buildings into black (white
floor, magenta ways, black solid, blue water). It is much worse: 77.3% alone against 90.0%, and 83.5% against 93.2%
in the D01 vote. Without the plants and buildings classes Qwen paints nearly every object magenta, the ways colour,
which the ways rule then opens (`img/cinder_works_six_vs_four.jpg`: the Cinder Works' desks, machines and inner walls
all turn magenta). The extra classes are decoys: they give Qwen somewhere harmless to put the things it is unsure of.

### Eight colours

Two more decoys were added for the commonest slips: cyan for furniture and vehicles ("filled solid to their outline")
and orange for hazards (lava, fire, pits). Both read as solid.

| Reader | All | Tuned | Held out |
|---|---|---|---|
| six3 alone | 90.0% | 93.2 | 87.7 |
| eight alone | 90.4% | 95.1 | 87.1 |
| D01_six3_plusWays | 93.2% | 94.0 | 92.6 |
| D01_eight_plusWays | 93.9% | 97.0 | 91.8 |

The gain is all on the tuned places, whose errors the two classes were chosen against, and the held-out places go
slightly down, so it is overfitting. By eye (`img/cinder_works_six_vs_eight.jpg`, `img/interchange_six_vs_eight.jpg`):
the Cinder Works' lava ring turns orange, but its star-shaped lava channels stay magenta; the pond turns cyan instead
of blue; the Interchange's trucks are still outlines, now cyan ones. Six colours stay.

### Naming a thing's own colour

The prompts that drew vehicles as line art all say something like "whatever its colour" or "never by its own colour".
The guess was that naming colour makes Qwen attend to it. walkD0 and six3 were made with those phrases removed (walkD0n
and six3n), at seeds 1 and 1001, on four places. The phrases make little difference; the seed makes much more
(`img/interchange_colour_phrase_seeds.jpg`, `img/hq_colour_phrase_seeds.jpg`). At the Interchange both versions draw
the trucks as line art at seed 1 and fill them dark at seed 1001. At HQ the rugs keep their own colours (blue, green,
magenta, orange) in all four pictures, although the prompt names rugs as white floor.

### Less colour in the map

To stop rugs keeping their own hue, the map was given to Qwen with less colour: half, a quarter, a tenth and none
(grey). The rugs do turn white (`img/hq_less_colour.jpg`), but Qwen loses the water: at Lantern Shoals the water
between the islands turns white at 10% colour, and in grey the shores become magenta paths
(`img/lantern_shoals_less_colour.jpg`). The Interchange's trucks are painted red and white even in grey, so Qwen
invents those colours rather than copying them.

| six3 on the map at | All | Tuned | Held out |
|---|---|---|---|
| Full colour | 90.0% | 93.2 | 87.7 |
| Half colour | 88.7% | 92.9 | 85.8 |
| A quarter | 88.1% | 92.7 | 84.8 |
| A tenth | 87.7% | 92.1 | 84.6 |
| Grey | 88.2% | 93.0 | 84.8 |

As extra voters they add nothing: D01 with the half-colour plan instead of full colour gets 93.5%, with a tenth 93.8%,
and with grey added as a fourth voter 93.3%, all within noise of 93.2%. Colour helps Qwen more than it misleads it.

### Seeds

The six-colour plan at seeds 1, 2 and 3 on all 20 places gets 90.0%, 88.4% and 91.8%. Seed 3's lead over seed 1
averages about 2 points per place with a spread of about 5, so it is luck, and there is no reason a seed should carry
over to another map or picture size. Voting the three seeds (90.8%) is no better than the average seed, because seeds
of one prompt make the same kinds of mistakes; different prompts vote better.

The author asked whether a check on a picture could pick a better seed instead. Three measures were tried on the 60
pictures: the area of line art the outline filler fills, the share of pixels off the palette, and the share of the
plan that keeps the map's own hue. None predicts which seed of a place scores better (rank correlations 0.02, -0.12
and 0.10). Retrying with another seed when line art covers more than a set share of the picture gains under half a
point at any threshold, at up to 50% more pictures. The places with heavy line art (the Cinder Works, the Unfinished
Bellfoundry) have it at every seed, and the worst failures, such as the Morrow Annex at seed 2 (66%), are clean plans
with the layout wrong, which only another reader can catch.

## Known faults of the six-colour plan

These were written about D01_six3_plusWays, where the six-colour plan votes. In today_quiet it only stops Luna, so
its faults there are floor painted solid, which Luna can then no longer open.

- **Vehicles drawn as outlines.** Both walkD0 and six3 draw the Interchange's trucks as thin outlines with white
  bodies, although the prompts ask for vehicles filled solid (`img/interchange_vehicles.jpg`). The outline is
  anti-aliased grey, a pixel or two wide and thinner than a cell, so the truck opens. See "Filling closed outlines"
  below.
- **Desks in the Morrow Annex.** Both new readers open parts of the desk clusters, which today's reader and a_sure keep
  closed (`img/morrow_annex_fill.jpg`). six3 paints the desks in their own brown, which is no answer, so the cells are
  left to the two walk prompts.
- **Blue rugs.** A few of HQ's blue rugs are still painted blue (water). In the vote the other two plans mostly
  outvote them.
- **Lava.** The lava reads as walkable, as with every reader so far.
- **Dark parking lots read as water.** six3 painted the Interchange's dark parking loop blue. The vote keeps most of
  it open.

## Filling closed outlines

Before a plan is read into cells, any white patch under 40 square metres whose edge is mostly a fairly dark outline
is filled black (`fillOutlines` in `packages/server/src/cli/_exp/prompts/lib.ts`). A room is left alone, because its
doorway joins it to the white beyond. A closed room is unreachable anyway.

- **What it fills that is right.** The trucks, and HQ's tables, which Qwen also draws as outlines.
- **What it fills that is wrong.** Some walkable things: two of HQ's rugs drawn as outlined squares, a few traffic
  islands, and part of the Interchange's parking loop (`img/interchange_fill.jpg`, bottom right).

On the marks it lifts D01_six3_plusWays from 93.2% to 93.7%, with the same half point on the tuned (94.5%) and the
held-out (93.1%) places, and with Luna from 91.6% to 92.8%. On the six-colour plan alone it gives 1.4 points (90.0%
to 91.4%), 1.5 on the held-out places. On today's reader it changes nothing (88.3% against 88.5%), since today's
prompts hardly draw outlines.

Two variants, without Luna on D01_six3_plusWays:

- **The size limit.** 10, 20 and 40 m² score the same (93.8%, 93.8% and 93.7%). At 80 m² and 160 m² the score falls
  back to 93.2%, because the filler starts closing small rooms and alcoves. 40 m² is kept, since it also covers a
  parked lorry of about 30 m².
- **Leaving the patch to the other plans.** Instead of black, the patch can be made no answer (transparent), so the
  other plans decide it. It ties with black (93.6%, and 91.4% for six3 alone), because nearly every small closed
  outline really is a solid thing.

**With Luna, filling does not help the recommended reader.** today_quiet with its plans filled gets 95.1% against
95.9% (-0.8, interval -1.9 to +0.3), and a_sure_today_cutP_quiet filled gets 92.2% against 96.1%. Filling makes the
six-colour plan paint more cells solid, outlined rugs and traffic islands among them, so quieting stops Luna opening
them. Filling only helps readers that let a palette plan vote, and those lose to today_quiet with Luna. It is not
recommended.

## Final evaluation

At the author's request, every idea was weighed again on its own evidence, without favouring what the build does today.
The build always runs Luna, so the ideas are judged by their scores with her. A gain counts only if it holds when the
places are drawn again with replacement (`paired.ts`, 4000 draws, 90% interval), holds on the held-out places, and is
worth the parts it adds.

The author then marked four more places that no reader had been shaped on: Rimefen (thim_w0_1), the Drowned Abbey of Orra
(warm_d0_1), the Cathedral of Saint Orra (warm_t1_0) and the Third-Floor Print and Records Maze (bell_d0_1), 517 points
in all. Their six-colour and rewritten walk plans were painted (16 Qwen pictures, about 7 minutes of GPU) and the eleven
final readers were scored with Luna on all 24 places (`score_luna_final24.json`). The table below is that run.

Two readers were scored again under new names earlier, so Luna answered afresh: today and today_quiet gave exactly the
same scores. Luna's answers repeat, so the differences below come from the readers, not from her. The 24-place run
also gave exactly the earlier scores on the first 20 places for every reader but two: today_six3_quiet and
today_quiet_plusWays. Those two were the last of the previous round, which ran over its estimate, and the spend cap
stopped some of Luna's looks for them; their earlier scores (94.1% and 92.1%) were too low. Both are complete now.

| Reader, with Luna | All 24 | Held out (15) | 4 new places | Gain over today | 90% interval | Gain over today_quiet |
|---|---|---|---|---|---|---|
| a_sure_today_cutP_quiet | 96.0% | 95.7 | 95.6 | +2.6 | +0.5 to +5.1 | +0.3 (-0.4 to +1.0) |
| **today_quiet** | **95.7%** | **95.4** | **94.6** | **+2.3** | **+0.6 to +4.6** | |
| today_quiet_plusWays | 95.4% | 95.2 | 95.4 | +2.0 | +0.1 to +4.4 | -0.3 (-0.8 to +0.2) |
| today_six3_quiet (six3 also votes) | 95.2% | 94.7 | 95.0 | +1.8 | -0.3 to +4.3 | -0.6 (-1.2 to +0.1) |
| today_quiet_fill | 94.9% | 94.9 | 93.8 | +1.5 | -0.1 to +3.3 | -0.8 (-1.8 to +0.1) |
| a_sure_today_cutP | 94.4% | 93.9 | 90.1 | +1.0 | -0.4 to +2.6 | -1.3 |
| today | 93.4% | 93.7 | 89.4 | | | -2.3 (-4.6 to -0.6) |
| todayD_quiet (rewritten walk prompts) | 93.3% | 93.6 | 93.8 | -0.1 | -2.0 to +1.9 | -2.5 |
| today_six3_plusWays | 92.1% | 91.9 | 87.2 | -1.3 | -2.2 to -0.5 | -3.6 |
| todayD (rewritten walk prompts) | 91.4% | 92.6 | 91.5 | -2.0 | -3.7 to -0.1 | -4.3 |
| D01_six3_plusWays | 91.3% | 91.5 | 89.6 | -2.1 | -4.7 to +1.1 | -4.4 |

On the four new places alone, today's reader gets 89.4% and today_quiet 94.6%. Rimefen carries most of it (73% to
90%): its frozen ground is where today's plans and Luna open too much.

Each idea, judged on these scores:

- **The six-colour plan.** It has merit, but only as a guard on Luna (quiet). As a voter it adds nothing over quieting
  alone (today_six3_quiet, -0.6), because its mistakes (lava as ways, outlined trucks, rugs in their own colour) then
  count.
- **Quieting.** The one change that clearly helps: +2.3 over today, the interval well above zero, 11 places better and
  6 worse, better on the held-out places and on the four new ones.
- **Opening the ways (plusWays).** Without quieting it hurts with Luna (today_six3_plusWays, -1.3). With quieting it
  ties (-0.3, interval -0.8 to +0.2): it is slightly better on the new places and slightly worse on the old. A tie does
  not earn a rule.
- **The rewritten walk prompts (without "dark means blocked").** They help only without Luna. With her they lose 2.0
  points alone and 2.5 quieted: they send her more doubtful patches, and she opens some that are solid.
- **The a_sure masks (things masks as sure ground, plants cut).** +0.3 over today_quiet, inside the noise (-0.4 to
  +1.0), for three more Qwen pictures per place. Not worth it.
- **Filling outlines.** It helps palette plans that vote, without Luna. With Luna and quieting it costs 0.8 points.
- **Four or eight colours, less colour in the map, other seeds, retries, colour phrases.** All were rejected before
  Luna (see "Further tests"), and none of them touches what quieting uses except the six-colour plan itself.

**The best combination is today_quiet:** today's three walk plans, plus the six-colour plan, which only stops Luna
opening cells it paints solid. It is also among the simplest: one more picture and one rule. The four new places made
the choice surer: its gain over today grew from +1.8 (+0.1 to +4.5) on 20 places to +2.3 (+0.6 to +4.6) on 24.

## Spend

- **OpenAI.** $0.031 for painting the 8 new places, $2.60 for the Luna scores (four runs of the 20 places), and $0.60
  for the 24-place run (Luna on the four new places, and the looks the cap had stopped). The studies' ledger
  `<study data>/seeds/spend.json` went from $1.53 to $4.73.
- **GPU.** About 450 Qwen pictures for the prompts in this report, at about 27 seconds each (1.4 MP) or 45 seconds
  (2.4 MP), plus the narrow masks of earlier days. All are cached in `<study data>/prompts/qwen`.

## What would come next

1. **today_quiet is in the build** (30 October 2026): `mapread.ts` `KIND_PLAN`, `kindPixel` and `quiet`, called in
   `zones.ts` `readPlace` (reader version r3, so built places are read again; their first four plans are reused). Its
   colour reading was checked against the study's on every cell of the 24 places: no cell differs. The kind plan is
   painted at the place's own seed rather than the study's seed 1, which the seed tests show is noise.
2. **The remaining misses.** The Cinder Works (81%) and Lantern Shoals (warm_w0_1, 88%) are the worst places with
   Luna, then Rimefen (90%). The Cinder
   Works' lava channels read as ways in every plan, and its machinery is drawn as line art at every seed.

## Where things are

- **Experiment code:** `packages/server/src/cli/_exp/prompts/`.
  - `lib.ts`: the prompts and the palette reading.
  - `score.ts`: the readers.
  - `split.ts`: the tuned and held-out summary.
  - `make.ts`: makes the pictures.
  - `side.ts` and `sheet.ts`: the pictures for judging by eye.
  - `paint.ts`: paints the new places.
  - `labeller.ts`: the marking page.
  - `phrase.ts`: the colour-phrase pictures; `seedchecks.ts`: the per-seed measures.
  - `paired.ts`: a reader's gain over another, with its interval over redrawn places.
- **Data:** `<study data>/prompts`.
  - `qwen/`: the plan pictures.
  - `labels.json`: the marks.
  - `score_*.json`: the scores.
  - `side/` and `full/`: the pictures.
