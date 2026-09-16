import type { FastifyInstance } from "fastify";
import { authenticate, checkAnyPermission } from "../middleware/auth.ts";
import {
  createPreAuthRequest,
  getPreAuthList,
  updatePreAuthStatus,
} from "../controllers/preAuth.ts";
import {
  createPreAuthSchema,
  preAuthListQuerySchema,
  updatePreAuthStatusSchema,
} from "../schemas/operations.ts";

export default async function preAuthRoutes(app: FastifyInstance) {
  const manageBilling = { preHandler: [authenticate, checkAnyPermission("MANAGE_BILLING", "MANAGE_ORGANIZATION")] };
  const viewBilling = { preHandler: [authenticate, checkAnyPermission("VIEW_BILLING", "MANAGE_BILLING", "MANAGE_ORGANIZATION")] };

  app.post("/api/pre-auth", { ...manageBilling, schema: createPreAuthSchema }, createPreAuthRequest);
  app.get("/api/pre-auth", { ...viewBilling, schema: preAuthListQuerySchema }, getPreAuthList);
  app.put("/api/pre-auth/:id", { ...manageBilling, schema: updatePreAuthStatusSchema }, updatePreAuthStatus);

}
