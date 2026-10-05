import crypto from "node:crypto";
import { disruptionService } from "../services/disruptionService.ts";
import { WorkerLoop } from "../utilities/workerLoop.ts";
import { acquireOrRenewWorkerLease, releaseWorkerLease } from "../utilities/workerLease.ts";

const loop = new WorkerLoop();
export const getDisruptionTimeoutProgress = () => loop.progress();
const disruptionHolderId = `${process.env.HOSTNAME || "api"}:${process.pid}:${crypto.randomUUID()}`;

/**
 * Periodically sweeps for appointments in disruption_triage whose 60-minute window
 * has expired without patient action, and automatically cancels & refunds them.
 */
export async function runDisruptionTimeoutSweep() {
  try {
    const result = await disruptionService.processDisruptionTimeout();
    if (result.autoCancelledCount > 0) {
      console.log(`[DisruptionTimeoutJob] Auto-cancelled ${result.autoCancelledCount} expired disruption appointments.`);
    }
    return result;
  } catch (err) {
    console.error("[DisruptionTimeoutJob] Error during disruption sweep:", err);
    return { autoCancelledCount: 0, error: err };
  }
}

export function startDisruptionTimeoutJob(intervalMs = 5 * 60 * 1000) {
  loop.start(async () => {
    const name = 'disruption-timeout-sweeper';
    const ownsLease = await acquireOrRenewWorkerLease({ name, holderId: disruptionHolderId, leaseMs: 120_000 });
    if (!ownsLease) return { processed: 0 };
    const heartbeat = setInterval(() => { void acquireOrRenewWorkerLease({ name, holderId: disruptionHolderId, leaseMs: 120_000 }).catch(() => console.error('[DisruptionTimeoutJob] Lease renewal failed')); }, 20_000);
    heartbeat.unref?.();
    try { const result = await runDisruptionTimeoutSweep(); if ("error" in result) throw result.error; return { processed: 1 }; }
    finally { clearInterval(heartbeat); await releaseWorkerLease(name, disruptionHolderId); }
  }, intervalMs);
}
export async function stopDisruptionTimeoutJob() { await loop.stop(); }
