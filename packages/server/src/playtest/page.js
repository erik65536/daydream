// The playtest harness's helper inside the game page (window.__pt), injected by the driver. Plain JavaScript run in
// the browser: it reads the game client (window.__gd) and renderer (window.__gdView), and never changes the game
// except through the client's own messages.
//
// - Short names for what the player can see (n1 a person, m1 a creature, h1 a hero, f1 a thing in the place, l1 a
//   pile of loot), kept for as long as the page lives, so an agent can say "talk n3".
// - What happened since the agent last looked (toasts, log lines, chat, story text, the server's refusals).
// - `settle`: wait until the game is quiet after an action (walking done, the person has answered, the turn came).
// - `marks`: numbered labels over things in the place or over the interface's buttons, for a screenshot.
(() => {
  if (window.__pt) return;
  const refs = new Map(); // game id -> short name
  const ids = new Map(); // short name -> game id
  const counters = {};
  let events = [];
  let hooked = null;
  let marked = [];
  let inFight = false;

  const client = () => window.__gd ?? null;
  const view = () => window.__gdView ?? null;

  function refOf(id, prefix) {
    let r = refs.get(id);
    if (!r) {
      counters[prefix] = (counters[prefix] ?? 0) + 1;
      r = `${prefix}${counters[prefix]}`;
      refs.set(id, r);
      ids.set(r, id);
    }
    return r;
  }

  /** The game's events, gathered from the client (a new client after a reconnect or a reload is hooked again). */
  function hook() {
    const c = client();
    if (!c || hooked === c) return;
    hooked = c;
    c.onServer((m) => {
      const at = Date.now();
      switch (m.t) {
        case 'toast': events.push({ at, kind: 'toast', text: m.text }); break;
        case 'log': events.push({ at, kind: 'log', text: m.text }); break;
        case 'chat': events.push({ at, kind: 'chat', from: m.from, text: m.text, mine: m.userId === c.state.userId }); break;
        // Story text that is still being written comes again, longer: only the finished text is news.
        case 'narration': if (!m.pending) events.push({ at, kind: 'story', title: m.title, text: m.text }); break;
        case 'combat': {
          const mine = !!m.combat;
          if (mine && !inFight) events.push({ at, kind: 'fight', text: 'A fight began.' });
          if (!mine && inFight) events.push({ at, kind: 'fight', text: 'The fight is over.' });
          inFight = mine;
          break;
        }
        case 'journal': events.push({ at, kind: 'journal', text: m.entry.text }); break;
        case 'error': events.push({ at, kind: 'refused', text: m.message }); break;
        case 'zone': events.push({ at, kind: 'place', text: m.zone.name }); break;
        case 'fx':
          for (const f of m.events) {
            const name = (id) => (id ? (refs.get(id) ? `${c.state.entities.get(id)?.name ?? id} (${refs.get(id)})` : (c.state.entities.get(id)?.name ?? id)) : 'something');
            if (f.kind === 'skill' && f.skillId) events.push({ at, kind: 'skill', text: `${name(f.sourceId)} used ${c.skillName(f.skillId)}${f.targetId && f.targetId !== f.sourceId ? ` on ${name(f.targetId)}` : ''}` });
            else if (f.kind === 'damage' && f.damage) {
              const d = f.damage;
              const type = c.state.world?.ruleset.damageTypes.find((t) => t.id === d.type)?.name ?? d.type;
              // Health is kept in fractions; numbers are shown whole, as the game's own floating numbers are.
              const amount = d.amount > 0 ? Math.max(1, Math.round(d.amount)) : Math.round(d.amount);
              events.push({ at, kind: d.type === 'heal' ? 'heal' : 'hit', text: d.miss ? `${name(d.targetId)}: missed` : `${name(d.targetId)} ${d.type === 'heal' ? 'healed' : 'took'} ${amount}${d.type === 'heal' ? '' : ` ${type}`}${d.crit ? ' (critical)' : ''}${d.fatal ? ', down' : ''}` });
            } else if (f.kind === 'levelup') events.push({ at, kind: 'level', text: `${name(f.targetId ?? f.sourceId)} reached a new level` });
          }
          break;
      }
    });
  }
  setInterval(hook, 200);

  const round1 = (v) => Math.round(v * 10) / 10;
  const compass = (dx, dy) => {
    if (Math.hypot(dx, dy) < 0.5) return 'here';
    const dirs = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
    return dirs[((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8];
  };

  function itemLine(c, it) {
    return { id: it.id, name: c.itemName(it), qty: it.qty > 1 ? it.qty : undefined, level: it.level };
  }

  /** Everything the player can see and needs to decide, in the fewest words. */
  function snapshot() {
    hook();
    const c = client();
    // The client lives on after the game screen is left: only the play page is the game.
    if (!c || !location.hash.startsWith('#/play/')) return { screen: location.hash || '#/', inGame: false };
    const s = c.state;
    const me = s.player;
    // Where "you" are: in a fight the hero acting now (whose reach matters), else the leader.
    const actingId = s.combat ? c.myActor() : undefined;
    const lead = (actingId && s.entities.get(actingId)) || c.leaderEntity();
    const lp = lead ? c.entityPos(lead) : me ? { x: me.x, y: me.y } : { x: 0, y: 0 };
    const where = (x, y) => ({ x: round1(x), y: round1(y), dist: round1(Math.hypot(x - lp.x, y - lp.y)), dir: compass(x - lp.x, y - lp.y) });
    const ruleset = s.world?.ruleset;
    const className = (id) => ruleset?.classes?.find((k) => k.id === id)?.name ?? id;

    const things = [];
    for (const e of s.entities.values()) {
      if (e.dead && e.kind !== 'monster') continue;
      const p = c.entityPos(e);
      if (!c.seen(p.x, p.y)) continue;
      const mine = e.kind === 'character' && e.ownerUserId === s.userId;
      const prefix = e.kind === 'npc' ? 'n' : e.kind === 'monster' ? 'm' : 'h';
      things.push({
        ref: refOf(e.id, prefix), id: e.id, kind: e.kind === 'character' ? (mine ? 'my hero' : 'friend') : e.kind === 'npc' ? 'person' : 'creature',
        name: e.name, title: e.title || undefined, level: e.level, hp: `${e.hp}/${e.maxHp}`,
        hostile: e.hostile || undefined, dead: e.dead || undefined, downed: e.downed || undefined, boss: (!!e.bossId && !e.named) || undefined, named: e.named || undefined,
        marker: me?.npcMarkers?.[e.id] || undefined, statuses: e.statuses.length ? e.statuses.map((st) => `${ruleset?.statuses?.find((d) => d.id === st.id)?.name ?? st.id} ${st.turns}t`).join(', ') : undefined,
        moving: p.moving || undefined, bark: e.bark && e.bark.until > c.serverNow() ? e.bark.text : undefined,
        ...where(p.x, p.y),
      });
    }
    for (const f of s.zone?.features ?? []) {
      if (f.hidden) continue;
      if (!c.seen(f.x, f.y) && f.kind !== 'exit') continue;
      const st = s.features.get(f.id) ?? {};
      const to = f.kind === 'exit' && f.targetZoneId ? (s.world?.zones?.find?.((z) => z.id === f.targetZoneId)?.name ?? f.targetZoneId) : undefined;
      const state = [st.opened && 'opened', st.empty && 'empty', st.unlocked && 'unlocked', st.toggled && 'used'].filter(Boolean).join(', ');
      things.push({ ref: refOf(f.id, 'f'), id: f.id, kind: f.kind === 'craft_station' ? 'crafting station' : f.kind, name: f.name || undefined, leadsTo: to, state: state || undefined, quest: c.questThingOpen?.(f.id) || undefined, ...where(f.x, f.y) });
    }
    for (const l of s.lootPiles) {
      if (!c.seen(l.x, l.y)) continue;
      things.push({ ref: refOf(l.id, 'l'), id: l.id, kind: 'loot', name: c.lootSummary(l).text, ...where(l.x, l.y) });
    }
    things.sort((a, b) => a.dist - b.dist);

    const party = (me?.party ?? []).map((ch) => {
      const e = s.entities.get(ch.id);
      const stats = c.charStats(ch);
      return {
        ref: refOf(ch.id, 'h'), id: ch.id, name: ch.name, class: className(ch.classId), level: ch.level, hp: `${e?.hp ?? ch.hp}/${e?.maxHp ?? stats.maxHp}`,
        leader: ch.id === me.leaderId || undefined, ai: ch.ai || undefined, downed: ch.downed || undefined, points: ch.treePoints || undefined,
        hotbar: ch.hotbar.map((id, i) => (id ? `${i + 1}:${id}${ch.cooldowns?.[id] ? ` (cooldown ${ch.cooldowns[id]})` : ''}` : null)).filter(Boolean),
      };
    });

    const quests = me
      ? Object.values(me.quests ?? {})
          .filter((q) => q.status === 'active')
          .map((q) => {
            const def = me.questDefs[q.questId];
            // What the tracker shows: for each way the step can be done, its next objective (any one way does it).
            const ways = c.questNext(q.questId);
            return { id: q.questId, title: def?.title ?? q.questId, main: def?.main || undefined, next: ways.map((o) => o.description).join(' OR ') || undefined };
          })
      : [];

    let combat;
    if (s.combat || s.watched.length) {
      const cb = s.combat ?? s.watched[0];
      const entry = (id) => cb.order.find((o) => o.id === id);
      const ref = (o) => refOf(o.id, o.team === 'players' ? 'h' : 'm');
      // Heroes whose turns come one after another act together: the player's own among them, the one commands act
      // with first (the selected one), and everyone else acting.
      const mine = c.myActors().map(entry).filter(Boolean).sort((a, b) => (b.id === actingId) - (a.id === actingId));
      const others = cb.actingIds.filter((id) => !c.myActors().includes(id)).map(entry).filter(Boolean);
      combat = {
        round: cb.round,
        yourTurn: mine.length > 0,
        mine: mine.map((o) => ({ ref: ref(o), name: o.name, ap: `${o.ap}/${o.maxAp}`, moveLeft: round1(o.movementLeft) || undefined })),
        others: others.map((o) => `${o.name} (${ref(o)})`),
        inIt: !!s.combat,
        order: cb.order.map((o) => `${ref(o)}${cb.actingIds.includes(o.id) ? '*' : ''}`).join(' '),
      };
    }

    const d = s.dialog;
    const dialog = d && !d.ended
      ? { with: `${d.npcName}${d.npcTitle ? `, ${d.npcTitle}` : ''}`, thinking: d.thinking || undefined, canTrade: d.canTrade || undefined, said: d.messages.slice(-6).map((m) => `${m.speaker === 'player' ? (m.name ?? 'You') : m.speaker === 'npc' ? d.npcName : 'Narrator'}: ${m.text}`), suggestions: d.suggestions?.length ? d.suggestions : undefined }
      : undefined;
    const trade = s.trade ? { with: s.trade.npcName, theirGold: s.trade.npcGold, stock: s.trade.stock.map((it) => ({ ...itemLine(c, it), price: it.price })) } : undefined;
    const loot = s.loot ? { label: s.loot.label, gold: s.loot.gold, items: s.loot.items.map((it) => itemLine(c, it)) } : undefined;

    const zone = s.zone;
    const clock = s.clock ? `day ${s.clock.day}, ${String(s.clock.hour).padStart(2, '0')}:${String(Math.floor(s.clock.minute % 60)).padStart(2, '0')}` : undefined;
    return {
      screen: location.hash,
      inGame: true,
      connection: s.status,
      error: s.error,
      place: zone ? `${zone.name} (${zone.kind}, ${round1(zone.width)} by ${round1(zone.height)} m)` : undefined,
      at: { x: round1(lp.x), y: round1(lp.y) },
      clock,
      gold: me?.gold,
      currency: ruleset?.terminology?.currency ?? 'gold',
      bag: me ? me.inventory.map((it) => itemLine(c, it)) : undefined,
      party,
      players: s.roster.filter((r) => r.userId !== s.userId).map((r) => `${r.name}${r.online ? '' : ' (offline)'}${r.zoneId !== me?.zoneId ? ` in ${s.world?.zones?.find?.((z) => z.id === r.zoneId)?.name ?? r.zoneId}` : ''}${r.fighting ? ', fighting' : ''}`),
      quests,
      combat,
      dialog,
      trade,
      loot,
      panel: s.panel || undefined,
      narration: s.narrations[0] ? { title: s.narrations[0].title, text: s.narrations[0].text } : undefined,
      things,
    };
  }

  /** What happened since the last call. */
  function takeEvents() {
    hook();
    const out = events;
    events = [];
    return out;
  }

  /** A short name, a game id, or a name as the player sees it, to the game id (nearest first). */
  function resolve(what) {
    if (ids.has(what)) return ids.get(what);
    const c = client();
    if (!c) return null;
    const s = c.state;
    if (s.entities.has(what) || s.features.has(what) || s.lootPiles.some((l) => l.id === what) || s.zone?.features.some((f) => f.id === what)) return what;
    const want = String(what).toLowerCase();
    const snap = snapshot();
    const hit = snap.things.find((t) => t.name?.toLowerCase() === want) ?? snap.things.find((t) => t.name?.toLowerCase().includes(want) || t.title?.toLowerCase().includes(want) || t.leadsTo?.toLowerCase().includes(want));
    return hit?.id ?? null;
  }

  /** Where a game id is now, in ground metres. */
  function positionOf(id) {
    const c = client();
    const e = c?.state.entities.get(id);
    if (e) return c.entityPos(e);
    const f = c?.state.zone?.features.find((x) => x.id === id);
    if (f) return { x: f.x, y: f.y };
    const l = c?.state.lootPiles.find((x) => x.id === id);
    return l ? { x: l.x, y: l.y } : null;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Wait until the game is quiet: the party has stopped walking, nobody is thinking of an answer, no blow is still on
   * its way (Health shows as it will be), and the place has loaded, all for `quiet` ms. Other people moving about do
   * not count. Stops early when a fight reaches the player's turn or story text shows, and after `timeout` ms in any
   * case. Says why it stopped.
   */
  async function settle({ timeout = 20000, quiet = 600, minimum = 300 } = {}) {
    const start = Date.now();
    let quietSince = Date.now();
    await sleep(minimum);
    for (;;) {
      const c = client();
      const s = c?.state;
      if (s && s.status === 'connected' && s.zone) {
        const walking = [...s.entities.values()].some((e) => e.kind === 'character' && e.ownerUserId === s.userId && c.entityPos(e).moving);
        const busy = walking || s.dialog?.thinking || c.blowsLanding();
        if (busy) quietSince = Date.now();
        const still = !busy && Date.now() - quietSince > quiet;
        if (s.narrations.length && Date.now() - start > minimum) return 'story text is showing';
        // In a fight, the others' turns pass until it is the player's turn again (or the fight ends).
        if (s.combat ? still && c.isMyTurn() : still) return s.combat ? 'your turn in the fight' : 'quiet';
      } else quietSince = Date.now();
      if (Date.now() - start > timeout) return s?.combat && !c.isMyTurn() ? 'the others are still acting in the fight ("wait" for them)' : 'still busy after the time limit';
      await sleep(100);
    }
  }

  /** Whether a line of the open conversation is the player's own, beginning like `words` (spaces aside). */
  const oneLine = (t) => t.trim().replace(/\s+/g, ' ');
  const saysIt = (m, words) => m.speaker === 'player' && m.userId === client()?.state.userId && oneLine(m.text).startsWith(oneLine(words).slice(0, 40));

  /** How many lines the player has said in the open conversation that begin like `words`. */
  function saidCount(words) {
    return (client()?.state.dialog?.messages ?? []).filter((m) => saysIt(m, words)).length;
  }

  /**
   * After the player said `words` (`before` such lines were in the conversation then): wait until the line is in the
   * conversation and an answer to it is written, or the conversation ends. The person may first finish what they were
   * saying. Says why it stopped.
   */
  async function answered({ words, before, timeout = 45000 }) {
    const start = Date.now();
    for (;;) {
      const c = client();
      const d = c?.state.dialog;
      if (!d || d.ended) return 'the conversation ended';
      if (saidCount(words) > before) {
        const mine = d.messages.findLastIndex((m) => saysIt(m, words));
        if (!d.thinking && d.messages.slice(mine + 1).some((m) => m.speaker !== 'player' && !m.pending)) return 'answered';
      }
      if (Date.now() - start > timeout) return 'no answer yet';
      await sleep(150);
    }
  }

  // ------------------------------------------------------------------------------ labels for screenshots

  function clearMarks() {
    document.getElementById('__pt_marks')?.remove();
    marked = [];
  }

  function layer() {
    clearMarks();
    const root = document.createElement('div');
    root.id = '__pt_marks';
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;font:700 12px/1 system-ui,sans-serif';
    document.body.appendChild(root);
    return root;
  }

  function label(root, x, y, text, color) {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = `position:absolute;left:${x}px;top:${y}px;transform:translate(-50%,-100%);padding:2px 4px;border-radius:3px;background:${color};color:#fff;border:1px solid #000;white-space:nowrap`;
    root.appendChild(el);
  }

  /** Short names over everything listed in the snapshot that is on screen. */
  function markWorld() {
    const v = view();
    const canvas = document.querySelector('canvas');
    if (!v || !canvas) return [];
    const root = layer();
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width / (v.W || rect.width);
    const sy = rect.height / (v.H || rect.height);
    const colors = { n: '#a46b00', m: '#b3261e', h: '#1e6fb3', f: '#5b3fa0', l: '#2d7a2d' };
    for (const t of snapshot().things) {
      const p = positionOf(t.id);
      if (!p) continue;
      const s = v.groundToScreen(p.x, p.y);
      const x = rect.left + s.x * sx;
      const y = rect.top + s.y * sy;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      label(root, x, y - 4, t.ref, colors[t.ref[0]] ?? '#333');
      marked.push(t.ref);
    }
    return marked;
  }

  /** Numbers over the interface's clickable things on screen, and what each is; how many more are scrolled away. */
  function markUi() {
    const root = layer();
    const seen = [];
    let away = 0;
    const sel = 'button, a[href], input, textarea, select, [role=button], [role=tab], [role=menuitem], [tabindex]:not([tabindex="-1"])';
    // Also what React made clickable without a button: the outermost element showing the pointer cursor.
    const pointer = (el) => el && el instanceof Element && getComputedStyle(el).cursor === 'pointer';
    const els = [...document.body.querySelectorAll('*')].filter((el) => el.closest('#__pt_marks') === null && !el.closest('canvas') && (el.matches(sel) || (pointer(el) && !pointer(el.parentElement))) && !el.parentElement?.closest(sel));
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      // Only what can be clicked where it is now: anything whose middle is off the screen is scrolled away.
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) {
        away++;
        continue;
      }
      const top = document.elementFromPoint(cx, cy);
      if (top && top !== el && !el.contains(top) && !top.contains(el)) continue; // covered by something else
      const n = seen.length + 1;
      const text = (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.value || el.placeholder || el.tagName.toLowerCase()).replace(/\s+/g, ' ').trim().slice(0, 60);
      seen.push({ n, x: Math.round(cx), y: Math.round(cy), text, tag: el.tagName.toLowerCase(), disabled: el.disabled || undefined });
      label(root, r.left + 2, r.top + 14, String(n), '#0b57d0');
    }
    marked = seen;
    return { items: seen, away };
  }

  window.__pt = { snapshot, takeEvents, resolve, positionOf, settle, saidCount, answered, markWorld, markUi, clearMarks, refOf, ids };
})();
