import type { FastifyInstance } from "fastify";
import { authenticate, checkAnyPermission } from "../middleware/auth.ts";
import {
  upsertTariff,
  getTariffs,
  evaluateTariff,
} from "../controllers/insuranceTariff.ts";
import {
  evaluateTariffSchema,
  insuranceTariffsQuerySchema,
  upsertInsuranceTariffSchema,
} from "../schemas/operations.ts";

export default async function insuranceTariffRoutes(app: FastifyInstance) {
  const manageBilling = { preHandler: [authenticate, checkAnyPermission("MANAGE_BILLING", "MANAGE_ORGANIZATION")] };
  const viewBilling = { preHandler: [authenticate, checkAnyPermission("VIEW_BILLING", "MANAGE_BILLING", "MANAGE_ORGANIZATION")] };

  app.post("/api/insurance/tariffs", { ...manageBilling, schema: upsertInsuranceTariffSchema }, upsertTariff);
  app.get("/api/insurance/tariffs", { ...viewBilling, schema: insuranceTariffsQuerySchema }, getTariffs);
  app.post("/api/insurance/tariffs/evaluate", { ...viewBilling, schema: evaluateTariffSchema }, evaluateTariff);
}
