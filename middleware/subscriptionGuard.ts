import type { FastifyRequest, FastifyReply } from "fastify";
import { subscriptionService } from "../services/billing/SubscriptionService.ts";
import { errorResponse } from "../utilities/helpers.ts";

/**
 * Subscription Status Guard Middleware.
 * Blocks write/mutation operations if organization subscription is expired or payment failed.
 */
export async function enforceSubscriptionActive(req: FastifyRequest, reply: FastifyReply) {
  // Super-admin root and consumer patients bypass subscription check
  if (req.user?.role === "root" || req.user?.role === "patient" || req.user?.role === "family_member" || req.user?.role === "guest") return;

  const orgId = req.user?.organization_id;
  if (!orgId) return;

  try {
    const sub = await subscriptionService.getOrInitializeSubscription(orgId);
    if (sub.status === "expired" || sub.status === "payment_failed") {
      return reply.code(402).send(
        errorResponse(
          `Subscription ${sub.status.toUpperCase()}. Upgrade or renew your subscription to perform this action.`,
          { subscriptionStatus: sub.status, actionRequired: "UPGRADE_SUBSCRIPTION" }
        )
      );
    }
  } catch (err: any) {
    req.log.error(`Subscription check error: ${err.message}`);
  }
}
