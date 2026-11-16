/** The tracked quest, on screen while playing: its current step, progress, and where to go next. */
import { currentWays, type ClientWorld, type PlayerView, type QuestDef, type QuestObjective } from '@daydream/shared';
import { useEffect, useState } from 'react';
import { client, useGame } from '../net/game';
import { pressable, tip } from './common';

/** Screens too small to keep the whole step in view over the game (phones, upright or on their side). */
const SMALL = '(max-width: 640px), (max-height: 500px)';

function useSmallScreen(): boolean {
  const [small, setSmall] = useState(() => matchMedia(SMALL).matches);
  useEffect(() => {
    const m = matchMedia(SMALL), on = () => setSmall(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return small;
}

/** How long a new step stays unfolded on a small screen before the tracker folds back to its title. */
const SHOW_STEP_MS = 7000;

/** The quest being tracked: the one the player chose, or the main story when nothing was chosen ('' tracks none). */
export function trackedQuest(player: PlayerView): QuestDef | undefined {
  const active = (id: string) => player.quests[id]?.status === 'active';
  if (player.pinnedQuestId === '') return undefined;
  if (player.pinnedQuestId && active(player.pinnedQuestId)) return player.questDefs[player.pinnedQuestId];
  return Object.values(player.questDefs).find((d) => d.main && active(d.id));
}

/** The ways of the step the quest is on (any one of them does it). */
function currentObjectives(player: PlayerView, d: QuestDef): QuestObjective[] {
  return currentWays(d, player.quests[d.id]);
}

/**
 * Where an objective leads, in words ("Mara Venn · Switchyard"). The place is always named: the quest itself points
 * there (a step that names nowhere left players searching every place).
 */
export function objectiveWhere(world: ClientWorld, player: PlayerView, o: QuestObjective): string | undefined {
  const zoneName = (id?: string) => world.zones.find((x) => x.id === id)?.name;
  if (o.npcId) {
    const n = world.npcs.find((x) => x.id === o.npcId);
    if (!n) return undefined;
    return `${n.name} · ${zoneName(n.zoneId) ?? 'somewhere'}`;
  }
  if (o.targetId) {
    const b = world.bosses.find((x) => x.id === o.targetId);
    if (b) return zoneName(b.zoneId);
  }
  if (o.zoneId) return zoneName(o.zoneId);
  if (o.itemUniqueId) {
    const z = world.zones.find((x) => x.features.some((f) => f.items?.includes(o.itemUniqueId!)));
    if (z) return zoneName(z.id);
  }
  if (o.familyId) {
    // Where the party has been first, else the nearest kind of place that has them.
    const homes = world.zones.filter((x) => x.familyIds?.includes(o.familyId!));
    const z = homes.find((x) => player.knownZones.includes(x.id)) ?? homes[0];
    return z ? zoneName(z.id) : undefined;
  }
  return undefined;
}

/** The HUD shows the step, not the story: its first sentence, kept short. */
function firstSentence(text: string): string {
  const one = text.match(/^.*?[.!?](\s|$)/)?.[0]?.trim() ?? text;
  return one.length > 110 ? `${one.slice(0, 107).replace(/\s+\S*$/, '')}…` : one;
}

/**
 * On a small screen the tracker is folded to its title, clear of the game: a tap unfolds it (another opens the quest
 * log, and its corner folds it again), and it unfolds by itself for a few seconds whenever the step changes.
 */
export function QuestTracker({ onOpen }: { onOpen: () => void }) {
  const { player, world } = useGame((s) => ({ player: s.player, world: s.world }));
  const small = useSmallScreen();
  const [shown, setShown] = useState(false);
  const d = player ? trackedQuest(player) : undefined;
  const ways = player && d ? currentObjectives(player, d) : [];
  const stepKey = `${d?.id}|${ways.map((o) => o.id).join(',')}`;
  useEffect(() => {
    if (!small || !d) return;
    setShown(true);
    const t = setTimeout(() => setShown(false), SHOW_STEP_MS);
    return () => clearTimeout(t);
    // Unfold again only when the step itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepKey, small]);
  if (!player || !world || !d) return null;
  const folded = small && !shown;
  const press = () => {
    if (!folded) return onOpen();
    setShown(true);
  };
  return (
    <div className={`tracker ${folded ? 'folded' : ''}`} data-hud {...pressable(press)} {...tip(folded ? 'Show the next step' : <div><b>{world.ruleset.terminology.quest} log</b> <kbd>J</kbd></div>)}>
      <div className="tr-head">
        <span className="tr-kind">{d.main ? 'Story' : world.ruleset.terminology.quest}</span>
        {small ? (
          // On a small screen the corner folds the tracker back to its title (tracking stops from the quest log).
          <button className="tr-x tr-fold" aria-label="Fold" onClick={(e) => { e.stopPropagation(); setShown(false); }}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M2.5 7.5 6 4l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        ) : (
          <button className="tr-x" aria-label="Stop tracking" {...tip('Stop tracking')} onClick={(e) => { e.stopPropagation(); client().send({ t: 'pin_quest', questId: '' }); }}>✕</button>
        )}
      </div>
      <div className="tr-title">{folded && <span className="tr-dot" />}{d.title}</div>
      {ways.map((o, i) => {
        const prog = player.quests[d.id]?.objectives[o.id];
        const where = objectiveWhere(world, player, o);
        return (
          <div key={o.id}>
            {i > 0 && <div className="tr-or">or</div>}
            <div className="tr-step">
              <span className="tr-dot" />
              <span>{firstSentence(o.description)}{(o.count ?? 1) > 1 ? ` (${prog?.progress ?? 0}/${o.count})` : ''}</span>
            </div>
            {where && <div className="tr-where">{where}</div>}
          </div>
        );
      })}
    </div>
  );
}
