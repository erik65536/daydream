import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { longPress, useTouch } from '../input/pointer';
import { itemDisplayName, itemLines, itemPrice, maxStack, nextRankLines, playerLevel, rx, skillCostLine, skillDetails, wieldBlock, type ItemCategory, type ItemInstance, type Ruleset, type StatBlock } from '@daydream/shared';
import { client } from '../net/game';
import { drawItemIcon, drawSkillIcon } from '../render/icons';
import { Icon } from './svgicons';
import { readable, useThemeVersion } from './theme';
import { drawPlaceholder, drawShadow, imageState, loadImage, onImageSettled } from '../render/sprites';
import { sounds } from '../sounds';

export function CanvasDraw({ size, draw, deps, className }: { size: number; draw: (ctx: CanvasRenderingContext2D, s: number) => void; deps: unknown[]; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = size * dpr;
    c.height = size * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, size);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return <canvas ref={ref} className={className} style={{ width: size, height: size }} />;
}

/** Props that make a clickable element work from the keyboard too (focusable, Enter, and Space press it). */
export function pressable(onPress: () => void) {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: onPress,
    onKeyDown: (e: React.KeyboardEvent) => {
      // A key pressed on a button inside it is that button's.
      if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      onPress();
    },
  };
}

/** A window's row of tabs. */
export function Tabs({ children, label }: { children: ReactNode; label?: string }) {
  return <div className="tabs" role="tablist" aria-label={label}>{children}</div>;
}

/** One tab of the row: pressed with the mouse, a finger, or the keyboard. */
export function Tab({ on, onPress, className, children }: { on: boolean; onPress: () => void; className?: string; children: ReactNode }) {
  return <div className={`tab ${on ? 'on' : ''} ${className ?? ''}`} {...pressable(onPress)} role="tab" aria-selected={on}>{children}</div>;
}

/** A rule word in the plural ("Class" → "Classes", "City" → "Cities"). */
export const plural = (w: string) => (/[^aeiou]y$/i.test(w) ? `${w.slice(0, -1)}ies` : /(s|x|ch|sh)$/i.test(w) ? `${w}es` : `${w}s`);

/** Whether a world has anything to craft, brew, improve or enchant (the crafting window and its key). */
export const hasCrafting = (r: Ruleset) => r.crafts.length > 0 || r.recipes.length > 0 || r.crafting.upgrades.enabled || r.crafting.enchanting.enabled;

export function SkillIcon({ id, size = 40 }: { id: string; size?: number }) {
  // Its frame follows the world's corners, so it paints again when the look changes.
  const look = useThemeVersion();
  return <CanvasDraw size={size} deps={[id, size, look]} draw={(ctx, s) => drawSkillIcon(ctx, s, id)} />;
}

export function ItemIcon({ item, size = 40, url }: { item: { baseId: string; rarityId?: string }; size?: number; url?: string }) {
  const [ok, setOk] = useState(!!url);
  if (url && ok) return <img src={url} width={size} height={size} onError={() => setOk(false)} alt="" />;
  return <CanvasDraw size={size} deps={[item.baseId, item.rarityId, size]} draw={(ctx, s) => drawItemIcon(ctx, s, item)} />;
}

interface PortraitProps {
  /** The figure's painting. */
  sprite?: string;
  size: number;
  /** Show the whole figure instead of head and shoulders. */
  full?: boolean;
}

/** Head-and-shoulders (or whole) view of a painted figure; a plain silhouette while it loads or when it has none. */
export function Portrait({ sprite, size, full }: PortraitProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = size * dpr;
    c.height = size * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const state = imageState(sprite);
    if (state === 'loading') {
      let live = true;
      onImageSettled(sprite!, () => live && setTick((x) => x + 1));
      return () => {
        live = false;
      };
    }
    const img = state === 'ok' ? loadImage(sprite) : null;
    if (img) {
      const h = full ? size * 0.92 : size * 2.1;
      const w = (img.naturalWidth / img.naturalHeight) * h;
      ctx.drawImage(img, size / 2 - w / 2, size * 0.04, w, h);
    } else {
      ctx.save();
      ctx.translate(size / 2, full ? size * 0.94 : size * 1.5);
      drawShadow(ctx, size * 0.2);
      drawPlaceholder(ctx, full ? size * 0.85 : size * 1.6);
      ctx.restore();
    }
  }, [sprite, size, tick, full]);
  return <canvas ref={ref} style={{ width: size, height: size }} />;
}

export function Bar({ value, max, color, label, thin, extra, extraColor }: { value: number; max: number; color: string; label?: string; thin?: boolean; extra?: number; extraColor?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const ex = extra && max > 0 ? Math.max(0, Math.min(100 - pct, (extra / max) * 100)) : 0;
  const bar = (
    <div className={`bar${thin ? ' thin' : ''}`}>
      <div style={{ width: `${pct}%`, background: color }} />
      {ex > 0 && <div style={{ position: 'absolute', left: `${pct}%`, top: 0, bottom: 0, width: `${ex}%`, background: extraColor ?? 'rgba(160,216,255,.8)' }} />}
    </div>
  );
  // The numbers sit above the bar, never squeezed inside it.
  if (!label || thin) return bar;
  return (
    <div className="bar-wrap">
      <div className="bar-num">{label}</div>
      {bar}
    </div>
  );
}

// ---------------------------------------------------------------------------- tooltip

type TipState = { x: number; y: number; content: ReactNode; anchor?: DOMRect };
let setTip: ((t: TipState | null) => void) | null = null;

/**
 * The one tooltip: beside the mouse, or (shown by a finger's long-press) above the thing pressed, below it when there
 * is no room. It always stays on screen.
 */
export function TooltipHost() {
  const [t, set] = useState<TipState | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  setTip = set;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!t || !el) return setPos(null);
    const w = el.offsetWidth, h = el.offsetHeight, W = window.innerWidth, H = window.innerHeight, m = 8;
    const clampX = (x: number) => Math.max(m, Math.min(W - w - m, x));
    if (t.anchor) {
      const a = t.anchor;
      const above = a.top - h - 10, below = a.bottom + 10;
      setPos({ left: clampX(a.left + a.width / 2 - w / 2), top: above >= m ? above : Math.min(below, H - h - m) });
    } else {
      const left = t.x + 16 + w > W - m ? t.x - 16 - w : t.x + 16;
      const top = t.y + 16 + h > H - m ? Math.max(m, t.y - 16 - h) : t.y + 16;
      setPos({ left: clampX(left), top });
    }
  }, [t]);
  // A tooltip shown by a finger stays until the next touch.
  useEffect(() => {
    if (!t?.anchor) return;
    const hide = () => set(null);
    const id = setTimeout(() => window.addEventListener('pointerdown', hide, { capture: true, once: true }), 0);
    return () => {
      clearTimeout(id);
      window.removeEventListener('pointerdown', hide, { capture: true });
    };
  }, [t]);
  if (!t) return null;
  return (
    <div ref={ref} className={`tooltip ${t.anchor ? 'held' : ''}`} style={pos ?? { left: -9999, top: 0 }}>
      {t.content}
    </div>
  );
}

/** Hover help for an element: shown beside the mouse, or by a long-press of a finger. */
export function tip(content: ReactNode | null) {
  const show = (e: React.PointerEvent) => e.pointerType !== 'touch' && content && setTip?.({ x: e.clientX, y: e.clientY, content });
  return {
    onPointerEnter: show,
    onPointerMove: show,
    onPointerLeave: (e: React.PointerEvent) => e.pointerType !== 'touch' && setTip?.(null),
    ...(content ? longPress((el) => setTip?.({ x: 0, y: 0, content, anchor: el.getBoundingClientRect() })) : {}),
  };
}

/** Show a tooltip held by a finger, above an element (for long-presses that do more than show it). */
export function holdTip(el: HTMLElement, content: ReactNode) {
  setTip?.({ x: 0, y: 0, content, anchor: el.getBoundingClientRect() });
}

export function hideTip() {
  setTip?.(null);
}

interface Uniques {
  uniqueItems: Record<string, { name: string; description: string }>;
}

/** What kind of thing an item is, when it is not gear or a story item. */
const CATEGORY: Record<ItemCategory, string> = { equipment: 'Gear', potion: 'Consumable', material: 'Material', valuable: 'Valuable', tool: 'Tool', quest: 'Story item', key: 'Story item' };

export function ItemTooltip({ item, r, uniques, price, compare }: { item: ItemInstance; r: Ruleset; uniques: Uniques; price?: number; compare?: ItemInstance }) {
  const ix = rx(r);
  const base = ix.item.get(item.baseId);
  const st = client().state;
  const hero = client().selectedHero();
  const lines = itemLines(r, item, base, hero?.level ?? (st.player ? playerLevel(st.player) : 1));
  const rarity = ix.rarity.get(item.rarityId);
  const color = item.uniqueId ? '#ffd24a' : rarity?.color ?? '#ddd';
  const desc = item.uniqueId ? uniques.uniqueItems[item.uniqueId]?.description : base?.description;
  const slot = base?.slotId ? ix.slot.get(base.slotId)?.name : undefined;
  // A weapon says whose it is ("Fine Hunter weapon"), and why the chosen hero cannot wield it, if they cannot.
  const cls = base?.classId ? ix.cls.get(base.classId)?.name : undefined;
  const unwieldy = hero ? wieldBlock(r, hero, base) : null;
  const value = itemPrice(r, item, st.player ? playerLevel(st.player) : 1);
  return (
    <div>
      <div className="tname" style={{ color }}>{itemDisplayName(r, item, uniques)}</div>
      <div className="tsub">
        {base?.category === 'equipment' ? `${item.uniqueId ? 'Unique' : rarity?.name ?? ''}${cls ? ` ${cls}` : ''}${slot ? ` ${slot.toLowerCase()}` : ''} · ${r.terminology.level} ${item.level}` : base?.category === 'quest' || item.bound ? 'Story item' : base ? CATEGORY[base.category] : ''}
        {maxStack(r, item) > 1 ? ` · stack ${item.qty}/${maxStack(r, item)}` : ''}
      </div>
      <div style={{ marginTop: 6 }}>
        {lines.map((l, i) => (
          <div className="tline" key={i}>{l}</div>
        ))}
      </div>
      {unwieldy && <div className="tsub unwieldy-why">{unwieldy}</div>}
      {desc && <div className="tdesc">{desc}</div>}
      {compare && <div className="tsub" style={{ marginTop: 6 }}>Equipped: {itemDisplayName(r, compare, uniques)}</div>}
      <div className="tsub" style={{ marginTop: 6 }}>
        {price !== undefined ? `Price: ${price} ${r.terminology.currency}` : value > 0 ? `Value: ${value} ${r.terminology.currency}` : ''}
      </div>
    </div>
  );
}

/**
 * A skill as a card: what it costs, what it does at the hero's rank (each status it applies with what that status
 * does), and in the talent tree what the next rank adds and the skill's own words. Elsewhere (the skill bar, the
 * controller's wheel) it stays to the mechanics.
 */
export function SkillTooltip({ id, r, stats, rank, cooldown, known, flavor, next }: { id: string; r: Ruleset; stats?: StatBlock; rank?: number; cooldown?: number; known?: boolean; flavor?: boolean; next?: boolean }) {
  const s = rx(r).skill.get(id);
  if (!s) return null;
  const owner = rx(r).cls.get(s.owner)?.name;
  const shown = Math.max(1, rank ?? 1);
  const coming = next ? nextRankLines(r, s, rank ?? 0, stats) : [];
  const rankText = rank === undefined || s.maxRank <= 1 && rank > 0 ? null : rank === 0 ? 'Not learned' : `Rank ${rank} of ${s.maxRank}`;
  return (
    <div className="skill-tip">
      <div className="st-head">
        <span className="tname gold">{s.name}</span>
        {rankText && <span className={`st-rank ${rank === 0 ? 'off' : ''}`}>{rankText}</span>}
      </div>
      <div className="tsub">{skillCostLine(r, s, stats)}{owner ? ` · ${owner}` : ''}</div>
      <div className="st-lines">
        {skillDetails(r, s, shown, stats).map((l, i) => (
          <div className="tline" key={i}>
            {l.status ? <StatusNamed text={l.text} name={l.status.name} color={l.status.color} /> : l.text}
            {l.status && l.status.lines.length > 0 && (
              <div className="st-status" style={{ '--sc': readable(l.status.color) } as React.CSSProperties}>
                {l.status.lines.map((x, k) => <div key={k}>{x}</div>)}
              </div>
            )}
          </div>
        ))}
      </div>
      {coming.length > 0 && (
        <div className="st-next">
          <div className="st-label">Next rank</div>
          {coming.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
      {flavor && s.description && <div className="tdesc">{s.description}</div>}
      {cooldown ? <div className="tsub st-ready">Ready in {cooldown}</div> : null}
      {known === false && <div className="tsub">Not learned</div>}
    </div>
  );
}

/** A line with a status's name in the status's color. */
function StatusNamed({ text, name, color }: { text: string; name: string; color: string }) {
  const at = text.indexOf(name);
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<b style={{ color: readable(color), fontWeight: 600 }}>{name}</b>{text.slice(at + name.length)}</>;
}

/**
 * Where a window opens: beside the party's frames when the screen has room, further left when it has not, never wider
 * than the screen. (Phones show every window as a full-screen sheet instead, mobile.css.)
 */
export function docked(width: number, top: number | string = 70): React.CSSProperties {
  return { left: `clamp(8px, calc(100% - ${width}px - 8px), 260px)`, top, width: `min(${width}px, calc(100% - 16px))` };
}

/** A window centered across the screen, never wider than it (less `margin` pixels in all). */
export function centered(width: number, top: number | string, margin = 16): React.CSSProperties {
  return { left: '50%', top, transform: 'translateX(-50%)', width: `min(${width}px, calc(100% - ${margin}px))` };
}

/** A panel opening and closing is heard (every window, the conversation, trading). */
export function usePanelSound(open: boolean) {
  useEffect(() => {
    if (!open) return;
    sounds.play('panel_open');
    return () => sounds.play('panel_close');
  }, [open]);
}

export function Window({ title, onClose, children, style, className, actions }: { title: ReactNode; onClose: () => void; children: ReactNode; style?: React.CSSProperties; className?: string; actions?: ReactNode }) {
  // Tooltips belong to the window that opened them.
  useEffect(() => () => hideTip(), []);
  usePanelSound(true);
  // The keyboard starts in the window that opened, unless something in it took the focus itself.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div ref={ref} role="dialog" aria-label={typeof title === 'string' ? title : undefined} tabIndex={-1} className={`window panel ornate ${className ?? ''}`} style={style} onMouseDown={(e) => e.stopPropagation()}>
      <span className="corner tl" />
      <span className="corner tr" />
      <span className="corner bl" />
      <span className="corner br" />
      <div className="panel-head">
        <h3>{title}</h3>
        <div className="spacer" />
        {actions}
        <button className="btn ghost sm close-x" onClick={onClose} aria-label="Close" {...tip('Close (Esc)')}><Icon name="close" size={16} color="currentColor" /></button>
      </div>
      {children}
    </div>
  );
}

/**
 * What can be done with one thing (an item, a ware): a small menu beside the mouse (or the controller's ring), or for a
 * finger a sheet rising from the bottom edge that also says what the thing is, since a finger cannot hover to see it.
 * The actions are buttons; any of them, a press outside, or Escape closes it.
 */
export function ActionSheet({ at, head, title, children, onClose }: { at: { x: number; y: number }; head?: ReactNode; title?: ReactNode; children: ReactNode; onClose: () => void }) {
  const touch = useTouch();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    hideTip();
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || touch) return;
    const m = 8;
    setPos({ left: Math.max(m, Math.min(window.innerWidth - el.offsetWidth - m, at.x)), top: Math.max(m, Math.min(window.innerHeight - el.offsetHeight - m, at.y)) });
  }, [touch, at.x, at.y]);
  const close = (e: React.PointerEvent | React.MouseEvent) => e.target === e.currentTarget && onClose();
  return createPortal(
    <div className={`ctx-wrap ${touch ? 'sheet-wrap' : ''}`} onPointerDown={close} onContextMenu={(e) => (e.preventDefault(), close(e))} onClick={(e) => {
      // A button does its thing and the sheet closes, unless it leads to a next choice in the same sheet (`data-stay`).
      const b = (e.target as HTMLElement).closest('button');
      if (b && b.dataset.stay === undefined) onClose();
    }}>
      {touch ? (
        <div className="ctx sheet panel" role="menu">
          {head && <div className="sheet-head">{head}</div>}
          <div className="sheet-actions">{children}</div>
          <button className="btn ghost sheet-cancel" onClick={onClose}>Cancel</button>
        </div>
      ) : (
        <div ref={ref} className="ctx panel" role="menu" style={pos ?? { left: -9999, top: 0 }}>
          <div className="menu-list">
            {title && <div className="tiny muted ctx-title">{title}</div>}
            {children}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
