/**
 * What a playtesting agent can do, as one table: the CLI (cli/play.ts) and the MCP server (playtest/mcp.ts) are two
 * doors to it. Each command acts through the game's own client in the page (`window.__gd`) or through real clicks and
 * keys, waits until the game is quiet, and answers with a short text of what the player now sees and a screenshot.
 */
import fs from 'node:fs';
import type { Page } from './cdp.ts';
import { SEVERITIES, type Run, type Severity } from './run.ts';

export interface Param {
  name: string;
  description: string;
  type?: 'string' | 'number';
  optional?: boolean;
  /** Takes the rest of the words (the last parameter only). */
  rest?: boolean;
  /** Only given by name (`--fun 4`), never by position. */
  flag?: boolean;
}

/** One player's live session: their page, their run, and what the last `ui` listed. */
export interface Session {
  n: number;
  page: Page;
  run: Run;
  userId: string;
  uiTargets: { n: number; x: number; y: number; text: string }[];
}

export interface Answer {
  text: string;
  /** A screenshot was taken (the default for most commands). */
  shot?: string;
}

export interface Command {
  name: string;
  summary: string;
  params: Param[];
  /** Takes no screenshot unless asked (`--shot`). */
  quiet?: boolean;
  run(s: Session, a: Record<string, string | undefined>, o: { marks?: boolean }): Promise<Answer | string>;
}

// ------------------------------------------------------------------------------------ the page

const js = (v: unknown) => JSON.stringify(v);

/** The game client's state, through the helper (page.js). */
type Thing = { ref: string; id: string; kind: string; name?: string; title?: string; level?: number; hp?: string; hostile?: boolean; dead?: boolean; downed?: boolean; boss?: boolean; named?: boolean; marker?: string; statuses?: string; moving?: boolean; bark?: string; leadsTo?: string; state?: string; quest?: boolean; x: number; y: number; dist: number; dir: string };
type Item = { id: string; name: string; qty?: number; level?: number; price?: number };
export interface Snapshot {
  screen: string;
  inGame: boolean;
  connection?: string;
  error?: string;
  place?: string;
  at?: { x: number; y: number };
  clock?: string;
  gold?: number;
  currency?: string;
  bag?: Item[];
  party?: { ref: string; id: string; name: string; class: string; level: number; hp: string; leader?: boolean; ai?: boolean; downed?: boolean; points?: number; hotbar: string[] }[];
  players?: string[];
  quests?: { id: string; title: string; main?: boolean; next?: string }[];
  combat?: { round: number; yourTurn: boolean; mine: { ref: string; name: string; ap: string; moveLeft?: number }[]; others: string[]; inIt: boolean; order: string };
  dialog?: { with: string; thinking?: boolean; canTrade?: boolean; said: string[]; suggestions?: string[] };
  trade?: { with: string; theirGold: number; stock: Item[] };
  loot?: { label: string; gold: number; items: Item[] };
  panel?: string;
  narration?: { title: string; text: string };
  things?: Thing[];
}
type GameEvent = { kind: string; text: string; from?: string; title?: string; mine?: boolean };

export const snapshot = (p: Page) => p.evaluate<Snapshot>('window.__pt.snapshot()');
const takeEvents = (p: Page) => p.evaluate<GameEvent[]>('window.__pt.takeEvents()');
const settle = (p: Page, o: { timeout?: number; quiet?: number; minimum?: number } = {}) => p.evaluate<string>(`window.__pt.settle(${js(o)})`);
const send = (p: Page, msg: Record<string, unknown>) => p.evaluate(`window.__gd.send(${js(msg)})`);

async function inGame(p: Page): Promise<Snapshot> {
  const s = await snapshot(p);
  if (!s.inGame) throw new Error('Not in the game now (the page is the menus): use "start", or "ui" and "click" to find your way.');
  return s;
}

/** A short name (n3), a game id, a name as the player sees it, or a point "x,y", to a target. */
async function target(p: Page, what: string | undefined): Promise<{ id?: string; x?: number; y?: number }> {
  if (!what) throw new Error('Say what: a short name from the list (n1, m2, f3), a name, or a point "x,y".');
  const point = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(what);
  if (point) return { x: Number(point[1]), y: Number(point[2]) };
  const id = await p.evaluate<string | null>(`window.__pt.resolve(${js(what)})`);
  if (!id) throw new Error(`Nothing called "${what}" in sight. "look" lists what is here.`);
  return { id };
}

/**
 * The hero who acts: the one named (in a fight, one of the player's heroes acting now), else in a fight the player's
 * hero acting now that the game has selected, else the leader.
 */
async function actor(p: Page, hero?: string): Promise<string> {
  const fight = await p.evaluate<{ acting: { id: string; name: string }[] } | null>(`(() => {
    const c = window.__gd;
    return c.state.combat ? { acting: c.myActors().map((id) => ({ id, name: c.state.entities.get(id)?.name ?? id })) } : null;
  })()`);
  if (hero) {
    const t = await target(p, hero);
    if (!t.id) throw new Error('Name one of your heroes (h1, or a name).');
    if (fight && !fight.acting.some((a) => a.id === t.id))
      throw new Error(fight.acting.length ? `${hero} is not acting now; your heroes acting now: ${fight.acting.map((a) => a.name).join(', ')}.` : 'It is not your turn in the fight: "wait" until it is.');
    return t.id;
  }
  if (fight?.acting.length) return p.evaluate<string>('window.__gd.myActor()');
  return p.evaluate<string>('window.__gd.state.player.leaderId');
}

const HERO: Param = { name: 'hero', description: 'which of your heroes acts (h1, or a name); in a fight, one acting now', flag: true, optional: true };

/** An item in the bag (or in the open shop or loot window) by its id or name. */
async function item(p: Page, what: string | undefined, from: 'bag' | 'trade' | 'loot' = 'bag'): Promise<Item> {
  if (!what) throw new Error('Say which item (its name or id).');
  const s = await inGame(p);
  const list = from === 'bag' ? s.bag : from === 'trade' ? s.trade?.stock : s.loot?.items;
  if (!list) throw new Error(from === 'trade' ? 'No shop is open: talk to a trader and "trade" first.' : from === 'loot' ? 'No loot window is open.' : 'No bag.');
  const want = what.toLowerCase();
  const hit = list.find((i) => i.id === what) ?? list.find((i) => i.name.toLowerCase() === want) ?? list.find((i) => i.name.toLowerCase().includes(want));
  if (!hit) throw new Error(`No "${what}" in ${from === 'bag' ? 'the bag' : from === 'trade' ? 'the shop' : 'the loot'}: ${list.map((i) => i.name).join(', ') || 'it is empty'}.`);
  return hit;
}

/** A skill on the acting hero's hotbar or tree, by its id or name. */
async function skill(p: Page, charId: string, what: string | undefined): Promise<string> {
  if (!what) throw new Error('Say which skill (its id or name; "look" shows each hero\'s hotbar).');
  const id = await p.evaluate<string | null>(`(() => {
    const c = window.__gd, ch = c.myChars().find((x) => x.id === ${js(charId)});
    const want = ${js(what.toLowerCase())};
    const known = [...new Set([...(ch?.hotbar ?? []).filter(Boolean), 'attack'])];
    const hotkey = /^\\d$/.test(want) ? ch?.hotbar[Number(want) - 1] : null;
    return hotkey ?? known.find((k) => k === want) ?? known.find((k) => c.skillName(k).toLowerCase() === want) ?? known.find((k) => c.skillName(k).toLowerCase().includes(want)) ?? null;
  })()`);
  if (!id) throw new Error(`The hero has no skill "${what}" on their hotbar.`);
  return id;
}

// ------------------------------------------------------------------------------------ the answer

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** What the player sees now, in a few lines: the answer to every command that changes something. */
export function describe(s: Snapshot, events: GameEvent[], o: { full?: boolean } = {}): string {
  if (!s.inGame) return `On the menus (${s.screen || '#/'}). "ui" numbers the buttons; "click <n>" presses one.`;
  const out: string[] = [];
  if (s.connection !== 'connected') out.push(`Connection: ${s.connection}${s.error ? ` (${s.error})` : ''}`);
  out.push(`Place: ${s.place ?? 'loading'} · ${s.clock ?? ''} · you are at ${s.at?.x},${s.at?.y} · ${s.gold ?? 0} ${s.currency} · ${plural(s.bag?.length ?? 0, 'item')} in the bag`);
  for (const h of s.party ?? [])
    out.push(`Hero ${h.ref} ${h.name}: ${h.class} level ${h.level}, ${h.hp} health${h.leader ? ', leads' : ''}${h.ai ? ', fights on their own' : ''}${h.downed ? ', DOWNED' : ''}${h.points ? `, ${plural(h.points, 'unspent point')}` : ''}; hotbar ${h.hotbar.join(' ') || 'empty'}`);
  if (s.players?.length) out.push(`Other players: ${s.players.join('; ')}`);
  const quests = s.quests ?? [];
  for (const q of o.full ? quests : quests.filter((x) => x.main).concat(quests.filter((x) => !x.main)).slice(0, 3))
    out.push(`Quest${q.main ? ' (main)' : ''} "${q.title}"${q.next ? `: next, ${q.next}` : ''}`);
  if (!o.full && quests.length > 3) out.push(`(${quests.length - 3} more quests: "quests" lists them)`);
  if (s.combat) {
    const c = s.combat;
    const hero = (h: { ref: string; name: string; ap: string; moveLeft?: number }) => `${h.name} (${h.ref}) ${h.ap} action points${h.moveLeft ? `, ${h.moveLeft} m of free movement` : ''}`;
    const others = c.others.length ? `${c.others.join(', ')} ${c.others.length > 1 ? 'are' : 'is'} acting` : 'the others are acting';
    const state = !c.inIt
      ? `a fight nearby that you are not in (${others}); you walk, talk and loot as usual, and join it by walking within about 8 m of anyone in it, in sight of them`
      : c.yourTurn
        ? `your turn: ${hero(c.mine[0]!)}${c.mine.length > 1 ? `; also yours now: ${c.mine.slice(1).map(hero).join('; ')} (commands act with ${c.mine[0]!.name} unless --hero names another)` : ''}${c.others.length ? `; sharing the turn: ${c.others.join(', ')}` : ''}`
        : others;
    out.push(`${c.inIt ? 'FIGHT' : 'Fight nearby'}, round ${c.round}: ${state}. Order (* acting): ${c.order}`);
  }
  if (s.narration) out.push(`Story text on screen ("ok" closes it): ${s.narration.title}: ${s.narration.text}`);
  if (s.dialog) {
    out.push(`Talking with ${s.dialog.with}${s.dialog.thinking ? ' (they are thinking)' : ''}${s.dialog.canTrade ? ' (they trade: "trade")' : ''}:`);
    for (const line of s.dialog.said) out.push(`  ${line}`);
    if (s.dialog.suggestions) out.push(`  Suggested replies: ${s.dialog.suggestions.map((x) => js(x)).join(' · ')}`);
  }
  if (s.trade) out.push(`Shop of ${s.trade.with} (${s.trade.theirGold} ${s.currency}): ${s.trade.stock.map((i) => `${i.name}${i.qty ? ` ×${i.qty}` : ''} ${i.price}`).join('; ')}`);
  if (s.loot) out.push(`Loot window, ${s.loot.label}: ${[s.loot.gold ? `${s.loot.gold} ${s.currency}` : '', ...s.loot.items.map((i) => i.name)].filter(Boolean).join('; ') || 'empty'}`);
  if (s.panel) out.push(`Open panel: ${s.panel}`);
  if (events.length) {
    out.push('Since the last command:');
    for (const e of events.slice(-15))
      out.push(`  [${e.kind}] ${e.kind === 'chat' ? `${e.mine ? 'you' : e.from}: ${e.text}` : e.kind === 'story' ? `${e.title}: ${e.text}` : e.text}`);
  }
  const things = (s.things ?? []).filter((t) => !t.kind.startsWith('my hero'));
  if (things.length) {
    const shown = o.full ? things : [...things.slice(0, 14), ...things.slice(14).filter((t) => t.kind === 'exit')];
    out.push('In sight (nearest first):');
    for (const t of shown) {
      const bits = [
        t.name ? js(t.name) : '',
        t.title ? `(${t.title})` : '',
        t.kind === 'creature' || t.kind === 'friend' ? `level ${t.level}, ${t.hp}` : '',
        t.hostile ? 'hostile' : '',
        t.boss ? 'BOSS' : t.named ? 'named foe' : '',
        t.dead ? 'dead' : t.downed ? 'downed' : '',
        t.marker ? `[${t.marker}]` : '',
        t.quest ? '[quest]' : '',
        t.leadsTo ? `to ${t.leadsTo}` : '',
        t.state ?? '',
        t.statuses ? `{${t.statuses}}` : '',
        t.bark ? `says ${js(t.bark)}` : '',
      ].filter(Boolean);
      out.push(`  ${t.ref} ${t.kind} ${bits.join(' ')} · ${t.dist} m ${t.dir} (${t.x},${t.y})`);
    }
    if (shown.length < things.length) out.push(`  (${things.length - shown.length} more: "look all")`);
  }
  return out.join('\n');
}

/** The usual answer: wait for quiet, then what is seen, with why the wait ended when it was not plain quiet. */
async function after(p: Page, o: { timeout?: number; quiet?: number; minimum?: number } = {}): Promise<string> {
  const why = await settle(p, o);
  const text = describe(await snapshot(p), await takeEvents(p));
  return why === 'quiet' ? text : `(${why})\n${text}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Say `words` in the open conversation and wait for the answer to them: not just for quiet, which can come while the
 * person is still finishing what they were saying, before the words are taken up.
 */
async function speak(p: Page, words: string): Promise<string> {
  const before = await p.evaluate<number>(`window.__pt.saidCount(${js(words)})`);
  await send(p, { t: 'talk', text: words });
  const why = await p.evaluate<string>(`window.__pt.answered(${js({ words, before })})`);
  const text = await after(p, { timeout: 15000, quiet: 800, minimum: 300 });
  return why === 'answered' || why === 'the conversation ended' ? text : `(${why})
${text}`;
}

/** Where things stand, for a report: place, position, what is open, recent events. */
async function context(s: Session): Promise<string> {
  const snap = await snapshot(s.page).catch(() => null);
  if (!snap?.inGame) return `On the menus (${snap?.screen ?? '?'}).`;
  return [`${snap.place} at ${snap.at?.x},${snap.at?.y}`, snap.combat ? `in a fight, round ${snap.combat.round}` : '', snap.dialog ? `talking with ${snap.dialog.with}` : '', `adventure ${s.run.adventure}`].filter(Boolean).join('; ') + '.';
}

/**
 * What "wait" wakes for: each looks at how things were, how they are, and what happened in between, and says what it
 * saw (or nothing).
 */
const WAKE = {
  turn: (_a: Snapshot, b: Snapshot, ev: GameEvent[]) =>
    b.combat?.yourTurn ? 'your turn in the fight' : ev.some((e) => e.kind === 'fight' && /over/.test(e.text)) ? 'the fight is over' : '',
  fight: (_a: Snapshot, _b: Snapshot, ev: GameEvent[]) => ev.find((e) => e.kind === 'fight')?.text.toLowerCase().replace(/\.$/, '') ?? '',
  chat: (_a: Snapshot, _b: Snapshot, ev: GameEvent[]) => (ev.some((e) => e.kind === 'chat' && !e.mine) ? 'a chat message arrived' : ''),
  story: (a: Snapshot, b: Snapshot) => (b.narration && b.narration.text !== a.narration?.text ? 'story text is showing' : ''),
  answer: (a: Snapshot, b: Snapshot) => (a.dialog?.thinking && b.dialog && !b.dialog.thinking ? 'an answer in the conversation' : ''),
  place: (_a: Snapshot, _b: Snapshot, ev: GameEvent[]) => (ev.some((e) => e.kind === 'place') ? 'you are in a new place' : ''),
};

// ------------------------------------------------------------------------------------ the commands

export const COMMANDS: Command[] = [
  {
    name: 'look',
    summary: 'What you see now: the place, your heroes, quests, a fight, a conversation, and everything in sight with a short name (n1 a person, m1 a creature, f1 a thing, l1 loot, h1 a hero). "look marks" labels them on the screenshot; "look all" lists everything.',
    params: [{ name: 'how', description: '"marks" to label things on the screenshot, "all" to list everything', optional: true }],
    async run(s, a) {
      const snap = await snapshot(s.page);
      return describe(snap, await takeEvents(s.page), { full: a.how === 'all' });
    },
  },
  {
    name: 'walk',
    summary: 'Walk the party to something (its short name or name) or to a point "x,y" in metres. Waits until they arrive.',
    params: [{ name: 'to', description: 'a short name (n1, f2), a name, or "x,y"', rest: true }],
    async run(s, a) {
      await inGame(s.page);
      const t = await target(s.page, a.to);
      const pos = t.id ? await s.page.evaluate<{ x: number; y: number } | null>(`window.__pt.positionOf(${js(t.id)})`) : { x: t.x!, y: t.y! };
      if (!pos) throw new Error('That has no place on the map.');
      await send(s.page, { t: 'move', x: pos.x, y: pos.y });
      return after(s.page, { timeout: 30000 });
    },
  },
  {
    name: 'use',
    summary: 'Go to something and use it, as a click on it does: talk to a person, open a chest, read a sign, take an exit, pick up loot, attack a creature.',
    params: [{ name: 'thing', description: 'a short name or name', rest: true }],
    async run(s, a) {
      await inGame(s.page);
      const t = await target(s.page, a.thing);
      if (!t.id) throw new Error('"use" needs a thing, not a point: "walk" goes to a point.');
      await send(s.page, { t: 'interact', targetId: t.id });
      return after(s.page, { timeout: 40000, quiet: 900 });
    },
  },
  {
    name: 'talk',
    summary: 'Say something to a person: walks over and opens the conversation if it is not open, then speaks and waits for the answer. Without words, only opens the conversation.',
    params: [
      { name: 'who', description: 'the person (short name or name)' },
      { name: 'words', description: 'what to say, in your own words', optional: true, rest: true },
    ],
    async run(s, a) {
      await inGame(s.page);
      const t = await target(s.page, a.who);
      if (!t.id) throw new Error('Talk to whom: a person, not a point.');
      const open = await s.page.evaluate<string | null>('window.__gd.state.dialog && !window.__gd.state.dialog.ended ? window.__gd.state.dialog.npcId : null');
      if (open !== t.id) {
        await send(s.page, { t: 'interact', targetId: t.id });
        for (let i = 0; i < 300; i++) {
          const d = await s.page.evaluate<{ npcId: string; thinking: boolean } | null>('window.__gd.state.dialog');
          if (d && d.npcId === t.id && !d.thinking) break;
          await sleep(100);
        }
      }
      const words = a.words;
      return words ? speak(s.page, words) : after(s.page, { timeout: 45000, quiet: 800, minimum: 600 });
    },
  },
  {
    name: 'say',
    summary: 'Say something in the conversation that is open (or one of the suggested replies) and wait for the answer.',
    params: [{ name: 'words', description: 'what to say', rest: true }],
    async run(s, a) {
      const snap = await inGame(s.page);
      if (!snap.dialog) throw new Error('No conversation is open: "talk <person> <words>" starts one.');
      if (!a.words) throw new Error('Say what?');
      return speak(s.page, a.words);
    },
  },
  {
    name: 'bye',
    summary: 'End the conversation.',
    params: [],
    async run(s) {
      await send(s.page, { t: 'end_dialog' });
      return after(s.page);
    },
  },
  {
    name: 'trade',
    summary: 'Ask the person you are talking with to trade: their shop opens. Then "buy", "sell", and "bye".',
    params: [],
    async run(s) {
      await send(s.page, { t: 'request_trade' });
      return after(s.page, { timeout: 30000 });
    },
  },
  {
    name: 'buy',
    summary: 'Buy an item from the open shop.',
    params: [
      { name: 'item', description: 'its name or id' },
      { name: 'qty', description: 'how many', type: 'number', optional: true },
    ],
    async run(s, a) {
      const it = await item(s.page, a.item, 'trade');
      const npcId = await s.page.evaluate<string>('window.__gd.state.trade.npcId');
      await send(s.page, { t: 'buy', npcId, itemId: it.id, qty: a.qty ? Number(a.qty) : undefined });
      return after(s.page);
    },
  },
  {
    name: 'sell',
    summary: 'Sell an item from the bag to the open shop.',
    params: [
      { name: 'item', description: 'its name or id' },
      { name: 'qty', description: 'how many', type: 'number', optional: true },
    ],
    async run(s, a) {
      const it = await item(s.page, a.item);
      const npcId = await s.page.evaluate<string | null>('window.__gd.state.trade?.npcId ?? null');
      if (!npcId) throw new Error('No shop is open.');
      await send(s.page, { t: 'sell', npcId, itemId: it.id, qty: a.qty ? Number(a.qty) : undefined });
      return after(s.page);
    },
  },
  {
    name: 'take',
    summary: 'Take from the open loot window: one item, or everything ("take all").',
    params: [{ name: 'item', description: '"all", or an item name or id', rest: true, optional: true }],
    async run(s, a) {
      const snap = await inGame(s.page);
      if (!snap.loot) throw new Error('No loot window is open ("use" a chest or pile takes everything at once).');
      const sourceId = await s.page.evaluate<string>('window.__gd.state.loot.id');
      if (!a.item || a.item === 'all') await send(s.page, { t: 'take_loot', sourceId, all: true });
      else await send(s.page, { t: 'take_loot', sourceId, itemId: (await item(s.page, a.item, 'loot')).id });
      return after(s.page);
    },
  },
  {
    name: 'equip',
    summary: 'Equip an item from the bag on a hero (the leader unless named).',
    params: [
      { name: 'item', description: 'its name or id' },
      { name: 'hero', description: 'the hero (short name or name)', optional: true },
    ],
    async run(s, a) {
      const it = await item(s.page, a.item);
      await send(s.page, { t: 'equip', charId: await actor(s.page, a.hero), itemId: it.id });
      const text = await after(s.page);
      const still = (await snapshot(s.page)).bag?.some((i) => i.id === it.id);
      return `${still ? `${it.name} is still in the bag: it was not equipped.` : `Equipped ${it.name}.`}
${text}`;
    },
  },
  {
    name: 'give',
    summary: 'Give an item from the bag to another player, as the "Give to" of the pack does: out of a fight, with one of your heroes within a few meters of one of theirs. It goes into their bag (a stack: --qty says how many).',
    params: [
      { name: 'item', description: 'its name or id' },
      { name: 'to', description: 'the player (their name), or one of their heroes (short name or name)', rest: true },
      { name: 'qty', description: 'how many of a stack (all of it when not given)', type: 'number', flag: true, optional: true },
    ],
    async run(s, a) {
      const it = await item(s.page, a.item);
      const to = await s.page.evaluate<string | null>(`(() => {
        const c = window.__gd, want = ${js(a.to)}.toLowerCase();
        const friends = c.state.roster.filter((r) => r.userId !== c.state.userId);
        const hero = c.state.entities.get(window.__pt.resolve(${js(a.to)}) ?? '');
        return (hero?.ownerUserId && hero.ownerUserId !== c.state.userId ? hero.ownerUserId : null)
          ?? friends.find((r) => r.name.toLowerCase() === want || r.heroes.some((h) => h.name.toLowerCase() === want))?.userId ?? null;
      })()`);
      if (!to) throw new Error(`No other player or friend's hero called "${a.to}". The players line of "look" names them.`);
      await send(s.page, { t: 'give_item', itemId: it.id, toUserId: to, qty: a.qty as number | undefined });
      const text = await after(s.page);
      const left = (await snapshot(s.page)).bag?.find((i) => i.id === it.id);
      return `${left && left.qty === it.qty ? `${it.name} is still in the bag: it was not given.` : `Gave ${it.name}${a.qty ? ` ×${a.qty}` : ''}.`}
${text}`;
    },
  },
  {
    name: 'skill',
    summary: 'Use a skill (its id, name, or hotbar number; "attack" is the basic attack) on a target or a point. In a fight it is your hero acting now (--hero picks another of yours acting).',
    params: [
      { name: 'skill', description: 'id, name, or hotbar number' },
      { name: 'target', description: 'a short name, a name, or "x,y" (none for skills on yourself)', optional: true, rest: true },
      HERO,
    ],
    async run(s, a) {
      await inGame(s.page);
      const charId = await actor(s.page, a.hero);
      const skillId = await skill(s.page, charId, a.skill);
      const t = a.target ? await target(s.page, a.target) : {};
      if (t.id && (await s.page.evaluate<boolean>(`!!window.__gd.state.entities.get(${js(t.id)})?.dead`))) throw new Error(`${a.target} is already dead: "look" lists who is still standing.`);
      await send(s.page, { t: 'use_skill', charId, skillId, targetId: t.id, x: t.x, y: t.y });
      return after(s.page, { timeout: 30000, quiet: 900 });
    },
  },
  {
    name: 'item',
    summary: 'Use an item from the bag (a potion, a scroll) on a target, or on the acting hero.',
    params: [
      { name: 'item', description: 'its name or id' },
      { name: 'target', description: 'a short name, a name, or "x,y"', optional: true, rest: true },
      HERO,
    ],
    async run(s, a) {
      const it = await item(s.page, a.item);
      const charId = await actor(s.page, a.hero);
      const t = a.target ? await target(s.page, a.target) : {};
      await send(s.page, { t: 'use_item', charId, itemId: it.id, targetId: t.id, x: t.x, y: t.y });
      return after(s.page, { timeout: 30000 });
    },
  },
  {
    name: 'endturn',
    summary: 'End your acting hero\'s turn in a fight (--hero picks another of yours acting), then wait until it is your turn again or the fight is over. Several of your heroes can act in one turn: each ends their own.',
    params: [HERO],
    async run(s, a) {
      const charId = await actor(s.page, a.hero);
      const name = await s.page.evaluate<string>(`window.__gd.state.entities.get(${js(charId)})?.name ?? 'the hero'`);
      await send(s.page, { t: 'end_turn', charId });
      return `Ended ${name}'s turn.\n${await after(s.page, { timeout: 60000, quiet: 900 })}`;
    },
  },
  {
    name: 'flee',
    summary: 'Call the retreat on your turn, once one of your acting heroes is 7 m clear of the enemies: everyone on your side leaves the fight together, fallen friends too, and gathers out of the creatures\' reach.',
    params: [],
    async run(s) {
      await send(s.page, { t: 'flee' });
      return after(s.page, { timeout: 30000 });
    },
  },
  {
    name: 'ok',
    summary: 'Close the story text on screen (an introduction, the end of a chapter).',
    params: [],
    async run(s) {
      await s.page.evaluate('window.__gd.dismissNarration()');
      return after(s.page);
    },
  },
  {
    name: 'wait',
    summary: `Wait for something to happen, instead of sleeping: returns the moment it does, saying what. "wait" alone returns on anything that needs you (${Object.keys(WAKE).join(', ')}); "wait turn" only when it is your turn in a fight (or the fight ends), "wait chat" only for a message from another player, and so on. Gives up after the seconds given (default 60, at most 120): then simply wait again.`,
    params: [
      { name: 'for', description: `what to wait for: ${Object.keys(WAKE).join(', ')}, or "any" (the default)`, optional: true },
      { name: 'seconds', description: 'give up after this long (default 60, at most 120)', type: 'number', optional: true },
    ],
    async run(s, a) {
      // "wait 30" (the old form) is seconds.
      const [what, secs] = a.for && /^\d+$/.test(a.for) ? ['any', a.for] : [a.for ?? 'any', a.seconds];
      const wake = what === 'any' ? Object.values(WAKE) : WAKE[what as keyof typeof WAKE] ? [WAKE[what as keyof typeof WAKE]] : null;
      if (!wake) throw new Error(`Wait for what? ${Object.keys(WAKE).join(', ')}, or "any".`);
      const until = Date.now() + Math.min(120, Math.max(1, Number(secs ?? 60))) * 1000;
      const kept: GameEvent[] = [];
      let prev = await snapshot(s.page);
      let why = '';
      while (!why && Date.now() < until) {
        await sleep(250);
        const ev = await takeEvents(s.page);
        kept.push(...ev);
        const now = await snapshot(s.page);
        why = wake.map((w) => w(prev, now, ev)).find(Boolean) ?? '';
        prev = now;
      }
      return `(${why || 'nothing happened yet: wait again'})\n${describe(await snapshot(s.page), kept)}`;
    },
  },
  {
    name: 'chat',
    summary: 'Send a chat message to the other players in this adventure (people in the game, AI or human, read it in their chat). Their messages show under "Since the last command".',
    params: [{ name: 'message', description: 'the message', rest: true }],
    quiet: true,
    async run(s, a) {
      if (!a.message) throw new Error('Say what?');
      await send(s.page, { t: 'chat', text: a.message });
      await sleep(400);
      return describe(await snapshot(s.page), await takeEvents(s.page));
    },
  },
  {
    name: 'quests',
    summary: 'Every active quest with its next step.',
    params: [],
    quiet: true,
    async run(s) {
      const snap = await inGame(s.page);
      return (snap.quests ?? []).map((q) => `${q.main ? '(main) ' : ''}"${q.title}" [${q.id}]${q.next ? `: next, ${q.next}` : ''}`).join('\n') || 'No active quests.';
    },
  },
  {
    name: 'bag',
    summary: 'What is in the bag, with ids.',
    params: [],
    quiet: true,
    async run(s) {
      const snap = await inGame(s.page);
      return `${snap.gold} ${snap.currency}.\n` + ((snap.bag ?? []).map((i) => `${i.name}${i.qty ? ` ×${i.qty}` : ''} (level ${i.level}) [${i.id}]`).join('\n') || 'The bag is empty.');
    },
  },
  // ---------------------------------------------------------------- the interface itself
  {
    name: 'ui',
    summary: 'Number every button and field on screen (shown on the screenshot) and list them, for testing the interface by hand with "click".',
    params: [],
    async run(s) {
      const { items: list, away } = await s.page.evaluate<{ items: { n: number; x: number; y: number; text: string; tag: string; disabled?: boolean }[]; away: number }>('window.__pt.markUi()');
      s.uiTargets = list;
      const more = away ? `\n(${away} more scrolled out of sight: "scroll down" or "scroll up", then "ui" again)` : '';
      return `${list.length} things to press:\n` + list.map((t) => `  ${t.n}. ${t.text}${t.disabled ? ' (disabled)' : ''} [${t.tag} at ${t.x},${t.y}]`).join('\n') + more;
    },
  },
  {
    name: 'click',
    summary: 'Click a numbered thing from the last "ui", or a point "x,y" on the screen in pixels (the screenshot is 1280 by 800). "click right x,y" right-clicks.',
    params: [{ name: 'where', description: 'a number from "ui", or "x,y" in screen pixels; "right x,y" for a right click', rest: true }],
    async run(s, a) {
      const right = /^right\s+/.test(a.where ?? '');
      const where = (a.where ?? '').replace(/^right\s+/, '');
      const n = /^\d+$/.test(where) ? s.uiTargets.find((t) => t.n === Number(where)) : undefined;
      const xy = /^\s*(\d+)\s*[, ]\s*(\d+)\s*$/.exec(where);
      const at = n ?? (xy ? { x: Number(xy[1]), y: Number(xy[2]) } : null);
      if (!at) throw new Error(/^\d+$/.test(where) ? `No ${where} in the last "ui" list.` : 'Say a number from "ui" or "x,y".');
      await s.page.click(at.x, at.y, right ? 'right' : 'left');
      await sleep(700);
      const snap = await snapshot(s.page);
      return snap.inGame ? after(s.page, { minimum: 0 }) : describe(snap, []);
    },
  },
  {
    name: 'key',
    summary: 'Press a key, as on a keyboard ("i", "Escape", "Enter", "1", "ArrowUp"): the game\'s own shortcuts.',
    params: [{ name: 'key', description: 'the key' }],
    async run(s, a) {
      if (!a.key) throw new Error('Which key?');
      await s.page.key(a.key);
      await sleep(600);
      const snap = await snapshot(s.page);
      return snap.inGame ? after(s.page, { minimum: 0 }) : describe(snap, []);
    },
  },
  {
    name: 'scroll',
    summary: 'Scroll the page (or the panel under the middle of the screen) up or down by most of a screen.',
    params: [{ name: 'way', description: '"down" or "up"' }],
    async run(s, a) {
      if (a.way !== 'down' && a.way !== 'up') throw new Error('Scroll "down" or "up".');
      await s.page.evaluate(`(() => {
        const dy = (${a.way === 'down' ? 1 : -1}) * innerHeight * 0.8;
        // The innermost scrollable box under the middle of the screen, else the page.
        let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
        while (el && !(el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
        (el ?? document.scrollingElement).scrollBy({ top: dy });
      })()`);
      await sleep(300);
      return 'Scrolled: "ui" lists what is on screen now.';
    },
  },
  {
    name: 'type',
    summary: 'Type text into the field that has the focus (click it first).',
    params: [{ name: 'text', description: 'the text', rest: true }],
    async run(s, a) {
      await s.page.type(a.text ?? '');
      await sleep(300);
      return 'Typed.';
    },
  },
  {
    name: 'page',
    summary: 'Open a page of the game by its address after the "#", such as "/" (the worlds), "/adventure/<id>", or "/play/<id>".',
    params: [{ name: 'hash', description: 'the address after "#"' }],
    async run(s, a) {
      const url = new URL(await s.page.evaluate<string>('location.href'));
      url.hash = a.hash ?? '/';
      await s.page.goto(url.toString());
      await sleep(2000);
      return describe(await snapshot(s.page), []);
    },
  },
  // ---------------------------------------------------------------- underneath
  {
    name: 'send',
    summary: 'Send any message of the game\'s protocol (packages/shared/src/protocol.ts, ClientMessage) as JSON, for what no command covers.',
    params: [{ name: 'json', description: 'the message, such as {"t":"set_leader","charId":"..."}', rest: true }],
    async run(s, a) {
      await send(s.page, JSON.parse(a.json ?? '') as Record<string, unknown>);
      return after(s.page);
    },
  },
  {
    name: 'dev',
    summary: 'A developer command (DevCommand in packages/shared/src/protocol.ts) as JSON, such as {"action":"level","level":5}, {"action":"goto","zoneId":"..."}, {"action":"peace","on":true}, {"action":"info"}. Use it to reach what you want to test, not to play.',
    params: [{ name: 'json', description: 'the command', rest: true }],
    async run(s, a) {
      const r = await s.page.evaluate<{ ok: boolean; text: string; info?: unknown }>(`window.__gd.dev(${a.json ?? '{}'})`);
      const head = `${r.ok ? 'Done' : 'Refused'}: ${r.text}${r.info ? `\n${JSON.stringify(r.info)}` : ''}`;
      return `${head}\n${await after(s.page)}`;
    },
  },
  // ---------------------------------------------------------------- reports
  {
    name: 'bug',
    summary: 'Report a bug: something broken, wrong, or confusing enough to stop a player. Start with its severity (blocker, major, minor, polish), then say what you did, what happened, and what you expected. A screenshot and where you are are attached.',
    params: [
      { name: 'severity', description: 'blocker, major, minor, or polish' },
      { name: 'text', description: 'what you did, what happened, what you expected', rest: true },
    ],
    async run(s, a) {
      const severity = a.severity as Severity;
      if (!SEVERITIES.includes(severity)) throw new Error(`Severity first: ${SEVERITIES.join(', ')}.`);
      if (!a.text) throw new Error('Describe the bug.');
      const shot = s.run.shotPath('bug');
      fs.writeFileSync(shot, await s.page.screenshot());
      const n = s.run.report({ kind: 'bug', severity, text: a.text, shot, context: await context(s) });
      return { text: `Bug ${n} saved with a screenshot.`, shot };
    },
  },
  {
    name: 'feedback',
    summary: 'Give feedback on design and feel: what was fun, dull, unclear, ugly, beautiful, too hard, or too easy, and why. A screenshot is attached.',
    params: [{ name: 'text', description: 'your feedback', rest: true }],
    async run(s, a) {
      if (!a.text) throw new Error('Say what you think.');
      const shot = s.run.shotPath('feedback');
      fs.writeFileSync(shot, await s.page.screenshot());
      const n = s.run.report({ kind: 'feedback', text: a.text, shot, context: await context(s) });
      return { text: `Feedback ${n} saved with a screenshot.`, shot };
    },
  },
  {
    name: 'note',
    summary: 'Write a note in the run\'s log (what you are trying, a thought for later), with no screenshot.',
    params: [{ name: 'text', description: 'the note', rest: true }],
    quiet: true,
    async run(s, a) {
      s.run.report({ kind: 'note', text: a.text ?? '', context: await context(s) });
      return 'Noted.';
    },
  },
];

/** The commands only the driver can run: they make and end sessions. Listed with the others for help and MCP. */
export const DRIVER_COMMANDS: { name: string; summary: string; params: Param[] }[] = [
  {
    name: 'start',
    summary: 'Start playing as a player: signs in, makes or joins an adventure, makes heroes, and opens the game. Begins a run whose log and report are kept in data/playtests/.',
    params: [
      { name: 'agent', description: 'who is playing, for the run\'s name ("codex", "gemini", "claude")' },
      { name: 'world', description: 'the world\'s id or title (the first world when not given)', flag: true, optional: true },
      { name: 'adventure', description: 'an adventure id to play instead of a new one', flag: true, optional: true },
      { name: 'join', description: 'join the adventure another player of this driver is playing (their player number)', flag: true, optional: true, type: 'number' },
      { name: 'heroes', description: 'how many heroes to make (1 to 4, default 1), or "Name:class:kin,…" (a class and kin by id or name; a wrong one lists the world\'s)', flag: true, optional: true },
      { name: 'menus', description: '"yes" to begin on the game\'s menus instead of in the game, to test them', flag: true, optional: true },
    ],
  },
  {
    name: 'finish',
    summary: 'End your run with your verdict: a summary in your own words, and scores from 1 to 5. Writes the report (data/playtests/<run>/report.md) and closes your page.',
    params: [
      { name: 'fun', description: 'how fun it was, 1 to 5', type: 'number', flag: true, optional: true },
      { name: 'clarity', description: 'how clear it was what to do and how, 1 to 5', type: 'number', flag: true, optional: true },
      { name: 'looks', description: 'how good it looked, 1 to 5', type: 'number', flag: true, optional: true },
      { name: 'best', description: 'the best thing', flag: true, optional: true },
      { name: 'worst', description: 'the worst thing', flag: true, optional: true },
      { name: 'summary', description: 'your verdict in a few sentences', rest: true },
    ],
  },
  { name: 'status', summary: 'Who is playing in this driver, and where each run is written.', params: [] },
  { name: 'stop', summary: 'Close every page and stop the driver (runs not finished keep what they wrote).', params: [] },
];

export const commandByName = new Map(COMMANDS.map((c) => [c.name, c]));
