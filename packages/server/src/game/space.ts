/**
 * Where the game's actors stand and walk in a place (meters on the painting's navigation grid). The walking rules
 * themselves (bodies, squeezing past allies, budgets) are shared with the client: see shared/world/walking.
 */
import { SPACING, crowdedCells, walkAmong as among, walkAmongCells, type Nav, type NavPathOptions, type Vec2 } from '@daydream/shared';
import type { Actor } from './actors.ts';

/** Takes up room: standing, or down on the ground. */
const present = (a: Actor) => a.alive() || a.downed();
const idOf = (x?: Actor | string) => (typeof x === 'string' ? x : x?.id);

/** Someone (other than `ignore`) standing within SPACING of p. */
export function bodyAt(people: Iterable<Actor>, p: Vec2, ignore?: Actor | string): Actor | undefined {
  const skip = idOf(ignore);
  for (const a of people) if (a.id !== skip && present(a) && Math.hypot(a.x - p.x, a.y - p.y) < SPACING - 0.01) return a;
  return undefined;
}

/** Walkable ground nobody else stands on. */
export function isFree(nav: Nav, people: Iterable<Actor>, p: Vec2, ignore?: Actor | string): boolean {
  return nav.walkable(p.x, p.y) && !bodyAt(people, p, ignore);
}

/** The nearest free spot to p (p itself when free), searching up to maxR meters out. */
export function nearestFree(nav: Nav, people: Actor[], p: Vec2, ignore?: Actor | string, maxR = 8): Vec2 | null {
  return nav.nearestWalkable(p, maxR, (cx, cy) => nav.walkableCell(cx, cy) && !bodyAt(people, nav.center(cx, cy), ignore));
}

/** Walking options for `a` among the others present: strangers block, allies can be squeezed past. */
export function walkAmong(nav: Nav, a: Actor, people: Actor[], ally: (o: Actor) => boolean): NavPathOptions {
  return among(nav, people.filter((o) => o !== a && present(o)).map((o) => ({ x: o.x, y: o.y, ally: ally(o) })));
}

/**
 * Walking options for `a` among the others present, and whether someone other than `a` stands on a cell (index
 * cy * cols + cx): `bodyAt` at the cell's center.
 */
export function walkAndTaken(nav: Nav, a: Actor, people: Actor[], ally: (o: Actor) => boolean): { walk: NavPathOptions; taken: (i: number) => boolean } {
  const others = people.filter((o) => o !== a && present(o));
  const strangers = crowdedCells(nav, others.filter((o) => !ally(o))), allies = crowdedCells(nav, others.filter(ally));
  return { walk: walkAmongCells(nav, strangers, allies), taken: (i) => strangers.has(i) || allies.has(i) };
}

/**
 * Where the i-th follower stands when a fight begins: the walking formation opened into a wedge behind the leader,
 * two meters between neighbors, so one small blast catches one hero and a large one about three, as areas are
 * priced (worldRules: AREA_TARGETS), instead of the whole party walking close together.
 */
function fightSlot(lead: Vec2, dir: Vec2, i: number): Vec2 {
  const row = i < 2 ? 1 : 2;
  const side = i < 2 ? (i ? 1 : -1) * 1.5 : [0, -3, 3][i - 2] ?? 0;
  const back = row * 1.3;
  return { x: lead.x - dir.x * back - dir.y * side, y: lead.y - dir.y * back + dir.x * side };
}

/**
 * Where a party stands as a fight begins: its leader where it is, the others in their fighting slots facing the foes
 * (`toward`), each on free ground the leader can see, or as near as can be.
 */
export function fightPositions(nav: Nav, people: Actor[], party: Actor[], toward: Vec2): Map<Actor, Vec2> {
  const out = new Map<Actor, Vec2>();
  const lead = party[0];
  if (!lead) return out;
  const d = Math.hypot(toward.x - lead.x, toward.y - lead.y) || 1;
  const dir = { x: (toward.x - lead.x) / d, y: (toward.y - lead.y) / d };
  out.set(lead, { x: lead.x, y: lead.y });
  // Everyone else where they stand, and the party where it has been placed so far.
  const taken = () => [...people.filter((o) => !party.includes(o) && present(o)), ...out.values()];
  const free = (p: Vec2) => taken().every((o) => Math.hypot(o.x - p.x, o.y - p.y) >= SPACING - 0.01);
  party.slice(1).forEach((a, i) => {
    const slot = fightSlot(lead, dir, i);
    const spot = nav.walkable(slot.x, slot.y) && nav.sees(lead, slot) ? nav.nearestWalkable(slot, 1.2, (cx, cy) => nav.walkableCell(cx, cy) && free(nav.center(cx, cy))) : null;
    out.set(a, spot ?? { x: a.x, y: a.y });
  });
  return out;
}

/**
 * Where the i-th follower walks behind a leader facing `dir` (a unit vector): in pairs, 1.2 m back and then 0.9 m
 * further for each pair, half a meter to either side (or straight behind, `inLine`, where the side is blocked). A fight begins with the party standing so (the balance
 * simulation starts its fights the same way).
 */
export function followSlot(lead: Vec2, dir: Vec2, i: number, inLine = false): Vec2 {
  const back = 1.2 + 0.9 * Math.floor(i / 2), side = inLine ? 0 : (i % 2 ? 1 : -1) * 0.55;
  return { x: lead.x - dir.x * back - dir.y * side, y: lead.y - dir.y * back + dir.x * side };
}
