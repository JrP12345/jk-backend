import crypto from "node:crypto";
import { disruptionService } from "../services/disruptionService.ts";
import { acquireOrRenewWorkerLease } from "../utilities/workerLease.ts";

let intervalHandle: NodeJS.Timeout | null = null;
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

export function startDisruptionTimeoutJob(intervalMs: number = 5 * 60 * 1000) {
  if (intervalHandle) return;

  console.log(`[DisruptionTimeoutJob] Starting disruption timeout sweeper (interval: ${intervalMs}ms)`);
  intervalHandle = setInterval(async () => {
    try {
      const ownsLease = await acquireOrRenewWorkerLease({
        name: "disruption-timeout-sweeper",
        holderId: disruptionHolderId,
        leaseMs: Math.max(intervalMs * 2, 60_000),
      });
      if (!ownsLease) {
        return;
      }
      await runDisruptionTimeoutSweep();
    } catch (err: any) {
      console.warn("[DisruptionTimeoutJob] Lock acquisition failed; failing safely:", err.message);
    }
  }, intervalMs);
  // Do not block process exit in tests
  if (intervalHandle.unref) {
    intervalHandle.unref();
  }
}

export function stopDisruptionTimeoutJob() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log("[DisruptionTimeoutJob] Disruption timeout sweeper stopped.");
  }
}
