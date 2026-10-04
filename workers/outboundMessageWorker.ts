import { startWorkerHealthServer } from "../utilities/workerHealthServer.ts";
import { verifyEnv } from "../utilities/config.ts";
import { outboundMessageDeliveryWorker } from "../services/OutboundMessageDeliveryWorker.ts";
import { whatsAppWebhookWorker } from "../services/WhatsAppWebhookService.ts";
import { startBillingReconciliationJob, stopBillingReconciliationJob } from "../jobs/billingReconciliationJob.ts";
import { startOrganizationBrandingJob, stopOrganizationBrandingJob } from "../jobs/organizationBrandingJob.ts";

verifyEnv();
await import("../db.ts");
outboundMessageDeliveryWorker.start();
whatsAppWebhookWorker.start();
// These existing lease-protected jobs otherwise have no owner with RUN_INLINE_JOBS=false.
startBillingReconciliationJob();
startOrganizationBrandingJob();
console.log("Outbound message worker started");

const healthServer = startWorkerHealthServer({ workerName: "outboundMessageWorker", defaultPort: 5002 });

const shutdown = async () => {
  stopBillingReconciliationJob();
  stopOrganizationBrandingJob();
  await healthServer.stop();
  await outboundMessageDeliveryWorker.stop();
  await whatsAppWebhookWorker.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
