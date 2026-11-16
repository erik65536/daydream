/**
 * A speech engine with no model, for tests: each line "speaks" a quiet tone of its length, in 100 ms pieces as fast
 * as asked (`realtime` paces them as a real engine would).
 */
import { sayMs, type EngineName, type EngineStatus, type LineEvents, type LineRequest, type SpeechEngine } from './engine.ts';

export class FakeEngine implements SpeechEngine {
  readonly spoken: LineRequest[] = [];
  ready = true;
  private active = new Map<string, { req: LineRequest; ev: LineEvents; timer?: ReturnType<typeof setTimeout> }>();
  private waiting: { req: LineRequest; ev: LineEvents }[] = [];
  readonly name: EngineName;
  slots: number;
  private realtime: boolean;

  constructor(name: EngineName = 'cpu', slots = 2, realtime = false) {
    this.name = name;
    this.slots = slots;
    this.realtime = realtime;
  }

  canStart(ms: number, _priority = 0): boolean {
    return this.ready && (this.active.size < this.slots || ms > 5000);
  }

  speak(req: LineRequest, ev: LineEvents) {
    this.waiting.push({ req, ev });
    this.next();
  }

  private next() {
    while (this.active.size < this.slots && this.waiting.length) {
      const { req, ev } = this.waiting.shift()!;
      if (Date.now() > req.deadline) {
        ev.end('expired');
        continue;
      }
      this.spoken.push(req);
      const line = { req, ev } as { req: LineRequest; ev: LineEvents; timer?: ReturnType<typeof setTimeout> };
      this.active.set(req.lineId, line);
      ev.started(24000);
      let left = Math.max(1, Math.round(sayMs(req.text) / 100));
      const piece = () => {
        if (!this.active.has(req.lineId)) return;
        const pcm = new Int16Array(2400);
        for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(i / 8) * 800);
        ev.audio(new Uint8Array(pcm.buffer));
        if (--left > 0) line.timer = setTimeout(piece, this.realtime ? 100 : 0);
        else {
          this.active.delete(req.lineId);
          ev.end('done');
          this.next();
        }
      };
      line.timer = setTimeout(piece, 0);
    }
  }

  cancel(lineId: string) {
    const a = this.active.get(lineId);
    if (a) {
      clearTimeout(a.timer);
      this.active.delete(lineId);
      a.ev.end('cancelled');
      this.next();
      return;
    }
    const i = this.waiting.findIndex((w) => w.req.lineId === lineId);
    if (i >= 0) this.waiting.splice(i, 1)[0]!.ev.end('cancelled');
  }

  prepare() {}

  status(): EngineStatus {
    return { name: this.name, ready: this.ready, slots: this.slots, free: this.slots - this.active.size, waiting: this.waiting.length };
  }

  stop() {
    for (const id of [...this.active.keys()]) this.cancel(id);
  }
}
