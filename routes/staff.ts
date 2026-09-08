import type { FastifyInstance } from "fastify";
import { authenticate, checkPermission } from "../middleware/auth.ts";
import { requireModule } from "../middleware/moduleGuard.ts";
import { enforceSubscriptionActive } from "../middleware/subscriptionGuard.ts";
import { addDoctorSchema, addReceptionistSchema } from "../schemas/onboarding.ts";
import {
  addDoctor,
  addReceptionist,
  addStaff,
  getOrgStaff,
  updateDoctor,
  updateReceptionist,
  updateStaff,
  enableAdminDoctorProfile,
  deleteStaff,
  inviteStaff,
  acceptInvitation,
} from "../controllers/onboarding.ts";

export default async function staffRoutes(app: FastifyInstance) {
  const manageStaff = { preHandler: [authenticate, requireModule("staff"), checkPermission("MANAGE_STAFF"), enforceSubscriptionActive] };
  const viewStaff = { preHandler: [authenticate, requireModule("staff"), checkPermission("VIEW_STAFF")] };

  app.post("/api/onboarding/doctor", { ...manageStaff, schema: addDoctorSchema }, addDoctor);
  app.post("/api/onboarding/receptionist", { ...manageStaff, schema: addReceptionistSchema }, addReceptionist);
  app.post("/api/onboarding/staff", manageStaff, addStaff);
  app.post("/api/onboarding/admin/enable-doctor-profile", manageStaff, enableAdminDoctorProfile);
  app.post("/api/onboarding/invitations", manageStaff, inviteStaff);
  app.post("/api/auth/accept-invitation", acceptInvitation);
  app.get("/api/onboarding/staff", viewStaff, getOrgStaff);
  app.put("/api/onboarding/doctor/:id", manageStaff, updateDoctor);
  app.put("/api/onboarding/receptionist/:id", manageStaff, updateReceptionist);
  app.put("/api/onboarding/staff/:id", manageStaff, updateStaff);
  app.delete("/api/onboarding/staff/:id", manageStaff, deleteStaff);
}
