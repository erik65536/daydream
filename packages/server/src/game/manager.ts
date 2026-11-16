/** Loads, runs, saves, and unloads adventures. */
import crypto from 'node:crypto';
import { GAME_MINUTES_PER_DAY, type DifficultyId, type AdventureState, type AdventureSummary, type PlayerState, type WorldDefinition } from '@daydream/shared';
import { Adventure, blankAdventure, lowestHeroLevel } from './adventure.ts';
import { adventuresFor, closeAdventure, listAdventures, loadAdventure, loadWorld, saveAdventure, getUser } from '../storage.ts';
import type { CharacterSpec } from './characters.ts';

const UNLOAD_AFTER_MS = 30_000;

/** Why an adventure can't be played with the current engine (null if it can). */
export function incompatibility(state: AdventureState, world: WorldDefinition | null): string | null {
  if (!world) return 'Its world no longer exists.';
  if (Object.values(state.players).some((p) => p.party.some((c) => !world.ruleset.classes.some((k) => k.id === c.classId))))
    return 'This adventure began before the world’s rules were regenerated. Start a new adventure.';
  return null;
}

class AdventureManager {
  private live = new Map<string, Adventure>();
  private unloadTimers = new Map<string, ReturnType<typeof setTimeout>>();

  get(id: string): Adventure | null {
    const existing = this.live.get(id);
    if (existing) {
      this.cancelUnload(id);
      return existing;
    }
    const state = loadAdventure(id);
    if (!state) return null;
    const world = loadWorld(state.worldId);
    if (!world || world.status !== 'ready' || incompatibility(state, world)) return null;
    const adv = this.wire(new Adventure(state, world));
    this.live.set(id, adv);
    return adv;
  }

  /**
   * Drop the running copy (after saving it) so the next connection loads the world as it is on disk now. Everyone
   * still in it is disconnected, and their clients connect again by themselves, to the fresh copy: nobody plays on in
   * the old one, which saves nothing more.
   */
  reload(id: string) {
    const adv = this.live.get(id);
    if (!adv) return;
    this.cancelUnload(id);
    this.live.delete(id);
    adv.handOver();
    closeAdventure(id);
  }

  private wire(adv: Adventure): Adventure {
    adv.onSave = (s) => saveAdventure(s);
    adv.onEmpty = () => this.scheduleUnload(adv.state.id);
    adv.saveCopy = (p, name) => {
      const snap = this.saveCopy(adv, name, p);
      adv.sendTo(p.userId, { t: 'saved', adventureId: snap.id, name: snap.name });
    };
    return adv;
  }

  private scheduleUnload(id: string) {
    this.cancelUnload(id);
    this.unloadTimers.set(
      id,
      setTimeout(() => {
        this.unloadTimers.delete(id);
        const adv = this.live.get(id);
        if (!adv || adv.onlineUsers().length) return;
        adv.save();
        adv.stop();
        this.live.delete(id);
        closeAdventure(id);
      }, UNLOAD_AFTER_MS),
    );
  }

  private cancelUnload(id: string) {
    const t = this.unloadTimers.get(id);
    if (t) clearTimeout(t);
    this.unloadTimers.delete(id);
  }

  create(world: WorldDefinition, ownerId: string, ownerName: string, name: string, party: CharacterSpec[], difficulty?: DifficultyId): Adventure {
    const id = `a_${crypto.randomBytes(5).toString('hex')}`;
    const state = blankAdventure(id, world.id, ownerId, name.trim().slice(0, 60) || `${ownerName}’s adventure`, difficulty);
    const adv = this.wire(new Adventure(state, world));
    adv.addPlayer(ownerId, ownerName, party);
    adv.save();
    this.live.set(id, adv);
    this.scheduleUnload(id);
    return adv;
  }

  /**
   * Run `fn` on an adventure outside the game (making heroes, choosing who comes along, who may join): its running
   * copy, loaded if need be, and saved after. What `fn` returned comes back as `{ out }`; null means the adventure
   * could not be opened, and `fn` never ran.
   */
  edit<T>(id: string, fn: (adv: Adventure) => T): { out: T } | null {
    const adv = this.get(id);
    if (!adv) return null;
    const out = fn(adv);
    adv.save();
    if (!adv.onlineUsers().length) this.scheduleUnload(id);
    return { out };
  }

  /** Copy an adventure as it stands into a new adventure of its own (Save a copy): whoever saved it creates it, and everyone who could play the original can play the copy. */
  saveCopy(adv: Adventure, name: string, by: PlayerState): AdventureState {
    adv.save();
    const copy: AdventureState = JSON.parse(JSON.stringify(adv.state));
    copy.id = `a_${crypto.randomBytes(5).toString('hex')}`;
    copy.name = (name.trim() || `${adv.state.name} — day ${adv.day()}`).slice(0, 60);
    copy.copyOf = adv.state.id;
    copy.ownerId = by.userId;
    copy.members = [...new Set([adv.state.ownerId, ...adv.state.members])].filter((u) => u !== by.userId);
    copy.createdAt = Date.now();
    saveAdventure(copy);
    return copy;
  }

  summary(s: AdventureState): AdventureSummary {
    const live = this.live.get(s.id);
    const state = live?.state ?? s;
    const world = loadWorld(state.worldId);
    return {
      id: state.id,
      worldId: state.worldId,
      name: state.name,
      ownerId: state.ownerId,
      ownerName: getUser(state.ownerId)?.displayName,
      updatedAt: state.updatedAt,
      createdAt: state.createdAt,
      copyOf: state.copyOf,
      day: Math.floor(state.clock / GAME_MINUTES_PER_DAY) + 1,
      players: Object.values(state.players).map((p) => ({ userId: p.userId, name: p.name, level: Math.max(1, ...p.party.map((c) => c.level)), zone: p.zoneId })),
      heroes: Object.values(state.players).flatMap((p) => p.party.map((c) => ({ name: c.name, figure: world?.assets[c.sprite]?.status === 'ok' ? world.assets[c.sprite]!.file : undefined }))),
      members: state.members.map((u) => ({ userId: u, name: getUser(u)?.displayName ?? 'a former player' })),
      online: live?.onlineUsers().length ?? 0,
      difficulty: state.difficulty,
      incompatible: incompatibility(state, world) ?? undefined,
    };
  }

  /** The adventures in a world a user may play (their own and those they were given a place in), or (`others`, for administrators) everyone else's. */
  list(worldId: string, userId: string, others = false): AdventureSummary[] {
    const states = others ? listAdventures(worldId).filter((s) => s.ownerId !== userId && !s.members.includes(userId)) : adventuresFor(worldId, userId);
    return states.map((s) => this.summary(s));
  }

  saveAll() {
    for (const adv of this.live.values()) adv.save();
  }

  /** For the server's hourly numbers. */
  stats() {
    let playersOnline = 0;
    for (const adv of this.live.values()) playersOnline += adv.onlineUsers().length;
    return { playersOnline, adventuresRunning: this.live.size };
  }

  /** Players in the game now (none when it is not running). */
  onlineUsers(id: string): string[] {
    return this.live.get(id)?.onlineUsers() ?? [];
  }

  heroesInGame(id: string, except?: string): number {
    return this.live.get(id)?.heroesInGame(except) ?? 0;
  }

  /** The level a hero made now would start at. */
  newHeroLevel(id: string): number {
    return this.live.get(id)?.newHeroLevel() ?? lowestHeroLevel(Object.values(loadAdventure(id)?.players ?? {}));
  }

  /** Nobody got in after loading it (no heroes yet, or no room): let it go again in a while. */
  release(id: string) {
    if (this.live.has(id) && !this.onlineUsers(id).length) this.scheduleUnload(id);
  }

  /**
   * End an adventure for good (it, or its world, is being deleted): nothing of it is saved again, not even when its
   * players' connections close, and everyone in it is told why.
   */
  end(id: string, message: string) {
    const adv = this.live.get(id);
    if (!adv) return;
    this.cancelUnload(id);
    adv.onSave = adv.onEmpty = adv.saveCopy = undefined;
    adv.stop();
    adv.endFor(message);
    this.live.delete(id);
  }
}

export const adventures = new AdventureManager();
