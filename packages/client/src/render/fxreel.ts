/**
 * The effects reel: every kind of combat effect, played one after another on the hero and the figures near them, with
 * a caption saying what each should look like, so a person can check by eye that they read well and nothing is off.
 * It feeds made-up events through the same path as the server's (`GameClient.playFx`), and briefly gives figures
 * statuses on this screen only; nothing is sent to the server. Admins start it from the developer
 * panel (Creatures) or with `window.__gd.fxReel()`.
 */
import { FX_BLASTS, FX_RUSHES, FX_SHOTS, type DamageEvent, type EntityView, type FxEvent, type FxMoves } from '@daydream/shared';
import type { GameClient } from '../net/game';
import { rules } from '../rules';

let running: { stop: boolean } | null = null;

const sleep = (s: number) => new Promise<void>((r) => setTimeout(r, s * 1000));

export async function playFxReel(c: GameClient) {
  if (running) {
    running.stop = true;
    return;
  }
  const run = { stop: false };
  running = run;
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999;padding:8px 14px;border-radius:8px;background:rgba(10,12,30,0.82);color:#fff;font:600 15px Inter,sans-serif;max-width:min(92vw,640px);text-align:center;pointer-events:none';
  document.body.appendChild(box);
  const restore: (() => void)[] = [];
  try {
    await reel(c, run, (text) => (box.textContent = text), restore);
  } finally {
    for (const f of restore.reverse()) f();
    box.remove();
    running = null;
  }
}

async function reel(c: GameClient, run: { stop: boolean }, say: (t: string) => void, restore: (() => void)[]) {
  const st = c.state;
  const r = rules();
  const hero = st.entities.get(st.selectedCharId ?? '');
  if (!hero || !r) return say('No hero to show effects on.');
  const at = (e: EntityView) => c.entityPos(e);
  const h = at(hero);
  // The figures nearest the hero stand in as targets (anyone: people, creatures, the party).
  const near = [...st.entities.values()]
    .filter((e) => e.id !== hero.id && !e.dead && (e.kind === 'monster' || e.kind === 'npc' || e.kind === 'character'))
    .map((e) => ({ e, d: Math.hypot(at(e).x - h.x, at(e).y - h.y) }))
    .filter((x) => x.d < 9)
    .sort((a, b) => a.d - b.d)
    .map((x) => x.e);
  const [t1, t2 = t1, t3 = t2] = near;
  if (!t1) return say('Stand within a few steps of someone (a person or a creature) to play the reel.');

  const fx = (...events: FxEvent[]) => c.playFx(events);
  const hit = (target: EntityView, type: string, share: number, more: Partial<DamageEvent> = {}, from = hero): FxEvent => ({
    kind: 'damage', sourceId: from.id, targetId: target.id,
    damage: { targetId: target.id, type, amount: Math.max(1, Math.round(share * target.maxHp)), share, ...more },
  });
  /** Show a caption, play what `f` does, and wait. */
  const scene = async (text: string, f: () => void | Promise<void>, wait = 1.6) => {
    if (run.stop) throw new Error('stopped');
    say(text);
    await f();
    await sleep(wait);
  };
  /**
   * Give a figure something on this screen only, until the reel ends. The server's updates replace a figure's view,
   * so what is lent is laid over each one; at the end the figure gets its own values back.
   */
  const lent = new Map<string, Partial<EntityView>>(), own = new Map<string, Partial<EntityView>>();
  const overlay = () => {
    for (const [id, v] of lent) {
      const e = st.entities.get(id);
      if (e) Object.assign(e, v);
    }
  };
  const unsubscribe = c.subscribe(overlay);
  restore.push(() => {
    unsubscribe();
    for (const [id, v] of own) {
      const e = st.entities.get(id);
      if (e) Object.assign(e, v);
    }
  });
  const lend = <K extends keyof EntityView>(e: EntityView, key: K, value: EntityView[K]) => {
    const mine = own.get(e.id) ?? {};
    if (!(key in mine)) mine[key] = e[key];
    own.set(e.id, mine);
    lent.set(e.id, { ...lent.get(e.id), [key]: value });
    overlay();
  };

  const name = (id: string) => r.damageTypes.find((d) => d.id === id)?.name ?? id;
  const kinds = r.damageTypes.map((d) => d.id).slice(0, 10);
  /** Show a kind of damage moving another way than its world chose, on this screen until the reel ends. */
  const ownMoves = { ...r.looks.moves };
  restore.push(() => (r.looks.moves = ownMoves));
  const moveAs = (k: string, m: Partial<FxMoves>) => (r.looks.moves = { ...r.looks.moves, [k]: { ...(ownMoves[k] ?? { rush: 'dash', shot: 'orb', blast: 'ring' }), ...m } });
  /** Beside a figure, on the hero's side of it: where a rush at it lands. */
  const beside = (e: EntityView) => {
    const p = at(e), d = Math.hypot(h.x - p.x, h.y - p.y) || 1;
    return { x: p.x + ((h.x - p.x) / d) * 0.9, y: p.y + ((h.y - p.y) / d) * 0.9 };
  };

  try {
    await scene(`The effects reel: ${kinds.length} kinds of damage, healing, statuses, kills. Press the button again to stop.`, () => {}, 2.2);
    for (const k of kinds) {
      const n = name(k);
      await scene(`${n}: a scratch (4% of Health). A few flecks and a small number; no shake.`, () => fx(hit(t1, k, 0.04)), 1.3);
      await scene(`${n}: a heavy melee blow (22%). A slash, a full burst, the target flashes and is knocked back.`, () => fx({ kind: 'skill', sourceId: hero.id, targetId: t1.id, fx: 'slash', element: k }, hit(t1, k, 0.22)), 1.5);
      await scene(`${n}: thrown (15%), as this world's ${r.looks.moves[k]?.shot ?? 'shot'}. It carries the look and trail; the hit shows only when it lands.`, () => fx({ kind: 'projectile', sourceId: hero.id, targetId: t2.id, fx: 'bolt', element: k }, hit(t2, k, 0.15)), 1.7);
      await scene(`${n}: a rush, as this world's ${r.looks.moves[k]?.rush ?? 'rush'}. The hero crosses to the foe and the blow lands on arrival.`, () => fx({ kind: 'skill', sourceId: hero.id, targetId: t1.id, x: h.x, y: h.y, fx: 'slash', element: k, land: beside(t1) }, hit(t1, k, 0.15)), 1.8);
      await scene(`${n}: a heavy crit (35%). Big number with "!", the action holds a moment and the view shakes.`, () => fx(hit(t1, k, 0.35, { crit: true })), 1.9);
    }
    const k0 = kinds[0]!;
    // Every way a skill can move, whatever this world chose, in the colors of its last kind of damage.
    const kl = kinds[kinds.length - 1]!;
    const RUSH: Record<(typeof FX_RUSHES)[number], string> = { dash: 'runs low in a cloud of dust', blur: 'leaves fading copies behind', blink: 'vanishes in a puff and reappears beside the foe', streak: 'flies as a bright streak that lingers', leap: 'leaps in an arc and lands hard (a ring, dust, and a small shake)' };
    for (const rush of FX_RUSHES) {
      moveAs(kl, { rush });
      await scene(`Rush "${rush}": ${RUSH[rush]}; the blow lands on arrival.`, () => fx({ kind: 'skill', sourceId: hero.id, targetId: t1.id, x: h.x, y: h.y, fx: 'slash', element: kl, land: beside(t1) }, hit(t1, kl, 0.14)), 1.9);
    }
    const SHOT: Record<(typeof FX_SHOTS)[number], string> = { arrow: 'a fast shaft', orb: 'a ball of the look with its trail', lob: 'an arcing throw with a shadow under it', bolt: 'a jagged flash, at once', ray: 'a steady beam that swells and thins away', swarm: 'a stream of small shapes weaving to the target' };
    for (const shot of FX_SHOTS) {
      moveAs(kl, { shot });
      await scene(`Shot "${shot}": ${SHOT[shot]}; the hit shows when it lands.`, () => fx({ kind: 'projectile', sourceId: hero.id, targetId: t2.id, fx: 'bolt', element: kl }, hit(t2, kl, 0.14)), 1.8);
    }
    const BLAST: Record<(typeof FX_BLASTS)[number], string> = { ring: 'a ring spreading over the ground', pillar: 'a column bursting up from the ground', rain: 'a shower falling from above', vortex: 'drawn in, then bursting', quake: 'shock rings, thrown dust, and a small shake' };
    for (const blast of FX_BLASTS) {
      moveAs(kl, { blast });
      await scene(`Blast "${blast}": ${BLAST[blast]}, hitting two.`, () => fx({ kind: 'projectile', sourceId: hero.id, x: h.x, y: h.y, tx: at(t2).x, ty: at(t2).y, fx: 'bolt', radius: 2, element: kl }, hit(t2, kl, 0.14), hit(t3, kl, 0.1)), 2.2);
    }
    r.looks.moves = ownMoves;
    await scene('A beam (a creature\'s jagged flash): drawn at once from hand to target.', () => fx({ kind: 'projectile', sourceId: hero.id, targetId: t1.id, fx: 'beam', element: kinds[1] ?? k0 }, hit(t1, kinds[1] ?? k0, 0.18)), 1.6);
    await scene('A miss: only the word "Miss".', () => fx(hit(t1, k0, 0.1, { miss: true })), 1.3);

    await scene('Healing, small (5%): a few rising green motes and a green number.', () => fx(hit(hero, 'heal', 0.05, {}, hero)), 1.4);
    await scene('Healing, large (40%): a fuller rise of motes.', () => fx(hit(hero, 'heal', 0.4, {}, hero)), 1.6);

    for (const [f, text] of [
      ['nova', 'A nova: a ring around the caster and a burst outward.'],
      ['cloud', 'A cloud: smoke and drifting motes where it is cast.'],
      ['shadow', 'Magic up close: a swirl of the kind\'s look, a little smoke, and a sweep across the target.'],
      ['buff', 'A buff on an ally: rising motes (in its status\'s look when the skill brings one).'],
      ['debuff', 'A weakening on a foe: falling motes (in its status\'s look when the skill brings one).'],
      ['heal', 'An area heal: green motes rising over the area.'],
    ] as const)
      await scene(text, () => fx({ kind: 'skill', sourceId: hero.id, ...(f === 'nova' || f === 'heal' ? { tx: h.x, ty: h.y } : { tx: at(t1).x, ty: at(t1).y }), fx: f, radius: f === 'nova' || f === 'heal' || f === 'cloud' ? 2 : undefined, element: kinds[1] ?? k0 }), 1.8);

    const statuses = r.statuses.slice(0, 8);
    for (const s of statuses)
      await scene(`Status "${s.name}" (${s.harmful === false ? 'helpful' : 'harmful'}): now and then a mote of it drifts about the figure; quiet, not a constant spray.`, () => lend(t1, 'statuses', [{ id: s.id, turns: 2, power: 1 }]), 2.6);
    lend(t1, 'statuses', []);
    await scene('Two statuses at once: motes of both, still quiet.', () => lend(t2, 'statuses', statuses.slice(0, 2).map((s) => ({ id: s.id, turns: 2, power: 1 }))), 2.8);
    lend(t2, 'statuses', []);

    await scene('A creature falls (fatal hit): burst, a ring on the ground, smoke.', () => fx(hit(t2, k0, 0.25, { fatal: true }), { kind: 'death', targetId: t2.id }), 2);
    await scene('A boss falls: a bigger burst and ring; the action holds and the view shakes.', () => {
      lend(t1, 'bossId', 'reel');
      fx(hit(t1, kinds[1] ?? k0, 0.3, { fatal: true, crit: true }), { kind: 'death', targetId: t1.id });
    }, 2.4);
    lend(t1, 'bossId', undefined);
    await scene('Downed: the hero falls and lies still.', () => lend(hero, 'downed', true), 1.6);
    await scene('Getting up: healing rises about them and they stand up again (a painted fall plays backwards).', () => lend(hero, 'downed', false), 2.2);
    await scene('Level up: golden motes rising and a large "Level up!".', () => fx({ kind: 'levelup', targetId: hero.id, text: 'Level up!' }), 2.2);

    await scene('A busy round: many hits on several figures within two seconds. Still readable, nothing stuck on screen.', async () => {
      for (let i = 0; i < 18 && !run.stop; i++) {
        const k = kinds[i % kinds.length]!, t = [t1, t2, t3][i % 3]!;
        fx(i % 3 === 1 ? { kind: 'projectile', sourceId: hero.id, targetId: t.id, fx: 'bolt', element: k } : { kind: 'skill', sourceId: hero.id, targetId: t.id, fx: 'slash', element: k }, hit(t, k, 0.03 + (i % 4) * 0.05, { crit: i % 7 === 3 }));
        await sleep(0.11);
      }
    }, 2.5);
    say('The end of the reel.');
    await sleep(1.5);
  } catch (e) {
    if ((e as Error).message !== 'stopped') throw e;
  }
}
