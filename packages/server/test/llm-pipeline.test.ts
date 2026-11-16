/**
 * Runs a world's build and its people's dialogue through the real OpenAI-compatible provider against a mock server
 * that answers with schema-valid (but semantically random) JSON, and sometimes with junk, to prove the build's steps,
 * validation and retries hold up with weak models. Places are laid out as plain ground (no image model).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { genai } from '../src/genai/service.ts';
import { WorldGenJob, runGeneration } from '../src/worldgen/build.ts';
import { Pipeline } from '../src/pipeline/index.ts';
import { loadWorld } from '../src/storage.ts';
import { adventures } from '../src/game/manager.ts';
import { hero, mockModels, plainPlaces, validateWorld, type MockModels } from './helpers.ts';

let models: MockModels;
let restore: () => void;

beforeAll(async () => {
  models = await mockModels({
    junkOnce: ['story'],
    npc: () => ({ speech: 'Mock NPC says hello. And there is a job for you, if you want it.' }),
  });
  restore = plainPlaces();
});

afterAll(() => {
  restore();
  models.stop();
});

describe('LLM pipeline against a mock OpenAI-compatible server', () => {
  it('generates a valid world from model output (including a junk response)', async () => {
    const job = new WorldGenJob(`w_llm_${Date.now()}`, { theme: 'A test world of mock content', prompts: [{ topic: 'monsters' as const, text: 'No undead.' }], size: 'small', length: 'short', communication: 3 }, { id: 'u1', name: 'T' });
    await runGeneration(job);
    const w = loadWorld(job.worldId)!;
    expect(w.status).toBe('ready');
    expect(validateWorld(w)).toEqual([]);
    // Every step of the build was asked.
    const names = new Set(models.seen);
    for (const id of new Pipeline().project.steps.keys()) expect(names.has(id), id).toBe(true);
    // The junk story answer was asked again.
    expect(models.seen.filter((s) => s === 'story').length).toBeGreaterThanOrEqual(2);
    // Model-provided names made it into the world.
    expect(w.concept.title).toMatch(/title/);
    const calls = genai().recent.filter((c) => c.provider === 'mock');
    expect(calls.some((c) => !c.ok)).toBe(true);
    expect(calls.filter((c) => c.ok).length).toBeGreaterThan(8);

    // Every resident's inner life was written.
    for (const n of w.npcs.filter((x) => w.zones.find((z) => z.id === x.zoneId)?.kind === 'town')) expect(n.want && n.barks.length >= 3 && n.returning).toBeTruthy();

    // NPC dialogue: the judge reads a request for work, the code gives the side job, then the person says so.
    const adv = adventures.create(w, 'u1', 'T', 'llm run', [hero(w, 'Tess', 'melee')]);
    const msgs: unknown[] = [];
    adv.join({ userId: 'u1', send: (m) => msgs.push(structuredClone(m)) });
    const side = w.quests.find((q) => !q.main && q.giverNpcId)!;
    expect(side).toBeTruthy();
    await adv.dialogue.open('u1', side.giverNpcId!);
    await adv.dialogue.say('u1', 'Do you have any work for me?');
    expect(Object.keys(adv.state.quests)).toContain(side.id);
    expect(models.seen).toContain('decision');
    const last = (msgs.filter((m) => (m as { t: string }).t === 'dialog').pop() as { dialog: { messages: { text: string }[] } }).dialog.messages;
    expect(last.some((m) => m.text.includes('Mock NPC says hello'))).toBe(true);
    // The reply was streamed: its words were shown as they were written, then the whole reply.
    const growing = msgs.flatMap((m) => ((m as { t: string }).t === 'dialog' ? ((m as { dialog: { messages: { text: string; pending?: boolean }[] } }).dialog?.messages ?? []) : [])).filter((m) => m.pending);
    expect(growing.length).toBeGreaterThan(0);
    expect(growing[0]!.text.length).toBeLessThan('Mock NPC says hello. And there is a job for you, if you want it.'.length);
  }, 120000);
});
