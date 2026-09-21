import { verifyEnv } from "../utilities/config.ts";
import { domainEventDeliveryWorker } from "../services/DomainEventDeliveryWorker.ts";
import "../notifications/services/NotificationService.ts";
import { ClinicalSearchService } from "../services/ClinicalSearchService.ts";

verifyEnv();
await import("../db.ts");

ClinicalSearchService.registerEventListeners();
domainEventDeliveryWorker.start();
console.log("Domain event worker started");

const shutdown = async () => {
  await domainEventDeliveryWorker.stop();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
