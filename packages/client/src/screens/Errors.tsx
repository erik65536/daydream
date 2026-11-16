import { useState } from 'react';
import { api, type ErrorEntry, type ErrorsView, type HourStats, type Me } from '../api';
import { ToolPage } from '../ui/night';
import { capital, duration } from '../ui/format';
import { usePoll } from '../ui/poll';
import { ask } from '../ui/ask';

const when = (t: number) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const hour = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const SOURCE: Record<ErrorEntry['source'], { label: string; cls: string }> = {
  server: { label: 'server', cls: 'gray' },
  worker: { label: 'worker', cls: 'green' },
  client: { label: 'browser', cls: '' },
  tool: { label: 'console tool', cls: 'gray' },
};

/** One kind of error: what, how often, and when; opened, where it happened and what led to it. */
function ErrorRow({ e, now }: { e: ErrorEntry; now: number }) {
  const [open, setOpen] = useState(false);
  const { trail, ...context } = e.context as { trail?: string[] } & Record<string, unknown>;
  return (
    <div className={`err-row${open ? ' open' : ''}`}>
      <button className="err-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`badge ${SOURCE[e.source]?.cls ?? 'gray'}`}>{SOURCE[e.source]?.label ?? e.source}</span>
        <span className="err-message">{e.message}</span>
        <span className="err-count" title="Times seen">×{e.count}</span>
        <span className="muted small err-when" title={`Last ${when(e.lastAt)}`}>{duration(now - e.lastAt)} ago</span>
      </button>
      {open && (
        <div className="err-body">
          <div className="small muted">First seen {when(e.firstAt)}, last seen {when(e.lastAt)}.</div>
          <dl className="err-context">
            {Object.entries(context).map(([k, v]) => (
              <div key={k}><dt>{k}</dt><dd>{typeof v === 'string' ? v : JSON.stringify(v)}</dd></div>
            ))}
          </dl>
          {e.stack && <pre className="err-stack">{e.stack}</pre>}
          {trail && trail.length > 0 && (
            <>
              <div className="small muted" style={{ marginTop: 8 }}>What the player did before it (seconds since the page opened):</div>
              <pre className="err-stack">{trail.join('\n')}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Numbers({ stats }: { stats: ErrorsView['stats'] }) {
  const rows: (HourStats & { now?: boolean })[] = [{ ...stats.current, now: true }, ...stats.hours];
  return (
    <div className="panel gpu-panel">
      <div className="panel-head"><h3>The server, by the hour</h3><div className="spacer" /><span className="small muted">running since {when(stats.startedAt)}</span></div>
      <div className="panel-body">
        <table className="table">
          <thead>
            <tr><th>Hour</th><th>Players online</th><th>Adventures running</th><th>Sign-ins</th><th>Games joined</th><th>Requests</th><th>Failed</th><th>Slow</th><th>Errors</th><th>Memory</th></tr>
          </thead>
          <tbody>
            {rows.map((h) => (
              <tr key={h.at}>
                <td>{h.now ? `${hour(h.at)} (so far)` : hour(h.at)}</td>
                <td>{h.playersOnline}</td>
                <td>{h.adventuresRunning}</td>
                <td>{h.signIns}</td>
                <td>{h.joins}</td>
                <td>{h.requests}</td>
                <td className={h.failed ? 'error-text' : ''}>{h.failed}</td>
                <td>{h.slow}</td>
                <td className={h.errors ? 'error-text' : ''}>{h.errors}</td>
                <td>{h.rssMb} MB</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Administrators see the errors every process and players' browsers reported, and the server's hourly numbers. */
export function ErrorsAdmin({ me }: { me: Me }) {
  const [view, setView] = useState<ErrorsView | null>(null);
  const [source, setSource] = useState<ErrorEntry['source'] | 'all'>('all');
  const { error, setError, refresh } = usePoll(async (alive) => {
    const v = await api.errors();
    if (alive()) setView(v);
  }, 10_000, []);
  const now = Date.now();
  const shown = (view?.errors ?? []).filter((e) => source === 'all' || e.source === source);
  const clear = async () => {
    if (!(await ask('Clear every error? They are gone for good; new ones are kept again as they happen.', { danger: true, yes: 'Clear them' }))) return;
    await api.clearErrors().then(refresh, (e) => setError((e as Error).message));
  };
  return (
    <ToolPage me={me} className="gpu-page">
      <h1 className="h1">Errors</h1>
      <p className="lede">
        Errors from the server, the job worker, console tools, and players’ browsers, the same error counted once. Open one to see where it happened and what led to it.
        Errors not seen for 30 days are forgotten. It refreshes every 10 seconds while this tab is in view.
      </p>
      <div className="row wrap" style={{ gap: 8, marginTop: 12 }}>
        {(['all', 'server', 'worker', 'tool', 'client'] as const).map((s) => (
          <button key={s} className={`btn sm ${source === s ? 'primary' : ''}`} onClick={() => setSource(s)}>
            {s === 'all' ? 'All' : capital(SOURCE[s].label)}
          </button>
        ))}
        <div className="spacer" />
        {error && <span className="error-text">{error}</span>}
        <button className="btn sm danger" disabled={!view?.errors.length} onClick={clear}>Clear all</button>
      </div>
      {!view ? (
        <div className="center" style={{ padding: 40 }}><div className="spinner" /></div>
      ) : (
        <div className="col" style={{ gap: 14, marginTop: 16 }}>
          <div className="panel gpu-panel">
            <div className="panel-head"><h3>{shown.length ? `${shown.length} kind${shown.length === 1 ? '' : 's'} of error` : 'Errors'}</h3></div>
            <div className="panel-body">
              {shown.length ? shown.map((e) => <ErrorRow key={e.fingerprint} e={e} now={now} />) : <div className="muted small">Nothing has gone wrong.</div>}
            </div>
          </div>
          <Numbers stats={view.stats} />
        </div>
      )}
    </ToolPage>
  );
}
