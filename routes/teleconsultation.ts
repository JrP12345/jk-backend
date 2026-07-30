import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import {
  createTeleSession,
  getTeleSession,
  endTeleSession,
} from "../controllers/teleconsultation.ts";

export default async function teleconsultationRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };

  app.post("/api/teleconsultation/sessions", auth, createTeleSession);
  app.get("/api/teleconsultation/sessions/:appointmentId", auth, getTeleSession);
  app.put("/api/teleconsultation/sessions/:id/end", auth, endTeleSession);
}
