import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import {
  registerBloodUnit,
  getBloodUnits,
  crossMatchAndReserve,
} from "../controllers/bloodBank.ts";

export default async function bloodBankRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };

  app.post("/api/blood-bank/units", auth, registerBloodUnit);
  app.get("/api/blood-bank/units", auth, getBloodUnits);
  app.post("/api/blood-bank/cross-match", auth, crossMatchAndReserve);
}
