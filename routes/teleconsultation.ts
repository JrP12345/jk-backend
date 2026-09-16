import type { FastifyInstance } from "fastify";
import { authenticate, checkAnyPermission, checkAnyPermissionOrRoles, checkPermission, denyRoles } from "../middleware/auth.ts";
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
import {
  createTeleSessionSchema,
  teleSessionAppointmentParamSchema,
  teleSessionIdParamSchema,
  teleSessionSignalSchema,
  teleSessionsQuerySchema,
  updateTeleSessionNotesSchema,
} from "../schemas/clinical.ts";

export default async function teleconsultationRoutes(app: FastifyInstance) {
  const staffOnly = denyRoles("patient", "family_member", "guest");
  const viewSession = {
    preHandler: [
      authenticate,
      checkAnyPermissionOrRoles(["patient"], "VIEW_APPOINTMENTS", "VIEW_EHR", "MANAGE_APPOINTMENTS"),
    ],
  };
  const createSession = {
    preHandler: [
      authenticate,
      checkAnyPermissionOrRoles(["patient"], "MANAGE_APPOINTMENTS"),
    ],
  };
  const manageSession = {
    preHandler: [
      authenticate,
      staffOnly,
      checkAnyPermission("MANAGE_APPOINTMENTS", "MANAGE_CLINICAL_NOTES"),
    ],
  };
  const updateClinicalNotes = {
    preHandler: [authenticate, staffOnly, checkPermission("MANAGE_CLINICAL_NOTES")],
  };
  const signalSession = {
    preHandler: [
      authenticate,
      checkAnyPermissionOrRoles(["patient"], "VIEW_APPOINTMENTS", "MANAGE_APPOINTMENTS", "MANAGE_CLINICAL_NOTES"),
    ],
  };

  app.get("/api/teleconsultation/sessions", { ...viewSession, schema: teleSessionsQuerySchema }, getTeleSessions);
  app.post("/api/teleconsultation/session", { ...createSession, schema: createTeleSessionSchema }, createTeleSession);
  app.get("/api/teleconsultation/session/:appointmentId", { ...viewSession, schema: teleSessionAppointmentParamSchema }, getTeleSession);
  app.put("/api/teleconsultation/session/:id/start", { ...manageSession, schema: teleSessionIdParamSchema }, startTeleSession);
  app.put("/api/teleconsultation/session/:id/notes", { ...updateClinicalNotes, schema: updateTeleSessionNotesSchema }, updateTeleSessionNotes);
  app.put("/api/teleconsultation/session/:id/end", { ...manageSession, schema: teleSessionIdParamSchema }, endTeleSession);
  app.post("/api/teleconsultation/session/:id/signal", { ...signalSession, schema: teleSessionSignalSchema }, postSessionSignal);
  app.get("/api/teleconsultation/session/:id/signals", { ...signalSession, schema: teleSessionIdParamSchema }, getSessionSignals);
}
