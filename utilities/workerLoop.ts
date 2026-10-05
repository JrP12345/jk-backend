/** One awaited batch at a time, with adaptive idle polling and drain support. */
export class WorkerLoop {
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private stopped = true;
  private idleMs = 0;
  private lastCompletedAt = Date.now();
  private failures = 0;
  start(work: () => Promise<any>, baseMs: number) {
    if (!this.stopped) return;
    this.stopped = false;
    this.idleMs = baseMs;
    const tick = () => {
      if (this.stopped) return;
      this.active = (async () => {
        try {
          const result = await work();
          this.lastCompletedAt = Date.now();
          this.idleMs = result?.processed ? baseMs : Math.min(Math.max(baseMs, 15_000), Math.max(baseMs, this.idleMs * 2));
        } catch {
          this.failures++;
          this.idleMs = Math.min(Math.max(baseMs, 15_000), Math.max(baseMs, this.idleMs * 2));
          console.error("[WorkerLoop] Batch failed; retrying with bounded backoff");
        }
      })().finally(() => {
        this.active = undefined;
        if (!this.stopped) {
          this.timer = setTimeout(tick, this.idleMs + Math.floor(Math.random() * this.idleMs * 0.2));
          this.timer.unref?.();
        }
      });
    };
    this.timer = setTimeout(tick, baseMs);
    this.timer.unref?.();
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    // Provider deadlines bound normal completion. Container grace exceeds this.
    if (this.active) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.active, new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Worker drain deadline exceeded; durable leases will recover unfinished work")), 45_000);
          timeout.unref?.();
        })]);
      } finally { clearTimeout(timeout); }
    }
  }
  progress() { return { running: !this.stopped, active: !!this.active, lastCompletedAt: this.lastCompletedAt, failures: this.failures, idleMs: this.idleMs }; }
}
