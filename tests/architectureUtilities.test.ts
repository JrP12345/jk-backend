import { afterEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { WorkerLoop } from "../utilities/workerLoop.ts";
import { withConcurrencyBudget } from "../utilities/concurrencyBudget.ts";
import { LatencyHistogram } from "../utilities/latencyHistogram.ts";
import { createDomainEvent } from "../platform/events/DomainEvent.ts";
import { EventEmitter } from "node:events";
import { requestCancellationSignal } from "../utilities/requestCancellation.ts";

afterEach(() => vi.useRealTimers());
describe("Architecture utility regressions", () => {
  it("cancels unfinished disconnects and removes listeners without cancelling completed responses", () => {
    for (const completed of [false, true]) {
      const request = new EventEmitter();
      const response = Object.assign(new EventEmitter(), { writableEnded: completed });
      const signal = requestCancellationSignal({ raw: request } as any, { raw: response } as any);
      expect(signal.aborted).toBe(false);
      response.emit("close");
      expect(signal.aborted).toBe(!completed);
      expect(request.listenerCount("aborted")).toBe(0);
      expect(response.listenerCount("close")).toBe(0);
    }
    const request = new EventEmitter();
    const response = Object.assign(new EventEmitter(), { writableEnded: false });
    const signal = requestCancellationSignal({ raw: request } as any, { raw: response } as any);
    request.emit("aborted");
    expect(signal.aborted).toBe(true);
    response.emit("close");
  });
  it("fails closed when a production concurrency lease cannot be coordinated", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      await expect(withConcurrencyBudget("coordination-unavailable", 1, async () => "unsafe")).rejects.toMatchObject({ statusCode: 503 });
    } finally { vi.unstubAllEnvs(); }
  });
  it("does not overlap batches, backs off while idle and waits for active work during stop", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const work = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const loop = new WorkerLoop();
    loop.start(work, 100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(2000);
    expect(work).toHaveBeenCalledTimes(1);
    let drained = false;
    const stop = loop.stop().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish(); await stop;
    expect(loop.progress()).toMatchObject({ running: false, active: false, idleMs: 200 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(work).toHaveBeenCalledTimes(1);
  });
  it("rejects excess concurrent work and releases capacity on failure", async () => {
    let finish!: () => void;
    const first = withConcurrencyBudget("utility-regression", 1, () => new Promise<void>(resolve => { finish = resolve; }));
    await expect(withConcurrencyBudget("utility-regression", 1, async () => {})).rejects.toMatchObject({ statusCode: 429 });
    finish(); await first;
    await expect(withConcurrencyBudget("utility-regression", 1, async () => { throw new Error("failure"); })).rejects.toThrow("failure");
    expect(await withConcurrencyBudget("utility-regression", 1, async () => "available")).toBe("available");
  });
  it("preserves BSON types in the supplemental recovery format and stable event identity", () => {
    const source = { _id: new mongoose.Types.ObjectId(), at: new Date(), amount: new mongoose.mongo.Double(1), sequence: mongoose.mongo.Long.fromNumber(42) };
    const encoded = mongoose.mongo.BSON.EJSON.stringify(source, { relaxed: false });
    const restored = mongoose.mongo.BSON.EJSON.parse(encoded, { relaxed: false });
    expect(restored._id.equals(source._id)).toBe(true);
    expect(restored.at).toBeInstanceOf(Date);
    expect(restored.amount).toBeInstanceOf(mongoose.mongo.Double);
    expect(restored.sequence).toBeInstanceOf(mongoose.mongo.Long);
    expect(createDomainEvent("PROBE", { eventId: "durable-original" }).eventId).toBe("durable-original");
  });
  it("reports fixed-memory percentile upper bounds", () => {
    const histogram = new LatencyHistogram();
    for (let i = 0; i < 95; i++) histogram.observe(40);
    for (let i = 0; i < 5; i++) histogram.observe(800);
    expect(histogram.snapshot()).toMatchObject({ count: 100, p95UpperMs: 50, p99UpperMs: 1000 });
  });
});
