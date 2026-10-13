import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticate, checkAnyPermission, checkAnyPermissionOrRoles, checkPermission } from "../middleware/auth.ts";
import { requireModule } from "../middleware/moduleGuard.ts";
import { enforceNewBookingAllowed } from "../middleware/subscriptionGuard.ts";
import { bookAppointmentSchema, updateAppointmentStatusSchema } from "../schemas/appointment.ts";
import {
  bookAppointment,
  getAppointments,
  getAppointmentById,
  updateAppointmentStatus,
  getDoctorSlots,
  cancelAppointment,
  lockSlot,
  unlockSlot,
  getSlotLockStatus,
  rescheduleAppointment,
  resendPrescriptionNotification,
  getFollowUpRegister,
  sendFollowUpReminder,
} from "../controllers/appointment.ts";
import {
  searchPatients,
  getPatientDetails,
  submitDoctorReview,
  updatePatientProfile,
  createPatient,
} from "../controllers/patient.ts";
import {
  getQueue,
  getQueueStatus,
  reorderQueue,
  getAuditLogs,
  callNextPatient,
  checkInAppointment,
  bumpQueuePatient,
  parkQueuePatient,
  resumeQueuePatient,
  getQueueDelayStatus,
  triggerQueueDelayAlerts,
  sendPatientForInvestigation,
  resumeForReportReview,
  startOpdSession,
  getOpdSessionSummary,
  endOpdSessionAndReconcile,
  toggleDoctorBreak,
  recordPatientVitals,
  triggerStatEmergency,
  resendQueueTrackerNotification,
  verifyAuditLogsIntegrity,
} from "../controllers/queue.ts";
import { handleQueueWebSocket, handleClinicalWebSocket } from "../notifications/websocket.ts";
import { listPatientIdentityClaims, reviewPatientIdentityClaim, getOrganizationPatientContact, correctOrganizationPatientContact, associateOrganizationPatient } from "../controllers/patientIdentity.ts";
import { listCrmLocations } from '../controllers/crmLocations.ts';

export default async function appointmentRoutes(app: FastifyInstance) {
  const denyConsumerQueueAccess = async (req: FastifyRequest, reply: FastifyReply) => {
    if (["patient", "family_member", "guest"].includes(req.user?.role || "")) {
      return reply.code(403).send({ success: false, message: "Full queue access is restricted to location staff" });
    }
  };
  const viewAppointments = {
    preHandler: [authenticate, requireModule("appointments"), checkAnyPermissionOrRoles(["patient", "family_member"], "VIEW_APPOINTMENTS", "MANAGE_APPOINTMENTS")],
  };
  const bookAppointments = {
    config: { allowGuest: true },
    preHandler: [authenticate, requireModule("appointments"), checkAnyPermissionOrRoles(["patient", "family_member", "guest"], "MANAGE_APPOINTMENTS", "CREATE_APPOINTMENTS"), enforceNewBookingAllowed],
  };
  const manageAppointments = {
    preHandler: [authenticate, requireModule("appointments"), checkAnyPermissionOrRoles(["patient", "family_member"], "MANAGE_APPOINTMENTS")],
  };
  const viewPatients = {
    preHandler: [authenticate, requireModule("patients"), checkAnyPermissionOrRoles(["patient", "family_member"], "VIEW_PATIENTS", "MANAGE_PATIENTS")],
  };
  const managePatients = {
    preHandler: [authenticate, requireModule("patients"), checkAnyPermissionOrRoles(["patient", "family_member"], "MANAGE_PATIENTS")],
  };
  const viewQueue = {
    // Full queue responses contain other patients' contact details. Consumers
    // use the capability-protected tracker; this operational view is staff-only.
    preHandler: [authenticate, requireModule("queue"), denyConsumerQueueAccess, checkAnyPermission("MANAGE_QUEUE", "VIEW_APPOINTMENTS")],
  };
  const manageQueue = {
    preHandler: [authenticate, requireModule("queue"), checkPermission("MANAGE_QUEUE")],
  };
  const checkIn = {
    preHandler: [authenticate, requireModule("queue"), checkAnyPermissionOrRoles(["patient", "family_member"], "MANAGE_QUEUE")],
  };
  const viewAudit = {
    preHandler: [authenticate, requireModule("audit"), checkPermission("VIEW_AUDIT_LOGS")],
  };

  // Appointments
  app.post("/api/appointments", { ...bookAppointments, schema: bookAppointmentSchema }, bookAppointment);
  app.get("/api/appointments", viewAppointments, getAppointments);
  app.get("/api/appointments/patient/me", viewAppointments, getAppointments);
  app.get("/api/appointments/:id", viewAppointments, getAppointmentById);
  app.put("/api/appointments/:id/status", { ...manageAppointments, schema: updateAppointmentStatusSchema }, updateAppointmentStatus);
  app.post("/api/appointments/:id/check-in", checkIn, checkInAppointment);
  app.put("/api/appointments/:id/cancel", manageAppointments, cancelAppointment);
  app.patch("/api/appointments/:id/reschedule", manageAppointments, rescheduleAppointment);
  app.post("/api/appointments/:id/resend-rx", { ...manageAppointments, preHandler: [...manageAppointments.preHandler, checkAnyPermission('COMMUNICATE_PATIENTS')], schema: { body: { type: 'object', additionalProperties: false, required: ['clientRequestId'], properties: { clientRequestId: { type: 'string', minLength: 8, maxLength: 100 }, phone: { type: 'string', maxLength: 30 }, channel: { type: 'string', enum: ['whatsapp'] } } } } }, resendPrescriptionNotification);
  app.get("/api/appointments/follow-ups", viewAppointments, getFollowUpRegister);
  app.post("/api/appointments/:id/send-followup-reminder", manageAppointments, sendFollowUpReminder);
  app.get("/api/doctors/:doctorId/slots", viewAppointments, getDoctorSlots);

  // Slot Locking (anti-double-booking)
  app.post("/api/appointments/lock-slot", { preHandler: [...manageAppointments.preHandler, enforceNewBookingAllowed] }, lockSlot);
  app.delete("/api/appointments/lock-slot", manageAppointments, unlockSlot);
  app.get("/api/appointments/slot-lock-status", viewAppointments, getSlotLockStatus);

  // Patients
  app.get('/api/patients/association-locations', { preHandler: [authenticate, checkAnyPermission('MANAGE_PATIENTS'), checkAnyPermission('REVIEW_PATIENT_IDENTITY')], schema: { querystring: { type: 'object', additionalProperties: false, properties: { page: { type: 'integer', minimum: 1, maximum: 5000, default: 1 }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 200 } } } } }, listCrmLocations);
  app.post("/api/patients", managePatients, createPatient);
  const patientIdParams = { type: "object", required: ["id"], properties: { id: { type: "string", pattern: "^[a-fA-F0-9]{24}$" }, claimId: { type: "string", pattern: "^[a-fA-F0-9]{24}$" } } };
  const identityClaims = { preHandler: [authenticate, requireModule("patients"), checkPermission("REVIEW_PATIENT_IDENTITY")] };
  app.post("/api/patients/:id/associate", { preHandler: [...identityClaims.preHandler, checkPermission("MANAGE_PATIENTS")], schema: {
    params: patientIdParams, body: { type: "object", additionalProperties: false, required: ["locationId", "verificationMethod", "reason", "clientRequestId"], properties: {
      locationId: { type: "string", pattern: "^[a-fA-F0-9]{24}$" }, verificationMethod: { type: "string", enum: ["in_person", "patient_record_access"] },
      identityVerified: { type: "boolean" }, reason: { type: "string", minLength: 1, maxLength: 500 }, clientRequestId: { type: "string", minLength: 8, maxLength: 100 },
    } },
  } }, associateOrganizationPatient);
  app.get("/api/patients/:id/identity-claims", { ...identityClaims, schema: { params: patientIdParams, querystring: {
    type: "object", additionalProperties: false, properties: { cursor: { type: "string", pattern: "^[a-fA-F0-9]{24}$" } },
  } } }, listPatientIdentityClaims);
  app.post("/api/patients/:id/identity-claims/:claimId/review", { ...identityClaims, schema: { params: { ...patientIdParams, required: ["id", "claimId"] },
    body: { type: "object", additionalProperties: false, required: ["decision", "reason", "clientRequestId"], properties: {
      decision: { type: "string", enum: ["approve", "reject"] }, identityVerified: { type: "boolean" }, reason: { type: "string", minLength: 1, maxLength: 500 }, clientRequestId: { type: "string", minLength: 8, maxLength: 100 },
    } } } }, reviewPatientIdentityClaim);
  app.get("/api/patients/:id/contact", { ...managePatients, schema: { params: patientIdParams } }, getOrganizationPatientContact);
  app.patch("/api/patients/:id/contact", { ...managePatients, schema: { params: patientIdParams, body: {
    type: "object", additionalProperties: false, required: ["phone", "email", "availability", "expectedRevision", "reason", "clientRequestId"], properties: {
      phone: { type: "string", maxLength: 30 }, email: { type: "string", maxLength: 200 },
      availability: { type: "string", enum: ["unknown", "reachable", "unreachable", "invalid"] },
      expectedRevision: { type: "integer", minimum: 0 }, reason: { type: "string", minLength: 1, maxLength: 500 }, clientRequestId: { type: "string", minLength: 8, maxLength: 100 },
    },
  } } }, correctOrganizationPatientContact);
  app.get("/api/patients", viewPatients, searchPatients);
  app.get("/api/patients/:id", viewPatients, getPatientDetails);
  app.patch("/api/patients/:id", managePatients, updatePatientProfile);
  app.post("/api/doctors/:id/reviews", {
    preHandler: [
      authenticate,
      requireModule("appointments"),
      checkAnyPermissionOrRoles(["patient", "family_member"], "VIEW_APPOINTMENTS"),
    ],
  }, submitDoctorReview);

  // Queue & VIP Override
  app.get("/api/queue", viewQueue, getQueue);
  app.get("/api/queue/status", viewQueue, getQueueStatus);
  app.put("/api/queue/reorder", manageQueue, reorderQueue);
  app.post("/api/queue/call-next", manageQueue, callNextPatient);
  app.post("/api/queue/:id/bump-back", manageQueue, bumpQueuePatient);
  app.post("/api/queue/:id/park", manageQueue, parkQueuePatient);
  app.post("/api/queue/:id/resume", manageQueue, resumeQueuePatient);
  app.post("/api/queue/:id/order-investigations", manageQueue, sendPatientForInvestigation);
  app.post("/api/queue/:id/resume-review", manageQueue, resumeForReportReview);
  app.post("/api/queue/session/start", manageQueue, startOpdSession);
  app.get("/api/queue/session/summary", viewQueue, getOpdSessionSummary);
  app.post("/api/queue/session/end", manageQueue, endOpdSessionAndReconcile);
  app.post("/api/queue/session/break", manageQueue, toggleDoctorBreak);
  app.get("/api/queue/delay-status", viewQueue, getQueueDelayStatus);
  app.post("/api/queue/trigger-delay-alerts", manageQueue, triggerQueueDelayAlerts);
  app.post("/api/queue/:id/vitals", manageQueue, recordPatientVitals);
  app.post("/api/queue/:id/stat-emergency", manageQueue, triggerStatEmergency);
  app.post("/api/queue/:id/resend-tracker", manageQueue, resendQueueTrackerNotification);
  app.get("/api/audit-logs", viewAudit, getAuditLogs);
  app.get("/api/audit-logs/verify-integrity", viewAudit, verifyAuditLogsIntegrity);

  // Real-time Queue WebSocket for Location TV / Lobby Displays (Public & Sanitized)
  app.get("/api/queue/ws", { websocket: true }, (socket, req) => {
    void handleQueueWebSocket(socket as any, req);
  });

  // Real-time Clinical WebSocket for Authenticated Clinical Staff (Doctor/Nurse/Admin)
  app.get("/api/clinical/ws", { websocket: true }, (socket, req) => {
    void handleClinicalWebSocket(socket as any, req).catch(() => {
      (socket as any).close(1011, "Clinical channel initialization failed");
    });
  });
}
