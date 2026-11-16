/** Everything in a world that can be found by searching: each thing with where it is shown and the words it holds. */
import type { WorldDefinition } from '@daydream/shared';
import type { Section } from './core';

export interface Found {
  section: Section;
  id?: string;
  part?: string;
  /** What kind of thing it is ("person", "skill"). */
  kind: string;
  title: string;
  /** Lower-case words to match: its title first, then everything it says. */
  text: string;
}

/** Every string inside a value, joined. */
const texts = (x: unknown): string =>
  typeof x === 'string' ? x : Array.isArray(x) ? x.map(texts).join(' ') : x && typeof x === 'object' ? Object.values(x).map(texts).join(' ') : '';

export function searchIndex(w: WorldDefinition): Found[] {
  const r = w.ruleset;
  const out: Found[] = [];
  const add = (f: Omit<Found, 'text'>, body: unknown) => out.push({ ...f, text: `${f.title} ${texts(body)}`.toLowerCase() });
  for (const z of w.zones) add({ section: 'places', id: z.id, kind: z.kind, title: z.name }, [z.description, z.lore, z.design, z.buildings, z.features.map((f) => [f.name, f.text])]);
  for (const n of w.npcs) {
    const { id: _i, zoneId: _z, x: _x, y: _y, asset: _a, ...rest } = n;
    add({ section: 'people', id: n.id, kind: 'person', title: n.name }, rest);
  }
  for (const q of w.quests) add({ section: 'story', id: q.id, kind: q.main ? 'story quest' : 'side quest', title: q.title }, [q.summary, q.objectives.map((o) => [o.description, o.agree])]);
  for (const a of w.arcs) add({ section: 'story', id: `arc${a.index}`, kind: 'arc', title: a.title }, a.revelation);
  for (const l of w.lore) add({ section: 'story', id: l.id, kind: 'lore', title: l.title }, l.text);
  for (const f of w.families) {
    add({ section: 'creatures', id: f.id, kind: 'creature family', title: f.name }, f.description);
    f.members.forEach((m, i) => add({ section: 'creatures', id: f.id, part: `m${i}`, kind: 'creature', title: m.name }, [m.description, m.appearance]));
  }
  for (const b of w.bosses) add({ section: 'creatures', id: b.id, kind: b.member ? 'named foe' : 'boss', title: b.name }, [b.description, b.appearance, b.taunt, b.voice]);
  for (const c of r?.classes ?? []) {
    add({ section: 'rules', id: 'classes', part: c.id, kind: r.terminology.calling.toLowerCase(), title: c.name }, c.description);
    for (const n of c.nodes) add({ section: 'rules', id: 'classes', part: n.id, kind: n.kind, title: n.name }, n.description);
  }
  for (const s of r?.statuses ?? []) add({ section: 'rules', id: 'statuses', part: s.id, kind: 'status', title: s.name }, s.description);
  for (const i of r?.items ?? []) add({ section: 'rules', id: 'items', part: i.id, kind: i.category, title: i.name }, i.description);
  for (const u of Object.values(w.uniqueItems)) add({ section: 'rules', id: 'items', part: u.id, kind: u.questItem ? 'quest item' : 'unique item', title: u.name }, u.description);
  for (const k of r?.kins ?? []) add({ section: 'rules', id: 'kins', part: k.id, kind: r.terminology.kin.toLowerCase(), title: k.name }, [k.description, k.appearance, k.names]);
  for (const a of Object.values(w.assets)) if (a.kind !== 'sheet') add({ section: 'art', id: a.key, kind: 'picture', title: a.key }, [a.prompt, a.imagePrompt]);
  for (const k of Object.keys(w.sounds ?? {})) add({ section: 'sound', id: k, kind: 'sound', title: k }, '');
  return out;
}

/** The things matching every word of a query, those named by it first. */
export function search(index: Found[], query: string, limit = 40): Found[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = index.filter((f) => words.every((x) => f.text.includes(x)));
  const named = (f: Found) => words.every((x) => f.title.toLowerCase().includes(x));
  return hits.sort((a, b) => Number(named(b)) - Number(named(a))).slice(0, limit);
}
