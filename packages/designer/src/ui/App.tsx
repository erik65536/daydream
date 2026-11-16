/**
 * The pipeline editor. The sidebar chooses the example everything runs on, then lists the steps in the order they
 * run and the game's records; the page beside it shows the one chosen. Runs, their progress and spending are along
 * the top.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { State } from '../protocol.ts';
import { get, money, post, q, STATE_WORDS } from './api.ts';
import { ConstantsView } from './ConstantsView.tsx';
import { ExampleView } from './ExampleView.tsx';
import { RecordView } from './RecordView.tsx';
import { StepView } from './StepView.tsx';
import { TalkView } from './TalkView.tsx';
import { mayLeave } from './unsaved.ts';
import { Names } from './Value.tsx';

const remembered = (k: string) => {
  try {
    return localStorage.getItem(k) ?? undefined;
  } catch {
    return undefined;
  }
};
const remember = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* a private window */
  }
};

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [example, setExample] = useState(remembered('example'));
  const [selected, setSelected] = useState(remembered('selected') ?? '');
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    get<State>(`/api/state?${q(example ? { example } : {})}`).then(
      (s) => (setState(s), setError('')),
      (e) => setError((e as Error).message),
    );
  }, [example]);

  useEffect(refresh, [refresh]);
  // Followed while something runs, and now and then otherwise (files may change outside the editor).
  const busy = !!state?.jobs.some((j) => !j.done);
  useEffect(() => {
    const t = setInterval(refresh, busy ? 1500 : 5000);
    return () => clearInterval(t);
  }, [refresh, busy]);

  // Going elsewhere leaves the step being edited: with edits not saved, only once the editor agrees.
  const select = (id: string) => {
    if (id !== selected && !mayLeave()) return;
    setSelected(id);
    remember('selected', id);
  };
  const chooseExample = (id: string) => {
    if (id !== state?.example && !mayLeave()) return;
    setExample(id);
    remember('example', id);
  };
  const act = (p: Promise<unknown>) => p.then(refresh, (e) => setError((e as Error).message));

  if (!state) return <div className="pad muted">{error || 'Loading the pipeline…'}</div>;
  const an = state.analysis;
  const page = an.steps[selected] || /^(record|example):/.test(selected) || selected === 'constants' || selected === 'talk' ? selected : (an.order[0] ?? '');
  const exampleProblem = (x: string) => an.problems.find((p) => p.startsWith(`examples/${x}.yaml:`));
  const problems = an.problems.length + Object.values(an.steps).reduce((n, s) => n + s.problems.length, 0) + an.records.reduce((n, r) => n + r.problems.length, 0);

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          Daydream <span>build pipeline</span>
        </div>
        <div className="top-runs">
          <span className="muted">
            On <strong className="mono">{state.example}</strong>
          </span>
          <button onClick={() => act(post('/api/run', { example: state.example, step: 'all', stale: true }))} disabled={busy} title="Every step whose newest run is out of date or missing, in order">
            Run what is out of date
          </button>
          <button onClick={() => act(post('/api/run', { example: state.example, step: 'all' }))} disabled={busy} title="Every step again, in order">
            Run every step
          </button>
        </div>
        <Activity state={state} />
        <div className="spend" title="Spent by the editor since it started. No call starts once the cap is reached.">
          Spent <strong>{money(state.spend.spent)}</strong> of $
          <input
            key={state.spend.cap}
            defaultValue={state.spend.cap.toFixed(2)}
            onBlur={(e) => act(post('/api/cap', { cap: Number(e.target.value) }))}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            aria-label="Spending cap in dollars"
          />
        </div>
      </header>
      {error && (
        <button className="notice notice-bad banner" onClick={() => setError('')} title="Dismiss">
          {error}
        </button>
      )}
      <div className="body">
        <nav className="side">
          <Section title="Example" hint="what everything runs on">
            {state.examples.map((x) => (
              <div key={x} className={page === `example:${x}` ? 'nav-row on' : 'nav-row'}>
                <button className="nav-main" onClick={() => chooseExample(x)} aria-pressed={x === state.example} title={`Run and show everything on ${x}`}>
                  <span className={x === state.example ? 'radio on' : 'radio'} />
                  <span className="nav-name">{x}</span>
                  {exampleProblem(x) && <span className="tag tag-bad">!</span>}
                </button>
                <button className="nav-edit" onClick={() => (chooseExample(x), select(`example:${x}`))}>
                  Edit
                </button>
              </div>
            ))}
            <AddRow
              placeholder="New example…"
              title={`A new example, starting as a copy of ${state.example}`}
              onAdd={(id) => act(post('/api/examples', { id, from: state.example }).then(() => (chooseExample(id), select(`example:${id}`))))}
            />
          </Section>
          <Section title="Steps" hint="by subject (order.yaml)">
            {an.groups.flatMap((g) => [<h3 key={`group:${g.name}`} className="nav-group">{g.name}</h3>, ...g.steps.map((id) => {
              const s = an.steps[id]!;
              const st = state.status[id]!;
              return (
                <div key={id} className={page === id ? 'nav-row on' : 'nav-row'}>
                  <button className="nav-main" onClick={() => select(id)} title={st.why || STATE_WORDS[st.state]}>
                    <span className={`dot dot-${st.state}`} />
                    <span className="nav-name">{id}</span>
                    {state.steps[id]?.forEach && <span className="tag" title="Called once for each item">each</span>}
                    {s.problems.length > 0 ? (
                      <span className="tag tag-bad">{s.problems.length}</span>
                    ) : !s.readBy.length ? (
                      <span className="tag tag-warn" title="Nothing reads it: a variant, or unused">unread</span>
                    ) : (
                      s.unread.length > 0 && (
                        <span className="tag tag-warn" title={`Fields nothing reads: ${s.unread.join(', ')}`}>
                          {s.unread.length} unread
                        </span>
                      )
                    )}
                  </button>
                </div>
              );
            })])}
            <AddRow placeholder="New step…" title="A new step, with a starting template and schema" onAdd={(id) => act(post<{ id: string }>('/api/steps', { id }).then((r) => select(r.id)))} />
          </Section>
          <Section title="Records" hint="what the game takes">
            {an.records.map((r) => (
              <div key={r.name} className={page === `record:${r.name}` ? 'nav-row on' : 'nav-row'}>
                <button className="nav-main" onClick={() => select(`record:${r.name}`)} title={r.from ? `Filled from ${r.from}` : 'Nothing fills it'}>
                  <span className={`dot ${r.problems.length ? 'dot-failed' : 'dot-fresh'}`} />
                  <span className="nav-name">{r.name}</span>
                  <span className="nav-note">{r.from ?? 'unfilled'}</span>
                </button>
              </div>
            ))}
          </Section>
          <Section title="Talk" hint="with the example's people">
            <div className={page === 'talk' ? 'nav-row on' : 'nav-row'}>
              <button className="nav-main" onClick={() => select('talk')} title="Talk with the people of the world the example's runs make, in the game's own conversation">
                <span className="dot dot-fresh" />
                <span className="nav-name">people of {state.example}</span>
              </button>
            </div>
          </Section>
          <Section title="Constants" hint="the same on every example">
            <div className={page === 'constants' ? 'nav-row on' : 'nav-row'}>
              <button className="nav-main" onClick={() => select('constants')} title="Values every step may read, as {{constants.<name>}}">
                <span className="dot dot-fresh" />
                <span className="nav-name">constants</span>
                <span className="nav-note">constants.yaml</span>
              </button>
            </div>
          </Section>
          <div className={problems ? 'summary bad' : 'summary'}>{problems ? `${problems} problem${problems > 1 ? 's' : ''}` : 'No problems'}</div>
          {an.problems.map((p) => (
            <div key={p} className="notice notice-bad small">
              {p}
            </div>
          ))}
        </nav>
        <Names.Provider value={state.names}>
          <main className="main">
            {an.steps[page] ? (
              <StepView key={page} id={page} state={state} onChange={refresh} onSelect={(id) => (id ? select(id) : (select(''), refresh()))} />
            ) : page.startsWith('record:') ? (
              <RecordView key={page} name={page.slice(7)} state={state} onSelect={select} />
            ) : page === 'talk' ? (
              <TalkView state={state} onChange={refresh} />
            ) : page === 'constants' ? (
              <ConstantsView state={state} onChange={refresh} />
            ) : page.startsWith('example:') && state.examples.includes(page.slice(8)) ? (
              <ExampleView key={page} id={page.slice(8)} state={state} onChange={refresh} onGone={() => (select(''), refresh())} />
            ) : (
              <div className="pad muted">Choose a step, a record, an example, or the constants.</div>
            )}
          </main>
        </Names.Provider>
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="nav-section">
      <h2 title={hint}>
        {title} <span>{hint}</span>
      </h2>
      {children}
    </section>
  );
}

/** A name to add, typed in place: Enter adds it, Escape clears it. */
function AddRow({ placeholder, title, onAdd }: { placeholder: string; title: string; onAdd: (id: string) => Promise<unknown> }) {
  const [id, setId] = useState('');
  return (
    <form
      className="add-row"
      title={title}
      onSubmit={(e) => {
        e.preventDefault();
        if (id.trim()) void onAdd(id.trim()).then(() => setId(''));
      }}
    >
      <input value={id} onChange={(e) => setId(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setId('')} placeholder={placeholder} spellCheck={false} aria-label={placeholder} />
      {id && <button type="submit">Add</button>}
    </form>
  );
}

/** The runs started here: the latest along the top, all of them with their progress below it. */
function Activity({ state }: { state: State }) {
  const last = state.jobs.at(-1);
  if (!last) return <div className="activity muted">Nothing run yet</div>;
  const word = last.done ? (last.error ? 'Failed' : 'Done') : 'Running';
  return (
    <details className="activity">
      <summary className={`activity-${word.toLowerCase()}`}>
        <span className="activity-dot" />
        {word}: {last.label}
      </summary>
      <div className="activity-list">
        {[...state.jobs].reverse().map((j) => (
          <div key={j.id} className="activity-job">
            <div>
              <strong>{j.label}</strong> <span className="muted">{j.done ? (j.error ? 'failed' : 'done') : 'running'}</span>
            </div>
            {j.lines.map((l, i) => (
              <div key={i} className="mono small">
                {l}
              </div>
            ))}
            {j.error && <div className="bad small">{j.error}</div>}
          </div>
        ))}
      </div>
    </details>
  );
}
