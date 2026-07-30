import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import {
  upsertTariff,
  getTariffs,
  evaluateTariff,
} from "../controllers/insuranceTariff.ts";

export default async function insuranceTariffRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };

  app.post("/api/insurance/tariffs", auth, upsertTariff);
  app.get("/api/insurance/tariffs", auth, getTariffs);
  app.post("/api/insurance/tariffs/evaluate", auth, evaluateTariff);
}
