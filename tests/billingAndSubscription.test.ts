import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { SaaSPlan } from "../models/SaaSPlan.ts";
import { Subscription } from "../models/Subscription.ts";
import { SubscriptionPayment } from "../models/SubscriptionPayment.ts";
import { SaaSInvoice } from "../models/SaaSInvoice.ts";
import { Organization } from "../models/Organization.ts";
import { subscriptionService } from "../services/billing/SubscriptionService.ts";
import { razorpayService } from "../services/billing/RazorpayService.ts";

import { SaaSConfig } from "../models/SaaSConfig.ts";

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  if (mongoose.connection.readyState === 0) {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    await mongoose.connect(uri);
  }

  await SaaSConfig.create({
    key: "platform_config",
    razorpayKeyId: "rzp_test_mock_key_12345",
    razorpayKeySecret: "mock_secret_key_12345",
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

describe("Commercial SaaS Billing & Subscription Engine", () => {
  it("should initialize default 15-day trial subscription for a new organization", async () => {
    const org = await Organization.create({
      name: "Test Hospital",
      city: "Mumbai",
      plan: "starter",
    });

    const sub = await subscriptionService.getOrInitializeSubscription(org._id.toString());

    expect(sub).toBeDefined();
    expect(sub.status).toBe("trialing");
    expect(sub.planId).toBeDefined();
    expect(sub.trialEndsAt).toBeDefined();

    const plan = sub.planId as any;
    expect(plan.slug).toBe("starter");
  });

  it("should create Razorpay checkout order for plan upgrade", async () => {
    const org = await Organization.create({
      name: "City Clinic",
      city: "Delhi",
    });

    const plan = await SaaSPlan.create({
      name: "Professional",
      slug: "pro_test",
      description: "Pro plan test",
      monthlyPrice: 4999,
      annualPrice: 49990,
      limits: { maxClinics: 5, maxDoctors: 15, maxStaff: 25 },
    });

    const checkout = await subscriptionService.createCheckoutOrder(
      org._id.toString(),
      plan._id.toString(),
      "monthly"
    );

    expect(checkout).toBeDefined();
    expect(checkout.orderId).toBeDefined();
    expect(checkout.amount).toBe(5899); // 4999 + 18% GST (899.82 round 900)
    expect(checkout.currency).toBe("INR");
  });

  it("should verify payment signature and activate subscription with SaaS invoice generation", async () => {
    const org = await Organization.create({
      name: "Metro Medical",
      city: "Bangalore",
    });

    const plan = await SaaSPlan.create({
      name: "Enterprise",
      slug: "ent_test",
      description: "Enterprise plan test",
      monthlyPrice: 14999,
      annualPrice: 149990,
      limits: { maxClinics: 99, maxDoctors: 999, maxStaff: 999 },
    });

    const checkout = await subscriptionService.createCheckoutOrder(
      org._id.toString(),
      plan._id.toString(),
      "monthly"
    );

    const result = await subscriptionService.verifyAndActivateSubscription(
      org._id.toString(),
      checkout.orderId,
      `pay_${Math.random().toString(36).substr(2, 9)}`,
      "simulated_valid_signature"
    );

    expect(result.success).toBe(true);
    expect(result.subscription.status).toBe("active");
    expect(result.invoice).toBeDefined();
    expect(result.invoice.invoiceNumber).toContain("SAAS-");

    // Check organization limits updated
    const updatedOrg = await Organization.findById(org._id);
    expect(updatedOrg?.plan).toBe("ent_test");
    expect(updatedOrg?.maxClinics).toBe(99);
  });

  it("should compute real-time organization usage metrics correctly", async () => {
    const org = await Organization.create({
      name: "Usage Test Clinic",
      city: "Chennai",
    });

    const usageInfo = await subscriptionService.getOrganizationUsage(org._id.toString());

    expect(usageInfo).toBeDefined();
    expect(usageInfo.usage).toBeDefined();
    expect(usageInfo.limits).toBeDefined();
    expect(usageInfo.subscriptionStatus).toBe("trialing");
  });
});
