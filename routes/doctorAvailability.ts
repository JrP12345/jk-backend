import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { authenticate, checkAnyPermission, checkAnyPermissionOrRoles, denyRoles } from "../middleware/auth.ts";
import { requireModule } from "../middleware/moduleGuard.ts";
import { enforceSubscriptionActive } from "../middleware/subscriptionGuard.ts";
import { getTrackerCapability } from "../utilities/publicTracker.ts";
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
      denyRoles("patient", "family_member", "guest"),
      checkAnyPermission(
        "MANAGE_APPOINTMENTS",
        "MANAGE_QUEUE",
      ),
      enforceSubscriptionActive,
    ],
  };

  const viewOverrides = {
    preHandler: [
      authenticate,
      requireModule("appointments"),
      checkAnyPermissionOrRoles(
        ["patient", "family_member"],
        "VIEW_APPOINTMENTS",
        "MANAGE_APPOINTMENTS"
      ),
    ],
  };
  const viewTriage = { preHandler: [authenticate, requireModule("appointments"),
    denyRoles("patient", "family_member", "guest"),
    checkAnyPermission("VIEW_APPOINTMENTS", "MANAGE_APPOINTMENTS", "MANAGE_QUEUE"), enforceSubscriptionActive] };

  const optionalAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    // Public tracker proof is independent of cookies. Otherwise resolve the
    // complete authenticated session, including revocation, before owner access.
    if (getTrackerCapability(req)) return;
    return authenticate(req, reply);
  };

  // Day Overrides CRUD
  app.post("/api/doctor-overrides", staffOrDoctor, setDoctorDayOverride);
  app.get("/api/doctor-overrides", viewOverrides, getDoctorDayOverrides);
  app.delete("/api/doctor-overrides/:id", staffOrDoctor, deleteDoctorDayOverride);

  // Doctor Disruption & Patient Triage Endpoints
  app.get("/api/doctor-overrides/triage", viewTriage, getTriageAppointments);
  app.get("/api/doctor-overrides/eligible-replacements", viewTriage, getEligibleReplacements);
  app.post("/api/doctor-overrides/triage/transfer", staffOrDoctor, triageTransferAppointment);
  app.post("/api/doctor-overrides/triage/cancel", staffOrDoctor, triageCancelAppointment);
  app.post("/api/doctor-overrides/triage/reschedule", staffOrDoctor, triageRescheduleAppointment);
  app.post("/api/doctor-overrides/triage/batch", staffOrDoctor, triageBatchAction);

  // Patient Self-Service Action (Reschedule or Cancel via SMS/WhatsApp links)
  app.post("/api/doctor-overrides/patient-action", { preHandler: [optionalAuth] }, patientDisruptionAction);
}
