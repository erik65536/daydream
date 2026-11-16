/**
 * Getting in: signing in (user name and password, or a passkey) and setting an account up from its invite link
 * (#/invite/<code>): a user name (unless the account already has one), a name others see, then a passkey, a password
 * or both.
 */
import { useEffect, useId, useState } from 'react';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN, checkDisplayName, checkPassword, checkUsername } from '@daydream/shared';
import { api, type Me, type Proof } from '../api';
import { MoonScreen } from '../ui/night';
import { useReveal, type FieldState } from '../ui/fields';
import { navigate } from '../App';

export const passkeysWork = () => browserSupportsWebAuthn();

/** A passkey canceled in the browser's own dialog is not an error worth showing. */
const cancelled = (e: unknown) => (e as Error)?.name === 'NotAllowedError' || (e as Error)?.name === 'AbortError';

/** Use a passkey for a ceremony the server started; returns the browser's answer. */
async function answerPasskey(options: unknown) {
  return startAuthentication({ optionsJSON: options as never });
}

/** Make a passkey for a ceremony the server started. */
export async function makePasskey(options: unknown) {
  return startRegistration({ optionsJSON: options as never });
}

/** A passkey proof that it is you, ready to send with a change. */
export async function passkeyProof(): Promise<Proof> {
  const c = await api.proofStart();
  return { passkey: { flow: c.flow, response: await answerPasskey(c.options) } };
}

/** The lantern lake: the title on the far shore with its reflection in the water, the form below it. */
function Shell({ tagline, wide, children }: { tagline: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <MoonScreen scene="lake">
      <main className="m-lake">
        <div className="m-lake-title">
          <div className="m-emblem" />
          <div className="m-wordmark">Daydream</div>
          <div className="m-wordmark reflection" aria-hidden="true">Daydream</div>
          <div className="m-tagline">{tagline}</div>
        </div>
        <div className={`m-panel${wide ? ' wide' : ''}`}>{children}</div>
      </main>
    </MoonScreen>
  );
}

const KeyIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="8" cy="8" r="5" /><path d="M11.5 11.5 21 21M17 17l2-2M15 19l2-2" /></svg>
);

/** A field on the lake with its line beneath: what is wrong, else the rule it keeps or good news. */
function Well({ note, bad, good, ...input }: React.InputHTMLAttributes<HTMLInputElement> & { note?: string; bad?: boolean; good?: boolean }) {
  const id = useId();
  return (
    <div className="m-field">
      <input className="m-well" aria-invalid={bad || undefined} aria-describedby={note ? id : undefined} {...input} />
      {note && <div id={id} className={`m-fine${bad ? ' bad' : good ? ' good' : ''}`} aria-live="polite">{note}</div>}
    </div>
  );
}

/** The second password must match the first; while it is shorter it may only be unfinished. */
export const matching = (password: string, again: string): FieldState =>
  again === password ? {} : { problem: 'The passwords do not match.', unfinished: again.length < password.length };

export function AuthScreen({ onAuthed }: { onAuthed: (me: Me) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<Me>) => {
    setBusy(true);
    setError('');
    try {
      onAuthed(await fn());
    } catch (err) {
      if (!cancelled(err)) setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const withPasskey = () =>
    run(async () => {
      const c = await api.passkeySignInStart();
      return api.passkeySignInFinish(c.flow, await answerPasskey(c.options));
    });
  return (
    <Shell tagline="Describe a world. Then walk into it.">
      <form
        style={{ display: 'contents' }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!username.trim() || !password) setError('Enter your user name and password.');
          else run(() => api.login(username, password));
        }}
      >
        <input className="m-well" aria-label="User name" placeholder="User name" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        <input className="m-well" aria-label="Password" placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        {error && <div className="m-error" role="alert">{error}</div>}
        <button className="m-lantern" disabled={busy}>Enter</button>
        <div className="foot">
          {passkeysWork() ? <button type="button" className="m-passkey" disabled={busy} onClick={withPasskey}><KeyIcon />Use a passkey</button> : <span />}
          <div className="m-fine" title="Ask this server’s administrator for an invite link.">By invitation only</div>
        </div>
      </form>
    </Shell>
  );
}

/** Setting up an account from its invite link: a user name and a name, then a passkey, a password, or both. */
export function InviteScreen({ code, onAuthed }: { code: string; onAuthed: (me: Me) => void }) {
  const [invite, setInvite] = useState<{ username: string | null; displayName: string } | null>(null);
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [keyName, setKeyName] = useState('');
  // A passkey first where the browser can make one; a password on request, or where there is no other way.
  const [withPassword, setWithPassword] = useState(!passkeysWork());
  /** The server's answer on whether a well-formed user name can be had (it may be taken). */
  const [asked, setAsked] = useState<{ name: string; problem: string | null } | null>(null);
  const reveal = useReveal();
  useEffect(() => {
    api.invite(code).then((i) => {
      setInvite(i);
      setName(i.displayName);
    }, (e) => setError(e.message));
  }, [code]);
  const needsName = !!invite && !invite.username;
  const typed = checkUsername(username);
  // Once typing pauses on a well-formed user name, ask whether it is free.
  useEffect(() => {
    if (!needsName || typed.problem) return;
    const t = setTimeout(() => api.usernameProblem(code, typed.value).then((r) => setAsked({ name: typed.value, problem: r.problem }), () => {}), 350);
    return () => clearTimeout(t);
  }, [code, needsName, typed.value, typed.problem]);
  const answer = asked && asked.name.toLowerCase() === typed.value.toLowerCase() ? asked : null;
  const user: FieldState = !needsName ? {} : typed.problem ? typed : { problem: answer?.problem ?? undefined };
  const display = checkDisplayName(name);
  const pass = checkPassword(password);
  const match = matching(password, again);
  const key: FieldState = keyName.trim() ? {} : { problem: 'Name your passkey to tell it apart from others you add later.', unfinished: true };
  const shown = {
    user: reveal.shown('user', user),
    name: reveal.shown('name', display),
    pass: reveal.shown('pass', pass),
    again: reveal.shown('again', match),
    key: reveal.shown('key', key),
  };
  const done = (me: Me) => {
    navigate('#/');
    onAuthed(me);
  };
  const run = async (fields: FieldState[], fn: () => Promise<Me>) => {
    if (!reveal.ready(fields)) return;
    setBusy(true);
    setError('');
    try {
      done(await fn());
    } catch (err) {
      if (!cancelled(err)) setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  /** Another way to sign in starts with a fresh form: what was tried with the other one is not held against it. */
  const switchTo = (password: boolean) => {
    setWithPassword(password);
    setError('');
    reveal.reset();
  };
  /** The user name to send: none when the account already has one. */
  const chosen = needsName ? typed.value : undefined;
  if (!invite)
    return (
      <Shell tagline="You are invited.">
        {error ? <div className="m-error">{error}</div> : <div className="m-spinner" />}
        <button className="m-quiet" onClick={() => navigate('#/')}>Sign in instead</button>
      </Shell>
    );
  const free = needsName && !user.problem && !!answer;
  const names = (
    <>
      {needsName && (
        <Well
          aria-label="User name"
          placeholder="User name, for signing in"
          autoFocus
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onBlur={reveal.leave('user')}
          bad={!!shown.user}
          good={free}
          note={shown.user ?? (free ? `${typed.value} is free.` : `${USERNAME_MIN} to ${USERNAME_MAX} letters, numbers, dots, dashes, or underscores`)}
        />
      )}
      <Well aria-label="The name others see" placeholder="The name others see" value={name} onChange={(e) => setName(e.target.value)} onBlur={reveal.leave('name')} bad={!!shown.name} note={shown.name} />
    </>
  );
  return (
    <Shell tagline={invite.username ? `Welcome back, ${invite.username}.` : 'You are invited. Choose how you will come back.'} wide>
      <div className="note">{invite.username ? 'Set up how you sign in again.' : 'Choose your user name (it cannot be changed later) and the name other players see.'}</div>
      {!withPassword ? (
        <form
          style={{ display: 'contents' }}
          onSubmit={(e) => {
            e.preventDefault();
            run([user, display, key], async () => {
              const c = await api.joinPasskeyStart(code, chosen);
              return api.joinPasskeyFinish(code, { flow: c.flow, response: await makePasskey(c.options), name: keyName, username: chosen, displayName: name });
            });
          }}
        >
          {names}
          <Well value={keyName} maxLength={40} onChange={(e) => setKeyName(e.target.value)} onBlur={reveal.leave('key')} placeholder="Name your passkey" aria-label="A name for this passkey" bad={!!shown.key} note={shown.key} />
          {error && <div className="m-error" role="alert">{error}</div>}
          <button className="m-lantern" disabled={busy}>Create a passkey</button>
          <div className="foot">
            <button type="button" className="m-passkey" onClick={() => switchTo(true)}>Use a password instead</button>
            <div className="m-fine">Your face, fingerprint, or PIN</div>
          </div>
        </form>
      ) : (
        <form
          style={{ display: 'contents' }}
          onSubmit={(e) => {
            e.preventDefault();
            run([user, display, pass, match], () => api.joinWithPassword(code, { username: chosen, displayName: name, password }));
          }}
        >
          {names}
          <input type="text" autoComplete="username" value={invite.username ?? username} readOnly hidden />
          <Well type="password" placeholder="Password" aria-label="Password" value={password} onChange={(e) => setPassword(e.target.value)} onBlur={reveal.leave('pass')} autoComplete="new-password" bad={!!shown.pass} note={shown.pass ?? `At least ${PASSWORD_MIN} characters`} />
          <Well type="password" placeholder="Password again" aria-label="Password again" value={again} onChange={(e) => setAgain(e.target.value)} onBlur={reveal.leave('again')} autoComplete="new-password" bad={!!shown.again} note={shown.again} />
          {error && <div className="m-error" role="alert">{error}</div>}
          <button className="m-lantern" disabled={busy}>Set password</button>
          <div className="foot">
            {passkeysWork() ? <button type="button" className="m-passkey" onClick={() => switchTo(false)}><KeyIcon />Use a passkey instead</button> : <span />}
            <div className="m-fine">Add the other later on your account page</div>
          </div>
        </form>
      )}
    </Shell>
  );
}
