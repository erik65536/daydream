/**
 * What the player hears while playing (docs/sound.md, "Which moment plays what"): the game's moments, the fight, each
 * place's ambience and arrival cue, a boss's battle loop, defeat, and the ending. Everything is read from what the
 * client is already told (effects, notices, the fight, the place, the roster); nothing here changes the game.
 *
 * Every tap on a control and every window opening and closing is heard too, in and out of a world (the listener
 * below, and `Window` in ui/common.tsx).
 */
import { rx, soundKey, type ClientMessage, type FxEvent, type ServerMessage } from '@daydream/shared';
import type { GameClient, Toast } from './net/game';
import type { Renderer } from './render/renderer';
import { sounds } from './sounds';
import { sound } from './sound';

/** A notice's sound, by its kind, when the server names none. */
const TOAST: Record<Toast['kind'], string | null> = { bad: 'refusal', good: 'success', loot: 'take', pickup: 'take', quest: 'success', info: null };
/** A place's arrival cue plays on the first visit, and on one after this long away. */
const CUE_AGAIN_MS = 10 * 60_000;
/** The last seconds of a turn with a time limit tick. */
const TICKS_S = 5;
/** How long a fight's opening waits for its creatures to be known. */
const OPENING_MS = 1500;

/**
 * The game's sounds while playing; returns the unsubscribe. With the game view `r`, the fight is heard as it is seen:
 * a blow sounds when the view shows it land (a shot in flight, a rush), not when the server counted it.
 */
export function gameSounds(c: GameClient, r?: Renderer): () => void {
  // The pages' mute stays outside: the game is heard by its own volumes.
  sound.setPlaying(true);
  const st = () => c.state;
  const posOf = (id?: string) => {
    const e = id ? st().entities.get(id) : undefined;
    return e ? c.entityPos(e) : undefined;
  };
  const isElement = (id?: string) => !!id && !!st().world?.ruleset.damageTypes.some((t) => t.id === id);

  let worldId: string | undefined;
  let zoneId: string | undefined;
  let fighting = false;
  let myTurn = c.isMyTurn();
  let ticked = -1;
  const left = new Map<string, number>();
  let online = new Set<string>();

  const onFx = (events: FxEvent[]) => {
    for (const ev of events) {
      const at = posOf(ev.targetId) ?? (ev.x !== undefined && ev.y !== undefined ? { x: ev.x, y: ev.y } : undefined);
      if (ev.kind === 'damage' && ev.damage) {
        const d = ev.damage;
        if (d.type === 'heal') {
          if ((d.share ?? 0) >= 0.05) sounds.play('heal', { at });
          continue;
        }
        if (d.minor || d.miss) continue;
        const heavy = d.crit || d.fatal || (d.share ?? 0) >= 0.25;
        if (heavy && sounds.has(soundKey('heavy', d.type))) sounds.play(soundKey('heavy', d.type), { at });
        else sounds.play(soundKey('hit', d.type), { at, db: heavy ? 4 : 0 });
      } else if (ev.kind === 'skill' || (ev.kind === 'projectile' && ev.element)) {
        const from = posOf(ev.sourceId);
        if (ev.skillId === 'attack' || !isElement(ev.element)) sounds.play('swing', { at: from });
        else sounds.play(soundKey('cast', ev.element!), { at: from });
      } else if (ev.kind === 'text') {
        if (ev.dodged) sounds.play('dodge', { at });
        else if (ev.statusId) sounds.play(rx(c.r).status.get(ev.statusId)?.harmful === false ? 'status_helpful' : 'status_harmful', { at });
      } else if (ev.kind === 'death') {
        const e = ev.targetId ? st().entities.get(ev.targetId) : undefined;
        if (e?.kind === 'character') sounds.play('hero_falls', { at });
        else if (e?.familyId) sounds.play(soundKey('death', e.familyId), { at });
      }
    }
  };

  const onServer = (m: ServerMessage) => {
    const s = st();
    if (m.t === 'narration' && !s.narrations.some((n) => n.id === m.id)) {
      if (m.style === 'death') sounds.playMusic('defeat');
      else if (m.style === 'ending') sounds.playMusic('theme');
    } else if (m.t === 'chat' && m.userId && m.userId !== s.userId) sounds.play('chat');
    else if (m.t === 'loot' && m.loot?.sourceKind === 'chest' && s.loot?.id !== m.loot.id) sounds.play('chest_open');
    else if (m.t === 'roster') {
      const now = new Set(m.players.filter((p) => p.online && p.userId !== s.userId).map((p) => p.userId));
      const changed = [...now].some((u) => !online.has(u)) || [...online].some((u) => !now.has(u));
      if (changed && s.roster.length) sounds.play('friend');
      online = now;
    }
  };

  // A notice is news, heard when whoever is speaking to the player finishes; a refusal answers what they just did.
  const onToast = (kind: Toast['kind'], sound: string | null | undefined) => {
    const key = sound === undefined ? TOAST[kind] : sound;
    if (key) sounds.play(key, { afterSpeech: kind !== 'bad' });
  };

  const onSent = (m: ClientMessage) => {
    if (m.t === 'equip') sounds.play('take');
    else if (m.t === 'unequip' || m.t === 'drop_item' || m.t === 'give_item') sounds.play('put');
  };

  /** The place: its ambience, and its arrival cue on a first visit or after a while away (not over the story's cards). */
  const place = () => {
    const s = st();
    if (s.world?.id !== worldId) {
      worldId = s.world?.id;
      sounds.setWorld(s.world ?? null);
    }
    const z = s.zone?.id;
    if (!z || s.narrations.length) return;
    if (z === zoneId) return;
    if (zoneId) left.set(zoneId, Date.now());
    zoneId = z;
    sounds.setAmbience(soundKey('ambience', z));
    const away = left.get(z);
    if (fighting) return;
    const cue = soundKey('place', z);
    if ((away === undefined || Date.now() - away > CUE_AGAIN_MS) && sounds.has(cue)) sounds.playMusic(cue);
    // The theme that carried the player in fades as the place takes over (a place with no cue of its own too).
    else if (sounds.musicPlaying()?.endsWith('/theme')) sounds.stopMusic(4);
  };

  /**
   * A fight: an enemy's cry opens it, a boss brings its battle loop, and its end lets the loop go. A fight can be
   * told before the creatures in it (spawned that moment), so its opening waits for them, a moment at most.
   */
  let opening = 0;
  let battle: string | null = null;
  const fight = () => {
    const s = st();
    const now = !!s.combat;
    if (now && !fighting) opening = Date.now();
    if (now && opening) {
      const enemies = s.combat!.order.filter((o) => o.team === 'enemies');
      const foes = enemies.map((o) => s.entities.get(o.id)).filter((e): e is NonNullable<typeof e> => !!e && !e.dead);
      if (foes.length === enemies.length || Date.now() - opening > OPENING_MS) {
        opening = 0;
        const boss = foes.find((e) => e.bossId);
        if (boss && sounds.has(soundKey('boss', boss.bossId!))) sounds.playMusic((battle = soundKey('boss', boss.bossId!)));
        const criers = foes.filter((e) => e.familyId);
        const crier = criers[Math.floor(Math.random() * criers.length)];
        if (crier) sounds.play(soundKey('cry', crier.familyId!), { at: c.entityPos(crier) });
      }
    } else if (!now && fighting) {
      opening = 0;
      if (battle) sounds.end(battle);
      battle = null;
    }
    fighting = now;
    const mine = c.isMyTurn();
    if (mine && !myTurn) sounds.play('my_turn');
    myTurn = mine;
  };

  const offState = c.subscribe(() => {
    place();
    fight();
  });
  // The last seconds of a timed turn.
  const timer = setInterval(() => {
    const cv = st().combat;
    if (!cv?.turnLimit || !c.isMyTurn()) return void (ticked = -1);
    const secs = Math.ceil(cv.turnLimit - (c.serverNow() - cv.turnStartedAt) / 1000);
    if (secs > 0 && secs <= TICKS_S && secs !== ticked) sounds.play('timer_tick');
    ticked = secs;
  }, 200);
  const offs = [r ? r.onShown(onFx) : c.onFx(onFx), c.onServer(onServer), c.onToast(onToast), c.onSent(onSent)];
  place();
  return () => {
    offState();
    clearInterval(timer);
    for (const o of offs) o();
    sounds.quiet();
    sound.setPlaying(false);
  };
}
