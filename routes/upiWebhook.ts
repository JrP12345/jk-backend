import type { FastifyInstance } from "fastify";
import { handleInboundUpiWebhook } from "../controllers/upiWebhook.ts";

export default async function upiWebhookRoutes(app: FastifyInstance) {
  // POST /api/webhooks/upi — Autonomous banking & gateway UPI settlement callback
  app.post("/api/webhooks/upi", {
    config: {
      rateLimit: {
        max: process.env.NODE_ENV === "test" ? 1000 : 120,
        timeWindow: "1 minute",
      },
    },
  }, handleInboundUpiWebhook);
}
