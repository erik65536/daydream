/**
 * Quest state machine: start, progress, completion, and story arcs. Quests are the adventure's, shared
 * by everyone in it; rewards go to the players in the game when a quest is completed.
 */
import { Rng, currentWays, type AdventureState, type ItemInstance, type PlayerState, type QuestDef, type QuestObjective, type QuestProgress, type JournalEntry, type Moment, type ToastKind } from '@daydream/shared';
import { isPouchItem, rewardItems } from './loot.ts';
import type { WorldCtx } from './worldctx.ts';

interface QuestHost {
  ctx: WorldCtx;
  rng: Rng;
  /** The adventure, whose story the quests are. */
  readonly story: AdventureState;
  day(): number;
  questDef(id: string): QuestDef | undefined;
  /** Players in the game now: notices and rewards go to them. */
  present(): PlayerState[];
  /** Give a player items (quest and key items go to the shared pouch instead). */
  give(p: PlayerState | null, items: ItemInstance[]): void;
  /** Where quest items may be counted and taken from, in order: the pouch, then the players' bags (`first` before the others). */
  holdings(first?: PlayerState): ItemInstance[][];
  journal(kind: JournalEntry['kind'], text: string): void;
  /** `sound`: the moment it is heard as when not its kind's own (protocol `toast`). */
  toast(text: string, kind?: ToastKind, sound?: Moment | null): void;
  narrate(title: string, text: string, style: 'arc' | 'ending'): void;
  grantXp(p: PlayerState, amount: number): void;
  /** Whether someone is talking with this person now. */
  talkingWith(npcId: string): boolean;
  grantGold(p: PlayerState, amount: number): void;
  changed(): void;
  /** A quest has begun: what it sends the heroes to find, and the foe it sends them to defeat, appear. */
  begun(questId: string): void;
  /** Hook for gossip: quest completed/failed. */
  questEvent(q: QuestDef, kind: 'completed' | 'failed'): void;
}

export class QuestEngine {
  private h: QuestHost;
  constructor(h: QuestHost) {
    this.h = h;
  }

  private get quests() {
    return this.h.story.quests;
  }

  /** Notices held while one event moves several quests: quests sharing a step say it once. */
  private held: Parameters<QuestHost['toast']>[] | null = null;
  private toast(...n: Parameters<QuestHost['toast']>) {
    if (!this.held) this.h.toast(...n);
    else if (!this.held.some((x) => x[0] === n[0])) this.held.push(n);
  }

  /** Reward items for every player in the game (each their own), quest items once into the pouch. */
  private hand(def: QuestDef, specs: string[]) {
    const players = this.h.present();
    let pouchDone = false;
    for (const p of players.length ? players : [null]) {
      const items = rewardItems(this.h.ctx.r, this.h.ctx.uniqueItems, this.h.rng, specs, def.level).filter((it) => !pouchDone || !isPouchItem(this.h.ctx.r, it));
      pouchDone = true;
      this.h.give(p, items);
    }
  }

  /** Begin a quest: `source` is how it began (for its log), `by` the hero who took it up (the shared journal names them). */
  start(questId: string, source?: string, by?: string): boolean {
    const def = this.h.questDef(questId);
    if (!def || this.quests[questId]) return false;
    const prog: QuestProgress = { questId, status: 'active', objectives: {}, log: [{ day: this.h.day(), text: source ?? def.summary }], startedDay: this.h.day() };
    for (const o of def.objectives) prog.objectives[o.id] = { progress: 0, done: false };
    this.quests[questId] = prog;
    const kind = def.main ? 'Story' : this.h.ctx.r.terminology.quest;
    this.h.journal('quest', by ? `${by} took up the ${kind.toLowerCase()} "${def.title}".` : `${kind} started: ${def.title}`);
    this.toast(this.newQuestLine(def), 'quest', 'quest_accept');
    // Objectives may already be met (carrying the item, the foe defeated).
    this.refresh();
    this.h.begun(questId);
    this.h.changed();
    return true;
  }

  /** The line that tells of a quest begun, wherever it is shown. */
  newQuestLine(def: QuestDef): string {
    return `New ${def.main ? 'story ' : ''}${this.h.ctx.r.terminology.quest.toLowerCase()}: ${def.title}`;
  }

  /** Start main quests whose prerequisites are complete. */
  autoStart() {
    for (const def of [...this.h.ctx.world.quests]) {
      if (!def.autoStart || this.quests[def.id]) continue;
      if (def.prerequisites.every((id) => this.quests[id]?.status === 'completed')) this.start(def.id);
    }
  }

  private advanceObjective(questId: string, pred: (o: QuestObjective) => boolean, amount = 1): boolean {
    const def = this.h.questDef(questId);
    const prog = this.quests[questId];
    if (!def || !prog || prog.status !== 'active') return false;
    const ways = currentWays(def, prog);
    let changed = false;
    // Only the ways of the step the quest is on may progress.
    for (const o of ways) {
      if (!pred(o)) continue;
      const st = (prog.objectives[o.id] ??= { progress: 0, done: false });
      if (st.done) continue;
      st.progress += amount;
      const need = o.count ?? 1;
      if (st.progress >= need) {
        st.progress = need;
        st.done = true;
        prog.log.push({ day: this.h.day(), text: `Done: ${o.description}` });
        this.toast(`✔ ${o.description}`, 'quest');
      } else this.toast(`${o.description} (${st.progress}/${need})`, 'quest');
      changed = true;
    }
    if (changed) this.checkComplete(questId);
    return changed;
  }

  private forActive(fn: (questId: string) => boolean): boolean {
    const outer = !this.held;
    if (outer) this.held = [];
    let any = false;
    try {
      for (const id of Object.keys(this.quests)) if (this.quests[id]!.status === 'active' && fn(id)) any = true;
      if (any) {
        this.refresh();
        this.h.changed();
      }
    } finally {
      if (outer) {
        const held = this.held!;
        this.held = null;
        for (const n of held) this.h.toast(...n);
      }
    }
    return any;
  }

  onTalk(npcId: string) {
    return this.forActive((q) => this.advanceObjective(q, (o) => o.type === 'talk' && o.npcId === npcId));
  }

  onKill(info: { familyId: string; bossId?: string; zoneId: string }) {
    return this.forActive((q) =>
      this.advanceObjective(q, (o) =>
        (o.type === 'kill' && o.familyId === info.familyId && (!o.zoneId || o.zoneId === info.zoneId)) ||
        (o.type === 'kill_unique' && !!info.bossId && o.targetId === info.bossId),
      ),
    );
  }

  /**
   * Mark done the steps already met, whenever they come: an item the party holds, a boss or named foe defeated
   * (before its quest, or before the quest came to it). Again while that opens further steps.
   */
  refresh() {
    let more = true;
    while (more) {
      more = false;
      for (const [qid, prog] of Object.entries(this.quests)) {
        if (prog.status !== 'active') continue;
        const def = this.h.questDef(qid);
        if (!def) continue;
        for (const o of currentWays(def, prog)) {
          if (prog.objectives[o.id]?.done) continue;
          const met =
            (o.type === 'kill_unique' && !!o.targetId && this.h.story.defeated.includes(o.targetId)) ||
            (o.type === 'collect' && this.h.holdings().reduce((n, inv) => n + countItems(inv, o), 0) >= (o.count ?? 1));
          if (met && this.advanceObjective(qid, (x) => x === o, (o.count ?? 1) - (prog.objectives[o.id]?.progress ?? 0))) more = true;
        }
      }
    }
  }

  /** Deliver objectives targeting this NPC that the party can satisfy right now (`by` hands over first). Removes the items. */
  tryDeliver(npcId: string, by?: PlayerState): { questId: string; items: ItemInstance[] }[] {
    const out: { questId: string; items: ItemInstance[] }[] = [];
    for (const [qid, prog] of Object.entries(this.quests)) {
      if (prog.status !== 'active') continue;
      const def = this.h.questDef(qid);
      if (!def) continue;
      const o = currentWays(def, prog).find((x) => x.type === 'deliver' && x.npcId === npcId);
      if (!o) continue;
      const holdings = this.h.holdings(by);
      if (holdings.reduce((n, inv) => n + countItems(inv, o), 0) < (o.count ?? 1)) continue;
      let need = o.count ?? 1;
      const taken: ItemInstance[] = [];
      for (const inv of holdings) {
        if (need <= 0) break;
        const got = takeItems(inv, o, need);
        need -= got.reduce((n, i) => n + i.qty, 0);
        taken.push(...got);
      }
      out.push({ questId: qid, items: taken });
      this.advanceObjective(qid, (x) => x === o, o.count ?? 1);
    }
    if (out.length) {
      this.refresh();
      this.h.changed();
    }
    return out;
  }

  /** NPC-driven objective completion (persuasion etc.). */
  completeObjective(questId: string, objectiveId: string): boolean {
    const def = this.h.questDef(questId);
    const prog = this.quests[questId];
    if (!def || !prog || prog.status !== 'active') return false;
    const o = def.objectives.find((x) => x.id === objectiveId);
    if (!o) return false;
    const st = (prog.objectives[o.id] ??= { progress: 0, done: false });
    if (st.done) return false;
    st.done = true;
    st.progress = o.count ?? 1;
    prog.log.push({ day: this.h.day(), text: `Done: ${o.description}` });
    this.toast(`✔ ${o.description}`, 'quest');
    this.checkComplete(questId);
    this.refresh();
    this.h.changed();
    return true;
  }

  private checkComplete(questId: string) {
    const def = this.h.questDef(questId);
    const prog = this.quests[questId];
    if (!def || !prog || prog.status !== 'active') return;
    const ways = currentWays(def, prog);
    if (!ways.length) return this.complete(questId);
    // A step that comes to talking with someone the heroes are talking with already is done there and then.
    const talk = ways.find((o) => o.type === 'talk' && !!o.npcId && !prog.objectives[o.id]?.done && this.h.talkingWith(o.npcId));
    if (talk) this.advanceObjective(questId, (o) => o === talk);
  }

  complete(questId: string, note?: string) {
    const def = this.h.questDef(questId);
    const prog = this.quests[questId];
    if (!def || !prog || prog.status !== 'active') return;
    const story = this.h.story;
    prog.status = 'completed';
    prog.log.push({ day: this.h.day(), text: note ?? 'Completed.' });
    // Rewards for those in the game now; the story moves on for everyone.
    this.hand(def, def.rewards.items);
    const gold = def.rewards.gold;
    for (const p of this.h.present()) {
      p.stats.questsCompleted++;
      this.h.grantGold(p, gold);
      this.h.grantXp(p, def.rewards.xp);
    }
    this.h.journal('quest', `Completed: ${def.title}`);
    this.toast(`${this.h.ctx.r.terminology.quest} complete: ${def.title} (+${def.rewards.xp} ${this.h.ctx.r.terminology.xp}, +${gold} ${this.h.ctx.r.terminology.currency})`, 'good', 'quest_complete');
    this.h.questEvent(def, 'completed');
    // Arc revelations and ending (the last arc's words are the ending's).
    if (def.main && def.arcIndex !== undefined && questId !== this.h.ctx.world.finalQuestId) {
      const arc = this.h.ctx.world.arcs[def.arcIndex];
      if (arc && arc.questIds.every((id) => this.quests[id]?.status === 'completed') && !story.revealedArcs.includes(arc.index)) {
        story.revealedArcs.push(arc.index);
        this.h.narrate(arc.title, arc.revelation, 'arc');
        this.h.journal('story', `${arc.title}: ${arc.revelation}`);
      }
    }
    if (questId === this.h.ctx.world.finalQuestId) {
      story.completedGame = true;
      this.h.narrate('The End', this.h.ctx.world.ending, 'ending');
      this.h.journal('story', 'The main story is complete. The world remains open to explore.');
    }
    this.autoStart();
    this.h.changed();
  }

  /** A quest fails (nothing in play fails one today; the developer commands can). */
  fail(questId: string, reason: string) {
    const def = this.h.questDef(questId);
    const prog = this.quests[questId];
    if (!def || !prog || prog.status !== 'active') return;
    if (def.main) {
      // The story never fails: the setback is noted and the quest goes on.
      prog.log.push({ day: this.h.day(), text: `Setback: ${reason}` });
      this.toast(`Setback: ${reason}`, 'bad', 'quest_failed');
      return;
    }
    prog.status = 'failed';
    prog.log.push({ day: this.h.day(), text: `Failed: ${reason}` });
    this.h.journal('quest', `Failed: ${def.title} — ${reason}`);
    this.toast(`${this.h.ctx.r.terminology.quest} failed: ${def.title}`, 'bad', 'quest_failed');
    this.h.questEvent(def, 'failed');
    this.h.changed();
  }

  /** Give up a side quest under way. It is forgotten, so the one who gave it can be asked for it again. */
  abandon(questId: string) {
    const def = this.h.questDef(questId);
    if (!def || def.main || this.quests[questId]?.status !== 'active') return;
    delete this.quests[questId];
    for (const p of Object.values(this.h.story.players)) if (p.pinnedQuestId === questId) p.pinnedQuestId = undefined;
    this.h.journal('quest', `Abandoned: ${def.title}`);
    this.toast(`${this.h.ctx.r.terminology.quest} abandoned: ${def.title}`, 'info');
    this.h.changed();
  }
}

function countItems(inv: ItemInstance[], o: QuestObjective): number {
  return inv.filter((i) => !!o.itemUniqueId && i.uniqueId === o.itemUniqueId).reduce((s, i) => s + i.qty, 0);
}

function takeItems(inv: ItemInstance[], o: QuestObjective, n: number): ItemInstance[] {
  const out: ItemInstance[] = [];
  for (let i = inv.length - 1; i >= 0 && n > 0; i--) {
    const it = inv[i]!;
    if (!o.itemUniqueId || it.uniqueId !== o.itemUniqueId) continue;
    if (it.qty > n) {
      it.qty -= n;
      out.push({ ...it, qty: n });
      n = 0;
    } else {
      inv.splice(i, 1);
      out.push(it);
      n -= it.qty;
    }
  }
  return out;
}
