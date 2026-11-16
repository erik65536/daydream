import { useEffect, useState } from 'react';
import { DISPLAY_NAME_MAX, PASSWORD_MIN, checkDisplayName, checkPassword } from '@daydream/shared';
import { api, type Me, type Proof, type SpendingSummary, type TrashEntry, type UserRow } from '../api';
import { ToolPage } from '../ui/night';
import { useReveal, type FieldState } from '../ui/fields';
import { plural, usd } from '../ui/format';
import { makePasskey, matching, passkeyProof, passkeysWork } from './Auth';
import { ask } from '../ui/ask';

const when = (t: number | null) => (t ? new Date(t).toLocaleDateString() : 'never');
const inviteLink = (code: string) => `${location.origin}${location.pathname}#/invite/${code}`;

/**
 * Your account: your name, how you sign in (a password, passkeys, or both), and your AI budget. Changing how you sign
 * in asks you to confirm it is you first (your current password, or a passkey).
 */
export function Account({ me, onMe }: { me: Me; onMe: (me: Me) => void }) {
  /** What the last change said, shown in the panel it was made in. */
  const [said, setSaid] = useState<{ panel: 'name' | 'signin'; error?: string; note?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(me.displayName);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [keyName, setKeyName] = useState('');
  const nameReveal = useReveal(), keyReveal = useReveal(), passReveal = useReveal();
  // What was spent is as the server has it now, not as it was when the game was opened.
  useEffect(() => void api.me().then(onMe, () => {}), []);
  const run = async (panel: 'name' | 'signin', fn: () => Promise<Me>, done?: string) => {
    setBusy(true);
    setSaid(null);
    try {
      onMe(await fn());
      if (done) setSaid({ panel, note: done });
    } catch (e) {
      const err = e as Error;
      if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') setSaid({ panel, error: err.message });
    } finally {
      setBusy(false);
    }
  };
  /** Confirm it is you: the current password when typed, else a passkey. */
  const proof = async (): Promise<Proof> => (current ? { password: current } : passkeyProof());
  const proving: FieldState = current || me.passkeys.length ? {} : { problem: me.hasPassword ? 'Type your current password first.' : 'This account has no password or passkey left to confirm with. Ask an administrator to reset it.', unfinished: true };
  const display = checkDisplayName(name);
  const key: FieldState = keyName.trim() ? {} : { problem: 'Name the new passkey first.', unfinished: true };
  const pass = checkPassword(next);
  const match = matching(next, again);
  const shown = {
    name: nameReveal.shown('name', display),
    proof: keyReveal.shown('proof', proving) ?? passReveal.shown('proof', proving),
    key: keyReveal.shown('key', key),
    pass: passReveal.shown('pass', pass),
    again: passReveal.shown('again', match),
  };
  const say = (panel: 'name' | 'signin') =>
    said?.panel === panel && (said.error ? <div className="error-text" role="alert">{said.error}</div> : <div className="small gold">{said.note}</div>);
  return (
    <ToolPage me={me} style={{ maxWidth: 560 }}>
        <div className="panel">
          <div className="panel-head"><h3>Your account</h3><div className="spacer" /><span className="muted small">{me.username} · {me.isAdmin ? 'administrator' : 'player'}</span></div>
          <div className="panel-body col" style={{ gap: 14 }}>
            <form
              className="row"
              style={{ gap: 8, alignItems: 'flex-end' }}
              onSubmit={(e) => {
                e.preventDefault();
                if (nameReveal.ready([display])) run('name', () => api.setDisplayName(name), 'Name saved.');
              }}
            >
              <div className="field grow">
                <label htmlFor="account-name">Your name (what other players see)</label>
                <input id="account-name" className="input" value={name} onChange={(e) => setName(e.target.value)} onBlur={nameReveal.leave('name')} aria-invalid={!!shown.name || undefined} />
              </div>
              <button className="btn" disabled={busy || display.value === me.displayName}>Save</button>
            </form>
            {shown.name && <div className="error-text">{shown.name}</div>}
            {say('name')}
          </div>
        </div>

        <div className="panel" style={{ marginTop: 14 }}>
          <div className="panel-head"><h3>Signing in</h3></div>
          <div className="panel-body col" style={{ gap: 14 }}>
            {me.hasPassword && (
              <div className="field">
                <label htmlFor="account-current">Current password (to confirm changes below{me.passkeys.length ? '; or leave it empty and use a passkey' : ''})</label>
                <input type="text" autoComplete="username" value={me.username} readOnly hidden />
                <input id="account-current" className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" aria-invalid={!!shown.proof || undefined} />
                {shown.proof && <div className="error-text">{shown.proof}</div>}
              </div>
            )}
            <div className="col" style={{ gap: 8 }}>
              <div className="small">Passkeys</div>
              {me.passkeys.length ? (
                me.passkeys.map((p) => (
                  <div key={p.id} className="row small" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="grow">{p.name}</span>
                    <span className="muted">added {when(p.createdAt)} · last used {when(p.lastUsedAt)}</span>
                    <button className="btn sm ghost" disabled={busy} onClick={() => void ask(`Remove the passkey “${p.name}”?`, { danger: true }).then((ok) => void (ok && run('signin', async () => api.removePasskey(p.id, await proof()), 'Passkey removed.')))}>Remove</button>
                  </div>
                ))
              ) : (
                <div className="muted small">None yet.</div>
              )}
              {passkeysWork() && (
                <form
                  className="col"
                  style={{ gap: 6 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (keyReveal.ready([proving, key]))
                      run('signin', async () => {
                        const c = await api.passkeyAddStart(await proof());
                        const added = await api.passkeyAddFinish(c.flow, await makePasskey(c.options), keyName);
                        setKeyName('');
                        keyReveal.reset();
                        return added;
                      }, 'Passkey added.');
                  }}
                >
                  <div className="row" style={{ gap: 8 }}>
                    <input className="input grow" value={keyName} maxLength={40} onChange={(e) => setKeyName(e.target.value)} placeholder="Name your passkey" aria-label="A name for the new passkey" aria-invalid={!!shown.key || undefined} />
                    <button className="btn" style={{ whiteSpace: 'nowrap' }} disabled={busy}>Add a passkey</button>
                  </div>
                  {shown.key && <div className="error-text">{shown.key}</div>}
                </form>
              )}
            </div>
            <form
              className="col"
              style={{ gap: 8 }}
              onSubmit={(e) => {
                e.preventDefault();
                if (passReveal.ready([proving, pass, match]))
                  run('signin', async () => {
                    const m = await api.setPassword(await proof(), next);
                    setCurrent('');
                    setNext('');
                    setAgain('');
                    passReveal.reset();
                    return m;
                  }, 'Password saved. Your other sessions were signed out.');
              }}
            >
              <div className="small">{me.hasPassword ? 'Change your password' : 'Add a password'}</div>
              <input className="input" type="password" placeholder="New password" aria-label="New password" value={next} onChange={(e) => setNext(e.target.value)} onBlur={passReveal.leave('pass')} autoComplete="new-password" aria-invalid={!!shown.pass || undefined} />
              <div className={shown.pass ? 'error-text' : 'hint'}>{shown.pass ?? `At least ${PASSWORD_MIN} characters`}</div>
              <input className="input" type="password" placeholder="New password again" aria-label="New password again" value={again} onChange={(e) => setAgain(e.target.value)} onBlur={passReveal.leave('again')} autoComplete="new-password" aria-invalid={!!shown.again || undefined} />
              {shown.again && <div className="error-text">{shown.again}</div>}
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button className="btn" disabled={busy}>{me.hasPassword ? 'Change password' : 'Add password'}</button>
                {me.hasPassword && me.passkeys.length > 0 && (
                  <button type="button" className="btn ghost" disabled={busy} onClick={() => void ask('Remove your password? You will sign in with a passkey only.', { danger: true }).then((ok) => void (ok && run('signin', async () => api.clearPassword(await proof()), 'Password removed.')))}>
                    Remove password
                  </button>
                )}
              </div>
            </form>
            {!me.hasPassword && shown.proof && <div className="error-text" role="alert">{shown.proof}</div>}
            {say('signin')}
            <div className="hint">Changes to how you sign in ask for your current password or one of your passkeys.</div>
          </div>
        </div>

        <div className="panel" style={{ marginTop: 14 }}>
          <div className="panel-head"><h3>AI budget</h3></div>
          <div className="panel-body col" style={{ gap: 8 }}>
            <Budget spent={me.ai.spentMonth} limit={me.ai.budget} period="this month" />
            <div className="hint">What building worlds, painting checks, and conversations with people have cost this month on paid models. It starts again on the 1st.</div>
          </div>
        </div>
    </ToolPage>
  );
}

/** Spent against a budget, as a bar. */
function Budget({ spent, limit, period }: { spent: number; limit: number | null; period: string }) {
  const frac = limit ? Math.min(1, spent / Math.max(0.0001, limit)) : 0;
  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="row small"><span>{usd(spent)} {period}</span><div className="spacer" /><span className="muted">{limit === null ? 'no limit' : `of ${usd(limit)}`}</span></div>
      {limit !== null && <div className="budget-bar"><div style={{ width: `${frac * 100}%`, background: frac > 0.9 ? 'var(--danger)' : frac > 0.6 ? 'var(--gold)' : 'var(--good)' }} /></div>}
    </div>
  );
}

/** An editable cell: commits on Enter or leaving it, when changed; what could not be saved goes back to what it was. */
function EditCell({ value, onSet, width, prefix, number }: { value: string; onSet: (v: string) => Promise<boolean>; width: number; prefix?: string; number?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = async () => {
    const t = v.trim();
    if (t === value || !t || (number && !(Number(t) >= 0))) return setV(value);
    if (!(await onSet(t))) setV(value);
  };
  return (
    <div className="row" style={{ gap: 4 }}>
      {prefix && <span className="muted small">{prefix}</span>}
      <input className="input" style={{ width, padding: '3px 6px' }} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => void commit()} onKeyDown={(e) => e.key === 'Enter' && void commit()} />
    </div>
  );
}

/** An invite link to pass on, with a copy button. */
function InviteLink({ code, expires }: { code: string; expires: number | null }) {
  const [copied, setCopied] = useState(false);
  const link = inviteLink(code);
  // A page not served over https has no clipboard: the link beside the button is selected whole by a click.
  const copy = () => void navigator.clipboard?.writeText(link).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }, () => {});
  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="row" style={{ gap: 6 }}>
        <code className="small" style={{ userSelect: 'all', wordBreak: 'break-all' }}>{link}</code>
        <button className="btn sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      {expires && <div className="tiny muted">Works until {new Date(expires).toLocaleDateString()}.</div>}
    </div>
  );
}

/** Administrators make accounts (invite links), set names and budgets, disable or reset accounts, remove passkeys. */
export function Users({ me }: { me: Me }) {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [error, setError] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [budget, setBudget] = useState('10');
  const [open, setOpen] = useState<string | null>(null);
  const [spending, setSpending] = useState<SpendingSummary | null>(null);
  const load = () => Promise.all([api.users().then(setUsers), api.spending().then(setSpending)]).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  /** Make a change, then show the users as they are now; false when it was refused. */
  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  const status = (u: UserRow) =>
    u.status === 'invited' ? (u.inviteExpires && u.inviteExpires < Date.now() ? 'invite expired' : 'invited') : u.blocked ? 'locked' : u.lockedUntil ? 'waiting' : u.status;
  return (
    <ToolPage me={me} style={{ maxWidth: 900 }}>
        <div className="panel">
          <div className="panel-head"><h3>Users</h3></div>
          <div className="panel-body col" style={{ gap: 14 }}>
            <form
              className="row wrap"
              style={{ gap: 8, alignItems: 'flex-end' }}
              onSubmit={(e) => {
                e.preventDefault();
                act(async () => {
                  const u = await api.createUser({ displayName, monthlyBudgetUsd: Number(budget) || 0 });
                  setOpen(u.id);
                  setDisplayName('');
                  setBudget('10');
                });
              }}
            >
              <div className="field grow" style={{ flex: '1 1 220px' }}>
                <label>Who it is for (they can change it)</label>
                <input className="input" value={displayName} maxLength={DISPLAY_NAME_MAX} onChange={(e) => setDisplayName(e.target.value)} placeholder="a name" />
              </div>
              <div className="field" style={{ width: 130 }}>
                <label>Budget / month</label>
                <div className="row" style={{ gap: 4, alignItems: 'center' }}>
                  <span className="muted">$</span>
                  <input className="input" style={{ flex: 1, minWidth: 0, width: 'auto' }} inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
                </div>
              </div>
              <button className="btn primary" disabled={!displayName.trim()}>Create invite</button>
            </form>
            {error && <div className="error-text">{error}</div>}
            {spending && (
              <div className="aside-box col" style={{ gap: 6 }}>
                <div className="small">AI spending today across the server</div>
                <Budget spent={spending.today} limit={spending.dailyTotalUsd} period="today" />
                <div className="hint">
                  The server’s daily ceiling is set in config/genai.json under “spending”{spending.adminsUnlimited ? '; administrators are unlimited' : ''}. Each player’s monthly budget is set below.
                </div>
              </div>
            )}
            <table className="table">
              <thead>
                <tr><th>Name</th><th>User name</th><th>Role</th><th>Status</th><th>This month</th><th>Budget</th><th /></tr>
              </thead>
              <tbody>
                {(users ?? []).map((u) => {
                  const self = u.id === me.id;
                  return [
                    <tr key={u.id}>
                      <td>{self ? <>{u.displayName}<span className="muted"> (you)</span></> : <EditCell value={u.displayName} width={130} onSet={(v) => act(() => api.updateUser(u.id, { displayName: v }))} />}</td>
                      <td className="small">{u.username ?? <span className="muted">not chosen yet</span>}</td>
                      <td>
                        <select className="input" style={{ padding: '3px 6px' }} disabled={self || u.status === 'invited'} title={u.status === 'invited' ? 'An invited account can be made an administrator once it is set up' : undefined} value={u.isAdmin ? 'admin' : 'player'} onChange={(e) => act(() => api.updateUser(u.id, { isAdmin: e.target.value === 'admin' }))}>
                          <option value="player">player</option>
                          <option value="admin">administrator</option>
                        </select>
                      </td>
                      <td className={`small ${u.status === 'disabled' || u.blocked ? 'bad' : 'muted'}`} title={u.blocked ? 'Too many wrong passwords: open More to unlock' : u.lockedUntil ? 'Waiting after wrong passwords' : undefined}>{status(u)}</td>
                      <td className="small">{usd(u.ai.spentMonth)}</td>
                      <td>{u.isAdmin && spending?.adminsUnlimited ? <span className="small muted">unlimited</span> : self ? <span className="small">{usd(u.monthlyBudgetUsd)}</span> : <EditCell value={String(u.monthlyBudgetUsd)} width={60} prefix="$" number onSet={(v) => act(() => api.updateUser(u.id, { monthlyBudgetUsd: Number(v) }))} />}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {!self && <button className="btn sm ghost" onClick={() => setOpen(open === u.id ? null : u.id)}>{open === u.id ? 'Close' : 'More'}</button>}
                      </td>
                    </tr>,
                    open === u.id && !self && (
                      <tr key={`${u.id}-more`}>
                        <td colSpan={7}>
                          <div className="col" style={{ gap: 10, padding: '6px 0 10px' }}>
                            {u.status === 'invited' && u.inviteCode && (
                              <div className="col" style={{ gap: 4 }}>
                                <div className="small">Send {u.displayName} this invite link{u.username ? ` (they sign in as ${u.username})` : '; they choose their user name'}:</div>
                                <InviteLink code={u.inviteCode} expires={u.inviteExpires} />
                              </div>
                            )}
                            {u.status !== 'invited' && (
                              <div className="small muted">
                                Signs in with {[u.hasPassword && 'a password', u.passkeys.length && `${u.passkeys.length} passkey${u.passkeys.length > 1 ? 's' : ''}`].filter(Boolean).join(' and ') || 'nothing (reset the account to give them a new invite link)'}.
                              </div>
                            )}
                            {u.failedPasswords > 0 && (
                              <div className="row small" style={{ gap: 8 }}>
                                <span className={`grow ${u.blocked ? 'bad' : ''}`}>
                                  {u.failedPasswords} wrong password{u.failedPasswords > 1 ? 's' : ''} in a row.{' '}
                                  {u.blocked
                                    ? 'Password sign-in is locked until you unlock it or they sign in with a passkey.'
                                    : u.lockedUntil
                                      ? `Password sign-in waits until ${new Date(u.lockedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
                                      : ''}
                                </span>
                                <button className="btn sm" onClick={() => act(() => api.unlockUser(u.id))}>Unlock</button>
                              </div>
                            )}
                            {u.passkeys.map((p) => (
                              <div key={p.id} className="row small" style={{ gap: 8 }}>
                                <span className="grow">Passkey “{p.name}”</span>
                                <span className="muted">last used {when(p.lastUsedAt)}</span>
                                <button className="btn sm ghost" onClick={() => void ask(`Remove ${u.displayName}’s passkey “${p.name}”?`, { danger: true }).then((ok) => void (ok && act(() => api.removeUserPasskey(u.id, p.id))))}>Remove</button>
                              </div>
                            ))}
                            <div className="row" style={{ gap: 8 }}>
                              {u.status !== 'invited' && (
                                <button className="btn sm" onClick={() => act(() => api.updateUser(u.id, { enabled: u.status === 'disabled' }))}>{u.status === 'disabled' ? 'Enable' : 'Disable'}</button>
                              )}
                              <button
                                className="btn sm danger"
                                onClick={() => void ask(u.status === 'invited' ? `Give ${u.displayName} a new invite link? The old one stops working.` : `Reset ${u.displayName}? Their password and passkeys are removed and they are signed out; they set the account up again from a new invite link (keeping their user name). Their worlds and adventures stay.`, { danger: true }).then((ok) => void (ok && act(() => api.resetUser(u.id))))}
                              >
                                {u.status === 'invited' ? 'New invite link' : 'Reset account'}
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
            <div className="hint">Change your own account on your account page. If every administrator is locked out, use the server console: npm run users -w @daydream/server -- reset &lt;user name or id&gt;</div>
          </div>
        </div>
        <Trash />
    </ToolPage>
  );
}

/** Deleted worlds, with their adventures: restore one, or remove it before its time in the trash runs out. */
function Trash() {
  const [trash, setTrash] = useState<{ days: number; entries: TrashEntry[] } | null>(null);
  const [error, setError] = useState('');
  const load = () => api.trash().then(setTrash).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
  };
  if (!trash) return null;
  const left = (e: TrashEntry) => Math.max(0, Math.ceil(trash.days - (Date.now() - e.deletedAt) / 86400_000));
  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="panel-head"><h3>Deleted worlds</h3></div>
      <div className="panel-body col" style={{ gap: 10 }}>
        {error && <div className="error-text">{error}</div>}
        {trash.entries.length ? (
          <table className="table">
            <thead>
              <tr><th>World</th><th>Owner</th><th>Deleted</th><th>Adventures</th><th /></tr>
            </thead>
            <tbody>
              {trash.entries.map((e) => (
                <tr key={e.id}>
                  <td>{e.title}</td>
                  <td className="small">{e.ownerName || '—'}</td>
                  <td className="small muted">{new Date(e.deletedAt).toLocaleDateString()}{e.deletedBy ? ` by ${e.deletedBy}` : ''} · {plural(left(e), 'day')} left</td>
                  <td className="small muted">{e.adventures}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn sm" onClick={() => act(() => api.restoreWorld(e.id))}>Restore</button>{' '}
                    <button className="btn sm danger" onClick={() => void ask(`Remove “${e.title}” and its adventures for good? This cannot be undone.`, { danger: true }).then((ok) => void (ok && act(() => api.purgeWorld(e.id))))}>Remove now</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted small">Nothing in the trash.</div>
        )}
        <div className="hint">A deleted world and its adventures are kept here for {trash.days} days, then removed for good.</div>
      </div>
    </div>
  );
}
