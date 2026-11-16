/** Developer commands (administrators only): testing any part of the game without playing up to it. */
import {
  BitSet, currentWays, GAME_MINUTES_PER_DAY, treePointsAt, xpForLevel, fogSize, knownSkills, rx, uid,
  type ClientMessage, type DevCommand, type DevInfo, type PlayerState, type MonsterRuntime, type SpawnDef,
} from '@daydream/shared';
import { Actor, MonsterActor } from './actors.ts';
import { isHostileTo } from './effects.ts';
import { makeItem, makeUnique } from './loot.ts';
import { restoreFully } from './characters.ts';
import type { Adventure } from './adventure.ts';

/** What this part of an adventure uses of the rest of it. */
type DevCommandsHost = Pick<
  Adventure,
  'broadcastZone' | 'charActors' | 'combatOf' | 'combats' | 'ctx' | 'day' | 'fightOf' | 'grantPartyXp'
  | 'hour' | 'items' | 'leader' | 'markAll' | 'markDirty' | 'markPlayer' | 'nearestFree' | 'newDay'
  | 'onDowned' | 'passable' | 'places' | 'questDef' | 'quests' | 'r' | 'rng' | 'sendClock'
  | 'sendTo' | 'state' | 'transfer' | 'world' | 'zonePayload' | 'zones'
>;

export class DevCommands {
  private h: DevCommandsHost;
  constructor(h: DevCommandsHost) {
    this.h = h;
  }

  /** Developer options (the server only lets admins send these): creatures leave these players alone. */
  devPeace = new Set<string>();

  /** Developer option: these players' parties take no damage. */
  devGod = new Set<string>();

  /** Step out of any fight at once (developer options). */
  private leaveCombat(p: PlayerState) {
    for (const c of this.h.charActors(p)) {
      const combat = this.h.combatOf(c);
      if (combat) combat.remove(c);
    }
    this.h.sendTo(p.userId, { t: 'combat', combat: null });
  }

  cmdDev(p: PlayerState, msg: Extract<ClientMessage, { t: 'dev' }>) {
    let out: { ok: boolean; text: string; info?: DevInfo };
    try {
      out = this.devCommand(p, msg);
    } catch (e) {
      out = { ok: false, text: e instanceof Error ? e.message : String(e) };
    }
    this.h.markPlayer(p.userId);
    this.h.markDirty();
    this.h.sendTo(p.userId, { t: 'dev_result', reqId: msg.reqId, ...out });
  }

  /** Runs one developer command; a refusal is `ok: false` with the reason. */
  private devCommand(p: PlayerState, cmd: DevCommand): { ok: boolean; text: string; info?: DevInfo } {
    const ok = (text: string) => ({ ok: true, text });
    const no = (text: string) => ({ ok: false, text });
    const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : null);
    const chars = (charId?: string) => (charId ? p.party.filter((c) => c.id === charId) : p.party);
    const story = this.h.state;
    const refresh = () => {
      for (const a of this.h.charActors(p)) a.dirty = true;
    };
    switch (cmd.action) {
      case 'peace':
        if (cmd.on) this.devPeace.add(p.userId);
        else this.devPeace.delete(p.userId);
        if (cmd.on) this.leaveCombat(p);
        return ok(cmd.on ? 'Peaceful: creatures ignore you.' : 'Creatures notice you again.');
      case 'god':
        if (cmd.on) this.devGod.add(p.userId);
        else this.devGod.delete(p.userId);
        return ok(cmd.on ? 'God mode: the party takes no damage.' : 'God mode off.');
      case 'reload':
        // The socket handler closes the connection and loads the world again.
        return ok('Reloading the world.');
      case 'goto': {
        const def = this.h.ctx.zones.get(cmd.zoneId);
        if (!def) return no(`No place ${cmd.zoneId}.`);
        this.leaveCombat(p);
        let at = cmd.x !== undefined && cmd.y !== undefined ? { x: cmd.x, y: cmd.y } : undefined;
        if (at && !this.h.passable(def.id, at.x, at.y)) at = undefined;
        this.h.transfer(p, def.id, undefined, at);
        return ok(`Went to ${def.name}.`);
      }
      case 'reveal': {
        const def = this.h.ctx.zones.get(p.zoneId);
        if (!def) return no('The party is nowhere.');
        const { w, h } = fogSize(def);
        const bs = new BitSet(w * h);
        for (let i = 0; i < w * h; i++) bs.set(i);
        story.explored[def.id] = bs.encode();
        this.h.broadcastZone(def.id, (u) => ({ t: 'zone', ...this.h.zonePayload(u) }));
        return ok(`Revealed ${def.name}.`);
      }
      case 'heal':
        for (const ch of p.party) restoreFully(this.h.r, ch);
        for (const ch of p.party) ch.cooldowns = {};
        refresh();
        return ok('The party is fully restored.');
      case 'level': {
        const level = num(cmd.level, 1, this.h.r.progression.maxLevel);
        if (level === null) return no('Give a level.');
        for (const ch of chars(cmd.charId)) {
          ch.level = level;
          ch.xp = xpForLevel(this.h.r, level);
          // Points already spent stay spent while the level has that many; otherwise the tree is refunded.
          if (Object.values(ch.tree).reduce((s, v) => s + v, 0) > treePointsAt(this.h.r, level)) ch.tree = {};
          ch.treePoints = treePointsAt(this.h.r, level) - Object.values(ch.tree).reduce((s, v) => s + v, 0);
          const known = knownSkills(this.h.r, ch);
          ch.hotbar = ch.hotbar.map((s) => (s && known.includes(s) ? s : null));
          restoreFully(this.h.r, ch);
        }
        refresh();
        return ok(`${this.h.r.terminology.level} ${level}.`);
      }
      case 'xp': {
        const amount = num(cmd.amount, 0, 1e9);
        if (amount === null) return no('Give an amount.');
        this.h.grantPartyXp(p, amount);
        return ok(`+${amount} ${this.h.r.terminology.xp}.`);
      }
      case 'points': {
        const amount = num(cmd.amount, -1000, 1000);
        if (amount === null) return no('Give an amount.');
        for (const ch of chars(cmd.charId)) ch.treePoints = Math.max(0, ch.treePoints + amount);
        return ok(`${amount >= 0 ? '+' : ''}${amount} talent points.`);
      }
      case 'gold': {
        const amount = num(cmd.amount, -1e9, 1e9);
        if (amount === null) return no('Give an amount.');
        p.gold = Math.max(0, p.gold + amount);
        return ok(`${this.h.r.terminology.currency}: ${p.gold}.`);
      }
      case 'item': {
        const qty = num(cmd.qty ?? 1, 1, 999)!;
        const level = num(cmd.level ?? this.h.leader(p)?.level ?? 1, 1, this.h.r.progression.maxLevel)!;
        const unique = this.h.ctx.uniqueItems[cmd.ref];
        const base = rx(this.h.r).item.get(cmd.ref);
        if (!unique && !base) return no(`No item ${cmd.ref}.`);
        const items = unique ? Array.from({ length: qty }, () => makeUnique(this.h.r, unique, level)) : [makeItem(this.h.r, this.h.rng, cmd.ref, level, this.h.r.rarities[0]!.id, qty)];
        this.h.items.give(p, items);
        this.h.quests.refresh();
        return ok(`Received ${qty} × ${unique?.name ?? base!.name}.`);
      }
      case 'spawn': {
        const leader = this.h.leader(p);
        const z = this.h.zones.get(p.zoneId);
        if (!leader || !z) return no('The party is nowhere.');
        const boss = cmd.bossId ? this.h.ctx.bosses.get(cmd.bossId) : undefined;
        if (cmd.bossId && !boss) return no(`No boss ${cmd.bossId}.`);
        const family = boss ? this.h.ctx.family(boss.familyId) : cmd.familyId ? this.h.ctx.family(cmd.familyId) : (this.h.ctx.family(z.map.def.familyIds[0] ?? '') ?? this.h.world.families[0]);
        if (!family) return no(`No creature family ${cmd.familyId}.`);
        const member = Math.max(0, Math.min(family.members.length - 1, cmd.member ?? 0));
        const level = num(cmd.level ?? boss?.level ?? z.map.def.levelRange[1], 1, this.h.r.progression.maxLevel)!;
        const count = boss ? 1 : num(cmd.count ?? 1, 1, 8)!;
        const groupId = uid('devgrp');
        // A few steps ahead of the leader, so the fight starts at once (unless peaceful).
        for (let i = 0; i < count; i++) {
          const angle = leader.facing + ((i - (count - 1) / 2) * Math.PI) / 6;
          const spot = this.h.nearestFree(z.id, { x: leader.x + Math.cos(angle) * 4, y: leader.y + Math.sin(angle) * 4 });
          const id = uid('dev');
          const def: SpawnDef = { id, kind: 'monster', familyId: family.id, member, level, x: spot.x, y: spot.y, groupId, bossId: boss?.id };
          const rt: MonsterRuntime = { spawnId: id, hp: -1, dead: false, x: spot.x, y: spot.y, scale: 1, def };
          z.rt.monsters[id] = rt;
          const actor = new MonsterActor(def, rt, family, boss, z.id, this.h.r, () => this.h.state.difficulty);
          z.actors.set(actor.id, actor);
          actor.dirty = true;
        }
        return ok(`Spawned ${boss ? boss.name : `${count} × ${family.members[member]?.name ?? family.name}`} (${this.h.r.terminology.level.toLowerCase()} ${level}).`);
      }
      case 'kill': {
        const leader = this.h.leader(p);
        const z = this.h.zones.get(p.zoneId);
        if (!leader || !z) return no('The party is nowhere.');
        const fight = this.h.fightOf(p);
        const near = (a: Actor) => Math.hypot(a.x - leader.x, a.y - leader.y) < 15;
        const victims = [...z.actors.values()].filter((a) => a instanceof MonsterActor && a.alive() && isHostileTo(a, leader) && (cmd.all || (fight ? fight.participants().includes(a) : near(a))));
        for (const a of victims) {
          a.hp = 0;
          this.h.onDowned(a, leader);
        }
        fight?.checkEnd();
        return ok(victims.length ? `Defeated ${victims.length}.` : 'Nothing hostile nearby.');
      }
      case 'respawn': {
        const z = this.h.zones.get(p.zoneId);
        if (!z) return no('The party is nowhere.');
        this.leaveCombat(p);
        const gone: string[] = [];
        for (const a of [...z.actors.values()])
          if (a instanceof MonsterActor) {
            if (a.combatId) this.h.combats.get(a.combatId)?.remove(a);
            z.actors.delete(a.id);
            gone.push(a.id);
          }
        z.rt.monsters = {};
        this.h.broadcastZone(z.id, { t: 'entities', upsert: [], remove: gone });
        this.h.places.populate(z);
        for (const a of z.actors.values()) if (a instanceof MonsterActor) a.dirty = true;
        return ok(`${z.map.def.name}: every creature is back.`);
      }
      case 'quest': {
        const def = this.h.questDef(cmd.questId);
        if (!def) return no(`No quest ${cmd.questId}.`);
        const prog = story.quests[def.id];
        switch (cmd.op) {
          case 'start':
            if (prog) return no(`${def.title} is already ${prog.status}; reset it first.`);
            this.h.quests.start(def.id, 'Started by a developer.');
            return ok(`Started ${def.title}.`);
          case 'advance': {
            if (prog?.status !== 'active') return no(`${def.title} is not active.`);
            const o = currentWays(def, prog)[0];
            if (!o) return no('No objective left.');
            this.h.quests.completeObjective(def.id, o.id);
            return ok(`Done: ${o.description}`);
          }
          case 'complete':
            if (prog && prog.status !== 'active') return no(`${def.title} is already ${prog.status}.`);
            if (!prog) this.h.quests.start(def.id, 'Started by a developer.');
            this.h.quests.complete(def.id, 'Completed by a developer.');
            return ok(`Completed ${def.title}.`);
          case 'fail':
            if (prog?.status !== 'active') return no(`${def.title} is not active.`);
            if (def.main) return no('Main quests never fail.');
            this.h.quests.fail(def.id, 'Failed by a developer.');
            return ok(`Failed ${def.title}.`);
          case 'reset':
            delete story.quests[def.id];
            for (const pl of Object.values(story.players)) if (pl.pinnedQuestId === def.id) pl.pinnedQuestId = undefined;
            // A main quest whose prerequisites are done starts again by itself.
            this.h.quests.autoStart();
            this.h.markAll();
            return ok(`Reset ${def.title}${story.quests[def.id] ? ' (it started again)' : ''}.`);
        }
        return no('Unknown quest operation.');
      }
      case 'story': {
        const main = this.h.world.quests.filter((q) => q.main);
        const at = main.findIndex((q) => q.id === cmd.questId);
        if (at < 0) return no(`${cmd.questId} is not a main quest.`);
        main.forEach((q, i) => {
          if (i >= at) return void delete story.quests[q.id];
          // Earlier stages count as done, quietly: no rewards or narration.
          const objectives = Object.fromEntries(q.objectives.map((o) => [o.id, { progress: o.count ?? 1, done: true }]));
          story.quests[q.id] = { questId: q.id, status: 'completed', objectives, log: [{ day: this.h.day(), text: 'Completed by a developer.' }], startedDay: this.h.day() };
        });
        story.revealedArcs = this.h.world.arcs.filter((a) => a.questIds.every((id) => story.quests[id]?.status === 'completed')).map((a) => a.index);
        story.completedGame = false;
        for (const pl of Object.values(story.players)) pl.pinnedQuestId = undefined;
        // An item the stage has delivered that an earlier stage would have found comes with the jump.
        const q = main[at]!;
        const found = new Set(q.objectives.filter((o) => o.type === 'collect').map((o) => o.itemUniqueId));
        for (const o of q.objectives) {
          const u = o.type === 'deliver' && o.itemUniqueId && !found.has(o.itemUniqueId) ? this.h.ctx.uniqueItems[o.itemUniqueId] : undefined;
          if (u && ![...story.pouch, ...p.inventory].some((i) => i.uniqueId === u.id)) this.h.items.give(p, [makeUnique(this.h.r, u, q.level)]);
        }
        this.h.quests.autoStart();
        if (!story.quests[q.id]) this.h.quests.start(q.id, 'Started by a developer.');
        this.h.markAll();
        return ok(`The story is at ${q.title}.`);
      }
      case 'time': {
        const day = num(cmd.day ?? this.h.day(), 1, 100_000)!;
        const hour = num(cmd.hour ?? this.h.hour(), 0, 23)!;
        const before = this.h.day();
        this.h.state.clock = (day - 1) * GAME_MINUTES_PER_DAY + hour * 60;
        if (this.h.day() !== before) this.h.newDay();
        this.h.sendClock(true);
        return ok(`Day ${day}, ${String(hour).padStart(2, '0')}:00.`);
      }
      case 'info':
        return {
          ok: true,
          text: `${this.h.world.quests.length} quests, ${this.h.world.bosses.length} bosses.`,
          info: {
            quests: this.h.world.quests.map((q) => {
              const prog = story.quests[q.id];
              const current = prog?.status === 'active' ? currentWays(q, prog).map((o) => o.description).join(' or ') || undefined : undefined;
              return { id: q.id, title: q.title, main: q.main, arcIndex: q.arcIndex, status: prog?.status, current };
            }),
            bosses: this.h.world.bosses.map((b) => ({ id: b.id, name: b.name, zoneId: b.zoneId, familyId: b.familyId })),
            god: this.devGod.has(p.userId),
            peace: this.devPeace.has(p.userId),
          },
        };
    }
    return no('Unknown developer command.');
  }
}
