import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { SaaSPlan } from "../models/SaaSPlan.ts";
import { Subscription } from "../models/Subscription.ts";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { Doctor } from "../models/Doctor.ts";
import { SaaSConfig } from "../models/SaaSConfig.ts";
import { subscriptionService, PlanDowngradeViolationError } from "../services/billing/SubscriptionService.ts";

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  if (mongoose.connection.readyState === 0) {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    await mongoose.connect(uri);
  }

  await SaaSConfig.create({
    key: "platform_config",
    razorpayKeyId: "rzp_test_downgrade_mock",
    razorpayKeySecret: "mock_secret_key_downgrade",
    razorpayWebhookSecret: "mock_webhook_secret",
    isLiveMode: false,
  });
});

afterAll(async () => {
  if (mongoServer) {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    await mongoServer.stop();
  }
});

describe("Subscription Plan Downgrade & Active Resource Quota Enforcement", () => {
  it("should validate and block downgrade when active clinics exceed target plan limit", async () => {
    // 1. Create Organization
    const org = await Organization.create({
      name: "Metro Healthcare Group",
      city: "Bengaluru",
      plan: "pro",
    });
    const orgId = org._id.toString();

    // 2. Create Pro Plan (allows 5 clinics)
    const proPlan = await SaaSPlan.create({
      name: "Professional Plan",
      slug: "pro_plan_5",
      description: "For expanding multi-specialty multi-branch practices",
      monthlyPrice: 4999,
      annualPrice: 49990,
      limits: {
        maxClinics: 5,
        maxDoctors: 10,
        maxStaff: 20,
      },
    });

    // 3. Create Starter Plan (allows 1 clinic)
    const starterPlan = await SaaSPlan.create({
      name: "Starter Single Clinic",
      slug: "starter_1",
      description: "For solo clinics",
      monthlyPrice: 999,
      annualPrice: 9990,
      limits: {
        maxClinics: 1,
        maxDoctors: 2,
        maxStaff: 5,
      },
    });

    // 4. Create active subscription on Pro
    await Subscription.create({
      organizationId: org._id,
      planId: proPlan._id,
      status: "active",
      billingCycle: "monthly",
      trialStartedAt: new Date(),
      trialEndsAt: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    // 5. Add 4 active clinics to this organization
    const clinic1 = await Clinic.create({ organizationId: org._id, name: "Indiranagar Branch", city: "Bengaluru", isActive: true });
    const clinic2 = await Clinic.create({ organizationId: org._id, name: "Koramangala Branch", city: "Bengaluru", isActive: true });
    const clinic3 = await Clinic.create({ organizationId: org._id, name: "Whitefield Branch", city: "Bengaluru", isActive: true });
    const clinic4 = await Clinic.create({ organizationId: org._id, name: "Jayanagar Branch", city: "Bengaluru", isActive: true });

    // 6. Pre-flight check downgrade to Starter (limit: 1)
    const check = await subscriptionService.validatePlanDowngrade(orgId, starterPlan._id.toString());
    expect(check.canDowngrade).toBe(false);
    expect(check.violations).toHaveLength(1);
    expect(check.violations[0].resource).toBe("clinics");
    expect(check.violations[0].current).toBe(4);
    expect(check.violations[0].allowed).toBe(1);
    expect(check.violations[0].excess).toBe(3);
    expect(check.activeClinics).toHaveLength(4);

    // 7. Attempting to create checkout order must throw PlanDowngradeViolationError
    await expect(
      subscriptionService.createCheckoutOrder(orgId, starterPlan._id.toString(), "monthly")
    ).rejects.toThrowError(PlanDowngradeViolationError);

    // 8. Soft-deactivate 3 branches (archive them without deleting historical data)
    await Clinic.updateOne({ _id: clinic2._id }, { isActive: false });
    await Clinic.updateOne({ _id: clinic3._id }, { isActive: false });
    await Clinic.updateOne({ _id: clinic4._id }, { isActive: false });

    // 9. Re-check feasibility now that active clinics = 1
    const recheck = await subscriptionService.validatePlanDowngrade(orgId, starterPlan._id.toString());
    expect(recheck.canDowngrade).toBe(true);
    expect(recheck.violations).toHaveLength(0);
    expect(recheck.currentUsage.clinics).toBe(1);
    expect(recheck.activeClinics).toHaveLength(1);
    expect(recheck.activeClinics[0].id).toBe(clinic1._id.toString());

    // 10. Checkout order or direct switch now succeeds cleanly
    const switched = await subscriptionService.directSwitchPlan(orgId, starterPlan._id.toString(), "monthly");
    expect(switched.planSlug).toBe("starter_1");

    // Verify Org metadata updated
    const updatedOrg = await Organization.findById(org._id);
    expect(updatedOrg?.maxClinics).toBe(1);
    expect(updatedOrg?.plan).toBe("starter_1");

    // Helper to mock Fastify reply
    function createMockReply() {
      let statusCode = 200;
      let sentData: any = null;
      const reply: any = {
        code: (c: number) => {
          statusCode = c;
          return reply;
        },
        send: (d: any) => {
          sentData = d;
          return reply;
        },
        getStatus: () => statusCode,
        getData: () => sentData,
      };
      return reply;
    }

    // 11. Test getClinics with status filtering
    const { getClinics, reactivateClinic } = await import("../controllers/clinic.ts");

    // Default getClinics returns only active clinics
    const replyDefault = createMockReply();
    await getClinics({ user: { organization_id: orgId, role: "admin" }, query: {} } as any, replyDefault as any);
    expect(replyDefault.getStatus()).toBe(200);
    expect(replyDefault.getData().data).toHaveLength(1);
    expect(replyDefault.getData().data[0].name).toBe("Indiranagar Branch");

    // getClinics with status="inactive" returns 3 inactive clinics
    const replyInactive = createMockReply();
    await getClinics({ user: { organization_id: orgId, role: "admin" }, query: { status: "inactive" } } as any, replyInactive as any);
    expect(replyInactive.getStatus()).toBe(200);
    expect(replyInactive.getData().data).toHaveLength(3);

    // getClinics with includeInactive="true" returns all 4 clinics
    const replyAll = createMockReply();
    await getClinics({ user: { organization_id: orgId, role: "admin" }, query: { includeInactive: "true" } } as any, replyAll as any);
    expect(replyAll.getStatus()).toBe(200);
    expect(replyAll.getData().data).toHaveLength(4);

    // 12. Test reactivateClinic when org is at quota limit (1 of 1)
    const replyBlocked = createMockReply();
    await reactivateClinic({
      user: { organization_id: orgId, role: "admin" },
      params: { id: clinic2._id.toString() }
    } as any, replyBlocked as any);
    expect(replyBlocked.getStatus()).toBe(403);
    expect(replyBlocked.getData().success).toBe(false);
    expect(replyBlocked.getData().message).toContain("quota limit of 1 reached");

    // Verify clinic2 is still inactive in database
    const checkClinic2 = await Clinic.findById(clinic2._id);
    expect(checkClinic2?.isActive).toBe(false);

    // 13. Increase quota (e.g. upgraded back to Pro) and verify reactivateClinic succeeds
    await Organization.updateOne({ _id: orgId }, { maxClinics: 5, plan: "pro" });
    const replyReactivated = createMockReply();
    await reactivateClinic({
      user: { organization_id: orgId, role: "admin" },
      params: { id: clinic2._id.toString() }
    } as any, replyReactivated as any);
    expect(replyReactivated.getStatus()).toBe(200);
    expect(replyReactivated.getData().success).toBe(true);

    // Verify clinic2 is now active in database
    const activeClinic2 = await Clinic.findById(clinic2._id);
    expect(activeClinic2?.isActive).toBe(true);
  });
});

