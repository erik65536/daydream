/**
 * The order a build's image work takes on the one local GPU. Tasks run one at a time, most urgent first, but a task
 * for the model already loaded counts as SWITCH more urgent than it is: switching models costs a load (about 20 s for
 * Klein, 10 s for Qwen), and a place's painting and its reading use different models when Qwen reads the maps (GPT
 * Image, the default reader, needs no GPU). So the starting town (priority
 * 0) still goes before everything, a region's places (1 and up for the first region, 2 for the next) before the next
 * region's, then art (10), voices (20), and sounds (30); but the places of one region, a hundredth apart, take turns by
 * model: Klein paints each of them that is waiting, then Qwen reads them all, rather than each place's painting and
 * reading alternating with the next place's. While Luna judges a painting, the GPU goes on to the next place's work.
 *
 * Places come first: a build holds its other work (art, voices, sounds) back until every place is painted and settled
 * (`holdFrom`). A place's GPU work is followed by work elsewhere (Luna's checks, GPT's reading, settling on the CPU)
 * and the world waits on all of it, while the rest is GPU work with nothing after it. So the rest goes last, and
 * nothing that starts first (work that needs no Luna call before its first GPU task) takes the GPU from a place.
 *
 * Loading and unloading is the GPU broker's job (every ComfyUI call goes through it); this only orders whole tasks so
 * their calls are not interleaved. Text work (Luna) runs alongside, unlimited by it.
 */

import { AsyncResource } from 'node:async_hooks';
import { report, touch, type WorkTag } from '../gpu/presence.ts';

/** How much more urgent a task for the loaded model counts (see the file comment). */
const SWITCH = 0.5;

/**
 * Which model a task mostly loads (a place's painting and its edits Klein, its reading Qwen's edit; sounds Stable
 * Audio's two; voices the broker's speech service).
 */
export type GpuModel = 'klein' | 'reader' | 'sound-small' | 'sound-medium' | 'speech';

interface Task {
  model: GpuModel;
  /** Lower runs first. */
  priority: number;
  run: () => Promise<void>;
  cancel: (e: Error) => void;
}

export class GpuQueue {
  private tasks: Task[] = [];
  private loaded: GpuModel | null = null;
  private busy = false;
  private running: { model: GpuModel; priority: number; since: number } | undefined;
  /** Tasks of this priority or later wait (see `holdFrom`). */
  private heldFrom = Infinity;
  /** Shown on the admin GPU page while the queue has work. */
  private unreport: (() => void) | null = null;
  private readonly stopped: () => boolean;
  private readonly tag?: WorkTag;

  constructor(stopped: () => boolean = () => false, tag?: WorkTag) {
    this.stopped = stopped;
    this.tag = tag;
  }

  /** Run `fn` when its turn comes (in its caller's call context, not the queue's); resolves with its result. */
  run<T>(model: GpuModel, priority: number, fn: () => Promise<T>): Promise<T> {
    const inCaller = AsyncResource.bind(fn);
    return new Promise<T>((resolve, reject) => {
      this.tasks.push({ model, priority, run: () => inCaller().then(resolve, reject), cancel: reject });
      this.unreport ??= report(() => ({ builds: [{ tag: this.tag, running: this.running, pending: this.tasks.map((t) => ({ model: t.model, priority: t.priority })).sort((a, b) => a.priority - b.priority) }] }));
      touch();
      void this.pump();
    });
  }

  /** Hold tasks of `priority` or later back until `until` settles (a build's places before everything else). */
  holdFrom(priority: number, until: Promise<unknown>) {
    this.heldFrom = Math.min(this.heldFrom, priority);
    const lift = () => {
      this.heldFrom = Infinity;
      void this.pump();
    };
    until.then(lift, lift);
  }

  private next(): Task | undefined {
    // A stopped queue cancels everything, held or not.
    const ready = this.stopped() ? this.tasks : this.tasks.filter((t) => t.priority < this.heldFrom);
    if (!ready.length) return undefined;
    const rank = (t: Task) => t.priority + (t.model === this.loaded ? 0 : SWITCH);
    const t = ready.reduce((a, b) => (rank(b) < rank(a) ? b : a));
    this.tasks.splice(this.tasks.indexOf(t), 1);
    return t;
  }

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let t = this.next(); t; t = this.next()) {
        if (this.stopped()) {
          t.cancel(new Error('cancelled'));
          continue;
        }
        this.loaded = t.model;
        this.running = { model: t.model, priority: t.priority, since: Date.now() };
        touch();
        await t.run();
        this.running = undefined;
      }
    } finally {
      this.busy = false;
      this.running = undefined;
      // Held tasks still show as waiting.
      if (!this.tasks.length) {
        this.unreport?.();
        this.unreport = null;
      }
    }
  }
}
