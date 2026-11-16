/**
 * Making a world, as its owner does it on the creation page (worldgen/review.ts): describe it, review the concept and
 * rule systems the build's first steps wrote, describe it again or set rules by hand, then create it, which starts its
 * build. Nothing is saved as a world before that. A stopped build is resumed by its owner or an administrator.
 */
import type { Express, Response } from 'express';
import { z } from 'zod';
import { BUILD_RATES } from '@daydream/shared';
import * as store from './storage.ts';
import { auth, type AuthedRequest } from './auth.ts';
import { activeJob, JobConflict } from './jobs/queue.ts';
import { BudgetExceeded } from './genai/spend.ts';
import { buildWorld } from './worldgen/build.ts';
import { createWorld, NoReview, ReviewBusy, writeReview } from './worldgen/review.ts';
import { measuredRates } from './worldgen/metrics.ts';
import { WorldInputSchema } from './worldInput.ts';
import { activity } from './log.ts';

/** Non-administrators may have this many jobs queued or running at once (a new build and a resumed one count alike). */
const MAX_BUILDS = 2;
const buildCap = (u: store.User) => ({ maxPerOwner: u.isAdmin ? undefined : MAX_BUILDS });

const Review = z.object({ input: WorldInputSchema, review: z.string().max(40).optional() }).strict();

/** Answer with what went wrong: a review gone (404), being written or too many builds (409), no budget (402). */
function refuse(res: Response, e: unknown) {
  if (e instanceof NoReview) return void res.status(404).json({ error: e.message });
  if (e instanceof ReviewBusy || e instanceof JobConflict) return void res.status(409).json({ error: e.message });
  if (e instanceof BudgetExceeded) return void res.status(402).json({ error: e.message });
  throw e;
}

export function mountWorldCreation(app: Express) {
  /** Write (or write again) the concept and rule systems of a world to be, for its owner to review. */
  app.post('/api/worlds/review', auth, async (req, res, next) => {
    const body = Review.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid input.' });
    try {
      res.json(await writeReview((req as AuthedRequest).user.id, body.data.input, body.data.review));
    } catch (e) {
      try {
        refuse(res, e);
      } catch (other) {
        next(other);
      }
    }
  });

  /** Create the world reviewed, and start building it. */
  app.post('/api/worlds', auth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const body = z.object({ input: WorldInputSchema, review: z.string().max(40) }).strict().safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid input.' });
    try {
      const worldId = createWorld({ id: u.id, name: u.displayName }, body.data.input, body.data.review, buildCap(u));
      activity('world started', u.id, { world: worldId });
      res.json({ worldId });
    } catch (e) {
      refuse(res, e);
    }
  });

  /** Continue a build that stopped (a model or service was down, or someone stopped it): finished steps are kept. */
  app.post('/api/worlds/:id/resume', auth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const w = store.loadWorld(String(req.params.id));
    if (!w || w.status === 'ready') return void res.status(404).json({ error: 'No stopped build to resume.' });
    if (w.ownerId !== u.id && !u.isAdmin) return void res.status(403).json({ error: 'Not your world.' });
    if (activeJob(w.id)) return void res.status(409).json({ error: 'This world is already being made.' });
    try {
      buildWorld(w, buildCap(u));
      res.json({ ok: true });
    } catch (e) {
      refuse(res, e);
    }
  });

  /** The rates the creation page's estimate uses: measured from finished builds once there are enough (worldgen/metrics.ts). */
  app.get('/api/build-rates', auth, (_req, res) => {
    res.json(measuredRates() ?? { rates: BUILD_RATES, builds: 0 });
  });
}
