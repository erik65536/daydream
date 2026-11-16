/** The crafting window: the crafts to learn, the recipes, and the forge where gear is improved and enchanted. */
import { useState } from 'react';
import {
  CRAFT_RANKS, RECIPE_GROUPS, brewBatch, craftBases, craftPointsLeft, craftRank, craftRankLine, craftedLevel, craftedRarity, enchantCost, enchantSlots, fieldRecipe, itemLines, itemMod, modifierLabel,
  nearStation, playerLevel, recipeGold, recipeGroup, rx, upgradeBlock, upgradeCost, upgradeStep, upgradedLevel,
  type CharacterState, type CraftDef, type CraftId, type ItemInstance, type RecipeGroup,
} from '@daydream/shared';
import { client, useGame } from '../net/game';
import { ItemIcon, ItemTooltip, Tab, Tabs, Window, docked, tip } from './common';
import { ItemCell, iconUrl, rarityClass } from './items';
import { ROMAN } from './talents';

/** One line of an item before and after it grows, its unchanged words said once: "12–20 → 15–24 Thump damage". */
function grows(was: string, now: string) {
  const a = was.split(' '), b = now.split(' ');
  let same = 0;
  while (same < Math.min(a.length, b.length) - 1 && a[a.length - 1 - same] === b[b.length - 1 - same]) same++;
  const rest = a.slice(a.length - same).join(' ');
  return <><span className="muted">{a.slice(0, a.length - same).join(' ')}</span> → <b>{b.slice(0, b.length - same).join(' ')}</b>{rest ? ` ${rest}` : ''}</>;
}

/** Each craft's mark: a hammer for making gear, a flask for brewing, a whetstone for improving, a star for enchanting. */
const CRAFT_GLYPH: Record<CraftId, string> = {
  craft: 'M14 6l4 4-9 9-4-4zM16 4l4 4M4 20l2-2',
  brew: 'M10 3h4M10.5 3v5.2L5.6 17a2.2 2.2 0 0 0 1.9 3.3h9a2.2 2.2 0 0 0 1.9-3.3L13.5 8.2V3M7.8 14h8.4',
  upgrade: 'M12 20V5M6.5 10.5 12 5l5.5 5.5M5 20h14',
  enchant: 'M12 3c.7 4.3 2.2 5.8 6.5 6.5-4.3.7-5.8 2.2-6.5 6.5-.7-4.3-2.2-5.8-6.5-6.5 4.3-.7 5.8-2.2 6.5-6.5zM18.5 15.5c.3 1.6.9 2.2 2.5 2.5-1.6.3-2.2.9-2.5 2.5-.3-1.6-.9-2.2-2.5-2.5 1.6-.3 2.2-.9 2.5-2.5z',
};

/**
 * One craft: its mark, name, and rank, then its ranks on a spine that fills as they are learned, each saying what it
 * does. The next rank is the button (click, tap or A); the ranks after it wait their turn.
 */
function CraftTrack({ craft, rank, pointsLeft }: { craft: CraftDef; rank: number; pointsLeft: number }) {
  const c = client();
  const r = c.r;
  const learn = () => {
    if (!pointsLeft || rank >= CRAFT_RANKS) return;
    c.send({ t: 'learn_craft', craft: craft.id });
  };
  return (
    <div className={`craft ${rank ? 'has' : ''} ${rank >= CRAFT_RANKS ? 'maxed' : ''}`}>
      <div className="craft-head">
        <span className="craft-mark">
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden><path d={CRAFT_GLYPH[craft.id]} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" /></svg>
          {rank > 0 && <span key={rank} className="tn-flash" aria-hidden />}
        </span>
        <div className="craft-title">
          <span className="display">{craft.name}</span>
          <span className="craft-rank">{rank >= CRAFT_RANKS ? 'Mastered' : rank ? `Rank ${rank} of ${CRAFT_RANKS}` : 'Not learned'}</span>
        </div>
      </div>
      <div className="craft-desc">{craft.description}</div>
      <ol className="craft-ranks">
        {Array.from({ length: CRAFT_RANKS }, (_, i) => {
          const state = i < rank ? 'on' : i === rank ? (pointsLeft ? 'next avail' : 'next') : 'later';
          const line = craftRankLine(r, craft.id, i + 1);
          const mark = <span className="cr-mark"><span>{ROMAN[i]}</span>{i === rank - 1 && <span key={rank} className="tn-flash" aria-hidden />}</span>;
          if (i !== rank || !pointsLeft) return <li key={i} className={state}>{mark}<span className="cr-line">{line}</span></li>;
          return (
            <li key={i} className={state}>
              <button className="cr-step" onClick={learn} aria-label={`${rank ? 'Raise' : 'Learn'} ${craft.name}: ${line}`}>
                {mark}
                <span className="cr-line">{line}</span>
                <span className="cr-go">{rank ? 'Raise' : 'Learn'}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function CraftWindow({ onClose }: { onClose: () => void }) {
  const { player, world, zone } = useGame((s) => ({ player: s.player, world: s.world, zone: s.zone }));
  const c = client();
  const r = world?.ruleset;
  const leader = c.leaderEntity();
  const atBench = !!zone && nearStation(zone.features, leader);
  const benchName = zone?.features.find((f) => f.kind === 'craft_station')?.name ?? 'workbench';
  const tabs = r ? ([r.crafts.length ? 'crafts' : null, r.recipes.length ? 'recipes' : null, r.crafting.upgrades.enabled ? 'upgrade' : null, r.crafting.enchanting.enabled ? 'enchant' : null].filter(Boolean) as ('crafts' | 'recipes' | 'upgrade' | 'enchant')[]) : [];
  const [tab, setTab] = useState<'crafts' | 'recipes' | 'upgrade' | 'enchant'>(tabs[0] ?? 'recipes');
  const [itemId, setItemId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'ready' | RecipeGroup>('all');
  /** The piece of gear chosen for each gear recipe. */
  const [kinds, setKinds] = useState<Record<string, string>>({});
  const ch = c.selectedHero();
  if (!player || !world || !r || !ch) return null;
  const ix = rx(r);
  const cur = r.terminology.currency;
  const have = (baseId: string) => player.inventory.filter((i) => i.baseId === baseId).reduce((s, i) => s + i.qty, 0);
  const lvl = playerLevel(player);
  // Equipment you can work on: what the party wears, then the pack.
  const gear: { item: ItemInstance; owner?: CharacterState }[] = [
    ...player.party.flatMap((p) => Object.values(p.equipment).filter((x): x is ItemInstance => !!x).map((item) => ({ item, owner: p }))),
    ...player.inventory.filter((i) => ix.item.get(i.baseId)?.category === 'equipment').map((item) => ({ item })),
  ];
  const chosen = gear.find((g) => g.item.id === itemId) ?? gear[0];
  type Cost = { gold: number; material?: { id: string; name: string }; qty: number };
  /** What a piece of work costs, as pills: the material with what you have of it, then the money. */
  const costRow = (cost: Cost) => (
    <div className="rc-needs">
      {cost.material && <Need ok={have(cost.material.id) >= cost.qty} baseId={cost.material.id} name={cost.material.name} count={`${have(cost.material.id)}/${cost.qty}`} />}
      {cost.gold > 0 && <Need ok={player.gold >= cost.gold} name={cur} count={String(cost.gold)} />}
    </div>
  );
  /** Why a piece of work cannot be done now, or null when it can. */
  const why = (cost: Cost) =>
    !atBench ? `Only at a ${benchName.toLowerCase()}.`
    : player.gold < cost.gold ? `Needs ${cost.gold - player.gold} more ${cur}.`
    : cost.material && have(cost.material.id) < cost.qty ? `Needs ${cost.qty - have(cost.material.id)} more ${cost.material.name}.`
    : null;
  const pointsLeft = craftPointsLeft(r, player);
  const craftOf = (id: CraftId) => r.crafts.find((x) => x.id === id);
  /** What a tab needs learned first, if it is not. */
  const needs = (id: CraftId) => (craftRank(player, id) > 0 ? null : <div className="forge-block">Learn {craftOf(id)?.name ?? id} on the Crafts tab to use this.</div>);
  // Every recipe, with whether it can be made now; the filter shows one group, or only what can be made.
  const recipes = r.recipes.map((rc) => {
    const field = fieldRecipe(r, rc);
    const gold = recipeGold(r, rc, lvl);
    const ok = craftRank(player, 'itemId' in rc.output ? 'brew' : 'craft') > 0 && rc.inputs.every((i) => have(i.itemId) >= i.qty) && player.gold >= gold && (field || atBench);
    return { rc, field, ok, gold, group: recipeGroup(r, rc) };
  });
  const groups = RECIPE_GROUPS.filter((g) => recipes.some((x) => x.group === g.id));
  const readyCount = recipes.filter((x) => x.ok).length;
  const benchBanner = (
    <div className={`bench ${atBench ? 'at' : ''}`} {...tip(<div className="small" style={{ maxWidth: 260 }}>Gear, improving, and enchanting need a {benchName.toLowerCase()}; every {r.terminology.town.toLowerCase()} has one. Remedies and tools can be made anywhere.</div>)}>
      <span className="dot" />
      {atBench ? `At the ${benchName.toLowerCase()}: everything can be made here` : 'Away from a workbench: remedies and tools only'}
    </div>
  );
  return (
    <Window title="Crafting" onClose={onClose} className="craftwin" style={docked(680)}>
      {tabs.length > 1 && (
        <Tabs>
          {tabs.map((tb) => (
            <Tab key={tb} on={tab === tb} onPress={() => setTab(tb)}>{{ crafts: 'Crafts', recipes: 'Recipes', upgrade: 'Improve', enchant: 'Enchant' }[tb]}{tb === 'crafts' && pointsLeft > 0 ? <span className="pts"> +{pointsLeft}</span> : null}</Tab>
          ))}
          <div className="spacer" />
          <div className="tab gold purse" style={{ cursor: 'default' }}>{player.gold} {cur}</div>
        </Tabs>
      )}
      {tab === 'crafts' && (
        <div className="panel-body crafts-body">
          <div className="crafts-intro">
            <span className="small muted">Shared by all your heroes. Points come with levels.</span>
            <span className={`points-left ${pointsLeft ? 'has' : ''}`}><b>{pointsLeft}</b> point{pointsLeft === 1 ? '' : 's'} to spend</span>
          </div>
          <div className="crafts">
            {r.crafts.map((cr) => <CraftTrack key={cr.id} craft={cr} rank={craftRank(player, cr.id)} pointsLeft={pointsLeft} />)}
          </div>
        </div>
      )}
      {tab === 'recipes' && (
        <div className="panel-body recipes-body">
          <div className="rc-filters">
            <button type="button" className={`chip ${filter === 'all' ? 'on' : ''}`} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All</button>
            <button type="button" className={`chip ${filter === 'ready' ? 'on' : ''}`} aria-pressed={filter === 'ready'} onClick={() => setFilter('ready')}>Can make<b className="chip-n">{readyCount}</b></button>
            {groups.length > 1 && groups.map((g) => <button type="button" key={g.id} className={`chip ${filter === g.id ? 'on' : ''}`} aria-pressed={filter === g.id} onClick={() => setFilter(g.id)}>{g.name}</button>)}
          </div>
          {benchBanner}
          {/* Grouped by what they make; in each group what can be made now comes first. */}
          {groups.map((grp) => ({ grp, rows: recipes.filter((x) => x.group === grp.id && (filter === 'all' || (filter === 'ready' ? x.ok : filter === grp.id))).sort((a, b) => Number(b.ok) - Number(a.ok)) })).filter((g) => g.rows.length).map(({ grp, rows }) => (
            <section key={grp.id} className="rc-group">
              <div className="rc-group-head"><span>{grp.name}</span><i /></div>
              <div className="recipes">
                {rows.map(({ rc, field, ok, gold }) => {
                  const out = rc.output;
                  const outBase = 'itemId' in out ? ix.item.get(out.itemId) : undefined;
                  const rank = craftRank(player, outBase ? 'brew' : 'craft');
                  const rar = ix.rarity.get('rarityId' in out ? craftedRarity(r, Math.max(1, rank)) : r.rarities[0]!.id);
                  // Gear: the player chooses which piece; it starts as the kind the hero already wears there.
                  const bases = 'slotKind' in out ? craftBases(r, out.slotKind) : [];
                  const worn = Object.values(ch.equipment).find((it) => it && bases.some((b) => b.id === it.baseId))?.baseId;
                  const pick = bases.find((b) => b.id === kinds[rc.id]) ?? bases.find((b) => b.id === worn) ?? bases[0];
                  const made = 'qty' in out ? out.qty * brewBatch(rank) : 1;
                  const gearLevel = craftedLevel(r, lvl);
                  const shown = outBase ?? pick;
                  const outName = shown?.name ?? 'Gear';
                  const iconBase = shown?.id ?? 'quest_item';
                  // The card of what it makes, as it will be (gear at the quality the rank makes, its bonuses rolled when it is made).
                  const card = shown && (
                    <ItemTooltip item={{ id: rc.id, baseId: shown.id, level: gearLevel, rarityId: outBase ? r.rarities[0]!.id : (rar?.id ?? r.rarities[0]!.id), affixes: [], qty: made }} r={r} uniques={{ uniqueItems: c.uniqueItems() }} />
                  );
                  return (
                    <div key={rc.id} className={`recipe ${ok ? 'ok' : 'na'}`} {...tip(card)}>
                      <span className="rc-icon" style={{ '--rc': rar?.color } as React.CSSProperties}>
                        <ItemIcon item={{ baseId: iconBase, rarityId: rar?.id }} url={shown ? iconUrl(shown.id) : undefined} size={38} />
                        {made > 1 && <span className="qty">×{made}</span>}
                      </span>
                      <div className="rc-text">
                        <div className="rc-name">
                          <span style={!outBase ? { color: rar?.color } : undefined}>{outName}</span>
                          {!outBase && <span className="rc-lv">{r.terminology.level} {gearLevel}</span>}
                          {!rank ? <span className="rc-where">Needs {craftOf(outBase ? 'brew' : 'craft')?.name}</span> : !field && !atBench && <span className="rc-where">Workbench</span>}
                        </div>
                        <div className="rc-needs">
                          {rc.inputs.map((i) => <Need key={i.itemId} ok={have(i.itemId) >= i.qty} baseId={i.itemId} name={ix.item.get(i.itemId)?.name ?? i.itemId} count={`${have(i.itemId)}/${i.qty}`} />)}
                          {gold > 0 && <Need ok={player.gold >= gold} name={cur} count={String(gold)} />}
                        </div>
                        {bases.length > 1 && (
                          <div className="rc-kinds" role="radiogroup" aria-label="What to make">
                            {bases.map((b) => (
                              <button key={b.id} role="radio" aria-checked={b.id === pick?.id} className={`rc-kind ${b.id === pick?.id ? 'on' : ''}`} onClick={() => setKinds({ ...kinds, [rc.id]: b.id })} {...tip(<ItemTooltip item={{ id: b.id, baseId: b.id, level: gearLevel, rarityId: rar?.id ?? r.rarities[0]!.id, affixes: [], qty: 1 }} r={r} uniques={{ uniqueItems: c.uniqueItems() }} />)}>
                                <ItemIcon item={{ baseId: b.id, rarityId: rar?.id }} url={iconUrl(b.id)} size={26} />
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <button className="btn sm primary" disabled={!ok} onClick={() => c.send({ t: 'craft', recipeId: rc.id, baseId: pick?.id })}>Craft</button>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
          {filter === 'ready' && !readyCount && <div className="forge-block">Nothing can be made right now{atBench ? '' : ' away from a workbench'}.</div>}
          <div className="hint">Materials drop from foes and chests, and can be bought from merchants.</div>
        </div>
      )}
      {(tab === 'upgrade' || tab === 'enchant') && (
        <div className="panel-body forge">
          <div className="forge-gear">
            {/* What each hero wears, then the pack. */}
            {[...player.party.map((p) => ({ key: p.id, label: p.name, items: gear.filter((g) => g.owner?.id === p.id) })), { key: 'pack', label: 'In your pack', items: gear.filter((g) => !g.owner) }].filter((g) => g.items.length).map((g) => (
              <div key={g.key} className="forge-set">
                <div className="label">{g.label}</div>
                <div className="items">
                  {g.items.map((x) => <ItemCell key={x.item.id} item={x.item} selected={chosen?.item.id === x.item.id} onClick={() => setItemId(x.item.id)} />)}
                </div>
              </div>
            ))}
            {!gear.length && <div className="muted small">No equipment.</div>}
          </div>
          {chosen && (
            <div className="forge-work">
              {benchBanner}
              <div className="forge-item">
                <span className={`item ${rarityClass(r, chosen.item)}`} style={!chosen.item.uniqueId ? ({ '--rc': ix.rarity.get(chosen.item.rarityId)?.color } as React.CSSProperties) : undefined}>
                  <ItemIcon item={chosen.item} size={48} url={iconUrl(chosen.item.baseId)} />
                </span>
                <div className="forge-name">
                  <span className="display" style={{ color: chosen.item.uniqueId ? '#ffd24a' : ix.rarity.get(chosen.item.rarityId)?.color }}>{c.itemName(chosen.item)}</span>
                  <span className="forge-sub">{ix.rarity.get(chosen.item.rarityId)?.name} · {r.terminology.level} {chosen.item.level} · {chosen.owner ? `Worn by ${chosen.owner.name}` : 'In your pack'}</span>
                </div>
              </div>
              {tab === 'upgrade' && (needs('upgrade') ?? (() => {
                const rank = craftRank(player, 'upgrade');
                const item = chosen.item;
                const cost = upgradeCost(r, item, rank, lvl);
                const word = r.terminology.level.toLowerCase();
                // What changes: the item's lines now and at the level an improvement takes it to, where they differ.
                const to = upgradedLevel(r, item, rank, lvl);
                const now = itemLines(r, item);
                const next = itemLines(r, { ...item, level: to });
                const no = cost && why(cost);
                return (
                  <>
                    <div className="forge-help">Improving raises an item’s {word}{upgradeStep(rank) > 1 ? ` by up to ${upgradeStep(rank)} at once` : ' by one'}: everything on it grows, as if it had been found there. It goes up to your own {word}.</div>
                    {cost ? (
                      <div className="forge-card">
                        <div className="lv-change"><span className="lv">{r.terminology.level} {item.level}</span><span className="lv-arrow" aria-hidden>→</span><span className="lv up">{r.terminology.level} {to}</span></div>
                        <div className="improve-diff">
                          {now.map((l, i) => (l !== next[i] && next[i] ? <div key={i}>{grows(l, next[i])}</div> : null))}
                        </div>
                        <div className="forge-act">
                          {costRow(cost)}
                          <button className="btn primary" disabled={!!no} onClick={() => c.send({ t: 'upgrade_item', itemId: item.id, charId: chosen.owner?.id })}>Improve</button>
                        </div>
                        {no && <div className="forge-why">{no}</div>}
                      </div>
                    ) : (
                      <div className="forge-block">{upgradeBlock(r, item, rank, lvl, craftOf('upgrade')?.name)}</div>
                    )}
                  </>
                );
              })())}
              {tab === 'enchant' && (needs('enchant') ?? (() => {
                const cost = enchantCost(r, chosen.item, craftRank(player, 'enchant'));
                if (!cost) return <div className="forge-block">{chosen.item.uniqueId ? 'Unique items cannot be enchanted.' : 'This cannot be enchanted.'}</div>;
                const maxAff = enchantSlots(r, ix.item.get(chosen.item.baseId), chosen.item.rarityId);
                const no = why(cost);
                return (
                  <>
                    <div className="forge-help">Replace one bonus with a new random one{chosen.item.affixes.length < maxAff ? ', or add a new bonus' : ''}. Each try costs the same.</div>
                    <div className="forge-card">
                      <div className="bonuses">
                        {chosen.item.affixes.map((a, i) => {
                          const def = ix.affix.get(a.affixId);
                          return (
                            <div key={i} className="bonus">
                              <span className="bonus-mark" aria-hidden />
                              <span className="grow">{def ? modifierLabel(r, itemMod(r, { stat: def.stat, value: a.value }, chosen.item.level), chosen.item.level) : a.affixId}</span>
                              <button className="btn sm" disabled={!!no} onClick={() => c.send({ t: 'enchant_item', itemId: chosen.item.id, affixIndex: i, charId: chosen.owner?.id })}>Reroll</button>
                            </div>
                          );
                        })}
                        {Array.from({ length: Math.max(0, maxAff - chosen.item.affixes.length) }, (_, i) => (
                          <div key={`e${i}`} className="bonus empty">
                            <span className="bonus-mark" aria-hidden />
                            <span className="grow">Empty bonus</span>
                            {i === 0 && <button className="btn sm primary" disabled={!!no} onClick={() => c.send({ t: 'enchant_item', itemId: chosen.item.id, affixIndex: -1, charId: chosen.owner?.id })}>Add</button>}
                          </div>
                        ))}
                      </div>
                      <div className="forge-act">{costRow(cost)}</div>
                      {no && <div className="forge-why">{no}</div>}
                    </div>
                  </>
                );
              })())}
            </div>
          )}
        </div>
      )}
      {!tabs.length && <div className="panel-body muted">There is no crafting in this world.</div>}
    </Window>
  );
}

/** One thing a piece of work takes, as a pill: its icon, its name, and what you have against what it takes. */
function Need({ ok, baseId, name, count }: { ok: boolean; baseId?: string; name: string; count: string }) {
  return (
    <span className={`need ${ok ? 'ok' : ''}`}>
      {baseId ? <ItemIcon item={{ baseId }} url={iconUrl(baseId)} size={16} /> : <i className="coin" aria-hidden />}
      {name} <b>{count}</b>
    </span>
  );
}
