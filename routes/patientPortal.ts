import type { FastifyInstance } from "fastify";
import { authenticate, checkAnyPermissionOrRoles } from "../middleware/auth.ts";
import { requireModule } from "../middleware/moduleGuard.ts";
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
  const patientProfile = {
    preHandler: [
      authenticate,
      requireModule("patients"),
      checkAnyPermissionOrRoles(["patient"], "VIEW_PATIENTS", "MANAGE_PATIENTS"),
    ],
  };
  const patientAppointments = {
    preHandler: [
      authenticate,
      requireModule("appointments"),
      checkAnyPermissionOrRoles(["patient", "family_member"], "VIEW_APPOINTMENTS", "MANAGE_APPOINTMENTS"),
    ],
  };
  const patientRecords = {
    preHandler: [
      authenticate,
      requireModule("consultations"),
      checkAnyPermissionOrRoles(["patient", "family_member"], "VIEW_EHR"),
    ],
  };
  const pharmacyRefills = {
    preHandler: [
      authenticate,
      requireModule("pharmacy"),
      checkAnyPermissionOrRoles(["patient"], "VIEW_EHR", "MANAGE_MEDICINES"),
    ],
  };

  app.get("/api/patient/me", patientProfile, getCurrentPatientProfile);
  app.put("/api/patient/me", patientProfile, updateCurrentPatientProfile);

  app.post("/api/patient-portal/self-book", patientAppointments, patientSelfBookAppointment);
  app.get("/api/patient-portal/appointments", patientAppointments, getPatientAppointmentsHistory);

  app.get("/api/patient-portal/records", patientRecords, getPatientMedicalRecords);

  app.post("/api/prescriptions/:id/refill", pharmacyRefills, createPrescriptionRefillRequest);
  app.get("/api/prescriptions/refills", pharmacyRefills, getPrescriptionRefillRequests);
  app.patch("/api/prescriptions/refills/:id", pharmacyRefills, updatePrescriptionRefillRequestStatus);
}
