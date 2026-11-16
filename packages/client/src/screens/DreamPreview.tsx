/**
 * Administrators only (#/dreaming): the page of a world being dreamed, played from a made-up build, sped up, to see
 * and tune it without building a world. The build's stages and counts follow a timeline shaped like a small world's
 * real build (writing first, then places, pictures, balancing, voices, and sound side by side); a world that is ready
 * lends its painting and people for the end. Nothing is sent to the server but the list of worlds.
 */
import { useEffect, useMemo, useState } from 'react';
import type { BuildActivity, Made } from '@daydream/shared';
import { api, type JobPhase, type JobStatus, type Me, type WorldSummary } from '../api';
import type { DreamLook } from '../ui/dream';
import { Dreaming } from './Dreaming';

/** A stage of the made-up build: when it runs, as shares of the whole. */
const TIMELINE: { id: string; label: string; from: number; to: number }[] = [
  { id: 'text:World', label: 'World', from: 0.03, to: 0.06 },
  { id: 'text:Rules', label: 'Rules', from: 0.05, to: 0.12 },
  { id: 'text:Map and story', label: 'Map and story', from: 0.06, to: 0.14 },
  { id: 'text:Places and people', label: 'Places and people', from: 0.14, to: 0.2 },
  { id: 'text:Looks and sound', label: 'Looks and sound', from: 0.12, to: 0.18 },
  { id: 'places', label: 'Painting places', from: 0.2, to: 0.86 },
  { id: 'balance', label: 'Balancing', from: 0.2, to: 0.42 },
  { id: 'art', label: 'Characters and items', from: 0.21, to: 0.72 },
  { id: 'voices', label: 'Voices', from: 0.22, to: 0.36 },
  { id: 'sounds', label: 'Sound and music', from: 0.55, to: 0.94 },
];

const share = (t: number, from: number, to: number) => Math.min(1, Math.max(0, (t - from) / (to - from)));
const counted = (t: number, from: number, to: number, total: number): Made => ({ done: Math.floor(share(t, from, to) * total), total });

/** The build at a moment `t` (0 to 1) of the timeline. */
function buildAt(t: number): JobStatus {
  const phases: JobPhase[] = TIMELINE.map((s) => ({ id: s.id, label: s.label, detail: '', status: t >= s.to ? 'done' : t >= s.from ? 'active' : 'pending' }));
  const writing = TIMELINE.filter((s) => s.id.startsWith('text:'));
  const stepsDone = writing.reduce((k, s) => k + Math.floor(share(t, s.from, s.to) * 4), 0);
  const places = share(t, 0.2, 0.86);
  const activity: BuildActivity = {
    writing: { done: stepsDone, total: 20, words: Math.round(share(t, 0.03, 0.2) * 31_400) },
    places: { done: Math.floor(places * 5), total: 5, paintings: Math.floor(places * 11.4), setAside: Math.floor(places * 4.2), relaid: places > 0.55 ? 1 : 0 },
    characters: counted(t, 0.26, 0.6, 30),
    creatures: counted(t, 0.28, 0.66, 12),
    items: counted(t, 0.3, 0.72, 48),
    prompts: Math.floor(share(t, 0.21, 0.27) * 90),
    redrawn: Math.floor(share(t, 0.3, 0.72) * 6),
    balance: { done: 0, frac: share(t, 0.2, 0.42), fights: Math.floor(share(t, 0.2, 0.42) * 5_280) },
    voices: { done: t >= 0.36 ? 14 : 0, frac: share(t, 0.22, 0.36) },
    sounds: { done: Math.floor(share(t, 0.55, 0.94) * 71), frac: share(t, 0.55, 0.94) },
    calls: Math.floor(share(t, 0.03, 0.95) * 640),
    gpuMinutes: Math.round(share(t, 0.2, 0.95) * 24 * 10) / 10,
  };
  return { kind: 'world', status: t < 0.03 ? 'queued' : 'running', queuePosition: 0, progress: Math.min(0.99, share(t, 0.03, 0.97)), step: '', log: [], preview: { activity }, phases };
}

const SPEEDS = [60, 180, 600] as const;

export function DreamPreview({ me }: { me: Me }) {
  const [worlds, setWorlds] = useState<WorldSummary[]>([]);
  const [seconds, setSeconds] = useState<(typeof SPEEDS)[number]>(180);
  const [look, setLook] = useState<DreamLook>('lanterns');
  const [t, setT] = useState(0);
  const [paused, setPaused] = useState(false);
  const [run, setRun] = useState(0);
  useEffect(() => void api.worlds().then(setWorlds, () => {}), []);
  // The world lends its palette, painting, and people; its title stands for the new world's.
  const lender = worlds.find((w) => w.status === 'ready' && w.coverArt?.scene) ?? worlds[0];
  useEffect(() => {
    if (paused) return;
    const t0 = performance.now() - t * seconds * 1000;
    const timer = setInterval(() => setT(Math.min(1.08, (performance.now() - t0) / (seconds * 1000))), 250);
    return () => clearInterval(timer);
    // The clock restarts from where it is when the speed changes or it is resumed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds, paused, run]);
  const ready = t >= 1;
  // At the end the build's last counts stay, as a finished build's do.
  const job = useMemo(() => (ready ? { ...buildAt(1), status: 'done' as const, progress: 1 } : buildAt(t)), [Math.round(t * 400), ready]);
  if (!lender) return <div className="center" style={{ height: '100%' }}><div className="spinner" /></div>;
  const w: WorldSummary = { ...lender, status: ready ? 'ready' : 'generating' };
  return (
    <>
      <Dreaming key={`${run}${look}`} me={me} w={w} job={job} canManage ready={ready} onSeen={() => setRun((r) => r + 1)} look={look} />
      <div className="m-panel m-dream-preview">
        <b>Preview</b>
        <input type="range" min={0} max={1.05} step={0.005} value={Math.min(1.05, t)} aria-label="Moment of the build" onChange={(e) => { setPaused(true); setT(+e.target.value); }} />
        <span>{Math.round(Math.min(1, t) * 100)}%</span>
        <button className="m-quiet m-small" onClick={() => setPaused((p) => !p)}>{paused ? 'Play' : 'Pause'}</button>
        <button className="m-quiet m-small" onClick={() => { setT(0); setPaused(false); setRun((r) => r + 1); }}>Again</button>
        <select value={seconds} aria-label="Length of the build" onChange={(e) => setSeconds(+e.target.value as (typeof SPEEDS)[number])}>{SPEEDS.map((s) => <option key={s} value={s}>{s / 60} min</option>)}</select>
        <select value={look} aria-label="Look" onChange={(e) => setLook(e.target.value as DreamLook)}><option value="lanterns">Lanterns</option><option value="galaxy">Galaxy</option></select>
      </div>
    </>
  );
}
