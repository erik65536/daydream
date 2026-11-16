/** The pack and what stands open beside it: a town's storage, a merchant's wares; and a chest or pile to pick from. */
import { useEffect, useRef } from 'react';
import { inventoryCapacity, inventoryUsed, nearStation, playerLevel, rx, sellPrice, storageKey, wieldBlock, withinHandReach, type ItemInstance, type RosterEntry } from '@daydream/shared';
import { client, useGame, type Panel } from '../net/game';
import { ActionSheet, ItemTooltip, Tabs, Window, centered, docked, hideTip, pressable, tip } from './common';
import { ItemCell, PartyTabs, Stacks, useItemMenu } from './items';
import { isTouch } from '../input/pointer';

function useItem(charId: string, item: ItemInstance) {
  const c = client();
  const use = rx(c.r).item.get(item.baseId)?.use;
  if (!use) return;
  if (use.targeting === 'self' || use.tool === 'recall') c.send({ t: 'use_item', charId, itemId: item.id, targetId: charId });
  else c.update({ targeting: { charId, itemId: item.id }, panel: null });
}

/**
 * What stands open beside the pack, if anything: a merchant's wares (a click on an item of yours sells it) or your
 * storage (a click stores it). The pack then opens as the other half of the pair (`pack-beside`, controls.css).
 */
const counterOf = (s: { trade: unknown; panel: Panel }): 'trade' | 'storage' | null => (s.trade ? 'trade' : s.panel === 'storage' ? 'storage' : null);

/**
 * Who can be handed things now: the other players in the game here whose heroes stand within reach of ours (the
 * server's rule), out of a fight. `blocked` says why nobody can be, when someone else is in the game.
 */
function useHandTargets(): { to: RosterEntry; why?: string }[] {
  const { roster, entities, player, userId, combat, zone } = useGame((s) => ({ roster: s.roster, entities: s.entities, player: s.player, userId: s.userId, combat: s.combat, zone: s.zone?.id }));
  if (!player) return [];
  const at = (ids: string[]) => ids.flatMap((id) => {
    const e = entities.get(id);
    return e ? [client().entityPos(e)] : [];
  });
  const mine = at(player.party.map((h) => h.id));
  // Every friend in the game: those a hand's reach away can be given to; for the others, what it takes.
  return roster.filter((r) => r.userId !== userId && r.online && !r.away).map((to) => ({
    to,
    why: combat || to.fighting ? 'not during a fight'
      : to.zoneId !== zone ? 'they are elsewhere'
      : withinHandReach(mine, at(to.heroes.map((h) => h.id))) ? undefined
      : `walk over to ${to.name}`,
  }));
}

export function InventoryWindow({ onClose }: { onClose: () => void }) {
  const { player, trade, counter, world, combat, roster } = useGame((s) => ({ player: s.player, trade: s.trade, counter: counterOf(s), world: s.world, combat: s.combat, roster: s.roster }));
  const c = client();
  const { menu, set: setMenu, open: openMenu, close: closeMenu } = useItemMenu<{ item: ItemInstance; equipped?: string; giveTo?: RosterEntry }>();
  const hand = useHandTargets();
  const ch = c.selectedHero();
  if (!player || !world || !ch) return null;
  const r = world.ruleset;
  const ix = rx(r);
  const cat = (i: ItemInstance) => ix.item.get(i.baseId)?.category;
  const equippedFor = (item: ItemInstance) => {
    const slot = ix.item.get(item.baseId)?.slotId;
    return slot ? ch.equipment[slot] : undefined;
  };
  const sell = (item: ItemInstance, qty: number) => trade && c.send({ t: 'sell', npcId: trade.npcId, itemId: item.id, qty });
  const store = (item: ItemInstance) => c.send({ t: 'store_item', itemId: item.id, to: 'storage' });
  const primary = (item: ItemInstance) => {
    if (counter === 'trade') return sell(item, 1);
    if (counter === 'storage') return !item.bound && store(item);
    if (cat(item) === 'equipment') return c.send({ t: 'equip', charId: ch.id, itemId: item.id });
    useItem(ch.id, item);
  };
  const sellFor = (it: ItemInstance) => (trade ? sellPrice(r, it, playerLevel(player), trade.sellMult) : undefined);
  // A finger cannot hover to see what an item is: a tap opens its sheet. A mouse click does the main thing at once.
  const give = (item: ItemInstance, to: RosterEntry, qty: number) => c.send({ t: 'give_item', itemId: item.id, toUserId: to.userId, qty });
  // Story items are everyone's and only quests use them: they can be looked at, nothing more.
  const isStory = (it: ItemInstance) => player.pouch.some((i) => i.id === it.id);
  const press = (it: ItemInstance, e: React.MouseEvent, equipped?: string) => {
    if (isTouch()) return openMenu(e, { item: it, equipped });
    hideTip();
    if (isStory(it)) return;
    if (equipped) return !combat && c.send({ t: 'unequip', charId: ch.id, slot: equipped });
    primary(it);
  };
  const stats = c.charStats(ch);
  const cap = inventoryCapacity(r, player);
  const used = inventoryUsed(player);
  const w = stats.weapon;
  const kindName = (typeId: string) => ix.type.get(typeId)?.name ?? '';
  return (
    <Window title={counter ? 'Your pack' : 'Pack'} onClose={onClose} className={`inventory ${counter ? 'pack-beside' : ''}`} style={counter ? undefined : docked(660)}>
      <Tabs>
        <PartyTabs ch={ch} />
        <div className="spacer" />
        <div className="tab gold" style={{ cursor: 'default' }}>{player.gold} {r.terminology.currency}</div>
      </Tabs>
      <div className="panel-body row" style={{ alignItems: 'flex-start', gap: 18 }}>
        <div className="col inv-side" style={{ width: 280, flex: 'none' }}>
          <div className="equip">
            {r.slots.map((slot) => {
              const it = ch.equipment[slot.id];
              return (
                <div className="slotbox" key={slot.id}>
                  {it ? (
                    <ItemCell item={it} onClick={(e) => press(it, e, slot.id)} onContext={(e) => openMenu(e, { item: it, equipped: slot.id })} />
                  ) : (
                    <div className="item empty" role="img" aria-label={`${slot.name}: empty`} />
                  )}
                  <span>{slot.name}</span>
                </div>
              );
            })}
          </div>
          <div className="kv" style={{ marginTop: 8 }}>
            <span>Weapon</span><span className="v">{Math.round(w.min)}–{Math.round(w.max)} {kindName(w.typeId)}</span>
            {r.damageTypes.map((d) => (
              <span key={d.id} style={{ display: 'contents' }}><span>{d.mitigationName}</span><span className="v">{Math.round((stats.mitigation[d.id] ?? 0) * 100)}%</span></span>
            ))}
            <span>{r.health.name}</span><span className="v">{stats.maxHp}</span>
            {r.resolution.crit && <><span>Critical</span><span className="v">{Math.round(stats.crit * 100)}%</span></>}
          </div>
          <div className="hint key-hint">Click equipped items to remove them. Right-click any item for more.</div>
          <div className="hint touch-hint">Tap an item to see it and what you can do with it.</div>
        </div>
        <div className="grow col">
          <Stacks items={player.inventory} used={used} cap={cap} story={player.pouch}
            storyNote={roster.length > 1 ? 'Shared by everyone in this adventure: any quest can use them. They take no pack space.' : 'Kept for your quests. They take no pack space.'}
            room={<div>Pack space: {used} of {cap} stacks used.<div className="tsub">Story items take no space.{player.inventoryUpgrades < r.inventory.upgrades ? ' Merchants can enlarge your pack.' : ''}</div></div>}
            cell={(it) => isStory(it)
              ? <ItemCell key={it.id} item={it} onClick={(e) => press(it, e)} />
              : <ItemCell key={it.id} item={it} compare={equippedFor(it)} price={sellFor(it)} onClick={(e) => press(it, e)} onContext={(e) => openMenu(e, { item: it })} />} />
        </div>
      </div>
      {menu && (
        <ActionSheet at={menu} title={c.itemName(menu.item)} onClose={closeMenu}
          head={<ItemTooltip item={menu.item} r={r} uniques={{ uniqueItems: c.uniqueItems() }} price={sellFor(menu.item)} compare={menu.equipped ? undefined : equippedFor(menu.item)} />}>
          {menu.equipped ? (
            <button className="btn sm ghost" disabled={!!combat} onClick={() => c.send({ t: 'unequip', charId: ch.id, slot: menu.equipped! })}>Take off</button>
          ) : isStory(menu.item) ? null : menu.giveTo ? (
            // A stack: how many of it go.
            [...new Set([1, Math.ceil(menu.item.qty / 2), menu.item.qty])].map((n) => (
              <button key={n} className={`btn sm ${n === menu.item.qty ? 'primary' : 'ghost'}`} onClick={() => give(menu.item, menu.giveTo!, n)}>
                {n === menu.item.qty ? `Give all ${n}` : `Give ${n}`} to {menu.giveTo!.name}
              </button>
            ))
          ) : (
            <>
              {counter === 'trade' && <button className="btn sm primary" onClick={() => sell(menu.item, 1)}>Sell for {sellFor(menu.item)} {r.terminology.currency}</button>}
              {counter === 'trade' && menu.item.qty > 1 && <button className="btn sm ghost" onClick={() => sell(menu.item, menu.item.qty)}>Sell all {menu.item.qty}</button>}
              {counter === 'storage' && !menu.item.bound && <button className="btn sm primary" onClick={() => store(menu.item)}>Store</button>}
              {cat(menu.item) === 'equipment' && player.party.map((p) => (
                <button key={p.id} className={`btn sm ${!counter && p.id === ch.id ? 'primary' : 'ghost'}`} disabled={!!wieldBlock(r, p, ix.item.get(menu.item.baseId))} onClick={() => c.send({ t: 'equip', charId: p.id, itemId: menu.item.id })}>{player.party.length > 1 ? `Equip on ${p.name}` : 'Equip'}</button>
              ))}
              {ix.item.get(menu.item.baseId)?.use && player.party.map((p) => (
                <button key={p.id} className={`btn sm ${!counter && p.id === ch.id ? 'primary' : 'ghost'}`} onClick={() => useItem(p.id, menu.item)}>{player.party.length > 1 ? `${p.name} uses it` : 'Use'}</button>
              ))}
              {!menu.item.bound && !counter && hand.map(({ to, why }) => (
                why
                  ? <button key={to.userId} className="btn sm ghost" disabled data-stay {...tip(`To give ${to.name} this, ${why}.`)}>Give to {to.name}<span className="ctx-why">{why}</span></button>
                  : menu.item.qty > 1
                    ? <button key={to.userId} className="btn sm ghost" data-stay onClick={() => setMenu({ ...menu, giveTo: to })}>Give to {to.name}…</button>
                    : <button key={to.userId} className="btn sm ghost" onClick={() => give(menu.item, to, 1)}>Give to {to.name}</button>
              ))}
              {!menu.item.bound && <button className="btn sm ghost" onClick={() => c.send({ t: 'drop_item', itemId: menu.item.id })}>Drop</button>}
            </>
          )}
        </ActionSheet>
      )}
    </Window>
  );
}

// =================================================================================== storage

/**
 * The player's store at a town's storage, beside their pack: a click moves a whole stack across, either way. It
 * closes when the party walks away from the storage.
 */
export function StorageWindow({ onClose }: { onClose: () => void }) {
  const { player, world, zone } = useGame((s) => ({ player: s.player, world: s.world, zone: s.zone }));
  const c = client();
  const { menu, open: openMenu, close: closeMenu } = useItemMenu<{ item: ItemInstance }>();
  // It opens as the party arrives (the hero drawn a step behind where the server has it), so it closes only once the
  // party has stood at the storage and walked away.
  const here = !!zone && nearStation(zone.features, c.leaderEntity(), 'storage');
  const arrived = useRef(false);
  useEffect(() => {
    if (here) arrived.current = true;
    else if (arrived.current) onClose();
  }, [here]);
  if (!player || !world || !zone) return null;
  const r = world.ruleset;
  const items = player.storage?.[storageKey(r, zone.id)] ?? [];
  const cap = r.inventory.storageSlots;
  const town = r.terminology.town.toLowerCase();
  const take = (it: ItemInstance) => c.send({ t: 'store_item', itemId: it.id, to: 'bag' });
  const press = (it: ItemInstance, e: React.MouseEvent) => {
    if (isTouch()) return openMenu(e, { item: it });
    hideTip();
    take(it);
  };
  return (
    <Window title={zone.features.find((f) => f.kind === 'storage')?.name ?? 'Storage'} onClose={onClose} className="counter">
      <div className="panel-body col">
        <div className="small muted">{r.inventory.storage === 'shared' ? `The same store in every ${town}.` : `Each ${town} keeps only what was left there.`} It stays safe when you fall.</div>
        <Stacks items={items} used={items.length} cap={cap} room={<div>Storage: {items.length} of {cap} stacks used.</div>}
          cell={(it) => <ItemCell key={it.id} item={it} onClick={(e) => press(it, e)} onContext={(e) => openMenu(e, { item: it })} />} />
        <div className="hint key-hint">Click a stored item to take it, or one in your pack to store it.</div>
        <div className="hint touch-hint">Tap a stored item to take it, or one of yours to store it.</div>
      </div>
      {menu && (
        <ActionSheet at={menu} title={c.itemName(menu.item)} onClose={closeMenu} head={<ItemTooltip item={menu.item} r={r} uniques={{ uniqueItems: c.uniqueItems() }} />}>
          <button className="btn sm primary" onClick={() => take(menu.item)}>Take</button>
        </ActionSheet>
      )}
    </Window>
  );
}

// =================================================================================== trade

export function TradeWindow() {
  const { trade, player, world } = useGame((s) => ({ trade: s.trade, player: s.player, world: s.world }));
  const c = client();
  const { menu, open: openMenu, close: closeMenu } = useItemMenu<{ id: string }>();
  if (!trade || !player || !world) return null;
  const r = world.ruleset;
  const cur = r.terminology.currency;
  const ware = menu && trade.stock.find((it) => it.id === menu.id);
  const buy = (id: string, qty: number) => c.send({ t: 'buy', npcId: trade.npcId, itemId: id, qty });
  return (
    <Window title={`${trade.npcName}’s wares`} onClose={() => c.send({ t: 'end_trade' })} className="counter">
      <div className="panel-body col">
        <div className="row small">
          <span className="muted">They have {trade.npcGold} {cur}</span>
          <div className="spacer" />
          <span className="gold">You have {player.gold} {cur}</span>
        </div>
        <div className="items pack">
          {trade.stock.map((it) => (
            <ItemCell key={it.id} item={it} price={it.price} onClick={(e) => (isTouch() ? openMenu(e, { id: it.id }) : buy(it.id, e.shiftKey ? it.qty : 1))} onContext={(e) => openMenu(e, { id: it.id })} />
          ))}
        </div>
        {trade.bagUpgrade && (
          <div className="offer-row">
            <div className="grow">
              <div style={{ fontWeight: 600 }}>Larger pack</div>
              <div className="tiny muted">+{trade.bagUpgrade.slots} stacks (now {inventoryCapacity(r, player)})</div>
            </div>
            <button className="btn sm primary" disabled={player.gold < trade.bagUpgrade.cost} onClick={() => c.send({ t: 'buy_inventory_upgrade', npcId: trade.npcId })}>{trade.bagUpgrade.cost} {cur}</button>
          </div>
        )}
        <div className="hint key-hint">Click to buy (Shift-click for the whole stack). Click items in your pack to sell them.</div>
        <div className="hint touch-hint">Tap a ware to buy it, or one of yours to sell it.</div>
      </div>
      {menu && ware && (
        <ActionSheet at={menu} title={c.itemName(ware)} onClose={closeMenu} head={<ItemTooltip item={ware} r={r} uniques={{ uniqueItems: c.uniqueItems() }} price={ware.price} />}>
          <button className="btn sm primary" disabled={player.gold < ware.price} onClick={() => buy(ware.id, 1)}>Buy for {ware.price} {cur}</button>
          {ware.qty > 1 && <button className="btn sm ghost" disabled={player.gold < ware.price * ware.qty} onClick={() => buy(ware.id, ware.qty)}>Buy all {ware.qty} for {ware.price * ware.qty} {cur}</button>}
        </ActionSheet>
      )}
    </Window>
  );
}

// =================================================================================== loot

export function LootWindow() {
  const { loot, world } = useGame((s) => ({ loot: s.loot, world: s.world }));
  const c = client();
  const close = () => c.send({ t: 'close_loot' });
  // Like storage, it closes once the party has stood at the chest or pile and walked away (a step past the server's reach).
  const at = useGame((s) => (loot ? s.zone?.features.find((f) => f.id === loot.id) ?? s.lootPiles.find((l) => l.id === loot.id) : undefined));
  const leader = c.leaderEntity();
  const here = !!at && !!leader && Math.hypot(at.x - leader.x, at.y - leader.y) <= 4;
  const arrived = useRef(false);
  useEffect(() => void (arrived.current = false), [loot?.id]);
  useEffect(() => {
    if (here) arrived.current = true;
    else if (arrived.current && loot) close();
  }, [here]);
  if (!loot || !world) return null;
  return (
    <Window title={loot.label} onClose={close} style={centered(330, '30%')}>
      <div className="panel-body col">
        {loot.gold > 0 && (
          <div className="row loot-row" {...pressable(() => c.send({ t: 'take_loot', sourceId: loot.id, itemId: 'gold' }))}>
            <span className="gold" style={{ fontSize: 16 }}>◉</span> {loot.gold} {world.ruleset.terminology.currency}
          </div>
        )}
        {loot.items.map((it) => (
          <div key={it.id} className="row loot-row" {...pressable(() => c.send({ t: 'take_loot', sourceId: loot.id, itemId: it.id }))}>
            <ItemCell item={it} />
            <div className="grow small" style={{ color: it.uniqueId ? '#ffd24a' : rx(world.ruleset).rarity.get(it.rarityId)?.color }}>{c.itemName(it)}{it.qty > 1 ? ` ×${it.qty}` : ''}</div>
          </div>
        ))}
        {!loot.items.length && !loot.gold && <div className="muted small">Empty.</div>}
        <div className="row">
          <div className="spacer" />
          <button className="btn primary" autoFocus onClick={() => c.send({ t: 'take_loot', sourceId: loot.id, all: true })}>Take all</button>
        </div>
      </div>
    </Window>
  );
}
