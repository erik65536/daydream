---
name: playtest-daydream
description: Play Daydream (this repository's 2D top-down RPG) through its playtest harness and report bugs and feedback with screenshots. Use when asked to playtest the game, try a feature in the running game, or play with other agents or people in one adventure.
---

# Playtesting Daydream

The game runs locally (`npm run dev`, started by the user). You play it from the repository root with
`npm run play -- <command>`, which drives a signed-in browser for you and prints what your player sees and the path
of a screenshot after every command. Read `docs/playtesting.md` for the whole guide; this is the short version.

1. `npm run play -- start <your agent name>` signs you in, makes an adventure and a hero, and opens the game.
   `--heroes 3` gives you three heroes, and `--heroes Ana:<class>,Bo:<class>` names them and picks their classes by
   name (the world's own classes; an unknown one is refused with the list). A
   second agent joins with `start <name> --join 1 --player 2`, and then passes `--player 2` to every command.
2. `npm run play -- look`, then act: `walk f1`, `use f2`, `talk n1 <your words>`, `say <words>`, `bye`,
   `take all`, `equip <item>`, `ok` (closes story text). Things in sight have short names: n person, m creature,
   f thing, l loot, h hero.
3. Wait for things instead of sleeping. `wait` returns as soon as something needs you and says what it was: your
   turn, a fight starting or ending, a chat message, story text, an answer in a conversation, or a new place.
   `wait turn` or `wait chat` waits for one of those only. It gives up after a minute (two at most); then wait again.
4. Fights:
   - **The fight line.** It tells you whose heroes act now, for example
     `your turn: Ana (h1) 4/6 …; also yours now: Bo (h2) …; sharing the turn: Kit (h3)`.
   - **Acting.** Heroes whose turns come one after another act together, across players. `skill attack m1` acts with
     the first of yours, and `--hero h2` picks another.
   - **Ending your turn.** Each of your acting heroes ends their own with `endturn` or `endturn --hero h2`.
   - **Fleeing.** `flee` calls the retreat for your whole side, once one of your acting heroes is 7 m clear of the
     enemies.
   - **Refusals.** When a move or attack is refused, the answer says why (blocked, out of reach, how far).
   - **Areas.** An area skill is aimed at a point, `skill <skill> x,y`, and catches everyone it covers there (foes
     for one that hurts, allies for one that helps).
   - **Joining and watching.** A hero within 8 m of anyone in a fight, in sight of them, is in it. A fight nearby
     that you are not in shows as "Fight nearby": you walk, talk and loot as usual, and join it by walking up.
5. Look at the screenshots (open the printed path) to judge how the game looks; `look marks` labels things on it. To
   test the interface itself: `ui` numbers the buttons in view, `click <n>` presses one, `scroll down` reaches the
   rest, and `key <key>` sends a shortcut.
6. Playing together: loot is each player's own (every hero who fought rolls for their player; you see and take only
   your piles). Hand a friend something with `give <item> <their name or hero> [--qty …]`, standing near them out
   of a fight.
7. Report as you go: `bug <blocker|major|minor|polish> <what you did, what happened, what you expected>`,
   `feedback <what you felt and why>`, `note <text>`. `chat <message>` reaches the other players; answer them.
8. End with `finish <verdict> --fun <1-5> --clarity <1-5> --looks <1-5> --best <…> --worst <…>`. The report is
   `data/playtests/<run>/report.md`.

Play from what the screen tells you rather than from the source code: confusion is a finding. Use `dev <json>`
(developer commands) only to reach what you cannot reach by playing, and say so in a note. `npm run play -- help
<command>` shows any command in full; the harness refuses options and words it does not know, so read its answer. If
a command cannot reach the driver because your sandbox stops background processes or blocks localhost, ask the user
to run `npm run play -- serve` and to let your terminal reach localhost (docs/playtesting.md, "Each agent's
settings").
