import { verifyEnv } from "./utilities/config.ts";
verifyEnv();

import "./db.ts";
import { requestContextStore } from "./utilities/context.ts";
import fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import authRoutes from "./routes/auth.ts";
import onboardingRoutes from "./routes/onboarding.ts";
import publicRoutes from "./routes/public.ts";
import uploadRoutes from "./routes/upload.ts";

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

app.register(cors, {
  origin: "http://localhost:3000",   // Next.js frontend
  credentials: true,                 // allow cookies cross-origin
});

app.register(rateLimit, {
  max: 100,
  timeWindow: "1 minute"
});

// ─── Register route plugins ────────────────────────────────────
app.register(authRoutes);
app.register(onboardingRoutes);
app.register(publicRoutes);
app.register(uploadRoutes, { prefix: '/api' });

// ─── Health-check ───────────────────────────────────────────────
app.get("/api/health", async () => {
  return { status: "ok", timestamp: new Date().toISOString() };
});

// ─── Start server ───────────────────────────────────────────────
if (process.env.NODE_ENV !== "test") {
  const PORT = Number(process.env.PORT) || 5000;
  app.listen({ host: "localhost", port: PORT }).then(() => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
}

export { app };