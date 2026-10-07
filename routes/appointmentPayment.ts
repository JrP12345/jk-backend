import type { FastifyInstance } from "fastify";
import { authenticate, checkAnyPermissionOrRoles, checkAnyPermission } from "../middleware/auth.ts";
import { requireModule } from "../middleware/moduleGuard.ts";
import {
  createAppointmentPaymentOrder,
  verifyAppointmentPayment,
  selectPayAtLocation,
  collectCounterPayment,
  reconcileAppointmentPayment,
  reconcileRefund,
} from "../controllers/appointmentPayment.ts";

export default async function appointmentPaymentRoutes(app: FastifyInstance) {
  const paymentAccess = {
    config: { allowGuest: true },
    preHandler: [
      authenticate,
      requireModule("appointments"),
      checkAnyPermissionOrRoles(
        ["patient", "family_member", "guest"],
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
  app.post("/api/appointment-payments/pay-at-location", paymentAccess, selectPayAtLocation);
  app.post("/api/appointment-payments/collect-counter", counterPaymentAccess, collectCounterPayment);
  app.post("/api/appointment-payments/reconcile", counterPaymentAccess, reconcileAppointmentPayment);
  app.post("/api/appointment-payments/reconcile-refund", {
    preHandler: [authenticate, requireModule("billing"), checkAnyPermission("MANAGE_BILLING")],
  }, reconcileRefund);
}
