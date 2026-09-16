import type { FastifyInstance } from "fastify";
import { authenticate, checkAnyPermission, checkPermission } from "../middleware/auth.ts";
import {
  getOrganizationWhatsAppConfig,
  updateOrganizationWhatsAppConfig,
  purchaseWhatsAppCredits,
} from "../controllers/whatsappCredits.ts";
import {
  updateWhatsappConfigSchema,
  whatsappConfigQuerySchema,
  whatsappTopUpSchema,
} from "../schemas/operations.ts";

export default async function whatsappCreditsRoutes(app: FastifyInstance) {
  const viewOrganizationBilling = { preHandler: [authenticate, checkAnyPermission("MANAGE_ORGANIZATION", "VIEW_BILLING", "MANAGE_BILLING")] };
  const manageOrganizationBilling = { preHandler: [authenticate, checkAnyPermission("MANAGE_ORGANIZATION", "MANAGE_BILLING")] };
  const manageOrganization = { preHandler: [authenticate, checkPermission("MANAGE_ORGANIZATION")] };

  // GET /api/organization/whatsapp — View WhatsApp configuration, credit balance, usage, and packs
  app.get("/api/organization/whatsapp", { ...viewOrganizationBilling, schema: whatsappConfigQuerySchema }, getOrganizationWhatsAppConfig);

  // PATCH /api/organization/whatsapp — Update gateway mode, notification toggles, and thresholds
  app.patch("/api/organization/whatsapp", { ...manageOrganization, schema: updateWhatsappConfigSchema }, updateOrganizationWhatsAppConfig);

  // POST /api/organization/whatsapp/top-up — Purchase prepaid WhatsApp credit packs
  app.post("/api/organization/whatsapp/top-up", { ...manageOrganizationBilling, schema: whatsappTopUpSchema }, purchaseWhatsAppCredits);
}
