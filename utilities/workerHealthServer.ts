import http from "node:http";
import { checkWorkerReadiness, markShuttingDown } from "./readiness.ts";

export interface WorkerHealthServerOptions {
  workerName: string;
  defaultPort?: number;
  envPortVar?: string;
  onMetrics?: () => Promise<Record<string, any>> | Record<string, any>;
  onProgress?: () => ({ running: boolean; lastCompletedAt: number; idleMs: number; active: boolean } | { running: boolean; lastCompletedAt: number; idleMs: number; active: boolean }[]);
}

export function startWorkerHealthServer(options: WorkerHealthServerOptions): {
  server: http.Server | null;
  stop: () => Promise<void>;
} {
  const envPort = options.envPortVar ? process.env[options.envPortVar] : process.env.WORKER_HEALTH_PORT;
  const port = envPort ? Number(envPort) : options.defaultPort;

  if (!port) {
    return {
      server: null,
      stop: async () => {},
    };
  }

  const server = http.createServer(async (req, res) => {
    const url = req.url?.split("?")[0] || "/";

    if (url === "/health" || url === "/api/health/liveness") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          worker: options.workerName,
          process: {
            pid: process.pid,
            uptime: Math.floor(process.uptime()),
            memoryUsageMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
          },
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    if (url === "/ready" || url === "/api/health/readiness") {
      const report = await checkWorkerReadiness(options.workerName);
      const progress = options.onProgress?.();
      if (progress) {
        report.data.progress = progress;
        if ((Array.isArray(progress) ? progress : [progress]).some(item => !item.running || Date.now() - item.lastCompletedAt > Math.max(120_000, item.idleMs * 4))) { report.statusCode = 503; report.ready = false; report.data.status = "consumer_stalled"; }
      }
      res.writeHead(report.statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(report.data));
      return;
    }

    if (url === "/metrics" && options.onMetrics) {
      try {
        const metrics = await options.onMetrics();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", worker: options.workerName, metrics }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", error: err?.message || "Failed to fetch metrics" }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(port, () => {
    console.log(`[${options.workerName}] Health and readiness server listening on port ${port}`);
  });

  server.on("error", (err) => {
    console.warn(`[${options.workerName}] Health server error:`, err.message);
  });

  const stop = async () => {
    markShuttingDown();
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return { server, stop };
}
