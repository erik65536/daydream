# Server architecture: accounts, jobs, and model access

The game server answers players; long work (building a world, painting it, writing or rebalancing its rules, animating it)
runs as **jobs** that survive restarts; every model call goes through one **gateway**, and every piece of GPU work
through the **GPU broker** (docs/gpu-broker.md). This keeps the server responsive and lets development continue
while worlds are being built.

## Accounts

- Invite only: there is no sign-up. An administrator creates an account on the **Users** page (or with
  `npm run users -w @daydream/server -- invite <name>`) with a name saying who it is for and a monthly AI budget
  ($10 by default). An invite is never an administrator; an account is made one after it is set up. That gives
  an invite link (`#/invite/<code>`) which works for 5 days; administrators can see it until it is used and make
  a new one.
- An account is **invited** until its player opens the link, picks a user name (fixed once chosen) and a name
  others see, and sets a password, a passkey, or both. It is then **active**; administrators can disable it.
- The rules for these live in one place, `packages/shared/src/accounts.ts`, which the server enforces and the account
  screens explain as you type. A user name is 3 to 24 letters, numbers, dots, dashes, or underscores, compared
  without case; spaces at its ends are dropped and a space inside it is refused with a suggestion, because it is
  typed at every sign-in (the name others see is where spaces belong). A password is 12 to 200 characters. The invite
  screen asks `GET /api/join/<code>/username?name=` whether a user name is free while it is typed.
- Passkeys are WebAuthn (SimpleWebAuthn), bound to the site's host name, so they need the real address (or
  `localhost`), not a raw IP. Each has a name the user chose.
- Users change the name others see, change or remove their password (only while a passkey remains), and add or
  remove passkeys (never the last way to sign in). Changes to how they sign in need their current password or a
  passkey; a new password signs out their other sessions.
- Administrators edit the name, budget, and administrator flag, remove a passkey, disable an account, or reset it:
  invited again with a new link, its password, passkeys, and sessions gone, its user name, worlds, and adventures kept.
  Disabling or resetting an account on the Users page also ends the games it has open (`endGames` in `index.ts`); a
  reset from the console (`users.ts reset`) ends its sessions, and a game already open goes on until it closes.
  At least one active administrator always remains; administrators change their own account on the account page.
- A session is the cookie `daydream_session` (`daydream_session_<port>` on a port other than 3000, so checkouts
  running side by side on `localhost` keep their own: cookies ignore the port). Under `npm run dev` only,
  `GET /api/dev/sign-in?token=<session>` gives a browser the cookie of a session that is already signed in, which is
  how tools sign a browser in with the session `npm run setup` writes to `data/dev.json`; it grants nothing the token
  does not. The database keeps a session by the SHA-256 of its token (`sessionKey` in `storage.ts`), never the token:
  a copy of the database, such as a backup, signs nobody in.
- Every request that changes something (anything but a read under `/api`) must come from the site's own pages: its
  `Origin` is checked the way a game connection's is (`sameOrigin` in `auth.ts`: the page's host is the request's,
  or in development the Vite client's). A request with no `Origin` is not from a browser (console tools, tests) and
  passes; it carries no player's cookie unless it was given one.
- A server without accounts prints an invite link on the console; the first account set up becomes the
  administrator. When locked out, `npm run users -w @daydream/server -- list` and `reset <user name or id>` give a new
  link.
- **Wrong passwords** are counted on the account (`failed_passwords` on `users`, `tryPassword` in `storage.ts`), so a
  restart does not forget them; a right password clears the count.
  - From the 5th in a row, password sign-in waits before taking another: 30 seconds, doubling to 15 minutes.
  - At the 20th the account is blocked: no password is checked until an administrator unlocks it (Users page, More,
    or `users.ts unlock <name>`), which takes about two and a half hours of guessing to reach.
  - A passkey still signs in a blocked account and clears it: a guesser cannot use one, so knowing someone's user
    name is not enough to keep them out. A player without a passkey asks an administrator.
  - The waiting and blocked answers say why, so they show that the account exists; that is the price of telling
    its owner what to do.
  - Separately, an address that keeps failing (sign-ins, invite guesses) waits too (in memory, `accounts.ts`).

Code: `storage.ts` (users, passkeys, sessions), `accounts.ts` (account and sign-in routes, passkey ceremonies),
`auth.ts` (session and admin middleware), `cli/users.ts`, client `screens/Auth.tsx` and `screens/Account.tsx`.

### The administrators' pages

AI models, GPU, Errors, and Users are listed under "Administration" in the account menu, for administrators only
(client `ADMIN_PAGES` in `App.tsx`; anyone else who opens one of their addresses sees the worlds). The server refuses
them on its own: every route under `/api/admin` passes one guard, mounted before any other route (`admin.ts`), so it
answers 401 signed out and 403 to a player wherever the route is defined, and the routes do not repeat the check.
`test/admin.test.ts` checks every such route. Deleting a world (`DELETE /api/worlds/:id`) is outside the prefix and
carries the check itself.

## Worlds and adventures: who may do what

- **Making a world** happens in two steps on the creation page (`creation.ts`, `worldgen/review.ts`). The owner
  describes it; the build's first steps (its concept, its rule systems, and what they read) are written for them to
  review, and they may describe it again or set any rule by hand. Nothing is saved as a world until they create it:
  the review's runs wait in a scratch folder (`data/cache/reviews/`, cleared after a day) and the page holds the
  rest. Creating it moves the runs into the new world and queues its build, which keeps them.

- **Worlds:** every signed-in player sees every world, and can start adventures in the ready ones. (A world has a
  `public` flag, which every build sets and nothing changes; `canSee` in `index.ts` also says what a world that was
  not public would follow, but there is none.) A world still
  being dreamed, or one whose dreaming stopped, shows everyone how far it is (its stages and counts); its build log
  and why it stopped are for its owner and administrators (`GET /api/worlds/:id/job`), who can also resume it. Only
  the owner (or an administrator) asks for a world's missing pictures to be painted.
- **A world's pictures and sounds** (`GET /api/worlds/:id/assets/:file` and `.../sounds/:file`) are served without
  sign-in, on purpose: browsers and caches keep them, and a world's id (ten random hex digits, which signed-in players
  see) is what it takes to ask. Nothing else of a world is served that way. A smaller copy of a picture (`?w=256` or
  `?w=512`), which the server makes on first asking, is for signed-in players only.
- **The world viewer** (`#/world/<id>/view`, client `screens/viewer/`, server `worldview.ts`) is for administrators
  only: everything a world holds, read-only, spoilers and secrets included. Its routes are under `/api/admin/`, so the
  administrators' guard refuses everyone else, the world's owner included (`test/worldviewer.test.ts`):
  - `GET /api/admin/worlds/:id/view`: the world definition as saved, its build records (`worldgen/metrics.ts`) with
    the creation page's estimate for its size, each actor's animation state, the voices made, every line spoken at
    build time with its file, its adventures counted, and any job running on it;
  - `GET /api/admin/worlds/:id/voices/:file` and `.../speech/:file`: a speaker's reference clip and a line spoken at
    build time, to play.

  Its sections are Overview, Build (time, dollars, tokens, pictures, GPU time, and tries by step, model purpose and
  model), Rules (systems, classes as skill trees with their heroes, races, statuses, items, crafting, fight looks and
  the balance report), Story, Places (each map to zoom and pan, with walkable ground and everything placed in it),
  People, Creatures, Pictures, and Sound, with a search over everything. The address names the section, the thing and a
  part of it, so things link to each other and links can be shared. Fields it does not lay out itself are shown
  plainly, so what a world holds is all there as worlds grow. Editing a world is the console tools' work
  (`packages/server/src/cli`: `paintworld`, `animate`, `resettle`, `rules`, `soundworld`, `voiceworld`) and the
  pipeline designer's (`npm run designer`, docs/build-pipeline.md). The Delete button is in the viewer's header too.
- **Deleting a world** is for administrators only, whoever owns it; an owner who is not an administrator cannot
  (`DELETE /api/worlds/:id`, `worlddelete.ts`). On the world's page, whatever state the world is in (being dreamed,
  stopped or ready), an administrator has a Delete button. Its confirmation (`GET /api/admin/worlds/:id/deletion`)
  names the world and its owner, says how many adventures of how many players go with it, who is in the game now and
  which jobs are still running, and needs the world's name typed. Deleting:
  - stops every job of the world (build, rules, painting, animation) as Stop does on the GPU page: its
    ComfyUI prompts are removed or interrupted through the broker, and the delete waits up to 30 s for a running job
    to end (a job that no worker holds any more is ended at once). If one is still running then, nothing is deleted
    and the administrator is asked to try again in a minute;
  - ends the adventures being played in it: their players go back to the worlds, which say that the world was
    deleted, and nothing of those adventures is saved again (`AdventureManager.end`);
  - moves the world's folder and every player's adventures to the trash (`data/trash/<id>/`, `storage.ts`), and
    removes its rows (the world, its adventures and their members, its jobs and their logs) and what the server
    cached of it. The activity log keeps its history;
  - is written to the admin log on the GPU page and to the activity log.

  A deleted world waits in the trash for 30 days; on the **Users** page an administrator restores it, with all its
  adventures, or removes it for good sooner. After that it can still be restored from a nightly backup taken while
  it existed: the backups keep their snapshots (docs/hosting.md, Backups, and Deleted worlds).
- **Adventures** are played together (docs/multiplayer.md). The creator and the players they give a place in it
  (`AdventureState.members`, mirrored in the `adventure_members` table so lists and world visibility need no save
  opened) list it, play it, and make their heroes in it, each as themselves. The creator alone gives and takes places
  and deletes it; anyone else can leave. A player whose place is taken is sent out of the game; their heroes stay
  saved with the adventure.
- **Heroes are made and chosen outside the game**, on the adventure's page: `POST /api/adventures/:id/heroes`, `PUT
  …/party`, `DELETE …/heroes/:heroId`, refused while the player is in the game. Joining checks the room: at most six
  heroes in the game, all players' together (`Adventure.join`).
- **Administrators** can give themselves a place in someone else's adventure, or delete it, but only by asking for it
  explicitly: the request carries `admin=1` (`GET /api/worlds/:id/adventures?admin=1` lists others' adventures,
  `POST /api/adventures/:id/members?admin=1`, `DELETE /api/adventures/:id?admin=1`). On the world page this is a
  folded-away section; joining asks first, and deleting needs the adventure's name typed.

Code: `index.ts` (the `adventures` routes and the socket), `worlddelete.ts`, `storage.ts` (the trash),
`game/manager.ts` (`list`, `edit`, `end`), client `screens/AdventurePage.tsx` and `screens/WorldPage.tsx`
(`OthersAdventures`, `DeleteWorld`).

## Jobs

A job is a row in the shared SQLite database (`jobs/queue.ts`): kind (`world`, `rules`, `art`, `animate`), its
world, owner, parameters, status, progress, the stage checklist, a log (`job_log`) and a **lease**.

```
queued → running ⇄ waiting → done | failed | cancelled
              ↑ lease runs out (worker stopped) → claimed again, resumes
```

- The web server only enqueues and reads progress: a world build (new, or resumed) and the painting of a world's
  missing pictures. One job is active per world at a time; a player who is not an administrator has at most two
  queued or running, the animation that follows a build by itself aside. New rules and a rebalance are queued from
  the console (`cli/rules.ts`).
- A **worker** (`jobs/worker.ts`) claims the most urgent queued job, renews its lease while working, and runs
  it. A worker that dies lets its lease lapse; the job is claimed again and resumes. A worker that finds its lease
  gone (the process stood still past it and another worker took the job) stops its own work on it and writes
  nothing more of it.
- **Checkpoints**: a world build keeps each finished text step as a run in the world's own pipeline store
  (`data/worlds/<id>/draft/pipeline/`, docs/build-pipeline.md) and every step of every place's painting under
  `data/worlds/<id>/draft/places/`. A resumed build keeps them; everything is laid out and painted from the world's
  id, so the resumed world is the same world. Painting saves every image as it is
  approved, so a resumed paint job continues with what is left.
- **Safe points**: asked to restart, a worker sets `yieldRequested`; jobs stop at the next stage boundary,
  zone, or painting round (images already painted are scored and kept), are re-queued, and the worker exits.
- **What a build shows**: its stages, and counts of what it has made (`worldgen/activity.ts`, the job's
  `preview.activity`): steps written and about how many words, places painted and paintings set aside, pictures by
  kind and those painted again, fights simulated, voices and sounds, model calls and GPU minutes. Counts only, never
  a name, place, or quest, so the page of a world being dreamed (`client/screens/Dreaming.tsx`) spoils nothing.
  Administrators can watch that page play a made-up build, sped up, at `#/dreaming` (Dreaming preview in the menu).
- **Cancel** marks the job; it stops at its next check. A job's model calls carry its cancel check (call
  context `cancelled`): a ComfyUI prompt it is waiting on is removed or interrupted,
  and a call still waiting for the GPU gives up its turn. What it finished stays for a later resume.

### Processes

| mode | how | when |
| --- | --- | --- |
| in-process | `npm start` (default) | one machine, simplest |
| separate worker | `DAYDREAM_WORKER=external` on the server, `npm run worker -w @daydream/server` (one or more) | development and production (`deploy/systemd`), and to scale work out |

Either way a worker asked to stop pauses its jobs at their next safe point and queues them again before it exits.

`npm run dev` runs the server under Node's watch mode and the worker separately: a code change restarts the server
at once, and touches `data/.worker-reload`; the worker pauses its jobs at their next safe point, exits with
code 75 and is started again with the new code. Nothing being built is lost.

Several workers may share one database (each claims different jobs). `jobConcurrency` in `config/genai.json`
sets how many jobs one worker runs at once (default 1, for a single local GPU).

### Every quest a build writes can be finished

A quest is only as good as the world around it: the people it names must exist, the creatures it asks for must
live where it sends the player, an item must come from somewhere and not be asked for after it was handed over.
The build makes this true where each thing is made, rather than repairing quests afterwards:

- **The steps cannot name what does not exist.** Every person, place, family, and creature a quest step names is a
  choice from what earlier steps made (an enum of the step's schema), and a fight is only in a wild place or a
  dungeon, so a story cannot send the player to someone or somewhere that is not there.
- **The world is made around the quests** (`pipeline/world.ts`). A family a quest fights lives in the place the
  quest names, a thing to find is in a chest of its own there, and every family of a place gets at least one pack
  there (`worldgen/zones.ts`).
- **A final check** (`worldgen/questcheck.ts`, run after places are furnished and before the world is ready) walks
  every quest as a player would: the place is reachable from the start, earlier quests come first and do not form
  a ring, every item has a source, every person, creature, boss, and feature exists where it is needed, and the
  main story is one chain. It reports to the build log; it does not rewrite quests. `cli/questcheck.ts` runs the
  same check on built worlds, read-only.

## Model gateway

Every call (`genai/service.ts`) carries a priority from its context (`genai/context.ts`): **interactive**
(a player waiting on an NPC: `npc.*`, `narration`), **owner** (an owner waiting on the creation page's review),
**background** (building and painting).

- **The GPU** is the broker's: every ComfyUI prompt carries its urgency (a player waiting, an owner waiting, a build,
  animation) and the broker runs one piece at a time across every installation, unloading one model before the
  next needs the memory. A build's own `GpuQueue` (`worldgen/gpu.ts`) orders that build's work so each place is
  painted and read before the next. An administrator's pause holds work before it is sent to the broker.
- **Back-pressure**: when a provider is busy, rate-limited, overloaded, or unreachable, the call waits and
  retries with backoff instead of failing. Player-facing calls give up after ~12 s (people then answer with
  simple rule-based replies); background work waits up to `waitForModelsMs` (default 30 min) and its job shows
  `waiting` with the reason, then carries on.
- **Lost connections**: every request to OpenAI or the GPU broker goes out through `genai/http.ts`. A kept-alive
  connection that the server closes just as a request reaches it is reset before any answer; that request is sent
  once more at once on a new connection, so neither the player nor the job waits a backoff for it.
- Non-transient errors (bad requests, unparseable output after retries) are tried again a few times; then
  the build stops, to be resumed once the model works.

### Measuring what a build costs

Every job on a world keeps a record with it (`worldgen/metrics.ts`): `data/worlds/<id>/metrics/<job>.json`, with
the job's active time, and its dollars, model calls, tokens, pictures made, GPU time and wait, ComfyUI prompts, step
time and tries (failed, and given up), by step, by model purpose, and by model and tier (standard, flex, or batch).
GPU time is the time the GPU spent on the job's work, not its wait for a turn: a ComfyUI prompt from ComfyUI's own
start and finish timestamps, and a voice session from when the broker gave it the GPU until it was given back. A
finished build's record also says what the world holds (places, tiles, actors, items, sounds, voices), and the
review before the world existed is kept as `metrics/review.json`. The records are small and travel with the world.
`node src/cli/buildrecords.ts <worldId>` prints them beside the estimate for the world's size. The creation page's
estimate (`shared/rules/estimate.ts`) is a world's counts times unit rates, plus a fifth, so it errs high. Until
three builds are recorded the rates are the defaults in that file (measured from the development machine's builds),
and then `measuredRates` takes them from the installation's own records (`GET /api/build-rates`). Animation's time is
from its first run to its last, since most of it is spent waiting on OpenAI's batches.

For a study of one build in detail, the meter (`genai/meter.ts`), when switched on with `DAYDREAM_METER=1` (in `.env`; it is off by default), writes
`data/logs/meter.jsonl`: every paid OpenAI call (model, tier, tokens, dollars), every ComfyUI prompt and voice session (GPU time, the wait for its turn, and for a prompt whether it loaded
its model), every span of a named build step (`atStep`: places' painting, reading, and furnishing, each kind of
art, the balance simulation, animation's briefs, batches, and assembly), every retry chain (gateway, build steps,
map quality checks) and the worker's CPU time. Calls carry their step through the call context, and a build's GPU
queue runs each task in its caller's context. `node scripts/buildcost.mjs <worldId> --out <dir>` sums a build per
step into JSON and CSV, including what the GPU sat waiting on; `node scripts/gpusmi.mjs`, run beside a build, samples
the card's use, heat, and clock for it. `node src/cli/buildquality.ts <worldId> ...` (from `packages/server`) judges
finished places the same way whatever painted them: ground cut off or behind narrow passages, things out of reach,
and Sol's review against one rubric.

## The admin GPU page

`#/gpu` (`client/src/screens/Gpu.tsx`, API `server/src/gpu/admin.ts` under `/api/admin/gpu`, administrators
only) shows and controls everything that uses the GPU. GPU work passes through several layers, and the page is
one view over them rather than another queue:

| layer | where | what the page shows | what it controls |
| --- | --- | --- | --- |
| job queue | `jobs` table | running and waiting jobs (owner, world, priority, step, elapsed, which worker), recent outcomes | cancel / stop, priority, move up or down |
| build GPU queue | in memory, per build (`worldgen/gpu.ts`) | each build's running and pending GPU tasks | — |
| GPU broker | its `/broker/queue` | every installation's work, running and waiting, the model it has loaded | — |
| pauses | `gpu_control`, read by every process | — | pause all GPU work (it waits before it is sent), or animation jobs alone (none starts) |
| ComfyUI | its HTTP API, through the broker | running and pending prompts by origin, recent failures, prompts, and images per hour | remove / interrupt a prompt |
| GPU | `nvidia-smi`, else ComfyUI `/system_stats` | VRAM in use, utilization | — |
| animation | the `animate` job, per-actor files | actors waiting and failed (with the error) per world | retry a failed actor |

The schedulers live in memory, and in development the worker and CLI runs are separate processes, so the web
server cannot see them directly. Each process therefore publishes its **presence** (`gpu/presence.ts`): a
`gpu_procs` row with its role (`server`, `worker`, `cli` + script and arguments), the GPU calls queued and
its builds' GPU queues and the jobs it runs, written within a second of a change and
every 5–15 s as a heartbeat (silent for 20 s: shown as gone). Every ComfyUI prompt carries a tag in
`extra_data.daydream` (process, role, job id, world, kind, workflow), so prompts from CLI runs are labeled too.

Controls act through the same shared layers, so they reach the separate worker:

- **Pause** (`gpu_control`): workers claim no new job (or no `animate` job), and work of a paused kind waits
  before its next prompt is sent to the broker, while players' work (rank 0) goes past it. A prompt already sent
  finishes.
- **Stop** a running job: its cancel flag, plus removing or interrupting every ComfyUI prompt tagged with its id.
- **Priority / move**: a queued job's priority, or a swap of priority and queued-at time with its neighbor.
- **ComfyUI prompts** of any origin (CLI runs included) can be removed (pending) or interrupted (running, only
  if it is still the one running).
- CLI runs are outside the job queue: only their ComfyUI prompts can be controlled; they are stopped in their
  terminal.

Destructive actions need `confirm: true` (the page asks first) and every action is written to `gpu_audit` with
the administrator's name, shown as the page's admin log. The page polls every 2 s; reading every actor's
animation files is cached for 15 s.

## Developer commands

Administrators can set up any part of a game without playing up to it: the party's level, upgrade points,
experience, gold, and items; full healing, god mode (no damage) and peace (creatures leave the party alone);
spawning creature families and bosses at any level, defeating them, bringing a place's creatures back; starting,
advancing, completing, failing, or resetting any quest, and jumping to any stage of the main story; the clock;
going to any place, revealing the map, and reloading the world from disk.

- Each is a `dev` message (`DevCommand` in `packages/shared/src/protocol.ts`). The server checks on every message
  that the account is an administrator now and answers with a `dev_result`: whether it worked, a line saying what
  happened, and the quests, bosses, and toggles for the panel.
- In a game, `` ` `` opens the panel (`client/src/ui/dev.tsx`); Ctrl+click teleports.
- Scripts and automated browser tests use the same commands: `await window.__gd.dev({ action: 'level', level: 8 })`
  resolves with the result.
- `adventure.ts` runs them (`devCommand`); `test/devtools.test.ts` covers each one.

## Logs, errors, and usage

`log.ts` is the one place the server and worker write what happened:

- `log` and `warn` write a line per event: JSON in production (journald keeps it), a readable line in development.
  What matters is logged, not every request (docs/hosting.md lists it). Values under secret-looking names and
  anything shaped like an API key or bearer token are hidden.
- `reportError` logs an error and keeps it in the `errors` table, counted by kind (source, message with numbers
  and ids ignored, and the first stack frame). It records where it happened: a route; a game message with the
  place, the position, and the party; a combat turn; a job and its step; and always the code's commit. Errors from
  players' browsers come through `POST /api/errors` (signed in, ten a minute at most) from `client/src/report.ts`,
  with the page, the game spot, the player's last actions, and the version of the code the page runs (kept beside
  the server's own, so an error from a tab left open is not taken for the new code's); a built client's stack is mapped back to the source
  (`sourcemap.ts`, hidden source maps the client build writes and the server does not serve).
- The **Errors** page (`/api/admin/errors`) shows them and the server's hourly numbers.
- `seenFrom` keeps each account's addresses (`user_addresses`), and `activity` its sign-ins, worlds, adventures
  and play sessions (`activity`), for questions later such as a shared account or how much a world was played.
  `users.ts ips` and `users.ts activity` read them.
- What grows is bounded: errors after 30 days, addresses after a year, activity after two, the model-call logs
  by size (`logfile.ts`), and a job's log a week after it ended. Job rows and the GPU page's admin log are kept as
  history (a row per job or action). Backups are `cli/backup.ts` (docs/hosting.md).
- A request that was itself wrong (a body that is not JSON or too large) is answered 400 or 413 and is not an
  error of the server's: it is neither reported nor kept.

## Models and providers

The server decides which model serves each purpose (`config/genai.json`: `providers` and `purposes`); players
do not choose and there are no per-user keys. Every text, decision, and speech purpose runs on OpenAI (Luna, with
Sol as the stronger check where a purpose asks for it); every image on ComfyUI behind the GPU broker. The
gateway's waiting and retries apply to every provider, `concurrency` per provider limits parallel calls, and paid
calls are charged to the user they are for, within each account's monthly budget and the server's daily
ceiling (`spending`).

## Growing further

- Many machines: move the queue and leases from SQLite to Postgres (or Redis), and world folders and art to
  object storage; workers then run anywhere.
- Running adventures still live in the web server process; a separate game runtime with snapshotting would let
  the web tier restart without disconnecting players.
- Per-purpose budgets and cost estimates before large hosted-image runs.
