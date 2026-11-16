/**
 * Deleting a world: administrators only, whoever owns it. Everything the world owns goes: its jobs (stopped first,
 * with their ComfyUI prompts), the adventures being played in it (their players are told and sent back to the
 * worlds), every player's adventures and the world's folder (both to the trash, see storage.ts), its rows, and what
 * the server cached of it.
 */
import type { Express } from 'express';
import * as store from './storage.ts';
import { adminOnly, auth, type AuthedRequest } from './auth.ts';
import { activeJobsOfWorld, cancelOrphan, forgetWorldJobs, getJobRecord, requestCancel, type JobRecord } from './jobs/queue.ts';
import { dropJobPrompts } from './gpu/comfyqueue.ts';
import { audit } from './gpu/presence.ts';
import { forgetWorldsCache } from './gpu/admin.ts';
import { comfyBase } from './worldgen/comfy.ts';
import { adventures } from './game/manager.ts';
import { activity } from './log.ts';

/** What deleting a world takes with it, for the confirmation. */
export interface DeletionPreview {
  title: string;
  ownerName: string;
  /** Every player's adventures in it. */
  adventures: number;
  /** Different people with an adventure or a place in one. */
  players: number;
  /** People playing in it right now. */
  online: number;
  /** Its jobs still running or queued (a build, rules, painting, animation). */
  jobs: { kind: string; status: string }[];
}

export function deletionPreview(worldId: string): DeletionPreview | null {
  const w = store.loadWorld(worldId);
  if (!w) return null;
  const all = store.listAdventures(w.id);
  const people = new Set(all.flatMap((s) => [s.ownerId, ...s.members, ...Object.keys(s.players)]));
  const online = all.reduce((n, s) => n + adventures.onlineUsers(s.id).length, 0);
  return { title: w.concept.title, ownerName: w.ownerName, adventures: all.length, players: people.size, online, jobs: activeJobsOfWorld(w.id).map((j) => ({ kind: j.kind, status: j.status })) };
}

/** A job of the world was asked to stop but has not yet: nothing was deleted, and trying again shortly succeeds. */
export class StillStopping extends Error {}

/**
 * Stop every job of a world and wait until none runs, so nothing writes into its folder once it has moved. A job
 * that no worker holds any more is ended at once; one still running after `waitMs` throws StillStopping. Returns
 * how many jobs there were.
 */
async function stopWorldJobs(worldId: string, waitMs = 30_000): Promise<number> {
  const jobs = activeJobsOfWorld(worldId);
  const running = (j: JobRecord) => {
    const now = getJobRecord(j.id);
    return !!now && (now.status === 'running' || now.status === 'waiting') && !cancelOrphan(j.id);
  };
  for (const j of jobs) requestCancel(j.id);
  let left = jobs.filter(running);
  for (const j of left) await dropJobPrompts(comfyBase(), j.id).catch(() => 0);
  const until = Date.now() + waitMs;
  while ((left = left.filter(running)).length && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
  if (left.length) throw new StillStopping('Its jobs were asked to stop but are still running. Nothing was deleted; try again in a minute.');
  return jobs.length;
}

/** Delete a world and everything it owns (see the top of this file). */
export async function removeWorld(worldId: string, by: store.User, opts: { waitMs?: number } = {}) {
  const w = store.loadWorld(worldId);
  if (!w) return;
  const stopped = await stopWorldJobs(w.id, opts.waitMs);
  // Adventures being played end before their files move, so no last save writes them back outside the trash.
  for (const s of store.listAdventures(w.id)) adventures.end(s.id, `${w.concept.title} was deleted by an administrator, with every adventure in it.`);
  store.deleteWorld(w.id, by.displayName);
  forgetWorldJobs(w.id);
  forgetWorldsCache();
  audit(by, 'delete world', `${w.concept.title} (${w.id})`, stopped ? `${stopped} job(s) stopped` : '');
  activity('world deleted', by.id, { world: w.id }, { title: w.concept.title, ...(w.ownerId !== by.id ? { owner: w.ownerId } : {}) });
}

export function mountWorldDeletion(app: Express) {
  // (Under /api/admin: the administrators' guard, admin.ts.)
  app.get('/api/admin/worlds/:id/deletion', (req, res) => {
    const p = deletionPreview(String(req.params.id));
    if (!p) return void res.status(404).json({ error: 'Not found.' });
    res.json(p);
  });

  app.delete('/api/worlds/:id', auth, adminOnly, async (req, res, next) => {
    if (!store.loadWorld(String(req.params.id))) return void res.status(404).json({ error: 'Not found.' });
    try {
      await removeWorld(String(req.params.id), (req as AuthedRequest).user);
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof StillStopping) return void res.status(409).json({ error: e.message });
      next(e);
    }
  });
}
