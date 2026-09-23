import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

interface RouteMetric {
  route: string;
  method: string;
  totalCalls: number;
  totalDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  avgDurationMs: number;
  slowRequestsCount: number; // > 500ms
  statusCodes: Record<number, number>;
}

const metricsMap = new Map<string, RouteMetric>();
const SLOW_REQUEST_THRESHOLD_MS = 500;

/**
 * Fastify plugin that profiles route latency, status codes, and slow queries.
 */
export function registerProfilingHooks(app: FastifyInstance) {
  app.addHook("onRequest", (req: FastifyRequest, _reply: FastifyReply, done) => {
    (req as any)._profilingStart = process.hrtime.bigint();
    done();
  });

  app.addHook("onResponse", (req: FastifyRequest, reply: FastifyReply, done) => {
    const startNs = (req as any)._profilingStart;
    if (typeof startNs === "bigint") {
      const elapsedNs = process.hrtime.bigint() - startNs;
      const durationMs = Number(elapsedNs) / 1_000_000;

      const route = req.routeOptions?.url || req.url.split("?")[0] || "unknown";
      const method = req.method;
      const statusCode = reply.statusCode;
      const key = `${method} ${route}`;

      let metric = metricsMap.get(key);
      if (!metric) {
        metric = {
          route,
          method,
          totalCalls: 0,
          totalDurationMs: 0,
          minDurationMs: durationMs,
          maxDurationMs: durationMs,
          avgDurationMs: durationMs,
          slowRequestsCount: 0,
          statusCodes: {},
        };
        metricsMap.set(key, metric);
      }

      metric.totalCalls += 1;
      metric.totalDurationMs += durationMs;
      metric.minDurationMs = Math.min(metric.minDurationMs, durationMs);
      metric.maxDurationMs = Math.max(metric.maxDurationMs, durationMs);
      metric.avgDurationMs = Math.round((metric.totalDurationMs / metric.totalCalls) * 100) / 100;
      metric.statusCodes[statusCode] = (metric.statusCodes[statusCode] || 0) + 1;

      if (durationMs > SLOW_REQUEST_THRESHOLD_MS) {
        metric.slowRequestsCount += 1;
        app.log.warn({
          method,
          route,
          durationMs: Math.round(durationMs),
          thresholdMs: SLOW_REQUEST_THRESHOLD_MS,
          statusCode,
        }, "Slow API Handler Detected (Profiling Threshold Exceeded)");
      }
    }
    done();
  });
}

/**
 * Returns current profiling telemetry across all registered API handlers.
 */
export function getHandlerProfilingMetrics(): {
  recordedAt: string;
  totalRoutesProfiled: number;
  routes: RouteMetric[];
} {
  const routes = Array.from(metricsMap.values()).sort((a, b) => b.avgDurationMs - a.avgDurationMs);
  return {
    recordedAt: new Date().toISOString(),
    totalRoutesProfiled: routes.length,
    routes,
  };
}
