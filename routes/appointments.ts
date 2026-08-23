import type { FastifyInstance } from "fastify";
import { authenticate, checkAnyPermission, checkAnyPermissionOrRoles, checkPermission } from "../middleware/auth.ts";
import { requireModule } from "../middleware/moduleGuard.ts";
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
} from "../controllers/queue.ts";

export default async function appointmentRoutes(app: FastifyInstance) {
  const viewAppointments = {
    preHandler: [authenticate, requireModule("appointments"), checkAnyPermission("VIEW_APPOINTMENTS", "MANAGE_APPOINTMENTS")],
  };
  const bookAppointments = {
    preHandler: [authenticate, requireModule("appointments"), checkAnyPermissionOrRoles(["patient"], "MANAGE_APPOINTMENTS")],
  };
  const manageAppointments = {
    preHandler: [authenticate, requireModule("appointments"), checkAnyPermissionOrRoles(["patient"], "MANAGE_APPOINTMENTS")],
  };
  const viewPatients = {
    preHandler: [authenticate, requireModule("patients"), checkAnyPermission("VIEW_PATIENTS", "MANAGE_PATIENTS")],
  };
  const managePatients = {
    preHandler: [authenticate, requireModule("patients"), checkAnyPermissionOrRoles(["patient"], "MANAGE_PATIENTS")],
  };
  const viewQueue = {
    preHandler: [authenticate, requireModule("queue"), checkAnyPermission("MANAGE_QUEUE", "VIEW_APPOINTMENTS")],
  };
  const manageQueue = {
    preHandler: [authenticate, requireModule("queue"), checkPermission("MANAGE_QUEUE")],
  };
  const checkIn = {
    preHandler: [authenticate, requireModule("queue"), checkAnyPermissionOrRoles(["patient"], "MANAGE_QUEUE")],
  };
  const viewAudit = {
    preHandler: [authenticate, requireModule("audit"), checkPermission("VIEW_AUDIT_LOGS")],
  };

  // Appointments
  app.post("/api/appointments", { ...bookAppointments, schema: bookAppointmentSchema }, bookAppointment);
  app.get("/api/appointments", viewAppointments, getAppointments);
  app.get("/api/appointments/:id", viewAppointments, getAppointmentById);
  app.put("/api/appointments/:id/status", { ...manageAppointments, schema: updateAppointmentStatusSchema }, updateAppointmentStatus);
  app.post("/api/appointments/:id/check-in", checkIn, checkInAppointment);
  app.put("/api/appointments/:id/cancel", manageAppointments, cancelAppointment);
  app.patch("/api/appointments/:id/reschedule", manageAppointments, rescheduleAppointment);
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
  app.get("/api/audit-logs", viewAudit, getAuditLogs);
}
