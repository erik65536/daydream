/** One of the game's records: which output fills it, the shape it takes, and what the example's runs fill it with. */
import { useEffect, useState } from 'react';
import type { RecordOut, State } from '../protocol.ts';
import { get, q } from './api.ts';
import { Shape } from './Shape.tsx';
import { DataView } from './Value.tsx';

export function RecordView({ name, state, onSelect }: { name: string; state: State; onSelect: (id: string) => void }) {
  const r = state.analysis.records.find((x) => x.name === name);
  const [out, setOut] = useState<RecordOut | null>(null);
  const [error, setError] = useState('');
  const stamp = JSON.stringify(state.status);
  useEffect(() => {
    get<RecordOut>(`/api/record?${q({ example: state.example, name })}`).then(
      (o) => (setOut(o), setError('')),
      (e) => setError((e as Error).message),
    );
  }, [name, state.example, stamp]);
  if (!r) return null;
  const from = r.from?.split(/[.[]/)[0];
  return (
    <section className="page">
      <header className="page-head">
        <div className="page-title">
          <h1>{name}</h1>
          <span className="muted">a game record</span>
        </div>
      </header>
      <p className="lead">
        Filled from <code>{r.from ?? 'nothing yet'}</code>
        {from && state.analysis.steps[from] && (
          <>
            , the answer of step{' '}
            <button className="chip" onClick={() => onSelect(from)}>
              {from}
            </button>
          </>
        )}
        . Which output fills it is set in <code>pipeline/records.yaml</code>; its shape is the game's own, in <code>records.ts</code>. An answer may hold
        more than the record takes.
      </p>
      {r.problems.map((p) => (
        <pre key={p} className="notice notice-bad">
          {p}
        </pre>
      ))}
      {error && <div className="notice notice-bad">{error}</div>}
      {out && (
        <div className="two">
          <div className="panel">
            <h2>Its shape</h2>
            <Shape schema={out.shape} />
          </div>
          <div className="panel">
            <h2>On {state.example}</h2>
            {out.missing.length ? (
              <div className="empty">
                Not filled yet: {out.missing.join(', ')} {out.missing.length > 1 ? 'have' : 'has'} not run on {state.example}.
              </div>
            ) : (
              <DataView value={out.value} />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
