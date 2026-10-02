import crypto from "node:crypto";
import { cleanupBrandingAssets } from "../services/OrganizationBranding.ts";
import { acquireOrRenewWorkerLease } from "../utilities/workerLease.ts";
const holderId = `${process.pid}:${crypto.randomUUID()}`;
let timer: NodeJS.Timeout | null = null;
export function startOrganizationBrandingJob() {
  if (timer) return;
  timer = setInterval(async () => {
    try {
      if (await acquireOrRenewWorkerLease({ name: "organization-branding-cleanup", holderId, leaseMs: 20 * 60_000 })) await cleanupBrandingAssets();
    } catch (error) { console.error("organization.branding.job.failed", error); }
  }, 10 * 60_000);
  timer.unref();
}
export function stopOrganizationBrandingJob() { if (timer) clearInterval(timer); timer = null; }
