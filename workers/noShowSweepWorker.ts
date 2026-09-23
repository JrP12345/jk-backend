import crypto from "node:crypto";
import { verifyEnv } from "../utilities/config.ts";
import { startNoShowSweepJob, stopNoShowSweepJob } from "../jobs/noShowSweepJob.ts";
import { acquireOrRenewWorkerLease, releaseWorkerLease } from "../utilities/workerLease.ts";
import { startWorkerHealthServer } from "./workerHealthServer.ts";

verifyEnv();
await import("../db.ts");

const leaseName = "no-show-sweeper";
const holderId = `${process.env.HOSTNAME || "worker"}:${process.pid}:${crypto.randomUUID()}`;
const sweepIntervalMs = positiveDurationFromEnv("NO_SHOW_SWEEP_INTERVAL_MS", 5 * 60 * 1000, 1_000);
const leaseDurationMs = positiveDurationFromEnv("NO_SHOW_LEASE_MS", 15 * 60 * 1000, 30_000);
const heartbeatMs = positiveDurationFromEnv(
  "NO_SHOW_LEASE_HEARTBEAT_MS",
  Math.min(60_000, Math.floor(leaseDurationMs / 3)),
  1_000,
);

if (heartbeatMs >= leaseDurationMs) {
  throw new Error("NO_SHOW_LEASE_HEARTBEAT_MS must be shorter than NO_SHOW_LEASE_MS");
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
      startNoShowSweepJob(sweepIntervalMs);
      console.log(`[NoShowSweepWorker] Elected scheduler leader (${holderId})`);
    } else if (!ownsLease && leader) {
      leader = false;
      stopNoShowSweepJob();
      console.warn("[NoShowSweepWorker] Scheduler lease lost; stopping local sweeper");
    }
  } catch (error) {
    if (leader) {
      leader = false;
      stopNoShowSweepJob();
      console.error("[NoShowSweepWorker] Failed to reconcile lease; demoting from leader", error);
    }
  } finally {
    reconciling = false;
  }
}

async function main() {
  await reconcileLeadership();
  heartbeat = setInterval(() => {
    reconcileLeadership().catch((error) => {
      console.error("[NoShowSweepWorker] Unexpected error in leadership heartbeat", error);
    });
  }, heartbeatMs);

  const healthPort = Number(process.env.WORKER_HEALTH_PORT) || 5005;
  startWorkerHealthServer({
    port: healthPort,
    workerName: "noShowSweepWorker",
    getExtraMetrics: () => ({
      leader,
      leaseName,
      sweepIntervalMs,
    }),
  });
}

main().catch((error) => {
  console.error("[NoShowSweepWorker] Fatal startup error:", error);
  process.exit(1);
});

async function shutdown() {
  if (heartbeat) clearInterval(heartbeat);
  stopNoShowSweepJob();
  if (leader) {
    try {
      await releaseWorkerLease(leaseName, holderId);
      console.log("[NoShowSweepWorker] Released worker lease during shutdown");
    } catch (error) {
      console.error("[NoShowSweepWorker] Error releasing lease during shutdown:", error);
    }
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
