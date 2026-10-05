import { startWorkerHealthServer } from "../utilities/workerHealthServer.ts";
import { verifyEnv } from "../utilities/config.ts";
import { outboundMessageDeliveryWorker } from "../services/OutboundMessageDeliveryWorker.ts";
import { whatsAppWebhookWorker } from "../services/WhatsAppWebhookService.ts";
import { startBillingReconciliationJob, stopBillingReconciliationJob } from "../jobs/billingReconciliationJob.ts";
import { startOrganizationBrandingJob, stopOrganizationBrandingJob } from "../jobs/organizationBrandingJob.ts";
import { markShuttingDown } from "../utilities/readiness.ts";

verifyEnv();
await import("../db.ts");
outboundMessageDeliveryWorker.start();
whatsAppWebhookWorker.start();
// These existing lease-protected jobs otherwise have no owner with RUN_INLINE_JOBS=false.
startBillingReconciliationJob();
startOrganizationBrandingJob();
console.log("Outbound message worker started");

const healthServer = startWorkerHealthServer({ workerName: "outboundMessageWorker", defaultPort: 5002, onProgress: () => [outboundMessageDeliveryWorker.getProgress(), whatsAppWebhookWorker.getProgress()], onMetrics: () => outboundMessageDeliveryWorker.getMetrics() });

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  markShuttingDown();
  const deadline = setTimeout(() => process.exit(1), 55_000);
  deadline.unref();
  try {
    await Promise.all([stopBillingReconciliationJob(), stopOrganizationBrandingJob(), outboundMessageDeliveryWorker.stop(), whatsAppWebhookWorker.stop()]);
    await healthServer.stop();
    clearTimeout(deadline);
    process.exit(0);
  } catch {
    console.error("Outbound worker drain failed; durable leases will recover unfinished work");
    process.exit(1);
  }
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
