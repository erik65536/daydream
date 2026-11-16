# Playing together

Daydream is cooperative: friends play one adventure and live through one story. It is not an MMO with separate
stories side by side. This doc describes how an adventure holds several players, what they share, what stays their
own, and how fights, conversations, and absences work.

## The one rule

> An adventure has heroes. In a fight each hero is commanded by its player or fights on its own. At most six are present
> at once.

Everything else follows from it:

- **Solo, a party of four and playing with friends are the same thing.** A player who wants two heroes they command
  and two that fight beside them makes four heroes and lets two fight on their own. A world has no party mode, no
  companions made with it and no lone-wolf bonus; how hard a fight is follows from how many heroes are in its place.
- **A hero belongs to the player who made it.** Only they control it, equip it, spend its points, and choose whether
  it fights on its own. Their heroes share one bag and one purse; each hero has its own equipment.
- **The choice is about fights only.** Out of a fight a player's party always follows their lead. Letting every hero
  fight on their own is auto-battle. The words are in-world ("fights on their own", "you command"); the code calls it
  `ai`.
- **Losing a player is a change of controller.** A dropped connection and a turn timer running out let heroes fight
  on their own for a while.

## Who may play

- Every adventure starts as its creator's. The creator gives other players a place in it, when beginning it or later
  on its page (`#/adventure/<id>`, which is also its link), and can take it away. The adventure then shows in their
  list.
- Nobody owns what is inside: once in, every player is equal. The creator alone sets the difficulty, manages
  permissions and can delete the adventure.
- Anyone with permission can play it whether or not the creator is online.
- A player who loses permission keeps their heroes, saved with the adventure but unplayable until permission is given
  again. Heroes cost little to keep. If they are in the game when it is taken away, their heroes leave at once.
- Administrators may give themselves a place in anyone's adventure (asking for it explicitly, `admin=1`) and then
  join it as themselves.

## Heroes and the roster

- A player makes heroes on the adventure's page, outside the game: as many as they like when the adventure is begun,
  and more later. Choosing which heroes come along (the first leads) and which wait is done there, before joining;
  a hero who waits can be let go for good.
- **Joining checks the cap.** Only present heroes count toward six. Heroes of players who are not playing are away
  and take no place. If joining would make more than six, the player brings fewer, or someone else leaves to
  rotate a hero out.
- A hero made after the adventure began starts at the level of the lowest hero present (level 1 in a new
  adventure). It gets the same starting kit as any new hero, made at that level instead of level 1, and nothing more;
  its upgrade points are spent in the game, as if it had leveled.
- **Catch-up experience:** a hero below the highest level present earns extra experience until it reaches it. This
  serves friends who play less, heroes rotated back in and new heroes alike.

## What is shared and what is one's own

| Shared by the adventure | Each player's own | Each hero's own |
|---|---|---|
| Quests and story progress, the journal, the explored map, known places and waypoints, revelations shown, the quest pouch (key and quest items) | Bag, storage and gold, the heroes they made, chosen hero, hotbar, pinned quest | Equipment, upgrade tree, level, what people remember of them and think of them |

- **People remember heroes, not accounts.** Mara met the tall archer, not a login. A player talks through the hero
  they have chosen; a hero rotated in is a stranger to her.
- **Quest items go in the shared quest pouch**, so a quest never waits on whoever happens to carry the letter. One
  the world put somewhere (in a chest, on a boss) goes into the pouch the moment it is found, before anyone picks
  it up, so a quest never waits on the one player who found it coming back for it either.
- **Loot is per player, rolled per hero.** Each hero who fought rolls for their player: an ordinary creature's loot
  is shared out among the heroes in the fight (packs grow with the party, so a hero's loot from a fight does not), and
  a boss leaves a whole boss's loot for every one of them, so a player with three heroes gets three times what a
  player with one does. A player's rolls make one pile, which only they see and take. Chests are opened by each player
  for themselves, a roll for each of their heroes; a quest's find is everyone's, as its quest is. Giving a friend an
  item is a gift, not a negotiation (the pack's "Give to", for every friend, says what it takes when it cannot yet).
- **Experience comes from fights and quests only**, the content the experience curve is solved from; finding a place,
  reading a note or being trusted with a secret pays in what it leads to, not in experience.
- **Quest rewards** go to every player online when a quest is completed; absent players keep the story progress
  but not the reward.

## Being there and being away

- Heroes may be in different places. A player steers their chosen hero; their other heroes follow it.
- **Following a friend** is a choice (Follow on the friend's row in the party display, which then reads Following and
  stops it when clicked): the party walks after the friend's leader, into other places too, until the player gives
  their own party an order (a move, going to something such as a pile or a person, a skill aimed from afar, a way
  to a friend or a waypoint). A fight only pauses it, so a player away from the keyboard keeps up with their friend.
  Two players cannot follow each other. Following ends when the friend drops out: their heroes then walk after
  someone themselves.
- **Dropping out:** a player's heroes fight on their own and walk after the nearest friend's leader within reach (or
  wait where they are). They leave after a minute, or at the end of the fight they
  are in if another player is in it too. Coming back within the minute changes nothing, and a player's own heroes
  never count against the room when they come back. Leaving on purpose takes the heroes out at once (still not in the
  middle of a fight with another player), and so does changing heroes on the adventure's page while away.
- **Story moments** (an arc's revelation, the ending) play for everyone online at the same moment. A player joining
  for the first time sees the introduction; one returning after the story moved on gets a "Story so far" card
  written by the narration model from the journal (the journal's own lines without one).
- **Finding each other:** every player has a color, shown on their heroes' names and a ring at their feet, with
  arrows at the screen's edge toward friends out of sight. Over the map a friend's hurt hero also shows a Health bar,
  and any hero with statuses shows their icons, wherever a name or bar is drawn.
- **The party display** (top left) shows the player's own heroes as full frames, then a row per friend in the game
  (players who are not playing do not show), in their color: their name and where they are, then their heroes as
  small portraits with a sliver of Health and their worst statuses. Hover, a tap, or the controller's focus ring
  (View) shows a hero's Health and every status with what it does. Whose turn it is glows, the downed are grayed,
  and friends elsewhere or dropped out are dimmed. "Follow" walks after a friend close by; "Join" takes a player to
  a friend in another place when neither is fighting. The roster carries every hero's Health and statuses, so
  friends in other places stay current (it is sent again once a second when something in it changed).

## Fights

- A fight takes in every party whose leader is within 8 m of anyone in it and in sight of them, and the party of
  whoever set it off. A party joins whole: its followers come with it wherever they stand, and never without it.
  Parties further away walk over to join it. Several fights can run at once, in different places or the same one, while the rest of the world goes on in
  real time. A player not in a fight in their place watches it in the world and plays on as usual.
- **Joining a fight under way:** a party whose leader comes within that distance of anyone in it, in sight, joins
  that fight, and its heroes take their place among the turns still to come this round (by initiative), so they act
  this round like everyone else.
- **A retreat takes the whole side.** Any player whose turn it is can flee once one of their acting heroes is clear
  of the enemies (7 m). Every hero in the fight leaves with them, as one player's party would: they fade out and
  appear again together around the one who called it, at the nearest spot out of every creature's reach (preferring
  the way that hero was backing off), and the fallen get up there a moment later. The creatures heal and walk back
  to where they keep. Getting away never depends on how fast anyone moves afterwards.
- **Heroes whose turns come one after another act together**, each player with their own hero; the shared turn ends
  when they have all finished. A player has two minutes, then their heroes still to act fight on their own.
- **While a player aims, their friends see it:** a faint preview of the skill's area or path in the player's color.
- **Experience of a fight is split among the heroes in it**, downed ones too, so each earns what a lone hero would
  against a pack of its own size. Quest experience is not split.
- **Losing applies to the fight, not the party.** When every hero in a fight is down, those heroes wake in the last
  town at once and lose what the world's rules say (the owner's choices when creating it): each player's bag left on
  their remains to fetch, a quarter of their gold, a quarter of each hero's experience toward its next level, or
  nothing; friends elsewhere carry on. Until then friends can come and
  bring the downed back up.
- **Creatures scale to the heroes in their place.** A pack is sized to the heroes in its place when the place goes
  live: the heroes there or arriving, so a party that comes in after another counts too. A pack that was never fought
  is sized again each time the place goes live or another party arrives; one that has fought keeps its size until it
  comes back, so a pack never changes in the middle of a fight. Packs grow, up to about eight creatures, and the
  balance simulation fits the rest of the strength as Health and damage for one to six heroes. Bosses gain Health and
  bring followers of their family. Creatures act with shorter pauses the more of them are alive, so big fights keep
  moving.
- **A level gives the level and its points, nothing else:** no Health back, no statuses lifted and nobody raised,
  in a fight or out of one.
- **Piles do not lie forever.** An ordinary pile (loot not taken, something put down) is gone three game days after
  it was left. A hero's remains stay until they are fetched, and so does anything holding a quest's thing.

## Talking

- **Conversations are scenes.** When a player talks to someone, friends nearby get a small note ("Ann is talking to
  Mara: listen"); a click shows the scene and lets them speak too. Nobody is pulled into one. Whoever speaks makes
  the choices; the person answers the group. Each speaker's AI use is charged to their own budget.
- **Chat:** Enter opens it (Space ends a turn); messages go to the log in the speaker's color and appear over their
  hero.

## Where it lives in the code

| What | Where |
|---|---|
| Who may play, heroes outside the game | `index.ts` (`/api/adventures/:id`, `…/heroes`, `…/party`, `…/members`), `storage.ts` (`adventure_members`), client `screens/AdventurePage.tsx` |
| Joining, the cap, dropping out, following, the roster | `game/adventure.ts` (`join`, `leave`, `goAway`, `followFriends`, `sendRoster`) |
| The shared story, the pouch, rewards | `game/quests.ts`, `Adventure.give` |
| Shared turns, the turn limit, the AI taking over | `game/combat.ts` (`acting`, `aiTakeOver`) |
| Scaling fights, a hero's share of experience | `rules/encounters.ts` (`fitPack`), `rules/bind.ts` (`solveProgression`), `Adventure.grantHeroXp`, `Adventure.rollLootFor` |
| Conversations as scenes | `game/dialogue.ts` |
| Colors, names, arrows, aims, chat | client `render/labels.ts` and `render/overlays.ts`, `ui/hud.tsx` (`SceneInvites`, `ChatLine`) |
| The party display: own heroes and friends | client `ui/party.tsx`, `party.css` |
