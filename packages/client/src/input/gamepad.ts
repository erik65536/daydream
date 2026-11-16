/**
 * Controller play, designed for a pad rather than a mouse adapted to one:
 *
 *   Exploring   left stick walks; the nearest person, chest, way out, or pile ahead is focused (LB/RB to change)
 *               and A acts on it; X attacks the nearest foe; Y opens the journal; d-pad up opens the map and
 *               d-pad down the inventory.
 *   Combat      a ground cursor snaps to foes (LB/RB), shows the path and cost, and A moves or attacks there;
 *               the view follows the cursor beyond the screen's edges;
 *               Y ends the turn; B flees (or backs out of aiming).
 *   Aiming      a skill or an item chosen outside a fight is aimed with the same ground cursor (padaim.ts): LB/RB
 *               snap between the heroes (for what helps) or the foes near, the stick moves it freely, A uses it
 *               there, B backs out.
 *   Anywhere    hold RT for the skill wheel and LT for the menu wheel (pick with either stick, release to
 *               choose); d-pad left/right switches character; right stick zooms; Menu opens the game menu;
 *               View puts a focus ring on the party display, to read everyone's Health and statuses (B leaves);
 *               Chat on the menu wheel opens the chat history (the right stick scrolls it, B leaves).
 *   Talking     Y speaks to the person (Y again, or a pause, finishes); A picks a suggested reply.
 *   Windows     the d-pad or left stick moves a focus ring between controls, A presses, X opens an item's
 *               actions, LB/RB switch tabs, B goes back.
 */
import { isHarmful, itemSkill, nearestOnWay, rx, type EntityView, type SkillDef } from '@daydream/shared';
import type { GameClient, WheelItem } from '../net/game';
import type { HoverInfo, Renderer } from '../render/renderer';
import { featureUsable } from '../render/features';
import { hasCrafting } from '../ui/common';
import { aimPool, aimsAtAllies, nudge, snapNext, under } from './padaim';
import { PadNav } from './spatial';
import { Steer } from './steer';

const B = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const;
const DEAD = 0.28;
const PANELS: { id: NonNullable<GameClient['state']['panel']> | 'chat'; label: string }[] = [
  { id: 'inventory', label: 'Pack' },
  { id: 'character', label: 'Character' },
  { id: 'skills', label: 'Talents' },
  { id: 'quests', label: 'Journal' },
  { id: 'map', label: 'Map' },
  { id: 'craft', label: 'Crafting' },
  { id: 'codex', label: 'Codex' },
  { id: 'chat', label: 'Chat' },
  { id: 'menu', label: 'Menu' },
];

interface Target { info: HoverInfo; verb: string; name: string; x: number; y: number; hostile?: boolean }

export class PadInput {
  private raf = 0;
  private prev: boolean[] = [];
  private heading = { x: -1, y: 0 };
  private focusIdx = 0;
  private cursor: { x: number; y: number } | null = null;
  private repeatAt = 0;
  private nav = new PadNav();
  private walk: Steer;
  private r: Renderer;
  private c: GameClient;
  private act: (info: HoverInfo, button: number) => void;

  constructor(r: Renderer, c: GameClient, act: (info: HoverInfo, button: number) => void) {
    this.r = r;
    this.c = c;
    this.act = act;
    this.walk = new Steer(r, c);
    this.raf = requestAnimationFrame(this.tick);
    window.addEventListener('gamepadconnected', this.connected);
    window.addEventListener('gamepaddisconnected', this.disconnected);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('gamepadconnected', this.connected);
    window.removeEventListener('gamepaddisconnected', this.disconnected);
    this.rest();
  }

  private connected = () => this.c.toast('Controller connected. Hold RT for skills, LT for menus.', 'info');
  private disconnected = () => this.read();

  /**
   * The controller is put down (the mouse or a finger plays now) or gone: the walk it steered stops, and its focus,
   * cursor, prompt and wheel leave the screen, so nothing of it stays over what the player now uses.
   */
  private rest() {
    this.walk.stop();
    this.nav.clear();
    this.cursor = null;
    if (this.r.padHover) this.r.setPadHover(null);
    const st = this.c.state;
    if (st.padPrompt || st.wheel) this.c.update({ padPrompt: null, wheel: null });
  }

  private tick = () => {
    this.raf = requestAnimationFrame(this.tick);
    this.read();
  };

  private read() {
    const pad = [...(navigator.getGamepads?.() ?? [])].find((p) => p && p.connected);
    if (!pad) {
      // Unplugged, or its battery ran out: whatever it was doing ends.
      if (this.prev.length) this.rest();
      this.prev = [];
      return;
    }
    const down = pad.buttons.map((b) => b.pressed || b.value > 0.5);
    const pressed = (i: number) => down[i] && !this.prev[i];
    const released = (i: number) => !down[i] && this.prev[i];
    const lx = pad.axes[0] ?? 0, ly = pad.axes[1] ?? 0, rxs = pad.axes[2] ?? 0, rys = pad.axes[3] ?? 0;
    const any = down.some(Boolean) || Math.hypot(lx, ly) > DEAD || Math.hypot(rxs, rys) > DEAD;
    if (any && this.c.state.inputMode !== 'pad') this.c.update({ inputMode: 'pad' });
    try {
      this.step(down, pressed, released, { lx, ly, rx: rxs, ry: rys });
    } finally {
      this.prev = down;
    }
  }

  private step(down: boolean[], pressed: (i: number) => boolean, released: (i: number) => boolean, s: { lx: number; ly: number; rx: number; ry: number }) {
    const c = this.c, st = c.state;
    if (st.status !== 'connected' || !st.player) return;
    // A controller lying on the desk leaves the game to whatever the player uses now.
    if (st.inputMode !== 'pad') return this.rest();

    // Radial wheels: hold a trigger, aim with a stick, release to choose.
    if (st.wheel) {
      const ax = Math.hypot(s.rx, s.ry) > 0.5 ? s.rx : s.lx, ay = Math.hypot(s.rx, s.ry) > 0.5 ? s.ry : s.ly;
      if (Math.hypot(ax, ay) > 0.5) {
        const n = st.wheel.items.length;
        const ang = (Math.atan2(ax, -ay) + Math.PI * 2) % (Math.PI * 2);
        const sel = Math.round(ang / ((Math.PI * 2) / n)) % n;
        if (sel !== st.wheel.sel) c.update({ wheel: { ...st.wheel, sel } });
      }
      const trigger = st.wheel.kind === 'skills' ? B.RT : B.LT;
      if (released(trigger) || pressed(B.A)) this.chooseWheel();
      else if (pressed(B.B)) c.update({ wheel: null });
      return;
    }

    // Windows, conversations, and story cards: move a focus ring between their controls.
    const modal = st.narrations.length > 0 || !!st.panel || !!st.dialog || !!st.trade || !!st.loot || st.partyFocus || st.historyOpen;
    if (modal) {
      this.walk.stop();
      this.r.setPadHover(null);
      if (st.padPrompt) c.update({ padPrompt: null });
      // In a conversation, Y speaks (and finishes speaking): a controller has no keyboard to hand.
      if (st.dialog && !st.trade && pressed(B.Y)) {
        document.querySelector<HTMLButtonElement>('.composer .say.listening .btn.primary:not(:disabled), .composer .btn.mic:not(:disabled)')?.click();
        return;
      }
      if (st.partyFocus && !st.panel && pressed(B.VIEW)) return c.update({ partyFocus: false });
      this.nav.step(down, pressed, { x: s.lx, y: s.ly }, s.ry);
      return;
    }
    this.nav.clear();

    if (pressed(B.MENU)) return c.update({ panel: 'menu' });
    if (pressed(B.VIEW)) return c.update({ partyFocus: true });
    if (pressed(B.UP)) return c.update({ panel: 'map' });
    if (pressed(B.DOWN)) return c.update({ panel: 'inventory' });
    if (pressed(B.LEFT) || pressed(B.RIGHT)) return this.switchCharacter(pressed(B.RIGHT) ? 1 : -1);
    if (Math.abs(s.ry) > 0.5) this.r.zoomBy(s.ry > 0 ? 0.985 : 1.015);
    if (pressed(B.RT)) return this.openSkills();
    if (pressed(B.LT)) {
      // The windows, and who decides the hero's turns in a fight (the one whose turn it is, or the one selected).
      const hero = this.actingChar();
      const own = hero ? [{ id: 'own', icon: 'own', label: hero.ai ? `Take command of ${hero.name}` : `Let ${hero.name} fight on their own`, sub: 'Out of fights they follow you either way' }] : [];
      return c.update({ wheel: { kind: 'panels', items: [...PANELS.filter((p) => p.id !== 'craft' || this.crafting()).map((p) => ({ id: p.id!, label: p.label, icon: p.id! })), ...own], sel: 0 } });
    }

    if (st.combat) {
      this.walk.stop();
      this.combat(pressed, s);
    } else this.explore(pressed, s);
  }

  // ---------------------------------------------------------------------------- exploring

  private explore(pressed: (i: number) => boolean, s: { lx: number; ly: number }) {
    const c = this.c, st = c.state;
    const lead = c.leaderEntity();
    if (!lead) return;
    // Aiming a skill or an item: the fight's ground cursor, about the hero who uses it.
    if (st.targeting) {
      this.walk.stop();
      const { info, on, skill } = this.aimCursor(pressed, s, st.entities.get(st.targeting.charId) ?? lead, false);
      this.prompt(this.useVerb(skill) ?? 'Use', on?.name ?? '');
      if (pressed(B.A)) this.act(info, 0);
      if (pressed(B.B)) c.update({ targeting: null });
      return;
    }
    this.cursor = null;
    const mag = Math.hypot(s.lx, s.ly);
    if (mag > DEAD) {
      // Steering: the server keeps the party walking this way (see steer.ts).
      this.heading = { x: s.lx / mag, y: s.ly / mag };
      this.walk.go(this.heading);
    } else this.walk.stop();

    // Focus: what A would act on.
    const targets = this.nearby(lead);
    if (pressed(B.RB)) this.focusIdx++;
    if (pressed(B.LB)) this.focusIdx--;
    const t = targets.length ? targets[((this.focusIdx % targets.length) + targets.length) % targets.length] : undefined;
    this.r.setPadHover(t?.info ?? null);
    const prompt = t ? this.promptAt(t.verb, t.name, t.x, t.y) : null;
    if (JSON.stringify(prompt) !== JSON.stringify(st.padPrompt)) c.update({ padPrompt: prompt });
    if (pressed(B.A) && t) {
      this.walk.stop();
      this.act(t.info, 0);
    }
    if (pressed(B.X)) {
      const foe = targets.find((x) => x.hostile) ?? this.nearestFoe(lead, 9);
      if (foe) this.act(foe.info, 0);
    }
    if (pressed(B.Y)) c.update({ panel: 'quests' });
  }

  /** Things to act on near the leader, best first: close, and ahead of where the party is heading. */
  private nearby(lead: { x: number; y: number; id: string }): Target[] {
    const st = this.c.state;
    const out: (Target & { score: number })[] = [];
    const score = (x: number, y: number) => {
      const dx = x - lead.x, dy = y - lead.y, d = Math.hypot(dx, dy);
      const ahead = d > 0.01 ? (dx * this.heading.x + dy * this.heading.y) / d : 1;
      return d - ahead * 0.8;
    };
    for (const e of st.entities.values()) {
      if (e.id === lead.id || e.dead || e.ownerUserId === st.userId) continue;
      const d = Math.hypot(e.x - lead.x, e.y - lead.y);
      if (e.hostile && d < 7) out.push({ info: this.r.hoverAt(e, { entityId: e.id }), verb: 'Attack', name: e.name, x: e.x, y: e.y, hostile: true, score: score(e.x, e.y) + 1.5 });
      else if (e.kind === 'npc' && !e.hostile && d < 3.2) out.push({ info: this.r.hoverAt(e, { entityId: e.id }), verb: 'Talk', name: e.name, x: e.x, y: e.y, score: score(e.x, e.y) });
    }
    for (const f of st.zone?.features ?? []) {
      // (A way out at the map's edge is offered anywhere along its road.)
      const at = f.kind === 'exit' ? nearestOnWay(this.r.wayOf(f), lead) : f;
      if (!featureUsable(f, st.features.get(f.id)) || Math.hypot(at.x - lead.x, at.y - lead.y) > 2.6) continue;
      const verbs: Record<string, string> = { chest: 'Open', exit: 'Travel', sign: 'Read', lore: 'Read', craft_station: 'Craft', storage: 'Storage', waypoint: 'Waypoint' };
      const verb = verbs[f.kind] ?? 'Use';
      out.push({ info: this.r.hoverAt(at, { featureId: f.id }), verb, name: f.name ?? f.kind, x: at.x, y: at.y, score: score(at.x, at.y) });
    }
    for (const l of st.lootPiles) {
      if (Math.hypot(l.x - lead.x, l.y - lead.y) > 2.6) continue;
      out.push({ info: this.r.hoverAt(l, { lootId: l.id }), verb: 'Take', name: this.c.lootSummary(l).text, x: l.x, y: l.y, score: score(l.x, l.y) - 0.3 });
    }
    return out.sort((a, b) => a.score - b.score);
  }

  private nearestFoe(from: { x: number; y: number }, within: number): Target | undefined {
    let best: Target | undefined, bd = within;
    for (const e of this.c.state.entities.values()) {
      if (!e.hostile || e.dead) continue;
      const d = Math.hypot(e.x - from.x, e.y - from.y);
      if (d < bd) {
        bd = d;
        best = { info: this.r.hoverAt(e, { entityId: e.id }), verb: 'Attack', name: e.name, x: e.x, y: e.y, hostile: true };
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------------- combat

  private combat(pressed: (i: number) => boolean, s: { lx: number; ly: number }) {
    const c = this.c, st = c.state;
    if (!c.isMyTurn()) {
      this.r.setPadHover(null);
      if (st.padPrompt) c.update({ padPrompt: null });
      this.cursor = null;
      return;
    }
    const active = st.entities.get(c.myActor() ?? st.combat!.activeId);
    if (!active) return;
    const { info, on, skill } = this.aimCursor(pressed, s, active, true);
    this.prompt(this.useVerb(skill) ?? (on?.hostile ? 'Attack' : on ? '' : 'Move'), on?.name ?? '');
    if (pressed(B.A)) this.act(info, 0);
    const foe = pressed(B.X) ? aimPool(st.entities.values(), active, false, true)[0] : undefined;
    if (foe) this.act(this.r.hoverAt(foe, { entityId: foe.id }), 0);
    if (pressed(B.Y)) c.send({ t: 'end_turn', charId: c.myActor() });
    // B backs out of aiming; with nothing to back out of, it flees (when no foe is near).
    if (pressed(B.B)) {
      if (st.targeting) c.update({ targeting: null });
      else c.send({ t: 'flee' });
    }
  }

  /** What is being aimed, as a skill: the skill chosen, or the skill an item's use is. */
  private aimed(): SkillDef | undefined {
    const st = this.c.state, t = st.targeting;
    if (!t) return undefined;
    const ix = rx(this.c.r);
    if (t.skillId) return ix.skill.get(t.skillId);
    const item = st.player?.inventory.find((i) => i.id === t.itemId);
    const base = item ? ix.item.get(item.baseId) : undefined;
    return base?.use ? itemSkill(base) : undefined;
  }

  /**
   * The ground cursor, in a fight and aiming outside one: it starts on the nearest of those what is aimed is for
   * (else on `from`, who acts), LB/RB snap between them, and the stick moves it freely. Returns what it points at,
   * whom it is on, and what is being aimed.
   */
  private aimCursor(pressed: (i: number) => boolean, s: { lx: number; ly: number }, from: EntityView, fighting: boolean) {
    const st = this.c.state, skill = this.aimed();
    // Snapping goes between those the skill is for: allies for one that helps (on one or on the ground among them), else foes.
    const pool = aimPool(st.entities.values(), from, aimsAtAllies(this.c.r, skill), fighting);
    if (!this.cursor) {
      const first = pool[0] ?? from;
      this.cursor = { x: first.x, y: first.y };
    }
    // Snap between targets.
    if (pressed(B.RB) || pressed(B.LB)) {
      const next = snapNext(pool, this.cursor, pressed(B.RB) ? 1 : -1);
      if (next) this.cursor = { x: next.x, y: next.y };
    }
    // Free cursor: a meter per push, repeating while held.
    const now = performance.now();
    if (Math.hypot(s.lx, s.ly) > 0.45) {
      if (now >= this.repeatAt) {
        this.cursor = nudge(this.cursor, s.lx, s.ly);
        this.repeatAt = now + (this.repeatAt === 0 ? 220 : 95);
      }
    } else this.repeatAt = 0;
    // The view goes where the cursor goes, so a foe beyond the screen can be found and aimed at (in a fight: outside
    // one the view stays with the party).
    this.r.keepInView(this.cursor);
    const on = under(st.entities.values(), this.cursor);
    const info = this.r.hoverAt(this.cursor, on ? { entityId: on.id } : {});
    this.r.setPadHover(info);
    return { info, on, skill };
  }

  /**
   * What A would do with what is aimed: use it, or nothing where the view's verdict says it cannot be used (the note
   * beside the cursor says why: out of range, no line of sight). Undefined while nothing is aimed.
   */
  private useVerb(skill: SkillDef | undefined): string | undefined {
    if (!skill) return undefined;
    const verdict = this.r.aim;
    return verdict?.center && !verdict.ok ? '' : `Use ${skill.name}`;
  }

  /** Show the button prompt over the cursor (none for an empty verb). */
  private prompt(verb: string, name: string) {
    const prompt = verb && this.cursor ? this.promptAt(verb, name, this.cursor.x, this.cursor.y) : null;
    if (JSON.stringify(prompt) !== JSON.stringify(this.c.state.padPrompt)) this.c.update({ padPrompt: prompt });
  }

  /** A button prompt placed above a spot on the map, in screen pixels (rounded so it only updates when it moves). */
  private promptAt(verb: string, name: string, x: number, y: number) {
    const p = this.r.groundToScreen(x, y);
    return { verb, name, x: Math.round(p.x), y: Math.round(p.y) };
  }

  // ---------------------------------------------------------------------------- wheels and party

  private crafting() {
    const r = this.c.state.world?.ruleset;
    return !!r && hasCrafting(r);
  }

  private actingChar() {
    const st = this.c.state;
    const id = st.combat ? this.c.myActor() ?? st.combat.activeId : st.selectedCharId ?? st.player?.leaderId;
    return st.player?.party.find((p) => p.id === id) ?? st.player?.party[0];
  }

  private openSkills() {
    const ch = this.actingChar();
    if (!ch) return;
    const ix = rx(this.c.r);
    const items: WheelItem[] = ch.hotbar.filter((x): x is string => !!x).slice(0, 10).map((id) => {
      const sk = ix.skill.get(id);
      return { id, label: sk?.name ?? id, sub: sk ? `${sk.ap} ${this.c.r.terminology.actionPoints}` : '', icon: id, disabled: (ch.cooldowns?.[id] ?? 0) > 0 };
    });
    if (items.length) this.c.update({ wheel: { kind: 'skills', items, sel: 0 } });
  }

  private chooseWheel() {
    const c = this.c, w = c.state.wheel!;
    const item = w.items[w.sel];
    c.update({ wheel: null });
    if (!item || item.disabled) return;
    if (w.kind === 'panels' && item.id === 'own') {
      const hero = this.actingChar();
      return void (hero && c.send({ t: 'set_ai', charId: hero.id, ai: !hero.ai }));
    }
    if (w.kind === 'panels' && item.id === 'chat') return c.update({ historyOpen: true });
    if (w.kind === 'panels') return c.update({ panel: item.id as GameClient['state']['panel'] });
    const ch = this.actingChar();
    if (!ch) return;
    const sk = rx(c.r).skill.get(item.id);
    if (sk?.targeting === 'self') return c.send({ t: 'use_skill', charId: ch.id, skillId: item.id });
    c.update({ targeting: { charId: ch.id, skillId: item.id } });
    // Aim at the nearest fitting target straight away.
    this.cursor = null;
    if (!c.state.combat) {
      const lead = c.leaderEntity();
      const foe = lead ? this.nearestFoe(lead, 12) : undefined;
      if (foe && (sk?.targeting === 'enemy' || (sk?.targeting === 'ground' && isHarmful(c.r, sk.effects)))) {
        this.act(foe.info, 0);
      }
    }
  }

  private switchCharacter(dir: 1 | -1) {
    const st = this.c.state;
    if (!st.player || st.combat) return;
    const party = st.player.party;
    const i = party.findIndex((p) => p.id === (st.selectedCharId ?? st.player!.leaderId));
    const next = party[(i + dir + party.length) % party.length]!;
    this.c.update({ selectedCharId: next.id });
    this.c.send({ t: 'set_leader', charId: next.id });
  }
}
