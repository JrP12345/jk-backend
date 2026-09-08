import type { FastifyInstance } from "fastify";
import { verifyWhatsAppWebhook, handleWhatsAppWebhookEvent } from "../controllers/whatsappWebhook.ts";

export default async function whatsappWebhookRoutes(app: FastifyInstance) {
  // GET /api/webhooks/whatsapp — Meta challenge verification
  app.get("/api/webhooks/whatsapp", verifyWhatsAppWebhook);

  // POST /api/webhooks/whatsapp — Meta message status receipts & inbound events
  app.post("/api/webhooks/whatsapp", handleWhatsAppWebhookEvent);
}
