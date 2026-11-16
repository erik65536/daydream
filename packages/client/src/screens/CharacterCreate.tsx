import { useEffect, useMemo, useState } from 'react';
import { DIFFICULTIES, DIFFICULTY_SHORT, DIFFICULTY_TEXT, MAX_HEROES, characterStats, rx, type ClassRole, type DifficultyId, type ItemInstance, type Ruleset } from '@daydream/shared';
import { api, assetUrl, type AdventureDetail, type CharSpec, type Me, type PlayerEntry, type WorldSetup } from '../api';
import { navigate } from '../App';
import { SkillIcon, SkillTooltip, tip } from '../ui/common';
import { MoonScreen, Sigil } from '../ui/night';
import { setRules } from '../rules';
import { loadImage } from '../render/sprites';

/** A class card's tag says how it fights, reach first: "hybrid" alone did not tell a player it fights up close. */
const ROLE_TAG: Record<ClassRole, string> = { melee: 'melee', ranged: 'ranged', caster: 'ranged magic', hybrid: 'melee magic', healer: 'healer', support: 'support' };

const NAMES = ['Arin', 'Sela', 'Corvin', 'Mira', 'Tobin', 'Ysolde', 'Kael', 'Wren', 'Juno', 'Rook', 'Bramble', 'Tamsin', 'Oren', 'Linnet', 'Fennick', 'Ilsa'];

/** A hero being made; `suggested` while its name is one the game offered (it follows the kin until the player types). */
type Draft = CharSpec & { suggested?: boolean };

/** A name for a hero of this kin, from the world's names for its people, not one the party already has. */
function nameFor(r: Ruleset, kinId: string, taken: Set<string>): string {
  const own = rx(r).kin.get(kinId)?.names ?? [];
  const pool = [own, NAMES].map((l) => l.filter((n) => !taken.has(n))).find((l) => l.length) ?? NAMES;
  return pool[Math.floor(Math.random() * pool.length)]!;
}

function starterGear(r: Ruleset, classId: string): Record<string, ItemInstance> {
  const cls = rx(r).cls.get(classId);
  const out: Record<string, ItemInstance> = {};
  for (const [slot, baseId] of Object.entries(cls?.startingGear ?? {})) out[slot] = { id: `${slot}_${baseId}`, baseId, level: 1, rarityId: r.rarities[0]!.id, affixes: [], qty: 1 };
  return out;
}

/**
 * Starting an adventure, or joining one (`adventureId`): your heroes in lantern light, one or as many as six. Joining
 * heroes start where the others are (docs/multiplayer.md).
 */
export function CharacterCreate({ me, worldId: givenWorld, adventureId }: { me: Me; worldId?: string; adventureId?: string }) {
  const [joining, setJoining] = useState<AdventureDetail | null>(null);
  const worldId = givenWorld ?? joining?.worldId ?? '';
  const [setup, setSetup] = useState<WorldSetup | null>(null);
  const [players, setPlayers] = useState<PlayerEntry[]>([]);
  const [friends, setFriends] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [party, setParty] = useState<Draft[]>([]);
  const [idx, setIdx] = useState(0);
  const [adventureName, setAdventureName] = useState('');
  const [difficulty, setDifficulty] = useState<DifficultyId>('normal');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (adventureId) api.adventure(adventureId).then(setJoining, (e) => setError(e.message));
    else api.players().then(setPlayers, () => setPlayers([]));
  }, [adventureId]);

  useEffect(() => {
    if (!worldId) return;
    api.setup(worldId).then((s) => {
      setRules(s.ruleset);
      // Warm the image cache so switching class or kin shows art at once.
      for (const o of s.origins) for (const k of Object.values(o.assets ?? {})) if (k && s.assets[k]) loadImage(assetUrl(worldId, s.assets[k]));
      setSetup(s);
      setParty([newDraft(s, 0, new Set())]);
    }).catch((e) => setError((e as Error).message));
  }, [worldId]);

  const d = party[idx];
  const r = setup?.ruleset;

  const update = (patch: Partial<Draft>) =>
    setParty((p) =>
      p.map((x, i) => {
        if (i !== idx) return x;
        const next = { ...x, ...patch };
        // An offered name follows a change of kin, so it stays one of that people's names.
        if (r && patch.kinId && patch.kinId !== x.kinId && x.suggested && patch.name === undefined) next.name = nameFor(r, patch.kinId, new Set(p.filter((_, j) => j !== i).map((o) => o.name)));
        return next;
      }),
    );
  const preview = useMemo(() => {
    if (!r || !d) return null;
    const equipment = starterGear(r, d.classId);
    return { equipment, stats: characterStats(r, { classId: d.classId, kinId: d.kinId, level: 1, tree: {}, equipment, statuses: [] }) };
  }, [r, d?.classId, d?.kinId]);

  const back = joining ? { label: joining.name, to: `#/adventure/${joining.id}` } : { label: setup?.concept.title ?? 'The world', to: `#/world/${worldId}` };
  if (!setup || !d || !r || !preview)
    return (
      <MoonScreen scene="clouds" me={me} back={back}>
        <main className="m-page">{error ? <div className="m-error" style={{ textAlign: 'center' }}>{error}</div> : <div className="m-spinner" />}</main>
      </MoonScreen>
    );

  const ix = rx(r);
  const t = r.terminology;
  const cls = ix.cls.get(d.classId)!;
  const kin = ix.kin.get(d.kinId);
  // A hero is painted for every class and kin (each kin is one gender).
  const art = (key?: string) => (key && setup.assets[key] ? assetUrl(worldId, setup.assets[key]) : undefined);
  const figure = (classId: string, kinId: string) => art(setup.origins.find((o) => o.id === classId)?.assets?.[kinId]);
  const sprite = figure(d.classId, d.kinId);
  const st = preview.stats;
  const start = async () => {
    setBusy(true);
    setError('');
    const specs: CharSpec[] = party.map(({ name, classId, kinId }) => ({ name: name.trim(), classId, kinId }));
    try {
      if (joining) {
        // A player's first heroes go straight into the game; more heroes back to the adventure's page.
        const first = !joining.party.length && !joining.bench.length;
        await api.addHeroes(joining.id, specs);
        return navigate(first ? `#/play/${joining.id}` : `#/adventure/${joining.id}`);
      }
      const { adventureId } = await api.createAdventure(worldId, adventureName, specs, difficulty, friends);
      navigate(`#/play/${adventureId}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  // What the class learns as it grows: its tree's skills, tier by tier.
  const learns = cls.nodes.filter((n) => n.kind === 'skill' && n.skillId && !cls.startingSkills.includes(n.skillId)).sort((a, b) => a.tier - b.tier);
  const suggest = () => update({ name: nameFor(r, d.kinId, new Set(party.map((p) => p.name))), suggested: true });
  const diffIndex = DIFFICULTIES.indexOf(difficulty);
  const addHero = () => {
    setParty((p) => [...p, newDraft(setup, p.length, new Set(p.map((x) => x.name)))]);
    setIdx(party.length);
  };
  const removeHero = (i: number) => {
    setParty((p) => p.filter((_, j) => j !== i));
    setIdx((cur) => Math.max(0, cur >= i ? cur - 1 : cur));
  };

  return (
    <MoonScreen scene="clouds" me={me} back={back}>
      <main className="m-page">
        <div className="m-new-top m-pool">
          <div className="m-eyebrow">{joining ? `Heroes for ${joining.name}, in` : 'A new adventure in'}</div>
          <h1 className="m-big" style={{ marginTop: 10 }}>{setup.concept.title}</h1>
          <p className="m-lede">{setup.concept.pitch}</p>
          {joining && joining.newHeroLevel > 1 && <p className="m-fine" style={{ marginTop: 8 }}>They join at level {joining.newHeroLevel}, where the others are, with gear of that level and {r.terminology.talentPoints} to spend in the game.</p>}
        </div>

        {/* Heroes: one, or a party. In fights each is commanded by you or fights on their own, switched at any time. */}
        <div className="m-heroes" role="tablist" aria-label="Your heroes">
          {party.map((p, i) => (
            <span key={i} className="m-herotab-wrap">
              <button role="tab" aria-selected={i === idx} className={`m-herotab${i === idx ? ' on' : ''}`} onClick={() => setIdx(i)}>
                <span className="m-ring">{figure(p.classId, p.kinId) ? <img src={figure(p.classId, p.kinId)} alt="" /> : (p.name[0] ?? '?')}</span>
                <span><b>{p.name || `Hero ${i + 1}`}</b><span>{ix.kin.get(p.kinId)?.name} · {ix.cls.get(p.classId)?.name}</span></span>
              </button>
              {party.length > 1 && <button type="button" className="m-herotab-x" title={`Leave ${p.name || 'this hero'} out`} aria-label={`Remove ${p.name || `hero ${i + 1}`}`} onClick={() => removeHero(i)}><Sigil name="cross" className="" /></button>}
            </span>
          ))}
          {party.length < MAX_HEROES && (
            <button type="button" className="m-herotab add" onClick={addHero} title="Another hero for your party: in fights you command them, or they fight on their own.">
              <span className="m-ring"><Sigil name="plus" className="" /></span>
              <span><b>Add a hero</b><span>{party.length === 1 ? 'Lead a party' : `Up to ${MAX_HEROES}`}</span></span>
            </button>
          )}
        </div>

        <div className="m-maker">
          <div className="m-panel m-stage-hero">
            <div className="light" />
            <div className="disc" />
            <div className="hero">{sprite && <img key={sprite} src={sprite} alt={`${d.name || 'Your hero'}, ${kin?.name ?? ''} ${cls.name}`} />}</div>
            <div className="m-name">
              <input value={d.name} maxLength={24} placeholder={idx === 0 ? 'Your name' : 'Their name'} aria-label={idx === 0 ? 'Your name' : 'Their name'} onChange={(e) => update({ name: e.target.value, suggested: false })} />
              <span className="pen"><Sigil name="pencil" className="" /></span>
              <button className="dice" type="button" title="Suggest a name" aria-label="Suggest a name" onClick={suggest}><Sigil name="dice" className="" /></button>
            </div>
            <div className="m-eyebrow">{d.name ? 'Type to change the name' : 'Type a name'}</div>
            <div className="who">{kin?.name} {cls.name}</div>
          </div>

          <div className="m-panel pad m-choose">
            <span className="m-eyebrow quiet">{t.calling}</span>
            <div className="m-classes">
              {r.classes.map((c) => (
                <button key={c.id} type="button" className={`m-pick small m-cls${d.classId === c.id ? ' on' : ''}`} aria-pressed={d.classId === c.id} onClick={() => update({ classId: c.id })}>
                  <div className="head"><span className="t">{c.name}</span><span className="role">{ROLE_TAG[c.role]}</span></div>
                  <div className="d">{c.description}</div>
                  <div className="skills">
                    {c.startingSkills.map((s) => <span key={s} {...tip(<SkillTooltip id={s} r={r} flavor />)}><SkillIcon id={s} size={28} /></span>)}
                  </div>
                </button>
              ))}
            </div>
            {r.kins.length > 1 && (
              <>
                <span className="m-eyebrow quiet" style={{ marginTop: 20 }}>{t.kin}</span>
                <div className="m-kins">
                  {r.kins.map((k) => {
                    const face = figure(d.classId, k.id);
                    return (
                      <button key={k.id} type="button" className={`m-kin${d.kinId === k.id ? ' on' : ''}`} aria-pressed={d.kinId === k.id} onClick={() => update({ kinId: k.id })} {...tip(<div><div className="tname gold">{k.name}</div><div className="tdesc" style={{ marginTop: 0 }}>{k.description}</div></div>)}>
                        <span className="face">{face && <img src={face} alt="" />}</span>
                        {k.name}
                      </button>
                    );
                  })}
                </div>
                {kin && <div className="m-kin-note">{kin.description}</div>}
              </>
            )}
            {learns.length > 0 && (
              <>
                <span className="m-eyebrow quiet" style={{ marginTop: 20 }}>A {cls.name} learns</span>
                <div className="m-tags">
                  {learns.map((n) => (
                    <span key={n.id} className="m-tag" {...tip(<SkillTooltip id={n.skillId!} r={r} flavor />)}>
                      <i />{ix.skill.get(n.skillId!)?.name ?? n.name}
                    </span>
                  ))}
                </div>
                <div className="m-kin-note">Every class’s skills are open to every hero as they grow, so a party can mix them.</div>
              </>
            )}
          </div>

          <div className="m-panel pad m-stats">
            <span className="m-eyebrow quiet" style={{ marginBottom: 0 }}>At {t.level.toLowerCase()} 1</span>
            <div className="m-vitals">
              <div className="m-vital"><b>{st.maxHp}</b><span>{r.health.name}</span></div>
              <div className="m-vital"><b>{st.apPerTurn}</b><span>{t.actionPoints} per turn</span></div>
            </div>
            <div className="m-kv">
              <span>Weapon</span><b>{Math.round(st.weapon.min)}–{Math.round(st.weapon.max)}{st.weapon.melee ? '' : ` · range ${Math.round(st.weapon.range)}`}</b>
              <span>Fights</span><b>{cls.reach === 'melee' ? 'Up close' : 'From a distance'}</b>
              <span>Deals</span><b>{ix.type.get(cls.damageTypeId)?.name ?? ''}</b>
            </div>
          </div>
        </div>

        {joining ? (
          <div className="m-panel m-begin">
            <div className="m-fine">{party.length === 1 ? 'Your hero joins' : `Your ${party.length} heroes join`} {joining.name}. In fights you command them, or let any of them fight on their own.</div>
            <button className="m-lantern" disabled={busy || party.some((p) => !p.name.trim())} title={party.some((p) => !p.name.trim()) ? 'Every hero needs a name.' : undefined} onClick={start}>{joining.party.length || joining.bench.length ? 'Make them' : 'Join the adventure'}</button>
            {error && <div className="m-error" role="alert">{error}</div>}
          </div>
        ) : (
        <div className="m-panel m-begin">
          <div className="diff">
            <span className="m-eyebrow quiet">How hard · you can change it later</span>
            <div className="m-stars-pick" role="radiogroup" aria-label="How hard">
              {DIFFICULTIES.map((x, i) => (
                <button key={x} type="button" role="radio" aria-checked={x === difficulty} className={`${i < diffIndex ? 'lit' : ''}${x === difficulty ? ' on' : ''}`} title={DIFFICULTY_TEXT[x]} onClick={() => setDifficulty(x)}>
                  <span className="seat"><i /></span>
                  <b>{r.difficulty[x].name}</b>
                  <small>{DIFFICULTY_SHORT[x]}</small>
                </button>
              ))}
            </div>
          </div>
          {players.length > 0 && (
            <div>
              <span className="m-eyebrow" style={{ color: 'var(--muted)' }}>Play with friends · you can change it later</span>
              <div className="m-friends">
                {players.map((p) => (
                  <button key={p.id} type="button" className={`m-tag m-friend${friends.includes(p.id) ? ' on' : ''}`} aria-pressed={friends.includes(p.id)} onClick={() => setFriends((f) => (f.includes(p.id) ? f.filter((x) => x !== p.id) : [...f, p.id]))}>
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <label className="m-eyebrow" htmlFor="adv-name" style={{ color: 'var(--muted)' }}>Name this adventure</label>
            <input id="adv-name" className="m-well" maxLength={60} value={adventureName} onChange={(e) => setAdventureName(e.target.value)} placeholder={party[0]?.name.trim() ? `${party[0].name.trim()}’s adventure` : 'A new adventure'} />
          </div>
          <button className="m-lantern" disabled={busy || party.some((p) => !p.name.trim())} title={party.some((p) => !p.name.trim()) ? 'Every hero needs a name.' : undefined} onClick={start}>Begin the adventure</button>
          {error && <div className="m-error" role="alert">{error}</div>}
        </div>
        )}
      </main>
    </MoonScreen>
  );
}

function newDraft(s: WorldSetup, i: number, taken: Set<string>): Draft {
  const r = s.ruleset;
  const kinId = r.kins[i % r.kins.length]!.id;
  // Every hero starts with a name from their people, ready to keep or change.
  return { name: nameFor(r, kinId, taken), suggested: true, classId: r.classes[i % r.classes.length]!.id, kinId };
}
