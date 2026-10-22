import bcrypt from "bcryptjs";
import type { ClientSession } from "mongoose";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Location } from "../models/Location.ts";
import { SaaSPlan } from "../models/SaaSPlan.ts";
import { COUNTRY_SETTINGS, type CountryCode } from "../utilities/countrySettings.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import { seedModulesForOrg } from "./OrganizationModuleDefaults.ts";
import { seedDefaultRoles } from "./OrganizationRoleDefaults.ts";
import { subscriptionService } from "./billing/SubscriptionService.ts";
import { attachBranding } from "./OrganizationBranding.ts";
import { WorkspaceError } from "./WorkspaceService.ts";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";
import { enqueueTransactionalEmail } from "./CommunicationOutbox.ts";
import { getFrontendBaseUrl } from "../utilities/config.ts";

export interface OrganizationProvisionInput {
  org_name: string; city: string; admin_name: string; admin_email: string; admin_password: string; plan?: string;
  address?: string; org_phone?: string; org_email?: string; description?: string; image_url?: string; logo_url?: string; timings?: string; working_days?: string; trialDays?: number; admin_phone?: string;
  location_name?: string; location_city?: string; location_address?: string; location_phone?: string; location_email?: string; facilityType?: string;
  taxId?: string; licenseNumber?: string; countryCode?: CountryCode; currency?: string; timezone?: string; sendWelcomeEmail?: boolean;
}
export interface OrganizationProvisionOptions { verifiedOwnerUserId?: string; workspaceProfile?: "clinic" | "pharmacy"; staffMfaRequired?: boolean;
  initializeSubscription?: (context: { organizationId: string; locationId: string; ownerUserId: string }, session: ClientSession | null) => Promise<void> }
export async function provisionOrganization(input: OrganizationProvisionInput, options: OrganizationProvisionOptions = {}) {
  const { org_name, city, address, org_phone, org_email, description, image_url, logo_url, timings, working_days, trialDays, admin_name, admin_email, admin_password, admin_phone, location_name, location_city, location_address, location_phone, location_email, facilityType, taxId, licenseNumber, countryCode, currency, timezone, sendWelcomeEmail } = input;
  return withTransaction(async session => {
      // Plans and quotas are commercial entitlements. Only a platform root can
      // select a plan, and no caller can set quotas directly through onboarding.
      const selectedPlan = input.plan || "starter";
      const configuredPlan = await SaaSPlan.findOne({ slug: selectedPlan, status: "active" }).lean();
      const fallbackLimits = selectedPlan === "enterprise"
        ? { maxLocations: 99, maxDoctors: 999, maxStaff: 999 }
        : selectedPlan === "professional"
          ? { maxLocations: 5, maxDoctors: 15, maxStaff: 25 }
          : { maxLocations: 1, maxDoctors: 2, maxStaff: 5 };
      const planLimits = {
        maxLocations: configuredPlan?.limits?.maxLocations ?? fallbackLimits.maxLocations,
        maxDoctors: configuredPlan?.limits?.maxDoctors ?? fallbackLimits.maxDoctors,
        maxStaff: configuredPlan?.limits?.maxStaff ?? fallbackLimits.maxStaff,
      };

      // Validate the administrator before writing any organization records.
      let emailQuery = User.findOne({ email: admin_email.trim().toLowerCase() });
      if (session) emailQuery = emailQuery.session(session);
      const existingOwner = await emailQuery;
      if (!options.verifiedOwnerUserId && existingOwner) {
        throw new WorkspaceError(409, "Administrator email is already registered; provide a unique administrator email for this organization");
      }
      if (options.verifiedOwnerUserId && (!existingOwner || existingOwner.id !== options.verifiedOwnerUserId || !existingOwner.isActive || !existingOwner.isEmailVerified || existingOwner.role === "root")) throw new WorkspaceError(403, "A current verified business owner is required");
      const hashedAdminPassword = options.verifiedOwnerUserId ? undefined : await bcrypt.hash(admin_password, 10);
      const workspaceProfile = options.workspaceProfile || (facilityType === "pharmacy" ? "pharmacy" : "clinic");

      const org = await createWithSession(Organization, {
        name: org_name,
        workspaceProfile,
        staffMfaRequired: options.staffMfaRequired === true,
        city,
        address: address || null,
        phone: org_phone || null,
        email: org_email || null,
        description: description || null,
        image_url: image_url || null,
        logo_url: logo_url || null,
        timings: timings || null,
        working_days: working_days || null,
        plan: selectedPlan,
        ...planLimits,
        taxId: taxId?.trim() || undefined,
        licenseNumber: licenseNumber?.trim() || undefined,
        countryCode,
        currency: countryCode ? COUNTRY_SETTINGS[countryCode].currency : (currency || "INR"),
        timezone: timezone || (countryCode ? COUNTRY_SETTINGS[countryCode].defaultTimezone : null) || "Asia/Kolkata",
        onboardingStatus: workspaceProfile === "pharmacy" ? "COMPLETED" : "LOCATION_CREATED",
        isOnboarded: workspaceProfile === "pharmacy",
      }, session);

      let adminUser = options.verifiedOwnerUserId ? existingOwner : await createWithSession(User, {
        name: admin_name,
        email: admin_email.trim().toLowerCase(),
        password: hashedAdminPassword,
        phone: admin_phone || null,
        role: "admin",
      }, session);
      if (options.verifiedOwnerUserId && adminUser.role === "pharmacy_applicant") {
        adminUser.role = "admin"; adminUser.authVersion = (adminUser.authVersion || 1) + 1; await adminUser.save({ session });
      }

      if (!adminUser) throw new Error("Failed to initialize administrator user");

      await createWithSession(OrgMember, {
        userId: adminUser._id,
        organizationId: org._id,
        role: "admin",
      }, session);

      // Automatically create the primary physical Location.
      const primaryLocation = await createWithSession(Location, {
        organizationId: org._id,
        name: location_name?.trim() || org_name.trim(),
        facilityType: facilityType || null,
        ...(facilityType === "pharmacy" ? { pharmacyCapability: { enabled: false, revision: 0 } } : {}),
        city: location_city?.trim() || city,
        address: location_address || address || null,
        phone: location_phone || org_phone || admin_phone || null,
        email: location_email || org_email || admin_email || null,
        timings: timings || null,
      }, session);

      // Seed default module toggles for the new organization (P1 = enabled, P2/P3 = disabled)
      await seedModulesForOrg(org._id.toString(), adminUser?._id?.toString(), session, workspaceProfile);

      // Upsert all system role documents so that permission checks work for every role type.
      await seedDefaultRoles(session);

      const orgIdStr = org._id.toString();
      await attachBranding(org, session);

      // Provision the subscription in the same transaction as the organization.
      // The lazy initializer cannot see an organization that has not committed yet.
      if (options.initializeSubscription) await options.initializeSubscription({ organizationId: orgIdStr, locationId: String(primaryLocation._id), ownerUserId: String(adminUser._id) }, session);
      else await subscriptionService.createInitialSubscription(orgIdStr, selectedPlan, trialDays, session);

      await eventBus.publishDurable({
        eventType: EVENT_TYPES.ORG_CREATED,
        category: "organization",
        targetUserId: adminUser._id.toString(),
        title: "Organization Created",
        message: `Welcome to Ekavyu! Organization workspace (${org_name}) is now active.`,
        severity: "success",
        organizationId: orgIdStr,
        actionUrl: "/dashboard",
      });

      if (sendWelcomeEmail !== false && admin_email && admin_password) {
        const portalUrl = `${getFrontendBaseUrl()}/login`;
        await enqueueTransactionalEmail({
          to: admin_email.trim().toLowerCase(),
          subject: `Welcome to Ekavyu - ${org_name} Workspace Provisioned`,
          text: `Hello ${admin_name},\n\nYour organization workspace (${org_name}) has been provisioned on Ekavyu Healthcare OS.\n\nLogin Portal: ${portalUrl}\nEmail: ${admin_email}\n\nUse the password you chose during provisioning to sign in. Please sign in to configure your clinical staff and operational settings.`,
          html: `<p>Hello <strong>${admin_name}</strong>,</p><p>Your organization workspace (<strong>${org_name}</strong>) has been provisioned on Ekavyu Healthcare OS.</p><ul><li><strong>Login Portal:</strong> <a href="${portalUrl}">${portalUrl}</a></li><li><strong>Email:</strong> ${admin_email}</li></ul><p>Use the password you chose during provisioning to sign in. Please sign in to configure your clinical staff and operational settings.</p>`,
          idempotencyKey: `transactional-email:organization-welcome:${org._id}`,
          session,
        });
      }

      return {
        organization: { id: orgIdStr, name: org_name, city },
        user: { id: adminUser._id.toString(), name: adminUser.name, email: adminUser.email, role: adminUser.role, organization_id: orgIdStr },
      };
  });
}
