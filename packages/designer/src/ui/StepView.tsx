/**
 * One step: its prompt and schema to edit beside exactly what they send, what its runs answered, and runs side by
 * side.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PreviewOut, RunSummary, State, StepEdit } from '../protocol.ts';
import type { RunRecord } from '../../../server/src/pipeline/index.ts';
import { call, get, money, post, q, STATE_WORDS, when } from './api.ts';
import { Shape } from './Shape.tsx';
import { unsaved } from './unsaved.ts';
import { DataView } from './Value.tsx';

const PURPOSES = ['world.design', 'world.content'];
const EFFORTS = ['', 'none', 'minimal', 'low', 'medium', 'high'];
const TABS = { prompt: 'Prompt', schema: 'Schema', output: 'Output', compare: 'Compare runs' } as const;
type Tab = keyof typeof TABS;

const rememberedTab = (): Tab => {
  try {
    const t = localStorage.getItem('tab');
    return t && t in TABS ? (t as Tab) : 'prompt';
  } catch {
    return 'prompt';
  }
};

export function StepView({ id, state, onChange, onSelect }: { id: string; state: State; onChange: () => void; onSelect: (id: string) => void }) {
  // The tab is kept from step to step, so going down the steps compares like with like.
  const [tab, setTabState] = useState<Tab>(rememberedTab);
  // The part last edited stays as it is behind the other tabs.
  const [part, setPart] = useState<'prompt' | 'schema'>(tab === 'schema' ? 'schema' : 'prompt');
  const setTab = (t: Tab) => {
    setTabState(t);
    if (t === 'prompt' || t === 'schema') setPart(t);
    try {
      localStorage.setItem('tab', t);
    } catch {
      /* a private window */
    }
  };
  const info = state.analysis.steps[id]!;
  const st = state.status[id]!;
  const settings = state.steps[id];
  const [times, setTimes] = useState(1);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const act = (p: Promise<unknown>) => p.then(onChange, (e) => setError((e as Error).message));
  const running = state.jobs.some((j) => !j.done && (j.label.startsWith(`${id} `) || j.label.startsWith('every step')));

  return (
    <section className="page">
      <header className="page-head">
        <div className="page-title">
          <h1>{id}</h1>
          <span className={`state state-${st.state}`}>{STATE_WORDS[st.state]}</span>
          {st.why && <span className="muted small">{st.why}</span>}
        </div>
        <div className="page-actions">
          <div className="split">
            <button className="primary" disabled={running} onClick={() => act(post('/api/run', { example: state.example, step: id, times }))}>
              {running ? 'Running…' : `Run on ${state.example}`}
            </button>
            <select value={times} onChange={(e) => setTimes(Number(e.target.value))} aria-label="How many runs side by side" title="How many runs side by side">
              {[1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  ×{n}
                </option>
              ))}
            </select>
          </div>
          <button disabled={running} onClick={() => act(post('/api/run', { example: 'all', step: id, times }))} title="Run it on every example">
            Run on every example
          </button>
          <button onClick={() => act(post<{ id: string }>(`/api/step/${id}/duplicate`).then((r) => onSelect(r.id)))} title="A copy under a new id, which nothing reads: a variant to compare">
            Duplicate
          </button>
          {confirmDelete ? (
            <>
              <button className="danger" onClick={() => act(call('DELETE', `/api/step/${id}`).then(() => onSelect('')))}>
                Delete {id}
              </button>
              <button onClick={() => setConfirmDelete(false)}>Keep it</button>
            </>
          ) : (
            <button className="quiet" onClick={() => setConfirmDelete(true)}>
              Delete…
            </button>
          )}
        </div>
      </header>
      <div className="facts-line">
        <span>
          <span className="muted">purpose</span> <span className="mono">{settings?.purpose}</span>
        </span>
        {settings?.forEach && (
          <span>
            <span className="muted">once for each of</span> <span className="mono">{settings.forEach}</span>
          </span>
        )}
        {settings?.when && (
          <span>
            <span className="muted">only when there is</span> <span className="mono">{settings.when}</span>
          </span>
        )}
      </div>
      <div className="links">
        <span className="muted">Reads</span>
        {info.reads.length ? info.reads.map((r) => <Chip key={r} id={r} onSelect={onSelect} />) : <span>only the input and the engine's facts</span>}
        <span className="muted links-gap">Read by</span>
        {info.readBy.length ? (
          info.readBy.map((r) =>
            r.startsWith('record ') ? (
              <button key={r} className="chip chip-record" onClick={() => onSelect(`record:${r.slice(7)}`)}>
                {r}
              </button>
            ) : (
              <Chip key={r} id={r} onSelect={onSelect} />
            ),
          )
        ) : (
          <span className="chip chip-warn">nothing: a variant, or unused</span>
        )}
      </div>
      {info.unread.length > 0 && (
        <div className="notice notice-warn">
          <strong>Nothing reads </strong>
          {info.unread.map((u) => (
            <code key={u}>{u}</code>
          ))}
        </div>
      )}
      {info.problems.length > 0 && (
        <div className="notice notice-bad">
          {info.problems.map((p) => (
            <div key={p}>{p}</div>
          ))}
        </div>
      )}
      {error && (
        <button className="notice notice-bad" onClick={() => setError('')} title="Dismiss">
          {error}
        </button>
      )}
      <nav className="tabs">
        {(Object.keys(TABS) as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'tab on' : 'tab'} onClick={() => setTab(t)}>
            {TABS[t]}
          </button>
        ))}
      </nav>
      {/* One editor for both parts, kept behind the other tabs, so an edit is still there on coming back. */}
      <div hidden={tab !== 'prompt' && tab !== 'schema'}>
        <EditPane id={id} part={part} state={state} onSaved={onChange} />
      </div>
      {tab === 'output' && <OutputPane id={id} state={state} />}
      {tab === 'compare' && <ComparePane id={id} state={state} />}
    </section>
  );
}

function Chip({ id, onSelect }: { id: string; onSelect: (id: string) => void }) {
  return (
    <button className="chip" onClick={() => onSelect(id)}>
      {id}
    </button>
  );
}

// ------------------------------------------------------------------ editing

type SentView = 'prompt' | 'shape' | 'body';

function EditPane({ id, part, state, onSaved }: { id: string; part: 'prompt' | 'schema'; state: State; onSaved: () => void }) {
  const [saved, setSaved] = useState<StepEdit | null>(null);
  const [edit, setEdit] = useState<StepEdit | null>(null);
  const [error, setError] = useState('');
  // What is shown beside follows the part being edited, and can be changed.
  const [view, setView] = useState<SentView>(part === 'schema' ? 'shape' : 'prompt');
  useEffect(() => setView(part === 'schema' ? 'shape' : 'prompt'), [part]);
  const stamp = state.steps[id]?.stamp;
  const dirty = !!edit && !!saved && JSON.stringify(edit) !== JSON.stringify(saved);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // Leaving the step with edits not saved asks first (unsaved.ts).
  useEffect(() => {
    unsaved.step = dirty ? id : '';
    return () => {
      unsaved.step = '';
    };
  }, [dirty, id]);

  // Loaded when the step changes, and again when its file changes elsewhere (unless it is being edited here).
  useEffect(() => {
    if (dirtyRef.current) return;
    get<StepEdit>(`/api/step/${id}`).then(
      (e) => (setSaved(e), setEdit(e)),
      (e) => setError((e as Error).message),
    );
  }, [id, stamp]);

  const save = async () => {
    if (!edit) return;
    try {
      await call('PUT', `/api/step/${id}`, edit);
      setSaved(edit);
      setError('');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (dirtyRef.current) void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!edit) return <div className="muted pad">{error || 'Loading…'}</div>;
  const set = (k: keyof StepEdit) => (e: { target: { value: string } }) => setEdit({ ...edit, [k]: e.target.value });
  return (
    <div className="edit">
      <div className="edit-form">
        <div className="save-row">
          <button className="primary" disabled={!dirty} onClick={save}>
            Save
          </button>
          <button disabled={!dirty} onClick={() => setEdit(saved)}>
            Undo changes
          </button>
          <span className={dirty ? 'unsaved' : 'muted'}>{dirty ? 'Not saved: Ctrl+S saves' : 'Saved'}</span>
          {error && <span className="bad">{error}</span>}
        </div>
        {part === 'prompt' ? (
          <>
            <div className="settings">
              <label>
                Purpose
                <select value={edit.purpose} onChange={set('purpose')}>
                  {[...new Set([...PURPOSES, edit.purpose])].map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </label>
              <label>
                Reasoning
                <select value={edit.reasoning} onChange={set('reasoning')}>
                  {EFFORTS.map((r) => (
                    <option key={r} value={r}>
                      {r || "the purpose's"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Max tokens
                <input value={edit.maxTokens} onChange={set('maxTokens')} inputMode="numeric" placeholder="the purpose's" />
              </label>
              <label>
                Model
                <input value={edit.model} onChange={set('model')} placeholder="the purpose's" />
              </label>
              <label className="wide">
                Once for each of
                <input value={edit.forEach} onChange={set('forEach')} placeholder="map.towns (optional)" spellCheck={false} />
              </label>
              <label className="wide">
                Only when there is
                <input value={edit.when} onChange={set('when')} placeholder="input.prompts[topic=story] (optional)" spellCheck={false} />
              </label>
            </div>
            <Field label="System" value={edit.system} onChange={set('system')} rows={3} />
            <Field label="User" value={edit.user} onChange={set('user')} rows={22} />
            <p className="hint">
              Templates are Mustache over paths: <code>{'{{input.theme}}'}</code>, <code>{'{{#map.towns}}…{{/map.towns}}'}</code>, a step's answer as{' '}
              <code>{'{{concept.title}}'}</code>, filters such as <code>{'map.places[kind=town]'}</code>, and <code>$first</code>, <code>$last</code>,{' '}
              <code>$n</code> inside a list. Nothing is escaped.
            </p>
          </>
        ) : (
          <>
            <Field label="Schema (YAML)" value={edit.schema} onChange={set('schema')} rows={36} yaml />
            <p className="hint">
              JSON Schema, with every property required. <code>nullable: true</code> allows nothing. <code>{'enum: { from: map.places[*].id }'}</code> and{' '}
              <code>{'keys: { from: …, each: … }'}</code> take their values from what exists. Descriptions are templates. The shape beside it is the answer as the model is told it; the request body is
              what is sent.
            </p>
          </>
        )}
      </div>
      <Sent id={id} example={state.example} draft={dirty ? edit : undefined} stamp={`${stamp}:${state.status[id]?.state}`} view={view} setView={setView} />
    </div>
  );
}

/** A text to edit. YAML is not wrapped, since its indentation is its structure. */
function Field({ label, value, onChange, rows, yaml }: { label: string; value: string; onChange: (e: { target: { value: string } }) => void; rows: number; yaml?: boolean }) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea value={value} onChange={onChange} rows={rows} spellCheck={false} wrap={yaml ? 'off' : undefined} />
    </label>
  );
}

/** Exactly what the step sends, from the step as edited, shown as it is typed. */
function Sent({ id, example, draft, stamp, view, setView }: { id: string; example: string; draft?: StepEdit; stamp: string; view: SentView; setView: (v: SentView) => void }) {
  const [mode, setMode] = useState<'saved' | 'sample'>('saved');
  const [out, setOut] = useState<PreviewOut | null>(null);
  const [error, setError] = useState('');
  const [item, setItem] = useState(0);
  const key = useMemo(() => JSON.stringify({ id, example, draft, mode, stamp }), [id, example, draft, mode, stamp]);
  useEffect(() => {
    const t = setTimeout(() => {
      post<PreviewOut>('/api/preview', { example, step: id, mode, draft }).then(
        (o) => (setOut(o), setError('')),
        (e) => setError((e as Error).message),
      );
    }, 300);
    return () => clearTimeout(t);
  }, [key]);
  const c = out?.calls[Math.min(item, (out?.calls.length ?? 1) - 1)];
  const schema = c?.schema;
  return (
    <aside className="sent">
      <div className="sent-head">
        <strong>Sent to the Responses API</strong>
        <div className="toggle">
          {(['prompt', 'shape', 'body'] as const).map((v) => (
            <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
              {v === 'prompt' ? 'Prompt' : v === 'shape' ? 'Answer shape' : 'Request body'}
            </button>
          ))}
        </div>
      </div>
      <div className="sent-head">
        <span className="muted small">Steps it reads, as</span>
        <div className="toggle" title="What the steps it reads stand for: their newest runs on this example, or answers made up from their schemas">
          <button className={mode === 'saved' ? 'on' : ''} onClick={() => setMode('saved')}>
            their newest runs
          </button>
          <button className={mode === 'sample' ? 'on' : ''} onClick={() => setMode('sample')}>
            made-up answers
          </button>
        </div>
        {out && out.calls.length > 1 && (
          <label className="muted small">
            Call for{' '}
            <select value={item} onChange={(e) => setItem(Number(e.target.value))}>
              {out.calls.map((x, i) => (
                <option key={x.item} value={i}>
                  {x.item}
                </option>
              ))}
            </select>{' '}
            of {out.calls.length}
          </label>
        )}
      </div>
      {error && <div className="notice notice-bad">{error}</div>}
      {out && (
        <>
          {out.missing.length > 0 && (
            <div className="notice">
              Made-up answers stand in for {out.missing.join(', ')}, which {out.missing.length > 1 ? 'have' : 'has'} not run on {example}.
            </div>
          )}
          {!out.runs && <div className="notice">Its “only when” finds nothing on {example}, so it would not be called.</div>}
          {out.problems.map((p) => (
            <div key={p} className="notice notice-bad">
              {p}
            </div>
          ))}
          {c && view === 'prompt' && (
            <>
              <h3>System</h3>
              <pre className="prompt">{c.system || '(none)'}</pre>
              <h3>User</h3>
              <pre className="prompt">{c.user}</pre>
            </>
          )}
          {c && view === 'shape' && (schema ? <Shape schema={schema} /> : <div className="muted">The schema cannot be made; see the problems above.</div>)}
          {c && view === 'body' && <pre className="code">{JSON.stringify(c.body, null, 2)}</pre>}
        </>
      )}
    </aside>
  );
}

// ------------------------------------------------------------------ output and runs

function useRuns(example: string, step: string, stamp: unknown) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  useEffect(() => {
    if (step) get<RunSummary[]>(`/api/runs?${q({ example, step })}`).then(setRuns, () => setRuns([]));
  }, [example, step, stamp]);
  return runs;
}

function useRun(example: string, step: string, id: string | undefined) {
  const [run, setRun] = useState<RunRecord | null>(null);
  useEffect(() => {
    if (!id) return setRun(null);
    get<RunRecord | null>(`/api/run?${q({ example, step, id })}`).then(setRun, () => setRun(null));
  }, [example, step, id]);
  return run;
}

const jobsDone = (s: State) => s.jobs.filter((j) => j.done).length;
const runLabel = (r: RunSummary, i: number) => `${i === 0 ? 'Newest · ' : ''}${when(r.at)} · ${money(r.usd)}${r.error ? ' · failed' : ''}`;

function RunPicker({ runs, value, onChange }: { runs: RunSummary[]; value?: string; onChange: (id: string) => void }) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-label="Which run">
      {runs.map((r, i) => (
        <option key={r.id} value={r.id}>
          {runLabel(r, i)}
        </option>
      ))}
    </select>
  );
}

function OutputPane({ id, state }: { id: string; state: State }) {
  const runs = useRuns(state.example, id, jobsDone(state));
  const [chosen, setChosen] = useState<string>();
  const runId = chosen && runs.some((r) => r.id === chosen) ? chosen : runs[0]?.id;
  const run = useRun(state.example, id, runId);
  if (!runs.length) return <div className="empty">{id} has not run on {state.example} yet. Run it from the top of the page.</div>;
  return <RunBody run={run} picker={<RunPicker runs={runs} value={runId} onChange={setChosen} />} />;
}

function RunBody({ run, picker }: { run: RunRecord | null; picker?: ReactNode }) {
  if (!run) return <div className="muted pad">Loading…</div>;
  const meta = (
    <span className="run-meta">
      <span>{(run.ms / 1000).toFixed(0)} s</span>
      <span>{money(run.usage.usd)}</span>
      <span>
        {run.usage.calls} call{run.usage.calls === 1 ? '' : 's'}
      </span>
      <span title={`${run.usage.reasoning.toLocaleString()} of them reasoning`}>{run.usage.output.toLocaleString()} tokens out</span>
    </span>
  );
  const bar = (
    <>
      {picker}
      {meta}
    </>
  );
  if (run.error)
    return (
      <div className="run">
        <div className="data-bar">{bar}</div>
        <div className="notice notice-bad">{run.error}</div>
        {run.partial && (
          <>
            <h3>Where the answer had reached</h3>
            <pre className="code">…{run.partial.slice(-3000)}</pre>
          </>
        )}
      </div>
    );
  if (run.output === null)
    return (
      <div className="run">
        <div className="data-bar">{bar}</div>
        <div className="empty">Its “only when” found nothing, so it was not called.</div>
      </div>
    );
  return <DataView value={run.output} toolbar={bar} />;
}

/** Two runs side by side: of this step, or of another (a variant). */
function ComparePane({ id, state }: { id: string; state: State }) {
  const done = jobsDone(state);
  const runs = useRuns(state.example, id, done);
  const [left, setLeft] = useState<string>();
  // A variant of this step (a duplicate, or what it was duplicated from) is the first thing to compare with.
  const base = id.replace(/_\d+$/, '');
  const variant = state.analysis.order.find((s) => s !== id && s.replace(/_\d+$/, '') === base);
  const [otherStep, setOtherStep] = useState(variant ?? id);
  const others = useRuns(state.example, otherStep, done);
  const [right, setRight] = useState<string>();
  const leftId = left ?? runs[0]?.id;
  const rightRuns = otherStep === id ? runs : others;
  const rightId = right ?? (otherStep === id ? runs[1]?.id : others[0]?.id);
  const a = useRun(state.example, id, leftId);
  const b = useRun(state.example, otherStep, rightId);
  if (!runs.length) return <div className="empty">{id} has not run on {state.example} yet.</div>;
  return (
    <div className="compare">
      <div className="compare-col">
        <div className="compare-pick">
          <span className="mono strong">{id}</span>
          <RunPicker runs={runs} value={leftId} onChange={setLeft} />
        </div>
        <RunBody run={a} />
      </div>
      <div className="compare-col">
        <div className="compare-pick">
          <select value={otherStep} onChange={(e) => (setOtherStep(e.target.value), setRight(undefined))} aria-label="Which step">
            {state.analysis.order.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          {rightId && <RunPicker runs={rightRuns} value={rightId} onChange={setRight} />}
        </div>
        {rightId ? <RunBody run={b} /> : <div className="empty">{otherStep === id ? `${id} has run only once on ${state.example}. Run it again (×2 runs two at once), or pick a variant to compare with.` : `${otherStep} has not run on ${state.example}.`}</div>}
      </div>
    </div>
  );
}
