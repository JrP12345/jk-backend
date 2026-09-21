import crypto from "node:crypto";
import { verifyEnv } from "../utilities/config.ts";
import { startDisruptionTimeoutJob, stopDisruptionTimeoutJob } from "../jobs/disruptionTimeoutJob.ts";
import { acquireOrRenewWorkerLease, releaseWorkerLease } from "../utilities/workerLease.ts";

verifyEnv();
await import("../db.ts");
// This scheduler runs only in a worker process. Its MongoDB lease ensures that
// horizontally scaled worker pods elect one active scheduler at a time.
const leaseName = "disruption-timeout-sweeper";
const holderId = `${process.env.HOSTNAME || "worker"}:${process.pid}:${crypto.randomUUID()}`;
const sweepIntervalMs = positiveDurationFromEnv("DISRUPTION_TIMEOUT_SWEEP_INTERVAL_MS", 5 * 60 * 1000, 1_000);
const leaseDurationMs = positiveDurationFromEnv("DISRUPTION_TIMEOUT_LEASE_MS", 15 * 60 * 1000, 30_000);
const heartbeatMs = positiveDurationFromEnv(
  "DISRUPTION_TIMEOUT_LEASE_HEARTBEAT_MS",
  Math.min(60_000, Math.floor(leaseDurationMs / 3)),
  1_000,
);

if (heartbeatMs >= leaseDurationMs) {
  throw new Error("DISRUPTION_TIMEOUT_LEASE_HEARTBEAT_MS must be shorter than DISRUPTION_TIMEOUT_LEASE_MS");
}

let leader = false;
let reconciling = false;
let heartbeat: ReturnType<typeof setInterval> | null = null;

function positiveDurationFromEnv(name: string, fallback: number, minimum: number): number {
  const configured = process.env[name];
  if (!configured) return fallback;
  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${name} must be a number of milliseconds of at least ${minimum}`);
  }
  return Math.floor(parsed);
}

async function reconcileLeadership() {
  if (reconciling) return;
  reconciling = true;
  try {
    const ownsLease = await acquireOrRenewWorkerLease({
      name: leaseName,
      holderId,
      leaseMs: leaseDurationMs,
    });

    if (ownsLease && !leader) {
      leader = true;
      startDisruptionTimeoutJob(sweepIntervalMs);
      console.log(`[DisruptionTimeoutWorker] Elected scheduler leader (${holderId})`);
    } else if (!ownsLease && leader) {
      leader = false;
      stopDisruptionTimeoutJob();
      console.warn("[DisruptionTimeoutWorker] Scheduler lease lost; stopping local sweeper");
    }
  } catch (error) {
    // Continuing scheduled work without being able to renew the durable lease
    // would allow an isolated worker to act as a second leader.
    if (leader) {
      leader = false;
      stopDisruptionTimeoutJob();
    }
    console.error("[DisruptionTimeoutWorker] Unable to reconcile scheduler lease:", error);
  } finally {
    reconciling = false;
  }
}

await reconcileLeadership();
heartbeat = setInterval(() => {
  void reconcileLeadership();
}, heartbeatMs);
console.log("Disruption timeout worker started; awaiting scheduler leadership");

const shutdown = async () => {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  stopDisruptionTimeoutJob();
  try {
    await releaseWorkerLease(leaseName, holderId);
  } catch (error) {
    console.error("[DisruptionTimeoutWorker] Failed to release scheduler lease:", error);
  }
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
