import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { SaaSPlan } from "../models/SaaSPlan.ts";
import { Subscription } from "../models/Subscription.ts";
import { SubscriptionPayment } from "../models/SubscriptionPayment.ts";
import { SaaSInvoice } from "../models/SaaSInvoice.ts";
import { Organization } from "../models/Organization.ts";
import { subscriptionService, addBillingPeriod } from "../services/billing/SubscriptionService.ts";
import { canCreateOrganizationBooking } from "../services/billing/SubscriptionAccess.ts";
import { razorpayService } from "../services/billing/RazorpayService.ts";
import { summarizeSubscription } from "../services/billing/subscriptionSummary.ts";

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
  it("summarizes trial, expiry, suspension and paid entitlement from actual dates", () => {
    const now = new Date("2026-09-30T12:00:00Z");
    const sub = {
      status: "trialing", trialStartedAt: "2026-09-20T12:00:00Z", trialEndsAt: "2026-10-02T12:00:00Z",
      currentPeriodStart: "2026-09-20T12:00:00Z", currentPeriodEnd: "2026-10-02T12:00:00Z",
      planId: { name: "Starter", slug: "starter" },
    };
    expect(summarizeSubscription({ status: "active" }, sub, false, now)).toMatchObject({ status: "expiring_soon", basis: "trial", daysRemaining: 2, bookingAvailable: true });
    expect(summarizeSubscription({ status: "inactive" }, sub, false, now)).toMatchObject({ status: "disabled", bookingAvailable: false });
    expect(summarizeSubscription({ status: "active" }, { ...sub, trialEndsAt: "2026-09-29T12:00:00Z" }, false, now)).toMatchObject({ status: "expired", bookingAvailable: false });
    expect(summarizeSubscription({ status: "active" }, { ...sub, status: "active" }, true, now)).toMatchObject({ status: "expiring_soon", basis: "paid" });
  });
  it("uses dates and organization state for trial, paid, overdue and suspended booking access", async () => {
    const org = await Organization.create({ name: "Lifecycle Clinic", city: "Surat", plan: "starter" });
    const id = org._id.toString();
    const subscription = await subscriptionService.getOrInitializeSubscription(id);
    expect(await canCreateOrganizationBooking(id)).toBe(true);
    await Subscription.findByIdAndUpdate(subscription._id, { status: "trialing", trialEndsAt: new Date(Date.now() - 1000) });
    expect(await canCreateOrganizationBooking(id)).toBe(false);
    await Subscription.findByIdAndUpdate(subscription._id, { status: "active", currentPeriodEnd: new Date(Date.now() + 86400000) });
    expect(await canCreateOrganizationBooking(id)).toBe(true);
    await Subscription.findByIdAndUpdate(subscription._id, { currentPeriodEnd: new Date(Date.now() - 1000) });
    expect(await canCreateOrganizationBooking(id)).toBe(false);
    await Subscription.findByIdAndUpdate(subscription._id, { status: "payment_failed", currentPeriodEnd: new Date(Date.now() + 86400000) });
    expect(await canCreateOrganizationBooking(id)).toBe(false);
    await Subscription.findByIdAndUpdate(subscription._id, { status: "active" });
    await Organization.findByIdAndUpdate(id, { status: "inactive" });
    expect(await canCreateOrganizationBooking(id)).toBe(false);
  });
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

  it("initializes one subscription when first requests arrive together", async () => {
    const org = await Organization.create({ name: "Concurrent First Billing", city: "Pune" });
    const initialized = await Promise.all([
      subscriptionService.getOrInitializeSubscription(org.id),
      subscriptionService.getOrInitializeSubscription(org.id),
    ]);
    expect(initialized[0].id).toBe(initialized[1].id);
    expect(await Subscription.countDocuments({ organizationId: org._id })).toBe(1);
  });

  it("uses UTC calendar periods without overflowing month ends or leap days", () => {
    expect(addBillingPeriod(new Date("2026-01-31T10:00:00Z"), "monthly").toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(addBillingPeriod(new Date("2024-02-29T10:00:00Z"), "annual").toISOString()).toBe("2025-02-28T10:00:00.000Z");
  });

  it("reuses a payable order and never creates two orders for the same intent", async () => {
    const org = await Organization.create({ name: "Idempotent Clinic", city: "Pune" });
    const plan = await SaaSPlan.create({ name: "Idempotent Pro", slug: "idempotent_pro", description: "Paid plan", monthlyPrice: 499, annualPrice: 4999 });
    const intent = "intent-1234567890123456";
    const first = await subscriptionService.createCheckoutOrder(org.id, plan.id, "monthly", intent);
    const second = await subscriptionService.createCheckoutOrder(org.id, plan.id, "monthly", intent);
    expect(second.orderId).toBe(first.orderId);
    expect(await SubscriptionPayment.countDocuments({ organizationId: org._id })).toBe(1);
    await expect(subscriptionService.createCheckoutOrder(org.id, plan.id, "annual", "different-1234567890123456"))
      .rejects.toThrow("Another checkout is in progress");
  });

  it("reconciles captured provider payment after the browser callback is lost", async () => {
    const org = await Organization.create({ name: "Recovered Clinic", city: "Pune" });
    const plan = await SaaSPlan.create({ name: "Recovered Pro", slug: "recovered_pro", description: "Paid plan", monthlyPrice: 499, annualPrice: 4999 });
    const order = await subscriptionService.createCheckoutOrder(org.id, plan.id, "monthly");
    const fetch = vi.spyOn(razorpayService, "fetchCapturedPaymentForOrder").mockResolvedValue("pay_recovered_123");
    try {
      const status = await subscriptionService.reconcileCheckout(org.id, order.orderId);
      expect(status).toMatchObject({ status: "captured", success: true });
      expect((await Subscription.findOne({ organizationId: org._id }))?.planId.toString()).toBe(plan.id);
      expect(await SaaSInvoice.countDocuments({ organizationId: org._id })).toBe(1);
      const repeated = await subscriptionService.reconcileCheckout(org.id, order.orderId);
      expect(repeated.success).toBe(true);
      expect(await SaaSInvoice.countDocuments({ organizationId: org._id })).toBe(1);
    } finally { fetch.mockRestore(); }
  });

  it("keeps a failed attempt's order payable and accepts a later captured attempt", async () => {
    const org = await Organization.create({ name: "Retry Clinic", city: "Pune" });
    const plan = await SaaSPlan.create({ name: "Retry Pro", slug: "retry_pro", description: "Paid plan", monthlyPrice: 499, annualPrice: 4999 });
    const order = await subscriptionService.createCheckoutOrder(org.id, plan.id, "monthly");
    const failed = { event: "payment.failed", payload: { payment: { entity: {
      id: "pay_failed_123", order_id: order.orderId, error_description: "Declined",
    } } } };
    const failedRaw = JSON.stringify(failed);
    await subscriptionService.processRazorpayWebhook(failedRaw,
      crypto.createHmac("sha256", "mock_webhook_secret").update(failedRaw).digest("hex"), failed);
    expect((await SubscriptionPayment.findOne({ razorpayOrderId: order.orderId }))?.status).toBe("created");
    const captured = { event: "payment.captured", payload: { payment: { entity: {
      id: "pay_retry_123", order_id: order.orderId, status: "captured", amount: order.amount * 100, currency: "INR",
    } } } };
    const raw = JSON.stringify(captured);
    await subscriptionService.processRazorpayWebhook(raw,
      crypto.createHmac("sha256", "mock_webhook_secret").update(raw).digest("hex"), captured);
    expect((await SubscriptionPayment.findOne({ razorpayOrderId: order.orderId }))?.status).toBe("captured");
  });

  it("shows and closes a legacy failed order so the organization can choose another plan", async () => {
    const org = await Organization.create({ name: "Legacy Failed Clinic", city: "Pune" });
    const plan = await SaaSPlan.create({ name: "Legacy Pro", slug: "legacy_pro", description: "Paid plan", monthlyPrice: 499, annualPrice: 4999 });
    const order = await subscriptionService.createCheckoutOrder(org.id, plan.id, "monthly");
    await SubscriptionPayment.updateOne({ razorpayOrderId: order.orderId }, { $set: { status: "failed" } });
    const fetch = vi.spyOn(razorpayService, "fetchCapturedPaymentForOrder").mockResolvedValue(null);
    try {
      expect(await subscriptionService.reconcileCheckout(org.id)).toMatchObject({ status: "created", orderId: order.orderId });
      expect(await subscriptionService.abandonCheckout(org.id, order.orderId)).toMatchObject({ status: "abandoned" });
      expect((await Subscription.findOne({ organizationId: org.id }))?.pendingCheckout?.paymentId).toBeNull();
    } finally { fetch.mockRestore(); }
  });

  it("records a late capture for review without overwriting a later plan change", async () => {
    const org = await Organization.create({ name: "Late Capture Clinic", city: "Pune" });
    const paidPlan = await SaaSPlan.create({ name: "Late Capture Pro", slug: "late_capture_pro", description: "Paid plan", monthlyPrice: 499, annualPrice: 4999 });
    const freePlan = await SaaSPlan.create({ name: "Late Capture Free", slug: "late_capture_free", description: "Free plan", monthlyPrice: 0, annualPrice: 0 });
    const order = await subscriptionService.createCheckoutOrder(org.id, paidPlan.id, "monthly");
    await SubscriptionPayment.updateOne({ razorpayOrderId: order.orderId }, { $set: { createdAt: new Date(Date.now() - 60_000) } });
    const fetch = vi.spyOn(razorpayService, "fetchCapturedPaymentForOrder").mockResolvedValue(null);
    try {
      const abandoned = await subscriptionService.abandonCheckout(org.id, order.orderId);
      expect(abandoned.status).toBe("abandoned");
      await subscriptionService.directSwitchPlan(org.id, freePlan.id);
      const captured = { event: "payment.captured", payload: { payment: { entity: {
        id: "pay_late_123", order_id: order.orderId, status: "captured", amount: order.amount * 100, currency: "INR",
      } } } };
      const raw = JSON.stringify(captured);
      await subscriptionService.processRazorpayWebhook(raw,
        crypto.createHmac("sha256", "mock_webhook_secret").update(raw).digest("hex"), captured);
      expect((await SubscriptionPayment.findOne({ razorpayOrderId: order.orderId }))?.status).toBe("captured_review");
      expect((await Organization.findById(org.id))?.plan).toBe(freePlan.slug);
      expect(await SaaSInvoice.countDocuments({ organizationId: org._id })).toBe(1);
      await subscriptionService.processRazorpayWebhook(raw,
        crypto.createHmac("sha256", "mock_webhook_secret").update(raw).digest("hex"), captured);
      expect(await SaaSInvoice.countDocuments({ organizationId: org._id })).toBe(1);
    } finally { fetch.mockRestore(); }
  });

  it("rejects a signed captured event with the wrong amount", async () => {
    const org = await Organization.create({ name: "Wrong Amount Clinic", city: "Pune" });
    const plan = await SaaSPlan.create({ name: "Wrong Amount Pro", slug: "wrong_amount_pro", description: "Paid plan", monthlyPrice: 499, annualPrice: 4999 });
    const order = await subscriptionService.createCheckoutOrder(org.id, plan.id, "monthly");
    const event = { event: "payment.captured", payload: { payment: { entity: {
      id: "pay_wrong_amount", order_id: order.orderId, status: "captured", amount: 100, currency: "INR",
    } } } };
    const raw = JSON.stringify(event);
    await expect(subscriptionService.processRazorpayWebhook(raw,
      crypto.createHmac("sha256", "mock_webhook_secret").update(raw).digest("hex"), event))
      .rejects.toThrow("does not match");
    expect((await SubscriptionPayment.findOne({ razorpayOrderId: order.orderId }))?.status).toBe("created");
  });

  it("restores an expired trial, changes paid plans immediately, and extends same-plan renewal", async () => {
    const org = await Organization.create({ name: "Lifecycle Billing Clinic", city: "Pune" });
    const firstPlan = await SaaSPlan.create({ name: "Lifecycle Pro", slug: "lifecycle_pro", description: "Paid plan", monthlyPrice: 499, annualPrice: 4999 });
    const higherPlan = await SaaSPlan.create({ name: "Lifecycle Plus", slug: "lifecycle_plus", description: "Paid plan", monthlyPrice: 999, annualPrice: 9999 });
    const trial = await subscriptionService.getOrInitializeSubscription(org.id);
    await Subscription.updateOne({ _id: trial._id }, { $set: { status: "expired", trialEndsAt: new Date(Date.now() - 86400000), currentPeriodEnd: new Date(Date.now() - 86400000) } });
    const pay = async (planId: string, paymentId: string) => {
      const order = await subscriptionService.createCheckoutOrder(org.id, planId, "monthly");
      const signature = crypto.createHmac("sha256", "mock_secret_key_12345")
        .update(`${order.orderId}|${paymentId}`).digest("hex");
      return subscriptionService.verifyAndActivateSubscription(org.id, order.orderId, paymentId, signature);
    };
    await pay(firstPlan.id, "pay_lifecycle_first");
    const paid = await Subscription.findOne({ organizationId: org._id });
    expect(paid?.status).toBe("active");
    expect(paid?.entitlementSource).toBe("paid");
    expect(await canCreateOrganizationBooking(org.id)).toBe(true);
    await pay(higherPlan.id, "pay_lifecycle_higher");
    const higher = await Subscription.findOne({ organizationId: org._id });
    expect(higher?.planId.toString()).toBe(higherPlan.id);
    const previousEnd = higher!.currentPeriodEnd.toISOString();
    await pay(higherPlan.id, "pay_lifecycle_renewal");
    const renewed = await Subscription.findOne({ organizationId: org._id });
    expect(renewed?.currentPeriodStart.toISOString()).toBe(previousEnd);
    expect(renewed?.currentPeriodEnd.getTime()).toBeGreaterThan(higher!.currentPeriodEnd.getTime());
    expect(await SaaSInvoice.countDocuments({ organizationId: org._id })).toBe(3);
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

  it("keeps paise exact for a two-decimal plan price while applying the existing GST rounding", async () => {
    const org = await Organization.create({ name: "Decimal Price Clinic", city: "Delhi" });
    const plan = await SaaSPlan.create({ name: "Decimal Pro", slug: "decimal_pro", description: "Paid plan", monthlyPrice: 499.5, annualPrice: 4999.5 });
    const order = await subscriptionService.createCheckoutOrder(org.id, plan.id, "monthly");
    expect(order.amount).toBe(589.5);
    const payment = await SubscriptionPayment.findOne({ razorpayOrderId: order.orderId });
    expect(payment?.subtotal).toBe(499.5);
    expect(payment?.taxAmount).toBe(90);
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

    await Organization.findByIdAndUpdate(org._id, { $set: { "billingDetails.gstin": "22AAAAA0000A1Z5",
      "billingDetails.email": "invoices@metro.test", "billingDetails.address": "Registered office" } });

    const checkout = await subscriptionService.createCheckoutOrder(
      org._id.toString(),
      plan._id.toString(),
      "monthly"
    );

    const paymentId = `pay_${Math.random().toString(36).slice(2, 11)}`;
    const signature = crypto.createHmac("sha256", "mock_secret_key_12345")
      .update(`${checkout.orderId}|${paymentId}`).digest("hex");
    await expect(subscriptionService.verifyAndActivateSubscription(
      org._id.toString(), checkout.orderId, paymentId, "simulated_valid_signature"
    )).rejects.toThrow("Invalid signature");
    expect((await SubscriptionPayment.findOne({ razorpayOrderId: checkout.orderId }))?.status).toBe("created");

    const result = await subscriptionService.verifyAndActivateSubscription(
      org._id.toString(),
      checkout.orderId,
      paymentId,
      signature
    );

    if ("pending" in result) throw new Error("Test payment should be captured");
    expect(result.success).toBe(true);
    expect(result.subscription?.status).toBe("active");
    expect(result.invoice).toBeDefined();
    expect(result.invoice?.invoiceNumber).toContain("SAAS-");
    expect(result.invoice?.billingDetails).toMatchObject({ gstin: "22AAAAA0000A1Z5",
      email: "invoices@metro.test", address: "Registered office" });

    // Check organization limits updated
    const updatedOrg = await Organization.findById(org._id);
    expect(updatedOrg?.plan).toBe("ent_test");
    expect(updatedOrg?.maxClinics).toBe(99);

    const repeated = await subscriptionService.verifyAndActivateSubscription(
      org._id.toString(), checkout.orderId, paymentId, signature
    );
    expect(repeated.success).toBe(true);
    expect(await SaaSInvoice.countDocuments({ paymentId: (await SubscriptionPayment.findOne({ razorpayOrderId: checkout.orderId }))?._id })).toBe(1);
  });

  it("does not allow a paid plan through the direct switch endpoint", async () => {
    const org = await Organization.create({ name: "No free upgrade", city: "Delhi" });
    const plan = await SaaSPlan.create({ name: "Paid", slug: "paid_direct_switch", description: "Paid plan", monthlyPrice: 499, annualPrice: 4999 });
    await expect(subscriptionService.directSwitchPlan(org.id, plan.id)).rejects.toThrow("verified checkout payment");
  });

  it("activates captured webhook payments once and ignores later failed events", async () => {
    const org = await Organization.create({ name: "Webhook Clinic", city: "Surat" });
    const plan = await SaaSPlan.create({ name: "Webhook Pro", slug: "webhook_pro", description: "Paid plan", monthlyPrice: 700, annualPrice: 7000 });
    const order = await subscriptionService.createCheckoutOrder(org.id, plan.id, "monthly");
    const capturedEvent = { event: "payment.captured", payload: { payment: { entity: {
      id: "pay_webhook_123", order_id: order.orderId, status: "captured", amount: order.amount * 100, currency: "INR",
    } } } };
    const raw = JSON.stringify(capturedEvent);
    const signature = crypto.createHmac("sha256", "mock_webhook_secret").update(raw).digest("hex");
    await expect(subscriptionService.processRazorpayWebhook(raw, "invalid", capturedEvent)).rejects.toThrow("Invalid webhook signature");
    await subscriptionService.processRazorpayWebhook(raw, signature, capturedEvent);
    await subscriptionService.processRazorpayWebhook(raw, signature, capturedEvent);
    const payment = await SubscriptionPayment.findOne({ razorpayOrderId: order.orderId });
    expect(payment?.status).toBe("captured");
    expect(await SaaSInvoice.countDocuments({ paymentId: payment?._id })).toBe(1);
    const failedEvent = { event: "payment.failed", payload: { payment: { entity: {
      order_id: order.orderId, error_description: "Late failed event",
    } } } };
    const failedRaw = JSON.stringify(failedEvent);
    await subscriptionService.processRazorpayWebhook(failedRaw, crypto.createHmac("sha256", "mock_webhook_secret").update(failedRaw).digest("hex"), failedEvent);
    expect((await SubscriptionPayment.findById(payment?._id))?.status).toBe("captured");
    expect((await Subscription.findOne({ organizationId: org._id }))?.status).toBe("active");
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
