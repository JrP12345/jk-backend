import { disruptionService } from "../services/disruptionService.ts";

let intervalHandle: NodeJS.Timeout | null = null;

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
  intervalHandle = setInterval(runDisruptionTimeoutSweep, intervalMs);
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
