import { verifyEnv } from "../utilities/config.ts";
import { domainEventDeliveryWorker } from "../services/DomainEventDeliveryWorker.ts";
import "../notifications/services/NotificationService.ts";
import '../services/AppointmentCommunicationEvents.ts';
import '../services/PaymentReceiptEvents.ts';
import '../services/DoctorAssignmentRecoveryEvents.ts';
import { startCrmReminderJob, stopCrmReminderJob } from '../jobs/crmReminderJob.ts';
import { startWorkerHealthServer } from "../utilities/workerHealthServer.ts";

verifyEnv();
await import("../db.ts");

domainEventDeliveryWorker.start();
startCrmReminderJob();
console.log("[DomainEventWorker] Worker started successfully");

// Independent Health & Metrics Reporting Server
const healthServer = startWorkerHealthServer({
  workerName: "domain-event-worker",
  defaultPort: 5004,
  envPortVar: "WORKER_HEALTH_PORT",
  onProgress: () => domainEventDeliveryWorker.getProgress(),
  onMetrics: () => domainEventDeliveryWorker.getMetrics(),
});

const shutdown = async () => {
  console.log("[DomainEventWorker] Graceful shutdown initiated...");
  await domainEventDeliveryWorker.stop();
  await stopCrmReminderJob();
  console.log("[DomainEventWorker] Worker stopped cleanly.");
  await healthServer.stop();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
