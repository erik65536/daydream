/** The constants: values every step may read as `{{constants.<name>}}`, to edit as YAML beside how they read. */
import { useEffect, useRef, useState } from 'react';
import type { State } from '../protocol.ts';
import { call, get } from './api.ts';
import { DataView } from './Value.tsx';

export function ConstantsView({ state, onChange }: { state: State; onChange: () => void }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [values, setValues] = useState<unknown>(null);
  const [error, setError] = useState('');
  const dirty = saved !== null && text !== saved;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Loaded at first, and again whenever the state does (the file may change elsewhere), unless it is being edited.
  useEffect(() => {
    get<{ text: string; values: unknown }>('/api/constants').then(
      (r) => {
        setValues(r.values);
        if (!dirtyRef.current) (setSaved(r.text), setText(r.text));
      },
      (e) => setError((e as Error).message),
    );
  }, [state]);

  const save = async () => {
    try {
      await call('PUT', '/api/constants', { text });
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
          <h1>constants</h1>
          <span className="muted">values every step may read, the same on every example</span>
        </div>
      </header>
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
            <span>pipeline/constants.yaml</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={24} spellCheck={false} wrap="off" />
          </label>
          <p className="hint">
            A template reads a constant as <code>{'{{constants.system}}'}</code>. Saving a change puts the newest run of every step out of date.
          </p>
        </div>
        <div className="panel">
          <h2>As templates read them</h2>
          {values ? <DataView value={values} /> : <div className="muted">…</div>}
        </div>
      </div>
    </section>
  );
}
