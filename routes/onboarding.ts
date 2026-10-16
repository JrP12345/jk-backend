import type { FastifyInstance } from "fastify";
import { removeOrganizationMember, updateGlobalUserStatus, updateMemberLocationAccess } from "../controllers/organizationMembers.ts";
import { getPlatformDashboard } from "../controllers/platformDashboard.ts";
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
  getOrganizationWorkflowPreferences,
  updateOrganizationSettings,
  getOrganizationSmtp,
  updateOrganizationSmtp,
  getOrganizationMembers,
  getGlobalUsers,
  getPlatformHierarchy,
} from "../controllers/onboarding.ts";

export default async function onboardingRoutes(app: FastifyInstance) {
  // Authenticated platform organization provisioning
  app.post("/api/onboarding/organization", {
    schema: createOrganizationSchema,
    preHandler: [authenticate, requirePlatformRoot()],
  }, createOrganization);

  // Draft persistence
  app.post("/api/onboarding/draft", saveDraft);
  app.get("/api/onboarding/draft", getDraft);

  // 2FA Google Authenticator (TOTP)
  const totpAccess = { preHandler: [authenticate], config: { rateLimit: { max: process.env.NODE_ENV === "test" ? 1000 : 5, timeWindow: "1 minute" } } };
  app.post("/api/onboarding/totp/setup", totpAccess, setupOnboardingTOTP);
  app.post("/api/onboarding/totp/verify", totpAccess, verifyOnboardingTOTP);

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
  app.put("/api/admin/users/:id/status", { ...platformRoot, schema: {
    ...organizationIdParamSchema,
    body: { type: "object", required: ["isActive"], properties: { isActive: { type: "boolean" } }, additionalProperties: false },
  } }, updateGlobalUserStatus);
  app.delete("/api/organizations/:id/members/:userId", { preHandler: [authenticate, checkPermission("MANAGE_STAFF")], schema: {
    params: { type: "object", required: ["id", "userId"], properties: { id: { type: "string", pattern: "^[a-fA-F0-9]{24}$" }, userId: { type: "string", pattern: "^[a-fA-F0-9]{24}$" } }, additionalProperties: false },
  } }, removeOrganizationMember);
  app.patch("/api/organizations/:id/members/:userId/location-access", { ...manageOrg, schema: {
    params: { type: "object", required: ["id", "userId"], additionalProperties: false,
      properties: { id: { type: "string", pattern: "^[a-fA-F0-9]{24}$" }, userId: { type: "string", pattern: "^[a-fA-F0-9]{24}$" } } },
    body: { type: "object", required: ["mode", "locationIds", "expectedRevision"], additionalProperties: false,
      properties: { mode: { type: "string", enum: ["all", "selected"] }, expectedRevision: { type: "integer", minimum: 0 },
        locationIds: { type: "array", maxItems: 100, uniqueItems: true, items: { type: "string", pattern: "^[a-fA-F0-9]{24}$" } } } },
  } }, updateMemberLocationAccess);
  app.get("/api/admin/hierarchy", platformRoot, getPlatformHierarchy);
  app.get("/api/admin/dashboard", { ...platformRoot, schema: {
    querystring: { type: "object", properties: { range: { type: "string", enum: ["7D", "30D", "90D"], default: "30D" } }, additionalProperties: false },
  } }, getPlatformDashboard);
  app.put("/api/organizations/:id", { ...manageOrg, schema: updateOrganizationSchema }, updateOrganizationById);
  app.delete("/api/organizations/:id", { ...platformRoot, schema: organizationIdParamSchema }, deleteOrganizationById);

  // Organization Settings
  app.get("/api/onboarding/organization/preferences", { preHandler: [authenticate] }, getOrganizationWorkflowPreferences);
  app.get("/api/onboarding/organization/me", manageOrg, getOrganizationSettings);
  app.put("/api/onboarding/organization/me", { ...manageOrg, schema: { body: updateOrganizationSchema.body } }, updateOrganizationSettings);

  // Organization SMTP / Email Gateway Config
  app.get("/api/onboarding/organization/me/smtp", manageOrg, getOrganizationSmtp);
  app.put("/api/onboarding/organization/me/smtp", manageOrg, updateOrganizationSmtp);
}
