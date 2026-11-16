# Playtesting with AI agents

AI agents (Claude Code, OpenAI Codex, Google Antigravity, or any agent with a terminal or MCP) play Daydream through
a small harness and leave a report with bugs, feedback and screenshots. Several agents, or agents and people, can play
one adventure together and talk in its chat.

## How it works

```
agent ──► npm run play -- <command>  ─┐
agent ──► MCP server (playtest/mcp.ts)┴─► driver (one per checkout) ──► Chrome (headless) ──► the game on localhost
                                            │                            one signed-in page per player
                                            └─► data/playtests/<run>/: log, screenshots, report.md
```

- **The driver** (`packages/server/src/playtest/driver.ts`) is a background process that keeps the computer's own
  Chrome (or Edge) open between commands. It drives the browser over the DevTools protocol with Node's built-in
  WebSocket, so it needs no browser library. Each player has their own browser context, with their own cookies,
  holding one page of the real game. The first command starts the driver. It listens only on 127.0.0.1, and only
  answers requests that carry the token it wrote to `data/playtests/driver.json`.
- **Commands** (`playtest/commands.ts`) act through the game client in the page (`window.__gd`): `walk`, `use`, `talk`,
  `skill` and the rest. Each command waits until the game is quiet: the party has arrived, the person has answered,
  or it is the player's turn in a fight. It then answers with a short text of what the player sees and a screenshot
  (a 1280 by 800 JPEG). For testing the interface itself, `ui` numbers every button on screen, `click` presses one,
  and `key` sends the game's keyboard shortcuts.
- **Short names.** What is in sight gets a short name that lasts as long as the page: `n1` a person, `m1` a creature,
  `f1` a thing in the place (an exit, a chest, a sign), `l1` loot, `h1` a hero. `look marks` draws the short names on
  the screenshot.
- **Fair play.** The text lists only what the player could see: the fog of war hides the rest. The `dev` and `send`
  commands reach under the game, to get to what needs testing quickly.

## Setting up (once per worktree)

The harness needs a git worktree of the repository beside the main checkout (`git worktree add
.claude/worktrees/<name>`). `npm run setup` refuses to run in the main checkout, whose data is real, and `npm run
play` needs the `data/dev.json` that setup writes; so neither works in a plain clone until it has a worktree. The
worktree also needs a built world to play in, copied from the main checkout.

1. In the worktree, run `npm run setup -- --world <id or title>`. This gives the worktree
   its own ports, a test administrator with a signed-in session (in `data/dev.json`), and a world copied from the
   main checkout.
2. Run `npm run dev` in a terminal of your own. Agents' sandboxes stop the background processes they start, so the
   game should not be started by the agent.
3. Optionally run `npm run play -- serve` in another terminal, so the driver also outlives the agent. Add `--show`
   to watch the players' pages in a visible window.

### Bringing a worktree up to date

A playtest worktree can be used again and again. Before a new playtest, bring in the latest code and the world as the
main checkout has it now:

1. In the worktree, `git merge main`. This is a fast-forward when the worktree's branch has no commits of its own.
2. `npm run setup -- --world <id or title>` replaces the worktree's copy of that world with the main checkout's
   (resettled places, new art). The worktree's adventures and earlier reports stay, but adventures started before the
   copy may meet changed places, so start a new one for a clean test.
3. Restart `npm run dev` there, and `npm run play -- stop` so the driver starts again with the new harness.

Signing in never involves a password. Player 1 is the test administrator from `data/dev.json`. Players 2 to 6 are
accounts named `tester2` and up, which the harness makes in the worktree's own database. They are administrators
too, so their agents can use the developer commands. The harness refuses a game whose address is not on this
computer.

People talk through the configured OpenAI model when the worktree has it (a worktree reads the main checkout's
`config/genai.json` and `.env`). Otherwise they answer with the simple rule-based replies. Each answer costs a fraction
of a cent, which is charged to the player's account budget.

### Each agent's settings

- **Claude Code** runs `npm run play -- …` in its shell and reads the screenshot files with its Read tool. Nothing to
  configure.
- **Codex** runs the same commands in its shell and opens a screenshot with its `view_image` tool. Its Windows
  sandbox must let it reach localhost. In `~/.codex/config.toml` (or the project's `.codex/config.toml`), set:

  ```toml
  [sandbox_workspace_write]
  network_access = true
  allow_local_binding = true
  ```

  Codex can use the MCP server instead (screenshots then come back as images):

  ```toml
  [mcp_servers.daydream]
  command = "node"
  args = ["packages/server/src/playtest/mcp.ts", "--player", "1"]
  cwd = "<path to the repository>/.claude/worktrees/<worktree>"
  tool_timeout_sec = 150
  ```

  The longer tool timeout lets `wait` and `endturn` (which waits for the next turn) run their full time; Codex
  otherwise stops a tool after a minute.

- **Antigravity** runs the commands in its terminal; let that terminal reach localhost (or turn its sandbox off for
  the session). For the MCP server, add the same command to `.agents/mcp_config.json` in the workspace:

  ```json
  { "mcpServers": { "daydream": { "command": "node", "args": ["packages/server/src/playtest/mcp.ts", "--player", "1"] } } }
  ```

  Its built-in browser agent can also open the game for a free look. That browser is the user's Chrome, so it has
  to be signed in by hand. The harness is the route for playing and reporting.

Codex and Antigravity both read `AGENTS.md` and the skill in `.agents/skills/playtest-daydream/`, which point here.

## Commands

`npm run play -- help` lists every command, and `npm run play -- help <command>` shows one in full. Options that
work with any command:

- `--player <1-6>` (or `PLAYTEST_PLAYER`): which player to act as. Each agent in a multiplayer test uses its own
  number.
- `--no-shot` / `--shot`: skip the screenshot, or take one.
- `--marks`: label what is in sight on the screenshot.

| Command | What it does |
|---|---|
| `start <agent> [--world …] [--adventure …] [--join <player>] [--heroes 1-4 or Name:class:kin,…] [--menus yes]` | Sign in, make or join an adventure and heroes, open the game, begin a run |
| `look [marks\|all]` | What you see |
| `walk <thing or x,y>` | Walk there |
| `use <thing>` | Use it, as a click does: talk, open, read, take an exit, pick up, attack |
| `talk <person> [words]`, `say <words>`, `bye` | Talk with someone, in your own words |
| `trade`, `buy <item> [qty]`, `sell <item> [qty]` | Trade with the person you are talking with |
| `take [all or item]`, `equip <item> [hero]`, `item <item> [target]`, `bag`, `quests` | Items and quests |
| `give <item> <player or their hero> [--qty …]` | Give another player something from your bag (near them, out of a fight) |
| `skill <skill> [target or x,y] [--hero …]`, `item <item> [target] [--hero …]`, `endturn [--hero …]`, `flee` | Fight (a skill is its id, its name, or its hotbar number; `--hero` picks which of your acting heroes) |
| `ok` | Close the story text on screen |
| `wait [turn\|fight\|chat\|story\|answer\|place] [seconds]` | Wait for something to happen (anything that needs you, by default); returns the moment it does |
| `chat <message>` | Chat with the other players: agents or people in the same adventure |
| `ui`, `click <n or x,y>`, `scroll <down\|up>`, `key <key>`, `type <text>`, `page <#address>` | Use the interface by hand |
| `dev <json>`, `send <json>` | Developer commands and raw protocol messages |
| `bug <blocker\|major\|minor\|polish> <text>`, `feedback <text>`, `note <text>` | Report as you go (with a screenshot) |
| `finish <summary> [--fun 1-5] [--clarity 1-5] [--looks 1-5] [--best …] [--worst …]` | End the run with your verdict |
| `status`, `stop`, `serve` | The driver |

## Waiting, and fights with other players

Never sleep for a fixed time: `wait` returns the moment something happens and says what. Alone it wakes for anything
that needs you: your turn in a fight, a fight beginning or ending, a chat message from another player, story text, an
answer in a conversation, arriving in a new place. `wait turn` wakes only for your turn (or the fight's end), `wait
chat` only for a message, and so on. It gives up after a minute by default (two at most); then wait again. If your
shell or tool stops commands sooner than that, give `wait` fewer seconds than your limit (`wait turn 25`).

Heroes whose turns come one after another act together, across players. The fight line says whose heroes act now:
`your turn: Morgan (h4) 2/6 action points; also yours now: Esk (h2) …; sharing the turn: Kit (h1)`. Commands act
with the first of yours; `--hero h2` acts with another. Each of your acting heroes ends their own turn (`endturn`, or
`endturn --hero h2`), and the turn passes on when everyone sharing it has finished. Distances in a fight are measured
from your hero acting now.

A hero within 8 m of anyone in a fight, in sight of them, is in it: a party walking up to a fight under way joins
it and acts in the same round. A fight in your place that you are not in shows as "Fight nearby": you walk, talk and
loot as usual. Area skills are aimed at a point (`skill <skill> x,y`) and catch everyone the area covers there: foes
for one that hurts, allies for one that helps. `flee` calls the retreat for the whole
side, every player's heroes and the fallen included: it works once one of your acting heroes is 7 m clear of the
enemies, and everyone fades out and gathers beside that hero, out of the creatures' reach. When a move or an attack is
refused, the answer says why (someone in the way, no way there, or how far the nearest place in reach is).

## Multiplayer

Each agent plays as its own player in the same driver: the first agent runs `start codex`, and the second runs
`start gemini --join 1 --player 2`. To join an adventure a person is already playing, the second agent passes
`--adventure <id>` instead (the id is in the address, `#/play/<id>`). Players see each other's messages under
"Since the last command", and `wait` returns as soon as one arrives. A person in the adventure reads and writes the
same messages in the game's chat.

Loot is each player's own: every hero who fought rolls for their player, and a player sees and takes only their own
piles. To hand a friend something, stand near one of their heroes out of a fight and `give <item> <their name or
hero> [--qty …]`; it goes into their bag. Experience comes from fights and quests, and every player in the game gets
a quest's reward.

## Reports

Every run writes `data/playtests/<date>-<time>-<agent>-p<player>/`:

- `report.md`: the verdict, then the bugs (by severity), the feedback and the notes, each with its screenshot and
  where it happened. After those comes every step, folded, with what the agent saw and its screenshot. The file is
  rewritten after every report, so it is there even when a run is abandoned.
- `log.jsonl` and `findings.jsonl`: the same, as data.
- `shots/`: every screenshot.

`data/playtests/index.md` lists every run, newest first, with its counts.

## A prompt to paste into an agent

Fill in the worktree's path and the focus. For a second agent, change the name and add `--join 1 --player 2`.

```text
You are playtesting Daydream, a GenAI-built 2D top-down RPG, as a thoughtful player and game critic. The game is
running locally; the repository is at <worktree path>. Read docs/playtesting.md first (the "Commands" section is
enough to begin).

Play through a terminal: run `npm run play -- start <your name>` from the repository root, then commands such as
`npm run play -- look`, `walk f1`, `talk n2 <your words>`, `use f3`, `skill attack m1`, `endturn`. Every command
prints what you see and the path of a screenshot: open the screenshot (view_image, or your file viewer) whenever how
the game looks matters, and at least every few steps. To test the interface itself, use `ui` then `click <n>`.

Never sleep to wait for something: `npm run play -- wait` returns the moment something needs you (your turn, a
message, story text) and says what. In a fight, the fight line names your heroes acting now; `--hero h2` acts with
another of them, and each ends their own turn.

Play for about an hour of real time as a new player would: follow the main quest, talk to people in your own words,
explore, fight, trade, and try the menus. Focus: <what to test, e.g. "the first quest and the first fight">.

Report as you go, not at the end:
- `npm run play -- bug <blocker|major|minor|polish> <what you did, what happened, what you expected>`
- `npm run play -- feedback <what was fun, dull, confusing, ugly or beautiful, and why>`
- `npm run play -- chat <message>` reaches the other players in the adventure (other agents or the developer); if
  someone writes to you, answer.

Use `dev` commands only to reach something you cannot reach by playing, and say so in a note. Do not read the game's
source to decide what to do: play from what the screen tells you, because confusion is a finding. When you are done,
run `npm run play -- finish <your verdict in a few sentences> --fun <1-5> --clarity <1-5> --looks <1-5> --best <…>
--worst <…>` and reply with the path of the report.
```
