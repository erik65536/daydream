/**
 * Talking with a world's people from the pipeline (the editor's Talk page, the CLI's `chat`), to judge how they speak
 * while their steps are written. It is the game's own conversation (game/dialogue.ts: the judge decides, the code
 * settles it, Luna speaks) in an adventure of the world an example's runs make (world.ts), with one hero of the
 * world's first class and kin. Nothing is saved, and every call is counted against the pipeline's spending cap.
 *
 * Each turn reports what the person said and what it changed: what they now think of the hero and why, quests
 * started, and what went into the journal.
 */
import type { DialogMessage, WorldDefinition } from '@daydream/shared';
import { Adventure, blankAdventure } from '../game/adventure.ts';
import { feeling, personSheet } from '../game/persona.ts';
import { withCallContext } from '../genai/context.ts';
import type { Budget } from './run.ts';

const USER = 'pipeline';

/** A conversation as the editor and the CLI show it. */
export interface ChatView {
  id: string;
  person: { id: string; name: string; title: string; home: string; role: string; story: boolean };
  /** What the speaking model is told about who they are, exactly (the same every turn). */
  sheet: string;
  messages: { speaker: 'hero' | 'person' | 'narrator'; text: string }[];
  /** What they think of the hero (−100 to 100), in words, and why. */
  regard: { value: number; feeling: string; reasons: string[] };
  quests: { title: string; status: string; main: boolean }[];
  journal: string[];
  /** Dollars this conversation has cost. */
  usd: number;
  thinking: boolean;
}

export class Chat {
  private adv: Adventure;
  private messages: DialogMessage[] = [];
  private thinking = false;
  private usd = 0;
  readonly id: string;
  private world: WorldDefinition;
  readonly npcId: string;
  private budget: Budget;

  constructor(id: string, world: WorldDefinition, npcId: string, budget: Budget) {
    this.id = id;
    this.world = world;
    this.npcId = npcId;
    this.budget = budget;
    if (!world.npcs.some((n) => n.id === npcId)) throw new Error(`There is no person "${npcId}" in ${world.concept.title}`);
    const state = blankAdventure(`chat_${id}`, world.id, USER, 'pipeline chat');
    state.clock = 9 * 60;
    this.adv = new Adventure(state, world);
    this.adv.addPlayer(USER, 'Tester', [{ name: 'Ash', classId: world.ruleset.classes[0]!.id, kinId: world.ruleset.kins[0]!.id }]);
    this.adv.join({
      userId: USER,
      send: (m) => {
        if (m.t !== 'dialog' || !m.dialog) return;
        this.messages = m.dialog.messages;
        this.thinking = m.dialog.thinking;
      },
    });
  }

  /** The person greets the hero, as when a player walks up to them. */
  open(): Promise<void> {
    return this.call(() => this.adv.dialogue.open(USER, this.npcId));
  }

  say(text: string): Promise<void> {
    return this.call(() => this.adv.dialogue.say(USER, text));
  }

  private async call(fn: () => Promise<void>) {
    this.budget.check();
    await withCallContext({ priority: 'interactive', step: 'pipeline chat', onUsage: (u) => ((this.usd += u.usd), (this.budget.spent += u.usd)) }, fn);
  }

  /** Ends the conversation and the adventure around it (its clock stops). */
  close() {
    this.adv.dialogue.close(USER);
    this.adv.stop();
  }

  view(): ChatView {
    const w = this.world;
    const def = w.npcs.find((n) => n.id === this.npcId)!;
    const home = w.zones.find((z) => z.id === def.zoneId)?.name ?? '';
    const state = this.adv.state;
    const hero = state.players[USER]!.leaderId;
    const r = state.npcs[this.npcId]?.regard[hero];
    return {
      id: this.id,
      person: { id: def.id, name: def.name, title: def.title, home, role: def.role, story: def.essential },
      sheet: personSheet(w, def, home, (id) => w.npcs.find((n) => n.id === id)?.name),
      messages: this.messages.filter((m) => !m.pending).map((m) => ({ speaker: m.speaker === 'player' ? 'hero' : m.speaker === 'npc' ? 'person' : 'narrator', text: m.text })),
      regard: { value: r?.value ?? 0, feeling: feeling(r?.value ?? 0, r?.reasons.length ?? 0), reasons: r?.reasons ?? [] },
      quests: Object.entries(state.quests).map(([id, q]) => ({ title: w.quests.find((x) => x.id === id)?.title ?? id, status: q.status, main: !!w.quests.find((x) => x.id === id)?.main })),
      journal: state.journal.map((j) => j.text),
      usd: this.usd,
      thinking: this.thinking,
    };
  }
}

/** The people one can talk with in a world, town by town. */
export function people(w: WorldDefinition) {
  return w.zones
    .filter((z) => z.kind === 'town')
    .map((z) => ({ town: z.name, people: w.npcs.filter((n) => n.zoneId === z.id).map((n) => ({ id: n.id, name: n.name, title: n.title, role: n.role, story: n.essential })) }));
}
