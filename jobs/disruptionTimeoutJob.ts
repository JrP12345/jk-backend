import crypto from "node:crypto";
import { disruptionService } from "../services/disruptionService.ts";
import { WorkerLoop } from "../utilities/workerLoop.ts";
import { acquireOrRenewWorkerLease, releaseWorkerLease } from "../utilities/workerLease.ts";
import { WorkerLease } from '../models/WorkerLease.ts';

const loop = new WorkerLoop();
export const getDisruptionTimeoutProgress = () => loop.progress();
const disruptionHolderId = `${process.env.HOSTNAME || "api"}:${process.pid}:${crypto.randomUUID()}`;

/**
 * Periodically sends unanswered disruption to staff review. This never cancels
 * care or initiates refunds based on an unanswered or undelivered message.
 */
export async function runDisruptionTimeoutSweep(fence?: () => Promise<void>) {
  try {
    const result = await disruptionService.processDisruptionTimeout(fence);
    if (result.reviewRequiredCount > 0) {
      console.log(`[DisruptionTimeoutJob] ${result.reviewRequiredCount} unanswered disruption appointments require staff review.`);
    }
    return result;
  } catch (err) {
    console.error("[DisruptionTimeoutJob] Error during disruption sweep:", err);
    return { autoCancelledCount: 0, reviewRequiredCount: 0, error: err };
  }
}

export function startDisruptionTimeoutJob(intervalMs = 5 * 60 * 1000) {
  loop.start(async () => {
    const name = 'disruption-timeout-sweeper';
    const ownsLease = await acquireOrRenewWorkerLease({ name, holderId: disruptionHolderId, leaseMs: 120_000 });
    if (!ownsLease) return { processed: 0 };
    try {
      const result = await runDisruptionTimeoutSweep(async () => {
        const fence = await WorkerLease.updateOne({ name, holderId: disruptionHolderId, expiresAt: { $gt: new Date() } }, { $inc: { fenceRevision: 1 }, $set: { expiresAt: new Date(Date.now() + 120_000) } });
        if (fence.matchedCount !== 1) throw new Error('Disruption review scheduler lease lost');
      });
      if ('error' in result) throw result.error;
      return { processed: result.reviewRequiredCount };
    } finally { await releaseWorkerLease(name, disruptionHolderId); }
  }, intervalMs);
}
export async function stopDisruptionTimeoutJob() { await loop.stop(); }
