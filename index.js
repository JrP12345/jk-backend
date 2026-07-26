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
import staffRoutes from "./routes/staff.ts";
import clinicRoutes from "./routes/clinics.ts";
import appointmentRoutes from "./routes/appointments.ts";
import clinicalRoutes from "./routes/clinical.ts";
import marRoutes from "./routes/mar.ts";
import laboratoryRoutes from "./routes/laboratory.ts";
import inpatientRoutes from "./routes/inpatient.ts";
import pharmacyRoutes from "./routes/pharmacy.ts";
import billingRoutes from "./routes/billing.ts";
import analyticsRoutes from "./routes/analytics.ts";
import fhirRoutes from "./routes/fhir.ts";
import searchRoutes from "./routes/search.ts";
import publicRoutes from "./routes/public.ts";
import uploadRoutes from "./routes/upload.ts";
import notificationRoutes from "./routes/notifications.ts";
import notificationPreferenceRoutes from "./routes/notificationPreferences.ts";
import taskRoutes from "./routes/tasks.ts";
import documentRoutes from "./routes/documents.ts";
import prescriptionPrintRoutes from "./routes/prescriptionPrint.ts";
import patientPortalRoutes from "./routes/patientPortal.ts";
import aiRoutes from "./routes/ai.ts";
import platformGatewayRoutes from "./platform/gateway.ts";

import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { apiV1VersioningPlugin } from "./utilities/versioningPlugin.ts";

const app = fastify({ logger: true, bodyLimit: 10485760 }); // 10MB

// Register Swagger OpenAPI spec
app.register(fastifySwagger, {
  openapi: {
    info: {
      title: "ANANTA Healthcare Infrastructure Platform API",
      description: "Production-Grade Enterprise AI-First Healthcare Infrastructure Platform API Specification",
      version: "1.0.0",
    },
    servers: [
      { url: "http://localhost:5000", description: "Local Development Server" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
  },
});

// Register Swagger UI documentation interface
app.register(fastifySwaggerUi, {
  routePrefix: "/documentation",
  uiConfig: {
    docExpansion: "list",
    deepLinking: true,
  },
});

// Register API Versioning plugin (/api/v1/*)
app.register(apiV1VersioningPlugin);

// Setup global async context & versioning URL rewrite hook
app.addHook("onRequest", (request, reply, done) => {
  requestContextStore.enterWith({ userId: undefined });
  if (request.raw.url && request.raw.url.startsWith("/api/v1/")) {
    request.raw.url = request.raw.url.replace("/api/v1/", "/api/");
  }
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
    "X-Onboarding-Secret", "x-onboarding-secret", "X-Clinic-Id", "x-clinic-id",
    "X-Organization-Id", "x-organization-id"
  ],
});

app.register(rateLimit, {
  max: 100,
  timeWindow: "1 minute",
  ...(redisClient ? { redis: redisClient } : {})
});

// ─── Register Domain Route Plugins ─────────────────────────────
app.register(authRoutes);
app.register(onboardingRoutes);
app.register(staffRoutes);
app.register(clinicRoutes);
app.register(appointmentRoutes);
app.register(clinicalRoutes);
app.register(marRoutes);
app.register(laboratoryRoutes);
app.register(inpatientRoutes);
app.register(pharmacyRoutes);
app.register(billingRoutes);
app.register(analyticsRoutes);
app.register(fhirRoutes);
app.register(searchRoutes);
app.register(publicRoutes);
app.register(uploadRoutes, { prefix: '/api' });
app.register(notificationRoutes);
app.register(notificationPreferenceRoutes);
app.register(taskRoutes);
app.register(documentRoutes);
app.register(prescriptionPrintRoutes);
app.register(patientPortalRoutes);
app.register(aiRoutes);
app.register(platformGatewayRoutes);

// ─── Health-checks & Probes (SRE-001, SRE-002, SRE-003) ─────────
const healthCheckHandler = async () => {
  return { status: "ok", timestamp: new Date().toISOString() };
};

const livenessHandler = async () => {
  return { status: "ok" };
};

const readinessHandler = async (request, reply) => {
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
};

app.get("/api/health", healthCheckHandler);
app.get("/api/health/liveness", livenessHandler);
app.get("/api/health/readiness", readinessHandler);

// Explicit /api/v1 Health Probe Aliases
app.get("/api/v1/health", healthCheckHandler);
app.get("/api/v1/health/liveness", livenessHandler);
app.get("/api/v1/health/readiness", readinessHandler);

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