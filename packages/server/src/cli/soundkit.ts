/**
 * Make the game's own sounds (docs/sound.md, "The game's own sounds"): a neutral copy of every moment, a spell, a
 * fight starting, and the game's theme, made once and shipped with the client in packages/client/public/sounds/
 * (`index.json` lists them). A world plays them for any sound it could not make, and the pages outside a world play
 * the theme. What exists is kept; `--again` makes everything anew, `--only <id ...>` just those (new takes each
 * run; a sound whose new takes are all refused keeps the one it had). `--use <id> <file>`
 * makes one of them game-ready from a WAV made elsewhere instead, with no GPU; the theme is made only this way (it was
 * composed with Google Gemini).
 *
 * Needs the broker with Stable Audio 3 in its ComfyUI (docs/hosting.md, "GPU PC setup"); no OpenAI.
 *
 * Usage: node src/cli/soundkit.ts [--again] [--only <id ...>] | --use <id> <file.wav>
 */
import fs from 'node:fs';
import path from 'node:path';
import { GAME_SOUNDS, gameSoundSpec, soundFile, type GameSound, type SoundDef } from '@daydream/shared';
import { ROOT_DIR } from '../paths.ts';
import { gameOrders } from '../sound/prompts.ts';
import { KBPS, makeSounds } from '../sound/make.ts';
import { makeReady, oggOpus } from '../sound/ready.ts';
import { decodeWav } from '../sound/wav.ts';
import { scaled, seconds } from '../sound/dsp.ts';
import { withCallContext } from '../genai/context.ts';

const args = process.argv.slice(2);
const dir = path.join(ROOT_DIR, 'packages', 'client', 'public', 'sounds');
const indexFile = path.join(dir, 'index.json');
const index: Record<string, SoundDef> = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : {};
const save = (sounds: Record<string, SoundDef>) => {
  const out = Object.fromEntries(Object.entries(sounds).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(indexFile, JSON.stringify(out, null, 1) + '\n');
  return Object.keys(out).length;
};

if (args.includes('--use')) {
  const [id, file] = args.slice(args.indexOf('--use') + 1) as [GameSound, string];
  if (!GAME_SOUNDS.includes(id) || !file) throw new Error(`usage: --use <${GAME_SOUNDS.join('|')}> <file.wav>`);
  const spec = gameSoundSpec(id);
  // Lowered 6 dB like a generated take (config/comfyui/stable_audio_3.json): a mastered file touches full scale, and
  // the level is set afterwards anyway.
  const r = makeReady(scaled(decodeWav(fs.readFileSync(file)), 0.5), spec);
  if (!r.ok) throw new Error(`${file}: ${r.problem}`);
  for (const f of [...(index[id]?.files ?? []), ...(index[id]?.intro ? [index[id]!.intro!] : [])]) fs.rmSync(path.join(dir, f), { force: true });
  const main = soundFile(id, 0);
  fs.writeFileSync(path.join(dir, main), oggOpus(r.main, KBPS[spec.bus]));
  const intro = r.intro ? soundFile(id, 0, 'intro') : undefined;
  if (intro) fs.writeFileSync(path.join(dir, intro), oggOpus(r.intro!, KBPS[spec.bus]));
  save({ ...index, [id]: { files: [main], ...(intro ? { intro } : {}) } });
  console.log(`${id}: ${seconds(r.main).toFixed(1)} s, ${(fs.statSync(path.join(dir, main)).size / 1e6).toFixed(2)} MB`);
  process.exit(0);
}

const again = args.includes('--again');
const only = args.includes('--only') ? new Set(args.slice(args.indexOf('--only') + 1).filter((a) => !a.startsWith('--'))) : null;
const orders = gameOrders().filter((o) => !only || only.has(o.key));
// What is not made anew stays, the theme always.
const have = Object.fromEntries(Object.entries(index).filter(([id]) => !orders.some((o) => o.key === id) || !(again || only)));
const t0 = Date.now();
// Each run has seeds of its own, so a sound made again is a new take.
const made = await withCallContext({ priority: 'background' }, () => makeSounds(orders, {
  dir, have, seedBase: `daydream:${Date.now()}`, takesFile: null,
  report: (m) => console.log(m),
  shouldStop: () => false,
  progress: (f) => process.stdout.write(`\r${Math.round(f * 100)}%  `),
}));
// A sound whose new takes were all refused keeps what it had; the files a remade one no longer uses go.
const filesOf = (d: SoundDef | undefined) => [...(d?.files ?? []), ...(d?.intro ? [d.intro] : [])];
for (const [id, d] of Object.entries(made)) for (const f of filesOf(index[id])) if (!filesOf(d).includes(f)) fs.rmSync(path.join(dir, f), { force: true });
const total = save({ ...index, ...made });
console.log(`\n${Object.keys(made).length} of ${orders.length} ready in ${Math.round((Date.now() - t0) / 1000)} s; ${total} in ${path.relative(ROOT_DIR, dir)}`);
process.exit(0);
