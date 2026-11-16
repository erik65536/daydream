/**
 * A world being dreamed (its build): the dream in the middle of the sky, the bubble its owner pressed Dream on, growing
 * into the world; round it lanterns rise or a galaxy gathers (a world keeps the look it was given, ui/dream.ts). Under
 * it a ledger counts what the build makes, part by part, as it happens: the world written, places painted, pictures,
 * balancing, voices, and sound (server: worldgen/activity.ts). Counts only, never anything of the world itself, so
 * nothing is spoiled. When it is done the clouds part on the world.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BuildActivity, GameLength, Made, WorldSize } from '@daydream/shared';
import { api, assetUrl, type JobPhase, type JobStatus, type Me, type WorldSummary } from '../api';
import { DreamSky, MoonScreen, Sigil, type NightLevel } from '../ui/night';
import { lookFor, startDream, type DreamLook, type DreamState } from '../ui/dream';
import { hours, useBuildEstimate } from '../ui/estimate';
import { plural } from '../ui/format';
import { ask, tell } from '../ui/ask';
import { navigate } from '../App';

const n = (x: number) => x.toLocaleString('en');
const fracOf = (m: Made) => (m.total ? m.done / m.total : m.frac ?? 0);

type Card = 'writing' | 'places' | 'characters' | 'creatures' | 'items' | 'balance' | 'voices' | 'sounds';
type CardState = 'pending' | 'active' | 'done';

/**
 * The ledger's cards: what each counts, in words a newcomer follows, and the build stages (job phases) it belongs to.
 * The pictures share one stage; each kind is done when all of its pictures are.
 */
const CARDS: { id: Card; label: string; sigil: string; phase: (id: string) => boolean; show: (a: BuildActivity) => { count: string; note: string; frac: number; made?: Made } }[] = [
  {
    id: 'writing', label: 'Writing', sigil: 'quill', phase: (id) => id.startsWith('text:'),
    show: (a) => ({ count: a.writing.total ? `${a.writing.done} of ${a.writing.total}` : '…', note: a.writing.words ? `${plural(a.writing.words, 'word')} so far` : 'Its rules, story, and people', frac: fracOf(a.writing) }),
  },
  {
    id: 'places', label: 'Places', sigil: 'map', phase: (id) => id === 'places',
    show: ({ places: p }) => ({
      count: p.total ? `${p.done} of ${p.total}` : '…',
      note: p.paintings ? [plural(p.paintings, 'painting'), p.setAside && `${n(p.setAside)} set aside`].filter(Boolean).join(' · ') : 'Painted and explored',
      frac: fracOf(p),
      made: p,
    }),
  },
  { id: 'characters', label: 'Characters', sigil: 'person', phase: (id) => id === 'art', show: (a) => ({ count: a.characters.total ? `${a.characters.done} of ${a.characters.total}` : '…', note: 'Heroes and townsfolk', frac: fracOf(a.characters), made: a.characters }) },
  { id: 'creatures', label: 'Creatures', sigil: 'claw', phase: (id) => id === 'art', show: (a) => ({ count: a.creatures.total ? `${a.creatures.done} of ${a.creatures.total}` : '…', note: 'Creatures and bosses', frac: fracOf(a.creatures), made: a.creatures }) },
  { id: 'items', label: 'Items', sigil: 'gem', phase: (id) => id === 'art', show: (a) => ({ count: a.items.total ? `${a.items.done} of ${a.items.total}` : '…', note: 'Gear, potions, and treasures', frac: fracOf(a.items), made: a.items }) },
  { id: 'balance', label: 'Balance', sigil: 'scales', phase: (id) => id === 'balance', show: (a) => ({ count: a.balance.fights ? plural(a.balance.fights, 'fight') : '…', note: 'Fights that tune the numbers', frac: fracOf(a.balance) }) },
  { id: 'voices', label: 'Voices', sigil: 'voice', phase: (id) => id === 'voices', show: (a) => ({ count: a.voices.done ? plural(a.voices.done, 'voice') : `${Math.round(fracOf(a.voices) * 100)}%`, note: 'For everyone who speaks', frac: fracOf(a.voices) }) },
  { id: 'sounds', label: 'Sound', sigil: 'note', phase: (id) => id === 'sounds', show: (a) => ({ count: a.sounds.done ? plural(a.sounds.done, 'sound') : `${Math.round(fracOf(a.sounds) * 100)}%`, note: 'Effects and music', frac: fracOf(a.sounds) }) },
];

/** A card's state from its stages: done when every stage of it is (or, for a kind of picture, when all are painted). */
function stateOf(card: (typeof CARDS)[number], phases: JobPhase[], made: Made | undefined, ready: boolean): CardState {
  if (ready) return 'done';
  const ps = phases.filter((p) => card.phase(p.id) && p.status !== 'skipped');
  if (made?.total && made.done >= made.total) return 'done';
  if (ps.length && ps.every((p) => p.status === 'done')) return 'done';
  return ps.some((p) => p.status === 'active') ? 'active' : 'pending';
}

/** The text steps' groups (pipeline/order.yaml) when finished, said plainly. */
const WRITTEN: Record<string, string> = {
  'text:World': 'The world takes shape',
  'text:Rules': 'Its rules are written',
  'text:Map and story': 'Its map and story are written',
  'text:Places and people': 'Its places and people are written',
  'text:Looks and sound': 'Its looks and sounds are chosen',
};

/** What happened between two looks at the counts, said softly, one thing at a time (nothing of the world itself). */
function news(was: BuildActivity, now: BuildActivity, finished: string[]): string[] {
  const out = finished.map((id) => WRITTEN[id] ?? 'A part of the world is written');
  const more = (a: number, b: number, one: string, many: string) => (b > a ? [b - a === 1 ? one : many.replace('#', n(b - a))] : []);
  out.push(
    ...more(was.places.done, now.places.done, 'A place is painted', '# places are painted'),
    ...more(was.places.setAside, now.places.setAside, 'A painting is set aside, and another begun', '# paintings are set aside, and others begun'),
    ...more(was.places.relaid, now.places.relaid, 'A place is laid out anew', '# places are laid out anew'),
    ...more(was.characters.done, now.characters.done, 'A character is painted', '# characters are painted'),
    ...more(was.creatures.done, now.creatures.done, 'A creature is painted', '# creatures are painted'),
    ...more(was.items.done, now.items.done, 'An item is painted', '# items are painted'),
    ...more(was.redrawn, now.redrawn, 'A picture is painted again, to get it right', '# pictures are painted again, to get them right'),
  );
  const thousand = Math.floor(now.balance.fights / 1000);
  if (thousand > Math.floor(was.balance.fights / 1000)) out.push(`${n(thousand * 1000)} fights simulated`);
  if (!was.voices.done && now.voices.done) out.push(`${plural(now.voices.done, 'voice')} found`);
  if (Math.floor(now.sounds.done / 10) > Math.floor(was.sounds.done / 10)) out.push(`${plural(now.sounds.done, 'sound')} made`);
  return out;
}

/** How long each whisper stays, and so how often a new one may come. */
const WHISPER_MS = 3200;

/** Whispers: what the build just did, one at a time under the dream; quiet once the world is ready. */
function useWhispers(activity: BuildActivity | undefined, phases: JobPhase[], ready: boolean) {
  const [whisper, setWhisper] = useState<{ id: number; text: string } | null>(null);
  const last = useRef<{ a: BuildActivity; done: Set<string> } | null>(null), queue = useRef<string[]>([]);
  useEffect(() => {
    if (!activity) return;
    const done = new Set(phases.filter((p) => p.status === 'done').map((p) => p.id));
    // What was already made when the page opened is simply there; only what is made after is told.
    if (ready) queue.current = [];
    else if (last.current) queue.current = [...queue.current, ...news(last.current.a, activity, [...done].filter((id) => !last.current!.done.has(id)))].slice(-3);
    last.current = { a: activity, done };
  }, [activity, phases, ready]);
  useEffect(() => {
    let k = 0;
    const t = setInterval(() => {
      const text = queue.current.shift();
      setWhisper(text ? { id: ++k, text } : null);
    }, WHISPER_MS);
    return () => clearInterval(t);
  }, []);
  return whisper;
}

const leftText = (h: number) => (h < 1 / 60 ? 'almost there' : h < 1 / 6 ? 'a few minutes left' : `about ${hours(h)} left`);

export function Dreaming({ me, w, job, canManage, ready, onSeen, extra, look = lookFor(w.id) }: { me: Me; w: WorldSummary; job: JobStatus | null; canManage: boolean; ready: boolean; onSeen: () => void; extra?: ReactNode; look?: DreamLook }) {
  const page = useRef<HTMLElement>(null), orb = useRef<HTMLDivElement>(null), back = useRef<HTMLCanvasElement>(null), front = useRef<HTMLCanvasElement>(null);
  const scenery = useRef<HTMLDivElement>(null), level = useRef<NightLevel>({ current: 0.15 });
  const phases = job?.phases ?? [];
  const activity = job?.preview.activity;
  const p = ready ? 1 : job?.progress ?? 0;
  const estimate = useBuildEstimate(w.input.size as WorldSize, w.input.length as GameLength);
  const pictures = activity ? activity.characters.done + activity.creatures.done : 0, picturesTotal = activity ? (activity.characters.total ?? 0) + (activity.creatures.total ?? 0) : 0;
  const state = useRef<DreamState>({ p, places: 0, placesTotal: 0, people: 0, peopleTotal: 0, ready });
  state.current = { p, places: activity?.places.done ?? 0, placesTotal: activity?.places.total ?? 0, people: pictures, peopleTotal: picturesTotal, ready };
  const palette = [w.palette.primary, w.palette.secondary, w.palette.accent, w.palette.ui];
  // The sky starts once the build's stages are known, so it knows how many places to make room for.
  const known = phases.length > 0 || ready;

  useEffect(() => {
    if (!known || !page.current || !orb.current || !back.current || !front.current) return;
    return startDream({ look, page: page.current, orb: orb.current, back: back.current, front: front.current, palette, state: () => state.current });
    // The look and the palette are fixed for a world; restarting on every poll would lose the sky.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [known, look, w.id]);

  // The night forms as the world does: the painting and its mist fade in and sharpen over the bare night sky, and the
  // stars come out.
  useEffect(() => {
    level.current.current = 0.15 + 0.85 * p;
    if (scenery.current) {
      scenery.current.style.transition = 'opacity 1.5s, filter 1.5s';
      scenery.current.style.opacity = (0.08 + 0.92 * p).toFixed(3);
      scenery.current.style.filter = `blur(${((1 - p) * 10).toFixed(1)}px) saturate(${(0.5 + p * 0.5).toFixed(2)})`;
    }
  }, [p]);

  const whisper = useWhispers(activity, phases, ready);
  const cards = useMemo(() => CARDS.map((c) => {
    const shown = activity ? c.show(activity) : { count: '…', note: '', frac: 0, made: undefined };
    return { ...c, ...shown, state: stateOf(c, phases, shown.made, ready) };
  }), [activity, phases, ready]);

  const status = ready ? 'Ready' : job?.status === 'queued' ? 'Waiting its turn' : job?.status === 'waiting' ? 'Waiting for a model' : `Being dreamed · ${Math.round(p * 100)}%`;
  const line = ready
    ? 'The clouds part. Your world is ready.'
    : job?.status === 'queued'
      ? job.queuePosition ? `${plural(job.queuePosition, 'world')} ahead of it` : 'Starting soon'
      : job?.status === 'waiting'
        ? 'A model is busy; it carries on as soon as one is free'
        : leftText(estimate.hours * (1 - p));

  return (
    <MoonScreen scene="sky" me={me} back={{ label: 'Worlds', to: '#/' }} level={level.current} sceneryRef={scenery}>
      <main ref={page} className={`m-dreaming${ready ? ' ready' : ''}`} style={{ '--p': p.toFixed(3), '--c1': palette[0], '--c2': palette[1], '--c3': palette[2], '--c4': palette[3] } as React.CSSProperties}>
        <div className="m-aurora" style={{ opacity: Math.min(1, Math.max(0, (p - 0.02) / 0.15)) * 0.55 * (ready ? 0.6 : 1) }}><i /><i /><i /></div>
        <canvas ref={back} className="m-orb-canvas back" />
        <div className="m-dream-head">
          <div className="m-eyebrow">{status}</div>
          <h1>{w.title}</h1>
          <p className="m-dream-line">{line}</p>
        </div>
        <div className="m-dream-wrap">
          <div className={`m-dream-core${look === 'galaxy' ? ' galaxy' : ''}`}>
            <div ref={orb} className="m-orb" title="Touch the dream">
              <div className="inside m-sky">
                <DreamSky />
                {ready && w.coverArt?.scene && (
                  <div className="clear">
                    <div className="scene" style={{ backgroundImage: `url(${assetUrl(w.id, w.coverArt.scene)})` }} />
                    <div className="figs">{w.coverArt.figures.slice(0, 3).map((f) => <img key={f} src={assetUrl(w.id, f)} alt="" />)}</div>
                  </div>
                )}
              </div>
              <div className="glass" />
              <div className="flash" />
            </div>
          </div>
        </div>
        <canvas ref={front} className="m-orb-canvas front" />
        <div className="m-dream-foot">
          <div className="m-whispers" aria-live="polite">{whisper && <div key={whisper.id} className="m-whisper">{whisper.text}</div>}</div>
          <div className="m-ledger" role="list" aria-label="What is being made">
            {cards.map((c) => (
              <div key={c.id} role="listitem" className={`m-ledger-card ${c.state}`} style={{ '--f': Math.min(1, c.frac).toFixed(3) } as React.CSSProperties}>
                <Sigil name={c.sigil} size={20} />
                <div className="what">
                  <div className="top"><b>{c.label}</b><span key={c.count} className="count">{c.state === 'pending' ? '' : c.count}</span></div>
                  <div className="note">{c.note}</div>
                  <div className="bar"><i /></div>
                </div>
              </div>
            ))}
          </div>
          {activity && activity.calls > 0 && (
            <div className="m-dream-stats">
              {[plural(activity.calls, 'model call'), activity.gpuMinutes && `${n(Math.round(activity.gpuMinutes))} GPU minutes`, activity.prompts && plural(activity.prompts, 'picture described', 'pictures described'), activity.redrawn && `${n(activity.redrawn)} painted again`].filter(Boolean).join(' · ')}
            </div>
          )}
          <div className="m-dream-actions">
            {ready ? (
              <>
                <button className="m-quiet" onClick={onSeen}>See the world</button>
                <button className="m-lantern" onClick={() => navigate(`#/world/${w.id}/new`)}>Begin a new adventure</button>
              </>
            ) : (
              <>
                <span className="m-fine">It keeps dreaming if you leave.</span>
                {canManage && <button className="m-quiet m-small" onClick={() => void ask('Everything finished so far is kept, and it can be resumed.', { title: 'Stop dreaming this world?', yes: 'Stop' }).then((ok) => void (ok && api.cancelJob(w.id).catch((e) => void tell((e as Error).message))))}>Stop</button>}
              </>
            )}
          </div>
          {extra}
        </div>
      </main>
    </MoonScreen>
  );
}
