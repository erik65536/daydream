/**
 * Talking with the example's people, to judge how they speak. It is the game's own conversation, in the world the
 * example's newest runs make: choose a person, and they greet the hero as when a player walks up to them. Beside the
 * conversation is what it changed (what they think of the hero and why, quests begun, the journal) and what the
 * speaking model is told about who they are.
 */
import { useEffect, useRef, useState } from 'react';
import type { ChatView, People, State } from '../protocol.ts';
import { call, get, money, post, q } from './api.ts';

export function TalkView({ state, onChange }: { state: State; onChange: () => void }) {
  const [people, setPeople] = useState<People | null>(null);
  const [error, setError] = useState('');
  const [chat, setChat] = useState<ChatView | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [side, setSide] = useState<'changed' | 'sheet'>('changed');
  const end = useRef<HTMLDivElement>(null);

  // The world is made from the newest runs, so it is read again when they change.
  const stamp = JSON.stringify(state.status);
  useEffect(() => {
    get<People>(`/api/people?${q({ example: state.example })}`).then(
      (p) => (setPeople(p), setError('')),
      (e) => (setPeople(null), setError((e as Error).message)),
    );
  }, [state.example, stamp]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [chat?.messages.length]);
  // A conversation ends when another starts, the example changes, or the page is left.
  useEffect(() => {
    const id = chat?.id;
    return () => {
      if (id) call('DELETE', `/api/chat/${id}`).catch(() => undefined);
    };
  }, [chat?.id]);
  useEffect(() => {
    setChat(null);
  }, [state.example]);

  const act = async (p: Promise<ChatView>) => {
    setBusy(true);
    try {
      setChat(await p);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onChange();
    }
  };
  const start = (person: string) => act(post<ChatView>('/api/chat', { example: state.example, person }));
  const say = () => {
    const line = text.trim();
    if (!chat || !line || busy) return;
    setText('');
    setChat({ ...chat, messages: [...chat.messages, { speaker: 'hero', text: line }] });
    void act(post<ChatView>(`/api/chat/${chat.id}/say`, { text: line }));
  };

  return (
    <section className="page">
      <header className="page-head">
        <div className="page-title">
          <h1>talk</h1>
          <span className="muted">with the people of {state.example}, in the game's own conversation</span>
        </div>
        {chat && (
          <div className="page-actions">
            <span className="muted small">this conversation {money(chat.usd)}</span>
            <button onClick={() => start(chat.person.id)} disabled={busy}>
              Start again
            </button>
          </div>
        )}
      </header>
      {error && <div className="notice notice-bad">{error}</div>}
      <div className="talk">
        <nav className="talk-people">
          {people?.map((t) => (
            <div key={t.town} className="talk-town">
              <h2>{t.town}</h2>
              {t.people.map((n) => (
                <button key={n.id} className={chat?.person.id === n.id ? 'talk-person on' : 'talk-person'} onClick={() => start(n.id)} disabled={busy}>
                  <span className="talk-name">
                    {n.name}
                    {n.story && <span className="tag">story</span>}
                  </span>
                  <span className="muted small">{n.title}</span>
                </button>
              ))}
            </div>
          ))}
          {!people && !error && <div className="muted">…</div>}
        </nav>
        <div className="talk-main">
          {!chat ? (
            <div className="empty">{busy ? 'They are turning to greet the hero…' : 'Choose someone to talk with. They greet the hero, Ash, as when a player walks up to them.'}</div>
          ) : (
            <>
              <div className="talk-who">
                <strong>{chat.person.name}</strong>, {chat.person.title}, in {chat.person.home}
                <span className="muted small"> · {chat.person.role}{chat.person.story ? ', in the story' : ''}</span>
              </div>
              <div className="talk-lines">
                {chat.messages.map((m, i) => (
                  <div key={i} className={`talk-line said-${m.speaker}`}>
                    {m.speaker !== 'narrator' && <span className="talk-speaker">{m.speaker === 'hero' ? 'Ash' : chat.person.name}</span>}
                    <span>{m.text}</span>
                  </div>
                ))}
                {busy && <div className="talk-line said-person talk-thinking">…</div>}
                <div ref={end} />
              </div>
              <form
                className="talk-say"
                onSubmit={(e) => {
                  e.preventDefault();
                  say();
                }}
              >
                <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Say something to ${chat.person.name}…`} disabled={busy} autoFocus />
                <button className="primary" type="submit" disabled={busy || !text.trim()}>
                  Say
                </button>
              </form>
            </>
          )}
        </div>
        {chat && (
          <aside className="talk-side">
            <div className="toggle">
              <button className={side === 'changed' ? 'on' : ''} onClick={() => setSide('changed')}>
                What it changed
              </button>
              <button className={side === 'sheet' ? 'on' : ''} onClick={() => setSide('sheet')}>
                What they are told
              </button>
            </div>
            {side === 'changed' ? (
              <dl className="talk-facts">
                <dt>What they think of Ash</dt>
                <dd>
                  They {chat.regard.feeling} <span className="v-atom">{chat.regard.value}</span>
                  {chat.regard.reasons.length > 0 && (
                    <ul className="v-bullets">
                      {chat.regard.reasons.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  )}
                </dd>
                <dt>Quests</dt>
                <dd>
                  {chat.quests.length ? (
                    <ul className="v-bullets">
                      {chat.quests.map((x) => (
                        <li key={x.title}>
                          {x.title} <span className="muted small">({x.status}{x.main ? ', main story' : ''})</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="v-none">none begun</span>
                  )}
                </dd>
                <dt>Journal</dt>
                <dd>
                  {chat.journal.length ? (
                    <ul className="v-bullets">
                      {chat.journal.map((j, i) => (
                        <li key={i}>{j}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="v-none">nothing yet</span>
                  )}
                </dd>
              </dl>
            ) : (
              <pre className="prompt">{chat.sheet}</pre>
            )}
          </aside>
        )}
      </div>
    </section>
  );
}
