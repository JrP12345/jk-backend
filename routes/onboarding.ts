import type { FastifyInstance } from "fastify";
import { authenticate, checkPermission } from "../middleware/auth.ts";
import { createOrganizationSchema } from "../schemas/onboarding.ts";
import {
  createOrganization,
  getAllOrganizations,
  updateOrganizationById,
  deleteOrganizationById,
  saveDraft,
  getDraft,
  setupOnboardingTOTP,
  verifyOnboardingTOTP,
  getOrganizationSettings,
  updateOrganizationSettings,
  getOrganizationSmtp,
  updateOrganizationSmtp,
  getOrganizationMembers,
  getGlobalUsers,
  getPlatformHierarchy,
} from "../controllers/onboarding.ts";

export default async function onboardingRoutes(app: FastifyInstance) {
  // Public Organization Registration
  app.post("/api/onboarding/organization", { schema: createOrganizationSchema }, createOrganization);

  // Draft persistence
  app.post("/api/onboarding/draft", saveDraft);
  app.get("/api/onboarding/draft", getDraft);

  // 2FA Google Authenticator (TOTP)
  app.post("/api/onboarding/totp/setup", { preHandler: [authenticate] }, setupOnboardingTOTP);
  app.post("/api/onboarding/totp/verify", { preHandler: [authenticate] }, verifyOnboardingTOTP);

  // Platform Organization Admin Management
  app.get("/api/organizations", { preHandler: [authenticate] }, getAllOrganizations);
  app.get("/api/onboarding/organizations/:id/members", { preHandler: [authenticate] }, getOrganizationMembers);
  app.get("/api/admin/users", { preHandler: [authenticate] }, getGlobalUsers);
  app.get("/api/admin/hierarchy", { preHandler: [authenticate] }, getPlatformHierarchy);
  app.put("/api/organizations/:id", { preHandler: [authenticate] }, updateOrganizationById);
  app.delete("/api/organizations/:id", { preHandler: [authenticate] }, deleteOrganizationById);

  // Organization Settings
  const manageOrg = { preHandler: [authenticate, checkPermission("MANAGE_ORGANIZATION")] };
  app.get("/api/onboarding/organization/me", manageOrg, getOrganizationSettings);
  app.put("/api/onboarding/organization/me", manageOrg, updateOrganizationSettings);

  // Organization SMTP / Email Gateway Config
  app.get("/api/onboarding/organization/me/smtp", manageOrg, getOrganizationSmtp);
  app.put("/api/onboarding/organization/me/smtp", manageOrg, updateOrganizationSmtp);
}





