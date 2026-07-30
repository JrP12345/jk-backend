import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
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
} from "../controllers/patient.ts";
import {
  getQueue,
  reorderQueue,
  getAuditLogs,
  callNextPatient,
} from "../controllers/queue.ts";

export default async function appointmentRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };

  // Appointments
  app.post("/api/appointments", { ...auth, schema: bookAppointmentSchema }, bookAppointment);
  app.get("/api/appointments", auth, getAppointments);
  app.get("/api/appointments/:id", auth, getAppointmentById);
  app.put("/api/appointments/:id/status", { ...auth, schema: updateAppointmentStatusSchema }, updateAppointmentStatus);
  app.put("/api/appointments/:id/cancel", auth, cancelAppointment);
  app.patch("/api/appointments/:id/reschedule", auth, rescheduleAppointment);
  app.get("/api/doctors/:doctorId/slots", auth, getDoctorSlots);

  // Slot Locking (anti-double-booking)
  app.post("/api/appointments/lock-slot", auth, lockSlot);
  app.delete("/api/appointments/lock-slot", auth, unlockSlot);
  app.get("/api/appointments/slot-lock-status", auth, getSlotLockStatus);

  // Patients
  app.get("/api/patients", auth, searchPatients);
  app.get("/api/patients/:id", auth, getPatientDetails);
  app.post("/api/doctors/:id/reviews", auth, submitDoctorReview);

  // Queue & VIP Override
  app.get("/api/queue", auth, getQueue);
  app.put("/api/queue/reorder", auth, reorderQueue);
  app.post("/api/queue/call-next", auth, callNextPatient);
  app.get("/api/audit-logs", auth, getAuditLogs);
}
