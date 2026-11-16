type SavePhase = "authority" | "readiness" | "command" | "prepare" | "stock" | "documents" | "payment" | "finalize";

/** Bounded, request-local durations only. No command, patient, product or payment values. */
export class PharmacySaveTimings {
  private durations = new Map<SavePhase, number>();
  start(phase: SavePhase) {
    const started = performance.now();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.durations.set(phase, (this.durations.get(phase) || 0) + performance.now() - started);
    };
  }
  async measure<T>(phase: SavePhase, action: () => Promise<T>): Promise<T> {
    const finish = this.start(phase);
    try { return await action(); } finally { finish(); }
  }
  header(totalMs: number) {
    return [`counter_save;dur=${totalMs.toFixed(1)}`, ...Array.from(this.durations, ([phase, duration]) => `counter_${phase};dur=${duration.toFixed(1)}`)].join(", ");
  }
}
