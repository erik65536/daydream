import { useEffect, useRef, useState } from 'react';
import { TRASH_DAYS, listing, type AdventureSummary, type Ruleset } from '@daydream/shared';
import { api, assetUrl, jobActive, type JobStatus, type Me, type WorldSummary } from '../api';
import { CodexView } from '../ui/codex';
import { usePanelSound } from '../ui/common';
import { setRules } from '../rules';
import { MoonScreen, Bubble, Sigil, Toggle } from '../ui/night';
import { Dreaming } from './Dreaming';
import { ago, capital } from '../ui/format';
import { usePoll } from '../ui/poll';
import { navigate } from '../App';
import { ask, askText, tell } from '../ui/ask';
import { sounds } from '../sounds';
import { updateSettings, useSettings } from '../settings';

export function WorldPage({ me, worldId }: { me: Me; worldId: string }) {
  const [w, setW] = useState<WorldSummary | null>(null);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [adventures, setAdventures] = useState<AdventureSummary[]>([]);
  const [ruleset, setRuleset] = useState<Ruleset | null>(null);
  const [codex, setCodex] = useState(false);
  usePanelSound(codex && !!ruleset);
  // Whether this player plays the world with its animations: kept with their settings, on every device.
  const animations = !useSettings().animationsOff.includes(worldId);
  const setAnimations = (on: boolean) => updateSettings((s) => ({ ...s, animationsOff: on ? s.animationsOff.filter((id) => id !== worldId) : [...s.animationsOff, worldId] }));
  // A world seen being dreamed stays on that view when it finishes, so its ending can be watched.
  const [watched, setWatched] = useState(false);
  const since = useRef(0);
  const rulesAt = useRef<number | undefined>(undefined);

  // Asked often while something is being made for the world or its dreaming is watched, now and then otherwise.
  const busy = !w || w.status === 'generating' || jobActive(w.job?.status) || watched;
  const { error, setError, refresh } = usePoll(async (alive) => {
    const ws = await api.world(worldId);
    if (!alive()) return;
    setW(ws);
    if (ws.status === 'generating' || jobActive(ws.job?.status)) {
      const j = await api.job(worldId, since.current);
      if (!alive()) return;
      setJob(j);
      if (j.kind === 'world' && jobActive(j.status)) setWatched(true);
      // Only the log's newest lines are asked for (the page shows counts, not the log).
      if (j.log.length) since.current = j.log[j.log.length - 1]!.t;
    } else {
      setJob((j) => (j && j.kind === 'world' ? { ...j, status: 'done', progress: 1 } : null));
    }
    if (ws.status === 'ready') {
      const mine = await api.adventures(worldId);
      if (!alive()) return;
      setAdventures(mine);
      // Reload the ruleset only when it changed (first load, or after a rules job).
      const at = ws.rules?.balance?.at ?? (ws.rules ? 0 : -1);
      if (rulesAt.current !== at) {
        rulesAt.current = at;
        const rr = await api.rules(worldId);
        if (!alive()) return;
        setRuleset(rr.ruleset);
        setRules(rr.ruleset);
      }
    }
  }, busy ? 1200 : 10_000, [worldId]);

  // The world's theme on its page; the game's own while it is being built (the world's takes over when it is ready).
  useEffect(() => {
    if (w) sounds.pageMusic(w.status === 'ready' ? { id: w.id, theme: w.theme } : undefined);
  }, [w?.id, w?.status, !!w?.theme]);

  // Escape closes the codex.
  useEffect(() => {
    if (!codex) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setCodex(false);
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [codex]);

  if (!w)
    return (
      <MoonScreen scene="clouds" me={me} back={{ label: 'Worlds', to: '#/' }}>
        <main className="m-page">{error ? <div className="m-error" style={{ textAlign: 'center' }}>{error}</div> : <div className="m-spinner" />}</main>
      </MoonScreen>
    );
  const active = jobActive(job?.status);
  // The owner, or an administrator looking after someone else's world (the server allows both).
  const canManage = w.ownerId === me.id || me.isAdmin;
  if ((active && job?.kind === 'world') || (watched && w.status !== 'failed'))
    return <Dreaming me={me} w={w} job={job} canManage={canManage} ready={w.status === 'ready' && !active} onSeen={() => setWatched(false)} extra={me.isAdmin && <div style={{ textAlign: 'center' }}><DeleteWorld worldId={w.id} /></div>} />;
  return (
    <MoonScreen scene="clouds" me={me} back={{ label: 'Worlds', to: '#/' }}>
      <main className="m-page" style={{ '--c1': w.palette.primary } as React.CSSProperties}>
        <section className="m-world-hero">
          <div className="m-float" data-depth="10">
            <div className="m-bob" style={{ '--dur': '8s' } as React.CSSProperties}>
              <Bubble art={w.coverArt && { worldId: w.id, ...w.coverArt }} tint={w.palette.secondary} label={w.title} />
            </div>
          </div>
          <div className="m-pool">
            <div className="m-eyebrow">A world by {w.ownerId === me.id ? 'you' : w.ownerName}</div>
            <h1 className="m-big">{w.title}</h1>
            <div className="m-tags">
              <span className="m-tag">{capital(w.input.size)} world</span>
              <span className="m-tag">{capital(w.input.length)} story</span>
              {w.rules && <span className="m-tag"><i />{w.rules.name}</span>}
            </div>
            <p className="m-lede">{w.pitch}</p>
            {w.status === 'ready' && (
              <div className="btns">
                <button className="m-lantern" disabled={!ruleset} title={ruleset ? undefined : 'This world needs rules first.'} onClick={() => navigate(`#/world/${w.id}/new`)}>Begin a new adventure</button>
                {ruleset && <button className="m-quiet" onClick={() => setCodex(true)}>Read the codex</button>}
              </div>
            )}
            {w.status === 'ready' && (w.animated || !!w.animation?.waiting || (canManage && !!w.animation?.failed)) && (
              <div className="m-panel m-motion">
                {w.animated && <Toggle label="Character animations" hint="Walk, attack, and hit animations for every character. Off, characters keep their original artwork." on={animations} onChange={setAnimations} />}
                <AnimationProgress a={w.animation} canManage={canManage} />
              </div>
            )}
          </div>
        </section>

        {w.status === 'failed' && (
          <div className="m-panel pad" style={{ marginBottom: 22 }}>
            <div className="m-error">Dreaming stopped{w.job?.error ? `: ${w.job.error}` : '.'}</div>
            <p className="m-fine" style={{ margin: '6px 0 12px' }}>Everything finished so far is kept{w.job?.status === 'failed' ? '. Resume once the model service is working again.' : ', and it carries on from there when resumed.'}</p>
            {canManage && <button className="m-lantern m-small" onClick={() => api.resumeWorld(w.id).then(refresh, (e) => setError((e as Error).message))}>Resume dreaming</button>}
            {me.isAdmin && <div style={{ marginTop: 12 }}><DeleteWorld worldId={w.id} /></div>}
          </div>
        )}
        {active && job && job.kind !== 'world' && <JobLine job={job} canStop={canManage} onStop={() => api.cancelJob(worldId).then(refresh, (e) => setError((e as Error).message))} />}
        {w.status === 'ready' && !active && w.job?.status === 'failed' && <div className="m-panel pad m-error" style={{ marginBottom: 22 }}>The last job failed{w.job.error ? `: ${w.job.error}` : ''}.</div>}
        {error && <div className="m-error" style={{ marginBottom: 12 }}>{error}</div>}

        {w.status === 'ready' && (
          <div className="m-world-cols">
            <div>
              <div className="m-head-row"><h2>Your adventures</h2></div>
              <div className="m-advs">
                {!adventures.length && <div className="m-panel m-empty">No adventures yet. Begin one to make your hero.</div>}
                {adventures.map((s) => {
                  const mine = s.ownerId === me.id;
                  const playing = s.players.some((p) => p.userId === me.id);
                  return (
                    <div key={s.id} className="m-panel m-adv">
                      <Rings worldId={w.id} heroes={s.heroes} />
                      <div>
                        <h3>
                          <a href={`#/adventure/${s.id}`} className="m-plain">{s.name}</a>
                          {s.copyOf && <span className="m-chip">copy</span>}
                          {!mine && <span className="m-chip">{s.ownerName ? `${s.ownerName}’s` : 'shared'}</span>}
                          {mine && s.members.length > 0 && <span className="m-chip">shared</span>}
                        </h3>
                        <div className="sub">
                          Day {s.day} · {listing(s.players.map((p) => p.name))} · level {Math.max(1, ...s.players.map((p) => p.level))} · {ruleset?.difficulty[s.difficulty]?.name ?? s.difficulty} · {ago(s.updatedAt)}
                          {s.online ? ` · ${s.online} online` : ''}
                        </div>
                        {s.incompatible && <div className="bad">{s.incompatible}</div>}
                      </div>
                      <div className="side">
                        <button className="m-lantern m-small" disabled={!!s.incompatible} onClick={() => navigate(playing ? `#/play/${s.id}` : `#/adventure/${s.id}/heroes`)}>{playing ? 'Continue' : 'Join'}</button>
                        <button className="m-icon-btn" title="Heroes and players" aria-label="Heroes and players" onClick={() => navigate(`#/adventure/${s.id}`)}>
                          <Sigil name="pencil" size={16} className="" />
                        </button>
                        {mine && (
                          <button className="m-icon-btn" title="Delete adventure" aria-label="Delete adventure" onClick={() => void ask(`${s.members.length ? 'Everyone you gave a place in it loses it too. ' : ''}This cannot be undone.`, { title: `Delete “${s.name}”?`, danger: true, yes: 'Delete' }).then((ok) => void (ok && api.deleteAdventure(s.id).then(() => setAdventures((x) => x.filter((y) => y.id !== s.id)), (e) => tell((e as Error).message))))}>
                            <Sigil name="cross" size={16} className="" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {me.isAdmin && <OthersAdventures worldId={w.id} me={me} />}
            </div>
            <div className="m-side-col">
              <RulesPanel ruleset={ruleset} />
              {canManage && w.artProgress.ok < w.artProgress.total && (
                <div className="m-panel pad">
                  <h3>Pictures</h3>
                  <div className="m-fine">{w.artProgress.ok} of {w.artProgress.total} pictures painted</div>
                  <div className="m-meter"><div style={{ width: `${(w.artProgress.ok / Math.max(1, w.artProgress.total)) * 100}%` }} /></div>
                  <div className="btns">
                    <button className="m-quiet m-small" disabled={active} title="Paints only what is missing or failed." onClick={() => api.regenArt(w.id, true).then(refresh, (e) => tell((e as Error).message))}>Paint what is missing</button>
                  </div>
                </div>
              )}
              {me.isAdmin && (
                <div className="m-panel pad">
                  <h3>World viewer</h3>
                  <p>Everything this world holds, secrets included: its build, rules, story, places, people, creatures, pictures, and sounds (administrator).</p>
                  <div className="btns">
                    <button className="m-lantern m-small" onClick={() => navigate(`#/world/${w.id}/view`)}>Open the viewer</button>
                  </div>
                </div>
              )}
              {me.isAdmin && <DeleteWorld worldId={w.id} />}
            </div>
          </div>
        )}
      </main>
      {codex && ruleset && (
        <div className="m-modal-wrap" onClick={() => setCodex(false)}>
          <div className="m-panel m-window" role="dialog" aria-label="Codex" onClick={(e) => e.stopPropagation()}>
            <div className="m-window-head">
              <h3>Codex <span>· {ruleset.name}</span></h3>
              <button className="m-icon-btn" aria-label="Close" onClick={() => setCodex(false)}><Sigil name="cross" className="" /></button>
            </div>
            <CodexView ruleset={ruleset} />
          </div>
        </div>
      )}
    </MoonScreen>
  );
}

/** An adventure's party as small portraits in moonlit rings (an initial where a hero has no picture yet). */
function Rings({ worldId, heroes }: { worldId: string; heroes: AdventureSummary['heroes'] }) {
  return (
    <div className="m-rings">
      {heroes.slice(0, 4).map((h, i) => (
        <div key={i} className="m-ring" title={h.name}>
          {h.figure ? <img src={assetUrl(worldId, h.figure)} alt="" /> : h.name.slice(0, 1)}
        </div>
      ))}
    </div>
  );
}

/**
 * How far the characters' animations have got, while they are being made (in the background, after the world is
 * ready); afterwards, for its owner, the characters that could not be animated.
 */
function AnimationProgress({ a, canManage }: { a?: WorldSummary['animation']; canManage: boolean }) {
  if (!a) return null;
  const total = a.done + a.waiting + a.failed;
  const text = a.waiting
    ? `Animations are being made: ${a.done} of ${total} characters so far.`
    : canManage && a.failed ? `${a.failed === 1 ? 'One character' : `${a.failed} characters`} could not be animated and ${a.failed === 1 ? 'keeps its' : 'keep their'} artwork.` : '';
  if (!text) return null;
  return (
    <div className="m-motion-progress">
      <span className="m-fine">{text}</span>
      {a.waiting > 0 && <div className="m-meter"><div style={{ width: `${(a.done / total) * 100}%` }} /></div>}
    </div>
  );
}

/** Another job running on a ready world (new rules, painting, animation): what it is doing, and a way to stop it. */
function JobLine({ job, canStop, onStop }: { job: JobStatus; canStop: boolean; onStop: () => void }) {
  return (
    <div className="m-panel pad" style={{ marginBottom: 22 }}>
      <div className="m-head-row" style={{ marginBottom: 8, alignItems: 'center' }}>
        <div className="m-spinner" style={{ width: 18, height: 18, margin: 0 }} />
        <div className="m-lede" style={{ fontSize: 18 }}>
          {job.status === 'queued' ? (job.queuePosition ? `Waiting its turn: ${job.queuePosition} ahead` : 'Starting soon') : job.status === 'waiting' ? 'Waiting for a model' : job.step || 'Working'}
        </div>
        <div className="spacer" />
        <span className="m-fine">{Math.round(job.progress * 100)}%</span>
        {canStop && <button className="m-quiet m-small" onClick={onStop}>Stop</button>}
      </div>
      <div className="m-meter"><div style={{ width: `${job.progress * 100}%` }} /></div>
    </div>
  );
}

const count = (n: number, one: string, many = `${one}s`) => `${n === 1 ? 'one' : n} ${n === 1 ? one : many}`;
const JOB_WORDS: Record<string, string> = { world: 'build', rules: 'new rules', art: 'painting', animate: 'animation' };

/**
 * Administrators only: delete this world for everyone, whoever owns it. The confirmation says what goes with it
 * (every player's adventures, people playing now, jobs still running) and needs the world's name typed.
 */
export function DeleteWorld({ worldId }: { worldId: string }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const p = await api.deletionPreview(worldId);
      const lines = [
        `${p.ownerName}’s world goes for everyone: its places, people, and art, and ${p.adventures ? `${count(p.adventures, 'adventure')} of ${count(p.players, 'player')}` : 'its adventures (it has none)'}.`,
        p.online ? `${p.online === 1 ? 'One player is' : `${p.online} players are`} in the game now; they are sent back to the worlds with a message.` : '',
        p.jobs.length ? `Its ${listing(p.jobs.map((j) => JOB_WORDS[j.kind] ?? j.kind))} ${p.jobs.length === 1 ? 'is' : 'are'} stopped first.` : '',
        `It waits in the trash for ${TRASH_DAYS} days, where an administrator can restore it from the Users page; after that, only a nightly backup has it.`,
        `Type the world’s name to confirm:
${p.title}`,
      ];
      const typed = await askText(lines.filter(Boolean).join('\n\n'), { title: `Delete “${p.title}”?`, danger: true, yes: 'Delete the world', input: { placeholder: p.title } });
      if (typed === null) return;
      if (typed.trim().toLowerCase() !== p.title.trim().toLowerCase()) return void tell('The name did not match; nothing was deleted.');
      await api.deleteWorld(worldId);
      navigate('#/');
    } catch (e) {
      tell((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return <button className="m-danger" disabled={busy} onClick={() => void run()}>Delete this world (administrator)</button>;
}

/**
 * Administrators only: other players' adventures in this world, folded away until asked for. Joining one (giving
 * yourself a place in it) asks first; deleting one needs its name typed.
 */
function OthersAdventures({ worldId, me }: { worldId: string; me: Me }) {
  const [others, setOthers] = useState<AdventureSummary[] | null>(null);
  const [error, setError] = useState('');
  const load = () => api.adventures(worldId, true).then(setOthers, (e) => setError(e.message));
  return (
    <details className="m-others" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && !others && load()}>
      <summary>Other players’ adventures (administrator)</summary>
      {error && <div className="m-error">{error}</div>}
      {others && !others.length && <div className="m-fine" style={{ marginTop: 6 }}>None.</div>}
      {others?.map((s) => (
        <div key={s.id} className="row">
          <div>
            {s.name} <span className="m-fine">· {s.ownerName ?? 'unknown player'}</span>
            <small>Day {s.day} · {listing(s.players.map((p) => `${p.name} (level ${p.level})`))} · {ago(s.updatedAt)}</small>
          </div>
          <button
            className="m-quiet m-small"
            disabled={!!s.incompatible}
            onClick={() => void ask(`Give yourself a place in ${s.ownerName ?? 'another player'}’s adventure “${s.name}”? You join it with heroes of your own, and what you do is saved into it.`).then((ok) => void (ok && api.addMember(s.id, me.id, true).then(() => navigate(`#/adventure/${s.id}`), (e) => tell(e.message))))}
          >
            Join as administrator
          </button>
          <button
            className="m-danger"
            onClick={async () => {
              const typed = await askText(`Delete ${s.ownerName ?? 'another player'}’s adventure for good? Type its name to confirm:
${s.name}`, { danger: true, yes: 'Delete', input: { placeholder: s.name } });
              if (typed === null) return;
              if (typed.trim().toLowerCase() !== s.name.trim().toLowerCase()) return void tell('The name did not match; nothing was deleted.');
              api.deleteAdventure(s.id, true).then(() => setOthers((x) => x?.filter((y) => y.id !== s.id) ?? null), (e) => tell(e.message));
            }}
          >
            Delete
          </button>
        </div>
      ))}
    </details>
  );
}

/** The world's rules as a player sees them: what kind of game it is (the codex opens beside the world's title). */
function RulesPanel({ ruleset }: { ruleset: Ruleset | null }) {
  return (
    <div className="m-panel pad">
      <h3>Rules{ruleset ? `: ${ruleset.name}` : ''}</h3>
      {!ruleset ? (
        <p>This world has no rules yet.</p>
      ) : (
        <>
          <p className="intro">{ruleset.classes.map((k) => k.name).join(', ')}: every hero starts in one class and may learn from any of them.</p>
          <p>Heroes grow up to {ruleset.terminology.level.toLowerCase()} {ruleset.progression.maxLevel}.</p>
        </>
      )}
    </div>
  );
}

