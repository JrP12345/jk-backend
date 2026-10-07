import "./utilities/startupEnvironment.ts";
import { getServerPort } from "./utilities/serverPort.ts";

import "./db.ts";
import mongoose from "mongoose";
import { closeRealtimeTransports } from "./notifications/websocket.ts";
import { requestContextStore } from "./utilities/context.ts";
import { requestCancellationSignal } from "./utilities/requestCancellation.ts";
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
import organizationBrandingRoutes from "./routes/organizationBranding.ts";
import { startOrganizationBrandingJob, stopOrganizationBrandingJob } from "./jobs/organizationBrandingJob.ts";
import staffRoutes from "./routes/staff.ts";
import locationRoutes from "./routes/locations.ts";
import appointmentRoutes from "./routes/appointments.ts";
import clinicalRoutes from "./routes/clinical.ts";
import laboratoryRoutes from "./routes/laboratory.ts";
import pharmacyRoutes from "./routes/pharmacy.ts";
import billingRoutes from "./routes/billing.ts";
import analyticsRoutes from "./routes/analytics.ts";
import trafficAnalyticsRoutes from "./routes/trafficAnalytics.ts";
import searchRoutes from "./routes/search.ts";
import publicRoutes from "./routes/public.ts";
import setupRequestRoutes from "./routes/setupRequests.ts";
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
import { whatsAppWebhookWorker } from "./services/WhatsAppWebhookService.ts";
import { outboundMessageDeliveryWorker } from "./services/OutboundMessageDeliveryWorker.ts";
import whatsappCreditsRoutes from "./routes/whatsappCredits.ts";
import { startDisruptionTimeoutJob, stopDisruptionTimeoutJob } from "./jobs/disruptionTimeoutJob.ts";
import { domainEventDeliveryWorker } from "./services/DomainEventDeliveryWorker.ts";
import { notificationDeliveryWorker } from "./notifications/workers/NotificationDeliveryWorker.ts";
import { startBillingReconciliationJob, stopBillingReconciliationJob } from "./jobs/billingReconciliationJob.ts";
import upiWebhookRoutes from "./routes/upiWebhook.ts";
import abdmRoutes from "./routes/abdm.ts";
import syntheticHealthRoutes from "./routes/syntheticHealth.ts";
import dpdpRoutes from "./routes/dpdp.ts";
import scheduleH1Routes from "./routes/scheduleH1.ts";
import outboxOperationsRoutes from "./routes/outboxOperations.ts";
import { seedDefaultRoles } from "./controllers/onboarding.ts";

import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { csrfProtection } from "./middleware/csrf.ts";
import { authenticate, requirePlatformRoot } from './middleware/auth.ts';
import { sanitizeMiddleware } from "./middleware/sanitize.ts";
import { registerProfilingHooks, getHandlerProfilingMetrics } from "./utilities/profiling.ts";
import {
  MAX_REQUEST_BODY_BYTES,
  GLOBAL_RATE_LIMIT_PER_MINUTE,
  SHUTDOWN_DRAIN_MS,
} from "./utilities/scalability.ts";

const app = fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
    serializers: {
      req: (req: any) => ({ method: req.method, url: String(req.url || '').split('?')[0].replace(/[a-f\d]{24}/gi, ':id'), remoteAddress: req.ip }),
    },
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.body.password",
      "req.body.otp",
      "req.body.twoFactorSecret",
    ],
  },
  bodyLimit: MAX_REQUEST_BODY_BYTES, // Centralized resource budget
  trustProxy: process.env.TRUSTED_PROXY_HOPS
    ? (_address: string, hop: number) => hop < Number(process.env.TRUSTED_PROXY_HOPS)
    : (process.env.TRUSTED_PROXY_CIDRS
        ? process.env.TRUSTED_PROXY_CIDRS.split(",").map(c => c.trim())
        : ["127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]),
  connectionTimeout: 30000, // 30s socket timeout
  keepAliveTimeout: 5000,   // 5s keep-alive timeout
});

let acceptingTraffic = process.env.NODE_ENV === "test";
const probePaths = new Set(["/api/health", "/api/health/liveness", "/api/health/readiness"]);
app.addHook("onRequest", (request, reply, done) => {
  if (!acceptingTraffic && !probePaths.has(request.url.split("?")[0])) {
    reply.header("Retry-After", "2").code(503).send({ success: false, message: "The service is starting or shutting down. Please try again shortly." });
    return;
  }
  done();
});

// Enforce edge proxy origin protection & Referrer-Policy
app.addHook("onRequest", (req, reply, done) => {

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
        title: "Ekavyu Healthcare Infrastructure Platform API",
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

// Register latency and slow-query profiling hooks (Step 5.5)
registerProfilingHooks(app);

// Setup global async context for request-scoped state
app.addHook("onRequest", (request, reply, done) => {
  reply.header("X-Request-Id", request.id);
  requestContextStore.run({ userId: undefined, correlationId: request.id, memo: new Map(), abortSignal: requestCancellationSignal(request, reply) }, done);
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

// Tenant budgets are applied by authenticate after session/tenant resolution.

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
    const route = request.routeOptions.url || 'unmatched';
    await reportCriticalError(`Unhandled Server Error: ${request.method} ${route}`, error, {
      route,
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
    "Cache-Control", "cache-control", "Pragma", "Expires", "X-Patient-Record-Access",
    "X-Tracker-Token", "If-None-Match"
  ],
  exposedHeaders: ["ETag"],
});

app.register(rateLimit, {
  max: GLOBAL_RATE_LIMIT_PER_MINUTE,
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
app.register(organizationBrandingRoutes);
app.register(staffRoutes);
app.register(locationRoutes);
app.register(appointmentRoutes);
app.register(clinicalRoutes);
app.register(laboratoryRoutes);
app.register(pharmacyRoutes);
app.register(billingRoutes);
app.register(analyticsRoutes);
app.register(trafficAnalyticsRoutes);
app.register(searchRoutes);
app.register(publicRoutes);
app.register(setupRequestRoutes);
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

let lastReadinessState = "";
const readinessHandler = async (_request: FastifyRequest, reply: FastifyReply) => {
  const report = await checkApiReadiness();
  const state = {
    status: report.data.status,
    database: report.data.database.status,
    redis: report.data.redis.status,
    redisRequired: report.data.redis.required,
    redisError: report.data.redis.error,
    configurationErrors: report.data.configuration.errors,
    bootstrapComplete: report.data.bootstrap.complete,
  };
  const signature = JSON.stringify(state);
  if (signature !== lastReadinessState) {
    if (!report.ready) app.log.warn({ readiness: state }, "API readiness failed. Check the reported dependency or configuration before redeploying.");
    else if (lastReadinessState) app.log.info("API readiness recovered.");
    lastReadinessState = signature;
  }
  return reply.code(report.statusCode).send(report.data);
};

app.get("/api/health", healthCheckHandler);
app.get("/api/health/liveness", livenessHandler);
app.get("/api/health/readiness", readinessHandler);
app.get("/api/admin/operations/profiling", { preHandler: [authenticate, requirePlatformRoot()] }, async (_req, reply) => {
  return reply.code(200).send(getHandlerProfilingMetrics());
});

// ─── Graceful Shutdown & Server Startup ──────────────────────────
async function startServer(port = getServerPort()) {
  // Claim the configured port before writing bootstrap data or starting jobs.
  // Health probes remain 503 until bootstrap is complete.
  acceptingTraffic = false;
  const address = await app.listen({ port, host: "0.0.0.0" });
  try {
    // 1. Current role bootstrap
    await seedDefaultRoles();
    app.log.info("✓ Default system roles verified / seeded.");


    // 3. Start durable consumers when using inline jobs.
    if (process.env.NODE_ENV !== "test" && (process.env.RUN_INLINE_JOBS === "true" || process.env.NODE_ENV !== "production")) {
      domainEventDeliveryWorker.start();
      notificationDeliveryWorker.start();
      startDisruptionTimeoutJob();
      startBillingReconciliationJob();
      startOrganizationBrandingJob();
      whatsAppWebhookWorker.start();
      outboundMessageDeliveryWorker.start();
      app.log.info("Durable consumers and scheduled jobs started (inline mode).");
    }

    markBootstrapComplete();
    acceptingTraffic = true;
    app.log.info("✓ Application bootstrap completed successfully.");
    app.log.info(`🚀 Ekavyu Fastify Server running at ${address}`);
    return address;
  } catch (err) {
    await app.close();
    throw err;
  }
}

let shutdownStarted = false;
const gracefulShutdown = async (signal: string, exitCode = 0) => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  acceptingTraffic = false;
  markShuttingDown();
  const deadline = setTimeout(() => {
    app.log.error("Shutdown exceeded 55 seconds; forcing exit so durable leases can recover unfinished work.");
    process.exit(1);
  }, 55_000);
  deadline.unref();
  app.log.info(`Received ${signal}. Initiating graceful traffic drain and shutdown...`);
  try {
    // Stop every consumer immediately; draining concurrently fits container grace.
    const drainMs = exitCode === 0 ? SHUTDOWN_DRAIN_MS : 0;
    if (drainMs > 0) {
      app.log.info(`Draining inbound traffic for ${drainMs}ms before closing listeners...`);
    }
    await Promise.all([
      stopDisruptionTimeoutJob(), domainEventDeliveryWorker.stop(), notificationDeliveryWorker.stop(),
      stopBillingReconciliationJob(), stopOrganizationBrandingJob(), whatsAppWebhookWorker.stop(), outboundMessageDeliveryWorker.stop(),
      drainMs > 0 ? new Promise(resolve => setTimeout(resolve, drainMs)) : Promise.resolve(),
    ]);

    // Step 2: Stop accepting new HTTP connections and wait for in-flight requests
    closeRealtimeTransports();
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
    clearTimeout(deadline);
    process.exit(exitCode);
  } catch (err) {
    app.log.error(err, "Error during graceful shutdown:");
    process.exit(1);
  }
};

if (process.env.NODE_ENV !== "test") {
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  startServer().catch(async (err) => {
    const conflict = (err as NodeJS.ErrnoException).code === "EADDRINUSE";
    app.log.error({ err, port: getServerPort() }, conflict
      ? "API port is already in use. Run only one backend process on this port; use npm run dev for the local duplicate check."
      : "Fatal error during startup / bootstrap.");
    await gracefulShutdown("startup failure", 1);
  });
}

export { app, startServer };
export default app;
