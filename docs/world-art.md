# Places and art

Every world is imagined from scratch, so nothing here names an environment. A place is one top-down 2D map, and
the game reads it back to learn where people can walk. Characters, creatures, a few objects, and item icons are
separate images drawn over the maps.

## A place, from words to ground

`worldgen/zones.ts` builds each place in two stages, so painting can start before the world is assembled:

1. **Make the map** (`paintAndRead`, needs only what the place is: name, description, buildings, ways out, and the
   sides they leave by). Luna plans the map; Klein paints the whole place at full size, closed by its barrier, one
   painting at a time until the walk reader finds one whose ground is joined; exits are cut through the barrier
   where its open ground comes closest to the edge, and unplanned ways out are closed. Where people can walk is read
   back by GPT Image (two plans of the map, lined up with the painting and voted; Qwen's plans on the GPU with Luna
   where they disagree, when the `image.read` purpose is left out), then made usable without repainting (narrow
   passages widened, cut-off areas joined). See `places.md` for the pipeline, the settings, and why.
2. **Settle** (`settlePlace`, after assembly). A way out across the edge stands at the gap cut for it; Luna places
   every building, way drawn inside the map, person, and thing on the numbered spots of the reading; the map is
   brought to game scale (a Lanczos resize, about 1.2×) and saved as `place_<zoneId>`; the walk and sight plans become the place's navigation grid; and monster
   packs (in open ground) and the boss (in the lair placement chose) are spread by walking distance from the
   way in. Town buildings are painted, never
   entered: each is someone's workplace (`zone.buildings`), and they stand outside its entrance; with crafting,
   the workbench, and with storage the store, stand in plain view by a main street or square, and with fast travel a
   waypoint stands in the town. A town's arrival, where a new party starts, is its heart (`heartOf`): the open ground
   with the shortest walk to all its people and things, clear of walls and a few meters from anyone; other places
   are arrived at by their waypoint or first way out.
   While Luna places things, the place's air is made (`atmosphere.ts`, below), and the light its map carries is
   measured from its pixels.

Every step is saved under `data/worlds/<id>/draft/places/<zoneId>/`, so a resumed build continues where it
stopped.

**The last check.** Once every place is furnished, the build checks that every quest can be finished
(`worldgen/questcheck.ts`: everyone, every place, creature, and item a quest needs exists, can be reached from the
start, and is there in time). Quests are made finishable where they are written, so a problem is a bug in the build.
One in the main story stops the build as a failed step that names it: the world is kept, not made ready. One in a
side quest is a warning. Both are kept on the world (`questProblems`) as well as in the build's log.

## Ground meters

Game positions are meters on the ground, x to the right and y down the map. The map is a top-down view of that
ground at one scale, `PX_PER_METER` (82/1.75, about 46.9 px): a meter runs that many pixels across and down, and a
person 1.75 m tall is drawn 82 px tall. Figures are drawn from a three-quarter camera over the flat map (below),
so what lies flat around their feet (contact shadows, the rings under them) is drawn flattened to match. The
navigation grid (`shared/world/nav.ts`) has half-meter cells: walkable (where a person's center may stand) and
see-through. Fog of war is remembered per square meter.

People are discs of 0.45 m (`shared/world/walking.ts`): two never stand closer than 0.9 m; walks go around
strangers and can squeeze past allies at a cost. Combat movement budgets are meters, and a move stops exactly
where the budget runs out. The client draws the reach as a ring (traced over the reachable cells) with a ring
per action point.

## Air and light

Every place has one mist of its own, used for both fog of war and the painting's edge, and its characters are lit
like the painting they stand in. The game never paints past the walkable ground; mist covers the rest.

- **Mist tile** (`worldgen/atmosphere.ts` and `worldgen/mistnoise.ts`, saved as `mist_<zoneId>`, `look.mist`). No
  image model: Luna says what drifts in the place (sea fog, ash haze, cave spores) from its description, art
  direction and colors, as a handful of numbers (bank size, swirl, flow, share of wisps, how thread-like, cover,
  contrast, motes) and two colors, thin and dense. The tile is made from noise that tiles by construction (every
  octave's lattice wraps at the tile's edge, and so does the warp that curls it), all of it stretched along the
  sideways drift the game gives the mist: broad soft banks, partly an octave finer so no wide holes show; wisps as
  long soft veins where a curled noise crosses zero, kept a steady width (the noise over its slope) so they never
  swell into blobs, with a fibrous grain along them made by smearing fine noise along the streamlines of a swirling
  flow (line integral convolution); and a halo. Its density is then spread evenly by rank, as a painted mist's is
  (the game reads brightness as density, so a mostly dark tile would show as bare fog), except that wispy air
  (smoke, dust, ash) keeps part of its own brightness, bright veins over a dim haze, since spreading it evenly would
  lift the haze into patches; cover sets the median. Its colors are half grayed, since the game tints the mist
  with the place's light as well. It is made at 512 px and enlarged to 1024 (the game draws mist at half the view's
  resolution), in about 3.5 seconds of CPU; then its large-scale brightness is divided out and stretched to the full
  range like any tile. Luna's design is the draft step. The comparison with the painted tiles it replaced is in
  `docs/experiments/procedural-mist/`.
- **Light** (`look.painted`): the mean color of the painting's brightest tenth (its light), of its darkest third
  (its shadows) and its mean brightness.
- **Mist in the game** (client `render/mist.ts`): WebGL at half resolution, drawn onto the view twice a frame,
  both times as two layers of the tile drifting at different speeds (the nearer one moves a little faster with
  the camera, for depth). The *ground pass*, right after the painting, fills everything past its edge, so there
  is never a border, and figures drawn after it stay crisp when they walk out to a way at the edge. The *air
  pass*, over the figures, covers unexplored ground (a dim veil over ground out of sight) and lays a veil inside
  the edge, solid over the last half meter (paintings often darken their outer rows), then reaching in an uneven
  two to five meters (the tile's large-scale density, held still), thickest over ground no one can walk (the
  painted barrier) and thin over the ways out, and clear around the party, so the painting sinks into the mist with
  no straight line. The mist's density erodes the coverage, so it breaks into wisps rather than a blur. Its
  thin parts take the place's fog color, its wisps the measured light; the view's light (night, gloom, the
  party's light) falls on both passes alike. Places without a tile get generated noise. Without WebGL the fog of
  war is a plain veil. The minimap fades the painting's edge.
- **Figures in the place's light** (client `render/light.ts`). Each figure (people, creatures, dropped spoils, the chest, sign
  and waypoint) is drawn once into a scratch canvas, and a copy is multiplied by a top-to-bottom gradient: the
  place's light hue at the head, the painting's own color around its feet at the feet (a tiny blurred copy of the
  painting, sampled under it), brighter or darker with that ground; then cut back to the figure's shape and washed
  faintly with the light from the upper left. Under it lies a soft contact shadow, flattened as the figures' camera
  sees the ground, sized from the body (0.45 m) in the place's own shadow color, stronger on brighter ground.
- **Camera:** the view always stays inside the painting; a place smaller than the screen sits centered with mist
  around it.

## The image pipeline (characters, objects, icons)

The art is painted by GPT Image 2.5 Flare by default, or by FLUX 3 Image Klein as the backup (the purposes on the
comfyui provider; `genai/images.ts`, `painterOf`). Both run in the same rounds: every pending asset is painted, cut
out and checked (the checks all at once), and the rejects are painted again. GPT Image paints a round in one Batch
API request, on its own transparent background (below). Klein paints one picture per GPU turn, and has no
transparency: each asset is painted on a plain chroma-key backdrop and keyed out of it (steps 3 to 5).

1. **Plan** (`art.ts`, `planAssets`): a hero for every class and kin (`spr_hero_<class>_<kin>`: the kin's look and
   gender in the class's outfit; each kin is one gender), people (the companions among them), creatures, bosses, the
   objects the game draws over the paintings (`obj_chest`, `obj_sign`, `obj_craft_station`, `obj_storage`,
   `obj_waypoint` when the world has them, and `obj_loot`, the spoils foes drop, when it has foes), and item icons.
   An object's brief is a few plain words (`OBJECTS` in `worldgen/art.ts`: "A bag of loot", "Something players open
   to find treasure"), and the prompt writer designs it from the world: the mining world's loot bag came out as a
   grimy industrial sack, the office comedy's as a clay sack with a stapler in it. Tried on three worlds: a brief that
   says only what a thing is for ("what a defeated enemy leaves behind") gave the checker nothing to match a picture
   against (scores of 4 to 5, so it would be painted again), "loot" alone was painted as one treasure (a stapler, a
   saucer of tea), and "a small pile of loot" scored low as hard to read at its size. Every actor is one
   base image in a neutral standing pose, the view its animation starts from: **front**
   for people and upright figures, **side** (in profile, facing left) for animals and other body plans. The
   plan records it in `asset.view` (people are planned as front; Luna picks a creature's view). Assets are
   repainted when missing, failed, or changed (or re-rolled by the owner).
2. **Prompts** (`genai/images.ts`): Luna writes one observer-style paragraph per asset (subjects stand alone: no
   scenery, fog, glows, or cast shadow, studio-lit) and, in the same answer, picks its **backdrop**: green
   (#00b140), blue (#0047bb) or magenta (#ff00ff), whichever hue the subject uses least along its outline,
   highlights and glows. See-through and glowing parts are keyed by their color too, so the same holds for them:
   a pale-blue ghost goes on green, not blue. The prompt ends with the backdrop sentence, color and hex included
   (`genai/cutout.ts`, `backdropSentence`).
3. **Paint** (`config/comfyui/klein_cutout.json`): one ComfyUI job paints with FLUX 3 Image Klein, 16 steps (people 832×1216, side
   views 1216×832, props and icons 1024×1024). No cutter model runs.
4. **Cut** (`genai/cutout.ts`), the classic chroma key over the whole frame, about a quarter of a second of CPU:
   the backdrop's color field B is estimated from the pixels joined to the image border. A color's key strength
   is how far the key's own channel exceeds the others (green: G − max(R, B); blue: B − max(R, G); magenta:
   min(R, B) − G), and a pixel's opacity is 1 − its strength ÷ the backdrop's. Smoke, steam, glass, a glow, and a
   spider's thread come out see-through, the middle of a ring and the gaps in a swarm open by themselves, and
   separate pieces are all kept. The backdrop's own shadows count as backdrop, and opacity under 6% (the backdrop's
   grain) is dropped. The backdrop is un-mixed from see-through pixels (`F = (C − (1−a)·B) / a`) and any color
   still lying along the backdrop's hue is removed from them, so glass and steam come out neutral rather than pink;
   opaque pixels keep their color (a red cork on magenta stays red).
5. **Score the cut** (no model): a backdrop too dull to key is rejected (its median key strength under 25; the
   muted keys a painter gives a desaturated style, around 45, cut cleanly), and so is a clash: a subject that
   carries the key's own hue, which the key reads as partly see-through and un-mixes into the key's opposite (a
   lavender ghost on magenta comes out teal). More than 2% of the cut's opacity in such pixels is a clash, and the
   next attempt uses another key color. Also: cut off by the frame, too small. See-through parts are not
   "missing": glass and smoke that let the background through are right. What the score cannot see is see-through
   glass tinted the key's own color (green glass on green comes out clear and gray); only the backdrop choice
   prevents it.
6. **Check the content**: the checker (Luna's decision model) sees the painting on its backdrop and judges the
   subject, match to the brief, framing, darkness, text, and the pose (front or side, neutral, whole body); for
   side views it says which way the creature faces, and one facing right is mirrored. It never judges the cut:
   in the bake-off it flagged clean cutouts as often as bad ones. A painting the checker did not answer for (its
   call failed) is unchecked, which is not a pass: it is never kept, and its asset is painted again in the next
   round like a reject. If the checker stays away, the art stops as a failed step, to be resumed once it works.
7. **Keep**: attempts repeat with new seeds up to `maxAttempts`; the best one is trimmed (actors kept up to 768 px
   on their long side, props 512, icons 256) and saved. Weak results are repaired with a rewritten prompt that
   names what went wrong; a repair replaces a picture only when it scores better. A repair pass under way is noted
   with the assets (`.repair.json`, its rewritten prompts with it), so a build stopped in the middle takes the same
   pass up again and reads the batch it had sent.

**GPT Image (the default).** With `image.sprite` and `image.icon` on an `openai-image` provider (model
`gpt-image-2.5-flare`: as good as Sunburst here, and its batches came back in 1.5 to 7.5 minutes where Sunburst's
took up to an hour), GPT Image paints the art (study in `experiments/gpt-art/README.md`). At its full kept size (768
px) its faces, buckles, and cables are as crisp as Klein's:

- **No chroma key.** It paints on a transparent background of its own (`background: transparent`), and its alpha is
  the cut. The key cannot take a subject's own colors for backdrop: a pale frog on green came out see-through from the
  key and whole from GPT's own transparency.
- **The prompt and the checker.** The prompt ends with "alone on a fully transparent background" instead of the
  backdrop sentence. The checker still sees the painting on the key color Luna picked, which it is calibrated on:
  shown on gray or white, it scored the same paintings 2 to 5 points lower.
- **Size and quality.** It paints the least it can at low quality: actors 672 × 976 (side views 976 × 672), objects
  and icons 816 × 816. Kept images are trimmed to 768, 512 or 256 px anyway, and larger or medium-quality paintings
  were no better at game size.
- **Batches.** Each round's paintings go through the Batch API at half price, one batch per purpose and step, off the
  GPU queue. A submitted batch is noted in the assets folder (`.gpt-batches.json`), so a stopped build picks up its
  answers. `batch: false` on the purpose calls directly instead.
- **Cost.** About $0.0024 an actor and $0.0032 an object or icon per attempt.

The cut was chosen in two studies. The 20 October bake-off (13 Krea subjects, 4 backdrop strategies, 8 cutters)
settled the chroma-key backdrops chosen by Luna: neutral gray or white backdrops make the key blind (silver,
highlights and beards look like backdrop), and Luna's look at a cutout agreed with the eye only 59% of the time.
It kept BiRefNet's mask for where the subject is, which made everything inside it solid: smoke, steam, and glass kept
the key's color, and a thread outside the mask was lost. The 28 October comparison on Klein paintings (14
subjects, `docs/experiments/flux3-klein/README.md`, "Cut-outs") found the whole-frame key better than BiRefNet and
than every matting model tried (BiRefNet dynamic-matting, BiRefNet-matting, BiRefNet_HR-matting, RMBG-2.0, Lucida).

In a build, image work runs on the build's GPU queue (`worldgen/gpu.ts`) with the places, on the same Klein model;
loading and unloading is the GPU broker's job. Animation is painted afterwards from the base view by GPT Image
(below); until then the game draws the base image.

## Characters in motion

Every character and creature is animated from its one painted standing view (front for people, side for animals)
by image models: GPT Image 2.5 Flare paints whole animation sheets (the same figure frame after frame, in poses its
words describe), and GPT Image 2.6 Sunburst paints the walks as looping GIFs (step 4). Nothing runs on the GPU. It
replaced a 3D route (a mesh made from the view, rigged, moved by clips, and rendered in eight directions): that took
hours of GPU per world, and a rig a little off deformed the figure. Studied in October 2026 and November 2026 (`docs/experiments/gpt-image-2.6`, which chose the GIF walks over
walk videos painted by Wan 2.2 on the GPU, used until then). Server code `src/anim/`, client `render/actors.ts`.

1. **Brief** (`anim/brief.ts`): Luna looks at the painting once and writes the words every sheet is painted from:
   the body (every part the painting shows that must appear in every frame and view, and what it lacks where that
   could be mistaken: "no legs; it floats"), how it gets about (walks, hops, crawls, slithers, swims, floats, flies,
   rolls, swarms) and the four key poses of each clip: move, attack, hit, death. The image model paints exactly the
   words: a stapler monster animated from hand-written words ("stalking on its crooked legs") grew legs its painting
   did not have, and one whose description never named its legs lost them in every view, five times running.
2. **Turnaround** (`anim/paint.ts`): a 3 × 2 sheet with the painting in the cell of its own view; the model paints
   the others, S, SW, W, NW, and N, standing, seen from slightly above like the game's camera. E, NE, and SE are their
   mirrors, so SW, W and NW must face the picture's left. Each is said as a three-quarter or side view with "its head
   and whole body pointing toward the left edge of the picture". Said as "facing up and to the left", 7 of 45
   turnarounds of the first animated world had their NW view (one its SW view) facing right, so those actors walked
   up-right when going up-left and back, and their walks, painted from those cells, did too. Other wordings tried on
   the worst 7 people and 5 odd bodies (a floating door, a swarm, a vine with one eye, a hedge block): "face and toes
   pointing" worked for people but names parts many bodies lack; "facing the corner of the picture with its whole
   body" turned 3 of 8 creatures the wrong way; "facing the left side of the picture" turned 6 of 7 people, who
   looked back over the other shoulder. "Head and whole body" had 11 of 12 right, and the twelfth was caught below.
   Creatures painted in profile often keep the profile in SW and NW: right facing, but no three-quarter view.
   When a turnaround comes back, the checker (Luna's decision model) says which side of the picture each of SW, W and
   NW is turned toward, and a view it is at least 80% sure faces right is mirrored in its cell before anything is
   painted from it (`anim/facing.ts`, a fraction of a cent an actor). It caught all 7 of the first world's wrong
   views and flagged none of the 45 once mended; it is unsure of near-straight back views, where a mirror barely
   shows. Its question names cues to judge by (face, chest, toes, the turn of the head) and judges by whichever a
   figure has; two plainer questions missed a clear case. Asked whether a figure's head and body face the same way,
   it answered too unevenly to act on.
3. **Clip sheets**: one per painted view, that view in its first cell and a row per clip, four frames each. SW, W
   and NW carry the move, attack, and hit, W the death too; S and N the move alone (each its own 2 × 2 sheet: a row
   of four is wider than the model paints, and two views on one sheet came out facing the same way). Townspeople,
   who never fight, have the move alone in every view. With walk GIFs (step 4), a sheet that would hold the move
   alone is not painted. Each sheet is told the view's facing in the turnaround's words, and where everything the
   character does goes, by the picture's edges and corners ("Everything it does goes toward the left edge of the
   picture: every step, and every blow, shot, throw, or spell."). Blows are painted only in the views that face the
   picture's left, which the game mirrors for the other side, and a blow toward the viewer or away plays the nearest
   of them (`paintedRow`). Until November 2026 the sheets said only the facing and "moving to the left" (or down, or
   up), and S, W and N carried the blows: the model likes to draw an action side-on toward the picture's right, so
   in the three animated worlds about a third of the W attacks turned right partway (a hunter fired her rifle to the
   right, kicks went right), most S attacks went sideways, and nearly every N attack went up and to the right. With
   the aim said, 4 test actors' W, SW and NW attacks went left but for two frames of one sheet; their S attacks went
   toward the viewer but a rifle still poked out sideways, and their N attacks still went right, however worded.
   When a SW, W or NW sheet comes back, the checker looks at every frame the game draws from it (not the move rows
   while the walks are GIFs), asking where the figure turns and where its blow, shot, or spell goes; a sheet with a
   frame it is at least 80% sure goes right is asked for again, and on its last attempt kept with those frames
   mirrored. Tried on 15 sheets, it flagged 3 of the 4 that had frames going right, and none of the others; it finds
   only some of a sheet's wrong frames (one of two, in two sheets), so it decides about the sheet, and a sheet is
   painted again rather than mended, which would also put the gear in the other hand partway through.
   The standing question of step 2 passed a body turned left with its rifle aimed right. `animate <world> <actors>
   --sheets` paints an animated actor's sheets again, keeping its turnaround and walks. Everything is painted on
   transparent canvases and answered on transparent backgrounds (`background: "transparent"`): keyed from a flat
   color instead, a glow painted on black kept a dark halo, a shadow painted on green left a green line, and on
   magenta the model tinted a glow pink.
   Low quality: it moved the most (medium and high barely moved); four frames, since eight were not smoother.
4. **Walk GIFs** (`anim/paint.ts`, `walkGif`, with the `image.walk` purpose): each of the five views' standing
   figure (the painting for its own view, the turnaround's cell for the rest) is placed on a transparent frame 256 px
   tall, and GPT Image 2.6 Sunburst answers with a looping GIF of eight frames walking it on the spot from the brief's
   words (`output_format: "gif"`, `frame_count: 8`). The model paints the eight frames on one sheet of its own and
   cuts it apart, so they hold together better than a sheet's four: an even cycle that keeps the painting's look,
   which GPT Image 2.5's walks did not always do (they sometimes stuttered or, for many-legged bodies, barely moved).
   A GIF costs the same for two frames as for eight, and more for larger frames, with nothing gained at game size.
   Moderation is set low for every GIF: under the default, a gunner's walk could be refused for violence. The GIFs
   go in a batch of their own (a batch holds one model) and replace GPT Image 2.5's walk in every view; GPT Image 2.5
   then paints only the SW, W and NW sheets of actors who fight (none for townspeople): their move rows stay, since the
   model draws each sheet at its own size and those rows are what measure it for the attack and hit beside them
   (step 5). A GIF with other than eight frames, or with a backdrop at its edges, is asked for again like a failed
   request. A GIF's alpha is on or off: outlines hold at game size, but a see-through body (a jellyfish) is drawn
   solid and a glow cannot fade out. Attack, hit, and death stay sheets: painted as GIFs, attacks lost their effects
   (muzzle flashes) and were tamer. Studied in November 2026: `docs/experiments/gpt-image-2.6`.
5. **Steadying and packing** (`anim/assemble.ts`): the model places and sizes each frame a little differently, so
   every frame is cut out (the faint haze the model leaves below alpha 24 cleared, and specks apart from the figure
   under 0.3% of it, which were taken for its feet) and placed: one scale for the whole actor, from the painting, so
   the standing figure is drawn as tall as the still sprite; each clip sheet sized to match, its move frames given
   the height of its view's standing figure (the model paints the frames up to 80% larger than the figure it was
   shown, differently each time). Height, not area: a side-view stride and a swinging arm cover a third more area
   than standing, and matching area drew the side walk 15% shorter than the idle. Each move frame is given its row's
   height (within 15%); an attack or hit row is sized so its last frame, the recovery, stands as tall as the move
   (within 10%), its other frames keeping their own heights, since a recoil or a crouch is lower. A death keeps its
   sheet's scale. The feet (lowest solid row) go on the ground point with the upper body's center over it (the
   median of its columns, which a weapon or an effect reaching out hardly moves), or for things that float, the
   figure's center half its standing height above it. The idle is one standing frame per view (the turnaround's),
   its breath drawn in code. A walk GIF's frames are steadied the same way: they come back from 6% smaller to 27%
   larger than the figure given, differently in each view, and some drift up and down within the loop. A walk lasts
   two thirds of a second whatever its frames (four at 6 a second, eight at 12). Each clip is packed (`anim/pack.ts`): a direction keeps only the box its frames touch;
   directions not painted are empty. In the game a blow, a spell, a flinch, or a fall cross-fades over 0.12 s
   (`client/render/actors.ts`), which hides what differences remain between clips. Standing, walking, and running cut
   from one to another, and a walk starts on its first frame: blended, every start and stop showed a stride over a
   standing figure, which looked blurred.

**Format** (`shared/world/anim.ts`): one WebP sheet per clip saved as asset `<key>@anim-<clip>` (idle, walk,
attack, hit, die), at `scale` (2) sheet pixels per picture pixel; each direction (S, SW, W, NW, N, NE, E, SE) a
strip of its frames, every frame the same box with transparent pixels around it; the sprite's own record carries
`anim`: cell, anchor, height, how it gets about, the image it was made from, and per clip its frames, frame rate,
loop, stride, event frame and `rows` (`sheetFrame` finds a frame). An actor that fights stores about 68 frames
(the walk's eight in 5 views; attack and hit in 3 and death in 1, four each); the 3D route's seven clips in eight
directions held about 140 MB.

**When**: everything is painted through OpenAI's **Batch API** (half price; answered within a day, usually within
minutes), never by direct calls. The world's `animate` job (`anim/job.ts`) never waits on the model: each run reads
the batches that came back and saves each answer in its actor's directory (`data/worlds/<id>/anim/<key>/`); writes
the briefs it needs; sends what is ready in batches, one for the sheets and one for the walk GIFs (the turnaround
and the painting's own view first, the other views once the turnaround is back); assembles every actor whose parts
are all in and saves it onto the world as it is on disk then; and, while anything is out, queues itself again to look in a minute and a half (a queued
animation job may carry a not-before time, `params.after`). A request that fails, a batch that ends without
answering (one that expired is still read for what it did answer, which is billed), or an answer whose picture cannot
be read is asked again, three attempts in all; so is an answer painted on a pale backdrop (light clouds round
every frame, despite the transparent canvas; one sheet in fifteen in the first test world), told by far more pale,
half-transparent pixels than the figure it was painted from had (a GIF, which has no half-transparent pixels, by a
solid edge); after that the actor keeps its still image (shown with the error
in the world viewer and on the admin GPU page, where an administrator can retry it). Which actors: in a world built with
animation (its owner turns "Character animations" on when creating it: `input.animate`), every actor
without current sheets, the heroes and companions first, then by place, bosses last; in any world, the actors asked
for by name (`cli/animate.ts`). A repainted actor starts again: its file keeps its name, so its animation's steps
and its sheets (`anim.from`) name the painting they were made from by a hash of its content, and what was painted
from an earlier one is thrown away.

**In the game** (`render/actors.ts`): the row is the screen direction the actor faces, drawn from the painted
direction, its mirror, or the nearest painted one round the compass (`paintedRow`); dead or downed actors fall and
stay down, and one getting up plays its fall backwards, a little quicker (an actor with no sheets yet tips over and
back up); damage plays the hit, a blow or arrow the attack, any other skill the cast (the attack, while no cast is
painted), over whatever else is going on; moving actors walk with their gait's frame rate set by their ground speed
over the clip's stride (no run is painted: the walk plays faster). Standing, the idle frame breathes in code
(`IDLE`): the lower body stays still and the part above 55% of the figure's height rises up to 1.2% and leans about
a pixel at the head, over 2.4 seconds; a floater bobs. Painted idles jittered, and scaling the whole figure read as
shrinking. Actors without sheets keep the still image with its procedural bob and lean. A player may turn a world's animations off,
and then every actor moves this way: the world's page offers the switch once any of them is animated, kept with the
player's settings (`animationsOff`).

The game holds only what it draws (`render/sheets.ts`): each sheet is fetched and decoded off the main thread into a
bitmap scaled to the pixels the screen shows at the current zoom, only for the clips an actor plays (its idle and
walk ahead of need, every clip once it is in a fight; the idle stands in while one decodes), and past a budget the
sheets drawn least recently are released. Drawn as plain images instead, the browser decodes them lazily and drops
them under memory pressure, then decodes them again inside every draw.

**Cost** at the Batch price, plus a fraction of a cent for the brief: an actor that fights about $0.07 (the
turnaround about $0.005, the SW, W and NW sheets $0.005 to $0.01 each, five walk GIFs about $0.009 each), a
townsperson about $0.05 (the turnaround and the walk GIFs); about $2.50 for a world of 25 actors that fight and 15
townspeople. Without walk GIFs, about $0.04 and $0.015 (the walk painted in the sheets).
**Configuration** (`config/genai.json`): an `openai-image` provider (model `gpt-image-2.5-flare`, quality `low`)
and the purpose `image.animation` on it; without that purpose actors keep their still images. The purpose
`image.walk` on the same provider with the model `gpt-image-2.6-sunburst` paints the walks as GIFs; without it
GPT Image 2.5 paints the walks in the sheets too.

## Seeing a world's art

The world viewer (administrators only, docs/server-architecture.md) shows every picture of a world by kind, with
its brief, its image prompt, its art check score, and tries, and an actor's animation playing in turn while it turns
through the eight directions, or that it waits for its paintings or failed and why. Repainting and animating again
are the console tools' work (below): `paintworld --only <keys>` paints what is missing, failed, or has a new brief, and
`animate <world> <key>` animates an actor again.

Qwen's edit (`qwenEdit` in `src/worldgen/comfy.ts`) can take extra reference pictures ("Picture 2", ...) besides
the one it edits. Nothing uses them yet; they are kept on purpose, from an experiment, for a step that needs Qwen to
match a second picture (a style, a character).

## Tools

- `src/cli/genlive.ts`: build a world end to end outside the web server (its animation is queued for the server's
  worker, unless built with `--still`).
- `src/cli/paintworld.ts`: paint (or repaint) a world's character and item art.
- `src/cli/resettle.ts`: make a world's places again from their saved steps and settle them, then check its quests
  and solve experience again from the creatures now placed.
- `src/cli/animate.ts`: animate a built world's characters and creatures by name (`--wait` to run the job's steps
  in the console until they are assembled, `--sheets` to paint their clip sheets again, `--list` for every actor's
  state, `--clear` to remove a world's animation).
- `src/cli/placetries.ts`: a sheet per place of every painting a build tried, with what the reader found cut off.
- `src/cli/placepeek.ts`: a settled place's map with its walkable ground and everything placed in it marked.
- `src/cli/npctalk.ts`: talk to a world's people with the configured model, without saving (for tuning prompts).
- `src/cli/strictcheck.ts`: send every model-facing schema to OpenAI in strict mode, so a schema it refuses fails at once.
- `src/cli/rules.ts`: write a world's rules anew, or rebalance them, as a job for the worker.
- `src/cli/users.ts`: accounts from the console (invite, reset, list).
- `src/cli/paintpeek.ts`: paint a few of a world's assets into a scratch folder (the world is not changed) and draw a contact sheet: each painting, its cutout on dark and on a loud color, and its scores.
