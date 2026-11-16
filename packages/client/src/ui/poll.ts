import { useEffect, useRef, useState } from 'react';

/**
 * Keeps a page up to date: `load` runs at once and then every `ms` (read anew each time, so a page can ask faster
 * while something is happening), but not while the tab is hidden; it runs again the moment the tab is shown. What
 * went wrong with the last run is `error`, cleared by the next one that works. `load` is given `alive`, false once the
 * page has gone, to check between its own requests. `refresh` runs it now (after an action) and resolves when what it
 * shows is no older than the call.
 */
export function usePoll(load: (alive: () => boolean) => Promise<unknown>, ms: number, deps: readonly unknown[]) {
  const [error, setError] = useState('');
  const latest = useRef({ load, ms });
  latest.current = { load, ms };
  const control = useRef({ refresh: () => Promise.resolve(), wait: () => {} });
  useEffect(() => {
    let alive = true, timer = 0, stale = false;
    let running: Promise<void> | null = null;
    const wait = () => {
      clearTimeout(timer);
      if (alive && !running && !document.hidden) timer = window.setTimeout(refresh, latest.current.ms);
    };
    const refresh = (): Promise<void> => {
      // A run already under way may have asked before the caller's change: it is followed by another.
      if (running) {
        stale = true;
        return running;
      }
      clearTimeout(timer);
      running = (async () => {
        do {
          stale = false;
          try {
            await latest.current.load(() => alive);
            if (alive) setError('');
          } catch (e) {
            if (alive) setError((e as Error).message);
          }
        } while (stale && alive);
        running = null;
        wait();
      })();
      return running;
    };
    const shown = () => void (document.hidden ? clearTimeout(timer) : refresh());
    control.current = { refresh, wait };
    document.addEventListener('visibilitychange', shown);
    void refresh();
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', shown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  // A new pace holds from now, not from the next run.
  useEffect(() => control.current.wait(), [ms]);
  return { error, setError, refresh: () => control.current.refresh() };
}
