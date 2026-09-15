import type { FastifyInstance } from "fastify";
import { authenticate, checkPermission, requirePlatformRoot } from "../middleware/auth.ts";
import {
  createOrganizationSchema,
  globalUsersQuerySchema,
  organizationIdParamSchema,
  updateOrganizationSchema,
} from "../schemas/onboarding.ts";
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
  const platformRoot = { preHandler: [authenticate, requirePlatformRoot()] };
  const manageOrg = { preHandler: [authenticate, checkPermission("MANAGE_ORGANIZATION")] };

  app.get("/api/organizations", manageOrg, getAllOrganizations);
  app.get(
    "/api/onboarding/organizations/:id/members",
    { ...manageOrg, schema: organizationIdParamSchema },
    getOrganizationMembers
  );
  app.get("/api/admin/users", { ...platformRoot, schema: globalUsersQuerySchema }, getGlobalUsers);
  app.get("/api/admin/hierarchy", platformRoot, getPlatformHierarchy);
  app.put("/api/organizations/:id", { ...manageOrg, schema: updateOrganizationSchema }, updateOrganizationById);
  app.delete("/api/organizations/:id", { ...platformRoot, schema: organizationIdParamSchema }, deleteOrganizationById);

  // Organization Settings
  app.get("/api/onboarding/organization/me", manageOrg, getOrganizationSettings);
  app.put("/api/onboarding/organization/me", manageOrg, updateOrganizationSettings);

  // Organization SMTP / Email Gateway Config
  app.get("/api/onboarding/organization/me/smtp", manageOrg, getOrganizationSmtp);
  app.put("/api/onboarding/organization/me/smtp", manageOrg, updateOrganizationSmtp);
}





