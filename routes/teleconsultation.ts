import type { FastifyInstance } from "fastify";
import { authenticate, authorize } from "../middleware/auth.ts";
import {
  createTeleSession,
  getTeleSession,
  getTeleSessions,
  startTeleSession,
  updateTeleSessionNotes,
  endTeleSession,
  postSessionSignal,
  getSessionSignals,
} from "../controllers/teleconsultation.ts";

export default async function teleconsultationRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };
  const manageSession = { preHandler: [authenticate, authorize("admin", "doctor", "nurse", "patient")] };

  app.get("/api/teleconsultation/sessions", auth, getTeleSessions);
  app.post("/api/teleconsultation/session", manageSession, createTeleSession);
  app.get("/api/teleconsultation/session/:appointmentId", auth, getTeleSession);
  app.put("/api/teleconsultation/session/:id/start", manageSession, startTeleSession);
  app.put("/api/teleconsultation/session/:id/notes", manageSession, updateTeleSessionNotes);
  app.put("/api/teleconsultation/session/:id/end", manageSession, endTeleSession);
  app.post("/api/teleconsultation/session/:id/signal", manageSession, postSessionSignal);
  app.get("/api/teleconsultation/session/:id/signals", manageSession, getSessionSignals);
}
