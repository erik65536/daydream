/**
 * Errors in the player's browser are sent to the server, which keeps them for the administrator's Errors page.
 *
 * A report says what went wrong (message and stack; the server maps a built client's stack back to the source), where
 * (the page, and in a game the adventure, place, position, and party) and what led to it: the last few things the
 * player did (pages opened, messages sent to the game, the server's refusals). What a player typed is never sent.
 */
import { VERSION } from './api';
import { tryClient } from './net/game';

const trail: string[] = [];
const started = Date.now();

/** Something the player did, for the next report's trail. Repeats (walking, steering) fold into one line. */
export function breadcrumb(what: string) {
  const line = `${Math.round((Date.now() - started) / 1000)}s ${what}`;
  const last = trail[trail.length - 1];
  if (last && last.replace(/^\d+s /, '').replace(/ ×\d+$/, '') === what) {
    const n = Number(/ ×(\d+)$/.exec(last)?.[1] ?? 1) + 1;
    trail[trail.length - 1] = `${line} ×${n}`;
  } else trail.push(line);
  if (trail.length > 30) trail.shift();
}

/** The game the player is in, if any: enough to find the spot again with the dev panel. */
function gameContext(): Record<string, unknown> | undefined {
  const c = tryClient();
  const s = c?.state;
  if (!c || !s) return undefined;
  const me = s.player;
  return {
    adventure: c.adventureId,
    connection: s.status,
    zone: me?.zoneId,
    at: me ? `${Math.round(me.x)},${Math.round(me.y)}` : undefined,
    party: me?.party.map((ch) => `${ch.name} (level ${ch.level})`).join(', '),
    inCombat: !!s.combat,
    dialog: s.dialog ? 'open' : undefined,
    panel: s.panel ?? undefined,
  };
}

const sent = new Set<string>();
let reports = 0;

/** Send one error to the server (each distinct error once per page load, at most 20 in all). */
export function reportError(err: unknown, where: string, more?: string) {
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err) ?? String(err));
  const key = `${e.message}|${e.stack?.split('\n')[1] ?? ''}`;
  if (sent.has(key) || reports >= 20) return;
  sent.add(key);
  reports++;
  let stack = e.stack ?? '';
  for (let cause = e.cause, depth = 0; cause instanceof Error && depth < 3; cause = cause.cause, depth++) stack += `\nCaused by: ${cause.stack ?? cause.message}`;
  if (more) stack += `\n${more}`;
  const body = {
    message: e.message || e.name,
    stack: stack.slice(0, 8000),
    where,
    version: VERSION,
    context: {
      page: location.hash || '#/',
      screen: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
      secondsOpen: Math.round((Date.now() - started) / 1000),
      ...gameContext(),
    },
    trail: trail.slice(),
  };
  void fetch('/api/errors', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin', keepalive: true }).catch(() => {});
}

/** Report whatever escapes: uncaught errors and forgotten promises; and keep the trail of pages opened. */
export function installErrorReports() {
  addEventListener('error', (ev) => reportError(ev.error ?? `${ev.message} (${ev.filename}:${ev.lineno}:${ev.colno})`, 'uncaught'));
  addEventListener('unhandledrejection', (ev) => reportError(ev.reason, 'promise'));
  addEventListener('hashchange', () => breadcrumb(`page ${location.hash}`));
  breadcrumb(`page ${location.hash || '#/'}`);
}
