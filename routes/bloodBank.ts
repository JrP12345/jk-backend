import type { FastifyInstance } from "fastify";
import { authenticate, authorize } from "../middleware/auth.ts";
import {
  registerBloodUnit,
  getBloodUnits,
  crossMatchAndReserve,
  updateBloodUnitStatus,
} from "../controllers/bloodBank.ts";

export default async function bloodBankRoutes(app: FastifyInstance) {
  app.post("/api/blood-bank/units", { preHandler: [authenticate, authorize("admin", "doctor", "lab_tech", "nurse")] }, registerBloodUnit);
  app.get("/api/blood-bank/units", { preHandler: [authenticate] }, getBloodUnits);
  app.post("/api/blood-bank/cross-match", { preHandler: [authenticate, authorize("admin", "doctor", "lab_tech")] }, crossMatchAndReserve);
  app.patch("/api/blood-bank/units/:id/status", { preHandler: [authenticate, authorize("admin", "doctor", "lab_tech", "nurse")] }, updateBloodUnitStatus);
}


