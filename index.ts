import { verifyEnv } from "./utilities/config.ts";
verifyEnv();

import "./db.ts";
import mongoose from "mongoose";
import { requestContextStore } from "./utilities/context.ts";
import { redisClient } from "./utilities/redis.ts";
import { reportCriticalError } from "./utilities/telemetry.ts";
import {
  markBootstrapComplete,
  markShuttingDown,
  checkApiReadiness,
} from "./utilities/readiness.ts";
import fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import compress from "@fastify/compress";
import authRoutes from "./routes/auth.ts";
import onboardingRoutes from "./routes/onboarding.ts";
import staffRoutes from "./routes/staff.ts";
import clinicRoutes from "./routes/clinics.ts";
import appointmentRoutes from "./routes/appointments.ts";
import clinicalRoutes from "./routes/clinical.ts";
import laboratoryRoutes from "./routes/laboratory.ts";
import pharmacyRoutes from "./routes/pharmacy.ts";
import billingRoutes from "./routes/billing.ts";
import analyticsRoutes from "./routes/analytics.ts";
import trafficAnalyticsRoutes from "./routes/trafficAnalytics.ts";
import searchRoutes from "./routes/search.ts";
import publicRoutes from "./routes/public.ts";
import uploadRoutes from "./routes/upload.ts";
import notificationRoutes from "./routes/notifications.ts";
import notificationPreferenceRoutes from "./routes/notificationPreferences.ts";
import taskRoutes from "./routes/tasks.ts";
import documentRoutes from "./routes/documents.ts";
import prescriptionPrintRoutes from "./routes/prescriptionPrint.ts";
import patientPortalRoutes from "./routes/patientPortal.ts";
import familyRoutes from "./routes/family.ts";
import appointmentPaymentRoutes from "./routes/appointmentPayment.ts";
import aiRoutes from "./routes/ai.ts";
import serviceCatalogRoutes from "./routes/serviceCatalog.ts";
import preAuthRoutes from "./routes/preAuth.ts";
import insuranceTariffRoutes from "./routes/insuranceTariff.ts";
import soapTemplateRoutes from "./routes/soapTemplate.ts";
import checkInRoutes from "./routes/checkIn.ts";
import imagingRoutes from "./routes/imaging.ts";
import teleconsultationRoutes from "./routes/teleconsultation.ts";
import pecRoutes from "./routes/pec.ts";
import reportExportRoutes from "./routes/reportExport.ts";
import ssoRoutes from "./routes/sso.ts";
import feedbackRoutes from "./routes/feedback.ts";
import roleRoutes from "./routes/role.ts";
import shiftRoutes from "./routes/shifts.ts";
import platformGatewayRoutes from "./platform/gateway.ts";
import moduleRegistryRoutes from "./routes/moduleRegistry.ts";
import doctorAvailabilityRoutes from "./routes/doctorAvailability.ts";
import whatsappWebhookRoutes from "./routes/whatsappWebhook.ts";
import whatsappCreditsRoutes from "./routes/whatsappCredits.ts";
import upiWebhookRoutes from "./routes/upiWebhook.ts";
import abdmRoutes from "./routes/abdm.ts";
import syntheticHealthRoutes from "./routes/syntheticHealth.ts";
import dpdpRoutes from "./routes/dpdp.ts";
import scheduleH1Routes from "./routes/scheduleH1.ts";
import outboxOperationsRoutes from "./routes/outboxOperations.ts";
import { seedDefaultRoles, syncOrganizationPlanQuotas } from "./controllers/onboarding.ts";

import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { apiV1VersioningPlugin } from "./utilities/versioningPlugin.ts";
import { csrfProtection } from "./middleware/csrf.ts";
import { sanitizeMiddleware } from "./middleware/sanitize.ts";

const app = fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.body.password",
      "req.body.otp",
      "req.body.twoFactorSecret",
    ],
  },
  bodyLimit: 10485760, // 10MB, reverse-proxy aware
  trustProxy: process.env.TRUSTED_PROXY_HOPS
    ? parseInt(process.env.TRUSTED_PROXY_HOPS, 10)
    : (process.env.TRUSTED_PROXY_CIDRS
        ? process.env.TRUSTED_PROXY_CIDRS.split(",").map(c => c.trim())
        : ["127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]),
  connectionTimeout: 30000, // 30s socket timeout
  keepAliveTimeout: 5000,   // 5s keep-alive timeout
  rewriteUrl: (req) => {
    if (req.url && req.url.startsWith("/api/v1/")) {
      return req.url.replace("/api/v1/", "/api/");
    }
    return req.url || "/";
  },
});

// Enforce edge proxy origin protection & Referrer-Policy
app.addHook("onRequest", (req, reply, done) => {
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");

  // Verify origin cannot be reached around trusted edge proxy when origin protection is enabled
  if (process.env.REQUIRE_TRUSTED_PROXY === "true" || process.env.ORIGIN_VERIFY_TOKEN) {
    const originVerifyToken = req.headers["x-origin-verify-token"];
    const expectedToken = process.env.ORIGIN_VERIFY_TOKEN;
    if (expectedToken && originVerifyToken !== expectedToken) {
      reply.code(403).send({ error: "Direct access to origin server is blocked. Requests must transit the trusted edge proxy." });
      return;
    }
  }

  done();
});

// Preserve raw body buffer string on incoming JSON for authentic HMAC webhook validation
app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body: string, done) => {
  (req as any).rawBody = body;
  if (!body || body.trim() === "") {
    return done(null, {});
  }
  try {
    const json = JSON.parse(body);
    done(null, json);
  } catch (err: any) {
    done(err, undefined);
  }
});

// Register Swagger OpenAPI spec & UI in non-production environments
if (process.env.NODE_ENV !== "production") {
  app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "ANANTA Healthcare Infrastructure Platform API",
        description: "Production-Grade Enterprise AI-First Healthcare Infrastructure Platform API Specification",
        version: "1.0.0",
      },
      servers: [
        ...(process.env.CORS_ALLOWED_ORIGINS
          ? [{ url: process.env.CORS_ALLOWED_ORIGINS.split(",")[0].trim().replace(/:\d+$/, `:${process.env.PORT || 5000}`), description: "Production Server" }]
          : []),
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
}

// Register API Versioning plugin (/api/v1/*)
app.register(apiV1VersioningPlugin);

// Setup global async context for request-scoped state
app.addHook("onRequest", (request, reply, done) => {
  requestContextStore.enterWith({ userId: undefined });
  done();
});

// ─── VAPT Enterprise Security Headers Hook (Applied on all outgoing HTTP responses) ───
app.addHook("onSend", async (request, reply, payload) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-XSS-Protection", "1; mode=block");
  reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("Permissions-Policy", "geolocation=(), camera=(self), microphone=(self)");
  reply.header(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data: blob: https:; script-src 'self'; style-src 'self'; font-src 'self' data: https:; connect-src 'self' ws: wss: https:;"
  );
  return payload;
});

// Register NoSQL injection sanitizer on all requests
app.addHook("preValidation", sanitizeMiddleware);

// Register CSRF protection guard on state-changing requests
app.addHook("preHandler", csrfProtection);

app.setErrorHandler(async (error: any, request, reply) => {
  if (error.validation) {
    return reply.code(400).send({
      success: false,
      message: `Validation Error: ${error.message}`,
      details: error.validation
    });
  }
  
  const statusCode = error.statusCode || 500;
  if (statusCode >= 500) {
    await reportCriticalError(`Unhandled Server Error: ${request.method} ${request.url}`, error, {
      route: request.url,
      method: request.method,
      statusCode: String(statusCode),
    });
  }

  const isProd = process.env.NODE_ENV === "production";
  reply.code(statusCode).send({
    success: false,
    message: statusCode >= 500 && isProd
      ? "Internal server error"
      : (error.message || "Internal server error")
  });
});

// ─── Plugins ────────────────────────────────────────────────────
app.register(cookie);
app.register(websocket, {
  options: {
    maxPayload: 1048576, // 1MB message limit
  },
});

const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean)
  : ["http://localhost:3000", "http://localhost:3001"];

const isDev = process.env.NODE_ENV === "development" || !process.env.NODE_ENV;

app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);

    const cleanOrigin = origin.trim().replace(/\/+$/, "");

    // In development mode, allow localhost, 127.0.0.1, and private LAN/hotspot IPs (10.x, 192.168.x, 172.x)
    if (isDev) {
      if (/^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/.test(cleanOrigin)) {
        return cb(null, true);
      }
    }

    if (allowedOrigins.includes(cleanOrigin)) {
      return cb(null, true);
    }
    return cb(null, false);
  },
  credentials: true,                 // allow cookies cross-origin
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
  allowedHeaders: [
    "Content-Type", "Authorization", "X-Requested-With", "Accept",
    "Cache-Control", "cache-control", "Pragma", "Expires"
  ],
});

app.register(rateLimit, {
  max: process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test" ? 10000 : 500,
  timeWindow: "1 minute",
  ...(redisClient ? { redis: redisClient } : {})
});

// Register HTTP response compression (gzip/deflate for payloads > 1KB)
app.register(compress, {
  encodings: ["gzip", "deflate"],
  threshold: 1024
});

// ─── Register Domain Route Plugins ─────────────────────────────
app.register(authRoutes);
app.register(onboardingRoutes);
app.register(staffRoutes);
app.register(clinicRoutes);
app.register(appointmentRoutes);
app.register(clinicalRoutes);
app.register(laboratoryRoutes);
app.register(pharmacyRoutes);
app.register(billingRoutes);
app.register(analyticsRoutes);
app.register(trafficAnalyticsRoutes);
app.register(searchRoutes);
app.register(publicRoutes);
app.register(uploadRoutes, { prefix: '/api' });
app.register(notificationRoutes);
app.register(notificationPreferenceRoutes);
app.register(taskRoutes);
app.register(documentRoutes);
app.register(prescriptionPrintRoutes);
app.register(patientPortalRoutes);
app.register(familyRoutes);
app.register(appointmentPaymentRoutes);
app.register(aiRoutes);
app.register(serviceCatalogRoutes);
app.register(preAuthRoutes);
app.register(insuranceTariffRoutes);
app.register(soapTemplateRoutes);
app.register(checkInRoutes);
app.register(imagingRoutes);
app.register(teleconsultationRoutes);
app.register(pecRoutes);
app.register(reportExportRoutes);
app.register(ssoRoutes);
app.register(feedbackRoutes);
app.register(roleRoutes);
app.register(shiftRoutes, { prefix: "/api/shifts" });
app.register(platformGatewayRoutes, { prefix: "/api/platform" });
app.register(moduleRegistryRoutes);
app.register(doctorAvailabilityRoutes);
app.register(whatsappWebhookRoutes);
app.register(whatsappCreditsRoutes);
app.register(upiWebhookRoutes);
app.register(abdmRoutes);
app.register(syntheticHealthRoutes);
app.register(dpdpRoutes);
app.register(scheduleH1Routes);
app.register(outboxOperationsRoutes);

// ─── Health-checks & Probes (SRE-001, SRE-002, SRE-003, Step 4.2) ─────────
const healthCheckHandler = async () => {
  return { status: "ok", timestamp: new Date().toISOString() };
};

const livenessHandler = async (_request: FastifyRequest, reply: FastifyReply) => {
  // Liveness indicates process responsiveness only. It intentionally does NOT fail
  // if downstream DB or Redis are temporarily degraded, preventing crash-restart thrash.
  return reply.code(200).send({
    status: "ok",
    process: {
      pid: process.pid,
      uptime: Math.floor(process.uptime()),
      memoryUsageMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
    timestamp: new Date().toISOString(),
  });
};

const readinessHandler = async (_request: FastifyRequest, reply: FastifyReply) => {
  const report = await checkApiReadiness();
  return reply.code(report.statusCode).send(report.data);
};

app.get("/api/health", healthCheckHandler);
app.get("/api/health/liveness", livenessHandler);
app.get("/api/health/readiness", readinessHandler);

// ─── Graceful Shutdown & Server Startup ──────────────────────────
const PORT = Number(process.env.PORT) || 5000;

async function startServer() {
  try {
    // 1. One-time migration guard & bootstrap work
    await seedDefaultRoles();
    app.log.info("✓ Default system roles verified / seeded.");

    await syncOrganizationPlanQuotas();
    app.log.info("✓ Tenant plan resource quotas verified / synchronized.");

    // 2. Mark bootstrap complete so readiness becomes true
    markBootstrapComplete();
    app.log.info("✓ Application bootstrap completed successfully.");

    // 3. Bind HTTP listener to begin receiving traffic
    const address = await app.listen({ port: PORT, host: "0.0.0.0" });
    app.log.info(`🚀 HealthOS Fastify Server running at ${address}`);
  } catch (err) {
    app.log.error(err, "Fatal error during startup / bootstrap:");
    process.exit(1);
  }
}

const gracefulShutdown = async (signal: string) => {
  app.log.info(`Received ${signal}. Initiating graceful traffic drain and shutdown...`);
  try {
    // Step 1: Remove server from traffic by failing readiness probes immediately
    markShuttingDown();
    const drainMs = process.env.NODE_ENV === "test" ? 0 : Number(process.env.SHUTDOWN_DRAIN_MS) || 2000;
    if (drainMs > 0) {
      app.log.info(`Draining inbound traffic for ${drainMs}ms before closing listeners...`);
      await new Promise((resolve) => setTimeout(resolve, drainMs));
    }

    // Step 2: Stop accepting new HTTP connections and wait for in-flight requests
    await app.close();
    app.log.info("HTTP listener closed, in-flight requests completed.");

    // Step 3: Disconnect database and cache
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
      app.log.info("MongoDB disconnected.");
    }
    if (redisClient) {
      await redisClient.quit();
      app.log.info("Redis disconnected.");
    }

    app.log.info("Server closed successfully.");
    process.exit(0);
  } catch (err) {
    app.log.error(err, "Error during graceful shutdown:");
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
