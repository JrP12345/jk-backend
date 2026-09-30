type SubscriptionLike = {
  status: string;
  trialStartedAt?: Date | string;
  trialEndsAt?: Date | string;
  currentPeriodStart?: Date | string;
  currentPeriodEnd?: Date | string;
  cancelledAt?: Date | string | null;
  billingCycle?: string;
  entitlementSource?: "trial" | "free" | "paid" | "manual" | null;
  planId?: { name?: string; slug?: string; monthlyPrice?: number; annualPrice?: number } | null;
};

type OrganizationLike = { isActive?: boolean; status?: string; plan?: string };

export function summarizeSubscription(
  organization: OrganizationLike,
  subscription: SubscriptionLike | null,
  hasCapturedPayment: boolean,
  now = new Date(),
  latestPaymentStatus: string | null = null,
) {
  if (!subscription) return {
    planName: organization.plan || "Unknown",
    planSlug: organization.plan || null,
    status: "unavailable", basis: "unknown", startedAt: null, expiresAt: null,
    daysRemaining: null, bookingAvailable: false, nextAction: "review", paymentStatus: latestPaymentStatus,
  };

  const trial = subscription.status === "trialing" || subscription.entitlementSource === "trial" || (subscription.status === "expired" && !hasCapturedPayment &&
    !!subscription.trialEndsAt && !!subscription.currentPeriodEnd &&
    new Date(subscription.trialEndsAt).getTime() === new Date(subscription.currentPeriodEnd).getTime());
  const startedAt = trial ? subscription.trialStartedAt : subscription.currentPeriodStart;
  const expiresAt = trial ? subscription.trialEndsAt : subscription.currentPeriodEnd;
  const endTime = expiresAt ? new Date(expiresAt).getTime() : 0;
  const daysRemaining = endTime ? Math.max(0, Math.ceil((endTime - now.getTime()) / 86400000)) : null;
  const disabled = organization.isActive === false || organization.status === "inactive";
  let status: string;
  if (disabled) status = "disabled";
  else if (subscription.status === "expired" || (endTime > 0 && endTime <= now.getTime())) status = "expired";
  else if (subscription.status === "payment_pending" || subscription.status === "payment_failed") status = subscription.status;
  else if (subscription.status === "cancelled" || subscription.cancelledAt) status = "cancelled";
  else if ((trial || subscription.status === "active") && daysRemaining !== null && daysRemaining <= 7) status = "expiring_soon";
  else status = trial ? "trial" : "active";

  const bookingAvailable = !disabled && endTime > now.getTime() &&
    (subscription.status === "trialing" || subscription.status === "active");
  const isFreePlan = subscription.planId?.monthlyPrice === 0 && subscription.planId?.annualPrice === 0;
  const basis = subscription.entitlementSource || (trial ? "trial" : isFreePlan ? "free" : hasCapturedPayment ? "paid" : "manual");
  const nextAction = disabled ? "review" : status === "payment_failed" ? "resolve_payment" :
    status === "expired" || status === "expiring_soon" ? (trial ? "upgrade" : "renew") :
    status === "cancelled" ? "review" : "none";

  return {
    planName: subscription.planId?.name || organization.plan || "Unknown",
    planSlug: subscription.planId?.slug || organization.plan || null,
    status, basis, startedAt: startedAt || null, expiresAt: expiresAt || null,
    daysRemaining, bookingAvailable, nextAction,
    paymentStatus: latestPaymentStatus,
  };
}
