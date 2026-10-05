import mongoose from "mongoose";
import { redisClient } from "./redis.ts";
import { validateConfig } from "./config.ts";
import { getRedisConfiguration } from "./redisConfiguration.ts";

let bootstrapComplete = false;
let shuttingDown = false;

async function pingWithTimeout<T>(ping: Promise<T>, dependency: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ping,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${dependency} ping timed out (1500ms)`)), 1500);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function markBootstrapComplete(): void {
  bootstrapComplete = true;
}

export function markShuttingDown(): void {
  shuttingDown = true;
}

/**
 * Validates MongoDB connectivity and ping response
 */
export async function checkDatabaseReadiness(): Promise<{
  ready: boolean;
  status: string;
  latencyMs?: number;
  error?: string;
}> {
  const readyState = mongoose.connection.readyState;
  if (readyState !== 1) {
    const states = ["disconnected", "connected", "connecting", "disconnecting"];
    return {
      ready: false,
      status: states[readyState] || "unknown",
      error: `MongoDB connection not open (readyState=${readyState})`,
    };
  }

  const start = Date.now();
  try {
    // Ping admin command with a bounded timeout
    if (mongoose.connection.db) {
      await pingWithTimeout(mongoose.connection.db.admin().ping(), "Database");
      return { ready: true, status: "connected", latencyMs: Date.now() - start };
    }
    return { ready: true, status: "connected" };
  } catch (err: any) {
    return {
      ready: false,
      status: "unreachable",
      error: err?.message || "Failed to ping database",
      latencyMs: Date.now() - start,
    };
  }
}

/**
 * Validates Redis readiness based on environment requirements
 */
export async function checkRedisReadiness(): Promise<{
  ready: boolean;
  required: boolean;
  status: string;
  latencyMs?: number;
  error?: string;
}> {
  const isDegradedAllowed = process.env.ALLOW_SINGLE_NODE_IN_PRODUCTION === "true";
  const configuration = getRedisConfiguration();
  const isRequired = configuration.required;

  if (!redisClient) {
    return {
      ready: !isRequired,
      required: isRequired,
      status: isDegradedAllowed ? "single_node_override" : "not_configured",
      error: isRequired ? `${configuration.error || "Redis client could not be initialized"}. Configure a Redis service or explicitly enable ALLOW_SINGLE_NODE_IN_PRODUCTION=true for a single instance` : undefined,
    };
  }

  if (redisClient.status !== "ready") {
    return {
      ready: !isRequired,
      required: isRequired,
      status: redisClient.status,
      error: `Redis status is '${redisClient.status}'`,
    };
  }

  const start = Date.now();
  try {
    const pingResult = await pingWithTimeout(redisClient.ping(), "Redis");

    const isPong = pingResult === "PONG";
    return {
      ready: isPong || !isRequired,
      required: isRequired,
      status: isPong ? "ready" : "unexpected_ping_response",
      latencyMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      ready: !isRequired,
      required: isRequired,
      status: "unreachable",
      error: err?.message || "Redis ping failed",
      latencyMs: Date.now() - start,
    };
  }
}

export interface ApiReadinessReport {
  ready: boolean;
  statusCode: number;
  data: {
    status: "ready" | "unhealthy" | "shutting_down" | "bootstrapping";
    database: { ready: boolean; status: string; latencyMs?: number; error?: string };
    redis: { ready: boolean; required: boolean; status: string; latencyMs?: number; error?: string };
    configuration: { valid: boolean; errors?: string[] };
    bootstrap: { complete: boolean };
    server: { shuttingDown: boolean; uptimeSeconds: number };
    timestamp: string;
  };
}

/**
 * Evaluates full readiness for the HTTP API server.
 * Returns 503 until DB, Redis (if required), configuration, and bootstrap are all healthy,
 * and immediately returns 503 during graceful shutdown traffic draining.
 */
export async function checkApiReadiness(): Promise<ApiReadinessReport> {
  const configCheck = validateConfig();
  const [dbReport, redisReport] = await Promise.all([
    checkDatabaseReadiness(),
    checkRedisReadiness(),
  ]);

  if (shuttingDown) {
    return {
      ready: false,
      statusCode: 503,
      data: {
        status: "shutting_down",
        database: dbReport,
        redis: redisReport,
        configuration: { valid: configCheck.valid },
        bootstrap: { complete: bootstrapComplete },
        server: { shuttingDown: true, uptimeSeconds: Math.floor(process.uptime()) },
        timestamp: new Date().toISOString(),
      },
    };
  }

  if (!bootstrapComplete) {
    return {
      ready: false,
      statusCode: 503,
      data: {
        status: "bootstrapping",
        database: dbReport,
        redis: redisReport,
        configuration: { valid: configCheck.valid, errors: configCheck.errors },
        bootstrap: { complete: false },
        server: { shuttingDown: false, uptimeSeconds: Math.floor(process.uptime()) },
        timestamp: new Date().toISOString(),
      },
    };
  }

  const isReady = configCheck.valid && dbReport.ready && redisReport.ready;
  const statusCode = isReady ? 200 : 503;

  return {
    ready: isReady,
    statusCode,
    data: {
      status: isReady ? "ready" : "unhealthy",
      database: dbReport,
      redis: redisReport,
      configuration: { valid: configCheck.valid, errors: configCheck.errors.length > 0 ? configCheck.errors : undefined },
      bootstrap: { complete: bootstrapComplete },
      server: { shuttingDown: false, uptimeSeconds: Math.floor(process.uptime()) },
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Evaluates readiness for standalone background worker processes.
 * Worker readiness is decoupled from HTTP routing: workers check process liveness, DB connection,
 * and background processing active status.
 */
export async function checkWorkerReadiness(workerName: string): Promise<{
  ready: boolean;
  statusCode: number;
  data: Record<string, any>;
}> {
  const configCheck = validateConfig();
  const [dbReport, redisReport] = await Promise.all([checkDatabaseReadiness(), checkRedisReadiness()]);

  const isReady = !shuttingDown && configCheck.valid && dbReport.ready && redisReport.ready;
  return {
    ready: isReady,
    statusCode: isReady ? 200 : 503,
    data: {
      worker: workerName,
      status: isReady ? "ready" : shuttingDown ? "shutting_down" : "unhealthy",
      database: dbReport,
      redis: redisReport,
      configuration: { valid: configCheck.valid },
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    },
  };
}
