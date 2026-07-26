import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import {
  getCurrentPatientProfile,
  updateCurrentPatientProfile,
  createPrescriptionRefillRequest,
  getPrescriptionRefillRequests,
  updatePrescriptionRefillRequestStatus,
} from "../controllers/patientPortal.ts";

export default async function patientPortalRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };

  // Patient Profile Management
  app.get("/api/patient/me", auth, getCurrentPatientProfile);
  app.put("/api/patient/me", auth, updateCurrentPatientProfile);

  // Prescription Refill Request Workflow
  app.post("/api/prescriptions/:id/refill", auth, createPrescriptionRefillRequest);
  app.get("/api/prescriptions/refills", auth, getPrescriptionRefillRequests);
  app.patch("/api/prescriptions/refills/:id", auth, updatePrescriptionRefillRequestStatus);
}
