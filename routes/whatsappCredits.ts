import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import {
  getOrganizationWhatsAppConfig,
  updateOrganizationWhatsAppConfig,
  purchaseWhatsAppCredits,
} from "../controllers/whatsappCredits.ts";

export default async function whatsappCreditsRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };

  // GET /api/organization/whatsapp — View WhatsApp configuration, credit balance, usage, and packs
  app.get("/api/organization/whatsapp", auth, getOrganizationWhatsAppConfig);

  // PATCH /api/organization/whatsapp — Update gateway mode, notification toggles, and thresholds
  app.patch("/api/organization/whatsapp", auth, updateOrganizationWhatsAppConfig);

  // POST /api/organization/whatsapp/top-up — Purchase prepaid WhatsApp credit packs
  app.post("/api/organization/whatsapp/top-up", auth, purchaseWhatsAppCredits);
}
