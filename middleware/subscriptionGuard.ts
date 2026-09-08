import type { FastifyRequest, FastifyReply } from "fastify";
import { subscriptionService } from "../services/billing/SubscriptionService.ts";
import { errorResponse } from "../utilities/helpers.ts";

/**
 * Subscription Status Guard Middleware.
 * Blocks write/mutation operations if organization subscription is expired or payment failed.
 */
export async function enforceSubscriptionActive(req: FastifyRequest, reply: FastifyReply) {
  // Super-admin root and consumer patients bypass subscription check
  if (req.user?.role === "root" || req.user?.role === "patient" || req.user?.role === "family_member") return;

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

/**
 * Factory: Enforce Plan Quota Limits on Resource Creation.
 * Usage: { preHandler: [authenticate, enforceResourceQuota("doctors")] }
 */
export function enforceResourceQuota(resourceType: "clinics" | "doctors" | "staff" | "patients" | "appointments") {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.user?.role === "root") return;

    const orgId = req.user?.organization_id;
    if (!orgId) return;

    const usageInfo = await subscriptionService.getOrganizationUsage(orgId);
    const { usage, limits, planName, subscriptionStatus } = usageInfo;

    if (subscriptionStatus === "expired" || subscriptionStatus === "payment_failed") {
      return reply.code(402).send(
        errorResponse(`Subscription ${subscriptionStatus.toUpperCase()}. Renewal required.`, {
          actionRequired: "UPGRADE_SUBSCRIPTION",
        })
      );
    }

    let currentCount = 0;
    let maxAllowed = 999999;

    switch (resourceType) {
      case "clinics":
        currentCount = usage.clinicsCount;
        maxAllowed = limits.maxClinics ?? 1;
        break;
      case "doctors":
        currentCount = usage.doctorsCount;
        maxAllowed = limits.maxDoctors ?? 2;
        break;
      case "staff":
        currentCount = usage.staffCount;
        maxAllowed = limits.maxStaff ?? 3;
        break;
      case "patients":
        currentCount = usage.patientsCount;
        maxAllowed = limits.maxPatients ?? 500;
        break;
      case "appointments":
        currentCount = usage.appointmentsCount;
        maxAllowed = limits.maxAppointments ?? 1000;
        break;
    }

    if (currentCount >= maxAllowed) {
      return reply.code(403).send(
        errorResponse(
          `Quota limit reached for ${resourceType.toUpperCase()} (${currentCount}/${maxAllowed}) on your ${planName} plan. Upgrade plan to add more.`,
          {
            resourceType,
            currentCount,
            maxAllowed,
            planName,
            actionRequired: "UPGRADE_SUBSCRIPTION",
          }
        )
      );
    }
  };
}

/**
 * Factory: Enforce Feature Access Gate (e.g. Analytics, Audit Logs, AI).
 * Usage: { preHandler: [authenticate, enforceFeatureAccess("analytics")] }
 */
export function enforceFeatureAccess(featureName: "analytics" | "auditLogs" | "multiBranch" | "dataExport" | "apiAccess" | "aiFeatures") {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.user?.role === "root") return;

    const orgId = req.user?.organization_id;
    if (!orgId) return;

    const usageInfo = await subscriptionService.getOrganizationUsage(orgId);
    const { features, planName } = usageInfo;

    if (!features || !features[featureName]) {
      return reply.code(403).send(
        errorResponse(
          `Feature '${featureName}' is not included in your current ${planName} plan. Upgrade to access this feature.`,
          { featureName, planName, actionRequired: "UPGRADE_SUBSCRIPTION" }
        )
      );
    }
  };
}
