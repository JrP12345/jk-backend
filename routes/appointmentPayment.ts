import type { FastifyInstance } from "fastify";
import { authenticate, checkAnyPermissionOrRoles, checkAnyPermission } from "../middleware/auth.ts";
import { requireModule } from "../middleware/moduleGuard.ts";
import {
  createAppointmentPaymentOrder,
  verifyAppointmentPayment,
  selectPayAtClinic,
  collectCounterPayment,
} from "../controllers/appointmentPayment.ts";

export default async function appointmentPaymentRoutes(app: FastifyInstance) {
  const paymentAccess = {
    preHandler: [
      authenticate,
      requireModule("appointments"),
      checkAnyPermissionOrRoles(
        ["patient", "family_member", "admin", "staff", "receptionist", "doctor", "guest"],
        "MANAGE_BILLING",
        "MANAGE_APPOINTMENTS",
        "VIEW_APPOINTMENTS",
        "MANAGE_QUEUE"
      ),
    ],
  };
  const counterPaymentAccess = {
    preHandler: [
      authenticate,
      requireModule("appointments"),
      checkAnyPermission("MANAGE_BILLING", "MANAGE_APPOINTMENTS"),
    ],
  };

  app.post("/api/appointment-payments/create-order", paymentAccess, createAppointmentPaymentOrder);
  app.post("/api/appointment-payments/verify", paymentAccess, verifyAppointmentPayment);
  app.post("/api/appointment-payments/pay-at-clinic", paymentAccess, selectPayAtClinic);
  app.post("/api/appointment-payments/collect-counter", counterPaymentAccess, collectCounterPayment);
}
