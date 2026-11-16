/**
 * The administrators' pages: everything under /api/admin, which one guard refuses to anyone else (401 signed out,
 * 403 signed in). Mounted before every other route, so a route added under the prefix anywhere (accounts.ts, the
 * GPU page, the world viewer, a deletion's preview) is guarded, and none repeats the check. The pages themselves: AI models, the GPU,
 * errors, users, and the trash of deleted worlds.
 */
import fs from 'node:fs';
import type { Express } from 'express';
import { z } from 'zod';
import { genaiConfigFile } from './paths.ts';
import { describePath } from './checkout.ts';
import * as store from './storage.ts';
import { adminOnly, auth } from './auth.ts';
import { genai, reloadGenAI } from './genai/service.ts';
import { imagePromptSystem } from './genai/images.ts';
import { backdropSentence, cutout, finishCutout } from './genai/cutout.ts';
import { speech } from './speech/speech.ts';
import { clearErrors, recentErrors, statsReport } from './log.ts';

export function mountAdmin(app: Express) {
  app.use('/api/admin', auth, adminOnly);

  // ---------------------------------------------------------------------------- AI models

  app.get('/api/admin/models', (_req, res) => {
    const g = genai();
    res.json({ purposes: g.describe(), recent: g.recent.slice(-60).reverse(), configFile: fs.existsSync(genaiConfigFile()) ? describePath(genaiConfigFile()) : null });
  });

  app.post('/api/admin/models/reload', (_req, res) => {
    try {
      res.json({ purposes: reloadGenAI().describe() });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  /** One small call to a purpose's model, to see that it answers. */
  app.post('/api/admin/models/test', async (req, res) => {
    const purpose = String(req.body?.purpose ?? '');
    const g = genai();
    const t0 = Date.now();
    try {
      if (purpose === 'image.check' || purpose === 'npc.judge') {
        const answers = await g.decide(purpose, {
          state: 'A weary traveler stumbles into the inn, soaked through, and asks the innkeeper for a seat by the fire.',
          questions: {
            action: { type: 'choice', instructions: 'What does the kind innkeeper do?', criteria: { welcome: 'Make room by the fire', ignore: 'Ignore them', refuse: 'Turn them away' } },
            concern: { type: 'score', instructions: 'How concerned is the innkeeper?', criteria: ['indifferent', 'mildly', 'very', 'alarmed'] },
          },
        });
        return void res.json({ ok: true, ms: Date.now() - t0, json: answers });
      }
      if (purpose === 'image.prompt') {
        const text = await g.text('image.prompt', { system: imagePromptSystem(), messages: [{ role: 'user', content: 'Brief: a game character sprite, full body. Subject: a lantern-bearing night watchman in a patched oilskin coat. Art style: painterly dark fantasy.' }], maxTokens: 400 });
        return void res.json({ ok: true, ms: Date.now() - t0, text });
      }
      if (purpose.startsWith('image.')) {
        const painting = await g.image(purpose as 'image.sprite', { prompt: `A painterly game character: a friendly lantern-bearing traveler, full body, seen from the front. ${backdropSentence('green')}`, seed: 42, width: 832, height: 1216 });
        const buf = (await finishCutout(await cutout(painting), 512)).png;
        return void res.json({ ok: true, ms: Date.now() - t0, image: `data:image/png;base64,${buf.toString('base64')}` });
      }
      if (purpose === 'speech.cpu') {
        const st = speech().engine('cpu')?.status();
        if (!st?.ready) return void res.status(500).json({ ok: false, ms: Date.now() - t0, error: st ? 'Pocket TTS is starting or not answering (see the server log).' : 'Not started.' });
        return void res.json({ ok: true, ms: Date.now() - t0, text: `Ready: ${st.free} of ${st.slots} lines free, ${st.waiting} waiting.` });
      }
      if (purpose === 'narration') {
        const text = await g.text('narration', { messages: [{ role: 'user', content: 'Say hello as a gruff innkeeper in one sentence.' }], maxTokens: 120 });
        return void res.json({ ok: true, ms: Date.now() - t0, text });
      }
      const out = await g.structured(purpose as 'npc.decision', { prompt: 'Invent a tavern. Return JSON.', schema: z.object({ name: z.string(), mood: z.string(), patrons: z.array(z.string()).max(3) }), name: 'tavern', maxTokens: 400 });
      res.json({ ok: true, ms: Date.now() - t0, json: out });
    } catch (e) {
      res.status(500).json({ ok: false, ms: Date.now() - t0, error: (e as Error).message });
    }
  });

  // ---------------------------------------------------------------------------- errors

  app.get('/api/admin/errors', (_req, res) => res.json({ errors: recentErrors(), stats: statsReport() }));
  app.delete('/api/admin/errors', (_req, res) => {
    clearErrors();
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------------------- the trash

  /** Deleted worlds wait in the trash for TRASH_DAYS days; administrators can restore them or remove them now. */
  app.get('/api/admin/trash', (_req, res) => {
    res.json({ days: store.TRASH_DAYS, entries: store.listTrash() });
  });

  app.post('/api/admin/trash/:id/restore', (req, res) => {
    try {
      const w = store.restoreWorld(String(req.params.id));
      res.json({ ok: true, id: w.id });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.delete('/api/admin/trash/:id', (req, res) => {
    store.purgeTrashEntry(String(req.params.id));
    res.json({ ok: true });
  });
}
