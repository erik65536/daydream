/**
 * Conversations with people. Each turn a person first decides, then speaks:
 * 1. The judge (a decision model, `npc.judge`) reads the moment and answers a few questions with probabilities: whether
 *    the person does more than talk (a gift, a secret confided; most lines call for nothing more), how the person now
 *    feels about the hero, what the hero is doing (asking, haggling, threatening...), whether the hero asks the way or
 *    for work, how convinced they are of a case put to them, and whether the hero said something worth remembering.
 * 2. The code settles it. Quest work follows rules, not moods: story work starts by itself and the one it sends the
 *    hero to tells of it, a side job is given to anyone who asks for work and is not disliked, and a case to be made
 *    (a persuade step) is theirs to decide in their own words once the judge finds them convinced enough to weigh it.
 *    A gift or a secret needs the judge to be clear about it. Opinion (Regard) moves a step toward the judged feeling.
 * 3. Luna speaks (`npc.decision`), told who the person is, what is going on, and what they just decided and did, with
 *    its names, places, and amounts. The words stream to the players and are spoken as they come. In the same answer
 *    Luna writes what follows from the words: where they point the hero (the journal, and the place on the map), why
 *    the person's opinion changed, what they will remember, and whether they agree to a case they were deciding.
 *
 * A player speaks through their leading hero: people remember heroes, and what was said with each person is the
 * adventure's. A conversation is a scene: friends close by may join it to listen and speak, one line at a time; the
 * person knows who is speaking and who is listening. Without models, simple rule-based replies keep people useful and
 * quests finishable.
 *
 * A turn is whole: once the code has settled what the person does, all of it happens and the reply is kept, whether or
 * not anyone is still there to hear it (a player may walk off, or a fight may begin, while the words are written).
 */
import { z } from 'zod';
import {
  currentPlans, currentWays, rx, uid,
  type CharacterState, type DialogMessage, type DialogState, type ItemInstance, type JournalEntry, type Memory, type NewsItem,
  type NpcDef, type NpcRuntime, type ZoneDef, type PlayerState, type QuestDef, type QuestObjective, type AdventureState, type Regard,
} from '@daydream/shared';
import { callContext, withCallContext } from '../genai/context.ts';
import { genai } from '../genai/service.ts';
import { partialString } from '../genai/json.ts';
import { BudgetExceeded } from '../genai/spend.ts';
import { NotConfigured, type DecisionAnswer, type DecisionQuestion } from '../genai/types.ts';
import type { QuestEngine } from './quests.ts';
import type { WorldCtx } from './worldctx.ts';
import { SpokenText, type AdventureVoices } from './voices.ts';
import { heardAbout, type Heard } from './news.ts';
import { FEELINGS, FEELING_VALUES, MOVES, feeling, knownPlaces, personSheet, type Move } from './persona.ts';

/** What a person must agree to for a persuade step: for a clever way around a fight, going ahead with their own plan. */
const caseOf = (o: QuestObjective) => (o.agree ? `going ahead together with the plan you know of: ${o.agree}` : o.description);

type GiftKind = 'supplies' | 'gear' | 'material' | 'keepsake';

interface DialogueHost {
  ctx: WorldCtx;
  quests: QuestEngine;
  /** The adventure: its quests, what was said with each person, and the news. */
  readonly story: AdventureState;
  readonly voices: AdventureVoices;
  day(): number;
  timeOfDay(): string;
  player(userId: string): PlayerState | undefined;
  /** The hero a player speaks through (their leader). */
  speaker(userId: string): CharacterState | undefined;
  /** A short description of a hero as people see them. */
  describe(hero: CharacterState): string;
  npcRt(npcId: string): NpcRuntime | undefined;
  sendDialog(userId: string, d: DialogState | null): void;
  /** Hold these players' notices until the returned release is called. */
  holdNotices(userIds: string[]): () => void;
  openTrade(userId: string, npcId: string): void;
  giveItemsToPlayer(userId: string, items: ItemInstance[]): void;
  takeItemFromPlayer(userId: string, itemId: string): ItemInstance | null;
  /** A place becomes known: it appears on the world map. Returns false if it already was. */
  revealZone(zoneId: string): boolean;
  remember(npcId: string, mem: Memory): void;
  /** Something people may hear about heroes. */
  news(item: Omit<NewsItem, 'id' | 'day'>): void;
  /** A gathering for a hero (`about`: its id). */
  scheduleGathering(npcId: string, about: string, day: number, reason: string): void;
  playerChanged(userId: string): void;
  journal(kind: JournalEntry['kind'], text: string): void;
  /** Something a person can spare, made at the party's level ("within reason": modest rarity). */
  rollGift(userId: string, kind: GiftKind, generous: boolean): ItemInstance | null;
  communication(): 0 | 1 | 2 | 3;
  questDef(id: string): QuestDef | undefined;
  knowsSkill(userId: string, skillId: string): string | null;
  /** Who talks with whom changed (friends nearby hear of it). */
  scenesChanged(): void;
}

/** What a turn answers: what the hero said and did, or (`event`) what brings the person to speak first, on meeting (`first`: for the first time). */
type TurnInput = { text: string; offered?: ItemInstance; gold?: number; skillId?: string; event?: string; first?: boolean };

/** A conversation with one person, shared by the players in it. */
interface Session {
  npcId: string;
  messages: DialogMessage[];
  thinking: boolean;
  /** Over (a farewell, an attack): nothing more is said in it, and whoever comes next starts a new one. */
  ended: boolean;
  members: Set<string>;
}

/** Everything about a turn's moment: the person, who speaks, who listens, and what the person knows of them. */
interface Moment {
  userId: string;
  p: PlayerState;
  hero: CharacterState;
  def: NpcDef;
  rt: NpcRuntime;
  listeners: CharacterState[];
  heard: Heard[];
}

/** A response the code offers the person this turn. */
interface Option {
  id: string;
  /** What it means, for the judge. */
  label: string;
  /** How sure the judge must be for the person to take it. */
  min: number;
  run: () => Outcome;
}

/**
 * What the person does in a turn. An offer taken or turned down gives way to whatever else happens with it; `next`:
 * what to do next for work under way; `nothing`: no work to give; `unwilling`: work they will not give this hero;
 * `refused`: asked for something and only talking; `decides`: a case is theirs to decide in their words;
 * `unconvinced`: a case they are not yet convinced of.
 */
type OutcomeKind = 'talk' | 'accepted' | 'declined' | 'gift' | 'secret' | 'job' | 'next' | 'nothing' | 'unwilling' | 'refused' | 'decides' | 'unconvinced';

/** What a response did: told to Luna in the second person, and shown to the players. */
interface Outcome {
  kind: OutcomeKind;
  did: string;
  shown: string[];
  ends?: boolean;
  /** A case the person decides in their own words this turn: agreeing completes the quest step. */
  decides?: { q: QuestDef; o: QuestObjective };
}

/** What the judge read in a line (all neutral when there is no judge). */
interface Verdict {
  response: string;
  probability: number;
  /** Index into FEELINGS, or null for no change. */
  feeling: number | null;
  move: Move;
  /** Whether the hero said something the person would remember for weeks (only then is a memory written). */
  remember: number;
  /** Whether the hero is asking where to go or whom to see (only then can the words leave a lead in the journal). */
  asksWay: number;
  /** Whether the hero is asking for new work. */
  asksWork: number;
  /** The quest under way, with this person in it, that the hero is asking about (what to do, who it goes to, another way). */
  about: string | null;
  /** How convinced the person now is of a case put to them (index into CONVINCED), when there is one. */
  convinces: number | null;
  accepts: number;
  caught: number;
}

/** Turns kept word for word per person (what lasts beyond them is kept as memories), and shown of a conversation. */
const KEEP_TURNS = 40;
/** Days between gifts from the same person, and the opinion they need of a hero to give one. */
const GIFT_EVERY_DAYS = 3;
const GIFT_AT = 20;
/** Opinion needed to confide a secret without being truly moved to it. */
const CONFIDE_AT = 35;
/** Opinion from which a person is won over a step sooner: a case that convinces them "a little" is theirs to decide. */
const WON_SOONER_AT = 35;
/** The most a gift of gold can lift opinion to. */
const GOLD_LIFTS_TO = 20;
const MAX_REASONS = 5;
/** A change of opinion in one turn that shows: the person's words carry it, and they say why. */
const NOTICEABLE = 6;
/** How convinced someone is of a case put to them, as the conversation stands: from the third (the second, when they are fond of the hero) the choice to agree is theirs. */
const CONVINCED = ['not at all', 'a little', 'partly', 'mostly', 'completely'] as const;
/** Opinion below which a person gives a hero no work. */
const NO_WORK_BELOW = -40;

export class DialogueEngine {
  /** Each player's conversation (players in the same one share it). */
  private sessions = new Map<string, Session>();
  private h: DialogueHost;
  constructor(h: DialogueHost) {
    this.h = h;
  }

  session(userId: string) {
    return this.sessions.get(userId);
  }

  /** The conversations going on (not those that are over), each with the players in it. */
  scenes(): { npcId: string; userIds: string[] }[] {
    return [...new Set(this.sessions.values())].filter((s) => !s.ended).map((s) => ({ npcId: s.npcId, userIds: [...s.members] }));
  }

  private npc(npcId: string): NpcDef | undefined {
    return this.h.ctx.npcs.get(npcId);
  }

  /** What this person thinks of a hero. */
  regard(rt: NpcRuntime, heroId: string): Regard {
    return (rt.regard[heroId] ??= { value: 0, reasons: [] });
  }

  /** Change what a person thinks of a hero, with the reason they would give. */
  shift(rt: NpcRuntime, heroId: string, by: number, reason?: string) {
    const r = this.regard(rt, heroId);
    r.value = Math.max(-100, Math.min(100, Math.round(r.value + by)));
    if (reason && !r.reasons.includes(reason)) r.reasons = [...r.reasons, reason].slice(-MAX_REASONS);
  }

  /** The queue a conversation's lines are spoken in. */
  private static queue(npcId: string) {
    return `dialog:${npcId}`;
  }

  /**
   * A reply that grows as it is written: `show` takes the words so far (they appear in the conversation, and each
   * finished sentence is spoken), `finish` the final words (the rest is spoken; returns them, or '' for none). Each
   * sentence is spoken to whoever is in the conversation then.
   */
  private liveReply(s: Session, def: NpcDef) {
    let msg: DialogMessage | null = null;
    let sentAt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const spoken = new SpokenText(() => this.h.voices.reply(s.npcId, () => [...s.members], DialogueEngine.queue(s.npcId), unvoiced));
    const sendAll = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      sentAt = Date.now();
      for (const m of s.members) this.sendTo(m, s);
    };
    const unvoiced = () => {
      if (!msg || msg.unvoiced) return;
      msg.unvoiced = true;
      sendAll();
    };
    return {
      show: (soFar: string) => {
        const text = sanitizeSpeech(soFar, def.name, true);
        if (!text || !s.members.size) return;
        if (!msg) {
          msg = { speaker: 'npc', text, pending: true, lines: spoken.lines, voiced: this.h.voices.has(s.npcId) || undefined };
          s.messages.push(msg);
        }
        msg.text = text;
        // Everyone sees the words at most a few times a second, and at once when a sentence is finished.
        if (spoken.grow(text) || Date.now() - sentAt > 150) sendAll();
        else timer ??= setTimeout(sendAll, 150);
      },
      shown: () => msg?.text,
      finish: (text: string) => {
        if (timer) clearTimeout(timer);
        if (!text) {
          if (msg) s.messages.splice(s.messages.indexOf(msg), 1);
          return '';
        }
        if (!msg) {
          msg = { speaker: 'npc', text, lines: spoken.lines, voiced: this.h.voices.has(s.npcId) || undefined };
          s.messages.push(msg);
        }
        msg.text = text;
        delete msg.pending;
        spoken.end(text);
        if (!msg.lines!.length) delete msg.lines;
        return text;
      },
    };
  }

  /** Everyone in a conversation sees it as it stands. */
  private send(userId: string) {
    const s = this.sessions.get(userId);
    if (!s) return this.h.sendDialog(userId, null);
    for (const m of s.members) this.sendTo(m, s);
  }

  private sendTo(userId: string, s: Session) {
    if (!this.h.speaker(userId)) return this.h.sendDialog(userId, null);
    const def = this.npc(s.npcId)!;
    this.h.sendDialog(userId, {
      npcId: s.npcId,
      npcName: def.name,
      npcTitle: def.title,
      sprite: def.asset,
      messages: s.messages.slice(-KEEP_TURNS),
      thinking: s.thinking,
      canTrade: sells(def),
      suggestions: this.suggestions(def),
      ended: s.ended,
    });
  }

  /** Whether a player is in a conversation now. */
  talking(userId: string): boolean {
    return this.sessions.has(userId);
  }

  /** A player leaves a conversation (it goes on for the others in it). */
  close(userId: string) {
    const s = this.sessions.get(userId);
    if (!s) return;
    this.sessions.delete(userId);
    this.h.sendDialog(userId, null);
    this.h.voices.leave(userId, { queue: DialogueEngine.queue(s.npcId) });
    s.members.delete(userId);
    if (s.members.size) {
      const hero = this.h.player(userId) && this.h.speaker(userId);
      if (hero) s.messages.push({ speaker: 'narrator', text: `${hero.name} leaves the conversation.` });
      for (const m of s.members) this.sendTo(m, s);
    }
    this.h.scenesChanged();
  }

  /** Keep a turn of what was said with this person (`hero`: who spoke, for player turns). */
  private record(npcId: string, speaker: 'player' | 'npc' | 'narrator', text: string, hero?: CharacterState) {
    const list = (this.h.story.conversations[npcId] ??= []);
    list.push({ speaker, hero: hero?.name, text, day: this.h.day() });
    if (list.length > KEEP_TURNS) list.splice(0, list.length - KEEP_TURNS);
  }

  /** Quests this NPC can give the party now. */
  availableQuests(def: NpcDef): QuestDef[] {
    const quests = this.h.story.quests;
    return def.questIds
      .map((id) => this.h.questDef(id))
      .filter((q): q is QuestDef => !!q && !q.autoStart && !quests[q.id] && q.prerequisites.every((r) => quests[r]?.status === 'completed'));
  }

  /**
   * Active quests where this NPC is the giver or an objective target, with the ways of the step each is on
   * (each way's next objective) and all each way still takes. Those where the person matters now come first: one whose
   * step at hand names them (something they tell, agree to, or receive), then their own requests, then the rest.
   */
  involvedQuests(npcId: string): { def: QuestDef; ways: QuestObjective[]; plans: QuestObjective[][] }[] {
    const out: { def: QuestDef; ways: QuestObjective[]; plans: QuestObjective[][] }[] = [];
    for (const [qid, prog] of Object.entries(this.h.story.quests)) {
      if (prog.status !== 'active') continue;
      const def = this.h.questDef(qid);
      if (!def) continue;
      if (def.giverNpcId === npcId || def.objectives.some((o) => o.npcId === npcId)) out.push({ def, ways: currentWays(def, prog), plans: currentPlans(def, prog) });
    }
    const rank = (q: (typeof out)[number]) => (q.plans.flat().some((o) => o.npcId === npcId) ? 0 : q.def.giverNpcId === npcId ? 1 : 2);
    return out.sort((a, b) => rank(a) - rank(b));
  }

  private suggestions(def: NpcDef): string[] {
    const out: string[] = [];
    if (this.availableQuests(def).length) out.push('Is there anything I can help with?');
    const persuade = this.involvedQuests(def.id).flatMap((q) => q.ways.filter((o) => o.type === 'persuade' && o.npcId === def.id));
    if (persuade[0]) out.push(persuade[0].agree ? 'Is there another way?' : `About ${persuade[0].description.replace(`Persuade ${def.name} to `, '')}...`.slice(0, 80));
    if (sells(def)) out.push('What do you have for sale?');
    out.push(`How are things with you?`);
    out.push('Farewell.');
    return out;
  }

  // ------------------------------------------------------------------ opening

  async open(userId: string, npcId: string): Promise<void> {
    // Whoever's message set it off pays for the greeting; a hero who walked up (on the game's own clock) pays for theirs.
    const paid = callContext();
    if (!paid?.userId) return withCallContext({ ...paid, priority: 'interactive', userId }, () => this.open(userId, npcId));
    const p = this.h.player(userId);
    const hero = this.h.speaker(userId);
    const def = this.npc(npcId);
    const rt = this.h.npcRt(npcId);
    if (!p || !hero || !def || !rt) return;
    if (this.sessions.has(userId)) this.close(userId);
    // Someone is already talking with them: join the conversation (one that is over is theirs to close).
    const going = [...new Set(this.sessions.values())].find((x) => x.npcId === npcId && !x.ended);
    if (going) {
      going.members.add(userId);
      this.sessions.set(userId, going);
      going.messages.push({ speaker: 'narrator', text: `${hero.name} joins the conversation.` });
      this.h.voices.join(userId, DialogueEngine.queue(npcId));
      this.send(userId);
      this.h.scenesChanged();
      return;
    }
    const s: Session = { npcId, messages: [], thinking: false, ended: false, members: new Set([userId]) };
    this.sessions.set(userId, s);
    this.h.voices.prepare(npcId);
    this.h.scenesChanged();
    // A quest asked for on meeting is noticed after the words that ask for it (turn).
    const release = this.h.holdNotices([userId]);
    try {
      await this.greet(userId, s, p, hero, def, rt);
    } finally {
      release();
    }
  }

  private async greet(userId: string, s: Session, p: PlayerState, hero: CharacterState, def: NpcDef, rt: NpcRuntime) {
    const npcId = def.id;
    const history = this.h.story.conversations[npcId] ?? [];
    // Recent history so the conversation feels continuous.
    for (const t of history.slice(-6)) s.messages.push({ speaker: t.speaker, text: t.speaker === 'player' && t.hero && t.hero !== hero.name ? `${t.hero}: ${t.text}` : t.text });
    const events: string[] = [];
    // (Not "has the hero spoken to them": someone greeted who then walks on has been met.)
    const since = rt.lastTalk?.[hero.id];
    const firstMeeting = since === undefined;
    if (this.h.quests.onTalk(npcId)) events.push(`${hero.name} came to see you as part of something you are both involved in.`);
    for (const d of this.h.quests.tryDeliver(npcId, p)) {
      const names = d.items.map((i) => this.h.ctx.itemName(i)).join(', ');
      s.messages.push({ speaker: 'narrator', text: `You hand over ${names}.` });
      this.record(npcId, 'narrator', `${hero.name} handed over ${names}.`);
      events.push(`${hero.name} has just handed you ${names}, which you were waiting for.`);
    }
    // A day remembered has come: it is brought up once, in the person's own words (so it waits for them).
    const today = this.h.day();
    const due = rt.memories.filter((m) => m.about === hero.id && m.dueDay !== undefined && m.dueDay <= today && !m.fulfilled);
    for (const m of due) events.push(`${m.dueDay === today ? 'Today is the day you remembered' : 'The day you remembered has come and gone'}: "${m.text}". Bring it up warmly.`);
    // What has reached the person about this hero since they last talked changes what they think of them, once: news
    // is new from the day it reaches them, however long ago it happened. What they saw themselves moved them then.
    const fresh = heardAbout(this.h.ctx, this.h.story.news, def, rt, [hero.id], today, this.h.communication()).filter((x) => !x.witness && (since === undefined || x.day > since));
    for (const x of fresh) if (x.item.tone !== 'neutral') this.shift(rt, hero.id, x.item.tone === 'good' ? 8 : -10, x.item.text);
    if (fresh.length && since !== undefined) events.push(`Since you last saw ${hero.name} you have heard: ${fresh.slice(-2).map((x) => `${x.item.text} (${x.source})`).join(' ')} Bring it up if it matters to you.`);
    (rt.lastTalk ??= {})[hero.id] = today;
    if (events.length || (firstMeeting && !def.greeting)) {
      // Meeting someone, people say hello and who they are before their trouble, and tell the trouble as to a stranger.
      if (firstMeeting) events.unshift(`${hero.name} comes up to talk with you for the first time: say hello and who you are, then${events.length ? ' what you need, as you would put it to someone who knows nothing of it yet' : ' let them speak'}.`);
      if (await this.turn(userId, { text: '', event: events.join(' '), first: firstMeeting })) for (const m of due) m.fulfilled = true;
      return;
    }
    if (firstMeeting) {
      this.liveReply(s, def).finish(def.greeting);
      this.record(npcId, 'npc', def.greeting);
    } else {
      // A "hello again" is shown, not kept: otherwise every visit adds one more to the history (and the model's transcript).
      this.liveReply(s, def).finish(this.returnGreeting(def, rt, hero));
    }
    this.send(userId);
  }

  private returnGreeting(def: NpcDef, rt: NpcRuntime, hero: CharacterState): string {
    const v = this.regard(rt, hero.id).value;
    const mood = v > 30 ? 'warm' : v < -20 ? 'cold' : 'plain';
    if (def.returning?.[mood]) return def.returning[mood];
    const pool = returnGreetings(hero.name)[mood];
    return pool[(this.h.day() + def.name.length) % pool.length]!;
  }

  /** " The first step: ..." for a quest being offered. */
  private firstStep(q: QuestDef): string {
    const plans = currentPlans(q, undefined);
    if (!plans.length) return '';
    return ` First step: ${this.waysLine(plans)}. Reward: ${q.rewards.gold} ${this.h.ctx.r.terminology.currency}.`;
  }

  // ------------------------------------------------------------------ trade

  /** The Trade button: open the shop straight away (no model call, no reply). */
  requestTrade(userId: string) {
    const s = this.sessions.get(userId);
    if (!s || !this.h.player(userId) || s.thinking || s.ended) return;
    if (!sells(this.npc(s.npcId)!)) return;
    this.h.openTrade(userId, s.npcId);
  }

  // ------------------------------------------------------------------ turns

  async say(userId: string, text: string, opts: { giveItemId?: string; giveGold?: number; useSkillId?: string } = {}) {
    const s = this.sessions.get(userId);
    const p = this.h.player(userId);
    const hero = this.h.speaker(userId);
    if (!s || !p || !hero || s.thinking || s.ended) return;
    const clean = text.trim().slice(0, 600);
    const offered = opts.giveItemId ? p.inventory.find((i) => i.id === opts.giveItemId) : undefined;
    const gold = Math.max(0, Math.min(p.gold, Math.floor(opts.giveGold ?? 0)));
    const parts: string[] = [];
    if (offered) parts.push(`(offers ${this.h.ctx.itemName(offered)})`);
    if (gold) parts.push(`(offers ${gold} ${this.h.ctx.r.terminology.currency})`);
    if (opts.useSkillId) {
      const err = this.h.knowsSkill(userId, opts.useSkillId);
      if (err) {
        s.messages.push({ speaker: 'narrator', text: err });
        this.send(userId);
        return;
      }
      parts.push(`(uses ${this.h.ctx.skillName(opts.useSkillId)})`);
    }
    const shown = `${parts.join(' ')} ${clean}`.trim();
    if (!shown) return;
    s.messages.push({ speaker: 'player', text: shown, name: hero.name, userId });
    this.record(s.npcId, 'player', shown, hero);
    const sk = opts.useSkillId ? rx(this.h.ctx.r).skill.get(opts.useSkillId) : undefined;
    if (sk?.effects.some((e) => e.kind === 'damage')) return this.assault(userId, s, hero, sk.name);
    await this.turn(userId, { text: clean, offered, gold, skillId: opts.useSkillId });
  }

  /** People do not fight: a hero who hurts someone is remembered for it, talked about, and left standing alone. */
  private assault(userId: string, s: Session, hero: CharacterState, skill: string) {
    const def = this.npc(s.npcId)!;
    const rt = this.h.npcRt(s.npcId)!;
    this.shift(rt, hero.id, -50, `${hero.name} attacked me with ${skill}`);
    this.h.news({ text: `${hero.name} attacked ${def.name} with ${skill}.`, heroIds: [hero.id], zoneId: rt.zoneId, witnesses: [def.id], reach: 'town', tone: 'bad' });
    const line = `${def.name} staggers back and wants nothing more to do with ${hero.name}.`;
    s.messages.push({ speaker: 'narrator', text: line });
    this.record(s.npcId, 'narrator', line);
    s.ended = true;
    for (const m of s.members) this.sendTo(m, s);
    this.h.playerChanged(userId);
  }

  private moment(s: Session, userId: string): Moment | null {
    const p = this.h.player(userId);
    const hero = this.h.speaker(userId);
    if (!p || !hero) return null;
    const def = this.npc(s.npcId)!;
    const rt = this.h.npcRt(s.npcId)!;
    const listeners = [...s.members].filter((m) => m !== userId).map((m) => this.h.speaker(m)).filter((c): c is CharacterState => !!c && c.id !== hero.id);
    const heard = heardAbout(this.h.ctx, this.h.story.news, def, rt, [hero.id, ...listeners.map((l) => l.id)], this.h.day(), this.h.communication());
    return { userId, p, hero, def, rt, listeners, heard };
  }

  /**
   * A turn: the person decides, speaks, and what follows from it happens. While it lasts the conversation shows them
   * thinking, and its notices (a quest taken, a step done) are held, so their sounds follow the words. Returns whether
   * the words were the person's own (the model's), not stock ones.
   */
  private async turn(userId: string, input: TurnInput): Promise<boolean> {
    const s = this.sessions.get(userId);
    if (!s) return false;
    const release = this.h.holdNotices([...s.members]);
    s.thinking = true;
    for (const u of s.members) this.sendTo(u, s);
    try {
      return await this.turnHeld(s, userId, input);
    } finally {
      s.thinking = false;
      for (const u of s.members) this.sendTo(u, s);
      release();
    }
  }

  private async turnHeld(s: Session, userId: string, input: TurnInput): Promise<boolean> {
    const m = this.moment(s, userId);
    if (!m) return false;
    // The judge reads whatever the hero did, with words or without (an offer made in silence is still weighed).
    const acted = !input.event;
    const options = acted ? this.options(m) : [];
    const verdict = acted ? await this.judge(m, options, input) : null;
    // Everyone walked off before anything was decided: nothing happens. (If only the one who spoke did, the others
    // still hear the answer.)
    if (!s.members.size) return false;
    const { outcome, moved } = this.decide(m, options, verdict, input);
    const live = this.liveReply(s, m.def);
    const { said, own } = await this.words(s, m, input, outcome, verdict, moved, live.show, live.shown);
    this.conclude(s, m, outcome, said, moved, live.finish);
    return own;
  }

  /** The code settles what the person does and how they now feel (`moved`: a change of opinion large enough to show, else 0). */
  private decide(m: Moment, options: Option[], verdict: Verdict | null, input: TurnInput): { outcome: Outcome; moved: number } {
    const outcome = this.settle(m, options, verdict, input);
    const before = this.regard(m.rt, m.hero.id).value;
    this.feel(m, verdict, input);
    const moved = this.regard(m.rt, m.hero.id).value - before;
    return { outcome, moved: Math.abs(moved) >= NOTICEABLE ? moved : 0 };
  }

  /** The person's words for what was decided: Luna's, or stock ones when Luna cannot speak (`own`: Luna's). */
  private async words(s: Session, m: Moment, input: TurnInput, outcome: Outcome, verdict: Verdict | null, moved: number, show: (soFar: string) => void, shown: () => string | undefined): Promise<{ said: Said; own: boolean }> {
    try {
      return { said: await this.speak(m, input, outcome, verdict, moved, show), own: true };
    } catch (e) {
      const words = shown();
      if (words) {
        console.warn('[dialogue] the reply broke off after its words were shown; keeping the words:', (e as Error).message);
        return { said: { speech: words }, own: true };
      }
      if (e instanceof BudgetExceeded) {
        // Out of AI budget: say so once, and let people answer simply until it resets.
        if (!s.messages.some((x) => x.speaker === 'narrator' && x.text === e.message)) s.messages.push({ speaker: 'narrator', text: e.message });
      } else if (!(e instanceof NotConfigured)) console.warn('[dialogue] model failed, answering simply:', (e as Error).message);
      // Without words of their own, a case argued at length is agreed to.
      const agrees = outcome.kind === 'decides' && (verdict?.convinces ?? 0) >= CONVINCED.length - 1;
      const said: Said = { speech: this.simpleSpeech(m, input, outcome, agrees), agrees };
      // Something personal is still remembered, in the hero's own words.
      if ((verdict?.remember ?? 0) >= 0.6) said.memory = { text: `${m.hero.name} told me: "${input.text.slice(0, 160)}"`, inDays: -1, tell: 'nobody', gathering: false };
      return { said, own: false };
    }
  }

  /**
   * What the words did happens, and they are kept, whether or not anyone is still there to hear them: a case agreed to
   * in words a player walked away from is still agreed to.
   */
  private conclude(s: Session, m: Moment, outcome: Outcome, said: Said, moved: number, finish: (text: string) => string) {
    const speech = finish(sanitizeSpeech(said.speech, m.def.name));
    if (speech) this.record(s.npcId, 'npc', speech);
    if (outcome.decides && said.agrees) this.h.quests.completeObjective(outcome.decides.q.id, outcome.decides.o.id);
    for (const n of [...outcome.shown, ...this.follow(m, said, moved)]) {
      s.messages.push({ speaker: 'narrator', text: n });
      this.record(s.npcId, 'narrator', n);
    }
    if (outcome.ends) s.ended = true;
    this.h.playerChanged(m.userId);
  }

  // ------------------------------------------------------------------ deciding

  /**
   * What this person could choose to do this turn besides talking: what is theirs to give. Quest work is not here: it
   * follows rules (work), so no quest waits on a mood.
   */
  private options(m: Moment): Option[] {
    const { userId, hero, def, rt } = m;
    const out: Option[] = [];
    const regard = this.regard(rt, hero.id).value;
    const add = (id: string, label: string, min: number, run: () => Outcome) => out.push({ id, label, min, run });
    add('talk', `Only talk: answer, chat, ask, explain, joke, warn, or turn ${hero.name} down, in words alone, giving and agreeing to nothing`, 0, () => ({ kind: 'talk', did: '', shown: [] }));
    const gift = this.canGift(rt, hero);
    if (gift)
      add('gift', `Give ${hero.name} something small you can spare (${giftKind(def, gift)}), as thanks, out of friendship, or to help with a danger you talked about`, 0.6, () => {
        const it = this.h.rollGift(userId, giftKind(def, gift), gift === 'generous');
        if (!it) return { kind: 'talk', did: '', shown: [] };
        (rt.giftDay ??= {})[hero.id] = this.h.day();
        this.h.giveItemsToPlayer(userId, [it]);
        const name = this.h.ctx.itemName(it);
        return { kind: 'gift', did: `You give ${hero.name} ${name}, something you could spare.`, shown: [`${def.name} gives you ${name}.`] };
      });
    // Nobody confides in front of someone they distrust.
    const distrusted = m.listeners.filter((l) => this.regard(rt, l.id).value < 0);
    if (!distrusted.length)
      for (const i of this.untoldSecrets(def, rt, hero.id)) {
        const secret = def.secrets[i]!;
        add(`secret_${i}`, `Confide in ${hero.name}: "${secret.text}" (you would only tell this ${secret.tellsWhen || 'to someone you trust'}). Only when the conversation has come to it`, regard >= CONFIDE_AT ? 0.55 : 0.8, () => {
          // Everyone listening has heard it.
          for (const x of [hero, ...m.listeners]) ((rt.secretsTold ??= {})[x.id] ??= []).push(i);
          this.h.journal('story', `${def.name} confided in ${hero.name}: ${secret.text}`);
          const shown = [`${def.name} trusted ${hero.name} with a secret. (Journal)`];
          // A secret that tells of a stash shows it, marked, to those who heard.
          const stash = secret.leadsTo ? this.h.ctx.world.zones.find((z) => z.features.some((f) => f.id === secret.leadsTo)) : undefined;
          if (stash) {
            this.h.revealZone(stash.id);
            shown.push(`${stash.features.find((f) => f.id === secret.leadsTo)!.name} in ${stash.name} is marked on your map.`);
          }
          return { kind: 'secret', did: `You confide this to ${hero.name}${m.listeners.length ? ' and the others with them' : ''}: ${secret.text}${stash ? ` Tell them where in ${stash.name} it is, and that they may take it.` : ''}`, shown };
        });
      }
    return out;
  }

  /** The step of a quest under way where the heroes must win this person over, if there is one now. */
  private caseFor(def: NpcDef): { q: QuestDef; o: QuestObjective } | undefined {
    for (const q of this.involvedQuests(def.id)) {
      const o = q.ways.find((x) => x.type === 'persuade' && x.npcId === def.id);
      if (o) return { q: q.def, o };
    }
    return undefined;
  }

  /** The judge's reading of the moment; null without a judge (or when it fails), and the code decides simply. */
  private async judge(m: Moment, options: Option[], input: TurnInput): Promise<Verdict | null> {
    if (!genai().configured('npc.judge')) return this.simpleVerdict(m.def, input);
    const { hero, def, rt } = m;
    const claims = rt.claims?.[hero.id] ?? [];
    const pending = this.caseFor(def);
    const questions: Record<string, DecisionQuestion> = {
      feeling: { type: 'score', instructions: `After this line, how does ${def.name} feel about ${hero.name}?`, criteria: [...FEELINGS] },
      move: { type: 'choice', instructions: `What is ${hero.name} mainly doing with their last line?`, criteria: { ...MOVES } },
      asksWay: { type: 'noul', instructions: `Is ${hero.name} asking where to go, or where to find someone or something?` },
      asksWork: { type: 'noul', instructions: `Is ${hero.name} asking ${def.name} for new work, or how they could help? Asking about work they have already taken up does not count.` },
      remember: { type: 'noul', instructions: `Did ${hero.name} just say something ${def.name} would remember for weeks: something personal about themselves (a date that matters to them, family, where they come from), or a promise or deal between them? Questions, small talk, and requests do not count.` },
    };
    // Work already taken up that this person is part of: which one is asked about, so the answer is about that one.
    const under = this.involvedQuests(def.id).filter((q) => q.ways.length);
    if (under.length) questions.about = { type: 'choice', instructions: `Is ${hero.name} asking about one of these pieces of work they have already taken up (what to do, where, who it goes to, or another way to do it)? Which one?`, criteria: { none: 'None of them', ...Object.fromEntries(under.map((q) => [q.def.id, `"${q.def.title}": ${q.def.summary}`])) } };
    // More than talk is the judge's to weigh only when the person has something to give.
    if (options.length > 1) questions.response = { type: 'choice', instructions: `Being who they are, what does ${def.name} do in reply to ${hero.name}'s last line? Most lines call only for talking; anything else must clearly fit this moment and what ${def.name} wants.`, criteria: Object.fromEntries(options.map((o) => [o.id, o.label])) };
    if (pending) questions.convinces = { type: 'score', instructions: `${hero.name} needs ${def.name} to agree to this: ${caseOf(pending.o)}. Taking the whole conversation into account, how convinced is ${def.name} now, by their own lights? Only what meets their real concerns convinces; pressure, flattery, and asking again move people only as far as this person would let them. If ${hero.name} has met or accepted the conditions ${def.name} set, ${def.name} is completely convinced.`, criteria: [...CONVINCED] };
    if (input.offered || input.gold) questions.accepts = { type: 'noul', instructions: `Does ${def.name} accept what ${hero.name} offers?` };
    if (claims.length && m.heard.length) questions.caught = { type: 'noul', instructions: `Does something ${def.name} has heard clearly show that one of the things ${hero.name} claimed earlier was a lie?` };
    try {
      const a = await genai().decide('npc.judge', { state: this.judgeState(m, input), questions });
      const choice = a.response?.type === 'choice' ? a.response : null;
      const score = a.feeling?.type === 'score' ? Math.round(a.feeling.score) : null;
      const about = a.about?.type === 'choice' ? a.about.choice : null;
      const move = a.move?.type === 'choice' && a.move.choice in MOVES ? (a.move.choice as Move) : 'chat';
      return {
        response: choice?.choice ?? 'talk',
        probability: choice ? (choice.probabilities[choice.choice] ?? choice.confidence) : 0,
        feeling: score === null ? null : Math.max(0, Math.min(FEELINGS.length - 1, score)),
        move,
        remember: yes(a.remember, 0),
        asksWay: yes(a.asksWay, 0),
        asksWork: yes(a.asksWork, 0),
        about: about && under.some((q) => q.def.id === about) ? about : null,
        convinces: a.convinces?.type === 'score' ? Math.max(0, Math.min(CONVINCED.length - 1, Math.round(a.convinces.score))) : null,
        accepts: yes(a.accepts, 0.5),
        caught: yes(a.caught, 0),
      };
    } catch (e) {
      if (e instanceof BudgetExceeded || e instanceof NotConfigured) return this.simpleVerdict(m.def, input);
      console.warn('[dialogue] the judge failed; deciding simply:', (e as Error).message);
      return this.simpleVerdict(m.def, input);
    }
  }

  /** The moment as the judge reads it: who the person is, who is here, what they know, and what was said. */
  private judgeState(m: Moment, input: TurnInput): string {
    const { hero, def, rt } = m;
    const r = this.regard(rt, hero.id);
    const claims = rt.claims?.[hero.id] ?? [];
    const recent = (this.h.story.conversations[def.id] ?? []).slice(-12, -1);
    return [
      `${def.name}, ${def.title}. ${def.personality}${def.want ? ` Wants: ${def.want}` : ''}${def.values.likes.length ? ` Won over by: ${def.values.likes.join('; ')}.` : ''}${def.values.dislikes.length ? ` Cannot stand: ${def.values.dislikes.join('; ')}.` : ''}`,
      `World mood: ${this.h.ctx.world.concept.tone}.`,
      `Speaking: ${this.h.describe(hero)}. ${def.name} ${feeling(r.value, r.reasons.length)}${r.reasons.length ? ` (${r.reasons.join('; ')})` : ''}.`,
      ...m.listeners.map((l) => { const lr = this.regard(rt, l.id); return `Also listening: ${this.h.describe(l)}. ${def.name} ${feeling(lr.value, lr.reasons.length)}.`; }),
      m.heard.length ? `What ${def.name} has heard: ${m.heard.slice(-6).map((x) => `${x.item.text} (${x.source})`).join(' ')}` : '',
      claims.length ? `What ${hero.name} has claimed before: ${claims.join(' | ')}` : '',
      this.workState(def),
      recent.length ? `Conversation so far:\n${recent.map((t) => this.turnLine(def, t)).join('\n')}` : '',
      input.offered ? `${hero.name} offers ${this.h.ctx.itemName(input.offered)}.` : '',
      input.gold ? `${hero.name} offers ${input.gold} ${this.h.ctx.r.terminology.currency}.` : '',
      input.skillId ? `${hero.name} uses ${this.h.ctx.skillName(input.skillId)} on ${def.name}: ${rx(this.h.ctx.r).skill.get(input.skillId)?.description ?? ''}` : '',
      input.text ? `${hero.name}'s last line: "${input.text}"` : `${hero.name} says nothing as they do it.`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** The work between this person and the heroes, in a few lines. */
  private workState(def: NpcDef): string {
    const cur = this.h.ctx.r.terminology.currency;
    const lines = this.involvedQuests(def.id).map((q) => {
      const plan = q.ways.find((o) => o.type === 'persuade' && o.npcId === def.id && o.agree);
      return `- "${q.def.title}" (${q.def.giverNpcId === def.id ? `your request, paying ${q.def.rewards.gold} ${cur}` : 'you are part of it'}): ${q.def.summary}${q.plans.length ? ` Now: ${this.waysLine(q.plans)}.` : ''}${plan ? ` You know another way, which you would tell them of if they ask and would agree to if they make the case: ${plan.agree}` : ''}`;
    });
    return lines.length ? `Work under way between you and the heroes:\n${lines.join('\n')}` : '';
  }

  private turnLine(def: NpcDef, t: { speaker: string; hero?: string; text: string }) {
    return t.speaker === 'player' ? `${t.hero ?? 'Someone'}: ${t.text}` : t.speaker === 'npc' ? `${def.name}: ${t.text}` : `[${t.text}]`;
  }

  /**
   * The code's decision: what the hero offers is taken or not; then quest work by its rules; else the judged response if
   * it clearly leads and its gate holds; else talking. One thing happens a turn besides an offer taken.
   */
  private settle(m: Moment, options: Option[], v: Verdict | null, input: TurnInput): Outcome {
    const { userId, p, hero, def, rt } = m;
    const out: Outcome = { kind: 'talk', did: '', shown: [] };
    const cur = this.h.ctx.r.terminology.currency;
    // (What the hero has now: gold offered may have been spent while the judge read the moment.)
    const gold = Math.min(input.gold ?? 0, p.gold);
    if (input.offered || input.gold) {
      if ((v?.accepts ?? 0.5) >= 0.5) {
        const taken: string[] = [];
        if (input.offered) {
          // It may be just what a delivery asked for.
          const delivered = this.h.quests.tryDeliver(def.id, p);
          const items = delivered.length ? delivered.flatMap((d) => d.items) : [this.h.takeItemFromPlayer(userId, input.offered.id)].filter((x): x is ItemInstance => !!x);
          for (const it of items) {
            taken.push(this.h.ctx.itemName(it));
            if (!delivered.length) this.shift(rt, hero.id, Math.min(15, 3 + Math.round(Math.sqrt(rx(this.h.ctx.r).item.get(it.baseId)?.price ?? 5))), `${hero.name} gave me ${this.h.ctx.itemName(it)}`);
          }
        }
        if (gold) {
          p.gold -= gold;
          rt.gold += gold;
          taken.push(`${gold} ${cur}`);
          // Gold buys goodwill up to what the gift is worth (a point for every ten, twenty at most), not by it: a
          // stream of small gifts lifts nobody's opinion further than one of them would.
          const lift = Math.min(GOLD_LIFTS_TO, Math.round(gold / 10)) - this.regard(rt, hero.id).value;
          if (lift > 0) this.shift(rt, hero.id, lift, `${hero.name} gave me ${gold} ${cur}`);
        }
        if (taken.length) {
          out.kind = 'accepted';
          out.did = `You accept ${taken.join(' and ')} from ${hero.name}.`;
          out.shown.push(`${def.name} takes ${taken.join(' and ')}.`);
        }
      } else {
        out.kind = 'declined';
        out.did = `You turn down what ${hero.name} offers; they keep it.`;
        out.shown.push(`${def.name} declines.`);
      }
    }
    if (v?.move === 'farewell') out.ends = true;
    const add = (r: Outcome): Outcome => ({ ...r, kind: r.kind === 'talk' ? out.kind : r.kind, did: `${out.did} ${r.did}`.trim(), shown: [...out.shown, ...r.shown], ends: out.ends || r.ends });
    const work = this.work(m, v);
    if (work) return add(work);
    const chosen = options.find((o) => o.id === v?.response);
    if (!chosen || chosen.id === 'talk' || (v?.probability ?? 0) < chosen.min) {
      if (v && (v.move === 'ask' || v.move === 'bargain')) {
        if (out.kind === 'talk') out.kind = 'refused';
        out.did = `${out.did} You do not give ${hero.name} what they asked for, at least not now; say so in your own way.`.trim();
      }
      return out;
    }
    return add(chosen.run());
  }

  /**
   * Quest work, by rules: anyone who asks for work and is not disliked gets the person's next side job; and once the
   * judge, reading the whole conversation, finds the person at least partly convinced of a case put to them (a
   * little, when they like the hero), the person decides in their own words whether they agree, and the game follows
   * the words (turn). Being convinced is a reading of where the conversation stands, not a sum of lines, so asking
   * again adds nothing: a case is won by meeting the person's concerns, never by nagging. The decision is in the
   * words because agreeing happens in them: a judge reading the moment before the reply kept disagreeing with it.
   */
  private work(m: Moment, v: Verdict | null): Outcome | null {
    const { hero, def, rt } = m;
    const regard = this.regard(rt, hero.id).value;
    const pending = this.caseFor(def);
    if (pending && v?.convinces != null) {
      const { o } = pending;
      if (v.convinces >= (regard >= WON_SOONER_AT ? 1 : 2))
        return { kind: 'decides', did: `${hero.name} wants you to agree to this: ${caseOf(o)}. You are ${CONVINCED[v.convinces]} convinced. Decide now, as who you are: if what they have said meets your concerns, agree in your words (and set agrees); if not, name the one thing that would settle it, and raise no new objection to what they have already met.`, shown: [], decides: pending };
      if (v.move === 'persuade' || v.move === 'flatter' || v.move === 'threaten' || v.move === 'bargain')
        return { kind: 'unconvinced', did: `You are ${CONVINCED[v.convinces]} convinced (${caseOf(o)}), so you do not agree. Let them hear what holds you back.`, shown: [] };
    }
    const involved = this.involvedQuests(def.id).filter((q) => q.ways.length);
    // Asked about work already taken up: what to do next for that work, before anything new is offered.
    const about = v?.about ? involved.find((q) => q.def.id === v.about) : undefined;
    const asks = !about && (v?.asksWork ?? 0) >= 0.5;
    const job = asks ? this.availableQuests(def).find((q) => !q.main) : undefined;
    // Asked for work by heroes already helping and nothing new to give: what to do next, never a refusal, for the work
    // where this person matters now (involvedQuests puts it first), with the other way they know when they know one.
    const under = about ?? (asks && !job ? involved[0] : undefined);
    const plan = under?.ways.find((o) => o.type === 'persuade' && o.npcId === def.id && o.agree);
    if (under) return { kind: 'next', did: `${hero.name} is already helping with "${under.def.title}". Tell them plainly what can be done next: ${this.waysLine(under.plans)}.${plan ? ` The other way is yours to give: tell them of it (${plan.agree}) and what would win you over.` : ''}`, shown: [] };
    if (asks && !job) {
      // Nothing of one's own to give: say so plainly, and point to a neighbor who needs help (people know who does).
      const other = this.h.ctx.world.npcs.find((n) => n.id !== def.id && n.zoneId === def.zoneId && this.availableQuests(n).some((q) => !q.main));
      return { kind: 'nothing', did: `You have nothing for ${hero.name} to do for you right now: say so plainly, without making up a reason.${other ? ` ${other.name} (${other.title}) needs help, as far as you know: tell them so.` : ''}`, shown: [] };
    }
    if (!job) return null;
    if (regard < NO_WORK_BELOW) return { kind: 'unwilling', did: `You have work that needs doing ("${job.title}"), but you will not give it to ${hero.name}: you do not trust them with it. Say no.`, shown: [] };
    if (!this.h.quests.start(job.id, `${def.name} asked ${hero.name} for help.`, hero.name)) return null;
    return { kind: 'job', did: `You ask ${hero.name} to take on "${job.title}": ${job.summary}${this.firstStep(job)} They have agreed to it.`, shown: [this.h.quests.newQuestLine(job)] };
  }

  /** Opinion moves a step toward the judged feeling; threats and lies found out are talked about. */
  private feel(m: Moment, v: Verdict | null, input: TurnInput) {
    if (!v) return;
    const { hero, def, rt } = m;
    const r = this.regard(rt, hero.id);
    if (v.feeling !== null) {
      // Trust is lost faster than it is won: a threat leaves a mark one kind word does not undo.
      const step = Math.max(-30, Math.min(15, Math.round((FEELING_VALUES[v.feeling]! - r.value) * 0.3)));
      if (Math.abs(step) >= 2) this.shift(rt, hero.id, step);
    }
    if (v.move === 'claim' && input.text) {
      const claims = (rt.claims ??= {});
      claims[hero.id] = [...(claims[hero.id] ?? []), input.text.slice(0, 160)].slice(-6);
    }
    if (v.caught >= 0.7) {
      this.shift(rt, hero.id, -20, `${hero.name} lied to me`);
      delete rt.claims?.[hero.id];
      this.h.news({ text: `${hero.name} was caught lying to ${def.name}.`, heroIds: [hero.id], zoneId: rt.zoneId, witnesses: [def.id], reach: 'friends', tone: 'bad' });
    }
    if (v.move === 'threaten' && v.feeling !== null && v.feeling <= 2) {
      // One piece of news a day, however many threatening lines it took.
      const text = `${hero.name} threatened ${def.name}.`;
      if (!this.h.story.news.some((n) => n.text === text && n.day === this.h.day())) this.h.news({ text, heroIds: [hero.id], zoneId: rt.zoneId, witnesses: [def.id], reach: 'town', tone: 'bad' });
      // The company you keep: those standing by are tarred with it.
      for (const l of m.listeners) this.shift(rt, l.id, -5, `was there when ${hero.name} threatened me`);
    }
  }

  // ------------------------------------------------------------------ speaking

  /** Luna says what was decided, as this person, streamed. */
  private async speak(m: Moment, input: TurnInput, outcome: Outcome, v: Verdict | null, moved: number, onSpeech: (soFar: string) => void): Promise<Said> {
    if (!genai().configured('npc.decision')) throw new NotConfigured('npc.decision');
    const { hero, def, rt } = m;
    const wantMemory = (v?.remember ?? 0) >= 0.6;
    // A lead can only point where the person would know (with nowhere to point, none is asked for).
    const places = this.leadPlaces(def).map((z) => z.name);
    const wantLead = (v?.asksWay ?? 0) >= 0.5 && places.length > 0;
    const schema = z.object({
      speech: z.string().min(1).max(900).describe(`Only ${def.name}'s spoken words`),
      ...(wantLead
        ? {
            lead: z.object({
              text: z.string().max(200).describe(`If your words point ${hero.name} somewhere (where to go, whom to see), that in one plain sentence for their journal; otherwise empty`),
              place: z.enum(['none', ...places]).describe('The place your words point them to, if it is one of these; otherwise none'),
            }),
          }
        : {}),
      ...(outcome.decides ? { agrees: z.boolean().describe(`True only if your words agree to it: ${caseOf(outcome.decides.o)}`) } : {}),
      ...(moved ? { reason: z.string().max(120).describe(`Why you now think ${moved > 0 ? 'better' : 'worse'} of ${hero.name}, in a few words as you would put it ("asked about my sister", "tried to bully me")`) } : {}),
      ...(wantMemory
        ? {
            memory: z.object({
              text: z.string().max(200).describe(`What to remember about ${hero.name}, one sentence naming them`),
              inDays: z.number().int().min(-1).max(60).describe('In how many days it happens, if it is about a date; -1 if not'),
              tell: z.enum(['nobody', 'friends', 'everyone']).describe('Who you would tell'),
              gathering: z.boolean().describe('True only for an occasion your community would gather for (a celebration, a memorial)'),
            }),
          }
        : {}),
    });
    const out = await genai().structured('npc.decision', {
      system: personSheet(this.h.ctx.world, def, this.h.ctx.zones.get(rt.zoneId)?.name ?? 'town', (id) => this.npc(id)?.name),
      prompt: this.situation(m, input, outcome, moved),
      schema,
      name: 'npc_turn',
      onText: (raw) => {
        const speech = partialString(raw, 'speech');
        if (speech) onSpeech(speech.text);
      },
    });
    return out as Said;
  }

  /** The moment as the person sees it, with what they decided, for Luna's prompt. */
  private situation(m: Moment, input: TurnInput, outcome: Outcome, moved: number): string {
    const { hero, def, rt } = m;
    const zone = this.h.ctx.zones.get(rt.zoneId);
    const r = this.regard(rt, hero.id);
    const mems = rt.memories.filter((x) => x.about === hero.id || m.listeners.some((l) => l.id === x.about)).slice(-8);
    const claims = rt.claims?.[hero.id] ?? [];
    const recent = (this.h.story.conversations[def.id] ?? []).slice(-16);
    const saidBefore = recent.filter((t) => t.speaker === 'npc').map((t) => t.text);
    const distrusted = m.listeners.filter((l) => this.regard(rt, l.id).value < 0);
    // Secrets are shown only once told (to these heroes) or being told now: words cannot give away what they never saw.
    const told = [...new Set([hero, ...m.listeners].flatMap((x) => rt.secretsTold?.[x.id] ?? []))].map((i) => def.secrets[i]?.text).filter(Boolean);
    const lines = [
      `NOW: ${this.h.timeOfDay()} on day ${this.h.day()}, at ${zone?.name ?? 'home'}.`,
      `WHO IS HERE\n- ${this.h.describe(hero)} (speaking to you). You ${feeling(r.value, r.reasons.length)}${r.reasons.length ? `, because: ${r.reasons.join('; ')}` : ''}.${m.listeners.map((l) => { const lr = this.regard(rt, l.id); return `\n- ${this.h.describe(l)} (listening). You ${feeling(lr.value, lr.reasons.length)}${lr.reasons.length ? `, because: ${lr.reasons.join('; ')}` : ''}.`; }).join('')}`,
      `Show how you feel in your tone and in what you share, never as a label.${distrusted.length ? ` You would not say anything private with ${distrusted.map((l) => l.name).join(' and ')} listening.` : ''}`,
      m.heard.length ? `WHAT YOU HAVE HEARD ABOUT THEM\n${m.heard.slice(-6).map((x) => `- ${x.item.text} (${x.source})`).join('\n')}` : '',
      claims.length ? `WHAT ${hero.name.toUpperCase()} HAS TOLD YOU ABOUT THEMSELVES\n${claims.map((c) => `- "${c}"`).join('\n')}` : '',
      told.length ? `WHAT YOU HAVE ALREADY CONFIDED TO THEM\n${told.map((t) => `- ${t}`).join('\n')}` : '',
      mems.length ? `THINGS YOU REMEMBER\n${mems.map((x) => `- ${x.text}${x.dueDay !== undefined ? ` (day ${x.dueDay})` : ''}`).join('\n')}` : '',
      this.workState(def),
      recent.length ? `THE CONVERSATION SO FAR\n${recent.map((t) => this.turnLine(def, t)).join('\n')}` : '',
      // Listed apart, people stop circling back to their own concern (graded scenes: fresh 3.4 with the rule alone).
      saidBefore.length ? `WHAT YOU HAVE ALREADY SAID (each point is made; move on from it)\n${saidBefore.map((t) => `- ${t}`).join('\n')}` : '',
      input.event ? `WHAT IS HAPPENING: ${input.event}` : '',
      input.offered ? `${hero.name} offers you ${this.h.ctx.itemName(input.offered)} (${this.h.ctx.itemDescription(input.offered) || rx(this.h.ctx.r).item.get(input.offered.baseId)?.category}).` : '',
      input.gold ? `${hero.name} offers you ${input.gold} ${this.h.ctx.r.terminology.currency}.` : '',
      input.skillId ? `${hero.name} uses ${this.h.ctx.skillName(input.skillId)} on you: ${rx(this.h.ctx.r).skill.get(input.skillId)?.description ?? ''}` : '',
      moved < 0 ? `You think worse of ${hero.name} than a moment ago: it shows (cooler, shorter, less willing).` : moved > 0 ? `You think better of ${hero.name} than a moment ago: it shows (warmer, more open).` : '',
      `WHAT YOU DO THIS TURN: ${outcome.did || 'You only talk: you give, offer, and agree to nothing.'}`,
      input.text ? `${hero.name} says: "${input.text}"\nAnswer as ${def.name}.` : input.event ? `Speak first, as ${def.name}.` : `${hero.name} says nothing as they do it.\nAnswer as ${def.name}.`,
    ];
    return lines.filter(Boolean).join('\n\n');
  }

  /** What follows from the words: a lead in the journal and its place on the map, a memory, the reason for a change of heart. */
  private follow(m: Moment, said: Said, moved: number): string[] {
    const { hero, def, rt } = m;
    const shown: string[] = [];
    if (moved && said.reason?.trim()) {
      const r = this.regard(rt, hero.id);
      const reason = said.reason.trim();
      r.reasons = [...r.reasons.filter((x) => x !== reason), reason].slice(-MAX_REASONS);
    }
    // Asked the way, the person points somewhere: it goes in the journal, and a place not yet known onto the map.
    const lead = said.lead?.text.trim();
    if (lead && lead.length >= 12 && !this.h.story.journal.slice(-20).some((j) => j.text.endsWith(lead))) {
      this.h.journal('discovery', `${def.name}: ${lead}`);
      shown.push('Noted in your journal.');
      const z = this.leadPlaces(def).find((x) => x.name === said.lead?.place);
      if (z && this.h.revealZone(z.id)) shown.push(`${z.name} is now on your map.`);
    }
    if (said.memory?.text) {
      const due = said.memory.inDays >= 0 ? this.h.day() + said.memory.inDays : undefined;
      this.h.remember(def.id, { id: uid('m'), text: said.memory.text, about: hero.id, aboutName: hero.name, day: this.h.day(), dueDay: due });
      const comm = this.h.communication();
      if (said.memory.tell !== 'nobody' && comm > 0) this.h.news({ text: said.memory.text, heroIds: [hero.id], zoneId: rt.zoneId, witnesses: [def.id], reach: said.memory.tell === 'everyone' ? 'town' : 'friends', tone: 'neutral' });
      if (said.memory.gathering && due !== undefined && comm >= 2) this.h.scheduleGathering(def.id, hero.id, due, said.memory.text);
    }
    return shown;
  }

  /**
   * The places a person can point a hero to: home, the places next to it, and the places of the quests they are part
   * of (as giver, or as someone a step goes to). Only these names are offered to the model, so far places are neither
   * given away nor put on the map by someone who would not know them.
   */
  private leadPlaces(def: NpcDef): ZoneDef[] {
    const w = this.h.ctx.world;
    const quests = w.quests.filter((q) => q.giverNpcId === def.id || q.objectives.some((o) => o.npcId === def.id));
    const ids = new Set([...knownPlaces(w, def).map((z) => z.id), ...quests.flatMap((q) => [q.zoneId, ...q.objectives.map((o) => o.zoneId)])]);
    return w.zones.filter((z) => ids.has(z.id));
  }

  /** Whether this person could give the hero a gift now: 'generous' for someone they are fond of. */
  private canGift(rt: NpcRuntime, hero: CharacterState): 'modest' | 'generous' | null {
    const last = rt.giftDay?.[hero.id];
    if (last !== undefined && this.h.day() - last < GIFT_EVERY_DAYS) return null;
    const v = this.regard(rt, hero.id).value;
    if (v < GIFT_AT) return null;
    return v >= 60 ? 'generous' : 'modest';
  }

  private untoldSecrets(def: NpcDef, rt: NpcRuntime, heroId: string): number[] {
    const told = new Set(rt.secretsTold?.[heroId] ?? []);
    return def.secrets.map((_, i) => i).filter((i) => !told.has(i));
  }

  /** The ways a step can be done, each with all it takes in order: "Find the envelope (…), then bring it to Jules (…), or …". */
  private waysLine(plans: QuestObjective[][]): string {
    const one = (o: QuestObjective) => { const where = this.whereOf(o); return `${o.description}${where ? ` (${where})` : ''}`; };
    return plans.map((plan) => plan.map(one).join(', then ')).join('; or ');
  }

  /**
   * Where a quest step leads, for the person telling of it, exactly, so they never guess: the place, for someone in
   * town the building they work at ("Wrenna, at the Acorn Cup in Thimblebrook"), and for a thing to find the chest it
   * is in and, in a town, the building it is near.
   */
  private whereOf(o: QuestObjective): string {
    const w = this.h.ctx.world, zone = (id?: string) => (id ? this.h.ctx.zones.get(id) : undefined);
    if (o.npcId) {
      const n = this.npc(o.npcId);
      if (!n) return '';
      const z = zone(n.zoneId), b = z?.buildings?.find((x) => x.npcId === n.id);
      return `${n.name}, ${b ? `at ${b.name} in ` : 'in '}${z?.name ?? 'somewhere'}`;
    }
    const chest = o.type === 'collect' && o.itemUniqueId ? w.zones.flatMap((x) => x.features.filter((f) => f.items?.includes(o.itemUniqueId!)).map((f) => ({ x, f })))[0] : undefined;
    if (chest) {
      const by = (chest.x.buildings ?? [])
        .map((b) => ({ b, n: this.npc(b.npcId) }))
        .filter((x) => x.n && x.n.zoneId === chest.x.id)
        .sort((p, q) => Math.hypot(p.n!.x - chest.f.x, p.n!.y - chest.f.y) - Math.hypot(q.n!.x - chest.f.x, q.n!.y - chest.f.y))[0];
      return `in a chest${by ? ` near ${by.b.name}` : ''} in ${chest.x.name}`;
    }
    const z =
      zone(o.zoneId) ??
      zone(w.bosses.find((b) => b.id === o.targetId)?.zoneId) ??
      w.zones.find((x) => o.itemUniqueId && x.features.some((f) => f.items?.includes(o.itemUniqueId!))) ??
      (o.familyId ? w.zones.find((x) => x.familyIds.includes(o.familyId!)) : undefined);
    return z ? `in ${z.name}` : '';
  }

  // ------------------------------------------------------------------ without models

  /** A plain reading of a line by its words, when there is no judge: people only talk, and quest work follows its rules. */
  private simpleVerdict(def: NpcDef, input: TurnInput): Verdict {
    const t = input.text.toLowerCase();
    const has = (...words: string[]) => words.some((x) => new RegExp(`\\b${x}`, 'i').test(t));
    const asksWork = has('work', 'job', 'help', 'task', 'errand', 'anything i can') ? 1 : 0;
    const remember = has('birthday', 'wedding', 'anniversary', 'remember') ? 1 : 0;
    const move: Move = has('bye', 'farewell', 'goodbye', 'see you') ? 'farewell' : has('idiot', 'stupid', 'ugly', 'hate you', 'shut up') ? 'insult' : asksWork ? 'ask' : remember ? 'kind' : 'chat';
    // A case argued at some length convinces; a short line does not move anyone.
    const convinces = this.caseFor(def) ? (input.text.length > 60 ? CONVINCED.length - 1 : 0) : null;
    return { response: 'talk', probability: 1, feeling: move === 'insult' ? 1 : null, move, remember, asksWay: has('where', 'which way', 'how do i get') ? 1 : 0, asksWork, about: null, convinces, accepts: 1, caught: 0 };
  }

  /** Stock words that carry what was decided, when Luna cannot speak (`agrees`: to a case that was theirs to decide). */
  private simpleSpeech(m: Moment, input: TurnInput, outcome: Outcome, agrees: boolean): string {
    const { hero, def, rt } = m;
    if (input.event) return input.first ? def.greeting || `Hello, ${hero.name}.` : this.returnGreeting(def, rt, hero);
    if (outcome.ends) return 'Take care.';
    switch (outcome.kind) {
      case 'job': return 'There is something you could do for me. It is in your journal now.';
      case 'accepted': return 'For me? Thank you.';
      case 'declined': return 'Keep it. I could not take that.';
      case 'gift': return 'Here. I want you to have this.';
      case 'secret': return 'There is something I have told almost nobody. It is in your journal now.';
      case 'next': return 'You are helping me already. Your journal has what comes next.';
      case 'nothing': return 'I have nothing for you to do right now.';
      case 'unwilling': return 'No. I would not trust you with it.';
      case 'refused': return 'I cannot do that for you.';
      case 'decides': return agrees ? 'All right. You have convinced me.' : 'I am not convinced yet.';
      case 'unconvinced': return 'I am not convinced yet.';
      case 'talk': break;
    }
    if (/\b(birthday|remember)/i.test(input.text)) return "I'll remember that.";
    return def.barks[(input.text.length + this.h.day()) % Math.max(1, def.barks.length)] ?? 'Hm.';
  }
}

/** Luna's answer: the words, and what follows from them. */
interface Said {
  speech: string;
  /** For a case the person decides this turn: whether their words agree. */
  agrees?: boolean;
  lead?: { text: string; place: string };
  reason?: string;
  memory?: { text: string; inDays: number; tell: 'nobody' | 'friends' | 'everyone'; gathering: boolean };
}

const yes = (a: DecisionAnswer | undefined, otherwise: number) => (a?.type === 'noul' ? a.noul : otherwise);

/** People who keep a shop. */
export function sells(def: NpcDef) {
  return def.role === 'merchant';
}

/**
 * What a person has to spare: a merchant something of what they sell (a generous one of weapons or armor, a piece
 * of it); anyone else supplies, or when generous a keepsake of their own.
 */
function giftKind(def: NpcDef, gift: 'modest' | 'generous'): GiftKind {
  if (def.merchantKind === 'materials') return 'material';
  if (def.role === 'merchant') return gift === 'generous' && def.merchantKind !== 'general' ? 'gear' : 'supplies';
  return gift === 'generous' ? 'keepsake' : 'supplies';
}

/** What people say to a hero they have met before, when they have no lines of their own (lines without the name are voiced at build time). */
export function returnGreetings(name: string) {
  return {
    warm: [`${name}! Good to see you.`, `There you are, ${name}. What do you need?`],
    cold: ['You again.', 'What do you want now?', `Make it quick, ${name}.`],
    plain: [`Back again, ${name}?`, 'Yes?', `Hello again, ${name}.`, 'What can I do for you?'],
  };
}

/**
 * Remove speaker tags and stage-direction noise models sometimes emit. `partial`: words still being written (a
 * quote around them is taken off at its start; its end is not there yet).
 */
export function sanitizeSpeech(s: string, name: string, partial = false): string {
  let out = (s ?? '').trim();
  const prefix = new RegExp(`^(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|NPC)\\s*:\\s*`, 'i');
  out = out.replace(prefix, '');
  if (partial ? out.startsWith('"') : out.startsWith('"') && out.endsWith('"') && out.length > 2) out = out.slice(1, partial ? undefined : -1);
  // (A tag still being written is held back, so the words never shrink under the sentences already cut from them.)
  if (partial) out = out.replace(/<[^>]*$/, '');
  return out.replace(/<\/?[^>]+>/g, '').trim();
}
