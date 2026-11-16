# The build pipeline and its editor

The world build's text calls are data: a set of steps in `pipeline/`, each one Responses API call, run by one runner (`packages/server/src/pipeline/`) that the editor, the CLI, and the build all use. The owner and Claude edit, run, and compare steps on the same files.

Status: every text call of the world build is a step, from the owner's style to the sounds: twenty steps (see "The build's steps" below), which the build runs (see "The build"). There are seven examples to run them on.

## Why

The build is a chain of model calls, and we redesign it one call at a time: splitting calls, adding and removing fields, comparing variants. When every call was hand-written TypeScript and experiments were scratch scripts that copied the prompts, three things went wrong:

- What was tested drifted from what the build ran.
- It was hard to see which later call or game record read a field, so fields nothing used survived.
- Every experiment rebuilt its inputs, caching, and comparison by hand.

## The model

- **Inputs** are what exists before any call:
  - `input`: the owner's theme, size, length, and prompts. Each prompt is `{ topic, about, text }`, where `about` reads "the story", "the creatures and foes" and so on. `systems` is what each optional system may be: the owner's choice, or every choice when they left it open. `mapTiles` is how many map tiles all places share, by the world's size (`SIZE_PROFILES.tiles`). `maxLevel` is the level cap of the world's length, and from it come the classes' shape: `points`, the points a hero has by the cap (2 at the start and 2 each level), and `tiers`, each with its `id`, `n`, the points spent in a class that open it (`opensAt`, the last at half of all the points) and how many active skills it holds (`actives`: two, and one in the last) how many passives (`passives`: three, each bought once) and how many effects each passive may combine (`passiveEffects`: one in the first tier, two deeper). The shape is `classShape` in `shared/rules/classes.ts`.
  - `map`: the **engine facts** (`facts.ts`), computed by code from the input. They hold the world's structure and the slots every later step fills, so answers are keyed by what the engine made and nothing is left out or doubled:
    - `map.places`, in the order they are reached, with `id`, `kind`, `label` ("a town"), `n`, `first`, `last`, `links` (the places a path leads to), `off` (for a dungeon, the place it opens from) and `sizes` (the sizes its map may have in tiles, each as "columns x rows", every one its kind of place allows: `TILE_RANGE` in `worldgen/mapdraw.ts`). A town also has its `cast`, its `residents` and its side-quest slots (`quests`); a wild place or dungeon has its `notes` slots;
    - `map.towns`, `map.wilds`, `map.dungeons`, and `map.areas` (the wilds and dungeons);
    - `map.arcs`, each with its `stretch` (the places it is told across), its `reach` (its stretch and every place before it) and its `cast`;
    - `map.cast`: the slots for the people of the story, three per town, each with its `town`;
    - `map.residents`: every town's other residents, each with its `town`, its `label` ("someone who sells weapons", "someone who lives here") and what it sells (`merchant`, or null for a resident). Every town gets a merchant for each kind of thing players buy (supplies, weapons, armor, and materials unless the owner turned every craft off), and as many residents as its size gives;
    - `map.families`: one slot per creature family, as many as the world's size gives.

    Facts refer to each other by object, so `off`, `links`, `stretch`, `reach` and a resident's `town` are places like any other. The references go both ways, so facts are written out with `plain`, where an item inside another item is its id.
  - `game`: what the engine fixes for every world: the sound `moments` the game plays (with each one's purpose), the `fx` vocabulary fights are drawn with, and under `rules` every other fixed list the rules choose from and the interface's look (`RULES_VOCABULARY` in `rules/vocabulary.ts`). They come from the code that uses them, so a step's enums and the records can never disagree: a step writes `enum: { from: 'game.rules.weaponStyles[*]' }`, never the list itself.
  - `constants` (`pipeline/constants.yaml`): the system message every step shares, and texts several steps read (the world's rule words and its classes as the rules steps list them, how to describe a voice, what makes a quest make sense, the craft of the world's sound).
- **A step is one Responses API call, and nothing more**: a system template, a user template, a schema, and its model settings. Its output is the structured data the schema describes.
- **Records** are the game's types (`records.ts`), each with the shape it accepts. `pipeline/records.yaml` names the output that fills each one, as a plain path (`places: placePlan.places`).
- **The order** (`pipeline/order.yaml`) is how the steps read, in the editor and the CLI: groups by subject (`Rules: [rulesSystems, rulesCore, …]`), each listing its steps. Every step is listed once, after every step it reads; a step listed before one it reads, listed twice, or left out is a problem. Running does not follow the list: each step starts once the steps it reads are done. Adding or copying a step in the editor lists it (a copy right after its original), and deleting one takes it off.
- **The world** (`world.ts`) is the records turned into the game's `WorldDefinition`, as a build makes it before painting (creatures and bosses stand on the open ground until painting places them). The rules records go to the rules compiler, checked against its own intent schemas on the way. The places become zones, the creatures families, the story's bosses bosses, and every townsperson a person with their inner life, secrets, and stashes. The quests' steps become objectives (a "bring" step becomes finding the item and handing it over), and the notes become lore, each with what it is (a carving on a post) for placing it. A boss, a named foe, and a thing to find are known by where in their quest they come (`b_<quest>_<n>`, `u_<quest>_<n>`), never by their names, so two of one name are two. Every reference in a record is exact, so nothing is matched by guesswork, as the old assembler had to. Until it is painted, a place is open ground with everyone near its middle, so a world can be played in, and talked in, before it is painted. Painting sets its ground, size, light, and where things stand, as for every world.

If a step needs something its templates and schemas cannot express, the rule is to add an engine fact, not to grow the format.

## Steps

One YAML file per step in `pipeline/steps/`, named by its id:

```yaml
purpose: world.design          # chooses the model and its settings, as every gateway call does
reasoning: medium              # optional: over the purpose's own
maxTokens: 8000                # optional
model: …                       # optional: another model of the purpose's provider
forEach: map.towns             # optional: one call per item, side by side; the output is keyed by item id
when: input.prompts[topic=story|places]   # optional: called only when this finds something; null otherwise
system: '{{> system}}'             # the system prompt every step has: a partial, filled in where it stands
user: |
  THE PLACES, in the order they are reached, from first to last:
  {{#map.places}}
  - {{placePlan.name}} ({{label}}{{#off}}, off {{placePlan.name}}{{/off}}): {{placePlan.description}}
  {{/map.places}}
schema:
  type: object
  properties:
    places:
      keys: { from: 'map.places[*].id' }
      each:
        type: object
        properties:
          name: { type: string, maxLength: 60 }
```

**Paths** (`path.ts`), in templates and schemas alike:

| Form | Meaning |
|---|---|
| `concept.title` | A field. |
| `map.places[*].id` | Every item of a list (or every value of an object), then a field of each. A null is no item, and an item without the field adds nothing, so `rulesCore.classes[*].damage.name` names every kind of damage the world's classes deal, though the healer class deals none. |
| `map.places[kind=wilderness\|dungeon]` | The items whose field has one of the values given. |
| `input.prompts[topic=art].length` | How many there are. A section on it shows only when there are some. |
| `$` | The item being described: the item of `forEach`, or the item a `keys` entry was read from. |
| `$first`, `$last`, `$n` | In a template, on an item of the list a section repeats over: whether it is first or last, and its number from 1. So `{{^$last}}, {{/$last}}` separates items. |

A path to a field that one answer lacks finds nothing, whether a `when` left the field out of this world (no magic) or the step has no such field at all (it was renamed or removed). So every field a path names in a step's answer is also looked up in that step's schema as written, with every `when` taken as holding, every member of a union tried, and `[*]` standing for any field: `rulesCore.classes[*].damage` is fine because some class has damage, and a path to a field that no world's answer can have is a problem (`"rulesCore.skills" is not a field of rulesCore`).

**Templates** are Mustache: placeholders, and sections that repeat over a list or show only when something is there. Nothing is escaped. Blank lines left by empty sections are closed up. A name found nowhere, or a placeholder that prints a list or an object, is a problem; `{{json path}}` prints one on purpose, as JSON (the skills step shows each status's effects this way). A partial, `{{> system}}`, is a text of `constants.yaml` filled in where it stands, reading what the step reads: every step's system prompt is one (it reads the owner's style), and the rules steps list the world's rule words and its classes this way (`{{> terminology}}`, `{{> classes}}`), once for all of them. A constant printed as a value, `{{constants.voice}}`, is printed as it is written, so a constant that is itself a template is used only as a partial.

**Keyed outputs join their items.** A step whose output has one entry per item of an engine list joins those items: the place plan has one entry per place, and a step run `forEach: map.towns` has one per town. Inside `{{#map.places}}`, `{{placePlan.name}}` is that place's entry, and so is `{{$.town.placePlan.name}}` for a cast slot. A step run for each town whose answer is keyed by one of the town's own lists (`keys: { from: '$.residents[*].id' }`) joins that list's items too, through the town they are in: inside `{{#$.residents}}`, `{{towns.name}}` is that resident's entry in the town step's answer for their town. No template ever looks anything up by id. An item's own fields come first, so a step whose id is also a field name (a resident's `town`) is not found from that item.

**`forEach`** takes a list as written (`map.towns`, or a list in an earlier answer such as `rulesStatuses.statuses`) or the items a path finds. Each call is named by its item's `id`, or by its `name` for an item of an answer, which has none.

**YAML anchors** repeat a part of a schema without writing it twice: `each: &look …` once, then `each: *look` wherever the same shape is wanted.

**Schemas** are a subset of JSON Schema, written in YAML. They cover:
- strings with `minLength` (default 1), `maxLength` and `pattern`;
- numbers, booleans, `enum` and `const`;
- arrays with `minItems` and `maxItems`, each a number or `{ from: <path> }`, a number read from there (the skills step's tiers read `$.actives`);
- objects;
- unions (`anyOf`): of objects that carry a `const` `kind` (a quest's steps), of objects told apart by the fields they have (a class's weapon, or its one-handed and two-handed ones), and of constants and objects together (a status's effects).

Every property is required, and `nullable: true` makes a field optional, as strict mode demands.

Strict mode holds every token to the schema while the model writes, so a few rules keep a model from being cornered:

- **A fixed number of things is named fields, not a list.** A list must have a range the model can always meet. With exactly five, a model that has written four cannot close it, and can only go on with blank space. (Item qualities are `common` to `legendary` for this reason.) The exception is a tier's skills and passives, whose number comes from the level cap (`minItems` and `maxItems` both from `$.actives` or `$.passives`): one to three, which Luna meets.
- **A `maxLength` is told to the model and enforced loosely.** The model is told the limit in the field's description and writes to it. The gateway sends a hard cap a quarter higher, which cuts text mid-word, so it only stops a runaway. A field between the limit and the cap is rewritten on its own, or trimmed at a word. A limit under 20 (a name, an abbreviation) has no word to trim at and is sent as it is. The editor's answer shape shows the limits the model is told; the request body shows what is sent.
- **Blank space stops a call.** Blank space between tokens is valid JSON and no schema can limit it. The gateway therefore streams every structured answer, and stops one after 400 blank characters in a row, keeping what it wrote.

Three additions refer to what exists, which is how worlds stay consistent by construction:

- **`enum: { from: <path> }`**: the values found there. An enum with nothing to choose from drops its union member (an arc with no wild place or dungeon in reach has no "fight" step); anywhere else it is a problem.
- **`keys: { from: <path> }` with `each`**: one required entry per value, with `$` the item it was read from.
- **Descriptions are templates**: "A person of the story who lives in {{$.town.placePlan.name}}".
- **`when: <path>`** on a property or a union member: it is there only when the path finds something (a system that is on, a list that is not empty). `a & b` needs both, and a list (`when: [ a, b ]`) any one of them: a crafting material is there when any craft that uses it is. The bombs of magic damage and the statuses' control kind exist only in worlds that have them.
- **Enums of true and false**: `enum: { from: 'input.systems.crafting[*]' }` is either choice when the owner left crafting open, and only their choice when they fixed it, so an owner's choice holds by construction.

An unknown key in a schema is a problem. The usual cause is a description containing a comma inside `{ … }`, which YAML splits, so such descriptions need quotes. The resolved schema goes to the existing gateway (`genai().structured`) as it is, with zod made from it to check the answer, so strict mode, length fitting, retries, and the call log work as for every other call. An enum of both true and false is sent as a plain boolean.

**Checks** say what an answer must hold that a schema cannot: that some value appears somewhere in a list, or that of several fields that may each be nothing, one is there. Each lists paths into the answer (`in`) and the values that must be found there (`has`, given or read `from` a path; without `has`, something must be found at one of the paths), with an optional `when`. An answer that fails one is asked for again, told what is missing.

```yaml
checks:
  - says: Give some class a skill that deals damage
    in: ['skills[*][*].effects[*]']
    has: [damage]
```

A check is the last resort: shape the answer so it cannot be wrong instead. Asked again, Luna often sent the same answer back word for word, and a prompt that lists what must be covered still let it leave one thing out. So two steps use checks today, each for what its schema cannot say. `rulesCore`, whose classes may each be nothing where they do not fit, must give at least one class that deals damage (a world with none cannot be played, and the schema cannot say "one of these four"). `rulesSkills` must give each class that deals damage a skill used on an enemy in its first tier, since a hero starts with a skill from there and must be able to fight with it (a list cannot say "one of its items is of this kind"). The attributes, for instance, were checked to cover every way of playing; then one step named them and the next had a field for each thing a hero grows stronger in, which had to name one of them.

A check whose paths find nothing in a made-up answer is a problem, since it would fail every run.

**Names** list the paths to names that must all differ, because two things a player meets under one name read as one. Paths that start with the step's own id are its own names, in its answer; the others are names steps before it made. A name of its own that repeats one before it (ignoring case, spacing, and punctuation) is renamed by itself, in a small request that keeps the rest of the answer and lists every name already used. The first of a name keeps it, and an earlier step's names never change, so what later steps read stays true. After three rounds with a repeat left, the run fails. A name asked for again keeps the limits its field has. The rules steps use it: statuses, skills, and passives each differ from the classes' names and from each other. So do the steps whose names later steps choose from: no two places share a name, nor two creature families or their members, since the story and the towns choose them by name; and a boss or named foe has a name of its own, apart from the others of the story (a town's foes also from the story's; each town is written on its own, so two towns' foes are not compared).

```yaml
names:
  - 'rulesStatuses.statuses[*].name'
  - 'rulesSkills[*][*][*].name'
```

On the six examples, a few runs in each world repeated a name, most often a skill named after the status it gives. Every repeat was renamed in the first round, with names that fit ("Per My Last Email" became "Forwarded for Visibility").

## What reads what

Templates and schemas read their inputs through views (`track.ts`) that note every step and field they touch. So rendering every step on outputs made up from the schemas (`scope.ts` in sample mode, where each made-up text says where it comes from, such as `⟨placePlan.places.t0_0.name⟩`, and a list holds one item of each kind it can, even when that is more than it may hold) gives everything at once, with nothing declared twice:

- **The order**: each step after every step it reads. Steps that read each other are a problem that names them.
- **Readers**: which steps and records read each step.
- **Unread fields**: by canonical path (`placePlan.places[*].secret`). A record reads exactly the fields its shape takes. An unread field is not an error. A step nothing reads is a variant, or unused.
- **Problems**: names that are not there, fields that the step a path reads has in no world, schemas that cannot be made, records nothing fills, and records whose shape the output does not match.

## The build's steps

As `pipeline/order.yaml` lists them (each after every step it reads; steps that need nothing from each other run side by side). Every name a step refers to is chosen from what exists: places, people, and creature families by enums, the rules' own names by enums of what the earlier rules steps made, and every slot the engine made by a required key.

| Step | Makes | Reads | State |
|---|---|---|---|
| `ownerStyle` | How the owner wants people to talk, in their words, or nothing; every step's system prompt and every conversation use it in place of plain, everyday words | the theme, the prompts | First version |
| `concept` | The world in general terms: setting, tone, genre, title | the theme | Settled |
| `art` | The art style, the interface's palette and look | concept, the art prompt | Settled |
| `rulesSystems` | Which optional systems the world has (crafting, upgrades, enchanting, control, critical hits, dodge, fast travel, the signature effects life steal, thorns, and regeneration, healing, shields, magic, and the kinds of consumable: healing, cleansing, buffs, debuffs, and bombs), where items are stored in towns, how a downed character gets up, what defeat costs, and how much each hit's damage varies | concept, the rules prompt, the owner's choices | Settled |
| `rulesCore` | The rules' words; the classes (for physical damage, and for magic where the world has it: a melee class, a ranged class, or both, with the damage they deal; a healer and a buff and debuff class, each attacking up close or from a distance); the races (a look and three to six example first names each, no strengths, one where everyone is the same people); slots; item qualities | concept, rulesSystems, the rules prompt | Settled |
| `rulesStatuses` | The buffs and debuffs skills can put on a target, each with its effects, named in the world's terms | rulesCore, rulesSystems | Settled |
| `rulesSkills` | The classes' active skills by tier, each one of three kinds by whom it is used on (an enemy, an ally, its user alone), with its area and the effects that fit that kind: damage and statuses on enemies or its user; healing, cleansing, reviving and statuses on allies or its user; the same for its user alone | rulesCore, rulesSystems, rulesStatuses | Settled |
| `rulesPassives` | Three passives in each tier of each class, of steady effects, named apart from the active skills | rulesCore, rulesSystems, rulesSkills | Settled |
| `rulesGear` | What a character wields and wears: each class's weapons, shields, a piece of each kind of armor for every armor slot, accessories | rulesCore, rulesSystems, the steps before it (names) | Settled |
| `rulesItems` | What a character uses up, sells, or crafts with: a consumable of each kind the world has, valuables, and the crafting materials its crafts use | rulesCore, rulesSystems, rulesStatuses, the steps before it (names) | Settled |
| `ownerPlaces` | The places the owner's prompts mention | the prompts | Settled |
| `placePlan` | Every place, named and described, with the size of its map chosen from the sizes the engine offers for its kind of place | concept, the owner's places, the map | Settled |
| `creatures` | The creature families, where each lives and its members, each a kind of fighter (soldier, brute, swarm, stalker, or guardian: its body and its habit in a fight) fighting as one of the classes (whose skills and damage it uses) | rulesCore, placePlan, the creatures prompt | Settled |
| `story` | The story's people (by the engine's slots) and the arcs and their quests. A quest's steps are persuading someone, bringing something found in a place, fighting a family where it lives, a named foe, a boss (one foe an arc comes to a head with, fighting as one or two classes), or a choice between fighting and a clever way someone knows | concept, rulesCore, placePlan, creatures | Third version |
| `telling` | The pitch, the narrator's intro, a closing for each arc but the last, the ending, the narrator's voice | story | Second version |
| `towns` | Each town's story people at home, its other residents by slot, buildings, sign, and side quests (the same steps as the story's, without bosses) | story, creatures, placePlan | Second version |
| `areas` | What is found written in each wild place and dungeon | story, creatures, placePlan | Settled |
| `people` | Every townsperson's inner life, one call per town; what each field is for is said in the schema | towns, story | Second version |
| `fightLooks` | How each kind of damage, healing and every status look in a fight, and how each kind of damage's skills move (a rush, a shot, and an area's blast) | rulesCore, rulesStatuses, art | Settled |
| `sounds` | What each sound is made from (a spell and a hit for each kind of damage, described by what its classes' attacks are made of; a cry and a death for each creature family), and the soundtrack | rulesCore, creatures, story, placePlan | Second version |

What changed from the old build's calls, step by step:

- **The rules** are seven calls: systems, core (words, classes, races, slots, qualities), statuses, skills, passives, gear, and items. The owner's prompt about the rules goes to each, and decides above all. What a world chooses from a fixed list comes from the engine's vocabularies (`game.rules`), and every reference between the calls is an enum of what an earlier call made. The rules compiler (`rules/worldRules.ts`, docs/rulesets.md) turns the seven records into the world's ruleset and prices every number; the balance simulation tunes it.
  - **Systems come first**, with the owner's choices fixed by construction, so later calls ask only for what the systems on need. Traps and locks were removed: characters heal after a fight and statuses wear off, so a trap outside a fight does nothing, and there is no lockpicking worth playing yet. How a downed character gets up is a system too.
  - **Classes, not attributes, carry builds.** Each kind of damage has a melee class, a ranged class or both; a world has one healer and one buff and debuff class at most. Any player puts points into any class, and a hybrid mixes them. Attributes, resources, and fixed kinds of skill came first and were dropped: attributes left effects that nothing raised, or piled Health, melee damage, and armor onto one, and a class that fought at both ranges could use only half its skills with either weapon.
  - **Races** have no strengths: a look and three to six example first names. A fixed six names gave blank and placeholder names, and a cap of four races broke a world that wanted more.
  - **Words**: the familiar game terms unless the world has a clearly better word. The class and race words are fields named `class` and `race`; the world writes what players see.
  - **No example lists and no "never" lists**: examples were copied (the office's damage was Physical and Magic, its kinds Fire and Cold), and naming what not to do named it. Each field says what it is for, and a prompt ends with just the ask.
  - **Counts are ranges.** A fixed count, or a cap smaller than what Luna wants, makes her run on into blank space or placeholder text in strict mode.
  - **Statuses** are a buff shape and a debuff shape, so a debuff cannot carry thorns. Healing is a system like crit or dodge: without it no skill, passive, or status heals.
  - The interface's look is the art step's.
- **The crafts** (the utility tree) are named in the items step, one for each craft the world has: the engine sets what each rank does. Brewing follows the consumables, not gear crafting: a world with any consumable has a reagent and a name for brewing, the compiler makes a recipe for each consumable, and its towns have a workbench and a seller of materials, as with any other craft. A world that came out with no craft at all has no workbench, and the slot the engine kept for a seller of materials (facts come before the rules) is a resident like any other.
- **The fight looks** are keyed by the rules' own damage types, kinds, and statuses, so none is left without a look.
- **The creatures** say which of the world's wilds and dungeons each family lives in, where the old build gave habitat words for the engine to match to places. Each member fights as one of the world's classes, using its skills and damage, so nothing is designed for creatures alone; its kind of fighter is its body and its habit in a fight. The kinds were once roles (archer, caster, healer) that the classes now say.
- **The story** fights a family by name in a place it lives. A boss is the one foe an arc comes to a head with: at most one per arc. Its looks, voice, taunt, and classes are written with it (its body is an ordinary fighter's, made a boss's by the rules).
  - **Quests.** A step is one thing to do, or a choice between fighting and a clever way someone knows (sounding the old market's closing call so the drowned retainers leave their stalls). Steps of two free ways were tried first and came back as two talks, or a boss one could skip; making every fight a choice made the alternatives filler; and letting the other way be finding the thing instead only dodged the fight. So the other way is always a person's plan, there only where one exists: about one step in five. The fighting way may go on to take what the fight wins (beat the guardian, then find the token it kept), when the plan does without that thing; the steps after a choice are done whichever way was taken. When the choice held only the fight, a model whose plan replaced the token put finding it after the choice, and a player who won the person over still had to go and find it.
  - **No talk steps and no courier errands.** A talk step was done as soon as a conversation opened, and bringing something from one person to another was a walk across town: the main quests read as chores (talk, talk, carry, fight, go back). A thing to bring is found in a place; a person is won over.
  - **The clever way is found by talking.** The quest log shows that there is another way and whom to see about it ("or find another way with Sella"), not the plan: that person knows it, tells it if asked, and agrees once the party makes the case. The judge weighs the plan itself.
  - **Named foes** are one of a family with a name of their own (Stapleface, a homicidal stapler). They are drawn as that creature and fought as a strong one of them, not as a boss, so they cost no painting.
  - **What a person tells** is given to them to say in their own words (the giver tells what is going on as the story quest starts); before, it was written and never used. Someone who hands something over gives it when the party comes for it, not when the quest starts.
  - **Bosses mix one or two classes**, as a hybrid player does. With one class and a kind of fighter, five of six worlds ended on the same fight: a guardian of the buff and debuff class.
  - **One to four quests an arc.** A forced second quest came back as a copy of the first.
  - **Going to the giver** is the code's rule, not the model's: a story quest starts by itself, so it starts by going to the one who asks unless the party is with them already, and a side quest, taken by talking to its giver, drops a first step of talking to them.
  - The engine groups a quest's objectives into steps of ways (`step`, `way` on each objective, `questSteps` and `currentWays` in shared): a step is done when every objective of one of its ways is.
- **The telling** is written from the finished story, so the pitch, intro, and ending tell only of what happens. It also closes each arc but the last, whose words are the ending's (the arcs ended on a title alone before).
- **The towns** fill the engine's slots: the town's story people (named by the story) get their looks, voice, and past at home, and each resident slot already has its part for visitors. So every town has the people it needs and no resident repeats a story person, by construction: the old build checked for both afterwards and asked again. Buildings name their keeper. Side quests are keyed by slots, choose every person, place, and foe from what exists, and are kept apart from the main story (a first run retold the main story's first quest).
- **The place plan sizes each place**: a town from 2×2 to 3×3 tiles, wilds from 2×2 to 4×4, a dungeon from 2×1 to 4×3 (a tile is about 25 m square). It is told how many tiles all places share and chooses a size for each from the place's `sizes`, so the space goes where the story lingers. The engine then makes the total fit (`placeTiles` in `world.ts`): a size is held to its kind's range (`fitTiles`), and while the places use more tiles than the world has, the largest that can still shrink loses a column or a row from its longer side. The old build asked for columns and rows as numbers and asked again when the total was over.
- **The skills offer only what fits**: a skill's kind is whom it is used on, and each kind's effects are its own, so a skill cannot deal damage and put a status on allies, or heal and put one on enemies (the rules compiler refuses such a record). What a world does not have is not offered: healing, life steal, a revive where the fallen do not get up by skills, silence without magic.
- **The notes** of the wilds and dungeons are written from the story as it is. The old ones were told to hint at the concept's secret, which no longer exists, and wrote mysteries nothing paid off.
- **The people** say what each field is for in the schema, where the prompt carried a long guide. A fixed five passing remarks ran on into blank space when Luna wanted four; three to six, with five or six asked for in words, gives five or six. They are keyed by the engine's ids. Opinions name people by id, and a stash is kept in one of the places next to the town.
- **The sounds** have a required key for every game moment, kind of damage, creature family, place, and boss. The old build asked for lists, then asked again for whatever they left out.

A whole world's text cost about a cent and a half on Luna when it was sixteen steps (the woodland: $0.0116); it is twenty steps now, and has not been measured again.

## Talking with the people

How people talk is the part of a world players judge most, and it depends on everything before it: the story, the town, the person's inner life, and the game's conversation code. So the tool talks with them through the game itself. `chat.ts` makes the world from the example's newest runs (`world.ts`), starts an adventure in it with one hero, Ash, of the world's first class and kin, and runs the game's own conversation (`game/dialogue.ts`): the judge decides, the code settles it, and Luna speaks. Nothing is saved. Every call counts against the spending cap, and a conversation turn costs a small fraction of a cent.

A conversation reports what the person said, what they now think of the hero and why, the quests begun and what went into the journal, and the exact person sheet the speaking model is given. The editor's Talk page and the CLI's `chat` show the same.

## Runs

- **Examples** are saved owner inputs in `pipeline/examples/`. An example's id lays out its map, as a world's id lays out a world's. The six worlds of the prompt redesign are the first ones; there are seven now.
- **A step runs from the newest runs of the steps it reads.** If one has not run, the step refuses and names it. A run can be repeated side by side, and can cover one example or all of them. Running everything takes the steps in order, side by side where they need nothing from each other. `Pipeline.needed(example)` lists the steps a world is made from: those whose answers fill the records, and every step they read. A variant nothing reads is not among them, so a build that runs only these does not pay for it.
- **Each run is kept** in `data/pipeline/<example>/<step>/` (`store.ts`). It holds the request bodies as sent but for the tier (a run is as good whichever tier served it), the answer, the tokens, reasoning and cost, the time taken and a fingerprint. On failure it holds the error and the text the answer had reached. A run's file is written whole or not at all, and the newest answer is found by reading from the newest run back.
- **Out of date.** A step's newest run is out of date when it would no longer send exactly what it sent (its requests, its checks, and the names its own must differ from), or when a step it read is itself out of date. A step it read that ran again with the same answer to what this one reads changes nothing. A change to a step that sends the same, such as an equivalent rewrite, leaves its runs as they are. The request holds everything the step read (the facts and constants it uses and the earlier answers), so a change to anything it does not read, such as a new constant for another step, leaves it as it is.
- **Spend** is counted call by call from the gateway's usage (`CallContext.onUsage`), shown after every run, and stops new calls at a cap: the CLI's `--cap` (default $0.50), or the editor's, set in its top bar (default $1, or `DAYDREAM_DESIGNER_CAP`). Scripts outside the job system bypass the server's spend ledger, so the runner keeps its own count.
- **The tier.** The editor and the CLI ask OpenAI for the standard tier, so answers come quickly while designing; a build asks for flex, at half the price and slower. A call is priced at the tier that served it, as its answer says.

## The CLI

`node src/cli/pipeline.ts <command>` from `packages/server`; with no command it prints its usage. It is made to be read by people and by Claude: short by default, with everything exact a flag away. Answers print as YAML, each text on one line, so they diff line by line. Every command works on one example: the one `--example` names, or else the one run last. The first line of the output says which.

- **Looking:**
  - `steps`: every step in order, with its state, what it reads, what reads it, and the fields nothing reads.
  - `check`: only the problems. It exits 1 when there are any.
  - `readers <step>[.<field>]`: each field of a step's answer, with the steps and records that read it.
  - `render <step>`: the system and user text and the answer's shape in words, from the same rules as the editor's shape view (`pipeline/shape.ts`). `--body` prints the request body exactly as sent instead of the shape. A step run once per item shows its first call, unless `--item <id>` or `--all` asks for others. `--sample` makes the steps it reads stand for made-up answers.
  - `examples`: each example and how far it has run.
  - `facts`: what templates read from the example (`input` and `map`). A place inside another prints as its id.
  - `constants`: what templates read as constants.
  - `record <name>`: what fills a record, its shape, and what the example's runs fill it with.
- **Talking:**
  - `chat`: the people of the example's world, town by town, with their ids.
  - `chat <person> "line" "line" …`: a conversation with one of them, by id or by part of their name. They greet the hero, each line is said in turn, and at the end it prints what they think of the hero, the quests begun, and the journal. `--sheet` also prints what the speaking model is told about who they are.
- **Runs:**
  - `runs <step>`: a step's runs, newest first.
  - `show <step>`: a run's answer, the newest unless `--run <id>` names one. `--at arcs.arc1.quests.0` prints only that part, and `--json` prints JSON.
  - `diff <step> [<other step>]`: two answers line by line. For one step, the run before the newest is marked `-` and the newest `+`. For two steps, the first step's newest run is `-` and the other's `+`, such as a variant beside what it was copied from. `--run` and `--with` name other runs.
  - `run <step|all>`: runs a step, `--times n` side by side, or every step in order (`--stale`: only those out of date). `--example all` runs on every example. Spending stops at the cap, which is $0.50 unless `--cap` sets another.

## The editor

`npm run designer`, then open http://localhost:5190 (`DAYDREAM_DESIGNER_PORT` moves it). It is its own package, `packages/designer`: a React page served through Vite and a small API on one port. It needs no accounts, database, or job worker, so it keeps working while the game server is refactored. The model config and key are the server's: `config/genai.json` (or `DAYDREAM_GENAI_CONFIG`) and `.env`. A worktree needs its own copies of both, and both are git-ignored.

- **The sidebar** has five parts:
  - **Example**: the example everything runs on and shows. Clicking one chooses it, and **Edit** opens its file. The box below adds a new example, as a copy of the chosen one (with a map of its own, laid out from its new id).
  - **Steps**, under the groups of `pipeline/order.yaml`. Each shows its state (up to date, out of date, not run, failed) and marks a step run once for each item, unread fields, and problems. The box below adds a step.
  - **Records**, each with the output that fills it.
  - **Talk**: the people of the example's world (see below).
  - **Constants**: `pipeline/constants.yaml`, to edit beside the values as templates read them.
- **Answers read as documents.** One view shows a step's answer, a record's contents, and an example's facts, by a few general rules (`Value.tsx`):
  - entries keyed by id are sections headed by their id and name;
  - a list of rows sharing a few short fields is a table;
  - other lists of objects are numbered cards headed by their kind and name;
  - colors show their color.

  Any id that one of the example's answers names (a place, a story person, an arc) shows its name beside it. The exact JSON is a toggle away, with a copy button.
- **Shapes read as fields** (`Shape.tsx`): each field with its type in plain words, its limits, and its description. A union lists its kinds, each named by its constant field (`kind: fight`). Records and a step's answer as sent are drawn the same way.
- **A step** has four tabs. The tab chosen stays as you go from step to step.
  - **Prompt** and **Schema** edit the step beside what it sends to the Responses API: the rendered system and user text, the shape of the answer, or the whole request body. That view follows every keystroke before anything is saved, with the steps it reads standing for their newest runs or for made-up answers. Ctrl+S saves, keeping the file's comments. An edit is kept while any other tab of the step is open, and leaving the step, the example, or the page with an edit not saved asks first. A step's `names` and `checks` are edited in its file: the editor keeps them as they are.
  - **Output**: any run, the newest first, with its time, cost, and tokens, or its error and where the answer had reached.
  - **Compare runs**: two runs side by side, of this step or of another. A variant of the step is offered first.
- **Talk** lists the people of the example's world by town. Choosing one starts a conversation: they greet the hero, and each line you say gets the game's own answer. Beside it are what the conversation changed (what they think of the hero and why, quests, journal) and, a toggle away, exactly what the speaking model is told about who they are. A conversation ends when another starts or the page is left, and "Start again" begins it afresh.
- **A record** shows which output fills it, its shape (from `records.ts`, so it is always the game's own), and what the chosen example's newest runs fill it with.
- **An example** is its file as YAML, beside what templates read from it: `input` (the file as templates see it, each prompt with what its topic is `about`) and `map` (what the engine lays out before any call). Saving checks it the way the server checks a new world's input (`worldInput.ts`), and an example the server would refuse is listed as a problem.
- **Duplicate** copies a step under a new id. Nothing reads the copy, so it is a variant to run and compare. **Delete** asks once more before it acts.
- **Run** a step on the chosen example or on every example, one to three times side by side. Along the top are "Run what is out of date" and "Run every step" on the chosen example, the latest runs and their progress, and the spending cap.
- The page rereads the files every few seconds, so changes made outside it (by hand, or by Claude through the CLI) show at once. A step being edited is not reloaded under its editor.
- Its server restarts by itself when the engine's code changes (Node's watch mode), so the page never checks steps against code older than the files.
- The API answers only requests from this machine's own pages: it checks the host and the origin, and needs JSON for anything that changes something. It writes only step files in `pipeline/steps/`, example files in `pipeline/examples/`, `pipeline/constants.yaml` and `pipeline/order.yaml`.

## What stays in code

- **Engine facts**: the map, arcs, stretches, and every slot the steps fill.
- **Record types and their conversion** into the game's world (`world.ts`).
- **Calls that need what only the build has made**:
  - calls that look at images (map reading, door marks, landmarks, placement), and the mist, which needs the light measured from each painting;
  - the image prompts, written in the painting loop and rewritten when a picture is rejected;
  - the place painting plan (`planMap`), which needs each place's size and its ways out from the layout: it can become a step once the layout is an engine fact;
  - all GPU work.

## The build

Before a world exists, its owner reviews its concept and rule systems on the creation page (`worldgen/review.ts`):
the steps the two read run on the owner's description, at the standard tier since the owner is waiting, in a scratch folder (`data/cache/reviews/<id>/`), the owner may
describe the world again (only the steps the change reaches run again) or set any system by hand, which becomes their
choice in the input and amends the rules systems step's answer without asking a model again (`amendStep`, kept as
a run marked `edited`). Nothing is saved as a world until they create it; then the review's runs move into the new
world's store and the build begins with them fresh. A review left a day is cleared.

A world's build (`worldgen/build.ts`) runs the steps `pipe.needed(ex)` lists (those behind the game's records and all they read, which its stages count too) on the world's own input, its map laid out from the world's id,
through the same runner as the editor and the CLI. Its runs are kept with the world, in
`data/worlds/<id>/draft/pipeline/`, so a build that stops (a worker restart, a model that was down) resumes with the
steps that finished: only those not fresh run again. A step that fails is tried again after a wait, four times in
all, before the build stops to be resumed later; a step run once per item keeps the answers it got and asks again
only for the items that failed. The build's stages are the groups of `order.yaml`, then painting
places, balancing, characters and items, voices and sound.

When every step is done, `world.ts` makes the world, exactly as the editor's Talk page does. Then the places are
painted, read, and furnished (the creatures, which stood about on open ground, are placed again where each painting
has room); the rules are balanced on the spare cores; people, creatures, and bosses are drawn while places are painted,
heroes and item icons once the rules are balanced; voices are designed and the lines known before play spoken; and
every sound is made from the sounds step's answer. On the GPU, places come first: the voices and sounds wait until
every place is painted and settled, since a place's GPU work is followed by Luna's and the CPU's and theirs is not
(`worldgen/gpu.ts`). The quest check runs last.

A world's owner can write its rules anew: its rules steps run again in its own pipeline store, and the ruleset is
compiled and balanced again.

## Next

- **Move the owner-places filter.** The owner-places step's answers are meant to be kept only when they are quoted from the prompts. That filter belongs in the place plan's record code, or in an engine fact over the step's output.
- **Better text editing.** If the plain text boxes prove clumsy, CodeMirror would give the editor a proper text editor, and `diff` would show the changes between two prompts.
