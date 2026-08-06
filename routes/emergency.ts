import type { FastifyInstance } from "fastify";
import { authenticate, authorize } from "../middleware/auth.ts";
import {
  createEmergencyTriage,
  getEmergencyTriages,
  updateEmergencyTriage,
} from "../controllers/emergency.ts";

export default async function emergencyRoutes(app: FastifyInstance) {
  app.post("/api/emergency/triage", { preHandler: [authenticate, authorize("admin", "doctor", "nurse", "receptionist")] }, createEmergencyTriage);
  app.get("/api/emergency/triage", { preHandler: [authenticate] }, getEmergencyTriages);
  app.put("/api/emergency/triage/:id", { preHandler: [authenticate, authorize("admin", "doctor", "nurse")] }, updateEmergencyTriage);
}

