/** A hero's own windows: the character sheet, and the talent trees with the skill bar. */
import { useState } from 'react';
import { canAllocate, classSpent, knownSkills, modifierLabel, nodeLines, nodeRank, rx, skillRank, talentPoints, xpForLevel, type CharacterState, type ClassDef, type TreeNode } from '@daydream/shared';
import { client, useGame } from '../net/game';
import { Portrait, SkillIcon, SkillTooltip, Tabs, Window, centered, docked, hideTip, holdTip, plural, tip } from './common';
import { PartyTabs } from './items';
import { isTouch } from '../input/pointer';
import { readable } from './theme';
import { Icon } from './svgicons';
import { sounds } from '../sounds';

export function CharacterWindow({ onClose }: { onClose: () => void }) {
  const { player, world } = useGame((s) => ({ player: s.player, world: s.world }));
  const c = client();
  const ch = c.selectedHero();
  if (!player || !world || !ch) return null;
  const r = world.ruleset;
  const ix = rx(r);
  const t = r.terminology;
  const s = c.charStats(ch);
  const cls = ix.cls.get(ch.classId);
  const kin = ix.kin.get(ch.kinId);
  const pctOf = (x: number) => `${Math.round(x * 100)}%`;
  const kindName = (typeId: string) => ix.type.get(typeId)?.name ?? '';
  const bonuses = Object.entries(s.pct).filter(([, v]) => Math.abs(v) >= 0.5);
  return (
    <Window title="Character" onClose={onClose} style={docked(600)}>
      <Tabs>
        <PartyTabs ch={ch} />
      </Tabs>
      <div className="panel-body row" style={{ alignItems: 'flex-start', gap: 20 }}>
        <div className="col" style={{ width: 230 }}>
          <div className="row" style={{ gap: 10 }}>
            <div className="portrait-lg"><Portrait size={64} sprite={c.assetUrl(ch.sprite, 'figure')} /></div>
            <div>
              <div className="display gold" style={{ fontSize: 20 }}>{ch.name}</div>
              <div className="muted small">{t.level} {ch.level} {kin?.name} {cls?.name}</div>
              <div className="tiny dim">{ch.level >= r.progression.maxLevel ? `Maximum ${t.level.toLowerCase()}` : `${t.xp} ${ch.xp} / ${xpForLevel(r, ch.level + 1)}`}</div>
            </div>
          </div>
          {/* The same choice as the blade-and-star chip on the portrait: who decides this hero's turns in a fight. */}
          <div className="ornament" />
          <div className="label">In battle</div>
          <div className="battle-choice" {...tip(<div><div className="tname">In battle</div><div className="tdesc" style={{ marginTop: 0 }}>You command {ch.name}, or let them fight on their own. Out of fights they follow you either way.</div></div>)}>
            <span className="pick" role="radiogroup" aria-label={`Who decides ${ch.name}’s turns in a fight`}>
              <button role="radio" aria-checked={!ch.ai} className={ch.ai ? '' : 'on'} onClick={() => ch.ai && c.send({ t: 'set_ai', charId: ch.id, ai: false })}>You command</button>
              <button role="radio" aria-checked={!!ch.ai} className={ch.ai ? 'on own' : ''} onClick={() => !ch.ai && c.send({ t: 'set_ai', charId: ch.id, ai: true })}><Icon name="own" size={11} color="currentColor" />On their own</button>
            </span>
          </div>
          <div className="ornament" />
          <div className="label">Talents</div>
          {r.classes.filter((k) => k.id === ch.classId || classSpent(r, ch, k.id) > 0).map((k) => (
            <div key={k.id} className="attr" {...tip(<div><div className="tname gold">{k.name}</div><div className="tdesc" style={{ marginTop: 0 }}>{k.description}</div></div>)}>
              <span className="n">{k.name}</span>
              <span className="val">{classSpent(r, ch, k.id)}</span>
            </div>
          ))}
          <div className="hint">{t.talentPoints} spent in each tree. Any tree is open to you (K).</div>
        </div>
        <div className="grow">
          <div className="label">Vitals</div>
          <div className="kv">
            <span>{r.health.name}</span><span className="v">{Math.round(ch.hp)} / {s.maxHp}</span>
          </div>
          <div className="label" style={{ marginTop: 12 }}>Attack</div>
          <div className="kv">
            <span>Weapon damage</span><span className="v">{Math.round(s.weapon.min)}–{Math.round(s.weapon.max)} {kindName(s.weapon.typeId)}</span>
            <span>Attack cost</span><span className="v">{s.weapon.apCost} {t.actionPoints}</span>
            <span>Range</span><span className="v">{s.weapon.melee ? 'Melee' : Math.round(s.weapon.range)}</span>
            <span>Skill power</span><span className="v">{Math.round(s.dpa)} per {t.actionPoints}</span>
            {r.resolution.crit && <><span>Critical chance</span><span className="v">{pctOf(s.crit)}</span><span>Critical damage</span><span className="v">{pctOf(s.critMult)}</span></>}
            {s.lifesteal ? <><span>Life steal</span><span className="v">{pctOf(s.lifesteal)}</span></> : null}
          </div>
          <div className="label" style={{ marginTop: 12 }}>Turns</div>
          <div className="kv">
            <span>{t.actionPoints} per turn</span><span className="v">{s.apPerTurn} (max {s.apMax})</span>
            <span>Movement</span><span className="v">{s.move.toFixed(1)} tiles per {t.actionPoints}</span>
          </div>
          <div className="label" style={{ marginTop: 12 }}>Defenses</div>
          <div className="kv">
            {r.resolution.dodge && <><span>Dodge</span><span className="v">{pctOf(s.dodge)}</span></>}
            {r.damageTypes.map((d) => (
              <span key={d.id} style={{ display: 'contents' }}><span style={{ color: readable(d.color) }}>{d.mitigationName}</span><span className="v">{pctOf(s.mitigation[d.id] ?? 0)} less {d.name.toLowerCase()}</span></span>
            ))}
          </div>
          {bonuses.length > 0 && (
            <>
              <div className="label" style={{ marginTop: 12 }}>Bonuses</div>
              <div className="kv">
                {bonuses.map(([k, v]) => (
                  <span key={k} style={{ display: 'contents' }}><span>{k === 'power' ? 'All damage' : k === 'healing' ? 'Healing' : modifierLabel(r, { stat: k, value: 0 }, 1).replace(/^\+0(\.0)?%? /, '')}</span><span className="v">{v > 0 ? '+' : ''}{Math.round(v)}%</span></span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </Window>
  );
}

export const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];

/** A passive's mark, from what it raises most: Health, a defense, damage, healing, dodging, or critical hits. */
const PASSIVE_GLYPH: [RegExp, string][] = [
  [/^hp/, 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z'],
  [/^mit:/, 'M12 3l7 3v5.5c0 4.4-3 7.8-7 9.5-4-1.7-7-5.1-7-9.5V6z'],
  [/^healing/, 'M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z'],
  [/^dodge/, 'M4 15c5 0 9-3 12-9M7 19c5-1 9-4 12-10M3 10c3 0 6-1.5 8-4'],
  [/^crit/, 'M12 3v5M12 16v5M3 12h5M16 12h5M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'],
  [/^(dmg:|power)/, 'M12 2l2.2 6.3L21 9.5l-5.3 3.9L17.6 21 12 17l-5.6 4 1.9-7.6L3 9.5l6.8-1.2z'],
];

function PassiveGlyph({ node }: { node: TreeNode }) {
  const stat = node.modifiers?.[0]?.stat ?? '';
  const d = PASSIVE_GLYPH.find(([re]) => re.test(stat))?.[1] ?? PASSIVE_GLYPH[5]![1];
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** The talent a finger tapped once (shown, not yet spent on). */
let armed: string | null = null;

/**
 * One pick in a tree. Desktop: hover shows it, a click spends a point. A finger: the first tap shows it, a second
 * spends. A controller: the ring shows it, A spends.
 */
function TalentNode({ ch, node }: { ch: CharacterState; node: TreeNode }) {
  const c = client();
  const r = c.r;
  const { rank, max } = nodeRank(r, ch, node);
  const err = canAllocate(r, ch, node.id);
  const open = classSpent(r, ch, node.classId) >= (r.progression.tierRequirements[node.tier] ?? 0);
  const state = rank >= max ? 'maxed' : !open ? 'locked' : !err ? 'avail' : 'idle';
  const skill = node.skillId ? rx(r).skill.get(node.skillId) : undefined;
  const stats = c.charStats(ch);
  const verb = rank === 0 ? (skill ? 'learn it' : 'take it') : 'raise its rank';
  const action = rank >= max ? null : err ? <div className="tsub t-why">{err}</div> : <div className="tsub t-go">{c.state.inputMode === 'pad' ? `Press A to ${verb}` : isTouch() ? `Tap again to ${verb}` : `Click to ${verb}`}</div>;
  const effects = skill ? [] : nodeLines(r, node, ch.level);
  const body = skill ? (
    <div>
      <SkillTooltip id={skill.id} r={r} stats={stats} rank={rank} flavor next />
      {action}
    </div>
  ) : (
    <div>
      <div className="st-head"><span className="tname gold">{node.name}</span><span className={`st-rank ${rank ? '' : 'off'}`}>{rank ? 'Taken' : 'Passive'}</span></div>
      <div className="st-lines">{effects.map((l, i) => <div key={i} className="tline">{l}</div>)}</div>
      {action}
    </div>
  );
  const press = (e: React.MouseEvent<HTMLElement>) => {
    // A finger sees a talent before spending on it: the first tap shows it, a second tap spends.
    if (isTouch() && armed !== node.id) {
      armed = node.id;
      return holdTip(e.currentTarget, body);
    }
    armed = null;
    if (!err) {
      c.send({ t: 'allocate', charId: ch.id, nodeId: node.id });
      sounds.play('learn');
      hideTip();
    }
  };
  const label = `${node.name}${max > 1 ? `, rank ${rank} of ${max}` : rank ? ', taken' : ''}`;
  return (
    <div className={`tnode ${skill ? 'skill' : 'passive'} ${state} ${rank ? 'has' : ''}`} onClick={press} role="button" aria-label={label} {...tip(body)}>
      <span className="tn-frame">
        {skill ? <SkillIcon id={skill.id} size={56} /> : <PassiveGlyph node={node} />}
        {/* Replayed on every point spent: a brief light across the frame. */}
        {rank > 0 && <span key={rank} className="tn-flash" aria-hidden />}
        {skill && max > 1 && <span className="tn-rank">{rank}/{max}</span>}
      </span>
      <span className="tn-name">{node.name}</span>
      {!skill && <span className="tn-fx">{effects.join(' · ')}</span>}
    </div>
  );
}

/**
 * One class's tree. Its tiers hang from a spine that fills as points go into the class; each tier's skills and
 * passives sit on a branch from its gate, which says how many more points open it.
 */
function ClassTree({ ch, cls }: { ch: CharacterState; cls: ClassDef }) {
  const r = client().r;
  const ix = rx(r);
  const spent = classSpent(r, ch, cls.id);
  const reqs = r.progression.tierRequirements;
  const kind = ix.type.get(cls.damageTypeId)?.name;
  const role = { melee: 'Fights up close', ranged: 'Fights from a distance', caster: 'Casts from a distance', hybrid: 'Fights up close', healer: 'Heals', support: 'Helps allies, hinders foes' }[cls.role];
  const emblem = cls.startingSkills[0] ?? cls.nodes.find((n) => n.skillId)?.skillId;
  return (
    <div className="ctree">
      <div className="ctree-head">
        {emblem && <span className="ctree-emblem"><SkillIcon id={emblem} size={44} /></span>}
        <div className="ctree-title">
          <span className="display">{cls.name}</span>
          <span className="ctree-role">{role}{kind ? ` · ${kind}` : ''}{cls.id === ch.classId ? ` · ${ch.name}’s own` : ''}</span>
        </div>
        <div className="ctree-spent"><b>{spent}</b><span>spent</span></div>
      </div>
      {cls.description && <div className="ctree-desc">{cls.description}</div>}
      <div className="tiers">
        {reqs.map((req, tier) => {
          const nodes = cls.nodes.filter((n) => n.tier === tier);
          if (!nodes.length) return null;
          const open = spent >= req;
          const nextReq = reqs[tier + 1];
          // The spine below a gate fills toward the next gate.
          const fill = nextReq === undefined ? 0 : open ? Math.max(0, Math.min(1, (spent - req) / Math.max(1, nextReq - req))) : 0;
          return (
            <div key={tier} className={`tier-row ${open ? 'open' : 'closed'}`}>
              <div className="tier-gate">
                <span className="tier-mark" aria-label={`Tier ${tier + 1}`}><span>{ROMAN[tier] ?? tier + 1}</span></span>
                {nextReq !== undefined && <span className="tier-line"><span style={{ height: `${fill * 100}%` }} /></span>}
              </div>
              <div className="tier-body">
                {!open && <div className="tier-lock"><LockGlyph />{talentPoints(r, req - spent).replace(/^(\d+) /, '$1 more ')} in {cls.name} to open</div>}
                <div className="tier-nodes">
                  {nodes.filter((n) => n.skillId).map((n) => <TalentNode key={n.id} ch={ch} node={n} />)}
                  <span className="tier-sep" aria-hidden />
                  {nodes.filter((n) => !n.skillId).map((n) => <TalentNode key={n.id} ch={ch} node={n} />)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LockGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden>
      <path d="M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

export function SkillsWindow({ onClose }: { onClose: () => void }) {
  const { player, world } = useGame((s) => ({ player: s.player, world: s.world }));
  const c = client();
  const [pick, setPick] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const ch = c.selectedHero();
  if (!player || !world || !ch) return null;
  const r = world.ruleset;
  // The hero's own class first, then the rest: anyone may mix them.
  const trees = [...r.classes].sort((a, b) => Number(b.id === ch.classId) - Number(a.id === ch.classId));
  const cls = trees.find((k) => k.id === shown) ?? trees[0]!;
  const stats = c.charStats(ch);
  const known = knownSkills(r, ch);
  const assign = (slot: number) => {
    if (!pick) return;
    const hb = Array.from({ length: 10 }, (_, i) => ch.hotbar[i] ?? null);
    const existing = hb.indexOf(pick);
    if (existing >= 0) hb[existing] = null;
    hb[slot] = pick;
    c.send({ t: 'set_hotbar', charId: ch.id, hotbar: hb });
    setPick(null);
  };
  return (
    <Window title="Talents" onClose={onClose} className="talents" style={centered(980, 60, 40)}>
      <Tabs>
        <PartyTabs ch={ch} mark={(p) => p.treePoints > 0} />
        <div className="spacer" />
        <div className={`tab points-left ${ch.treePoints ? 'has' : ''}`} style={{ cursor: 'default' }}>{ch.treePoints ? <><b>{ch.treePoints}</b> {ch.treePoints === 1 ? r.terminology.talentPoint : r.terminology.talentPoints} to spend</> : `No ${r.terminology.talentPoints} to spend`}</div>
      </Tabs>
      <div className="panel-body talents-body">
        <div className="class-rail" role="tablist" aria-label={plural(r.terminology.calling)}>
          {trees.map((k) => {
            const spent = classSpent(r, ch, k.id);
            const first = k.startingSkills[0] ?? k.nodes.find((n) => n.skillId)?.skillId;
            return (
              <button key={k.id} role="tab" aria-selected={k.id === cls.id} className={`class-tab ${k.id === cls.id ? 'on' : ''} ${k.id === ch.classId ? 'own' : ''}`} onClick={() => setShown(k.id)}>
                {first && <span className="ct-icon"><SkillIcon id={first} size={28} /></span>}
                <span className="ct-name">{k.name}{k.id === ch.classId && <span className="ct-own">{ch.name}’s own</span>}</span>
                <span className="ct-spent">{spent || ''}</span>
              </button>
            );
          })}
        </div>
        <ClassTree ch={ch} cls={cls} />
        <div className="loadout">
          <div className="col" style={{ gap: 4 }}>
            <div className="label">Skill bar{pick ? ': choose a slot' : ''}</div>
            <div className="lo-slots">
              {Array.from({ length: 10 }, (_, i) => {
                const id = ch.hotbar[i];
                return (
                  <div key={i} data-pad className={`slot sm ${pick ? 'on' : ''} ${id ? '' : 'empty'}`} onClick={() => (pick ? assign(i) : id && c.send({ t: 'set_hotbar', charId: ch.id, hotbar: ch.hotbar.map((x, j) => (j === i ? null : x)) }))} {...tip(id ? <SkillTooltip id={id} r={r} stats={stats} rank={skillRank(r, ch, id)} /> : 'Empty')}>
                    <span className="key">{(i + 1) % 10}</span>
                    {id && <SkillIcon id={id} size={34} />}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="col" style={{ gap: 4, minWidth: 0 }}>
            <div className="label">Known skills: choose one, then a slot</div>
            <div className="lo-known">
              {known.map((id) => (
                <div key={id} data-pad className={`slot sm ${pick === id ? 'on' : ''} ${ch.hotbar.includes(id) ? '' : 'unslotted'}`} onClick={() => setPick(pick === id ? null : id)} {...tip(<SkillTooltip id={id} r={r} stats={stats} rank={skillRank(r, ch, id)} />)}>
                  <SkillIcon id={id} size={34} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Window>
  );
}
