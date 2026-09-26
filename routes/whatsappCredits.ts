import type { FastifyInstance } from "fastify";
import { authenticate, checkAnyPermission, checkPermission, requirePlatformRoot } from "../middleware/auth.ts";
import { getPlatformWhatsAppConfig, savePlatformWhatsAppConfig, testWhatsAppConnection, syncWhatsAppTemplates, getWhatsAppHealth } from "../controllers/whatsappManagement.ts";
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
  const root = { preHandler: [authenticate, requirePlatformRoot()] };
  const actionSchema = { querystring: whatsappConfigQuerySchema.querystring, body: { type: "object", properties: { organizationId: { type: "string", pattern: "^[0-9a-fA-F]{24}$" } }, additionalProperties: false } };
  app.get("/api/admin/whatsapp", root, getPlatformWhatsAppConfig);
  app.patch("/api/admin/whatsapp", { ...root, schema: { body: { type: "object", properties: {
    enabled: { type: "boolean" }, wabaId: { type: "string", pattern: "^[0-9]+$" }, phoneNumberId: { type: "string", pattern: "^[0-9]+$" }, accessToken: { type: "string", maxLength: 4096 }, appSecret: { type: "string", maxLength: 4096 },
  }, additionalProperties: false } } }, savePlatformWhatsAppConfig);
  app.post("/api/admin/whatsapp/test", root, testWhatsAppConnection);
  app.post("/api/admin/whatsapp/templates/sync", root, syncWhatsAppTemplates);
  app.get("/api/admin/whatsapp/health", root, getWhatsAppHealth);
  app.post("/api/organization/whatsapp/test", { ...manageOrganization, schema: actionSchema }, testWhatsAppConnection);
  app.post("/api/organization/whatsapp/templates/sync", { ...manageOrganization, schema: actionSchema }, syncWhatsAppTemplates);
  app.get("/api/organization/whatsapp/health", { ...manageOrganization, schema: whatsappConfigQuerySchema }, getWhatsAppHealth);

  // GET /api/organization/whatsapp — View WhatsApp configuration, credit balance, usage, and packs
  app.get("/api/organization/whatsapp", { ...viewOrganizationBilling, schema: whatsappConfigQuerySchema }, getOrganizationWhatsAppConfig);

  // PATCH /api/organization/whatsapp — Update gateway mode, notification toggles, and thresholds
  app.patch("/api/organization/whatsapp", { ...manageOrganization, schema: updateWhatsappConfigSchema }, updateOrganizationWhatsAppConfig);

  // POST /api/organization/whatsapp/top-up — Purchase prepaid WhatsApp credit packs
  app.post("/api/organization/whatsapp/top-up", { ...manageOrganizationBilling, schema: whatsappTopUpSchema }, purchaseWhatsAppCredits);
}
