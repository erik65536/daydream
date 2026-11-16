import { useState } from 'react';
import { api, type Me } from '../api';
import { ToolPage } from '../ui/night';
import { usePoll } from '../ui/poll';
import { tell } from '../ui/ask';

type GenaiInfo = Awaited<ReturnType<typeof api.genai>>;

/** What each purpose is for (server: genai/types.ts, and the table in README.md). */
const PURPOSE_HELP: Record<string, string> = {
  'world.design': 'Concept, world plan, rules, story, and each place’s plan. Use your smartest model.',
  'world.content': 'Towns, residents and their inner lives, side quests, lore. Many calls.',
  'npc.judge': 'Decides what a person does in each turn of a conversation, and how they feel (a decision model). Latency matters.',
  'npc.decision': 'The words a person says in each turn of a conversation, streamed and spoken as they come. Latency matters.',
  narration: 'Short flavor text, the legends of top-rarity items, and people’s notes on old conversations.',
  'image.sprite': 'Paints characters, creatures, and the objects drawn over places.',
  'image.icon': 'Paints item icons.',
  'image.check': 'Checks painted art and places (a decision model).',
  'image.prompt': 'Writes the image prompt of every character, creature, object, and icon, and picks its chroma-key backdrop.',
  'image.animation': 'Paints characters’ animation frames, in batches.',
  'image.walk': 'Paints characters’ walks as looping pictures, in batches.',
  'image.read': 'Reads painted places for where people can walk. Left out, Qwen on the GPU reads them.',
  'speech.input': 'Turns what a player says into text, for talking to people.',
  'speech.cpu': 'Pocket TTS on this machine: speaks the voices while the GPU is busy or away.',
  'speech.gpu': 'Speaks the same voices on the GPU, through the GPU broker, while it is idle.',
};

export function Models({ me }: { me: Me }) {
  const [info, setInfo] = useState<GenaiInfo | null>(null);
  const [results, setResults] = useState<Record<string, { busy?: boolean; text?: string; image?: string; error?: string; ms?: number }>>({});
  const { error, refresh } = usePoll(async (alive) => {
    const now = await api.genai();
    if (alive()) setInfo(now);
  }, 5000, []);
  const test = async (purpose: string) => {
    setResults((r) => ({ ...r, [purpose]: { busy: true } }));
    try {
      const out = await api.genaiTest(purpose);
      setResults((r) => ({ ...r, [purpose]: { text: out.text ?? (out.json ? JSON.stringify(out.json) : out.error), image: out.image, error: out.ok ? undefined : out.error, ms: out.ms } }));
    } catch (e) {
      setResults((r) => ({ ...r, [purpose]: { error: (e as Error).message } }));
    }
  };
  return (
    <ToolPage me={me}>
        <h1 className="h1">AI models</h1>
        <p className="lede">Each part of the engine uses a configured model: OpenAI for text, decisions, speech input, and (by default) art and animation; ComfyUI behind the GPU broker for places, sound, and voices; Pocket TTS on this machine for voices while the GPU is busy. Edit <code>config/genai.json</code> (copy <code>config/genai.example.json</code>), then reload.</p>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={() => api.genaiReload().then(refresh, (e) => tell((e as Error).message))}>Reload config</button>
          {info && <span className="muted small">{info.configFile ? `Using ${info.configFile}` : 'No config/genai.json: no world can be built, and people answer with simple stock replies.'}</span>}
          {error && <span className="error-text">{error}</span>}
        </div>
        {!info && !error && <div className="center" style={{ padding: 40 }}><div className="spinner" /></div>}
        <div className="panel" style={{ marginTop: 16 }}>
          <table className="table">
            <thead>
              <tr><th>Purpose</th><th>Provider</th><th>Model</th><th style={{ width: 360 }}>Test</th></tr>
            </thead>
            <tbody>
              {info?.purposes.map((p) => {
                const r = results[p.purpose];
                return (
                  <tr key={p.purpose}>
                    <td><div style={{ fontWeight: 600 }}>{p.purpose}</div><div className="tiny muted">{PURPOSE_HELP[p.purpose]}</div></td>
                    <td>{p.provider} <span className="badge gray">{p.type}</span></td>
                    <td className="small">{p.model ?? '—'}</td>
                    <td>
                      {p.type !== 'not configured' && <button className="btn sm" disabled={r?.busy} onClick={() => test(p.purpose)}>{r?.busy ? 'Testing…' : 'Test'}</button>}
                      {r && !r.busy && (
                        <div className="small" style={{ marginTop: 6, color: r.error ? 'var(--danger)' : 'var(--good)', wordBreak: 'break-word' }}>
                          {r.ms !== undefined && <span className="dim">{(r.ms / 1000).toFixed(1)}s · </span>}
                          {r.error ?? r.text}
                          {r.image && <img src={r.image} style={{ display: 'block', maxWidth: 160, marginTop: 6, borderRadius: 6 }} />}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <h2 className="h2" style={{ marginTop: 26 }}>Recent calls</h2>
        <div className="panel" style={{ marginTop: 10 }}>
          <table className="table">
            <thead><tr><th>When</th><th>Purpose</th><th>Provider</th><th>Time</th><th>Result</th></tr></thead>
            <tbody>
              {info?.recent.map((c, i) => (
                <tr key={i}>
                  <td className="small">{new Date(c.at).toLocaleTimeString()}</td>
                  <td>{c.purpose}</td>
                  <td>{c.provider}</td>
                  <td>{(c.ms / 1000).toFixed(1)}s</td>
                  <td className="small" style={{ color: c.ok ? 'var(--good)' : 'var(--danger)' }}>{c.ok ? `ok${c.attempt > 1 ? ` (attempt ${c.attempt})` : ''}` : c.error}</td>
                </tr>
              ))}
              {!info?.recent.length && <tr><td colSpan={5} className="muted">No model calls yet.</td></tr>}
            </tbody>
          </table>
        </div>
    </ToolPage>
  );
}
