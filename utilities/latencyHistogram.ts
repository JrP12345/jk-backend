/** Fixed buckets: percentiles are upper bounds, not sampled exact values. */
export class LatencyHistogram {
  readonly bounds = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, Infinity];
  private counts = this.bounds.map(() => 0);
  private total = 0;
  observe(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.counts[this.bounds.findIndex(bound => ms <= bound)]!++;
    this.total++;
  }
  snapshot() {
    const percentile = (fraction: number) => {
      if (!this.total) return null;
      let count = 0;
      for (let i = 0; i < this.counts.length; i++) { count += this.counts[i]!; if (count >= Math.ceil(this.total * fraction)) return Number.isFinite(this.bounds[i]) ? this.bounds[i] : null; }
      return null;
    };
    return { count: this.total, buckets: this.bounds.map((upperMs, i) => ({ upperMs: Number.isFinite(upperMs) ? upperMs : null, count: this.counts[i] })), p95UpperMs: percentile(0.95), p99UpperMs: percentile(0.99) };
  }
}
export const databaseLatency = new LatencyHistogram();
export const databasePoolMetrics = { checkedOut: 0, checkoutFailures: 0 };
