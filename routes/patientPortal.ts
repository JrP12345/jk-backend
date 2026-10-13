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

  app.post("/api/patient-portal/self-book", { ...patientAppointments, schema: { body: {
    type: 'object', required: ['locationId', 'doctorId', 'appointmentTime'], additionalProperties: false,
    properties: {
      locationId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' }, doctorId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
      appointmentTime: { type: 'string', minLength: 10, maxLength: 40 }, appointmentType: { type: 'string', enum: ['online', 'walk-in', 'reception'] },
      notes: { type: 'string', maxLength: 2000 }, forPatientId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
      lockId: { type: 'string', maxLength: 200 }, payAtLocation: { type: 'boolean' }, clientRequestId: { type: 'string', pattern: '^[a-zA-Z0-9_-]{8,100}$' },
    },
  } } }, patientSelfBookAppointment);
  app.get("/api/patient-portal/appointments", { ...patientAppointments, schema: { querystring: { type: 'object', additionalProperties: false,
    properties: { page: { type: 'integer', minimum: 1, maximum: 10000 }, limit: { type: 'integer', minimum: 1, maximum: 100 } } } } }, getPatientAppointmentsHistory);

  app.get("/api/patient-portal/records", patientRecords, getPatientMedicalRecords);

  app.post("/api/prescriptions/:id/refill", pharmacyRefills, createPrescriptionRefillRequest);
  app.get("/api/prescriptions/refills", pharmacyRefills, getPrescriptionRefillRequests);
  app.patch("/api/prescriptions/refills/:id", pharmacyRefills, updatePrescriptionRefillRequestStatus);
}
