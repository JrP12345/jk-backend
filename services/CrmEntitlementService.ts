import { Organization } from '../models/Organization.ts';
import { Subscription } from '../models/Subscription.ts';

// Workers read persisted entitlement only; they never create a subscription.
export async function crmEntitlementActive(organizationId: string, now = new Date()) {
  const [org, subscription] = await Promise.all([
    Organization.findOne({ _id: organizationId, isActive: true, status: 'active' }).select('_id').lean(),
    Subscription.findOne({ organizationId }).sort({ createdAt: 1, _id: 1 }).select('status trialEndsAt currentPeriodEnd').lean(),
  ]);
  return !!org && !!subscription && ((subscription.status === 'active' && subscription.currentPeriodEnd > now) || (subscription.status === 'trialing' && subscription.trialEndsAt > now));
}
