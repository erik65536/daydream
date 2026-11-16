/**
 * The verdict on what is being aimed where the pointer is: whether it reaches, whom its area would catch, and what
 * to say about it. One answer for everything that shows it: the marks on the ground (overlays.ts), the note beside
 * the pointer, whether a finger's release uses it, and the controller's prompt.
 */
import { isHarmful, skillRange, type EntityView, type Ruleset, type SkillDef, type StatBlock, type Vec2 } from '@daydream/shared';

export interface AimVerdict {
  /** How far it reaches from its user, and the radius of its area (0: one target), in meters. */
  range: number;
  radius: number;
  /** Where it would land: on its user, or where the pointer is (null: the pointer is off the place). */
  center: Vec2 | null;
  /** It can be used there now; or (a skill only) after its user walks into reach. */
  reaches: boolean;
  walks: boolean;
  /** Whether it could be used where it points: it reaches, or its user walks into reach first. */
  ok: boolean;
  /** What to say beside the pointer (null: nothing, it simply reaches). */
  note: { text: string; ok: boolean } | null;
  /** Those its area would catch there, and whether it harms them (foes glow red) or helps them (allies green). */
  caught: string[];
  harmful: boolean;
}

export interface Aiming {
  r: Ruleset;
  /** The skill aimed, or the skill an item's use is (an item reaches and covers as the server uses it). */
  skill?: SkillDef;
  thrown?: SkillDef;
  stats: StatBlock;
  /** Where its user stands, and the ground point under the pointer. */
  from: Vec2;
  point: Vec2 | null;
  /** Whether one point of the place sees another. */
  sees: (a: Vec2, b: Vec2) => boolean;
  entities: Iterable<EntityView>;
  /** Where someone is now. */
  at: (e: EntityView) => Vec2;
}

export function aimVerdict(a: Aiming): AimVerdict {
  const { skill, thrown, from } = a;
  const range = skill ? skillRange(skill, a.stats) : thrown?.range ?? 0;
  const radius = skill?.radius ?? thrown?.radius ?? 0;
  const center = skill?.targeting === 'self' ? from : a.point;
  const verdict: AimVerdict = { range, radius, center, reaches: false, walks: false, ok: false, note: null, caught: [], harmful: false };
  if (!center) return verdict;
  const inRange = Math.hypot(center.x - from.x, center.y - from.y) <= range + 0.01 || skill?.targeting === 'self';
  const los = range <= 2 || a.sees(from, center);
  const reaches = inRange && los;
  // A skill aimed beyond reach is still good: the hero walks into reach first (an item is not).
  const walks = !reaches && !!skill;
  // Everyone the area would catch there glows, by the server's rule: foes for a harmful area, allies for a helpful one.
  const effects = (skill ?? thrown)?.effects;
  if (radius && effects && (reaches || walks)) {
    const harmful = (verdict.harmful = isHarmful(a.r, effects));
    const revive = effects.some((x) => x.kind === 'revive') || (a.r.revive === 'heal' && effects.some((x) => x.kind === 'heal'));
    for (const e of a.entities) {
      const takes = harmful ? e.hostile && !e.dead && !e.downed : e.kind === 'character' && !e.hostile && !e.dead && (!e.downed || revive);
      const ep = a.at(e);
      if (takes && Math.hypot(ep.x - center.x, ep.y - center.y) <= radius + 0.01) verdict.caught.push(e.id);
    }
  }
  verdict.reaches = reaches;
  verdict.walks = walks;
  verdict.ok = reaches || walks;
  verdict.note = reaches ? null : walks ? { text: 'Walk into range', ok: true } : { text: inRange ? 'No line of sight' : 'Out of range', ok: false };
  return verdict;
}
