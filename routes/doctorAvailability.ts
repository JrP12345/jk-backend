import type { FastifyInstance, FastifyRequest } from "fastify";
import { authenticate, checkAnyPermissionOrRoles } from "../middleware/auth.ts";
import { requireModule } from "../middleware/moduleGuard.ts";
import { enforceSubscriptionActive } from "../middleware/subscriptionGuard.ts";
import { verifyAccessToken } from "../utilities/helpers.ts";
import {
  setDoctorDayOverride,
  getDoctorDayOverrides,
  deleteDoctorDayOverride,
  getTriageAppointments,
  getEligibleReplacements,
  triageTransferAppointment,
  triageCancelAppointment,
  triageRescheduleAppointment,
  triageBatchAction,
  patientDisruptionAction,
} from "../controllers/doctorAvailability.ts";

export default async function doctorAvailabilityRoutes(app: FastifyInstance) {
  const staffOrDoctor = {
    preHandler: [
      authenticate,
      requireModule("appointments"),
      checkAnyPermissionOrRoles(
        ["doctor", "receptionist", "admin", "root"],
        "MANAGE_APPOINTMENTS",
        "MANAGE_QUEUE",
        "VIEW_APPOINTMENTS"
      ),
      enforceSubscriptionActive,
    ],
  };

  const viewOverrides = {
    preHandler: [
      authenticate,
      requireModule("appointments"),
      checkAnyPermissionOrRoles(
        ["doctor", "receptionist", "admin", "root", "patient", "family_member"],
        "VIEW_APPOINTMENTS",
        "MANAGE_APPOINTMENTS"
      ),
    ],
  };

  const optionalAuth = async (req: FastifyRequest) => {
    try {
      const token =
        req.cookies?.access_token ||
        (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.split(" ")[1] : undefined);
      if (token) {
        req.user = verifyAccessToken(token);
      }
    } catch {
      // Allow unauthenticated / guest access
    }
  };

  // Day Overrides CRUD
  app.post("/api/doctor-overrides", staffOrDoctor, setDoctorDayOverride);
  app.get("/api/doctor-overrides", viewOverrides, getDoctorDayOverrides);
  app.delete("/api/doctor-overrides/:id", staffOrDoctor, deleteDoctorDayOverride);

  // Doctor Disruption & Patient Triage Endpoints
  app.get("/api/doctor-overrides/triage", staffOrDoctor, getTriageAppointments);
  app.get("/api/doctor-overrides/eligible-replacements", staffOrDoctor, getEligibleReplacements);
  app.post("/api/doctor-overrides/triage/transfer", staffOrDoctor, triageTransferAppointment);
  app.post("/api/doctor-overrides/triage/cancel", staffOrDoctor, triageCancelAppointment);
  app.post("/api/doctor-overrides/triage/reschedule", staffOrDoctor, triageRescheduleAppointment);
  app.post("/api/doctor-overrides/triage/batch", staffOrDoctor, triageBatchAction);

  // Patient Self-Service Action (Reschedule or Cancel via SMS/WhatsApp links)
  app.post("/api/doctor-overrides/patient-action", { preHandler: [optionalAuth] }, patientDisruptionAction);
}
