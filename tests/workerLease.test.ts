import { beforeEach, describe, expect, it } from "vitest";
import { WorkerLease } from "../models/WorkerLease.ts";
import { acquireOrRenewWorkerLease, releaseWorkerLease } from "../utilities/workerLease.ts";

describe("Worker scheduler lease", () => {
  const leaseName = "test-disruption-timeout-sweeper";

  beforeEach(async () => {
    await WorkerLease.deleteMany({ name: leaseName });
    await WorkerLease.createIndexes();
  });

  it("elects exactly one holder when worker replicas race", async () => {
    const [first, second] = await Promise.all([
      acquireOrRenewWorkerLease({ name: leaseName, holderId: "worker-a", leaseMs: 60_000 }),
      acquireOrRenewWorkerLease({ name: leaseName, holderId: "worker-b", leaseMs: 60_000 }),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    const lease = await WorkerLease.findOne({ name: leaseName }).lean();
    expect(["worker-a", "worker-b"]).toContain(lease?.holderId);
  });

  it("allows the holder to renew, then permits takeover after expiry", async () => {
    const start = new Date("2026-09-21T10:00:00.000Z");
    expect(await acquireOrRenewWorkerLease({ name: leaseName, holderId: "worker-a", leaseMs: 60_000, now: start })).toBe(true);
    expect(await acquireOrRenewWorkerLease({ name: leaseName, holderId: "worker-a", leaseMs: 60_000, now: new Date(start.getTime() + 30_000) })).toBe(true);
    expect(await acquireOrRenewWorkerLease({ name: leaseName, holderId: "worker-b", leaseMs: 60_000, now: new Date(start.getTime() + 89_000) })).toBe(false);
    expect(await acquireOrRenewWorkerLease({ name: leaseName, holderId: "worker-b", leaseMs: 60_000, now: new Date(start.getTime() + 91_000) })).toBe(true);
  });

  it("does not let a former holder delete a newer holder's lease", async () => {
    const start = new Date("2026-09-21T10:00:00.000Z");
    await acquireOrRenewWorkerLease({ name: leaseName, holderId: "worker-a", leaseMs: 1_000, now: start });
    await acquireOrRenewWorkerLease({ name: leaseName, holderId: "worker-b", leaseMs: 60_000, now: new Date(start.getTime() + 1_001) });

    await releaseWorkerLease(leaseName, "worker-a");
    expect((await WorkerLease.findOne({ name: leaseName }).lean())?.holderId).toBe("worker-b");
  });
});
