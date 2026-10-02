import { describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { Organization } from "../models/Organization.ts";
import { Subscription } from "../models/Subscription.ts";
import { subscriptionService } from "../services/billing/SubscriptionService.ts";

const payload = (name: string) => ({
  org_name: name,
  city: "Mumbai",
  admin_name: "Admin User",
  admin_email: `${name.toLowerCase().replaceAll(" ", "-")}@example.com`,
  admin_password: "Password123!",
  sendWelcomeEmail: false,
});

describe("root organization provisioning", () => {
  it("persists branding and a custom trial while creating the subscription without lazy initialization", async () => {
    const lazyInitializer = vi.spyOn(subscriptionService, "getOrInitializeSubscription")
      .mockRejectedValue(new Error("lazy initializer must not be used while creating an organization"));
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/onboarding/organization",
        payload: {
          ...payload("Custom Trial Clinic"),
          plan: "starter",
          trialDays: 23,
          logo_url: "logos/custom-trial.png",
          image_url: "covers/custom-trial.png",
        },
      });

      expect(response.statusCode).toBe(201);
      expect(lazyInitializer).not.toHaveBeenCalled();
      const orgId = response.json().data.organization.id;
      const [org, subscription] = await Promise.all([
        Organization.findById(orgId),
        Subscription.findOne({ organizationId: orgId }),
      ]);
      expect(org).toMatchObject({ logo_url: "logos/custom-trial.png", image_url: "covers/custom-trial.png" });
      expect(subscription).toMatchObject({ status: "trialing", entitlementSource: "trial" });
      expect(subscription!.trialEndsAt.getTime() - subscription!.trialStartedAt.getTime()).toBe(23 * 24 * 60 * 60 * 1000);
    } finally {
      lazyInitializer.mockRestore();
    }
  });

  it("keeps Enterprise manual by default and starts a trial when days are selected", async () => {
    const defaultResponse = await app.inject({ method: "POST", url: "/api/onboarding/organization", payload: { ...payload("Manual Enterprise Clinic"), plan: "enterprise" } });
    const trialResponse = await app.inject({ method: "POST", url: "/api/onboarding/organization", payload: { ...payload("Trial Enterprise Clinic"), plan: "enterprise", trialDays: 7 } });

    expect(defaultResponse.statusCode).toBe(201);
    expect(trialResponse.statusCode).toBe(201);
    const [manual, trial] = await Promise.all([
      Subscription.findOne({ organizationId: defaultResponse.json().data.organization.id }),
      Subscription.findOne({ organizationId: trialResponse.json().data.organization.id }),
    ]);
    expect(manual).toMatchObject({ status: "active", entitlementSource: "manual" });
    expect(trial).toMatchObject({ status: "trialing", entitlementSource: "trial" });
    expect(trial!.trialEndsAt.getTime() - trial!.trialStartedAt.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it.each([0, 366, 1.5])("rejects invalid custom trial duration %s", async (trialDays) => {
    const response = await app.inject({ method: "POST", url: "/api/onboarding/organization", payload: { ...payload(`Invalid ${trialDays}`), trialDays } });
    expect(response.statusCode).toBe(400);
    expect(await Organization.countDocuments({ name: `Invalid ${trialDays}` })).toBe(0);
  });

  it("does not leave an organization behind when the administrator email is already registered", async () => {
    const reusedEmail = payload("Custom Trial Clinic").admin_email;
    const duplicate = await app.inject({
      method: "POST", url: "/api/onboarding/organization",
      payload: { ...payload("Duplicate Admin Clinic"), admin_email: reusedEmail },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(await Organization.countDocuments({ name: "Duplicate Admin Clinic" })).toBe(0);
  });
});
