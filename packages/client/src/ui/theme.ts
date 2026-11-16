/**
 * World theming. The layout never changes; each world restyles it:
 * - colors from the world's palette,
 * - lettering, panel material, and corner ornaments from the ruleset's `ui`,
 * - color grading of the game view (tint, saturation, contrast, vignette, grain).
 */
import { useSyncExternalStore } from 'react';
import type { Ruleset } from '@daydream/shared';

type Hsl = { h: number; s: number; l: number };

function hexToHsl(hex: string): Hsl | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

const hsl = (c: Hsl, a = 1) => `hsla(${c.h.toFixed(0)}, ${(c.s * 100).toFixed(0)}%, ${(c.l * 100).toFixed(0)}%, ${a})`;
const clampL = (c: Hsl, lo: number, hi: number, maxS = 1): Hsl => ({ h: c.h, s: Math.min(maxS, c.s), l: Math.max(lo, Math.min(hi, c.l)) });

interface Fonts {
  display: string;
  serif: string;
}

/** Font pairs for each lettering style the rules designer can choose (all loaded in index.html). */
const TYPEFACES: Record<Ruleset['ui']['typeface'], Fonts> = {
  engraved: { display: "'Cinzel', 'Trajan Pro', Georgia, serif", serif: "'EB Garamond', Georgia, serif" },
  classic: { display: "'EB Garamond', Georgia, serif", serif: "'Lora', Georgia, serif" },
  modern: { display: "'Inter', system-ui, sans-serif", serif: "'Inter', system-ui, sans-serif" },
  condensed: { display: "'Oswald', 'Inter', sans-serif", serif: "'Inter', system-ui, sans-serif" },
  storybook: { display: "'Fraunces', Georgia, serif", serif: "'Lora', Georgia, serif" },
  gothic: { display: "'IM Fell English SC', Georgia, serif", serif: "'IM Fell English', Georgia, serif" },
  technical: { display: "'Exo 2', 'Inter', sans-serif", serif: "'Inter', system-ui, sans-serif" },
};

const VARS = [
  '--gold', '--gold-2', '--accent', '--accent-glow', '--line', '--line-strong', '--panel', '--panel-solid', '--panel-2', '--bg', '--display', '--serif',
  '--grade-tint', '--grade-tint-a', '--grade-filter', '--grade-vignette', '--grade-grain', '--btn-primary-a', '--btn-primary-b', '--btn-primary-edge',
];

/** What a world's look is made from: its palette, and the material, lettering, and grading its rules chose. */
interface ThemeSource {
  concept: { palette: { primary: string; secondary: string; accent: string; ui: string } };
  ruleset: Pick<Ruleset, 'ui'>;
}

/** Bumped whenever the look changes, so what paints with it (skill icons' frames) can paint again. */
let themeVersion = 0;
const themeListeners = new Set<() => void>();
const themeChanged = () => {
  themeVersion++;
  for (const l of themeListeners) l();
};
/** The look's version now (for what is drawn outside React and kept until the look changes). */
export const currentThemeVersion = () => themeVersion;
export function useThemeVersion(): number {
  return useSyncExternalStore((fn) => (themeListeners.add(fn), () => void themeListeners.delete(fn)), () => themeVersion);
}

/**
 * The corner radius of an icon drawn `size` pixels square inside a slot: the slot's own radius (the world's material,
 * `--r-ui`) less the gap around a 40-pixel icon, so the two corners run parallel.
 */
export function iconRadius(size: number): number {
  const slot = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--r-ui')) || 8;
  return (Math.max(2, slot - 5) / 40) * size;
}

/** Apply a world's look to the document; returns a function that restores the default look. */
export function applyWorldTheme(world: ThemeSource | null | undefined): () => void {
  const el = document.documentElement;
  const root = el.style;
  const clear = () => {
    VARS.forEach((v) => root.removeProperty(v));
    delete el.dataset.material;
    delete el.dataset.ornament;
    themeChanged();
  };
  if (!world) return clear;
  const p = world.concept.palette;
  const primary = hexToHsl(p.primary);
  const accent = hexToHsl(p.accent);
  const ui = hexToHsl(p.ui) ?? hexToHsl(p.secondary);
  if (primary) {
    // Titles and lines must stay readable on dark panels whatever the palette says.
    // Muted: the palette tints the interface without making it loud.
    const title = clampL(primary, 0.6, 0.72, 0.42);
    root.setProperty('--gold', hsl(title));
    root.setProperty('--gold-2', hsl({ ...title, l: Math.min(0.86, title.l + 0.14) }));
    root.setProperty('--line', hsl(title, 0.22));
    root.setProperty('--line-strong', hsl(title, 0.45));
    root.setProperty('--btn-primary-a', hsl({ ...title, l: 0.32, s: Math.min(0.3, title.s) }));
    root.setProperty('--btn-primary-b', hsl({ ...title, l: 0.22, s: Math.min(0.3, title.s) }));
    root.setProperty('--btn-primary-edge', hsl({ ...title, l: 0.5, s: Math.min(0.35, title.s) }));
  }
  if (accent) {
    const a = clampL(accent, 0.5, 0.62, 0.5);
    root.setProperty('--accent', hsl(a));
    root.setProperty('--accent-glow', hsl(a, 0.28));
  }
  const u = world.ruleset.ui;
  const material = u.material;
  if (ui) {
    // Light materials still render as dark panels (readability); they just warm or cool the base.
    const lo = material === 'glass' || material === 'neon' ? 0.06 : 0.08;
    const base = clampL(ui, lo, lo + 0.03, material === 'neon' ? 0.5 : 0.35);
    const alpha = material === 'glass' ? 0.78 : 0.94;
    root.setProperty('--panel', hsl(base, alpha));
    root.setProperty('--panel-solid', hsl(base));
    root.setProperty('--panel-2', hsl({ ...base, l: base.l + 0.05 }, 0.92));
    root.setProperty('--bg', hsl({ ...base, l: 0.05 }));
  }
  // The lettering the rules chose.
  const f = TYPEFACES[u.typeface];
  root.setProperty('--display', f.display);
  root.setProperty('--serif', f.serif);
  el.dataset.material = u.material;
  el.dataset.ornament = u.ornament;
  const g = u.grading;
  const tint = hexToHsl(g.tint);
  // White means "no tint"; the strength grows with how colored the tint is.
  root.setProperty('--grade-tint', g.tint);
  root.setProperty('--grade-tint-a', tint ? String(Math.min(0.35, tint.s * 0.3 * (1 - Math.abs(tint.l - 0.5)))) : '0');
  root.setProperty('--grade-filter', `saturate(${clamp(g.saturation, 0.4, 1.6)}) contrast(${clamp(g.contrast, 0.8, 1.3)})`);
  root.setProperty('--grade-vignette', String(clamp(g.vignette, 0, 0.8)));
  root.setProperty('--grade-grain', String(clamp(g.grain, 0, 0.12)));
  themeChanged();
  return clear;
}

/** A world's color made legible as text on dark panels (same hue, lightened). */
export function readable(color: string | undefined, fallback = 'var(--text)'): string {
  const c = color ? hexToHsl(color) : null;
  return c ? hsl({ h: c.h, s: Math.min(0.8, c.s), l: Math.max(0.68, Math.min(0.85, c.l)) }) : color ?? fallback;
}

const clamp = (x: number, lo: number, hi: number) => (Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : lo);
