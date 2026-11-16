import { useState } from 'react';
import { listing } from '@daydream/shared';
import { api, type Me, type WorldSummary } from '../api';
import { Bubble, Floater, MoonScreen, NewWorldBubble } from '../ui/night';
import { ago, capital } from '../ui/format';
import { usePoll } from '../ui/poll';
import { navigate } from '../App';

/** The worlds: the sky above the clouds, each world a bubble drifting in it. */
export function Lobby({ me }: { me: Me }) {
  const [worlds, setWorlds] = useState<WorldSummary[] | null>(null);
  // Why the player was sent here (their adventure's world was deleted).
  const why = new URLSearchParams(location.hash.split('?')[1] ?? '').get('why');
  const { error } = usePoll(async (alive) => {
    const ws = await api.worlds();
    if (alive()) setWorlds(ws);
  }, 4000, []);
  const mine = worlds?.filter((w) => w.ownerId === me.id) ?? [];
  const others = worlds?.filter((w) => w.ownerId !== me.id) ?? [];
  // The adventure you were in last, whoever's world it is.
  const resume = worlds?.filter((w) => w.played?.last && w.status === 'ready').sort((a, b) => b.played!.last!.updatedAt - a.played!.last!.updatedAt)[0];
  const last = resume?.played?.last;
  // Into the game, or to making heroes first in an adventure the player was given a place in.
  const carryOn = () => last && !last.incompatible && navigate(last.players.some((p) => p.userId === me.id) ? `#/play/${last.id}` : `#/adventure/${last.id}/heroes`);
  return (
    <MoonScreen scene="sky" me={me}>
      <main className="m-lobby">
        <div className="m-heading">
          <div className="m-emblem" />
          <h1>Worlds</h1>
          <div className="m-rule"><i /></div>
          <p>Each world is dreamed once, with its places, people, and secrets. Then it can be lived in any number of adventures.</p>
        </div>
        {why && <div className="m-panel pad m-error" style={{ maxWidth: 640, margin: '0 auto 22px', textAlign: 'center' }}>{why}</div>}
        {error && <div className="m-error" style={{ textAlign: 'center' }}>{error}</div>}
        {!worlds && !error && <div className="m-spinner" />}
        {resume && last && (
          <section className="m-resume">
            <div className="m-float" data-depth="10">
              <div className="m-bob" style={{ '--dur': '8s' } as React.CSSProperties}>
                <Bubble art={resume.coverArt && { worldId: resume.id, ...resume.coverArt }} tint={resume.palette.secondary} label={`Continue ${last.name}`} onClick={carryOn} />
              </div>
            </div>
            <div className="m-panel">
              <div className="m-eyebrow">Continue your adventure</div>
              <h2>{resume.title}</h2>
              <div className="who">Day {last.day} · {listing(last.players.map((p) => p.name))} · level {Math.max(1, ...last.players.map((p) => p.level))}</div>
              <div className="note">{last.where ? `Last seen in ${last.where}, ${ago(last.updatedAt)}.` : `Played ${ago(last.updatedAt)}.`}</div>
              <div className="btns">
                <button className="m-lantern" disabled={!!last.incompatible} title={last.incompatible} onClick={carryOn}>Continue</button>
                <button className="m-quiet" onClick={() => navigate(`#/world/${resume.id}`)}>All adventures</button>
              </div>
            </div>
          </section>
        )}
        {worlds && (
          <>
            <div className="m-section"><h2>Your worlds</h2></div>
            <div className="m-sky-grid">
              <Floater i={0} caption={<div className="m-caption" onClick={() => navigate('#/create')}><div className="cta">Dream up a new world</div><div className="meta">Describe a theme</div></div>}>
                <NewWorldBubble label="Dream up a new world" onClick={() => navigate('#/create')} />
              </Floater>
              {mine.map((w, i) => <WorldFloat key={w.id} w={w} i={i + 1} />)}
            </div>
          </>
        )}
        {others.length > 0 && (
          <>
            <div className="m-section"><h2>Worlds by other players</h2></div>
            <div className="m-sky-grid">{others.map((w, i) => <WorldFloat key={w.id} w={w} i={i + mine.length + 1} />)}</div>
          </>
        )}
      </main>
      <div className="m-clouds-front" data-depth="30" />
    </MoonScreen>
  );
}

function WorldFloat({ w, i }: { w: WorldSummary; i: number }) {
  const open = () => navigate(`#/world/${w.id}`);
  const dreaming = w.status === 'generating';
  const count = w.played?.count ?? 0;
  return (
    <Floater
      i={i}
      caption={
        <div className="m-caption" onClick={open}>
          <h3>{w.title}</h3>
          <div className="meta">{capital(w.input.size)} · {capital(w.input.length)} story</div>
          {dreaming && <div className="meta mine">Being dreamed · {Math.round((w.job?.progress ?? 0) * 100)}%</div>}
          {w.status === 'failed' && <div className="meta m-bad">Dreaming stopped</div>}
          {w.status === 'ready' && !w.rules && <div className="meta m-bad">Needs rules</div>}
          {w.status === 'ready' && count > 0 && <div className="meta mine">{count} adventure{count === 1 ? '' : 's'}</div>}
        </div>
      }
    >
      {/* A world being dreamed shows how far along it is, and nothing of itself until it is ready. */}
      <Bubble art={!dreaming && w.coverArt ? { worldId: w.id, ...w.coverArt } : undefined} tint={w.palette.secondary} progress={dreaming ? w.job?.progress ?? 0 : undefined} label={w.title} onClick={open} />
    </Floater>
  );
}
