/**
 * The player's own preferences, kept with their account so they follow them to every device. Changes apply at once
 * and are saved a moment later (a slider being dragged saves once). Muting the pages outside the game is the one kept
 * with the device instead (the room it is in decides it), so it holds before signing in too.
 */
import { useSyncExternalStore } from 'react';
import { DEFAULT_SETTINGS, normalizeSettings, type PlayerSettings } from '@daydream/shared';
import { api } from './api';

let current: PlayerSettings = DEFAULT_SETTINGS;
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** The settings as the account has them (on signing in). */
export function loadSettings(s: PlayerSettings | undefined) {
  current = normalizeSettings(s);
  for (const l of listeners) l();
}

export function settings(): PlayerSettings {
  return current;
}

export function updateSettings(change: (s: PlayerSettings) => PlayerSettings) {
  current = normalizeSettings(change(structuredClone(current)));
  for (const l of listeners) l();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void api.saveSettings(current).catch(() => {}), 400);
}

export function onSettings(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useSettings(): PlayerSettings {
  return useSyncExternalStore(onSettings, settings);
}

const MUTED_KEY = 'daydream.pagesMuted';
let mutedNow = (() => {
  try {
    return localStorage.getItem(MUTED_KEY) === '1';
  } catch {
    return false;
  }
})();

/** The pages outside the game are silent on this device, whatever the volumes; the game is not (sound.ts). */
export function pagesMuted(): boolean {
  return mutedNow;
}

export function setPagesMuted(on: boolean) {
  mutedNow = on;
  try {
    if (on) localStorage.setItem(MUTED_KEY, '1');
    else localStorage.removeItem(MUTED_KEY);
  } catch {
    /* kept for this visit only */
  }
  for (const l of listeners) l();
}

export function usePagesMuted(): boolean {
  return useSyncExternalStore(onSettings, pagesMuted);
}
