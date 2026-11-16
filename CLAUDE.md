# Daydream: notes for Claude

A GenAI-built 2D top-down RPG. An owner describes a theme; a job builds the whole world once (rules, places
painted as top-down maps, people, story, art, animation), and then anyone plays it in adventures of their own (one
playthrough each, called `Adventure` in the code too). Start with `README.md`, then the doc for the area
you touch.

## Where things are explained

| Doc | Covers |
|---|---|
| `README.md` | What the game is, package layout, storage, model purposes, quick start |
| `docs/server-architecture.md` | Accounts, who may see or play what, jobs and workers, the model gateway, the admin GPU page |
| `docs/hosting.md` | The production box (systemd, Caddy, credentials), deploying, console tools there, moving worlds |
| `docs/gpu-broker.md` | The GPU broker: every installation's ComfyUI work goes through it |
| `docs/places.md` | How a place is painted, read for walkable ground, and furnished |
| `docs/world-art.md` | Characters, creatures, objects, and icons: prompts, painting, cutting out, checks; animation |
| `docs/rulesets.md` | Generated rules: the power budget and the balance simulation |
| `docs/combat.md` | The combat AI, how well it plays and how that is measured, and how fights look |
| `docs/voices.md` | Voices: how they are made at build time, spoken at play time and heard |
| `docs/people.md` | People: their inner lives, how a conversation turn is decided and spoken, regard, memory, news |
| `docs/sound.md` | Sound effects and music: what each sound is, how a build makes it, how it is heard |
| `docs/build-pipeline.md` | The build's text steps as data (`pipeline/`), their runner, the CLI, and the editor |
| `docs/playtesting.md` | AI agents playing the game through `npm run play` (or its MCP server) and reporting bugs and feedback |

## Commands

- `npm run dev`: server on 3000 (restarts on every change), job worker (pauses its jobs at a safe point and
  restarts with new code), client on 5173.
- `npm run designer`: the build pipeline's editor on 5190 (docs/build-pipeline.md), apart from the game server.
- `npx vitest run` from the repository root, and only from there. Tests use `data-test/` and a config with no
  models, never `data/`. Worlds built in tests skip the balance simulation (`DAYDREAM_BALANCE=off`); `balance.test.ts`
  tests the loop and one build in `jobs.test.ts` runs it. Each test file gets its own folder in
  `data-test/run-<pid>/`, so files never meet each other's jobs or saves and two runs in one checkout keep apart; a
  run's folder stays until a later run starts. For something a test waits on, use `until` from `test/helpers.ts`,
  not a fixed sleep.
- `npm run typecheck` covers all five packages.
- The backend has no build step: Node runs its TypeScript directly by stripping the types. Write only erasable
  syntax (no enums, namespaces, or parameter properties), name the file in every relative import (`./x.ts`) and
  mark type-only imports with `type`. Typecheck enforces all three.
- Console tools live in `packages/server/src/cli/`, each documented at its top. Run them with
  `node src/cli/<tool>.ts` from `packages/server`:
  - `users`: invites, resets, administrators, unlocking after wrong passwords; the addresses (`ips`) and activity (`activity`) of accounts.
  - `worldpack`: move a world and its adventures between machines.
  - `placepeek`: see a place's map, walkable ground, and placements.
  - `placetries`: see every painting a build tried for each place, and why the rejected ones were rejected.
  - `buildquality`: judge built places the same way whatever painted them, for comparing builds.
  - `paintworld`, `resettle`, `animate`: rework a built world's art, places, or animation.
  - `voiceworld`: give built worlds their voices (descriptions, clips, and lines made at build time).
  - `soundworld`: give built worlds their sounds and music; `soundkit`: make the game's own sounds (the stand-ins), or bring one in from a WAV (`--use`, as the theme was).
  - `combatlab/`: measure the combat AI (`bench`, `trace`, `oracle`, `balancelab`), areas (`areas`) and healing (`healing`); see `docs/combat.md`.
  - `genlive`: build a world from the command line.
  - `npctalk`: talk to a world's people without saving.
  - `npcscenes`: play scripted scenes with a world's people and have Sol grade them, to compare changes.
  - `paintpeek`: try the art pipeline on a few assets.
  - `dumprules`: write the rules fixtures the tests read (`test/fixtures/rules/`), from the examples' saved pipeline runs, with no model.
  - `strictcheck`: check the art prompts' schema against OpenAI's strict mode (one small paid call).
  - `questcheck`: check that every quest of built worlds can be finished (read-only).
  - `buildrecords`: what building a world took (time, dollars, pictures, GPU, tries by step, and purpose), beside its estimate.
  - `pocketcheck`: check the CPU speech runtime against PyTorch and measure it.
  - `backup`: the nightly snapshot of the data (`backup list` shows them).
  - `pipeline`: the build pipeline's steps: what reads what, what a step sends, its runs and their diffs, examples, facts and records, and talking with an example's people (docs/build-pipeline.md).

## Rules of the house

- **Secrets.**
  - Never print or commit `.env`, `config/genai*.json`, `config/broker.json` or anything holding API keys.
  - If a local config needs a change, make it without echoing values (or tell the user exactly what to change),
    and keep any backup outside the repository unless git ignores it.
- **Spend.**
  - OpenAI calls cost real money and builds take hours of GPU.
  - Keep spend deliberate and report it.
  - Prefer the saved steps of a build (`data/worlds/<id>/draft/`) and the peek tools over building again.
- **No backwards compatibility.**
  - The game is still in development and runs on one machine.
  - Old worlds, adventures, characters and database layouts need not keep working.
  - When the database schema changes, bring the user's dev database (`data/daydream.sqlite` in the main checkout) up to
    date with a one-off script, after backing it up.
- **Dependencies.** Ask the user before installing anything new.
- **Security.**
  - What matters is authentication, access to other people's things, remote code execution, and writing arbitrary
    files.
  - Players cheating in their own game does not matter.
- **Words.**
  - Game text uses plain game terms (Health, Gold, Fire) unless a theme truly needs another word.
  - The game is Daydream; the interface and the code say world and adventure (not daydream, reverie, or instance; `ItemInstance` is one concrete item).
  - Docs and reports are full sentences a cold reader can follow.
- **Quality.** Aim for studio quality and simple, general rules over special cases. Match the surrounding code's
  comment density and naming.
- **Line endings.** Every text file is LF (`.gitattributes`). A script that writes files must write LF: Python
  `open(path, 'w', newline='\n')` (text mode on Windows writes CRLF otherwise), Node `fs.writeFileSync` as is; never
  PowerShell `Set-Content` or `Out-File` on source files. Prefer the Edit tool for changes to code.
- **Git.**
  - In a worktree, commit on its branch.
  - Merge into main or push only when the user says so.
  - Never commit `.claude/launch.json` port changes made for a worktree.

## Setting up a worktree

Run `npm run setup` once in a new worktree (and again whenever; it keeps what is still right), then `npm run dev`
or the preview's "game". It does everything a session used to do by hand (`packages/server/src/cli/setup.ts`):

- **Ports.** The worktree gets its own slot n: the server on 3000 + 10n, the game on 5173 + 10n, the pipeline editor
  on 5190 + 10n. `npm run dev` and `npm run designer` use them by themselves. Its `.claude/launch.json` is rewritten
  with them and marked skip-worktree, so git never shows or commits it; never edit the ports by hand.
- **Signing in.** It makes the test administrator from `config/dev-test-account.json` and writes
  `data/dev.json`: the addresses (`urls.game`, `urls.server`), a signed-in session for scripts (`cookie.name` and
  `cookie.value`, sent as the `Cookie` header, also on the game's WebSocket), and `signIn`, an address that signs a
  browser in when opened while `npm run dev` runs. Never type the password into a browser.
- **A world.** `npm run setup -- --world <id or part of its title>` copies a world from the main checkout's data
  (only read there) into the worktree's, owned by the test administrator; `--world` alone lists them.
- **Secrets and models.** A worktree reads the main checkout's `.env`, `config/genai.json`,
  `config/dev-test-account.json` and `models/` in place when it has none of its own (`checkout.ts`). Never copy them.
- **Packages.** A worktree has no install of its own: its dependencies come from the main checkout's
  `node_modules`, but its own packages are linked into its own `node_modules/@daydream/` (`linkWorkspaces` in
  `checkout.ts`), or it would run main's `packages/shared`. Setup, `npm run dev`, `npm run typecheck` and Vitest do
  it first.
- **Cookies.** The session cookie is named after the server's port when it is not 3000 (`daydream_session_3010`),
  so checkouts on `localhost` do not sign each other out, and passkeys still work there.
- **Data.** A worktree's `data/` is its own: test adventures and worlds may stay there. The server and tools of a
  worktree refuse to use the main checkout's data, and setup runs only in a worktree. Real data (the main
  checkout's, production's) is never touched.

## Working on it

- **Several checkouts.** Worktrees under `.claude/worktrees/` each have their own `data/` and ports (above). Worlds
  built in one checkout are moved to another with `worldpack` (or `npm run setup -- --world` from the main checkout).
- **Accounts in development.**
  - The local test account for automated playtests is in `config/dev-test-account.json` (git-ignored, on this
    machine only). Never commit a password, even a test account's. In a worktree, sign in with `data/dev.json`.
  - Invites (`#/invite/<code>`), passkeys, and the first-administrator rule are described in
    `docs/server-architecture.md`.
  - Passkeys need a real host name or `localhost`, and an automated browser has no authenticator.
- **Browser playtests.**
  - `npm run play -- <command>` plays the game for you in a headless browser and keeps a report of the run
    (docs/playtesting.md); prefer it to driving a browser by hand.
  - The game screen exposes `window.__gd`, the game client: `state`, and `send(message)` with the messages in
    `packages/shared/src/protocol.ts`.
  - Administrators also have developer commands (`DevCommand` in the protocol, and the panel on `` ` ``): level,
    points, gold, items, healing, god mode, spawning and defeating creatures, quests, story stages, the clock,
    going anywhere and reloading. `await window.__gd.dev({ action: 'level', level: 8 })` returns the result.
  - Errors from the server, the worker, and the browser are on the admin Errors page (`log.ts`, `client/src/report.ts`).
  - Screenshots often show the previous frame; take another. While the browser pane is hidden, animation frames
    stop: `window.__gdView` (the renderer) can be stepped by hand with `__gdView.frame(performance.now())`.
  - A test that saves an adventure in real data must delete it afterwards.
- **Model work.**
  - Text, decisions, and speech use OpenAI (Luna, with Sol as the stronger check).
  - Images use ComfyUI behind the GPU broker (`npm run broker` on the GPU PC).
  - The server refuses to start on a provider type or a purpose it does not know.
- **Builds.**
  - A build runs as a job with checkpoints. Restarting the server or worker is safe: jobs resume.
  - A change to server or shared code restarts the worker at its next safe point.
