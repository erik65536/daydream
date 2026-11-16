# People

This document explains how the people of a world are written when it is built, and how they decide, speak, and remember
when heroes talk to them. The code is in `packages/server/src/worldgen/people.ts` (writing them),
`packages/server/src/game/dialogue.ts` (conversations), `game/persona.ts` (the words the models are given about a
person) and `game/news.ts` (what people have heard).

## What a person is

Every world, whether cozy, grim, absurd, modern, or far-future, is full of people who should feel like they live there.
They should not sound like characters in a game. Each person has:

- **Who they are**, written by the town step and the story: name, title, personality, backstory, appearance and
  voice, and their **role**, what they are for the players who visit (`NPC_ROLES`):
  - **story**: one of the story's people, who gives the main quests;
  - **merchant**: keeps a shop and stays by it, selling one kind of thing (`merchantKind`): supplies for the road,
    weapons, armor, or materials for the workbench where the world has crafting; every town has one of each;
  - **resident**: everyone else, who gives side jobs, directions, news, gifts, and secrets, as anyone may.

  The role is only what the game does with them. Their trade and standing (an innkeeper, a night watchman, a retired
  duchess) are in their title and their life, so a world can have whatever people suit it. An earlier design had
  eight roles (innkeeper, guard, noble, mystic and so on), from before people stopped fighting and before crafting
  moved to the workbench; most of them changed nothing in play.
- **Their inner life**, written by the people step: what they **want** right now (something that could actually
  happen in this world), two or three details of their **life** this week, their **manner** of talking, the behavior
  that wins them over or puts them off (**likes** and **dislikes**), honest **opinions** of a few neighbors, what they
  **know** and would tell anyone, **secrets** with what a visitor would have to do for them to tell (**tellsWhen**),
  a **greeting** for strangers, a "hello again" for someone they like, feel nothing much about, or dislike
  (**returning**), and five or six **barks** they say aloud as someone walks past.

People never fight. Nobody in a town can be attacked, and nobody flees or calls guards. A damaging skill used on a
person ends the conversation and turns the town against the hero. A conversation that has ended (an attack, a
farewell) is over on the server too: nothing more is said or traded in it, and whoever comes to the person next starts
a new one.

## Writing them at build time

The people of one town are written together, in one call (`world.content`), once the world is assembled. Writing
them together keeps their opinions of each other consistent. Waiting for assembly means everyone, every quest and
every place already has a name. The call sees the world's concept and hidden truth, the owner's notes on people and
story, the town and its neighbors, and each resident's role, personality, backstory, story secret, and the quests
they are part of. The prompt asks for real lives instead of game functions, and for plain spoken lines that mean
something. The world's tone should shape what people's lives are like, not how hard they play a part.

One rule runs through every step that writes for the player, and through how people speak: **the player arrives
knowing nothing**. A person, custom, or thing is explained when it first comes up, a want comes with the reason it
matters, and a quest's summary says what is wrong, why it matters to the giver and what they ask. Language models
lean the other way: asked to be vivid, they invent customs, private nouns, and trails of clues, and a reader who has
the whole sheet (another model, or the writer) follows them easily, while a player hears someone talking in code.
Most people are ordinary; an odd one is rare.

Telling the model the player is new was not enough on its own: people still opened with three unexplained names,
stacked a joke into every sentence and used their pet name ("dear") on every line. What fixed it, in any world:

- **A plain-reading rule for everything players read or hear**, in the build's shared system prompt: understood on
  first reading by someone who knows nothing of the world, everyday words, short sentences, one idea each, a name
  only with what it is, and the world shown in what happens rather than in clever wording. Our own prompts are written
  that way too, casually and directly ("Talk like a normal person, not a character in a play. Don't sound like a
  robot, and don't overact."): written formally, they were answered formally.
  Quest summaries became the giver's own words ("My wife is sick, and the medicine she needs is still in our old home
  beneath the market"), where they had been insider shorthand ("an intake patch", "a retention exception").
- **The owner's wish for how people talk replaces the default, and nothing else.** A small step (`ownerStyle`, like
  the one that pulls out the owner's places) writes down how the owner wants people to talk, in their words, or
  nothing. Every step's system prompt and every conversation use it in place of the plain default. Putting the
  owner's whole prompt about people into each conversation made an archaic-speech world speak in style, but would
  have carried everything else in that prompt into every line.
- **Manner is how someone comes across** (calm, blunt, chatty, shy), not a list of habits: a written habit ("dry jokes
  about water", "calls people dear") was played in every line. When speaking, most lines are plain and a habit shows
  now and then; anyone hearing a line once must follow it, with at most one new name a line.
- **Meeting someone**, they say hello and who they are before their trouble, and tell it as to a stranger.
- **Asked for work**, someone the heroes are already helping says what to do next, and someone with nothing to give
  says so plainly and names a neighbor who needs help. Before, both were told only that they gave nothing, and
  answered "I can't send you off just yet" with an invented reason.

The answer's shape names everyone, so nothing has to be matched afterwards. It has one field per resident, keyed by
their exact name, and an opinion can only be of someone from a fixed list: the town, the towns next to it, and the
story's characters (`circle`). Structured output cannot leave anyone out or misspell a name. People who have an
opinion of each other, either way, become friends for news (`relations`). Voices are designed after this step, so
every greeting, "hello again", and bark is spoken once at build time.

## Secrets that tell of a stash

A secret can be worth something in play. The build puts a hidden chest, a stash, in every wild place and dungeon for
each town next to it. When the people of a town are written, a secret may name one of those places (from a fixed list,
like opinions) and the thing put away there ("my brother's old toolbox"); about one person in three keeps such a
secret. Stashes nobody knows of are removed at the end of the build. When the person confides that secret, the place
goes on the world map, the person says where the stash is and that the hero may take it, and from then on the stash
is there, lit like a waypoint, for the players whose heroes heard it; nobody else sees it. It holds better things than
the place's other chests. So winning someone's trust pays off in something to go and find, and quests are untouched.

## A turn of conversation

A hero's line goes through four stages, in this order, so a person's words can never claim something that did not
happen:

1. **The code lists what this person could choose to do.** Talking is always possible. A person can also give a gift
   (only to someone they like, at most every few days, chosen by what they do) and confide a secret they have not yet
   told this hero (never with someone they distrust listening). Those are the things that are theirs to give, and the
   only things a person decides on their own.
2. **The judge reads the moment** (`npc.judge`, an OpenAI decision model). It answers a few questions with
   probabilities: which of those responses fits (asked only when there is more than talk on the list), how the person
   now feels about the hero (hostile to devoted), what the hero is doing (chat, ask, bargain, persuade, claim,
   threaten, insult, flatter, kind, farewell), whether the hero is asking the way, whether the hero is asking for new
   work, which quest under way with this person the hero is asking about (asked only when there is one), and whether
   the hero said something the person would remember for weeks. When a quest needs this person won over, it also
   scores how convinced the person now is; when the hero offers something, it says whether they accept it. The judge
   sees a secret's text and when the person would tell it, so it can tell whether the conversation has come to it. It
   reads whatever the hero did, with words or without: an item or gold offered in silence is weighed like any other.
3. **The code settles it.** Quest work follows rules (below). Otherwise a gift or a secret happens only when the
   judge's probability for it is at least its own minimum: 0.6 for a gift, and for a secret 0.8 from someone who does
   not yet trust the hero (0.55 from someone who does). The code then does it and writes a plain sentence saying
   exactly what was done. One thing happens a turn, besides taking what the hero offered.
4. **Luna speaks** (`npc.decision`, streamed, words first so the voice can start early). Its system prompt is the
   person's sheet: who they are, their inner life, the places around their home, and how to speak. A secret's text
   is never on it. Luna sees a secret only in the turn the code decides the person confides it, and afterwards as
   something already told to those heroes, so the words cannot give one away. The prompt adds the moment, the people
   present and how the person feels about each, what they have heard, what they remember, the work between them and
   the heroes, the conversation so far, and **what the person does this turn**. When the person only talks after
   being asked for something, Luna is told so explicitly, so the words turn the request down instead of promising it.

In the same structured answer as the words, Luna writes what follows from them. Each part is asked for only when the
judge found a reason for it:

- **A lead**, when the hero asked the way: one sentence for the journal, and the place it points to, chosen by name
  (or none) from the places this person would know: their home, the places next to it, and the places of the quests
  they are part of. Only those names are offered, so nobody gives away or marks a far place they have no reason to
  know; someone who knows no place is not asked for a lead. A place the party has not heard of yet appears on the world map ("X is now on
  your map."), the same way the places next to one the party enters do. This is the map's own knowledge of places,
  one entry per place and never a pin, so it cannot pile up. Small talk and "I'm not sure where that is" mark
  nothing, because then no lead is asked for.
- **A reason**, when the person's opinion moved noticeably ("asked after my sister").
- **A memory**, when the hero said something worth remembering: one sentence, the day it is about if any, who the
  person tells (nobody, friends, or everyone), and whether it is an occasion people would gather for.

A turn is whole. Once the code has settled what the person does, all of it happens and the reply is kept in the
conversation's history, whether or not anyone is still there to hear it: a player may walk away, or a fight may begin,
while the words are being written, and a case the person agreed to in those words is still agreed to. Only when
everyone has left before anything was decided does nothing happen.

Someone has been met once they have greeted a hero, whether or not the hero answered: the first greeting is said
once, and every later visit gets a "hello again".

The judge costs about $0.0001 a turn and answers in 0.2 to 1.2 seconds. Without a judge (or when it fails) a plain
reading of the words decides: people only talk, and quest work still follows its rules. Without Luna, stock lines
carry what was decided, one for each kind of outcome (a job given, an offer taken or turned down, nothing to give, a
case not yet won, and so on), so the words never claim a gift that was not given.

## Quest work follows rules

Quests must never wait on a model's mood, so the judge only reads the moment and the code decides:

- **Story work** starts by itself, each story quest when the one before it is done, and begins by going to the person
  who asks: when a hero comes to them, that step is done and they tell of the work. Asked for work while already
  helping, the person says what to do next.
- **Asked about work under way** ("what do I do for the chair?", "who does it go to?", "is there another way?"), the
  person answers for that quest, with its whole remaining way and the other way they know, before anything new is
  offered. Before, asking about one quest counted as asking for work: the person handed out their next side job
  first, and "it" in the hero's next question then meant the new job.
- **A side job** is given to a hero who asks for work, unless the person dislikes them (opinion below -40). Then the
  person says no, which is the price of having been rude to them. Each job is given once: `availableQuests` leaves
  out every quest already started, finished, or failed. A player can abandon a side job that is under way (the journal
  says so); it is then forgotten, and the person can be asked for it again.
- **A case to make** (a persuade step) has two gates. First the judge, reading the whole conversation, says how
  convinced the person now is (not at all, a little, partly, mostly, completely). Below "partly" ("a little" for
  someone fond of the hero, regard 35 or more) they do not agree, and Luna is told so. From there the person decides in their own
  words: Luna's answer carries `agrees` with the speech, and the game marks the step done only when it is true. This
  is the one decision made in the words, because agreeing happens in them. Graded scenes showed why:
  - adding up points per line let a player who only nagged win in four lines, and counted two half-answers as
    agreement;
  - a judge deciding before the reply kept disagreeing with it ("Good, I'll make the invitation plain" with the step
    not done), and telling the person to say what still held them back made them invent new objections.
  With both gates, a player who meets the person's concerns won in two or three lines in every test world, and a
  player who only pressed did not win in five. A hero who engages always gets there, so a story step is never stuck.

## What a person thinks of a hero

Each person keeps a **regard** for each hero: a value from -100 to 100 and up to five short reasons. Every turn it
moves 30% of the way toward the feeling the judge read, but never up by more than 15 points in a turn, so one kind
word does not win anyone over. It can fall by up to 30: trust is lost faster than it is won, and a threat shows. The
models never see the number. They see a feeling ("are wary of them", "are fond of them and trust them") and the
reasons. Regard decides a shopkeeper's prices, gifts, how readily a secret is told and a case is won, whether a side
job is given, and which "hello again" line is spoken. Nothing on screen shows it.

Gold a person accepts buys goodwill, not fondness: a gift is worth one point for every ten gold, twenty at most, and
it lifts their regard up to that level, not by it. A stream of small gifts therefore moves nobody further than one of
them would, and gold does nothing for someone who already thinks that well of the hero. An item given still adds to
regard by its price.

## Memory

The last 40 lines said with each person are kept word for word; older ones are let go. What should last longer is
kept as memories, written in the same answer as the words when the judge finds the hero said something worth
remembering (something personal, a promise, or a deal). A memory can carry a day, and the person brings it up when the
day comes, or the next time they meet after it. It counts as brought up only once the person has said it in their own
words, so a stock greeting on a day without models does not use it up. There is no background summarizing: a person remembers what mattered, not a digest of everything said.

## News

What heroes do is kept once, in the adventure (`AdventureState.news`): a quest finished, a boss defeated, a person
hurt, something told in confidence and passed on. Nobody holds a copy. Who has heard an item is worked out when it
matters, from who saw it, how far it travels (friends, town, or world), how long ago it happened, and the world's
communication level. The person knows who told them ("Wrenna told you", "people in town are talking about it"), and
the day it reached them. What they hear moves their regard once, at the first conversation after it reached them:
news is new from the day it arrives, however long ago it happened. What a person saw themselves moved them when it
happened, so it does not count again as news. A threat is told of once a day, however many lines it took.

## Barks

A person says a bark aloud only now and then: at most once in ten minutes to each player's party, never the same line
twice in a day, and more often to heroes they know. A memory that is due comes first. A party hears at most one bark in
twenty seconds, whoever says it, so a street of people takes turns instead of calling out together. Who said what to
whom is kept by the adventure, not by the person's figure in the place, so it holds when the party comes back after
the town was left empty (before, every figure was made anew then, and the whole town called out at once).

## Measuring

`packages/server/src/cli/npcscenes.ts` plays scripted scenes with chosen people of the given worlds and has Sol grade
each on five counts: whether the words agree with what the game did, whether the reply is clear, fresh (not stock),
believable for this person, and firm (not too easily moved). Clarity comes from a separate cold read: Sol sees only
what was said and the world's pitch, never the person's sheet, and lists everything a newcomer could not follow. A
grader holding the sheet explains every private reference to itself and rates talk in code as clear. It also writes
the transcripts to a page for grading by hand, which remains the judge of how real people sound. Use it on worlds in a
scratch data folder to compare a change against the last report.
