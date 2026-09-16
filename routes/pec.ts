import type { FastifyInstance } from "fastify";
import { authenticate, checkAnyPermission } from "../middleware/auth.ts";
import { evaluatePecClaim } from "../controllers/pec.ts";
import { evaluatePecSchema } from "../schemas/operations.ts";

export default async function pecRoutes(app: FastifyInstance) {
  const billingAccess = { preHandler: [authenticate, checkAnyPermission("VIEW_BILLING", "MANAGE_BILLING", "MANAGE_ORGANIZATION")] };

  app.post("/api/insurance/pec/evaluate", { ...billingAccess, schema: evaluatePecSchema }, evaluatePecClaim);
}
