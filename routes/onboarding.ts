import type { FastifyInstance } from "fastify";
import { removeOrganizationMember, updateGlobalUserStatus } from "../controllers/organizationMembers.ts";
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
  // Public Organization Registration
  app.post("/api/onboarding/organization", {
    schema: createOrganizationSchema,
    preHandler: async (req, reply) => {
      if (process.env.NODE_ENV !== "test" || req.headers.authorization || req.cookies?.access_token) await authenticate(req, reply);
    },
  }, createOrganization);

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
  app.put("/api/admin/users/:id/status", { ...platformRoot, schema: {
    ...organizationIdParamSchema,
    body: { type: "object", required: ["isActive"], properties: { isActive: { type: "boolean" } }, additionalProperties: false },
  } }, updateGlobalUserStatus);
  app.delete("/api/organizations/:id/members/:userId", { preHandler: [authenticate, checkPermission("MANAGE_STAFF")], schema: {
    params: { type: "object", required: ["id", "userId"], properties: { id: { type: "string", pattern: "^[a-fA-F0-9]{24}$" }, userId: { type: "string", pattern: "^[a-fA-F0-9]{24}$" } }, additionalProperties: false },
  } }, removeOrganizationMember);
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





