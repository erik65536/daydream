/**
 * The device around the game: the part of the screen that can be seen (an on-screen keyboard takes the rest), full
 * screen, and keeping the screen awake while playing.
 */

/**
 * `--vvh` is the height of the visible part of the page. Phones show their keyboard over the page (iOS always,
 * Android unless the page resizes): the game shrinks to what is left, so a conversation's text field stays in view.
 */
export function trackVisibleViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  const update = () => {
    root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    // iOS scrolls the page to show a focused field; the game is fixed, so it scrolls back.
    if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}

type FsDoc = Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => Promise<void> };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };

/** Whether this browser can take the page full screen (iPhones cannot; installing to the home screen does it there). */
export function canFullscreen(): boolean {
  const el = document.documentElement as FsEl;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen) && !isStandalone();
}

export function isFullscreen(): boolean {
  const d = document as FsDoc;
  return !!(d.fullscreenElement ?? d.webkitFullscreenElement);
}

export async function toggleFullscreen() {
  const d = document as FsDoc, el = document.documentElement as FsEl;
  try {
    if (isFullscreen()) await (d.exitFullscreen?.() ?? d.webkitExitFullscreen?.());
    else await (el.requestFullscreen?.({ navigationUI: 'hide' }) ?? el.webkitRequestFullscreen?.());
  } catch {
    /* refused (not from a tap, or not allowed here) */
  }
}

/** Browsers that can install the game as an app (Chrome, Edge, Android) offer it once; the offer is kept for the menu. */
let installOffer: (Event & { prompt(): Promise<void> }) | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installOffer = e as typeof installOffer;
  });
  window.addEventListener('appinstalled', () => (installOffer = null));
}

export const canInstall = () => !!installOffer && !isStandalone();

export async function install() {
  const offer = installOffer;
  installOffer = null;
  await offer?.prompt().catch(() => {});
}

/** Opened from the home screen as an app. */
export function isStandalone(): boolean {
  return matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** Keeps the screen from dimming while the game is open (reading a conversation is not touching it). Returns a release. */
export function keepAwake(): () => void {
  type Lock = { release(): Promise<void> };
  const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<Lock> } }).wakeLock;
  if (!wl) return () => {};
  let lock: Lock | null = null;
  let live = true;
  const take = () => {
    if (!live || document.visibilityState !== 'visible') return;
    wl.request('screen').then((l) => (live ? (lock = l) : void l.release()), () => {});
  };
  // The lock is dropped whenever the page is hidden; it is taken again on return.
  document.addEventListener('visibilitychange', take);
  take();
  return () => {
    live = false;
    document.removeEventListener('visibilitychange', take);
    void lock?.release().catch(() => {});
  };
}
