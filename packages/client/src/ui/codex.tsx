/** The codex: the rules of a world, generated from its ruleset (the game's window and the world page). */
import { useMemo, useState } from 'react';
import { codexSections, type Ruleset } from '@daydream/shared';
import { useGame } from '../net/game';
import { Window, centered, pressable } from './common';

export function CodexWindow({ onClose }: { onClose: () => void }) {
  const world = useGame((s) => s.world);
  if (!world) return null;
  return (
    <Window title={`Codex — ${world.ruleset.name}`} onClose={onClose} className="codex" style={{ ...centered(900, 60, 40), height: 'min(680px, calc(100% - 140px))' }}>
      <CodexView ruleset={world.ruleset} />
    </Window>
  );
}

/** The rules of a world, generated from its ruleset (game window and world page). */
export function CodexView({ ruleset }: { ruleset: Ruleset }) {
  const sections = useMemo(() => codexSections(ruleset), [ruleset]);
  const [sel, setSel] = useState('basics');
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const match = (e: { title: string; text?: string; lines: string[] }) => !query || [e.title, e.text ?? '', ...e.lines].some((s) => s.toLowerCase().includes(query));
  const shown = query ? sections.map((s) => ({ ...s, entries: s.entries.filter(match) })).filter((s) => s.entries.length) : sections.filter((s) => s.id === sel);
  return (
    <div className="row" style={{ alignItems: 'stretch', flex: 1, minHeight: 0, gap: 0 }}>
      <div className="scroll codex-nav">
        <input className="input" placeholder="Search…" aria-label="Search the codex" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        {sections.map((s) => (
          <div key={s.id} className={`quest ${!query && sel === s.id ? 'on' : ''}`} {...pressable(() => { setSel(s.id); setQ(''); })}>
            <div className="qt">{s.title}</div>
          </div>
        ))}
      </div>
      <div className="grow scroll panel-body">
        {shown.map((s) => (
          <div key={s.id} className="col" style={{ gap: 10, marginBottom: 16 }}>
            <div className="display gold" style={{ fontSize: 22 }}>{s.title}</div>
            {s.intro && <div className="serif" style={{ fontSize: 16, lineHeight: 1.5 }}>{s.intro}</div>}
            <div className="codex-grid">
              {s.entries.map((e, i) => (
                <div key={i} className="codex-entry" style={e.color ? ({ '--ec': e.color } as React.CSSProperties) : undefined}>
                  <div className="ce-title">{e.color && <span className="swatch" />}{e.title}</div>
                  {e.text && <div className="ce-text">{e.text}</div>}
                  {e.lines.map((l, j) => <div key={j} className="ce-line">{l}</div>)}
                </div>
              ))}
            </div>
          </div>
        ))}
        {!shown.length && <div className="muted">Nothing matches “{q}”.</div>}
      </div>
    </div>
  );
}
