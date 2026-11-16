# Daydream

**What you need.** Building a world needs an OpenAI API key and a GPU PC running ComfyUI with the game's models behind the GPU broker ("Configuring AI models", below). No sample world ships with the repository, so there is nothing to play until a world has been built.

A GenAI-built 2D top-down RPG. Describe a theme — high fantasy, a derelict space station, a cozy animal village, an office printer apocalypse — and the game dreams up its places, people, monsters, items, rules, main story, and twists, then lets you walk into it and play: real-time exploration, Divinity-style turn-based combat, free-text conversations with people who have their own wants, opinions, and secrets, remember you and hear what you have done.

## Quick start

```bash
npm install
npm run dev
```

Open the invite link the server prints on its first start (http://localhost:5173/#/invite/<code>) and set up the administrator: a user name, then a password, a passkey, or both. Accounts are invite only: administrators create invite links on the **Users** page, and `npm run users -w @daydream/server -- list` / `reset <user name or id>` make a new link from the console. Building a world needs OpenAI and ComfyUI behind the GPU broker (below); then choose **Dream up a new world**, describe it, review the concept and rules written for it, and create it.

- `npm run dev` — game server (port 3000, restarts on every change), job worker (pauses its jobs at a safe point and restarts with new code; they resume from checkpoints) + Vite client (port 5173)
- `npm run build && npm start` — production: the server also serves the built client on port 3000 (`DAYDREAM_PORT` to change) and runs jobs itself; set `DAYDREAM_WORKER=external` and run `npm run worker -w @daydream/server` (one or more) to run them in separate processes. See [docs/server-architecture.md](docs/server-architecture.md).
- `npm test` (`npx vitest run` from the repository root) — world generation against a mock model, gameplay simulation, combat balance, the GPU broker, image post-processing
- `npm run broker` — the GPU broker (on the GPU PC, started by hand before building: [docs/gpu-broker.md](docs/gpu-broker.md))
- `npm run typecheck`
- `npm run setup` — in a git worktree beside the main checkout: its own ports, a test administrator, and a signed-in session for tools in `data/dev.json` (see `CLAUDE.md`, "Setting up a worktree")
- `npm run play -- help` — play the game from a terminal, for AI agents playtesting it: commands, screenshots and a report per run ([docs/playtesting.md](docs/playtesting.md)). Like `npm run setup`, it needs a git worktree beside the main checkout: it plays in the worktree that setup prepared.

Node 24.12 or newer runs the TypeScript of the server, worker, GPU broker, designer, and console tools as it is, by
stripping the types: there is no build step for them, and errors point at the real lines. So the code uses only
syntax Node can erase (no enums, namespaces, or parameter properties), every relative import names its file
(`./combat.ts`), and type-only imports say `type`. `npm run typecheck` holds it to that (`erasableSyntaxOnly` and
`verbatimModuleSyntax` in `tsconfig.base.json`). Only the client is bundled, by Vite, and the tests run under vitest.

Data (accounts, worlds, adventures, generated art, AI call logs) lives in `data/` (`DAYDREAM_DATA_DIR` to move it).
Everything else the game makes or installs stays in the repository too, git-ignored: models exported at install in
`models/` (Pocket TTS's in `models/pocket/`), and each Python environment in a `.venv` beside the code it runs
(`packages/gpu-broker/speech/.venv`), made from the `requirements.txt` there. Outside it are only the tools it uses:
Node, Python and uv, ComfyUI with its models, and the Hugging Face download cache.

## How it is built

```
packages/shared   Fixed game rules shared by server and client: the ruleset's shape (classes as skill trees,
                  damage types, statuses, items, and affixes), crafting, kinds of fighter, quest objectives and
                  steps, stats & combat math, protocol, pathfinding.
packages/server   TypeScript (Node) authoritative game server.
  genai/          Provider layer: OpenAI (Responses for text and strict structured output, decisions, transcription)
                  and ComfyUI behind the GPU broker. zod validation, retry-with-feedback, concurrency limits,
                  spending caps, call log. Image pipeline: Luna-written prompts per asset, painted in rounds by GPT
                  Image on a transparent background through the Batch API (or by FLUX 3 Image Klein on a chroma-key
                  backdrop, keyed out over the whole frame), content checked by Luna's decision model, repainted until good.
  pipeline/       The build's text steps (docs/build-pipeline.md): the runner, the facts the engine fixes, and the
                  world made from the steps' answers.
  rules/          The rules compiler (a world's rules records → its ruleset, every number priced) and the balance
                  simulation (docs/rulesets.md).
  worldgen/       The build (build.ts): the text steps, then the world assembled from them; places painted, read
                  and furnished on the GPU while the rules are balanced, characters, objects, and icons drawn,
                  voices made, and the world's sounds and music.
  sound/          A world's sounds (docs/sound.md): Luna's prompts, takes made by Stable Audio 3, the game-ready
                  step (trim, level, loop) and the checks, run on a thread of their own.
  speech/         Voices at play time (docs/voices.md): the engines behind one interface, Opus streaming to
                  everyone listening, the six-second rule. Pocket TTS runs here on ONNX Runtime; its export to
                  ONNX is a Python script, packages/server/speech/pocket_export.py.
  anim/           Actor animation: GPT Image paints each character's turnaround, clip sheets, and walk GIFs from its
                  painted standing view, through OpenAI's Batch API; steadied and packed into sprite sheets.
  game/           Adventures: zones, movement, interactions, loot, trade, crafting, quests, conversations
                  (docs/people.md), news and memory, combat (turns, AP, armor, statuses), tactical AI, saving.
packages/gpu-broker  The one door to the GPU for every installation (docs/gpu-broker.md); speech/ holds the VoxCPM2
                     runner and the VoiceDesign designer it runs for voices.
packages/designer The build pipeline's editor (docs/build-pipeline.md): a local tool, apart from the game server.
pipeline/         The build's text steps as data: steps, constants, record bindings, and example inputs.
packages/client   React UI + canvas renderer (each place's top-down map as the ground, figures in depth
                  order, lighting and day/night, fog of war, weather, particles, combat reach rings).
config/           genai.example.json, broker.example.json, ComfyUI workflow templates.
```

### Design principles

- **Fixed mechanics, generated flavor.** Every world's rules are generated as data and priced by one engine: the AI picks which skills and systems fit and writes names, descriptions, characters, and story, in plain game words (Health, Gold, Fire) unless the theme truly calls for another recognizable word. It never invents numbers.
- **Code decides, the model chooses and speaks.** In a conversation the code lists what a person could do right now (talk, a gift, a secret), a decision model judges which fits, and how they feel, the code carries it out only when the judge is sure enough (quest work follows fixed rules instead, so no quest waits on a mood), and only then does Luna write the words, told exactly what was done (docs/people.md).
- **The build guarantees playability.** Every name a step uses is a choice from what exists, the world is made around its quests, and a last check walks every quest, every way out, and every quest item. A step that keeps failing stops the build, which resumes from its checkpoints. At play time people answer with simple rule-based replies when the model is out of budget or down.
- **Pre-generate everything that can be.** Worlds are generated once and saved. Any number of adventures can be played in one world.

### Storage

| What | Where | Why |
|---|---|---|
| Accounts, sessions, catalog of worlds and adventures | `data/daydream.sqlite` (SQLite, WAL) | Relational, shared by the server and CLI tools |
| A world | `data/worlds/<id>/world.json` + `assets/` | Written during generation, then read whole: plain JSON stays inspectable, hand-editable, and portable (copy the folder) |
| An adventure | `data/adventures/<id>.sqlite` | State split into sections (players, zones, NPCs, conversations, journal, explored maps); an autosave writes only what changed, in one transaction; one file per adventure |

### Gameplay summary

- A world's owner picks its size and the length of its story (`shared/rules/progression.ts`). Sizes: tiny (one town,
  one wild, one dungeon, for demos and a game in an evening), small (one town, two wilds, two dungeons), medium (two
  towns, three of each other) and large (three towns, five wilds, four dungeons); each town heads a region of its own
  level band. Lengths: brief (one story arc, level 5), short (two arcs, level 8), medium (three, level 14), long
  (four, level 20) and epic (five, level 30). Every length's level cap opens every tier of a class.
- Towns, wilds, and dungeons, each one big top-down painting (see `docs/places.md`): people work outside their painted buildings (no interiors), dungeons and wilds hold monster packs, bosses in their lairs, chests, and readable lore. A workbench stands in each town when the world has crafting, and a store for what players keep but do not carry when it has storage (each town's own, or one every town reaches); crafting, brewing, upgrading, and enchanting are crafts a player learns with points of their own, shared by all their heroes (`docs/rulesets.md`). Consumables have no level: their strength follows the hero who uses them. Fast travel between visited towns is a rule each world decides, or its maker picks.
- Real-time exploration; combat starts when enemies spot you (or you strike first). Turn-based combat: action points, movement cost, cooldowns, statuses, and control. Health comes back by itself out of combat (there is no resting or healing by people).
- Every world's classes are skill trees open to every hero: a hero starts in one and may spend points in any, so a party mixes them.
- Play alone or together: an adventure has up to six heroes in the game at once, each made by a player, who commands them in fights or lets them fight on their own (docs/multiplayer.md). Packs are sized to the heroes in their place.
- Main story in arcs; each arc ends with a revelation. Side quests per town, which people offer, sweeten or take back by how they feel about you; persuasion steps are won in conversation.
- People's communication level (set per world) decides how far news of what you do travels: friends, the town, or everywhere. Tell someone your birthday is tomorrow and they may remember; at "small-town" level, the town can gather for you on the day.
- Adventures save themselves as you play; **Save a copy** in the menu makes a separate adventure that carries on from that moment. The world's clock runs while anyone is in the game and stops when everyone has left.
- Anyone may begin adventures in any world they can see, and give other players a place in them: friends share one story (quests, journal, map) and keep their own heroes, bags, and gold. Administrators can join or delete someone else's from a folded-away section of the world page, after confirming.
- Only administrators delete a world (its owner cannot): every player's adventures in it go too, and it waits in a 30-day trash where an administrator can restore it.

## Configuring AI models

Copy `config/genai.example.json` to `config/genai.json`, put `OPENAI_API_KEY` in `.env` at the repository root, then click **Reload config** on the **AI models** page (top bar, administrators). That page also tests each purpose and shows recent calls with timings and errors.

Each purpose maps to a provider:

| Purpose | Used for | Provider |
|---|---|---|
| `world.design` | Concept, world plan, rules, story, each place's plan; Sol (its `strongModel`) checks paintings | OpenAI (Luna) |
| `world.content` | Towns, residents and their inner lives, side quests, lore | OpenAI (Luna) |
| `image.prompt` | Each asset's image prompt, its chroma-key backdrop and (creatures) its view | OpenAI (Luna) |
| `npc.judge` | What a person does in each turn of a conversation and how they feel | OpenAI decisions |
| `npc.decision` | A person's words, once the judge has decided what they do | OpenAI (Luna, standard tier for latency) |
| `narration` | Short flavor text, the legends of top-rarity items, people's notes on old conversations | OpenAI |
| `image.check` | Checks painted art and places | OpenAI decisions |
| `image.sprite` / `image.icon` | Characters, creatures, objects, and item icons | GPT Image 2.5 Flare, batched (or ComfyUI's FLUX 3 Image Klein) |
| `image.read` | Reading painted places for walkable ground | GPT Image 2.5 and 2.6 Sunburst (or Qwen on the GPU, when left out) |
| `speech.input` | Talking to people by voice | OpenAI transcription |
| `speech.cpu` | People's and the narrator's voices on this machine's CPU (docs/voices.md) | Pocket TTS |
| `speech.gpu` | The same voices on the GPU while it is idle; the reply's engine is chosen by speed | The GPU broker (the comfyui provider) |

Provider types: `openai-responses`, `openai-decision`, `openai-transcribe`, `openai-image`, `comfyui`, and `pocket-tts` (Pocket TTS models exported to ONNX; docs/hosting.md, step 4a). `openai-image` is OpenAI's GPT Image (default `gpt-image-2.5-flare`, `quality` default medium) through the Images API: it paints and edits for any image purpose, priced by token (text input $5, image input $8, image output $30 per million). By default it paints the art (`image.sprite`, `image.icon`: transparent, each round through the Batch API, about $0.003 an image; docs/world-art.md) and the animation (`image.animation` for the clip sheets and `image.walk` for the walk GIFs on GPT Image 2.6, always batched), and reads the painted places (`image.read`: two plans per painting, about $0.06; docs/places.md, "Reading the map"). Places are painted with Klein on the GPU: GPT Image's maps had a melted look up close (docs/experiments/gpt-paint). Klein stays the art's backup (the purposes on the comfyui provider), and Qwen the reading's (`image.read` left out). API keys can be literal, `"env:VAR_NAME"`, or `"credential:NAME"` (a systemd credential). Paid calls are charged to the user they are for, within each account's monthly budget and the server's daily ceiling (`spending`).

World generation writes the whole world first (its text steps), then paints, reads and furnishes the places on the GPU while the rules are balanced and the art, voices and sounds are made side by side. ComfyUI needs FLUX 3 Image Klein (and Qwen-Image 2.1 Turbo when `image.read` is left out; `config/comfyui/`, see `docs/places.md` and `docs/world-art.md`), and Stable Audio 3 Small SFX and Medium for sound and music (`docs/sound.md`), and runs an installed copy of the game's own nodes, `config/comfyui/daydream-nodes/` (`docs/gpu-broker.md`). It sits behind the GPU broker, which gives every installation's work its turn on the GPU and unloads one model before the next: copy `config/broker.example.json` to `config/broker.json` on the GPU PC and start it with `npm run broker`; the comfyui provider's `baseUrl` is the broker's address. Animation needs an `openai-image` provider and the `image.animation` purpose, and walks the `image.walk` purpose (docs/world-art.md, "Characters in motion").

## Known limitations (v1)

- Building a world needs OpenAI and the GPU broker: the build waits while either is away, retries, and can be resumed.
- People walking behind a painted building are drawn over it (no occlusion yet).
- Combat balance was tuned with automated AI-vs-AI simulations (`packages/server/test/balance.test.ts`); it needs human playtesting, especially for higher levels and long campaigns.
- Without the models (out of budget, or down), people decide from the words alone (work, trade, persuasion, insults, remembering dates) and answer with stock lines; real conversation needs the models.
- Accounts are local: a password (scrypt), passkeys, or both, with cookie sessions. A forgotten password is an administrator's reset (a new invite link); there is no email or OAuth.

## License

The code is under the MIT license ([LICENSE](LICENSE)). The models the game runs and the fonts it shows keep their own terms: see [CREDITS.md](CREDITS.md).
