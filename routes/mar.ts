import type { FastifyInstance } from "fastify";
import { authenticate, checkPermission } from "../middleware/auth.ts";
import {
  scheduleMARController,
  getEncounterMARController,
  administerMARController,
  refuseMARController,
  holdMARController,
  getPrescriptionMARController,
} from "../controllers/mar.ts";

export default async function marRoutes(app: FastifyInstance) {
  const administerMed = { preHandler: [authenticate, checkPermission("ADMINISTER_MEDICATION")] };
  const viewEhr = { preHandler: [authenticate, checkPermission("VIEW_EHR")] };

  app.post("/api/encounters/:id/mar", administerMed, scheduleMARController);
  app.get("/api/encounters/:id/mar", viewEhr, getEncounterMARController);
  app.put("/api/mar/:id/administer", administerMed, administerMARController);
  app.put("/api/mar/:id/refuse", administerMed, refuseMARController);
  app.put("/api/mar/:id/hold", administerMed, holdMARController);
  app.get("/api/prescriptions/:id/mar", viewEhr, getPrescriptionMARController);
}
