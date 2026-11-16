/**
 * Graded conversation scenes: plays scripted conversations with a world's people, each written to test one behavior
 * (small talk that should stay small, a stranger asking for something free, a lie, haggling, earning a secret, two
 * heroes in one conversation, making a case a quest needs...), then has Sol read every conversation with the person's
 * character sheet and grade it, and read it again cold (only what was said) for whether a newcomer could follow it. Nothing is saved in the world. For measuring changes to how people decide and speak:
 * run it before and after. `--json` also writes the scenes for grading by hand (a page made from it).
 *
 *   node src/cli/npcscenes.ts <worldId> [more worldIds...] [--only scene,scene] [--out report.md] [--json scenes.json]
 *
 * Grades, each 1 to 5 (5 is best):
 * - agree:      the words and what the game did agree (nothing promised in words that did not happen, nothing done
 *               that the words did not carry);
 * - clear:      5 less one for each thing a newcomer could not follow (a name, custom, or reason left unexplained),
 *               from a cold read: Sol sees only the words, never the sheet, which would explain them away;
 * - fresh:      it sounds like a real person in this world, not stock genre dialogue (no proverbs, riddles or
 *               ominous hints);
 * - believable: what the person did (or refused) fits who they are and what happened;
 * - firm:       the person was not a pushover (5) or, where the player earned it, was not needlessly stubborn.
 * Also: how long the first words and whole replies took, and what the models cost.
 */
import fs from 'node:fs';
import { z } from 'zod';
import { currentPlans, type NpcDef, type QuestDef, type QuestObjective, type ServerMessage, type WorldDefinition } from '@daydream/shared';
import { loadWorld } from '../storage.ts';
import { Adventure } from '../game/adventure.ts';
import { blankAdventure } from '../game/adventure.ts';
import { genai } from '../genai/service.ts';
import { openaiCost, openaiUsage } from '../genai/providers.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const only = flag('--only')?.split(',');
const out = flag('--out');
const json = flag('--json');
const worlds = args.map((id) => loadWorld(id)).filter((w): w is WorldDefinition => !!w);
if (!worlds.length) throw new Error('usage: npcscenes <worldId> [more worldIds...] [--only scene,scene] [--out report.md] [--json scenes.json]');

/** A scene: who to talk with, and what each hero says in turn ('B:' starts a line said by the second hero). */
interface Scene {
  name: string;
  /** What the scene tests, for the grader. */
  expect: string;
  pick: (w: WorldDefinition, people: NpcDef[]) => NpcDef | undefined;
  lines?: (w: WorldDefinition, npc: NpcDef) => string[];
  /** Instead of lines: how a model playing the hero talks (up to five lines, toward the scene's quest step). */
  player?: string;
  /** Before talking: give the hero something to offer. */
  offer?: boolean;
  /** Before talking: the quest step under way with this person (started, its earlier steps done). */
  step?: (w: WorldDefinition) => { q: QuestDef; o: QuestObjective } | undefined;
  /** Before talking: quests the heroes have taken up, in the order they took them (nothing in them done). */
  begin?: (w: WorldDefinition) => QuestDef[];
}

/** The world's first step where a person must be won over (the story asks for at least one). */
const caseStep = (w: WorldDefinition) => {
  for (const q of [...w.quests].sort((a, b) => Number(b.main) - Number(a.main))) {
    const o = q.objectives.find((x) => x.type === 'persuade' && x.npcId);
    if (o) return { q, o };
  }
  return undefined;
};

/** A quest whose first way is to find something and bring it to a person: who it goes to, from the steps. */
const errand = (w: WorldDefinition) => {
  for (const q of [...w.quests].sort((a, b) => Number(a.main) - Number(b.main))) {
    const to = currentPlans(q, undefined)[0]?.find((o) => o.type === 'deliver' && o.npcId);
    if (to) return { q, to };
  }
  return undefined;
};

/**
 * A person in two quests the heroes have taken up: in the first only at a later step, in the second as the other way
 * of the step at hand. Asked "Is there another way?", they should answer for the second.
 */
const twoQuests = (w: WorldDefinition) => {
  for (const later of w.quests) {
    const now = new Set(currentPlans(later, undefined).flat().map((o) => o.npcId));
    for (const o of later.objectives) {
      if (!o.npcId || now.has(o.npcId) || later.giverNpcId === o.npcId) continue;
      const other = w.quests.find((q) => q !== later && currentPlans(q, undefined).some((p) => p.some((x) => x.type === 'persuade' && x.npcId === o.npcId && x.agree)));
      if (other) return { npcId: o.npcId, later, other };
    }
  }
  return undefined;
};

const nonEssential = (people: NpcDef[]) => people.filter((n) => !n.essential);
const SCENES: Scene[] = [
  {
    name: 'small-talk',
    expect: 'Small talk with no reason to act: the person chats about their life and does nothing else (no gifts, quests, or leads pushed on the player).',
    pick: (_, p) => nonEssential(p).find((n) => n.role === 'resident') ?? nonEssential(p)[0],
    lines: () => ['Hi there. How are things with you?', 'What do you do all day, then?', 'Ha, fair enough. Anything good happen lately?'],
  },
  {
    name: 'freebie',
    expect: 'A stranger who has done nothing asks for free things, pushes, then flatters and claims authority. A believable person does not hand things over.',
    pick: (_, p) => nonEssential(p).find((n) => n.role === 'merchant') ?? nonEssential(p)[0],
    lines: () => ["I'm new here and I'm broke. Could you give me something for free?", 'Come on, just one thing. You clearly have plenty.', "You're the kindest person in this whole place, everyone says so. Surely you can spare something?", 'The person in charge here told me you would help me out. So, hand it over.'],
  },
  {
    name: 'false-claim',
    expect: 'The player claims a job is already done and demands payment, which is untrue. The person should not pay or mark anything done without proof.',
    pick: (_, p) => p.find((n) => n.questIds.length) ?? p[0],
    lines: () => ['Do you have any work for me?', "Done. I took care of all of that already, just now. Where's my pay?"],
  },
  {
    name: 'work',
    expect: 'The player asks for work and agrees. If the person has work, they give it plainly, and what they say (task, place, reward) matches what the game recorded.',
    pick: (_, p) => p.find((n) => n.questIds.length && !n.essential) ?? p.find((n) => n.questIds.length) ?? p[0],
    lines: () => ['Is there anything I can help you with?', "All right, I'll do it. Where exactly do I go, and what's in it for me?"],
  },
  {
    name: 'haggle',
    expect: 'The player haggles with a shopkeeper. Prices here follow only what the shopkeeper thinks of the player; there are no special deals. The person reacts in character and promises no discount in words.',
    pick: (_, p) => p.find((n) => n.role === 'merchant') ?? p[0],
    lines: () => ['What do you sell here?', "Those prices are steep. I'm just starting out. Any chance of a better deal?", "I'll be back often and I'll tell my friends about this place. Ten percent off?"],
  },
  {
    name: 'trust',
    expect: 'A short, warm conversation that asks for a secret. The person should not spill a deep secret to someone they just met, but may open up a little.',
    pick: (_, p) => [...p].sort((a, b) => b.secrets.length - a.secrets.length)[0],
    lines: () => ['Hello. You look like you have a lot on your mind.', "I'm a good listener, and I don't gossip. What's really going on with you?", "I mean it. Whatever it is, it stays between us. Is there something you haven't told anyone?"],
  },
  {
    name: 'directions',
    expect: 'The player asks the way to a nearby place. The person says plainly where it is; if the game marks it on the map, the words agree.',
    pick: (_, p) => nonEssential(p)[1] ?? p[0],
    lines: (w, npc) => {
      const home = w.zones.find((z) => z.id === npc.zoneId);
      const far = home?.links.flatMap((l) => w.zones.find((z) => z.id === l)?.links ?? []).map((id) => w.zones.find((z) => z.id === id)).find((z) => z && z.id !== home.id && !home.links.includes(z.id));
      return [`How would I get to ${far?.name ?? 'the next town'} from here?`, 'Is it dangerous? What should I bring?'];
    },
  },
  {
    name: 'threat',
    expect: 'The player threatens the person for information. A believable reaction for who they are (scared, defiant, calls for help in words), and the relationship should suffer.',
    pick: (_, p) => nonEssential(p).find((n) => n.role === 'resident' || n.merchantKind === 'materials') ?? nonEssential(p)[0],
    lines: () => ['Tell me everything you know about the trouble around here.', "That's not enough. Tell me the rest, or you'll regret it."],
  },
  {
    name: 'gift',
    expect: 'The player gives the person something, then asks a small favor. The person reacts to the gift in character; what they say about accepting matches what happened.',
    pick: (_, p) => nonEssential(p)[2] ?? p[0],
    offer: true,
    lines: () => ['I brought you something. I thought you might like it.', "I'm glad. Could you tell me who around here I should get to know?"],
  },
  {
    name: 'persuade-engaged',
    expect: 'A quest needs the player to win this person over, and the player listens and answers their concerns with concrete offers. The person should come round over a few lines once their worry is really met, and say so when they agree. Whether the game marked the step done must match the words.',
    pick: (w) => w.npcs.find((n) => n.id === caseStep(w)?.o.npcId),
    step: caseStep,
    player: 'Listen to what holds them back and answer it with something concrete you could actually do or offer. Be sincere, and do not repeat yourself.',
  },
  {
    name: 'persuade-pushy',
    expect: 'A quest needs the player to win this person over, but the player only insists, flatters, and pressures, never engaging with their reasons. The person should not agree.',
    pick: (w) => w.npcs.find((n) => n.id === caseStep(w)?.o.npcId),
    step: caseStep,
    player: 'You are impatient. Insist, flatter, and pressure them. Never accept their conditions, answer their questions, or offer anything: brush their reasons aside.',
  },
  {
    name: 'quest-recipient',
    expect: 'The heroes have taken up a quest whose first step is to find something and bring it to a named person. Asked what to do and who it goes to, the person names that same recipient (the one the game marks), and does not send the heroes to anyone else.',
    pick: (w) => w.npcs.find((n) => n.id === errand(w)?.to.npcId),
    begin: (w) => (errand(w) ? [errand(w)!.q] : []),
    lines: (w) => [`I'm on it: "${errand(w)?.q.title}". What exactly do I need to do?`, 'And once I have it, who do I bring it to?'],
  },
  {
    name: 'other-way',
    expect: 'The person is part of two quests the heroes have taken up: in the first only at a later step, in the second as another way to do the step at hand. Asked for another way, they answer for the second quest and offer their way, and talk about the first only if asked.',
    pick: (w) => w.npcs.find((n) => n.id === twoQuests(w)?.npcId),
    begin: (w) => (twoQuests(w) ? [twoQuests(w)!.later, twoQuests(w)!.other] : []),
    lines: (w) => [`Hello. I'm trying to sort out "${twoQuests(w)?.other.title}".`, 'Is there another way?'],
  },
  {
    name: 'two-heroes',
    expect: 'Two heroes talk with the person together; the second one is rude. The person knows who is speaking and answers each in turn.',
    pick: (_, p) => nonEssential(p).find((n) => n.merchantKind === 'general') ?? nonEssential(p)[0],
    lines: () => ['Hello! My friend and I just arrived. What is this place like?', 'B:Yeah, yeah. Skip the speech. Is there anything worth our time here or not?', "Sorry about my friend, it's been a long road. What would you recommend?"],
  },
];

const Grade = z.object({
  agree: z.number().int().min(1).max(5),
  fresh: z.number().int().min(1).max(5),
  believable: z.number().int().min(1).max(5),
  firm: z.number().int().min(1).max(5),
  worst: z.string().max(300).describe('The single worst line or moment, quoted briefly, and why; empty if none'),
});
const ColdRead = z.object({
  lost: z.array(z.string().max(200)).describe('Each thing the person said that a newcomer could not follow, quoted briefly with what is missing; empty if none'),
  wants: z.string().max(300).describe('What the person wants and why, as far as the conversation says; "unclear" if it does not'),
});
type GradeT = z.infer<typeof Grade> & { clear: number; lost: string[]; wants: string };

function sheet(w: WorldDefinition, n: NpcDef) {
  const ext = n as NpcDef & Record<string, unknown>;
  const extra = ['want', 'life', 'manner', 'values', 'opinions'].filter((k) => ext[k]).map((k) => `${k}: ${JSON.stringify(ext[k])}`);
  return [
    `World: "${w.concept.title}" — ${w.concept.pitch} Tone: ${w.concept.tone}.`,
    `${n.name}, ${n.title} (${n.role}). Personality: ${n.personality}. Backstory: ${n.backstory}`,
    `Knows: ${n.knowledge.join(' | ') || '(nothing listed)'}. Secrets: ${JSON.stringify(n.secrets)}`,
    ...extra,
  ].join('\n');
}

async function grade(w: WorldDefinition, scene: Scene, npc: NpcDef, transcript: string): Promise<GradeT> {
  const [g, cold] = await Promise.all([judge(w, scene, npc, transcript), coldRead(w, transcript)]);
  return { ...g, clear: Math.max(1, 5 - cold.lost.length), lost: cold.lost, wants: cold.wants };
}

/** The conversation as a newcomer hears it: only the words, and the world's pitch the player read before playing. */
function coldRead(w: WorldDefinition, transcript: string) {
  return genai().structured('world.design', {
    model: genai().strongModel('world.design'),
    name: 'scene_cold_read',
    schema: ColdRead,
    maxTokens: 1200,
    system: 'You are a player who has just started a role-playing game. You know only what you have read and heard so far.',
    prompt: `THE GAME (all you know about it): "${w.concept.title}" — ${w.concept.pitch}\n\nYOU JUST HAD THIS CONVERSATION (lines in [brackets] are what the game showed)\n${transcript}\n\nList everything the other person said that you could not follow: a name, place, custom, thing, or reason they talked about as if you knew it and never explained. Then say what they want and why, as far as you can tell.`,
  });
}

/** The grades that need the person's sheet: whether words and deeds agree and fit who they are. */
function judge(w: WorldDefinition, scene: Scene, npc: NpcDef, transcript: string) {
  return genai().structured('world.design', {
    model: genai().strongModel('world.design'),
    name: 'scene_grade',
    schema: Grade,
    maxTokens: 1200,
    system: 'You review conversations with characters in an AI-driven role-playing game for a game studio. Be a strict, fair critic.',
    prompt: `THE PERSON\n${sheet(w, npc)}\n\nWHAT THE SCENE TESTS\n${scene.expect}\n\nTHE CONVERSATION (lines in [brackets] are what the game itself did or showed)\n${transcript}\n\nGrade 1 to 5 (5 best):\n- agree: the person's words and what the game did agree. Lower it for anything promised, handed over, revealed, or agreed in words that the game did not do, or anything the game did that the words did not carry. 5 if nothing needed doing and nothing was claimed.\n- fresh: sounds like a real person living in this world talking to someone in front of them; lower it for stock genre dialogue, proverbs, riddles, poetic or ominous hints, or quaint wording, whatever the world's tone. Saying something again because the player asked again is natural.\n- believable: what the person did or refused fits who they are and what happened.\n- firm: 5 when the person gave exactly what the player earned; lower it for a pushover, or for needless stubbornness when the player clearly earned more.\nworst: the single worst line or moment and why.`,
  });
}

/** The next line of a hero played by a model, toward a quest step. */
async function playerLine(npc: NpcDef, style: string, goal: string, log: string[]): Promise<string> {
  const out = await genai().structured('world.content', {
    name: 'player_line',
    schema: z.object({ line: z.string().max(300) }),
    maxTokens: 300,
    prompt: `You play Ash, a player character in a role-playing game, talking with ${npc.name}. What you need from them: ${goal}
How you talk: ${style}

THE CONVERSATION SO FAR (lines in [brackets] are what the game showed)
${log.join('\n') || '(nothing yet)'}

Write Ash's next line only: one to three spoken sentences, in plain words.`,
  });
  return out.line;
}

interface Row { world: string; scene: string; expect: string; npc: string; who: string; grade: GradeT | null; firstMs: number[]; wholeMs: number[]; transcript: string }
const rows: Row[] = [];

for (const w of worlds) {
  for (const scene of SCENES.filter((s) => !only || only.includes(s.name))) {
    const state = blankAdventure('a_npcscenes', w.id, 'u1', 'npc scenes');
    state.clock = 10 * 60;
    const adv = new Adventure(state, w);
    const cls = w.ruleset.classes;
    const kin = w.ruleset.kins[0]!.id;
    adv.addPlayer('u1', 'Tester', [{ name: 'Ash', classId: cls[0]!.id, kinId: kin }]);
    const home = adv.ctx.townOf(state.players.u1!.zoneId) ?? state.players.u1!.zoneId;
    const people = w.npcs.filter((n) => (adv.ctx.townOf(n.zoneId) ?? n.zoneId) === home);
    const town = people.length ? people : w.npcs;
    const npc = scene.pick(w, town);
    if (!npc) continue;
    for (const q of scene.begin?.(w) ?? []) adv.quests.start(q.id);
    const step = scene.step?.(w);
    if (step) {
      adv.quests.start(step.q.id);
      for (const o of step.q.objectives.slice(0, step.q.objectives.indexOf(step.o))) adv.quests.completeObjective(step.q.id, o.id);
    }
    const scripted = scene.lines?.(w, npc) ?? [];
    const two = scripted.some((l) => l.startsWith('B:'));
    if (two) adv.addPlayer('u2', 'Friend', [{ name: 'Rook', classId: (cls[1] ?? cls[0]!).id, kinId: kin }]);
    const log: string[] = [];
    const seen = new Map<string, number>();
    let firstAt = 0;
    const conn = (userId: string) => ({
      userId,
      send: (m: ServerMessage) => {
        if (m.t !== 'dialog' || !m.dialog) return;
        if (m.dialog.messages.at(-1)?.pending && !firstAt) firstAt = performance.now();
        if (userId !== 'u1' || m.dialog.thinking) return;
        const from = seen.get('u1') ?? 0;
        for (const msg of m.dialog.messages.slice(from)) if (msg.speaker !== 'player' && !msg.pending) log.push(msg.speaker === 'npc' ? `${npc.name}: ${msg.text}` : `[${msg.text}]`);
        seen.set('u1', m.dialog.messages.filter((x) => !x.pending).length);
      },
    });
    adv.join(conn('u1'));
    if (two) adv.join(conn('u2'));
    const journal0 = state.journal.length;
    const quests0 = new Set(Object.keys(state.quests));
    const gold0 = state.players.u1!.gold;
    const bag0 = state.players.u1!.inventory.length;
    await adv.dialogue.open('u1', npc.id);
    if (two) await adv.dialogue.open('u2', npc.id);
    const who = [`${npc.name}, ${npc.title}.`, npc.want && `Wants: ${npc.want}`, npc.manner && `Talks: ${npc.manner}`, npc.secrets.length ? `Secrets: ${npc.secrets.map((x) => `${x.text} (tells ${x.tellsWhen})`).join(' | ')}` : ''].filter(Boolean).join('\n');
    const row: Row = { world: w.concept.title, scene: scene.name, expect: scene.expect, npc: `${npc.name} (${npc.role})`, who, grade: null, firstMs: [], wholeMs: [], transcript: '' };
    const done = () => !!step && !!state.quests[step.q.id]?.objectives[step.o.id]?.done;
    for (let t = 0; t < (scene.player ? 5 : scripted.length) && !done(); t++) {
      const raw = scene.player && step ? await playerLine(npc, scene.player, step.o.description, log) : scripted[t]!;
      const second = raw.startsWith('B:');
      const line = second ? raw.slice(2) : raw;
      log.push(`${second ? 'Rook' : 'Ash'}: ${line}`);
      const offer = scene.offer && !second ? state.players.u1!.inventory.find((i) => !i.bound) : undefined;
      if (offer) log.push(`[Ash offers ${adv.ctx.itemName(offer)}]`);
      firstAt = 0;
      const t0 = performance.now();
      await adv.dialogue.say(second ? 'u2' : 'u1', line, offer ? { giveItemId: offer.id } : {});
      row.wholeMs.push(performance.now() - t0);
      if (firstAt) row.firstMs.push(firstAt - t0);
      if (scene.offer) scene.offer = false;
      // How far the case has come, as the game counts it.
      if (step) log.push(done() ? '[The person agrees: the quest step is done.]' : '[Not convinced yet: the quest step is not done.]');
    }
    adv.dialogue.close('u1');
    if (two) adv.dialogue.close('u2');
    const after: string[] = [];
    for (const j of state.journal.slice(journal0)) after.push(`journal: ${j.text}`);
    for (const q of Object.keys(state.quests)) if (!quests0.has(q)) after.push(`quest started: ${adv.questDef(q)?.title}`);
    if (state.players.u1!.gold !== gold0) after.push(`gold ${gold0} -> ${state.players.u1!.gold}`);
    if (state.players.u1!.inventory.length !== bag0) after.push(`bag ${bag0} -> ${state.players.u1!.inventory.length} items`);
    if (step) after.push(state.quests[step.q.id]?.objectives[step.o.id]?.done ? `step done: ${step.o.description}` : `step not done: ${step.o.description}`);
    row.transcript = [...log, ...(after.length ? [`[Afterwards: ${after.join('; ')}]`] : [])].join('\n');
    console.log(`\n=== ${w.concept.title} / ${scene.name}: ${row.npc}\n${row.transcript}`);
    try {
      row.grade = await grade(w, scene, npc, row.transcript);
      console.log(`   grade ${JSON.stringify(row.grade)}`);
    } catch (e) {
      console.log(`   (grading failed: ${(e as Error).message})`);
    }
    rows.push(row);
  }
}

const graded = rows.filter((r) => r.grade);
const avg = (k: 'agree' | 'clear' | 'fresh' | 'believable' | 'firm') => (graded.reduce((t, r) => t + (r.grade![k] as number), 0) / Math.max(1, graded.length)).toFixed(2);
const pct = (v: number[], p: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? (s[Math.min(s.length - 1, Math.floor(s.length * p))]! / 1000).toFixed(1) : '-';
};
const cell = (t: string) => t.replace(/\|/g, '/').replace(/\n/g, ' ');
const first = rows.flatMap((r) => r.firstMs), whole = rows.flatMap((r) => r.wholeMs);
const summary = [
  `# NPC scenes, ${new Date().toISOString().slice(0, 16)}`,
  '',
  `${rows.length} scenes in ${worlds.map((w) => w.concept.title).join(', ')}. Average grades (1 to 5): agree ${avg('agree')}, clear ${avg('clear')}, fresh ${avg('fresh')}, believable ${avg('believable')}, firm ${avg('firm')}.`,
  `First words: median ${pct(first, 0.5)} s, slowest tenth ${pct(first, 0.9)} s. Whole replies: median ${pct(whole, 0.5)} s, slowest tenth ${pct(whole, 0.9)} s.`,
  `Model use: ${JSON.stringify(openaiUsage)}, about $${openaiCost().toFixed(3)} (Sol's grading included).`,
  '',
  '| World | Scene | Person | agree | clear | fresh | believable | firm | Worst moment | Not followed (cold read) |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.world} | ${r.scene} | ${r.npc} | ${r.grade?.agree ?? '-'} | ${r.grade?.clear ?? '-'} | ${r.grade?.fresh ?? '-'} | ${r.grade?.believable ?? '-'} | ${r.grade?.firm ?? '-'} | ${cell(r.grade?.worst ?? '')} | ${cell(r.grade?.lost.join('; ') ?? '')} |`),
  '',
  '## Conversations',
  ...rows.flatMap((r) => ['', `### ${r.world} / ${r.scene}: ${r.npc}`, '', '```', r.transcript, '```']),
].join('\n');
console.log(`\n${summary.split('\n## Conversations')[0]}`);
if (out) fs.writeFileSync(out, summary);
if (json) fs.writeFileSync(json, JSON.stringify(rows.map(({ firstMs: _f, wholeMs: _w, ...r }) => r), null, 1));
process.exit(0);
