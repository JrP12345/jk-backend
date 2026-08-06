import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import {
  getCurrentPatientProfile,
  updateCurrentPatientProfile,
  createPrescriptionRefillRequest,
  getPrescriptionRefillRequests,
  updatePrescriptionRefillRequestStatus,
  patientSelfBookAppointment,
  getPatientAppointmentsHistory,
  getPatientMedicalRecords,
} from "../controllers/patientPortal.ts";

export default async function patientPortalRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };

  // Patient Profile Management
  app.get("/api/patient/me", auth, getCurrentPatientProfile);
  app.put("/api/patient/me", auth, updateCurrentPatientProfile);

  // Patient Self-Booking & History
  app.post("/api/patient-portal/self-book", auth, patientSelfBookAppointment);
  app.get("/api/patient-portal/appointments", auth, getPatientAppointmentsHistory);

  // Longitudinal Medical Records Summary
  app.get("/api/patient-portal/records", auth, getPatientMedicalRecords);

  // Prescription Refill Request Workflow
  app.post("/api/prescriptions/:id/refill", auth, createPrescriptionRefillRequest);
  app.get("/api/prescriptions/refills", auth, getPrescriptionRefillRequests);
  app.patch("/api/prescriptions/refills/:id", auth, updatePrescriptionRefillRequestStatus);
}
