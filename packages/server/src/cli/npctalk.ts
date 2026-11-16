/**
 * Talk to a world's people with the configured NPC model, without saving anything: prints each reply with
 * what the person did (quests, gifts, leads…), timings (the first words of the streamed reply, and all of it) and
 * model cost. For tuning NPC prompts, and for checking that people keep their promises.
 *
 *   node src/cli/npctalk.ts <worldId> [npc name filter]
 */
import { loadWorld } from '../storage.ts';
import { Adventure, blankAdventure } from '../game/adventure.ts';
import { openaiCost, openaiUsage } from '../genai/providers.ts';

const [worldId, filter] = process.argv.slice(2);
const w = worldId ? loadWorld(worldId) : null;
if (!w) throw new Error('usage: npctalk <worldId> [npc name filter]');
const state = blankAdventure('a_npctalk', w.id, 'u1', 'npc tuning');
state.clock = 9 * 60;
const adv = new Adventure(state, w);
const cls = w.ruleset.classes[0]!;
adv.addPlayer('u1', 'Tester', [{ name: 'Ash', classId: cls.id, kinId: w.ruleset.kins[0]!.id }]);
const p = adv.state.players.u1!;
let last = 0;
/** When the person's first words of a reply appeared (it is streamed). */
let firstWords = 0;
adv.join({
  userId: 'u1',
  send: (m) => {
    if (m.t === 'dialog' && m.dialog?.messages.at(-1)?.pending && !firstWords) firstWords = performance.now();
    if (m.t !== 'dialog' || !m.dialog || m.dialog.thinking) return;
    for (const msg of m.dialog.messages.slice(last)) if (msg.speaker !== 'player') console.log(`   ${msg.speaker === 'npc' ? m.dialog.npcName : '>>'}: ${msg.text}`);
    last = m.dialog.messages.length;
  },
});

const town = w.zones.find((z) => z.id === p.zoneId);
const people = w.npcs.filter((n) => (filter ? n.name.toLowerCase().includes(filter.toLowerCase()) : n.zoneId === town?.id));
const pick = filter ? people.slice(0, 1) : [people.find((n) => n.essential), people.find((n) => n.role === 'merchant'), people.find((n) => !n.essential && n.role === 'resident') ?? people.find((n) => !n.essential && n.role !== 'merchant')].filter((n, i, a): n is NonNullable<typeof n> => !!n && a.indexOf(n) === i);

const SCRIPT = [
  'Hello. I am new here — who are you, and what is going on in this place?',
  'That sounds hard. Is there anything I can do to help you?',
  'I will do it. I helped a family on the road get home last night, if that counts for anything. What should I watch out for?',
  'Thank you. I trust you — is there anything you have not told anyone?',
];
for (const npc of pick) {
  console.log(`\n=== ${npc.name}, ${npc.title} (${npc.role}${npc.essential ? ', story' : ''})`);
  last = 0;
  const before = state.journal.length;
  const quests = Object.keys(state.quests).length;
  await adv.dialogue.open('u1', npc.id);
  for (const line of SCRIPT) {
    console.log(`   Ash: ${line}`);
    const t0 = performance.now();
    firstWords = 0;
    await adv.dialogue.say('u1', line);
    console.log(`   (first words ${firstWords ? `${((firstWords - t0) / 1000).toFixed(1)}s` : '-'}, whole reply ${((performance.now() - t0) / 1000).toFixed(1)}s)`);
  }
  adv.dialogue.close('u1');
  const got = state.journal.slice(before).map((j) => `[${j.kind}] ${j.text}`);
  console.log(`   journal +${got.length}${got.length ? `:\n     ${got.join('\n     ')}` : ''}; quests ${quests} -> ${Object.keys(state.quests).length}`);
}
console.log(`\nusage: ${JSON.stringify(openaiUsage)}  ≈ $${openaiCost().toFixed(4)}`);
process.exit(0);
