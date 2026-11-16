/**
 * What building the world took, from the records kept with it (server: worldgen/metrics.ts): each job's time,
 * dollars, tokens, pictures, GPU time, and tries, by step, by model purpose and by model, beside the estimate the
 * creation page gives a world of its size.
 */
import { useState } from 'react';
import type { BuildRecord, Tally } from '../../api';
import { Field, Split, date, minutes, thousands, usd, useView, type ListEntry } from './core';

/** Tallies added up. */
export function sumTallies(ts: Tally[]): Tally {
  const out: Tally = {};
  for (const t of ts) for (const [k, x] of Object.entries(t) as [keyof Tally, number][]) out[k] = (out[k] ?? 0) + (x ?? 0);
  return out;
}

/** The build's counts, one of each. */
const ONE: Record<string, string> = { towns: 'town', areas: 'area', tiles: 'tile', people: 'person', heroes: 'hero', creatures: 'creature', bosses: 'boss', items: 'item', sounds: 'sound', voices: 'voice' };

/** A job's kind and how it ended, as the viewer says them. */
export const KIND: Record<string, string> = { world: 'World build', review: 'Review before the build', rules: 'Rules', art: 'Painting', animate: 'Animation' };
const ended = (status: string) => (status === 'cancelled' ? 'canceled' : status);

export function Build({ sel }: { sel?: string }) {
  const { v, w } = useView();
  const records = [...v.records].sort((a, b) => a.started - b.started);
  const entries: ListEntry[] = [
    ...records.map((m) => ({ id: m.job, title: KIND[m.kind] ?? m.kind, sub: `${date(m.started)} · ${ended(m.status)} ·${usd(m.total.usd)}` })),
    ...(w.questProblems?.length ? [{ id: 'quests', title: 'Quest problems', sub: `${w.questProblems.length} found by the last check` }] : []),
    ...(w.generationLog?.length ? [{ id: 'log', title: 'Generation log', sub: `${w.generationLog.length} notes` }] : []),
  ];
  const chosen = sel ?? records.find((m) => m.kind === 'world')?.job ?? records[0]?.job;
  const m = records.find((x) => x.job === chosen);
  return (
    <Split section="build" entries={entries} sel={sel}>
      {chosen === 'quests' ? (
        <div className="col" style={{ gap: 8 }}>
          <h2 className="h2">Quest problems</h2>
          <p className="hint">Quests the build’s last check found cannot be finished. A problem in the main story keeps the world from being ready.</p>
          <ol className="vw-bullets">
            {w.questProblems!.map((x, i) => {
              const q = w.quests.find((y) => y.id === x.questId);
              return <li key={i}><b>{q?.title ?? 'The story'}</b> ({!q || q.main ? 'story' : 'side'}): {x.text}</li>;
            })}
          </ol>
        </div>
      ) : chosen === 'log' ? (
        <div className="col" style={{ gap: 8 }}>
          <h2 className="h2">Generation log</h2>
          <p className="hint">What the build noted as it went, step by step.</p>
          <ol className="vw-bullets">{w.generationLog!.map((x, i) => <li key={i}>{x}</li>)}</ol>
        </div>
      ) : m ? (
        <Record m={m} />
      ) : (
        <p className="dim">This world has no build records.</p>
      )}
    </Split>
  );
}

function Record({ m }: { m: BuildRecord }) {
  const { v } = useView();
  const t = m.total;
  const e = m.kind === 'world' ? v.estimate : null;
  return (
    <div className="col" style={{ gap: 16 }}>
      <div>
        <h2 className="h2">{KIND[m.kind] ?? m.kind}</h2>
        <div className="small dim">{ended(m.status)}, started {date(m.started)}, last recorded {date(m.updated)} · job {m.job}</div>
      </div>
      <div className="vw-counts">
        <Stat label="running" value={minutes(m.activeMs)} note={e ? `estimated ${minutes(e.hours * 3_600_000)}` : undefined} />
        <Stat label="dollars" value={usd(t.usd)} note={e ? `estimated ${usd(e.usd)}` : undefined} />
        <Stat label="model calls" value={thousands(t.calls)} />
        <Stat label="tokens in" value={thousands(t.input)} note={t.cached ? `${thousands(t.cached)} cached` : undefined} />
        <Stat label="tokens out" value={thousands(t.output)} note={t.reasoning ? `${thousands(t.reasoning)} reasoning` : undefined} />
        <Stat label="pictures" value={thousands(t.images)} note={t.imageInput ? `${thousands(t.imageInput)} image tokens in` : undefined} />
        <Stat label="GPU" value={minutes(t.gpuMs)} note={t.prompts ? `${t.prompts} prompts, ${minutes(t.queueMs)} waiting` : undefined} />
        <Stat label="tries" value={thousands(t.tries)} note={t.failed ? `${t.failed} failed${t.gaveUp ? `, ${t.gaveUp} gave up` : ''}` : undefined} />
      </div>
      {e && <p className="hint">The estimate is the creation page’s for a {v.world.input.size}, {v.world.input.length} world; animation adds about {minutes(e.animationHours * 3_600_000)} and {usd(e.animationUsd)}.</p>}
      {m.counts && <Field label="It made">{Object.entries(m.counts).map(([k, n]) => `${n} ${n === 1 ? ONE[k] ?? k : k}`).join(', ')}</Field>}
      <Table title="By step" rows={m.steps} hint="Step time adds up spans that ran side by side, so it can exceed the job’s running time." />
      <Table title="By model purpose" rows={m.purposes} />
      <Table title="By model and tier" rows={m.models} />
    </div>
  );
}

const Stat = ({ label, value, note }: { label: string; value: string; note?: string }) => (
  <div className="vw-countbox"><b>{value}</b><span>{label}</span>{note && <small>{note}</small>}</div>
);

type Col = { id: string; label: string; get: (t: Tally) => number; show: (t: Tally) => string };
const COLS: Col[] = [
  { id: 'usd', label: 'Dollars', get: (t) => t.usd ?? 0, show: (t) => (t.usd ? usd(t.usd) : '') },
  { id: 'calls', label: 'Calls', get: (t) => t.calls ?? 0, show: (t) => (t.calls ? thousands(t.calls) : '') },
  { id: 'input', label: 'Tokens in', get: (t) => t.input ?? 0, show: (t) => (t.input ? `${thousands(t.input)}${t.cached ? ` (${thousands(t.cached)} cached)` : ''}` : '') },
  { id: 'output', label: 'Tokens out', get: (t) => t.output ?? 0, show: (t) => (t.output ? `${thousands(t.output)}${t.reasoning ? ` (${thousands(t.reasoning)} reasoning)` : ''}` : '') },
  { id: 'images', label: 'Pictures', get: (t) => t.images ?? 0, show: (t) => (t.images ? thousands(t.images) : '') },
  { id: 'gpu', label: 'GPU', get: (t) => t.gpuMs ?? 0, show: (t) => (t.gpuMs ? minutes(t.gpuMs) : '') },
  { id: 'ms', label: 'Step time', get: (t) => t.ms ?? 0, show: (t) => (t.ms ? minutes(t.ms) : '') },
  { id: 'tries', label: 'Tries', get: (t) => t.tries ?? 0, show: (t) => (t.tries ? `${t.tries}${t.failed ? ` (${t.failed} failed)` : ''}` : '') },
];

/** One breakdown as a table, sorted by any column (dollars first), with a bar for each row's share of it. */
function Table({ title, rows, hint }: { title: string; rows: Record<string, Tally>; hint?: string }) {
  const [by, setBy] = useState('usd');
  const col = COLS.find((c) => c.id === by)!;
  const list = Object.entries(rows).sort((a, b) => col.get(b[1]) - col.get(a[1]) || a[0].localeCompare(b[0]));
  const cols = COLS.filter((c) => list.some(([, t]) => c.get(t)));
  const top = Math.max(1e-9, ...list.map(([, t]) => col.get(t)));
  if (!list.length) return null;
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="label">{title}</div>
      <div className="vw-table-wrap">
        <table className="vw-table">
          <thead>
            <tr>
              <th />
              {cols.map((c) => (
                <th key={c.id}>
                  <button className={`vw-th ${by === c.id ? 'on' : ''}`} onClick={() => setBy(c.id)} aria-label={`Sort by ${c.label}`}>{c.label}</button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.map(([name, t]) => (
              <tr key={name}>
                <th scope="row">
                  <span className="vw-bar" style={{ width: `${(col.get(t) / top) * 100}%` }} />
                  <span className="vw-rowname">{name}</span>
                </th>
                {cols.map((c) => <td key={c.id}>{c.show(t)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}
