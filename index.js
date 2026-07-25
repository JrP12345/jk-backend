import { verifyEnv } from "./utilities/config.ts";
verifyEnv();

import "./db.ts";
import mongoose from "mongoose";
import { requestContextStore } from "./utilities/context.ts";
import { redisClient } from "./utilities/redis.ts";
import fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import authRoutes from "./routes/auth.ts";
import onboardingRoutes from "./routes/onboarding.ts";
import publicRoutes from "./routes/public.ts";
import uploadRoutes from "./routes/upload.ts";
import notificationRoutes from "./routes/notifications.ts";
import notificationPreferenceRoutes from "./routes/notificationPreferences.ts";
import taskRoutes from "./routes/tasks.ts";

const app = fastify({ logger: true, bodyLimit: 10485760 }); // 10MB

// Setup global async context hook
app.addHook("onRequest", (request, reply, done) => {
  requestContextStore.enterWith({ userId: undefined });
  done();
});

app.setErrorHandler((error, request, reply) => {
  if (error.validation) {
    return reply.code(400).send({
      success: false,
      message: `Validation Error: ${error.message}`,
      details: error.validation
    });
  }
  
  const statusCode = error.statusCode || 500;
  reply.code(statusCode).send({
    success: false,
    message: error.message || "Internal server error"
  });
});

// ─── Plugins ────────────────────────────────────────────────────
app.register(cookie);

const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  : ["http://localhost:3000"];

app.register(cors, {
  origin: allowedOrigins.length === 1 ? allowedOrigins[0] : allowedOrigins,
  credentials: true,                 // allow cookies cross-origin
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
  allowedHeaders: [
    "Content-Type", "Authorization", "X-Requested-With", "Accept",
    "Cache-Control", "cache-control", "Pragma", "Expires",
    "X-Onboarding-Secret", "x-onboarding-secret", "X-Clinic-Id", "x-clinic-id"
  ],
});

app.register(rateLimit, {
  max: 100,
  timeWindow: "1 minute",
  ...(redisClient ? { redis: redisClient } : {})
});

// ─── Register route plugins ────────────────────────────────────
app.register(authRoutes);
app.register(onboardingRoutes);
app.register(publicRoutes);
app.register(uploadRoutes, { prefix: '/api' });
app.register(notificationRoutes);
app.register(notificationPreferenceRoutes);
app.register(taskRoutes);

// ─── Health-checks & Probes (SRE-001, SRE-002, SRE-003) ─────────
app.get("/api/health", async () => {
  return { status: "ok", timestamp: new Date().toISOString() };
});

app.get("/api/health/liveness", async () => {
  return { status: "ok" };
});

app.get("/api/health/readiness", async (request, reply) => {
  const dbState = mongoose.connection.readyState;
  const isDbReady = dbState === 1; // 1 = connected

  let isRedisReady = true;
  if (redisClient) {
    isRedisReady = redisClient.status === "ready" || redisClient.status === "connecting";
  }

  const isReady = isDbReady && isRedisReady;
  const statusCode = isReady ? 200 : 503;

  return reply.code(statusCode).send({
    status: isReady ? "ready" : "unhealthy",
    database: isDbReady ? "connected" : "disconnected",
    redis: isRedisReady ? "ready" : "degraded",
    timestamp: new Date().toISOString()
  });
});

// ─── Graceful Shutdown & Server Startup ──────────────────────────
const PORT = Number(process.env.PORT) || 5000;

async function startServer() {
  try {
    const address = await app.listen({ port: PORT, host: "0.0.0.0" });
    app.log.info(`🚀 HealthOS Fastify Server running at ${address}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

const gracefulShutdown = async (signal) => {
  app.log.info(`Received ${signal}. Shutting down gracefully...`);
  try {
    await app.close();
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    if (redisClient) {
      await redisClient.quit();
    }
    app.log.info("Server closed successfully.");
    process.exit(0);
  } catch (err) {
    app.log.error("Error during graceful shutdown:", err);
    process.exit(1);
  }
};

if (process.env.NODE_ENV !== "test") {
  startServer();
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

export { app };
export default app;