import http from "node:http";
import { verifyEnv } from "../utilities/config.ts";
import { domainEventDeliveryWorker } from "../services/DomainEventDeliveryWorker.ts";
import "../notifications/services/NotificationService.ts";
import { ClinicalSearchService } from "../services/ClinicalSearchService.ts";

verifyEnv();
await import("../db.ts");

ClinicalSearchService.registerEventListeners();
domainEventDeliveryWorker.start();
console.log("[DomainEventWorker] Worker started successfully");

// Independent Health & Metrics Reporting Server
const HEALTH_PORT = process.env.WORKER_HEALTH_PORT ? Number(process.env.WORKER_HEALTH_PORT) : 5004;
let healthServer: http.Server | null = null;

try {
  healthServer = http.createServer(async (req, res) => {
    if (req.url === "/health" || req.url === "/api/health/liveness") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          worker: "domain-event-worker",
          uptime: process.uptime(),
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    if (req.url === "/metrics" || req.url === "/api/health/metrics") {
      try {
        const metrics = await domainEventDeliveryWorker.getMetrics();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", worker: "domain-event-worker", metrics }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", error: err?.message || "Failed to fetch metrics" }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  healthServer.listen(HEALTH_PORT, () => {
    console.log(`[DomainEventWorker] Independent health reporting server listening on port ${HEALTH_PORT}`);
  });
} catch (serverErr) {
  console.warn("[DomainEventWorker] Health server could not be bound (optional):", serverErr);
}

const shutdown = async () => {
  console.log("[DomainEventWorker] Graceful shutdown initiated...");
  if (healthServer) {
    await new Promise<void>((resolve) => healthServer!.close(() => resolve()));
  }
  await domainEventDeliveryWorker.stop();
  console.log("[DomainEventWorker] Worker stopped cleanly.");
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
