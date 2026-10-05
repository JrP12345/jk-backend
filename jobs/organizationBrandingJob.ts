import crypto from "node:crypto";
import { cleanupBrandingAssets } from "../services/OrganizationBranding.ts";
import { cleanupExpiredUploads } from "../services/UploadCleanupService.ts";
import { acquireOrRenewWorkerLease, releaseWorkerLease } from "../utilities/workerLease.ts";
import { WorkerLoop } from "../utilities/workerLoop.ts";
const holderId = crypto.randomUUID();
const loop = new WorkerLoop();
export function startOrganizationBrandingJob() {
  loop.start(async () => {
    if (!await acquireOrRenewWorkerLease({ name: "organization-branding-cleanup", holderId, leaseMs: 120_000 })) return { processed: 1 };
    const heartbeat = setInterval(() => { void acquireOrRenewWorkerLease({ name: "organization-branding-cleanup", holderId, leaseMs: 120_000 }).catch(() => console.error("storage.cleanup.lease.failed")); }, 20_000);
    heartbeat.unref?.();
    try { await cleanupBrandingAssets(); await cleanupExpiredUploads(); return { processed: 1 }; }
    finally { clearInterval(heartbeat); await releaseWorkerLease("organization-branding-cleanup", holderId); }
  }, 10 * 60_000);
}
export async function stopOrganizationBrandingJob() { await loop.stop(); }
