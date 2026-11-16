/**
 * The world viewer (administrators only): everything a world holds, read-only, for exploring and checking a build.
 * Its routes are under /api/admin, so the administrators' guard (admin.ts) refuses everyone else, the world's owner
 * included. Editing a world is the console tools' work (packages/server/src/cli) and the pipeline designer's.
 *
 * The view is the whole world definition as saved (secrets, lore, and the generation log included), the build's
 * records (worldgen/metrics.ts) beside the estimate for its size, each actor's animation state, and every line spoken
 * at build time with its file, so the viewer plays a person's greeting in their own voice.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Express, Response } from 'express';
import { buildEstimate, type GameLength, type WorldSize } from '@daydream/shared';
import { listAdventures, loadWorld, worldAssetDir } from './storage.ts';
import { measuredRates, worldMetrics } from './worldgen/metrics.ts';
import { actorSprites } from './anim/actors.ts';
import { animationState } from './anim/job.ts';
import { fixedLines } from './worldgen/voices.ts';
import { fixedLineFile } from './speech/speech.ts';
import { activeJob } from './jobs/queue.ts';

const VOICE_FILE = /^[\w-]+\.wav$/;
const SPEECH_FILE = /^[0-9a-f]{24}\.opus$/;

function sendAudio(res: Response, dir: string, file: string, name: RegExp, type: string) {
  if (!name.test(file)) return void res.status(400).end();
  res.sendFile(path.join(dir, file), { dotfiles: 'allow', headers: { 'Content-Type': type, 'Cache-Control': 'no-cache' } }, (err) => err && !res.headersSent && res.status(404).end());
}

export function mountWorldViewer(app: Express) {
  app.get('/api/admin/worlds/:id/view', (req, res) => {
    const w = loadWorld(String(req.params.id));
    if (!w) return void res.status(404).json({ error: 'No such world.' });
    const dir = worldAssetDir(w.id);
    const speechDir = path.join(dir, 'speech');
    const spoken = fixedLines(w).map((l) => ({ ...l, file: path.basename(fixedLineFile(speechDir, l.speakerId, l.text)) })).filter((l) => fs.existsSync(path.join(speechDir, l.file)));
    const clips = fs.existsSync(path.join(dir, 'voices')) ? fs.readdirSync(path.join(dir, 'voices')).filter((f) => VOICE_FILE.test(f)) : [];
    const adventures = listAdventures(w.id);
    const job = activeJob(w.id);
    res.json({
      world: w,
      records: worldMetrics(w.id),
      estimate: w.input?.size ? buildEstimate(w.input.size as WorldSize, w.input.length as GameLength, measuredRates()?.rates) : null,
      motion: Object.fromEntries(actorSprites(w).map((a) => [a.key, animationState(w, a)])),
      voiceClips: clips.map((f) => f.replace(/\.wav$/, '')),
      spoken,
      adventures: { count: adventures.length, players: new Set(adventures.flatMap((s) => Object.keys(s.players))).size },
      job: job ? { kind: job.kind, status: job.status, step: job.step, progress: job.progress } : null,
    });
  });

  /** A speaker's reference clip (assets/voices/<id>.wav). */
  app.get('/api/admin/worlds/:id/voices/:file', (req, res) => {
    const id = String(req.params.id);
    if (!/^[\w-]+$/.test(id)) return void res.status(400).end();
    sendAudio(res, path.join(worldAssetDir(id), 'voices'), String(req.params.file), VOICE_FILE, 'audio/wav');
  });

  /** A line spoken at build time (assets/speech/<hash>.opus). */
  app.get('/api/admin/worlds/:id/speech/:file', (req, res) => {
    const id = String(req.params.id);
    if (!/^[\w-]+$/.test(id)) return void res.status(400).end();
    sendAudio(res, path.join(worldAssetDir(id), 'speech'), String(req.params.file), SPEECH_FILE, 'audio/ogg');
  });
}
