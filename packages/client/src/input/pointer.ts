/**
 * How the player points: a mouse (or pen) can hover, a finger cannot. The page knows which was used last
 * (`:root.touch` while it is a finger) so the interface can trade hovering for long-presses and larger targets.
 */
import { useSyncExternalStore } from 'react';
import { settings } from '../settings';

type PointerKind = 'mouse' | 'touch';

let kind: PointerKind = typeof matchMedia !== 'undefined' && matchMedia('(hover: none) and (pointer: coarse)').matches ? 'touch' : 'mouse';
const listeners = new Set<() => void>();

function set(k: PointerKind) {
  if (k === kind) return;
  kind = k;
  document.documentElement.classList.toggle('touch', k === 'touch');
  for (const l of listeners) l();
}

if (typeof window !== 'undefined') {
  document.documentElement.classList.toggle('touch', kind === 'touch');
  window.addEventListener('pointerdown', (e) => set(e.pointerType === 'touch' ? 'touch' : 'mouse'), { capture: true });
  // A real mouse moving takes over again (touch screens send no mouse pointer moves of their own).
  window.addEventListener('pointermove', (e) => e.pointerType === 'mouse' && (e.movementX || e.movementY) && set('mouse'), { capture: true, passive: true });
}

export const isTouch = () => kind === 'touch';

function onPointerKind(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useTouch(): boolean {
  return useSyncExternalStore(onPointerKind, isTouch);
}

/** How long a finger rests before a press becomes a long-press, and how far it may wander meanwhile. */
export const HOLD_MS = 450;
const HOLD_SLOP = 10;

/**
 * How hard a pointer at `v` along a side of `size` pixels pushes the view in a fight: 0 away from the ends, growing
 * to -1 at the start and 1 at the end over the last `edge` pixels (a mouse resting at the screen's edge, a finger
 * dragging near it).
 */
export const edgePush = (v: number, size: number, edge: number) => (v < edge ? -(1 - v / edge) : v > size - edge ? 1 - (size - v) / edge : 0);

/** Whether this device can vibrate at all (iPhones cannot, from a web page). */
export const canVibrate = () => typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

/**
 * A short tick (or a pattern of pulses and pauses) under the finger, while a finger is playing, as strong as the
 * player wants (Settings). `ms` is the pulse at full strength: a phone's motor cannot be made gentler, only
 * shorter, so lower settings shorten the pulses (to under a third, as below about 3 ms a motor is not felt at
 all) and keep the pauses.
 */
export function buzz(ms: number | number[] = 8) {
  const level = settings().controls.vibration;
  if (kind !== 'touch' || level <= 0 || !canVibrate()) return;
  const pulse = (v: number) => Math.max(3, Math.round(v * (0.3 + 0.7 * level)));
  try {
    navigator.vibrate(Array.isArray(ms) ? ms.map((v, i) => (i % 2 ? v : pulse(v))) : pulse(ms));
  } catch {
    /* not allowed here */
  }
}

/**
 * A short rumble in the controllers (where the browser can and Settings allow): `strength` from 0 to 1 at full
 * strength, scaled by the player's setting, and felt mostly in the light motor so small moments stay small.
 */
export function rumble(ms: number, strength: number) {
  const s = strength * settings().controls.vibration;
  if (s <= 0 || typeof navigator === 'undefined' || !navigator.getGamepads) return;
  for (const pad of navigator.getGamepads()) {
    void pad?.vibrationActuator?.playEffect('dual-rumble', { duration: ms, weakMagnitude: s, strongMagnitude: s * 0.4 }).catch(() => {});
  }
}

/** The element a long-press is being timed on (only the innermost one under the finger). */
let holding: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null;
/** A long-press just fired: the click that the finger's release makes is swallowed. */
let swallowUntil = 0;

if (typeof window !== 'undefined') {
  const cancel = () => {
    if (holding) clearTimeout(holding.timer);
    holding = null;
  };
  window.addEventListener('pointerup', cancel, { capture: true });
  window.addEventListener('pointercancel', cancel, { capture: true });
  window.addEventListener('scroll', cancel, { capture: true, passive: true });
  window.addEventListener('pointermove', (e) => holding && Math.hypot(e.clientX - holding.x, e.clientY - holding.y) > HOLD_SLOP && cancel(), { capture: true, passive: true });
  window.addEventListener('click', (e) => {
    if (performance.now() < swallowUntil) {
      e.stopPropagation();
      e.preventDefault();
      swallowUntil = 0;
    }
  }, { capture: true });
  // Android opens the browser's menu on a long-press; the game's own long-press is what the player meant.
  window.addEventListener('contextmenu', (e) => {
    const t = e.target as HTMLElement;
    if (kind === 'touch' && t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA' && !t.isContentEditable) e.preventDefault();
  }, { capture: true });
}

/**
 * Props for an element that does something on a finger's long-press (and swallows the tap the release would make).
 * Mice are left alone: they have hover and right-click.
 */
export function longPress(onHold: (el: HTMLElement) => void) {
  return {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType !== 'touch' || (e.nativeEvent as PointerEvent & { _held?: boolean })._held) return;
      (e.nativeEvent as PointerEvent & { _held?: boolean })._held = true;
      if (holding) clearTimeout(holding.timer);
      const el = e.currentTarget;
      holding = {
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => {
          holding = null;
          swallowUntil = performance.now() + 900;
          buzz();
          onHold(el);
        }, HOLD_MS),
      };
    },
  };
}
