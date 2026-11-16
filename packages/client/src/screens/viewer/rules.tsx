/**
 * The world's rules: the systems it has, its classes as skill trees (with the heroes drawn for each), races,
 * statuses, items and crafting, how fights look, and what the balance simulation found. Words come from the same
 * code that describes them to players (shared/ruleset/describe.ts, codex.ts).
 */
import { codexSections, itemLines, modifierLabel, nodeLines, skillCostLine, skillLines, type ClassDef, type Ruleset } from '@daydream/shared';
import { Bullets, Field, Pic, Plain, Rest, Thing, href, minutes, useNames, useScrollTo, useView } from './core';

const SUBS = [
  ['systems', 'Systems'],
  ['classes', 'Classes'],
  ['kins', 'Races'],
  ['statuses', 'Statuses'],
  ['items', 'Items'],
  ['crafting', 'Crafting'],
  ['looks', 'Fight looks'],
  ['balance', 'Balance'],
] as const;
type Sub = (typeof SUBS)[number][0];

export function Rules({ sub, part }: { sub?: string; part?: string }) {
  const { w } = useView();
  const r = w.ruleset;
  const on = (SUBS.some(([id]) => id === sub) ? sub : 'systems') as Sub;
  useScrollTo(part);
  if (!r) return <p className="dim">This world has no rules yet.</p>;
  // Classes and races by the world's own words for them, in the plural.
  const plural = (x: string) => (/(s|x|ch|sh)$/i.test(x) ? `${x}es` : `${x}s`);
  const label = (id: Sub, l: string) => (id === 'classes' ? plural(r.terminology.calling) : id === 'kins' ? plural(r.terminology.kin) : l);
  return (
    <div className="col vw-page" style={{ gap: 14 }}>
      <nav className="vw-tabs" aria-label="Rules">
        {SUBS.map(([id, l]) => <a key={id} href={href(w, 'rules', id)} className={`vw-tab ${on === id ? 'on' : ''}`} aria-current={on === id ? 'page' : undefined}>{label(id, l)}</a>)}
      </nav>
      {on === 'systems' && <Systems r={r} />}
      {on === 'classes' && r.classes.map((c) => <ClassCard key={c.id} r={r} c={c} />)}
      {on === 'kins' && <Kins r={r} />}
      {on === 'statuses' && <Statuses r={r} />}
      {on === 'items' && <Items r={r} />}
      {on === 'crafting' && <Crafting r={r} />}
      {on === 'looks' && <Field label="How hits and statuses look in a fight"><Plain value={r.looks} /></Field>}
      {on === 'balance' && <Balance r={r} />}
    </div>
  );
}

/** The codex as players read it, then the numbers behind it. */
function Systems({ r }: { r: Ruleset }) {
  const keep = new Set(['basics', 'damage', 'progression', 'together', 'difficulty']);
  return (
    <>
      {codexSections(r).filter((s) => keep.has(s.id)).map((s) => (
        <section key={s.id} className="panel panel-body col" style={{ gap: 8 }}>
          <h3 className="vw-h3">{s.title}</h3>
          {s.intro && <p className="small muted">{s.intro}</p>}
          <div className="vw-cards">
            {s.entries.map((e, i) => (
              <div key={i} className="vw-card">
                <div className="vw-card-title">{e.color && <span className="swatch" style={{ background: e.color }} />}{e.title}</div>
                {e.text && <div className="small muted">{e.text}</div>}
                <Bullets items={e.lines} />
              </div>
            ))}
          </div>
        </section>
      ))}
      <section className="panel panel-body col" style={{ gap: 8 }}>
        <h3 className="vw-h3">The numbers</h3>
        <div className="vw-grid2">
          {(['revive', 'death', 'resolution', 'control', 'recovery', 'turn', 'inventory', 'economy', 'systems', 'terminology', 'health', 'party'] as const).map((k) => <Field key={k} label={k}><Plain value={r[k]} /></Field>)}
        </div>
        <details className="vw-fold">
          <summary>Curves, difficulty, and fighters</summary>
          <div className="vw-grid2" style={{ marginTop: 8 }}>
            <Field label="Experience to reach each level">{r.progression.xp.slice(2).join(', ')}</Field>
            <Field label="Tree points">{r.progression.treePointsStart} at the start, {r.progression.treePointsPerLevel} each level; tiers open at {r.progression.tierRequirements.join(', ')}</Field>
            <Field label="Kinds of fighter"><Plain value={r.fighters} /></Field>
            <Field label="Difficulty"><Plain value={r.difficulty} /></Field>
            <Field label="Curves"><Plain value={r.curves} /></Field>
            <Field label="Bosses"><Plain value={r.boss} /></Field>
          </div>
        </details>
      </section>
    </>
  );
}

/** A class: what it is, the heroes drawn for it, and its tree tier by tier, each skill with what it does. */
function ClassCard({ r, c }: { r: Ruleset; c: ClassDef }) {
  const { w } = useView();
  const origin = w.origins.find((o) => o.id === c.id);
  const tiers = [...new Set(c.nodes.map((n) => n.tier))].sort((a, b) => a - b);
  const skill = (id?: string) => r.skills.find((s) => s.id === id);
  const level = w.maxLevel || r.progression.maxLevel;
  return (
    <section id={`vw-${c.id}`} className="panel panel-body col" style={{ gap: 12 }}>
      <div className="row wrap" style={{ alignItems: 'flex-start', gap: 14 }}>
        <div className="grow col" style={{ gap: 6, minWidth: 240 }}>
          <h3 className="vw-h3">{c.name}</h3>
          <div className="small muted">{c.description}</div>
          <div className="small dim">{c.role}, {c.reach}, deals {r.damageTypes.find((d) => d.id === c.damageTypeId)?.name ?? c.damageTypeId}; tuned ×{c.tune.hp.toFixed(2)} health, ×{c.tune.dmg.toFixed(2)} damage</div>
          <Field label="Starts with">{[...c.startingSkills.map((s) => skill(s)?.name ?? s), ...Object.values(c.startingGear).map((b) => r.items.find((i) => i.id === b)?.name ?? b)].join(', ')}</Field>
          {origin && <Field label="How its heroes look">{origin.appearance}</Field>}
        </div>
        {origin && (
          <div className="vw-heroes">
            {r.kins.map((k) => (
              <div key={k.id} className="col" style={{ gap: 2, alignItems: 'center' }}>
                <Pic k={origin.assets?.[k.id] ?? `spr_hero_${c.id}_${k.id}`} size={84} label={`${c.name}, ${k.name}`} />
                <span className="tiny dim">{k.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {tiers.map((t) => (
        <div key={t} className="col" style={{ gap: 6 }}>
          <div className="label">Tier {t + 1}{r.progression.tierRequirements[t] ? `, opens at ${r.progression.tierRequirements[t]} points` : ''}</div>
          <div className="vw-cards">
            {c.nodes.filter((n) => n.tier === t).map((n) => {
              const s = skill(n.skillId);
              return (
                <div key={n.id} id={`vw-${n.id}`} className="vw-card">
                  <div className="vw-card-title">{n.name} <span className="tiny dim">{n.kind}{n.maxRank > 1 ? `, ${n.maxRank} ranks` : ''}</span></div>
                  <div className="small muted">{s?.description ?? n.description}</div>
                  {s ? (
                    <>
                      <div className="tiny dim">{skillCostLine(r, s)} · {s.targeting}{s.tags.length ? ` · ${s.tags.join(', ')}` : ''}</div>
                      <Bullets items={skillLines(r, s, 1)} />
                    </>
                  ) : (
                    <Bullets items={nodeLines(r, n, level)} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

function Kins({ r }: { r: Ruleset }) {
  return (
    <div className="vw-cards">
      {r.kins.map((k) => (
        <div key={k.id} id={`vw-${k.id}`} className="vw-card">
          <div className="vw-card-title">{k.name} <span className="tiny dim">{k.presentation}</span></div>
          <div className="small muted">{k.description}</div>
          <Field label="Looks">{k.appearance}</Field>
          <Field label="Names">{k.names.join(', ')}</Field>
        </div>
      ))}
    </div>
  );
}

function Statuses({ r }: { r: Ruleset }) {
  const lines = new Map((codexSections(r).find((s) => s.id === 'statuses')?.entries ?? []).map((e) => [e.title, e.lines]));
  return (
    <>
      <div className="vw-cards">
        {r.damageTypes.map((d) => (
          <div key={d.id} className="vw-card">
            <div className="vw-card-title"><span className="swatch" style={{ background: d.color }} />{d.name} <span className="tiny dim">damage</span></div>
            <div className="small muted">Reduced by {d.mitigationName}.</div>
          </div>
        ))}
      </div>
      <div className="vw-cards">
        {r.statuses.map((s) => (
          <div key={s.id} id={`vw-${s.id}`} className="vw-card">
            <div className="vw-card-title"><span className="swatch" style={{ background: s.color }} />{s.name} <span className="tiny dim">{s.harmful ? 'debuff' : 'buff'}</span></div>
            <div className="small muted">{s.description}</div>
            <Bullets items={lines.get(s.name)} />
          </div>
        ))}
      </div>
    </>
  );
}

function Items({ r }: { r: Ruleset }) {
  const { w } = useView();
  const n = useNames();
  const common = r.rarities[0]?.id ?? 'common';
  const level = w.maxLevel || r.progression.maxLevel;
  const cats = [...new Set(r.items.map((i) => i.category))];
  const uniques = Object.values(w.uniqueItems);
  return (
    <>
      {cats.map((cat) => (
        <section key={cat} className="col" style={{ gap: 6 }}>
          <div className="label">{cat}</div>
          <div className="vw-cards">
            {r.items.filter((i) => i.category === cat).map((i) => (
              <div key={i.id} id={`vw-${i.id}`} className="vw-card row" style={{ alignItems: 'flex-start', gap: 10 }}>
                <Pic k={`icon_${i.id}`} size={56} label={i.name} />
                <div className="grow col" style={{ gap: 3 }}>
                  <div className="vw-card-title">{i.name} <span className="tiny dim">{[i.slotId && r.slots.find((s) => s.id === i.slotId)?.name, i.tier !== undefined && `tier ${i.tier}`, `${i.price} ${r.economy.currency}`].filter(Boolean).join(' · ')}</span></div>
                  <div className="small muted">{i.description}</div>
                  <Bullets items={itemLines(r, { baseId: i.id, level: 1, rarityId: common, affixes: [] }, i)} />
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
      {uniques.length > 0 && (
        <section className="col" style={{ gap: 6 }}>
          <div className="label">Unique and quest items</div>
          <div className="vw-cards">
            {uniques.map((u) => {
              const from = [...w.bosses.filter((b) => b.drops.includes(u.id)).map((b) => b.id), ...w.quests.filter((q) => q.rewards.items.includes(u.id) || q.objectives.some((o) => o.itemUniqueId === u.id)).map((q) => q.id)];
              return (
                <div key={u.id} id={`vw-${u.id}`} className="vw-card">
                  <div className="vw-card-title">{u.name} <span className="tiny dim">{u.questItem ? 'quest item' : r.rarities.find((x) => x.id === u.rarityId)?.name ?? u.rarityId} · {n.item(u.baseId)}</span></div>
                  <div className="small muted">{u.description}</div>
                  <Bullets items={u.mods.map((m) => modifierLabel(r, m, level))} />
                  {from.length > 0 && <div className="tiny">From {from.map((id, i) => <span key={id}>{i ? ', ' : ''}<Thing id={id} /></span>)}</div>}
                </div>
              );
            })}
          </div>
        </section>
      )}
      <details className="vw-fold">
        <summary>Rarities, slots, and affixes</summary>
        <div className="vw-grid2" style={{ marginTop: 8 }}>
          <Field label="Rarities"><Plain value={r.rarities} /></Field>
          <Field label="Slots"><Plain value={r.slots} /></Field>
          <Field label="Affixes"><Plain value={r.affixes} /></Field>
        </div>
      </details>
    </>
  );
}

function Crafting({ r }: { r: Ruleset }) {
  const n = useNames();
  if (!r.crafts.length && !r.recipes.length) return <p className="dim">This world has no crafting.</p>;
  return (
    <>
      <div className="vw-cards">
        {r.crafts.map((c) => (
          <div key={c.id} className="vw-card">
            <div className="vw-card-title">{c.name} <span className="tiny dim">{c.id}</span></div>
            <div className="small muted">{c.description}</div>
          </div>
        ))}
      </div>
      <Field label="Settings"><Plain value={r.crafting} /></Field>
      {r.recipes.length > 0 && (
        <div className="vw-cards">
          {r.recipes.map((x) => (
            <div key={x.id} className="vw-card">
              <div className="vw-card-title">{x.name}</div>
              <div className="small">{x.inputs.map((i) => `${i.qty} × ${n.item(i.itemId)}`).join(', ')}{x.gold ? `, ${x.gold} ${r.economy.currency}` : ''}</div>
              <div className="small muted">makes {'itemId' in x.output ? `${x.output.qty} × ${n.item(x.output.itemId)}` : `a piece of ${x.output.slotKind} gear, as good as the maker’s craft`}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** What the balance simulation tried and found. */
function Balance({ r }: { r: Ruleset }) {
  const b = r.balance;
  const n = useNames();
  if (!b) return <p className="dim">The rules have not been balanced.</p>;
  const skill = (id: string) => r.skills.find((s) => s.id === id)?.name ?? id;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return (
    <>
      <p className="small muted">{b.fights.toLocaleString('en-US')} fights over {b.iterations} rounds in {minutes(b.durationMs)}, {new Date(b.at).toLocaleDateString('en-US')}. {b.scenarios.filter((s) => s.ok).length} of {b.scenarios.length} scenarios on target.</p>
      {b.findings.length > 0 && <Field label="What numbers could not fix"><Bullets items={b.findings.map((f) => `${f.text}${f.classId ? ` (${n.cls(f.classId)})` : ''}`)} /></Field>}
      <div className="vw-table-wrap">
        <table className="vw-table">
          <thead><tr><th>Scenario</th><th>Level</th><th>Difficulty</th><th>Won</th><th>Health lost</th><th>Rounds</th><th /></tr></thead>
          <tbody>
            {b.scenarios.map((s) => (
              <tr key={s.id} className={s.ok ? '' : 'off'}>
                <th scope="row"><span className="vw-rowname">{s.label}{s.heroes ? ` (${s.heroes} heroes)` : ''}</span></th>
                <td>{s.level}</td>
                <td>{s.difficulty}</td>
                <td>{pct(s.winRate)} <span className="dim">of {pct(s.target.winRate[0])}–{pct(s.target.winRate[1])}</span></td>
                <td>{pct(s.hpLost)} <span className="dim">of {pct(s.target.hpLost[0])}–{pct(s.target.hpLost[1])}</span></td>
                <td>{s.rounds.toFixed(1)} <span className="dim">of {s.target.rounds.join('–')}</span></td>
                <td>{s.ok ? '' : s.limit ?? 'off target'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="vw-grid2">
        <Field label="Class strength in a party (average 1)"><Bullets items={b.classes.map((c) => `${n.cls(c.classId)}: ${c.strength.toFixed(2)} (tuned ×${c.tune.hp.toFixed(2)} health, ×${c.tune.dmg.toFixed(2)} damage)`)} /></Field>
        <Field label="Skill use"><Bullets items={[...b.skillUsage].sort((a, x) => x.share - a.share).map((s) => `${skill(s.skillId)}: ${pct(s.share)}${s.tune !== 1 ? `, tuned ×${s.tune.toFixed(2)}` : ''}`)} /></Field>
      </div>
      {(b.notes.length > 0 || b.outliers.length > 0) && <Field label="Notes"><Bullets items={[...b.notes, ...b.outliers]} /></Field>}
      <Rest obj={b} known={['at', 'iterations', 'durationMs', 'fights', 'scenarios', 'classes', 'skillUsage', 'outliers', 'findings', 'notes']} />
    </>
  );
}
