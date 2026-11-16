# Places

How a place is made: every place is one big top-down 2D map, painted by an image model and read back to find where people can
walk. The painter designs the geometry; the game controls the view, the place's edge, and its ways out,
and reads the map closely. This records the pipeline and why each choice won. The code: `worldgen/mapdraw.ts`
(planning and painting), `mapread.ts` (reading), `mapfix.ts` (making the reading usable), `mapgrid.ts` (the plan's grid),
`placement.ts` (where everything goes), `zones.ts` (a place from design to game data), `comfy.ts` (ComfyUI calls).
How it fits the game is in `world-art.md`.

It replaced painted isometric places (an illustration outpainted chunk by chunk, read back with SAM 3 and MoGe 2),
whose layouts could not be controlled and whose reading of 2.5D paintings was the weak point. Plans written by an
LLM (grid atlases, vectors, command languages, graphs) were tried before that and judged poor: the painter designs
far better levels.

## Pipeline

Studied in two rounds in October 2026, then moved to FLUX 3 Image Klein after a trial
(`docs/experiments/flux3-klein/README.md`).
`mapdraw.ts` paints the map; `zones.ts` plans it, reads it, and turns it into game data.

1. **Plan (Luna, `planMap`).** Luna is told the whole method and the goal (a fun level with distinct areas, a strong
   theme and one connected network). She writes the whole-map layout with one dominant area much larger than the
   rest (for a dungeon, the great chamber), the ground with every surface described in the world's art style's own
   terms (a style holds best that way; a style sentence alone is weak), the style, the floor, the barrier (its look
   and its surface material alone) and what a way out through the barrier looks like. The arrangement suits the
   place (organic for caves and ruins, rows for a barracks), never uniform repetition. The painter takes words
   literally: things are described by how they look, never by their names (Klein writes names on the map as
   labels); no heights, facades, or views (they tilt the view); a way out is never a tunnel mouth, gate, or dark
   opening (drawn as a black shape that reads as a pit).
2. **Painting, closed (`choosePainting`).** Klein paints the whole place at its full size in one pass (40–150 s;
   330 s for the largest, 4096²), closed all round by a narrow belt of its barrier: the belt is asked for as four
   layout boxes along the edges. Klein frames every place anyway, and asked for the barrier it frames it with that
   (11 of 15 closed paintings had no stray opening). Painting at full size gives far more fine detail than painting
   small and enlarging, and its passages are no narrower. Every painting prompt opens with the same lead-in for
   every kind of place (`LEAD`): seen from straight above with all walkable ground in view, naming no things
   (naming roofs and treetops painted a forest round a space station), and an orthographic overhead view "like a
   satellite image"; the style is introduced as "Flat top-down map, " then the plan's own. Taking side-view words
   out of a plan did not stop towns of pitched roofs coming out in a three-quarter view; those added words did.
   Each painting is read by the walk reader (`readOpen` in `zones.ts`, steps 1–4 of the reading below, the same
   reading the finished map gets) and Luna checks the view. It is **sound** when at least 40% of the whole map is
   walkable, less than 4% of that walkable ground is cut off from the main region (regions under 4 m² are specks),
   and it is not too steep. The walkable minimum came from Glasswake in the Klein build: a painting read as only 28%
   walkable (its dark open ground misread) passed because the little ground left was joined; every other painting of
   that build and the baseline's places were 39–70% walkable. One painting at a time, until one is sound; after two
   that are not, Luna rewrites the layout and ground, shown both paintings with the ground read as walkable tinted
   green and what was cut off in red, and told which checks each failed (too little walkable ground asks for open
   ground that plainly reads as floor, distinct from obstacles; cut-off ground asks for wide joining routes). Four
   paintings at most; the one failing fewest checks is kept, the least cut off among equals. Sol's "is it connected?" was dropped: it
   disagreed with the reader in both directions, and one Qwen reading alone is as noisy as a reading at half size.
3. **Exits (`exitSpots`, `openExits`).** Each planned way out goes, within 20% of the side from its planned spot,
   where the reading's main region comes closest to the edge (within 0.5 m of the way's middle). Luna, shown the
   1024 px window there, says what the open ground just inside the barrier looks like and how the barrier's cut ends
   should look, and Klein's box edit carries that ground on through a gap in the barrier, in a box 4 m wide from
   the edge to 1.5 m past where the open ground starts, pasted back whole (48 px soft edge). Klein draws what a box
   asks for as an object filling it, so a way out can come back as a capsule with a rim across its inner end: on
   Latchkey three wordings of the plan's exit look did so on all six tries, and Luna's description of the ground
   there blended best. A box running deeper and pasted back only through the barrier hid the rim but looked less
   real than Klein's own drawing (the user's call). Nothing checks the cut: the walk fixer opens every way out in
   the walk area whatever the painting shows, and Sol's "is it open?" disagreed with what a person sees.
4. **Unplanned ways off (`strayOpenings`, `closeStrays`).** Wherever else the reading's main region comes within
   1 m of the edge, the barrier's texture (Klein, checked by Luna to be one even surface matching the plan's
   barrier surface) is laid in the band across the opening, and Klein's box edit makes the barrier whole there with
   the ground ending before it. Texture first: painting alone left most openings half closed. An opening longer than
   one edit window (about 22 m) is closed stretch by stretch.
5. **Read** (`readPlace`): the finished map is read again in full: where people can walk, made usable without
   repainting, with building entrances, named landmarks, and a spot just inside each way out's gap (below).
6. **Settle** (`settlePlace`): each way out across the edge stands at the gap cut for it on its own side (the side
   toward where it leads on the world map, `edgeExits`); Luna places everything else on the numbered spots, the ways
   drawn inside the map among them; the map is brought to game scale; the
   navigation grid, people, things, and monster packs are laid out (see `world-art.md`).

Every step is saved under `data/worlds/<id>/draft/places/<zone>/` (the plan and its rewrite, each painting with its
view check and reading, the exit spots, each way out's cut as it is made, the map after its exits, and the finished
map), so a resumed build continues where it stopped.

## Settings and why

| Setting | Value | Why |
| --- | --- | --- |
| Map size | chosen per place by the world plan within the world's tile budget (26, 44, 70 and 106 tiles from tiny to large: every place at its kind's usual size, with room to spare for the ones that should be big; `placeTiles` in `pipeline/world.ts`, each held to its kind's range by `fitTiles`): town 2×2 to 3×3 tiles, wilds 2×2 to 4×4, dungeon 2×1 to 4×3 (1024 px each) | Bigger places than one painting allows; the plan gives the space to the places the story lingers in |
| Scale | 40 painted px per meter (`PAINT_PXM`) | Five sizes of a character in the narrowest passages: the size that walks through comfortably was 32 px/m, the one that looks normal 45, on all four test places. 40 leaves characters a little short but never squeezing through (the user's choice); the game draws 46.9, so maps are shown about 1.2× |
| Painter | Klein, int8 distilled, 16 steps, at full size | 2.8× faster than Krea 2 Turbo at the same size; full size is crisp where Krea, SeedVR2, and a detail pass were soft; 8 steps were visibly softer |
| Choosing | one painting at a time, judged by the walk reader | Klein's paintings vary (Krea's eight were one layout repeated); the reader is the judge that matters, and one at a time spends GPU only until one is sound |
| Edge | painted closed, exits cut after | Asked for exits, Klein closed the band in 13 of 30; asked closed, 11 of 15, with the inside unchanged |
| Exits | the reading's nearest open ground, Luna's look of it, Klein's box edit pasted whole | The reading knows where open ground reaches the edge; the box edit opened Latchkey's wall where a masked repaint did not; the walk area opens the exit whatever it looks like |
| Closing | barrier texture first, then the box edit | On rock it closes cleanly; on a built wall no method was reliable (below) |
| Checks | the reader for soundness and strays; Luna for the view; no Sol | Sol's "connected" disagreed with the reader both ways, and its "is this exit open?" with what a person sees; the view rule needs both "large fronts" and "ground hidden" (either alone misjudged good maps) |

## Reading the map

Studied in October 2026 in two rounds: first on five maps against 400 hand-labeled points, then on 21 places of three worlds (a fantasy village, a drowned town, and a modern office
building) against 810 points, and last on 24 places of four worlds against 3,574
points marked by eye (`experiments/walk-prompts/README.md`). `mapread.ts`:

1. **Qwen's plans of the whole map.** Qwen-Image 2.1's edit mode redraws the whole map, resized to about 1.4 or
   2.4 MP, as flat plans: white where a person can walk, black for solid things (filled, not outlined), blue for
   water, pits, and the outside. Three prompts (`WALK_READINGS`): the three-color plan at 2.4 MP, a game-mask
   wording, and the user's "fill objects with black" idea with blue added. A fourth plan also paints buildings red
   (`BUILDING_PLAN`), and a fifth names what each thing is in six colors (`KIND_PLAN`: white floor, magenta ways,
   green plants, red buildings, black objects, blue water), read by the nearest color. Tile by tile at full size was worse (a tile has no context: rows of roofs read as floor). The
   pictures are kept in the draft (`planN_<seed>.png`).
2. **Shares, and no answer where Qwen gave none.** Each plan is read per quarter-meter cell as the share of its
   answered pixels that are walkable or water. Qwen sometimes answers in its picture's transparency: the two
   "mask" prompts often leave parts transparent over junk colors. On Thimblebrook both left all the ground
   transparent and painted only the houses, and the old reader took that as "nothing is walkable". A transparent or
   off-palette pixel is no answer, so the plans that answered decide there.
3. **Edges from the painting.** Qwen reads the map at about a third of its size, so its edges are soft and shifted a
   little; the walkable share is filtered with the painting as a guide (a guided filter, `mapedge.ts`), so the walk
   area follows the painted curb or wall face instead of stepping along cells.
4. **Quiet.** Where the kind plan paints a cell solid (a plant, a building, or an object), the walk plans' evidence
   that it might be ground or water is cleared, so Luna is not asked to open it, and no seam or crossing opens
   through it. The kind plan is not voted: its own mistakes (lava painted as a way, a rug in its own color) would
   then count. With Luna, this took the user's marked points from 93.4% to 95.7% right on 24 places, and from 89.4%
   to 94.6% on the four marked last; it mostly stops Luna opening rooftops, tables, and tree crowns.
5. **Luna on the areas in doubt** (`judgeDoubts`), one look per area, the biggest first, at most `DOUBT_LOOKS` (60):
   blocked areas a plan painted blue (Qwen paints a dark asphalt road, a dark corridor, or a rug blue as often as
   flooded floor, wadeable pools, or a canal) and blocked areas a plan painted walkable (an office one plan saw as
   floor while the others filled the room as a building). The area keeps the shape the plan drew, so its desks stay
   blocked; Luna only says whether it is ground, with the place's description in the prompt. Each area is split by
   width first: parts under 1.25 m across, and any line some plan drew solid (a wall, a railing, a curb), are asked
   separately whether a person can step across them, so the walls between rooms never open with the rooms (they did
   when a whole office block was one area). Water one plan drew as ground waits for Luna rather than opening on a tie
   (a garden pond one plan drew as lawn), and water meant for wading (a ford, pools between paths, stepping stones)
   opens while a pond or basin kept as a feature does not.
6. **Seams.** A blocked line one cell wide between open ground, which some plan saw as ground or water, is a painted
   line, a curb, or a gutter, and opens; the character's clearance would otherwise turn it into a barrier.

Buildings (the building plan's red) block sight. Entrances and landmarks are found apart (below).

Reading a painting for walkable ground is partly a matter of taste (a curb, a mossy mound, a shallow pool), so each
labeled point is walkable, blocked, or either, and only clear mistakes count. At the 810 points after the fixes
below: 94% right (the first reader 90%), 94% of the clearly walkable points reachable (81%), 94% of the reachable
points not clearly blocked (98%). About 3 GPU minutes per map (five Qwen plans) and up to 75 Luna looks,
about 1.5 cents.

**GPT Image (the default) or Qwen.** With the `image.read` purpose configured (an `openai-image` provider), GPT
Image reads the maps; left out, Qwen does, as above:

- **The plans.** Each painting gets two six-color kind plans (the finished map reuses its painting's), from GPT Image 2.5 Sunburst and 2.6
  Sunburst (`gptPlans`; the purpose's `models` can name others). Both are at low quality and 1.4 MP.
- **Lined up first.** GPT Image keeps a map's layout but not its exact place: its plans come back shifted and
  stretched (2.5 Sunburst by 0.4 m on average and up to 1.2 m, 2.6 by about 0.1 m). Two plans that far apart vote
  every thin wall away, which read walkable ground through an office's walls and partitions. So each plan is moved
  back onto the painting first (`mapalign.ts`): the shift of its edges against the painting's is found tile by tile,
  and one affine map fitted to those shifts. The door plan is lined up the same way.
- **How they are read.** The two plans are voted as the walk plans are (`combine`), then go through the guided
  filter and mapfix with Luna's crossing looks. Seams are not opened: GPT draws no curbs or painted lines as solid,
  and the rule only reopened walls one plan missed.
- **What changes from Qwen.** Their red is the buildings. Luna is not asked about doubts: GPT's plans are clean
  enough that her looks, which can only open cells, opened more water, lava, and solid than they fixed.
- **Accuracy.** On the user's 3,574 marked points it gets 96.3% right, against 95.7% for Qwen's plans with Luna.
  Voted as drawn, with seams opened, its plans read 95.7% as well; lining them up and leaving out the seams added the
  rest (+0.56 points over the study's six plan pairs; `experiments/plan-align`), most of it along thin walls.
- **What it costs.** About $0.06 and 40 seconds per painting read, and no GPU.
- **Doors.** GPT Image 2.6 Sunburst also draws a town's door plan (below), for about $0.031 a town, so a build with
  `image.read` never loads Qwen.
- **Why this pair.** Unaligned, two models voted about a point better than two answers from one model; lined up,
  two 2.5 Sunburst answers ($0.038 a painting) read as well on average (96.25% against 96.20%), but lost 4 points on
  a mine where 2.6 is the one to read lava as a hazard, so the pair stays. A third plan, a higher quality and a larger
  map added nothing.

**Batch or direct.** Its plans go through the Batch API at half price unless the purpose says `"batch": false`, as
the example configuration does: each painting's judging waits for its reading, and Sunburst's batches took from 1
minute to almost 2 hours (typically half an hour), which would add about an hour to a world's places for $0.3 to $0.7
saved. A pair of the faster Flare models reads 1.7 points worse (94.1%; `experiments/gpt-read`), so it is not used.
Batches are noted in the place's draft (`<painting>_batches`), so a resumed build reads their answers, and each plan
is saved as it arrives, so one model's answer is never paid for twice because the other's was late or failed. A batch
that fails or expires is asked again as a batch (three in all, then the reading fails as a step and is tried again
later), never directly at the full price.

The study is in `experiments/gpt-read/README.md`. Reading steps carry the reader (`g2` for GPT, `r4` for Qwen), so
switching readers reads a built place again.

Tried and dropped: Luna judging every split cell at points every 2 m (the first reader: it leaned to "blocked" on
half-ground patches and its nearest-sample rule cut straight-edged chunks out of yards, the blockiness at map edges);
the same at points every 1.5 m with color-aware assignment (no more accurate, thousands of looks); a fourth plan in
words Luna writes for each place (asphalt road, terrazzo floor: more reach, less precision, no gain in accuracy); a
generic prompt by function with no color words (worse on its own); showing Qwen the map without its barrier band
(no gain); voting the six-color plan, opening its ways as sure ground, rewritten walk prompts without "dark means
blocked", filling small closed outlines, four or eight colors, a desaturated map, and choosing seeds (each helps less
than quieting, or only without Luna; `experiments/walk-prompts/README.md`); lifting the painting's shadows before Qwen (tried on the office: its dark corridor still read as water). SAM 3 with Luna's names was
weaker (names drift; a dungeon read almost wholly wrong), and Sol on crops was no better than Luna at forty times the
price.

## Entrances and landmarks

The spots things are placed on (`mapspots.ts`). Studied in October 2026 against hand labels on five towns (about 150
buildings with their doors, a joined row labeled per unit), among them two painted for the test: a mushroom village
and a canyon of tents, yurts, and cave dwellings.

1. **Luna finds the entrances** (`findEntrances`, low reasoning) on full-size crops of 24 m with a lettered grid of
   2 m cells, beside the whole map with the crop boxed. She lists every building whose entrance is in the crop (a
   house, shop, stall, tent, hut, cave dwelling...), once per door in a joined row, with the cell of the ground in
   front of it and a few words on the building (its size and look, which placement uses to choose an inn or a
   stall). Overlapping crops each keep only the spots nearest their own middle.
2. **A door plan** marks every door with a yellow square (`doorMarks` reads them). Each of Luna's spots moves to the
   nearest unclaimed mark within 3 m; marks she missed are kept as "a building" where the plan painted a building
   beside them.
   - **With `image.read`,** GPT Image 2.6 Sunburst draws the plan, asked for one square per painted door
     (`GPT_DOOR_PLAN`, saved in the draft as `<reading>_doors`). It marks doors on every side of a building.
   - **Without it,** Qwen draws the plan (`DOOR_PLAN`). Its marks are right at the door, but almost always on a
     building's lower side.
   - **Measured against Qwen.** On the five labeled towns, end to end, GPT's plan gave 61-62% of the buildings a
     spot at the door against Qwen's 53-55%, and found 97-99% of them against 91%
     (`experiments/gpt-doors/README.md`).
3. **One per building.** Every spot moves onto the walkable ground (within 3 m); spots closer than 4.5 m are shown
   to Luna as a pair: one building or two, and if one, which stands nearer its door (the other goes).

| Town | Earlier reader: found / at the door | Now |
| --- | --- | --- |
| Gingerbread | 61% / 52% | 91% / 73% |
| Cliff-top city (dense, few painted doors) | 69% / 41% | 72% / 41% |
| Brinewake | 80% / 57% | 97% / 77% |
| Mushroom village | 50% / 41% | 91% / 86% |
| Canyon of tents and caves | 35% / 35% | 61% / 30% |

The earlier reader put one entrance at the middle of each red patch's lower side in the building plan, so a joined
block was one building and a mushroom or tent the plan did not paint red had none. On the canyon, Luna finds nearly
every tent and cave, but her spot is often on a canopy and the nearest walkable ground can be behind it. Sol finding
the entrances was better only on the dense city, at about seventeen times the price; Luna with no reasoning found
fewer; SAM 3 asked for "door" found under half. Placement, given the descriptions, put every designed building of
the two unusual towns at a fitting entrance (the smith at the forge cave, the healer at the yurt). Per place: two to
three cents of Luna and Sol, and for a town's door plan either about $0.031 of GPT Image or about 30 s of GPU (Qwen).

**Landmarks** (`nameLandmarks`): Sol looks once at the whole map with a grid of 4 m cells and names up to 12 (a
monument, a plaza, a bridge, a pond, a striking rock) and every way in or down drawn inside the map (a cave mouth,
stairs down), each at its cell; people stand on the walkable ground nearest it. Luna named them as well but placed
them worse (on the city 3 of 8 in the right place against Sol's 6 of 7). Placement sees them by name ("way in: the
cave mouth"), so a quest objective or a way down goes to the landmark that fits.

**Monster packs and the bosses.** Placement also chooses each boss's lair among the landmarks and open spots; a boss
it left without one waits in open ground as deep in as it can, a pack's spacing from the other bosses while there is
room. Each boss and its followers are a group of their own (`<place>_<boss>`), since an adventure keeps who has been
defeated by these ids: two bosses of one place once shared them, and defeating one hid the other for good. Packs
gather only in open ground: a pack's center keeps 2 m from anything blocked (`PACK_CLEARANCE`), best clearance first
with some chance, so packs stand in rooms, clearings, and squares rather than passages (on the dungeon, 7 of 12 packs
of the earlier random rule stood in passages; none now).

**Quest foes in play.** A boss or named foe that a quest sends the heroes to defeat stays away, with its followers,
until one of those quests has begun, as a quest's find does (`foeAbroad` in `game/adventure.ts`). A foe defeated
anyway (a quest taken up again, two quests after one foe) is kept in the adventure's `defeated` list and counts as
soon as a quest comes to it, so no quest can be made impossible by fighting early. A named foe always stands with its
pack, whatever the party's size (`fitPack`).

**Arriving.** A party coming in through a way out or a door stands on the nearest open ground by walking
(`Nav.arrival`): past the narrow painted path of an edge exit, not in it, where a fight would line it up single file.
Packs keep their centers 11 m from every way in and from where a party arrives through it (`PACK_FROM_DOOR`: aggro
reaches 6.5 m and a pack is about 3 m across), so nobody walks into a fight on arrival.

## Making it usable

`mapfix.ts`, without repainting (the character may clip a little through things that look solid):

- specks cleaned (blocked under 0.5 m² inside open ground opens, open under 1 m² closes);
- the barrier band blocked except the gaps at the ways out;
- the character's center keeps one cell (0.25 m) from blocked ground (`CLEARANCE`): thin walls stay, passages a
  reader drew a little narrow open (0.5 m kept 97% precision but lost reach; none let people onto roof edges);
- every other cut-off region of 4 m² or more joins the main one along the cheapest route, carved 0.45 m either side.
  Cells some plan saw as ground cost less, so the route finds the bridge, stairs, or doorway one plan drew. The
  cheapest region joins first and the rest are measured again, so an island beyond an island joins once its
  neighbor has (the first reader tried each once, in no order, and lost Lantern Shoals' islands). A route may break
  through 3 m of ground no plan saw, and up to 10 m where some plan saw ground; one breaking through more than 0.5 m
  is shown to Luna as a dashed line ("a bridge, stairs, a ramp, an open or closed door, a doorway... along the
  line?", at most `CROSS_LOOKS`, 15). A refused crossing is closed and the region looks for another way, three times
  at most (the cheapest way across a brook is often its rocks, not its bridge). Every way out joins however far and
  whatever the painting shows: its gap is not one of these regions, so no look is spent on it and no refused crossing
  stands in its way.

The first reader showed every cut-off region to Luna ("ground the player should reach?") and blocked the ones she
rejected; judging the area instead of the way to it threw away whole islands beyond bridges, so the crossing check
replaced it.

## Known weaknesses

- **Klein's towns and dungeons are cut up more often** than Krea's were (in the trial's space world, 8 of 40
  paintings sound against 23), so they need more paintings; the layout rewrite after two is the first answer.
- **Built barriers resist closing.** A station bulkhead or town wall cut by a stray street was not closed reliably
  by any method tried; rock, water, and hedges close cleanly.
- **Exits can recast what they cut through** (a wreck became a long vehicle once in the trial), and nothing checks
  the cut's look.
- **Some ground is hidden** behind large trees and tall roofs (the slight angle is welcome, but not that).
- **Wall faces.** Walls painted in a slight perspective show a side face about a meter wide; GPT's plans outline it
  and fill it as floor, so it opens (`experiments/plan-align`). A prompt asking for walls across their whole width
  did not change it.
- **Reading edges.** Most remaining reading mistakes are where all of Qwen's plans agree and are wrong: street edges
  lost to buildings drawn a little fat, thin dungeon walls, and small props blurred into floor.
- **Rooms all plans fill.** In the office maps some rooms are filled black by every plan (a room drawn as a block
  of furniture), so no plan offers them as ground and Luna is never asked. A plan asked only for rooms and floors,
  or Luna asked about every enclosed room the building plan outlines, could reach them (not tried).
