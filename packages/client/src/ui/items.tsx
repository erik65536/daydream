/** Items as the windows show them: a cell with its card, a pack or store of stacks, and the menu of what to do with one. */
import { useEffect, useState } from 'react';
import { rx, wieldBlock, type CharacterState, type ItemInstance, type Ruleset } from '@daydream/shared';
import { client, useGame } from '../net/game';
import { ItemIcon, ItemTooltip, Tab, tip } from './common';

export const iconUrl = (baseId: string) => client().assetUrl(`icon_${baseId}`, 'icon');

export function rarityClass(r: Ruleset, item: ItemInstance): string {
  if (item.uniqueId) return 'r-unique';
  return `r-${Math.min(4, rx(r).rarityOrder.get(item.rarityId) ?? 0)}`;
}

export function ItemCell({ item, onClick, onContext, selected, price, compare }: { item: ItemInstance; onClick?: (e: React.MouseEvent) => void; onContext?: (e: React.MouseEvent) => void; selected?: boolean; price?: number; compare?: ItemInstance }) {
  const c = client();
  const r = c.r;
  const base = rx(r).item.get(item.baseId);
  const rarity = rx(r).rarity.get(item.rarityId);
  // A weapon the chosen hero cannot wield is dimmed; its card says why.
  const hero = useGame((_s, c) => c.selectedHero());
  const unwieldy = !!hero && !!wieldBlock(r, hero, base);
  return (
    <div
      className={`item ${rarityClass(r, item)} ${unwieldy ? 'unwieldy' : ''} ${base?.category === 'quest' || item.bound ? 'story' : ''} ${selected ? 'sel' : ''}`}
      style={!item.uniqueId && rarity ? ({ '--rc': rarity.color } as React.CSSProperties) : undefined}
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onContext?.(e);
      }}
      {...tip(<ItemTooltip item={item} r={r} uniques={{ uniqueItems: c.uniqueItems() }} price={price} compare={compare} />)}
    >
      <ItemIcon item={item} url={iconUrl(item.baseId)} />
      {item.qty > 1 && <span className="qty">{item.qty}</span>}
      {price !== undefined && <span className="price"><i />{price}</span>}
    </div>
  );
}

/** The party's heroes as tabs: the one a window shows, and a way to another. */
export function PartyTabs({ ch, mark }: { ch: CharacterState; mark?: (p: CharacterState) => boolean }) {
  const player = useGame((s) => s.player);
  const c = client();
  if (!player) return null;
  return (
    <>
      {player.party.map((p) => (
        <Tab key={p.id} on={p.id === ch.id} onPress={() => c.update({ selectedCharId: p.id })}>
          {p.name}
          {mark?.(p) ? <span className="dot" /> : null}
        </Tab>
      ))}
    </>
  );
}

/**
 * The menu of what can be done with one thing (ActionSheet): where it opened and for what. A right-click opens it, and
 * a finger's tap does, since a finger cannot hover to see what the thing is.
 */
export function useItemMenu<T>() {
  const [menu, set] = useState<({ x: number; y: number } & T) | null>(null);
  return { menu, set, open: (e: React.MouseEvent, what: T) => set({ x: e.clientX, y: e.clientY, ...what }), close: () => set(null) };
}

type Filter = 'all' | 'gear' | 'use' | 'mat' | 'story';
const FILTERS: Record<Exclude<Filter, 'story'>, string> = { all: 'All', gear: 'Gear', use: 'Usable', mat: 'Materials' };

function inFilter(r: Ruleset, f: Filter, i: ItemInstance): boolean {
  const k = rx(r).item.get(i.baseId)?.category;
  if (!k) return false;
  if (f === 'gear') return k === 'equipment';
  if (f === 'use') return k === 'potion' || k === 'tool';
  if (f === 'mat') return k === 'material' || k === 'valuable';
  return true;
}

/** How many columns a grid lays out (it follows the window's size), with a ref for the grid. */
function useGridColumns(): [React.RefCallback<HTMLElement>, number] {
  const [cols, setCols] = useState(1);
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!el) return;
    const read = () => setCols(Math.max(1, getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length));
    const watch = new ResizeObserver(read);
    watch.observe(el);
    read();
    return () => watch.disconnect();
  }, [el]);
  return [setEl, cols];
}

/** Empty cells after `used` filled ones: at least `least` cells in all, and whole rows. */
const freeCells = (used: number, least: number, cols: number) => Math.ceil(Math.max(used, least) / cols) * cols - used;

/**
 * Stacks of items and how full they are: a pack or a store. The cells are drawn as a bag, the free ones shown empty
 * (a few rows' worth, not every one); `room` explains the count. A pack also has its `story` items, kept apart (they
 * take no room) under their own chip, with `storyNote` saying whose they are.
 */
export function Stacks({ items, used, cap, room, cell, story, storyNote }: { items: ItemInstance[]; used: number; cap: number; room: React.ReactNode; cell: (it: ItemInstance) => React.ReactNode; story?: ItemInstance[]; storyNote?: string }) {
  const r = client().r;
  const [filter, setFilter] = useState<Filter>('all');
  const [gridRef, cols] = useGridColumns();
  const shown = filter === 'story' ? story ?? [] : items.filter((i) => inFilter(r, filter, i));
  return (
    <>
      <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
        {(Object.keys(FILTERS) as (keyof typeof FILTERS)[]).map((f) => (
          <button key={f} type="button" className={`chip ${filter === f ? 'on' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>{FILTERS[f]}</button>
        ))}
        {story && (
          <button type="button" className={`chip ${filter === 'story' ? 'on' : ''}`} aria-pressed={filter === 'story'} onClick={() => setFilter('story')}>
            Story{story.length > 0 && <span className="count">{story.length}</span>}
          </button>
        )}
        <div className="spacer" />
        <span className={`tiny ${used >= cap ? 'bad' : 'muted'}`} {...tip(room)}>{used}/{cap}</span>
      </div>
      <div className="capbar"><div style={{ width: `${Math.min(100, (used / Math.max(1, cap)) * 100)}%` }} className={used >= cap ? 'full' : ''} /></div>
      {filter === 'story' && <div className="small muted">{storyNote}</div>}
      <div className="items pack" ref={gridRef}>
        {shown.map(cell)}
        {filter === 'all' && Array.from({ length: freeCells(shown.length, Math.min(cap, 24), cols) }, (_, i) => <div key={`e${i}`} className="item empty" aria-hidden />)}
        {filter !== 'all' && !shown.length && <div className="muted small">{filter === 'story' ? 'Nothing yet.' : 'Nothing here.'}</div>}
      </div>
    </>
  );
}
