import { verifyEnv } from "../utilities/config.ts";
import { domainEventDeliveryWorker } from "../services/DomainEventDeliveryWorker.ts";
import "../notifications/services/NotificationService.ts";
import { ClinicalSearchService } from "../services/ClinicalSearchService.ts";
import { startWorkerHealthServer } from "../utilities/workerHealthServer.ts";

verifyEnv();
await import("../db.ts");

ClinicalSearchService.registerEventListeners();
domainEventDeliveryWorker.start();
console.log("[DomainEventWorker] Worker started successfully");

// Independent Health & Metrics Reporting Server
const healthServer = startWorkerHealthServer({
  workerName: "domain-event-worker",
  defaultPort: 5004,
  envPortVar: "WORKER_HEALTH_PORT",
  onMetrics: () => domainEventDeliveryWorker.getMetrics(),
});

const shutdown = async () => {
  console.log("[DomainEventWorker] Graceful shutdown initiated...");
  await healthServer.stop();
  await domainEventDeliveryWorker.stop();
  console.log("[DomainEventWorker] Worker stopped cleanly.");
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
