/** One example: an owner's input to edit as YAML, beside what templates read from it (`input` and `map`). */
import { useEffect, useRef, useState } from 'react';
import { GAME_LENGTHS, WORLD_SIZES } from '../../../shared/src/rules/progression.ts';
import { PROMPT_TOPICS } from '../../../shared/src/world/types.ts';
import type { State } from '../protocol.ts';
import { call, get, q } from './api.ts';
import { DataView } from './Value.tsx';

export function ExampleView({ id, state, onChange, onGone }: { id: string; state: State; onChange: () => void; onGone: () => void }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [facts, setFacts] = useState<{ input: unknown; map: unknown } | null>(null);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = saved !== null && text !== saved;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const problems = state.analysis.problems.filter((p) => p.startsWith(`examples/${id}.yaml:`));

  // Loaded when the example changes, and again whenever the state does (the file may change elsewhere).
  useEffect(() => {
    get<{ input: unknown; map: unknown }>(`/api/facts?${q({ example: id })}`).then(setFacts, () => setFacts(null));
    if (dirtyRef.current) return;
    get<{ text: string }>(`/api/example/${id}`).then(
      (r) => (setSaved(r.text), setText(r.text)),
      (e) => setError((e as Error).message),
    );
  }, [id, state]);

  const save = async () => {
    try {
      await call('PUT', `/api/example/${id}`, { text });
      setSaved(text);
      setError('');
      onChange();
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

  return (
    <section className="page">
      <header className="page-head">
        <div className="page-title">
          <h1>{id}</h1>
          <span className="muted">an example: what an owner gives to build a world</span>
        </div>
        <div className="page-actions">
          {confirmDelete ? (
            <>
              <button className="danger" onClick={() => call('DELETE', `/api/example/${id}`).then(onGone, (e) => setError((e as Error).message))}>
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
      {problems.map((p) => (
        <div key={p} className="notice notice-bad">
          {p}
        </div>
      ))}
      {error && (
        <button className="notice notice-bad" onClick={() => setError('')} title="Dismiss">
          {error}
        </button>
      )}
      <div className="two">
        <div className="edit-form">
          <div className="save-row">
            <button className="primary" disabled={!dirty} onClick={save}>
              Save
            </button>
            <button disabled={!dirty} onClick={() => setText(saved ?? '')}>
              Undo changes
            </button>
            <span className={dirty ? 'unsaved' : 'muted'}>{dirty ? 'Not saved: Ctrl+S saves' : 'Saved'}</span>
          </div>
          <label className="field">
            <span>The owner's input (YAML)</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={30} spellCheck={false} wrap="off" />
          </label>
          <dl className="hint-list">
            <dt>theme</dt>
            <dd>the owner's description of the world</dd>
            <dt>prompts</dt>
            <dd>
              their notes, each <code>{'{ topic, text }'}</code>, on {PROMPT_TOPICS.join(', ')}
            </dd>
            <dt>size</dt>
            <dd>{WORLD_SIZES.join(', ')}</dd>
            <dt>length</dt>
            <dd>{GAME_LENGTHS.join(', ')}</dd>
            <dt>communication</dt>
            <dd>0 to 3</dd>
            <dt>rules</dt>
            <dd>the systems the owner fixed, in the shape of the rules systems step's answer</dd>
          </dl>
          <p className="hint">Saving checks it the way the server checks a new world's input.</p>
        </div>
        <div className="panel">
          <h2>What templates read from it</h2>
          <p className="hint">
            <code>input</code> is the file as templates read it: each prompt also says what its topic is <code>about</code>. <code>map</code> is what the
            engine lays out from it before any call. Both follow the saved file, so save to see a change. The constants are the same on every example.
          </p>
          {facts ? <DataView value={{ input: facts.input, map: facts.map }} /> : <div className="muted">…</div>}
        </div>
      </div>
    </section>
  );
}
