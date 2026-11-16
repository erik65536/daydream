import { Component, Suspense, lazy, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { api, ApiError, onSignedOut, type Me } from './api';
import { AuthScreen, InviteScreen } from './screens/Auth';
import { Lobby } from './screens/Lobby';
import { loadSettings } from './settings';
import { sounds } from './sounds';
import { TooltipHost } from './ui/common';
import { reportError } from './report';

/** Set for this tab while it reloads to fetch new code, so a screen that still cannot load does not reload forever. */
const RELOADED = 'daydream.reloadedForCode';
const reloaded = (set?: boolean) => {
  try {
    if (set === undefined) return !!sessionStorage.getItem(RELOADED);
    if (set) sessionStorage.setItem(RELOADED, '1');
    else sessionStorage.removeItem(RELOADED);
  } catch {
    /* no storage here: it reloads at most once more than it should */
  }
  return false;
};

/**
 * Screens past the lobby load when first opened, each with only what it needs: a player never downloads the world viewer,
 * the world maker or the administrators' pages, and the lobby comes up before the game's code has arrived. A tab opened
 * before the game was updated asks for code that is gone: it reloads once, which brings the new code.
 */
function lazyScreen<P>(load: () => Promise<ComponentType<P>>) {
  return lazy(() =>
    load().then(
      (c) => {
        reloaded(false);
        return { default: c };
      },
      (e) => {
        if (reloaded()) throw e;
        reloaded(true);
        location.reload();
        return new Promise<never>(() => {});
      },
    ),
  );
}
const loadGame = () => import('./screens/Game');
const GameScreen = lazyScreen(() => loadGame().then((m) => m.GameScreen));
const AdventurePage = lazyScreen(() => import('./screens/AdventurePage').then((m) => m.AdventurePage));
const CharacterCreate = lazyScreen(() => import('./screens/CharacterCreate').then((m) => m.CharacterCreate));
const WorldPage = lazyScreen(() => import('./screens/WorldPage').then((m) => m.WorldPage));
const CreateWorld = lazyScreen(() => import('./screens/CreateWorld').then((m) => m.CreateWorld));
const Viewer = lazyScreen(() => import('./screens/viewer/Viewer').then((m) => m.Viewer));
const Account = lazyScreen(() => import('./screens/Account').then((m) => m.Account));
const Users = lazyScreen(() => import('./screens/Account').then((m) => m.Users));
const SettingsPage = lazyScreen(() => import('./screens/Settings').then((m) => m.SettingsPage));
const Models = lazyScreen(() => import('./screens/Models').then((m) => m.Models));
const GpuAdmin = lazyScreen(() => import('./screens/Gpu').then((m) => m.GpuAdmin));
const ErrorsAdmin = lazyScreen(() => import('./screens/Errors').then((m) => m.ErrorsAdmin));
// In development only (see ADMIN_PAGES): a build of the game does not carry it.
const DreamPreview = import.meta.env.DEV ? lazyScreen(() => import('./screens/DreamPreview').then((m) => m.DreamPreview)) : null;

const Loading = () => (
  <div className="center" style={{ height: '100%' }}>
    <div className="spinner" />
  </div>
);

/** The administrators' pages, as the account menu lists them; anyone else who opens one sees the worlds instead. */
export const ADMIN_PAGES = [
  { page: 'models', label: 'AI models' },
  { page: 'gpu', label: 'GPU' },
  { page: 'errors', label: 'Errors' },
  { page: 'users', label: 'Users' },
  // In development only: the page of a world being dreamed, played from a made-up build, to tune it.
  ...(import.meta.env.DEV ? [{ page: 'dreaming', label: 'Dreaming preview' }] : []),
];
const isAdminPage = (page: string) => ADMIN_PAGES.some((p) => p.page === page);

export function navigate(hash: string) {
  location.hash = hash;
}

let leaving: (() => Promise<boolean>) | null = null;
/**
 * A page holding work that leaving would lose (a world being reviewed) asks before any other page opens, however the
 * player got there: a link, the menu, or the browser's Back. `ask` resolves true to leave; null ends the guard.
 */
export function guardLeaving(ask: (() => Promise<boolean>) | null) {
  leaving = ask;
}

function useHash() {
  const [hash, setHash] = useState(location.hash || '#/');
  const shown = useRef(hash);
  useEffect(() => {
    let asking = false;
    const on = async () => {
      const to = location.hash || '#/';
      if (leaving && to !== shown.current) {
        // The address goes back to the page still shown while the player answers.
        history.replaceState(null, '', shown.current);
        if (asking) return;
        asking = true;
        const leave = await leaving();
        asking = false;
        if (!leave) return;
        leaving = null;
        history.replaceState(null, '', to);
      }
      shown.current = to;
      setHash(to);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('[ui] crashed', error);
    // Which components it happened in, below the error's own stack.
    reportError(error, 'screen', info.componentStack ? `Components:${info.componentStack}` : undefined);
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="center col" style={{ height: '100%', gap: 14 }}>
        <div className="display gold" style={{ fontSize: 22 }}>Something went wrong</div>
        <div className="muted small" style={{ maxWidth: 520, textAlign: 'center' }}>{this.state.error.message}</div>
        <div className="row">
          <button className="btn primary" onClick={() => location.reload()}>Reload</button>
          <button className="btn ghost" onClick={() => { location.hash = '#/'; location.reload(); }}>Back to worlds</button>
        </div>
      </div>
    );
  }
}

/** Pages that play the game's own theme (docs/sound.md, "Music"): signing in and the pages around the worlds. */
const THEME_PAGES = new Set(['', 'invite', 'create', 'account', 'settings']);

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  /** Someone signed in (on loading the page, through the form, or by an invite): their settings come with them. */
  const signedIn = (m: Me) => {
    loadSettings(m.settings);
    setMe(m);
    // The game is where a player is headed: fetch its code while they look around, so it opens at once.
    (window.requestIdleCallback ?? setTimeout)(() => void loadGame().catch(() => {}));
  };
  // A session that ended elsewhere (a new password, a reset, its 30 days) shows the sign-in form, not an error line.
  useEffect(() => {
    onSignedOut(() => setMe((was) => (was ? null : was)));
    return () => onSignedOut(null);
  }, []);
  const hash = useHash();
  const page = hash.replace(/^#\/?/, '').split(/[/?]/)[0] ?? '';
  // A world's pages play its theme (WorldPage); the game its places; these the game's theme.
  useEffect(() => {
    if (me === null || (me && THEME_PAGES.has(page))) sounds.pageMusic();
  }, [page, me === null, !!me]);
  useEffect(() => {
    // Only a real 401 means signed out; while the server is unreachable (e.g. restarting), keep retrying.
    let stop = false;
    let delay = 500;
    const attempt = () =>
      api.me().then(
        (m) => {
          if (!stop) signedIn(m);
        },
        (e) => {
          if (stop) return;
          if (e instanceof ApiError && e.status === 401) return setMe(null);
          setTimeout(attempt, (delay = Math.min(5000, delay * 1.6)));
        },
      );
    attempt();
    return () => {
      stop = true;
    };
  }, []);
  if (me === undefined) return <Loading />;
  const parts = hash.replace(/^#\/?/, '').split('/');
  // An invite link sets up its account, whoever is signed in on this browser.
  if (parts[0] === 'invite' && parts[1]) return <InviteScreen code={decodeURIComponent(parts[1])} onAuthed={signedIn} />;
  if (!me) return <AuthScreen onAuthed={signedIn} />;
  let screen;
  switch (isAdminPage(parts[0] ?? '') && !me.isAdmin ? '' : parts[0]) {
    case 'create':
      screen = <CreateWorld me={me} onMe={setMe} />;
      break;
    case 'world':
      // #/world/<id>: its page; /new: beginning an adventure; /view: the viewer, for administrators (others see its page).
      screen = parts[2] === 'new' ? <CharacterCreate key={parts[1]} me={me} worldId={parts[1]!} /> : parts[2] === 'view' && me.isAdmin ? <Viewer key={parts[1]} me={me} worldId={parts[1]!} path={parts.slice(3)} /> : <WorldPage key={parts[1]} me={me} worldId={parts[1]!} />;
      break;
    case 'adventure':
      // #/adventure/<id>: its page; #/adventure/<id>/heroes: making heroes for it.
      screen = parts[2]?.startsWith('heroes') ? <CharacterCreate key={parts[1]} me={me} adventureId={parts[1]!.split('?')[0]!} /> : <AdventurePage key={parts[1]} me={me} adventureId={parts[1]!.split('?')[0]!} />;
      break;
    case 'play':
      screen = <GameScreen key={parts[1]} me={me} adventureId={parts[1]!} />;
      break;
    case 'account':
      screen = <Account me={me} onMe={setMe} />;
      break;
    case 'users':
      screen = <Users me={me} />;
      break;
    case 'gpu':
      screen = <GpuAdmin me={me} />;
      break;
    case 'errors':
      screen = <ErrorsAdmin me={me} />;
      break;
    case 'models':
      screen = <Models me={me} />;
      break;
    case 'dreaming':
      screen = DreamPreview ? <DreamPreview me={me} /> : <Lobby me={me} />;
      break;
    case 'settings':
      screen = <SettingsPage me={me} />;
      break;
    default:
      screen = <Lobby me={me} />;
  }
  return (
    <ErrorBoundary>
      <Suspense fallback={<Loading />}>{screen}</Suspense>
      <TooltipHost />
    </ErrorBoundary>
  );
}
