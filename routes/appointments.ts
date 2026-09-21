import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticate, checkAnyPermission, checkAnyPermissionOrRoles, checkPermission } from "../middleware/auth.ts";
import { requireModule } from "../middleware/moduleGuard.ts";
import { enforceSubscriptionActive } from "../middleware/subscriptionGuard.ts";
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
  triggerAutoNoShowDetection,
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

export default async function appointmentRoutes(app: FastifyInstance) {
  const denyConsumerQueueAccess = async (req: FastifyRequest, reply: FastifyReply) => {
    if (["patient", "family_member", "guest"].includes(req.user?.role || "")) {
      return reply.code(403).send({ success: false, message: "Full queue access is restricted to clinic staff" });
    }
  };
  const viewAppointments = {
    preHandler: [authenticate, requireModule("appointments"), checkAnyPermissionOrRoles(["patient", "family_member"], "VIEW_APPOINTMENTS", "MANAGE_APPOINTMENTS")],
  };
  const bookAppointments = {
    preHandler: [authenticate, requireModule("appointments"), checkAnyPermissionOrRoles(["patient", "family_member", "guest"], "MANAGE_APPOINTMENTS", "CREATE_APPOINTMENTS"), enforceSubscriptionActive],
  };
  const manageAppointments = {
    preHandler: [authenticate, requireModule("appointments"), checkAnyPermissionOrRoles(["patient", "family_member"], "MANAGE_APPOINTMENTS"), enforceSubscriptionActive],
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
  app.post("/api/appointments/:id/resend-rx", manageAppointments, resendPrescriptionNotification);
  app.get("/api/appointments/follow-ups", viewAppointments, getFollowUpRegister);
  app.post("/api/appointments/:id/send-followup-reminder", manageAppointments, sendFollowUpReminder);
  app.get("/api/doctors/:doctorId/slots", viewAppointments, getDoctorSlots);

  // Slot Locking (anti-double-booking)
  app.post("/api/appointments/lock-slot", manageAppointments, lockSlot);
  app.delete("/api/appointments/lock-slot", manageAppointments, unlockSlot);
  app.get("/api/appointments/slot-lock-status", viewAppointments, getSlotLockStatus);

  // Patients
  app.post("/api/patients", managePatients, createPatient);
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
  app.post("/api/queue/auto-no-show", manageQueue, triggerAutoNoShowDetection);
  app.post("/api/queue/:id/bump-back", manageQueue, bumpQueuePatient);
  app.post("/api/queue/:id/park", manageQueue, parkQueuePatient);
  app.post("/api/queue/:id/resume", manageQueue, resumeQueuePatient);
  app.post("/api/queue/:id/send-investigation", manageQueue, sendPatientForInvestigation);
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

  // Real-time Queue WebSocket for Clinic TV / Lobby Displays
  app.get("/api/queue/ws", { websocket: true }, (socket, req) => {
    handleQueueWebSocket(socket as any, req);
  });

  // Real-time Clinical WebSocket for Authenticated Clinical Staff (Doctor/Nurse/Admin)
  app.get("/api/clinical/ws", { websocket: true }, (socket, req) => {
    void handleClinicalWebSocket(socket as any, req).catch(() => {
      (socket as any).close(1011, "Clinical channel initialization failed");
    });
  });
}
