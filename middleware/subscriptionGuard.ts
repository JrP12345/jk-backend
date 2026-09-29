import type { FastifyRequest, FastifyReply } from "fastify";
import { errorResponse } from "../utilities/helpers.ts";
import { canCreateClinicBooking, canCreateOrganizationBooking } from "../services/billing/SubscriptionAccess.ts";

/**
 * Subscription Status Guard Middleware.
 * Blocks write/mutation operations if organization subscription is expired or payment failed.
 */
export async function enforceSubscriptionActive(req: FastifyRequest, reply: FastifyReply) {
  // Platform maintenance and existing patient care have separate permissions.
  if (req.user?.role === "root" || req.user?.role === "patient" || req.user?.role === "family_member" || req.user?.role === "guest") return;

  const orgId = req.user?.organization_id;
  if (!orgId) return;

  try {
    if (!(await canCreateOrganizationBooking(orgId))) {
      return reply.code(402).send(
        errorResponse(
          "New activity is unavailable for this organization. Review its plan or contact an administrator.",
          { actionRequired: "UPGRADE_SUBSCRIPTION" }
        )
      );
    }
  } catch (err: any) {
    req.log.error(`Subscription check error: ${err.message}`);
    return reply.code(503).send(errorResponse("Service availability could not be verified. Please try again."));
  }
}

/** Booking must use the target clinic, not the caller's possibly unrelated organization. */
export async function enforceNewBookingAllowed(req: FastifyRequest, reply: FastifyReply) {
  const clinicId = (req.body as { clinicId?: string } | undefined)?.clinicId;
  if (!clinicId) return;
  try {
    if (await canCreateClinicBooking(clinicId)) return;
    const consumer = ["patient", "family_member", "guest"].includes(req.user?.role || "");
    return reply.code(consumer ? 409 : 402).send(errorResponse(consumer
      ? "Online booking is temporarily unavailable. Please contact the clinic directly."
      : "New bookings are unavailable for this organization. Review its plan or contact an administrator."));
  } catch (err: any) {
    req.log.error(`Booking access check error: ${err.message}`);
    return reply.code(503).send(errorResponse("Booking availability could not be verified. Please try again."));
  }
}
