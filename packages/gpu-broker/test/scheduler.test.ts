import { describe, expect, it, vi } from 'vitest';
import { AdapterDown, Broker, type GpuAdapter } from '../src/scheduler.ts';

interface W {
  name: string;
  /** Resolves when the test lets this piece finish. */
  gate?: Promise<void>;
  down?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake GPU program that records what ran and what was unloaded, in one shared log. */
function fake(name: string, log: string[], opts: { freeBetweenModels?: boolean; alive?: () => boolean } = {}): GpuAdapter<W> {
  return {
    name,
    freeBetweenModels: opts.freeBetweenModels,
    alive: async () => opts.alive?.() ?? true,
    unload: async () => void log.push(`unload ${name}`),
    run: async (w, ctx) => {
      if (w.down) {
        w.down = false;
        throw new AdapterDown('gone');
      }
      log.push(`run ${w.name}`);
      await Promise.race([w.gate ?? Promise.resolve(), new Promise((_, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('aborted'))))]);
      return w.name;
    },
  };
}

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

/** Until every piece named has ended, however long a busy machine takes. */
const settle = (b: Broker, ...ids: string[]) =>
  vi.waitFor(() => expect(ids.filter((id) => ['queued', 'running'].includes(b.get(id)!.state))).toEqual([]), { timeout: 20_000, interval: 5 });

const runs = (log: string[]) => log.filter((l) => l.startsWith('run ')).map((l) => l.slice(4));

describe('GPU broker scheduler', () => {
  it('runs the most urgent work first, and unloads everything before its first piece', async () => {
    const log: string[] = [];
    const b = new Broker({ comfy: fake('comfy', log), other: fake('other', log) }, { graceMs: 0, log: () => {} });
    const g = gate();
    const a = b.submit('comfy', { name: 'build-1', gate: g.p }, { client: 'prod', rank: 2, model: 'klein' });
    await sleep(10);
    const c = b.submit('comfy', { name: 'build-2' }, { client: 'prod', rank: 2, model: 'klein' });
    const d = b.submit('comfy', { name: 'player' }, { client: 'dev', rank: 0, model: 'klein' });
    g.open();
    await settle(b, a.id, c.id, d.id);
    expect(log.slice(0, 2).sort()).toEqual(['unload comfy', 'unload other']);
    expect(runs(log)).toEqual(['build-1', 'player', 'build-2']);
  });

  it('lets a program keep a model loaded while the GPU is idle, and unloads it for the next queued work', async () => {
    const log: string[] = [];
    let changes = 0;
    const b = new Broker({ comfy: fake('comfy', log), speech: fake('speech', log) }, { graceMs: 0, settleMs: 0, log: () => {}, onChange: () => changes++ });
    expect(b.idle()).toBe(true);
    // Just started, nothing known: everything else is unloaded first.
    expect(await b.claim('speech', 'runner')).toBe(true);
    expect(log).toEqual(['unload comfy']);
    expect(b.snapshot().resident).toEqual({ adapter: 'speech', model: 'runner' });
    const g = gate();
    const job = b.submit('comfy', { name: 'paint', gate: g.p }, { client: 'prod', model: 'klein' });
    expect(b.idle()).toBe(false);
    expect(await b.claim('speech', 'runner')).toBe(false);
    await sleep(10);
    expect(log).toEqual(['unload comfy', 'unload speech', 'run paint']);
    g.open();
    await settle(b, job.id);
    await sleep(10);
    // Queued, then idle again: callers hear of both.
    expect(changes).toBeGreaterThanOrEqual(2);
    expect(b.idle()).toBe(true);
    expect(await b.claim('speech', 'runner')).toBe(true);
    expect(log.at(-1)).toBe('unload comfy');
  });

  it('keeps the last model loaded until the GPU has stayed idle a while, then tells the programs', async () => {
    const log: string[] = [];
    let changes = 0;
    const b = new Broker({ comfy: fake('comfy', log), speech: fake('speech', log) }, { graceMs: 0, settleMs: 200, log: () => {}, onChange: () => changes++ });
    const sfx = b.submit('comfy', { name: 'sfx-1' }, { client: 'prod', model: 'sa3' });
    await settle(b, sfx.id);
    await sleep(10);
    // A caller between two pieces (the sound's take made game-ready on its CPU): its model stays.
    expect(b.idle()).toBe(true);
    expect(await b.claim('speech', 'runner')).toBe(false);
    const toldIdle = changes;
    const next = b.submit('comfy', { name: 'sfx-2' }, { client: 'prod', model: 'sa3' });
    await settle(b, next.id);
    expect(log.slice(log.indexOf('run sfx-1'))).toEqual(['run sfx-1', 'run sfx-2']);
    // Settled: the programs are told again, and one may load its own model.
    await vi.waitFor(() => expect(changes).toBeGreaterThan(toldIdle + 2), { timeout: 5000, interval: 10 });
    expect(await b.claim('speech', 'runner')).toBe(true);
    expect(log.at(-1)).toBe('unload comfy');
  });

  it('prefers work for the loaded model, and unloads when switching program or model', async () => {
    const log: string[] = [];
    const b = new Broker({ comfy: fake('comfy', log, { freeBetweenModels: true }), st: fake('st', log) }, { graceMs: 0, log: () => {} });
    const g = gate();
    const first = b.submit('comfy', { name: 'klein-1', gate: g.p }, { client: 'prod', model: 'klein' });
    await sleep(10);
    const qwen = b.submit('comfy', { name: 'qwen' }, { client: 'dev', model: 'qwen' });
    const klein = b.submit('comfy', { name: 'klein-2' }, { client: 'dev', model: 'klein' });
    const st = b.submit('st', { name: 'tool' }, { client: 'dev', model: 'tool' });
    g.open();
    await settle(b, first.id, qwen.id, klein.id, st.id);
    expect(runs(log)).toEqual(['klein-1', 'klein-2', 'qwen', 'tool']);
    const after = log.slice(log.indexOf('run klein-2'));
    expect(after).toEqual(['run klein-2', 'unload comfy', 'run qwen', 'unload comfy', 'run tool']);
  });

  it("waits a moment for the same caller's next piece before switching models", async () => {
    const log: string[] = [];
    // A grace long beside the 40 ms the next piece comes after, so a slow machine still sends it within it.
    const b = new Broker({ comfy: fake('comfy', log) }, { graceMs: 500, log: () => {} });
    const a = b.submit('comfy', { name: 'prod-klein-1' }, { client: 'prod', model: 'klein' });
    await settle(b, a.id);
    const other = b.submit('comfy', { name: 'dev-qwen' }, { client: 'dev', model: 'qwen' });
    await sleep(40);
    const next = b.submit('comfy', { name: 'prod-klein-2' }, { client: 'prod', model: 'klein' });
    await settle(b, other.id, next.id);
    expect(runs(log)).toEqual(['prod-klein-1', 'prod-klein-2', 'dev-qwen']);
  });

  it('passes the GPU to another caller after the hold limit', async () => {
    const log: string[] = [];
    const b = new Broker({ comfy: fake('comfy', log) }, { graceMs: 0, holdMs: 0, log: () => {} });
    const g = gate();
    const ids = [b.submit('comfy', { name: 'p1', gate: g.p }, { client: 'prod', model: 'klein' }).id];
    await sleep(10);
    ids.push(b.submit('comfy', { name: 'p2' }, { client: 'prod', model: 'klein' }).id);
    ids.push(b.submit('comfy', { name: 'd1' }, { client: 'dev', model: 'klein' }).id);
    g.open();
    await settle(b, ...ids);
    expect(runs(log)).toEqual(['p1', 'd1', 'p2']);
  });

  it('cancels queued and running work', async () => {
    const log: string[] = [];
    const b = new Broker({ comfy: fake('comfy', log) }, { graceMs: 0, log: () => {} });
    const running = b.submit('comfy', { name: 'long', gate: new Promise(() => {}) }, { client: 'prod' });
    const queued = b.submit('comfy', { name: 'never' }, { client: 'prod' });
    await sleep(10);
    expect(b.cancel(queued.id)).toBe(true);
    expect(b.cancel(running.id)).toBe(true);
    await settle(b, running.id, queued.id);
    expect(running.state).toBe('cancelled');
    expect(queued.state).toBe('cancelled');
    expect(runs(log)).toEqual(['long']);
  });

  it('keeps work waiting while its program does not answer, and runs it when it comes back', async () => {
    const log: string[] = [];
    let up = false;
    const b = new Broker({ comfy: fake('comfy', log, { alive: () => up }) }, { graceMs: 0, retryDownMs: 20, log: () => {} });
    const it = b.submit('comfy', { name: 'paint', down: true }, { client: 'prod' });
    await sleep(60);
    expect(it.state).toBe('queued');
    expect(b.isDown('comfy')).toBe(true);
    up = true;
    await settle(b, it.id);
    expect(it.state).toBe('done');
    expect(it.result).toBe('paint');
  });

  it('keeps its defaults for options a config leaves out', async () => {
    const log: string[] = [];
    let t = 1_000_000;
    const b = new Broker({ comfy: fake('comfy', log) }, { holdMs: undefined, graceMs: undefined, settleMs: undefined, now: () => t, log: () => {} });
    const it = b.submit('comfy', { name: 'paint' }, { client: 'prod' });
    await settle(b, it.id);
    await sleep(10);
    expect(b.settled()).toBe(false);
    t += 59_000;
    expect(b.settled()).toBe(false);
    t += 1000;
    expect(b.settled()).toBe(true);
  });

  it('counts the hold limit from when another caller began to wait', async () => {
    const log: string[] = [];
    let t = 1_000_000;
    const b = new Broker({ comfy: fake('comfy', log) }, { graceMs: 0, holdMs: 1000, now: () => t, log: () => {} });
    const g = gate();
    const ids = [b.submit('comfy', { name: 'p1', gate: g.p }, { client: 'prod', model: 'klein' }).id];
    await sleep(10);
    // Production has worked alone for longer than the limit when development arrives: it still has its hold.
    t += 5000;
    ids.push(b.submit('comfy', { name: 'p2' }, { client: 'prod', model: 'klein' }).id);
    ids.push(b.submit('comfy', { name: 'd1' }, { client: 'dev', model: 'klein' }).id);
    g.open();
    await settle(b, ...ids);
    expect(runs(log)).toEqual(['p1', 'p2', 'd1']);
  });

  it("does not fail work because another program's unload failed", async () => {
    const log: string[] = [];
    let failures = 1;
    const speech: GpuAdapter<W> = {
      ...fake('speech', log),
      unload: async () => {
        if (failures-- > 0) throw new Error('no answer to "unload"');
        log.push('unload speech');
      },
    };
    const b = new Broker({ comfy: fake('comfy', log), speech }, { graceMs: 0, settleMs: 0, log: () => {} });
    expect(await b.claim('speech', 'runner')).toBe(true);
    const it = b.submit('comfy', { name: 'paint' }, { client: 'prod', model: 'klein' });
    await settle(b, it.id);
    expect(it.state).toBe('done');
    // Cleared again as from an unknown state: speech was asked a second time, before the work ran.
    expect(log.slice(log.indexOf('unload speech'))).toEqual(['unload speech', 'run paint']);
  });

  it('sends nothing to the program for work canceled while the GPU was being cleared', async () => {
    const log: string[] = [];
    const g = gate();
    const b = new Broker({ comfy: { ...fake('comfy', log), unload: () => g.p } }, { graceMs: 0, log: () => {} });
    const it = b.submit('comfy', { name: 'paint' }, { client: 'prod' });
    await sleep(10);
    expect(it.state).toBe('running');
    expect(b.cancel(it.id)).toBe(true);
    g.open();
    await settle(b, it.id);
    expect(it.state).toBe('cancelled');
    expect(runs(log)).toEqual([]);
  });
});
