import { useEffect, useState } from 'react';
import { MAX_OWN_HEROES, listing } from '@daydream/shared';
import { api, assetUrl, type AdventureDetail, type HeroCard, type Me, type PlayerEntry } from '../api';
import { MoonScreen, Sigil } from '../ui/night';
import { navigate } from '../App';
import { ago } from '../ui/format';
import { usePoll } from '../ui/poll';
import { ask, tell } from '../ui/ask';

/**
 * An adventure's page, outside the game (docs/multiplayer.md): your heroes, which of them come along, who plays, and
 * (for the one who began it) who may join. Heroes are made and chosen here; the game checks the room at joining.
 */
export function AdventurePage({ me, adventureId }: { me: Me; adventureId: string }) {
  const [a, setA] = useState<AdventureDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const why = new URLSearchParams(location.hash.split('?')[1] ?? '').get('why');

  const { error, setError, refresh } = usePoll(async (alive) => {
    const now = await api.adventure(adventureId);
    if (alive()) setA(now);
  }, 5000, [adventureId]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const back = { label: 'The world', to: a ? `#/world/${a.worldId}` : '#/' };
  if (!a)
    return (
      <MoonScreen scene="clouds" me={me} back={back}>
        <main className="m-page">{error ? <div className="m-error" style={{ textAlign: 'center' }}>{error}</div> : <div className="m-spinner" />}</main>
      </MoonScreen>
    );

  const art = (h: { figure?: string }) => (h.figure ? assetUrl(a.worldId, h.figure) : undefined);
  const room = a.maxHeroes - a.inGame;
  const heroes = [...a.party, ...a.bench];
  const coming = (h: HeroCard) => a.party.some((x) => x.id === h.id);
  const setParty = (ids: string[]) => act(() => api.setParty(adventureId, ids));
  const toggle = (h: HeroCard) => setParty(coming(h) ? a.party.filter((x) => x.id !== h.id).map((x) => x.id) : [...a.party.map((x) => x.id), h.id]);
  const lead = (h: HeroCard) => setParty([h.id, ...a.party.filter((x) => x.id !== h.id).map((x) => x.id)]);
  const tooMany = a.party.length > room;
  const make = () => navigate(`#/adventure/${a.id}/heroes`);

  return (
    <MoonScreen scene="clouds" me={me} back={back}>
      <main className="m-page m-adventure">
        <div className="m-new-top m-pool">
          <div className="m-eyebrow">{a.isCreator ? 'Your adventure' : `${a.ownerName ?? 'Someone'}’s adventure`}</div>
          <h1 className="m-big" style={{ marginTop: 10 }}>{a.name}</h1>
          <p className="m-lede">Day {a.day} · {ago(a.updatedAt)}{a.online ? ` · ${a.online === 1 ? 'one player' : `${a.online} players`} in the game now` : ''}</p>
        </div>
        {why && <div className="m-panel pad m-error" style={{ marginBottom: 18 }}>{why}</div>}

        <div className="m-adv-cols">
          <section className="heroes">
            <div className="m-head-row">
              <h2>Your heroes</h2>
              <span className="spacer" />
              {heroes.length > 0 && <span className="m-fine">{a.party.length} coming along{a.bench.length ? ` · ${a.bench.length} staying behind` : ''}</span>}
            </div>
            <div className="m-hero-grid" aria-busy={busy}>
              {heroes.map((h) => {
                const on = coming(h);
                const leads = a.party[0]?.id === h.id;
                // Bringing one more must leave room in the game; the last one coming cannot stay behind.
                const blocked = on ? a.party.length === 1 : a.party.length >= Math.min(a.maxHeroes, Math.max(1, room));
                return (
                  <div key={h.id} className={`m-hero-card${on ? ' on' : ''}`}>
                    <button className="body" aria-pressed={on} disabled={busy || blocked} onClick={() => toggle(h)}
                      title={blocked ? (on ? 'At least one hero comes along.' : 'No more room in the game.') : on ? `Leave ${h.name} behind this time` : `Bring ${h.name} along`}>
                      <span className="figure">{art(h) ? <img src={art(h)} alt="" /> : <span className="initial">{h.name.slice(0, 1)}</span>}</span>
                      <b>{h.name}</b>
                      <span className="sub">{h.className ? `${h.className} · ` : ''}level {h.level}</span>
                      <span className="state">{on ? (leads ? 'Leads' : 'Coming along') : 'Stays behind'}</span>
                    </button>
                    {on && (
                      <button className={`corner lead${leads ? ' on' : ''}`} disabled={busy || leads} onClick={() => lead(h)} title={leads ? `${h.name} leads: you play as them` : `Lead with ${h.name}`} aria-label={leads ? `${h.name} leads` : `Lead with ${h.name}`}>
                        <Sigil name="star" className="" />
                      </button>
                    )}
                    {!on && (
                      <button className="corner drop" disabled={busy} onClick={() => void ask(`${h.name} leaves the adventure for good, with their gear.`, { title: `Let ${h.name} go?`, danger: true, yes: 'Let them go' }).then((ok) => void (ok && act(() => api.deleteHero(adventureId, h.id))))} title={`Let ${h.name} go for good`} aria-label={`Let ${h.name} go`}>
                        <Sigil name="cross" className="" />
                      </button>
                    )}
                  </div>
                );
              })}
              {heroes.length < MAX_OWN_HEROES && (
                <button className="m-hero-card add" disabled={busy} onClick={make}>
                  <span className="figure"><Sigil name="plus" className="" /></span>
                  <b>Make a hero</b>
                  <span className="sub">{heroes.length ? `Starts at level ${a.newHeroLevel}` : 'Your first, or a whole party'}</span>
                </button>
              )}
            </div>
            <p className="m-fine m-hero-help">
              {heroes.length
                ? `Click a hero to bring them along or leave them behind: a hero left behind keeps their level and gear until you bring them again. The star marks the one you play as. Up to ${a.maxHeroes} heroes play at once, everyone’s together.`
                : `Make one hero or a whole party: they join at ${a.newHeroLevel > 1 ? `level ${a.newHeroLevel}, where the others are` : 'the start'}, and any of them can fight on their own while you command the others.`}
            </p>
          </section>

          <div className="m-panel pad m-play">
            {heroes.length ? (
              <button className="m-lantern" disabled={busy || !a.party.length || tooMany || !!a.incompatible} onClick={() => navigate(`#/play/${a.id}`)}>Play</button>
            ) : (
              <button className="m-lantern" disabled={busy || !!a.incompatible} onClick={make}>Make your heroes first</button>
            )}
            {a.party.length > 0 && !tooMany && !a.incompatible && <p className="m-fine">With {listing(a.party.map((h) => h.name))}.</p>}
            {tooMany && <p className="m-fine bad">{room > 0 ? `Friends’ heroes fill the game: only ${room} more ${room === 1 ? 'fits' : 'fit'}. Leave some of yours behind.` : 'Friends’ heroes fill the game until someone leaves.'}</p>}
            {a.incompatible && <p className="m-fine bad">{a.incompatible}</p>}
            {error && <p className="m-error">{error}</p>}
          </div>
          <Players a={a} meId={me.id} busy={busy} act={act} art={art} />
        </div>
      </main>
    </MoonScreen>
  );
}

/**
 * Who plays: the one who began the adventure, then those given a place, each with their heroes and whether they are in
 * the game. The creator gives and takes places; the adventure's link opens this page for anyone with one.
 */
function Players({ a, meId, busy, act, art }: { a: AdventureDetail; meId: string; busy: boolean; act: (fn: () => Promise<unknown>) => void; art: (h: { figure?: string }) => string | undefined }) {
  const [players, setPlayers] = useState<PlayerEntry[] | null>(null);
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (a.canManage) api.players().then(setPlayers, () => setPlayers([]));
  }, [a.canManage]);
  const others = new Map(a.others.map((o) => [o.userId, o]));
  const rows = [{ userId: a.ownerId, name: a.ownerName ?? 'Its creator' }, ...a.members].map((m) => ({ ...m, you: m.userId === meId, creator: m.userId === a.ownerId, info: others.get(m.userId) }));
  const candidates = (players ?? []).filter((p) => !rows.some((r) => r.userId === p.id));
  const q = query.trim().toLowerCase();
  const matches = q ? candidates.filter((p) => p.name.toLowerCase().includes(q) || p.username?.toLowerCase().includes(q)).slice(0, 5) : [];
  const link = `${location.origin}${location.pathname}#/adventure/${a.id}`;
  // A page not served over https has no clipboard: the link is shown to copy by hand instead.
  const copy = () => (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }, () => void tell(link, 'This adventure’s link'));
  return (
    <div className="m-panel pad m-players">
      <h3>Players</h3>
      <ul>
        {rows.map((m) => (
          <li key={m.userId}>
            <span className={`dot${m.info?.online ? ' on' : ''}`} title={m.info?.online ? 'In the game now' : 'Not in the game'} />
            <span className="who">
              <b>{m.name}{m.you && <em> · you</em>}</b>
              <small>{m.creator ? 'Began the adventure' : m.you ? '' : m.info?.heroes.length ? listing(m.info.heroes.map((h) => h.name)) : 'No heroes yet'}</small>
            </span>
            {m.info && m.info.heroes.length > 0 && (
              <span className="faces">{m.info.heroes.slice(0, 3).map((h) => <span key={h.id} className="m-ring" title={h.name}>{art(h) ? <img src={art(h)} alt="" /> : h.name[0]}</span>)}</span>
            )}
            {a.canManage && !m.creator && (
              <button className="m-icon-btn" title={`Take ${m.name}’s place away (their heroes stay saved)`} aria-label={`Remove ${m.name}`} disabled={busy}
                onClick={() => void ask('Their heroes stay saved, and you can give the place back later.', { title: `Take ${m.name}’s place away?`, danger: true, yes: 'Take the place away' }).then((ok) => void (ok && act(() => api.removeMember(a.id, m.userId))))}>
                <Sigil name="cross" className="" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {a.canManage && candidates.length > 0 && (
        <div className="m-invite">
          <input className="m-well" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Give a player a place…" aria-label="Find a player by name" />
          {matches.length > 0 && (
            <div className="m-matches">
              {matches.map((p) => (
                <button key={p.id} disabled={busy} onClick={() => act(() => api.addMember(a.id, p.id).then(() => setQuery('')))}>
                  <Sigil name="plus" className="" />{p.name}{p.username && p.username !== p.name ? <small>{p.username}</small> : null}
                </button>
              ))}
            </div>
          )}
          {q && !matches.length && <p className="m-fine">No player by that name.</p>}
        </div>
      )}
      <button className="m-quiet m-small m-copy" onClick={copy}>
        <Sigil name="link" className="" />{copied ? 'Link copied' : 'Copy this adventure’s link'}
      </button>
      <p className="m-fine">{a.isCreator ? 'The link opens this page for the players you give a place.' : `${a.ownerName ?? 'Its creator'} decides who may join.`}</p>
      {!a.isCreator && <button className="m-danger" disabled={busy} onClick={() => void ask('Your heroes stay saved in it, if you are given a place again.', { title: 'Leave this adventure?', danger: true, yes: 'Leave' }).then((ok) => void (ok && act(() => api.removeMember(a.id, meId).then(() => navigate(`#/world/${a.worldId}`)))))}>Leave this adventure</button>}
    </div>
  );
}
