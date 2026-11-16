/**
 * Making a world (server: worldgen/review.ts). Its owner describes it; Next has the build's first steps write its
 * concept and choose its rules, which they review, setting any rule by hand, before they dream it. The page keeps
 * everything until then, so Back and Next lose nothing, and Next writes again only when the description changed.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { GAME_LENGTHS, LENGTH_PROFILES, PROMPT_TOPICS, WORLD_SIZES, SIZE_PROFILES, buildEstimate, type BuildRates, type CommunicationLevel, type PromptTopic, type ReviewView, type RuleSystems, type RulesChoices, type WorldInput, type WorldSize } from '@daydream/shared';
import { api, type Me } from '../api';
import { MoonScreen, NewWorldBubble, Sigil, Toggle } from '../ui/night';
import { dollars, hours, useBuildRates } from '../ui/estimate';
import { capital, plural, usd } from '../ui/format';
import { ask } from '../ui/ask';
import { guardLeaving, navigate } from '../App';

type Prompt = { topic: PromptTopic; text: string };
/** What the owner writes on the first step: everything the review is written from. */
type Description = Pick<WorldInput, 'theme' | 'size' | 'length'> & { prompts: Prompt[] };

const PRESETS: { name: string; theme: string; prompts?: Prompt[] }[] = [
  {
    name: 'The Drowned Kingdom',
    theme: 'A once-great coastal kingdom slowly sinking into a warm, glowing sea. Bell towers poke out of tide pools, fishermen pole flat boats over flooded market squares, and the old royal family rules from a cathedral on stilts. Melancholy, beautiful, a little haunted.',
    prompts: [{ topic: 'story', text: 'The sea is rising because something beneath it is waking. The royal family knows and has been bargaining with it for generations.' }],
  },
  {
    name: 'Derelict Star Station',
    theme: 'A sprawling mining station orbiting a dying red star, half its rings abandoned after a mysterious accident. Rival crews scavenge the dark sections while the station AI keeps making cheerful announcements to people who are no longer there. Gritty, with dry humor.',
    prompts: [
      { topic: 'story', text: 'The accident was not an accident. The station AI is protecting something it found in the star.' },
      { topic: 'rules', text: 'No magic: tech and psionics instead.' },
    ],
  },
  {
    name: 'Bramblewood Hollow',
    theme: 'A cozy woodland of talking animals: badger blacksmiths, hedgehog healers, mice running tea shops inside hollow logs. The seasons are turning strangely and spring has not arrived.',
    prompts: [
      { topic: 'story', text: 'Someone has stolen the Spring Lantern. A gentle mystery, with friendship and courage more important than fighting.' },
      { topic: 'monsters', text: 'Suitable for children: opponents are mischievous rather than evil, and nothing is gory.' },
    ],
  },
  {
    name: 'The Last Printer',
    theme: 'A soul-crushing corporate office tower, present day. Fluorescent lights, endless cubicles, a breakroom with a fridge nobody has cleaned since 2009. Somewhere on the 40th floor is the last office printer, and it has become self-aware. Comedy, absurd but played completely straight.',
    prompts: [{ topic: 'story', text: 'Find the last printer and shut it down before it prints the memo that ends the world. Office politics are deadlier than any monster.' }],
  },
  {
    name: 'Wonderland, Inside Out',
    theme: 'An insane, ever-shifting wonderland of impossible gardens, upside-down tea houses, staircases that argue, and a queen whose rules change every hour. Logic is a suggestion and riddles are currency.',
    prompts: [
      { topic: 'story', text: 'You fell in. The only way out is to solve the Riddle of the Clockwork Queen.' },
      { topic: 'people', text: 'Puzzle-forward, whimsical, sharp dialogue.' },
    ],
  },
];

const TOPIC: Record<PromptTopic, { label: string; hint: string }> = {
  story: { label: 'Story', hint: 'A villain, a twist, the quests you enjoy…' },
  places: { label: 'Places', hint: 'A town on stilts, a dungeon inside a whale…' },
  people: { label: 'People', hint: 'Make the merchants funny, everyone speaks in rhyme…' },
  monsters: { label: 'Monsters', hint: 'No undead, foes are mischievous rather than evil…' },
  rules: { label: 'Rules and words', hint: 'No magic, call the money credits…' },
  art: { label: 'Art', hint: 'Watercolor, ink outlines, a muted palette…' },
};

const COMMUNICATION: { t: string; d: string }[] = [
  { t: 'Private', d: 'People keep what you tell them to themselves.' },
  { t: 'Close circles', d: 'News reaches their friends and family.' },
  { t: 'Small-town', d: 'Whole towns hear what you do. Tell one person your birthday is tomorrow, and the town might throw you a party.' },
  { t: 'Legend', d: 'Your deeds ripple across the whole world.' },
];

const sizeText = (s: WorldSize) => {
  const p = SIZE_PROFILES[s];
  return `${plural(p.towns, 'town', 'towns')}, ${plural(p.wilds, 'wild', 'wilds')}, ${plural(p.dungeons, 'dungeon', 'dungeons')}`;
};

/** The description as the server takes it: notes left empty dropped. */
function tidy(d: Description) {
  const prompts = d.prompts.filter((p) => p.text.trim()).map((p) => ({ topic: p.topic, text: p.text.trim() }));
  return { theme: d.theme.trim(), size: d.size, length: d.length, ...(prompts.length && { prompts }) };
}

// ------------------------------------------------------------------ the page

export function CreateWorld({ me, onMe }: { me: Me; onMe: (me: Me) => void }) {
  const [description, setDescription] = useState<Description>({ theme: '', prompts: [], size: 'small', length: 'short' });
  const [communication, setCommunication] = useState<CommunicationLevel>(2);
  const [animate, setAnimate] = useState(false);
  const [rules, setRules] = useState<RulesChoices>({});
  const [review, setReview] = useState<ReviewView | null>(null);
  /** The description the review was written from: Next writes again only when it changed. */
  const [writtenFrom, setWrittenFrom] = useState('');
  const [step, setStep] = useState<0 | 1>(0);
  const [writing, setWriting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const page = useRef<HTMLElement>(null);
  const rates = useBuildRates();
  // What is left of this month's budget is as the server has it now (null: no limit).
  useEffect(() => void api.me().then(onMe, () => {}), []);
  const left = me.ai.budget === null ? null : Math.max(0, me.ai.budget - me.ai.spentMonth);

  // A review is lost with the page: a reload, a closed tab, or opening another page asks first.
  useEffect(() => {
    if (!review || creating) return;
    const stay = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener('beforeunload', stay);
    guardLeaving(() => ask('Leave without dreaming this world? What was written for it is lost.', { title: 'Leave', yes: 'Leave', no: 'Stay' }));
    return () => {
      removeEventListener('beforeunload', stay);
      guardLeaving(null);
    };
  }, [review, creating]);

  const go = (to: 0 | 1) => {
    setStep(to);
    setError('');
    page.current?.closest('.m-root')?.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const input = (): WorldInput => ({ ...tidy(description), communication, animate, ...(Object.keys(rules).length && { rules }) });

  const next = async () => {
    const from = JSON.stringify(tidy(description));
    go(1);
    if (review && !review.failed && from === writtenFrom) return;
    setWriting(true);
    try {
      setReview(await api.review(input(), review?.id));
      setWrittenFrom(from);
    } catch (e) {
      go(0);
      setError((e as Error).message);
    }
    setWriting(false);
  };

  const create = async () => {
    if (!review) return;
    setCreating(true);
    setError('');
    try {
      const { worldId } = await api.createWorld(input(), review.id);
      navigate(`#/world/${worldId}`);
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  };

  const title = step === 1 && !writing ? review?.concept?.title : undefined;
  return (
    <MoonScreen scene="clouds" me={me} back={{ label: 'Worlds', to: '#/' }}>
      <main className="m-page narrow m-create" ref={page}>
        <div className="m-create-top m-pool">
          <div className="m-bob" style={{ '--dur': '7s' } as React.CSSProperties}><NewWorldBubble brewing={writing} /></div>
          <h1 className="m-big" key={title ?? ''}>{title ?? 'Dream up a new world'}</h1>
          <Steps at={step} />
        </div>
        {step === 0 ? (
          <Describe
            description={description}
            onChange={setDescription}
            animate={animate}
            rates={rates}
            error={error}
            onNext={() => void next()}
            onCancel={() => navigate('#/')}
          />
        ) : (
          <Review
            review={writing ? null : review}
            description={description}
            rules={rules}
            communication={communication}
            animate={animate}
            rates={rates}
            left={left}
            busy={creating}
            error={error}
            onRules={(chosen) => {
              setRules(chosen);
              if (review?.systems) setReview({ ...review, systems: withChoices(review.systems, chosen) });
            }}
            onCommunication={setCommunication}
            onAnimate={setAnimate}
            onRetry={() => void next()}
            onBack={() => go(0)}
            onCreate={() => void create()}
          />
        )}
      </main>
    </MoonScreen>
  );
}

/** Where the owner is: describing the world, reviewing what was written, then dreaming it. */
function Steps({ at }: { at: 0 | 1 }) {
  return (
    <ol className="m-steps" aria-label="Making a world">
      {['Describe it', 'Review it', 'Dream it'].map((s, i) => (
        <li key={s} className={i < at ? 'done' : i === at ? 'now' : ''} aria-current={i === at ? 'step' : undefined}>
          <span className="n">{i + 1}</span>
          <span className="t">{s}</span>
        </li>
      ))}
    </ol>
  );
}

// ------------------------------------------------------------------ step one: describing it

function Describe({ description: d, onChange, animate, rates, error, onNext, onCancel }: { description: Description; onChange: (d: Description) => void; animate: boolean; rates: BuildRates; error: string; onNext: () => void; onCancel: () => void }) {
  const set = (patch: Partial<Description>) => onChange({ ...d, ...patch });
  // A tiny world is for a brief story, and a brief story for a tiny world: picking one suggests the other.
  const pickSize = (size: WorldSize) => set({ size, length: size === 'tiny' ? 'brief' : d.length === 'brief' ? 'short' : d.length });
  const setNote = (i: number, text: string) => set({ prompts: d.prompts.map((p, j) => (j === i ? { ...p, text } : p)) });
  const used = new Set(d.prompts.map((p) => p.topic));
  const short = d.theme.trim().length < 10;
  return (
    <>
      <div className="m-panel pad">
        <label className="m-eyebrow" htmlFor="theme">Your world</label>
        <textarea
          id="theme"
          className="m-dream-input"
          maxLength={4000}
          value={d.theme}
          onChange={(e) => set({ theme: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !short && onNext()}
          placeholder="A frozen archipelago where whale-riders trade with sky-ships…"
        />
        <div className="m-seeds">
          <span className="m-eyebrow">Or begin from</span>
          {PRESETS.map((p) => <button key={p.name} type="button" className="m-seed" onClick={() => set({ theme: p.theme, prompts: p.prompts ?? [] })}>{p.name}</button>)}
        </div>
        <div className="m-notes">
          <span className="m-eyebrow quiet">Add a note about one part</span>
          {d.prompts.map((p, i) => (
            <div key={p.topic} className="m-prompt-row">
              <div className="topic-name">{TOPIC[p.topic].label}</div>
              <textarea className="m-well" maxLength={2000} value={p.text} placeholder={TOPIC[p.topic].hint} aria-label={`${TOPIC[p.topic].label} note`} onChange={(e) => setNote(i, e.target.value)} />
              <button type="button" className="m-x" aria-label={`Remove the ${TOPIC[p.topic].label.toLowerCase()} note`} onClick={() => set({ prompts: d.prompts.filter((_, j) => j !== i) })}>×</button>
            </div>
          ))}
          {used.size < PROMPT_TOPICS.length && (
            <div className="m-topics">
              {PROMPT_TOPICS.filter((t) => !used.has(t)).map((t) => <button key={t} type="button" className="m-topic" onClick={() => set({ prompts: [...d.prompts, { topic: t, text: '' }] })}>+ {TOPIC[t].label}</button>)}
            </div>
          )}
        </div>
      </div>

      <div className="m-panel pad m-choices">
        <div>
          <span className="m-eyebrow quiet">How big</span>
          <Picks
            label="How big"
            value={d.size}
            onChange={pickSize}
            options={WORLD_SIZES.map((v, i) => {
              const e = buildEstimate(v, d.length, rates);
              return { v, t: capital(v), d: sizeText(v), note: [`Playable in ${hours(e.hours, true)}`, `${dollars(e.usd + (animate ? e.animationUsd : 0))} to make`], pic: <SizeStars size={v} seed={[3, 7, 11, 5][i]!} /> };
            })}
          />
        </div>
        <div>
          <span className="m-eyebrow quiet">How long a story</span>
          <Picks label="How long a story" value={d.length} onChange={(length) => set({ length })} options={GAME_LENGTHS.map((v, i) => ({ v, t: capital(v), d: `${plural(LENGTH_PROFILES[v].arcs, 'story arc', 'story arcs')} · up to level ${LENGTH_PROFILES[v].maxLevel}`, pic: <MoonPhase f={(i + 1) / GAME_LENGTHS.length} /> }))} />
        </div>
      </div>

      {error && <div className="m-error m-said" role="alert">{error}</div>}
      <div className="m-actions">
        <button type="button" className="m-quiet" onClick={onCancel}>Cancel</button>
        <button type="button" className="m-lantern" disabled={short} title={short ? 'Describe your world in a sentence or more.' : undefined} onClick={onNext}>Next</button>
      </div>
    </>
  );
}

/** A row of small night panels to choose one from, each with a drawing; a size's notes say what building it takes. */
function Picks<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { v: T; t: string; d: string; note?: [string, string]; pic: React.ReactNode }[]; label: string }) {
  return (
    <div className={`m-picks${options.length % 2 ? ' odd' : ''}`} style={{ '--n': options.length } as React.CSSProperties} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.v} type="button" role="radio" className={`m-pick${value === o.v ? ' on' : ''}`} aria-checked={value === o.v} onClick={() => onChange(o.v)}>
          <div className="pic">{o.pic}</div>
          <div className="t">{o.t}</div>
          <div className="d">{o.d}</div>
          {o.note && <div className="note"><b>{o.note[0]}</b>{o.note[1]}</div>}
        </button>
      ))}
    </div>
  );
}

/** A moon at a phase (0 new, 1 full), lit from the right: how long a story. */
function MoonPhase({ f }: { f: number }) {
  const r = 20, k = Math.abs(1 - 2 * f) * r, sweep = f < 0.5 ? 0 : 1;
  const lit = useId();
  return (
    <svg width="46" height="46" viewBox="0 0 48 48" aria-hidden="true">
      <defs><radialGradient id={lit} cx="40%" cy="35%"><stop offset="0" stopColor="#fffaf0" /><stop offset="1" stopColor="#e3cf9f" /></radialGradient></defs>
      <circle cx="24" cy="24" r={r} fill="rgba(160,170,230,.12)" stroke="rgba(200,205,255,.25)" />
      {f >= 1 ? <circle cx="24" cy="24" r={r} fill={`url(#${lit})`} /> : <path d={`M24 4 A${r} ${r} 0 0 1 24 44 A${k} ${r} 0 0 ${sweep} 24 4Z`} fill={`url(#${lit})`} />}
    </svg>
  );
}

/** A world's size as a small constellation: gold towns, silver wilds, violet dungeons, joined by faint roads. */
function SizeStars({ size, seed }: { size: WorldSize; seed: number }) {
  const p = SIZE_PROFILES[size];
  let s = seed;
  const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const kinds = [...Array(p.towns).fill('#ffd48a'), ...Array(p.wilds).fill('#cfd6ff'), ...Array(p.dungeons).fill('#b98cff')] as string[];
  const pts = kinds.map((c, i) => {
    const a = (i / kinds.length) * Math.PI * 2 + rnd() * 0.6, d = 8 + rnd() * 16;
    return { x: 60 + Math.cos(a) * d * 2.1, y: 27 + Math.sin(a) * d * 0.95, c, big: i < p.towns };
  });
  return (
    <svg width="120" height="54" viewBox="0 0 120 54" aria-hidden="true">
      {pts.map((q, i) => (i ? <line key={`l${i}`} x1={pts[i - 1]!.x} y1={pts[i - 1]!.y} x2={q.x} y2={q.y} stroke="rgba(241,194,123,.25)" /> : null))}
      {pts.map((q, i) => <circle key={i} cx={q.x} cy={q.y} r={q.big ? 3.4 : 2.4} fill={q.c} style={{ filter: `drop-shadow(0 0 3px ${q.c})` }} />)}
    </svg>
  );
}

// ------------------------------------------------------------------ step two: reviewing it

type Flag = Exclude<keyof RuleSystems, 'revive' | 'storage' | 'defeat' | 'potions' | 'swing'>;
type Row =
  | { at: 'flag'; key: Flag; label: string; hint: string }
  | { at: 'potions'; key: keyof RuleSystems['potions']; label: string; hint: string }
  | { at: 'defeat'; key: keyof RuleSystems['defeat']; label: string; hint: string };

/** The systems a world may have, as its owner reads them, grouped by when a player meets them. */
const GROUPS: { title: string; rows: Row[]; pick?: 'revive' | 'storage' }[] = [
  {
    title: 'Fighting',
    rows: [
      { at: 'flag', key: 'magic', label: 'Magic', hint: 'A power apart from weapons and the body, or what stands for it here.' },
      { at: 'flag', key: 'healing', label: 'Healing skills', hint: 'Heroes heal one another in a fight.' },
      { at: 'flag', key: 'shields', label: 'Shields', hint: 'A one-handed weapon leaves the other hand for a shield.' },
      { at: 'flag', key: 'crit', label: 'Critical hits', hint: 'Some hits deal extra damage.' },
      { at: 'flag', key: 'dodge', label: 'Dodging', hint: 'Attacks can miss.' },
      { at: 'flag', key: 'control', label: 'Crowd control', hint: 'Skills that stun, root, silence, or disarm.' },
      { at: 'flag', key: 'lifeSteal', label: 'Life steal', hint: 'Damage dealt heals the attacker.' },
      { at: 'flag', key: 'thorns', label: 'Thorns', hint: 'Gear and buffs hurt whoever hits their wearer.' },
      { at: 'flag', key: 'regeneration', label: 'Regeneration', hint: 'Gear and buffs restore Health every turn of a fight.' },
    ],
  },
  {
    title: 'When heroes fall',
    pick: 'revive',
    rows: [
      { at: 'defeat', key: 'loseExperience', label: 'Lose experience', hint: 'A defeated party loses some of its experience.' },
      { at: 'defeat', key: 'loseMoney', label: 'Lose money', hint: 'A defeated party loses some of its money.' },
      { at: 'defeat', key: 'recoverBody', label: 'Go back for their gear', hint: 'Heroes drop their gear where they fall.' },
    ],
  },
  {
    title: 'Items and crafts',
    rows: [
      { at: 'flag', key: 'crafting', label: 'Crafting', hint: 'Materials make new items and gear.' },
      { at: 'flag', key: 'upgrades', label: 'Upgrades', hint: 'Materials make gear stronger.' },
      { at: 'flag', key: 'enchanting', label: 'Enchanting', hint: 'Materials give gear extra properties.' },
      { at: 'potions', key: 'healing', label: 'Healing potions', hint: 'Restore Health.' },
      { at: 'potions', key: 'cleansing', label: 'Cleansing potions', hint: 'Remove harmful statuses.' },
      { at: 'potions', key: 'buffs', label: 'Buff potions', hint: 'Give the drinker a helpful status.' },
      { at: 'potions', key: 'debuffs', label: 'Debuff potions', hint: 'Put a harmful status on foes.' },
      { at: 'potions', key: 'bombs', label: 'Bombs', hint: 'Damage foes.' },
    ],
  },
  {
    title: 'Getting around',
    pick: 'storage',
    rows: [{ at: 'flag', key: 'fastTravel', label: 'Fast travel', hint: 'Between towns the party has visited.' }],
  },
];

const REVIVES: { v: RuleSystems['revive']; t: string; d: string }[] = [
  { v: 'heal', t: 'Any healing', d: 'Healing a fallen hero brings them back.' },
  { v: 'special', t: 'Revive skills only', d: 'Only revive skills and items work in a fight.' },
  { v: 'after_combat', t: 'After the fight', d: 'Fallen heroes stay down until the fight is won.' },
];
const STORAGES: { v: RuleSystems['storage']; t: string; d: string }[] = [
  { v: 'none', t: 'No storage', d: 'Heroes carry everything they own.' },
  { v: 'each_town', t: 'A bank in each town', d: 'Each holds only what was left there.' },
  { v: 'shared', t: 'Shared storage', d: 'Every town reaches the same storage.' },
];

/** The steps written before the review, as the owner reads them. */
const STEP_NAMES: Record<string, string> = { ownerStyle: 'How people talk', concept: 'The world', rulesSystems: 'Its rules' };

/** An answer with the owner's choices in it, as the server makes it (worldgen/review.ts, withChoices). */
const withChoices = (s: RuleSystems, c: RulesChoices): RuleSystems => ({ ...s, ...c, defeat: { ...s.defeat, ...c.defeat }, potions: { ...s.potions, ...c.potions } }) as RuleSystems;

function Review(p: {
  /** Null while it is being written. */
  review: ReviewView | null;
  description: Description;
  rules: RulesChoices;
  communication: CommunicationLevel;
  /** Its characters get painted animations once it is built. */
  animate: boolean;
  rates: BuildRates;
  /** Dollars left of the owner's budget this month; null with no limit. */
  left: number | null;
  busy: boolean;
  error: string;
  onRules: (rules: RulesChoices) => void;
  onCommunication: (c: CommunicationLevel) => void;
  onAnimate: (on: boolean) => void;
  onRetry: () => void;
  onBack: () => void;
  onCreate: () => void;
}) {
  const { review, rules } = p;
  const concept = review?.concept, systems = review?.systems;
  /** A rule set by hand: the owner's choice from now on, shown at once. */
  const choose = (change: RulesChoices) => {
    const next: RulesChoices = { ...rules, ...change, defeat: { ...rules.defeat, ...change.defeat }, potions: { ...rules.potions, ...change.potions } };
    if (!Object.keys(next.defeat!).length) delete next.defeat;
    if (!Object.keys(next.potions!).length) delete next.potions;
    p.onRules(next);
  };
  // A row's value in a set of systems (the answer, or the owner's choices).
  const read = (from: RulesChoices | undefined, r: Row) => (r.at === 'flag' ? from?.[r.key] : (from?.[r.at] as Record<string, boolean> | undefined)?.[r.key]);
  const set = (r: Row, v: boolean) => choose(r.at === 'flag' ? { [r.key]: v } : { [r.at]: { [r.key]: v } });
  const e = buildEstimate(p.description.size, p.description.length, p.rates);
  const cost = e.usd + (p.animate ? e.animationUsd : 0);

  return (
    <div className="m-review" aria-busy={!review}>
      {review?.failed && (
        <div className="m-panel pad m-error m-failed" role="alert">
          <div>{STEP_NAMES[review.failed.step] ?? review.failed.step} could not be written: {review.failed.error}.</div>
          <button type="button" className="m-quiet m-small" onClick={p.onRetry}>Try again</button>
        </div>
      )}

      <section className="m-panel pad m-concept">
        <div className="m-eyebrow">The world</div>
        {concept ? (
          <div className="m-reveal">
            <div className="m-tags">
              <span className="m-tag"><i />{concept.genre}</span>
              <span className="m-tag">{capital(p.description.size)} · {capital(p.description.length)} story</span>
            </div>
            <p className="tone">{concept.tone}</p>
            <p className="setting">{concept.setting}</p>
          </div>
        ) : (
          <Lines n={4} label="Imagining the world…" />
        )}
      </section>

      <section className="m-panel pad m-systems">
        <div className="m-systems-head">
          <div className="m-eyebrow">Its rules</div>
          {systems && <p className="m-fine">Chosen to fit the world. Change any of them: what you set stays if you go back and change the description.</p>}
        </div>
        {systems ? (
          <div className="m-system-groups m-reveal">
            {GROUPS.map((g) => (
              <div key={g.title} className="m-system-group">
                <h3>{g.title}</h3>
                {g.pick === 'revive' && <Choice label="Fallen heroes get up" value={systems.revive} options={REVIVES} mine={rules.revive !== undefined} onChange={(v) => choose({ revive: v })} />}
                {g.rows.map((r) => <Toggle key={`${r.at}.${r.key}`} label={r.label} hint={r.hint} on={read(systems, r) ?? false} mine={read(rules, r) !== undefined} onChange={(v) => set(r, v)} />)}
                {g.pick === 'storage' && <Choice label="Storage in towns" value={systems.storage} options={STORAGES} mine={rules.storage !== undefined} onChange={(v) => choose({ storage: v })} />}
              </div>
            ))}
            <div className="m-system-group">
              <h3>People</h3>
              <Choice label="How far your deeds travel" value={p.communication} options={COMMUNICATION.map((c, i) => ({ v: i as CommunicationLevel, ...c }))} onChange={p.onCommunication} />
            </div>
          </div>
        ) : (
          <Lines n={3} label="Choosing its rules…" />
        )}
      </section>

      <section className="m-panel m-motion">
        <Toggle label="Character animations" hint={`Walk, attack, and hit animations for every character, for about ${dollars(e.animationUsd)} more.`} on={p.animate} onChange={p.onAnimate} />
      </section>

      {p.left !== null && cost > p.left && (
        <div className="m-error m-said" role="alert">This is more than the {usd(p.left)} you have left this month. The build would stop when your budget runs out, to be resumed when there is budget again.</div>
      )}
      {p.error && <div className="m-error m-said" role="alert">{p.error}</div>}
      <div className="m-actions m-final">
        <div className="m-summary">
          <Sigil name="hourglass" size={22} />
          <div>
            <b>Playable in about {hours(e.hours)}</b>, for about {dollars(cost)} of AI models{p.left !== null && `, of your ${usd(p.left)} left this month`}.
            <span>{p.animate ? `Character animations follow about ${hours(e.animationHours)} later.` : 'No character animations.'}</span>
          </div>
        </div>
        <button type="button" className="m-quiet" disabled={!review || p.busy} onClick={p.onBack}>Back</button>
        <button type="button" className="m-lantern" disabled={!review || !!review.failed || p.busy} onClick={p.onCreate}>Dream this world</button>
      </div>
    </div>
  );
}

/** Text being written: what is happening, and lines of light passing over gray bars. */
function Lines({ n, label }: { n: number; label: string }) {
  return (
    <div className="m-lines" role="status">
      <span className="what">{label}</span>
      {Array.from({ length: n }, (_, i) => <i key={i} />)}
    </div>
  );
}

/** One rule of a few ways. */
function Choice<T extends string | number>({ label, value, options, mine, onChange }: { label: string; value: T; options: { v: T; t: string; d: string }[]; mine?: boolean; onChange: (v: T) => void }) {
  return (
    <div className="m-rule-choice" role="radiogroup" aria-label={label}>
      <b>{label}{mine && <span className="mine">your choice</span>}</b>
      <div className="ways">
        {options.map((o) => (
          <button key={o.v} type="button" role="radio" aria-checked={value === o.v} className={value === o.v ? 'on' : ''} onClick={() => onChange(o.v)}>{o.t}</button>
        ))}
      </div>
      <span className="d">{options.find((o) => o.v === value)?.d}</span>
    </div>
  );
}
