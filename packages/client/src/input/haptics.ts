/**
 * Small vibrations (where the device has them and Settings allow): for a finger, a light tick on every tap of a
 * control; for a finger or a controller, a felt moment when the player's turn comes, one of their heroes is hurt, or
 * the stick walks them into a wall. The gestures on the game view tick themselves (touch.ts).
 */
import type { GameClient } from '../net/game';
import type { Renderer } from '../render/renderer';
import { buzz, rumble } from './pointer';

/** Anything a finger presses to do something. */
export const CONTROL = 'button, .btn, .slot, .item, .tab, .chip, .tnode, .replies li, .quest, .loot-row, [role="switch"], [role="link"], .tracker, .m-caption';

if (typeof window !== 'undefined') {
  window.addEventListener('click', (e) => {
    const t = e.target as Element | null;
    if (t?.closest?.(CONTROL) && !t.closest('[disabled], .na')) buzz(6);
  }, { capture: true, passive: true });
}

/** The game's moments, felt while playing; returns the unsubscribe. */
export function gameHaptics(c: GameClient, r: Renderer): () => void {
  const pad = () => c.state.inputMode === 'pad';
  let wasMyTurn = c.isMyTurn();
  const offState = c.subscribe(() => {
    const mine = c.isMyTurn();
    if (mine && !wasMyTurn) pad() ? rumble(120, 0.5) : buzz([14, 70, 14]);
    wasMyTurn = mine;
  });
  r.onBump = () => (pad() ? rumble(60, 0.35) : buzz(10));
  // Felt when the blow is seen to land, not when the server counted it (a shot is still in flight then).
  const offFx = r.onShown((events) => {
    const hurt = events.some((ev) => ev.kind === 'damage' && ev.damage && !ev.damage.miss && ev.damage.type !== 'heal'
      && c.state.entities.get(ev.damage.targetId)?.ownerUserId === c.state.userId);
    if (hurt) pad() ? rumble(140, 0.7) : buzz(28);
  });
  return () => {
    r.onBump = undefined;
    offState();
    offFx();
  };
}
