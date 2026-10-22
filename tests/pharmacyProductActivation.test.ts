import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { pharmacyRetailFixture } from "./helpers/pharmacyRetailFixture.ts";
import { SaaSConfig } from "../models/SaaSConfig.ts";
import { SaaSPlan } from "../models/SaaSPlan.ts";
import { Subscription } from "../models/Subscription.ts";
import { SubscriptionPayment } from "../models/SubscriptionPayment.ts";
import { SaaSInvoice } from "../models/SaaSInvoice.ts";
import { Location } from "../models/Location.ts";
import { Organization } from "../models/Organization.ts";
import { Medicine } from "../models/Medicine.ts";
import { Invoice } from "../models/Invoice.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { createAuthSession } from "../utilities/helpers.ts";
import { addBillingPeriod } from "../utilities/billingPeriod.ts";
import { type CommercialQuote } from "../utilities/commercialQuote.ts";
import { sealProductQuote } from "../services/billing/ProductActivationService.ts";
import { getOrganizationProductEntitlements } from "../services/billing/ProductEntitlementService.ts";
import { subscriptionService } from "../services/billing/SubscriptionService.ts";
import { razorpayService } from "../services/billing/RazorpayService.ts";
import { canCreateLocationBooking, getOrganizationBookingAccess } from "../services/billing/SubscriptionAccess.ts";

const key = () => crypto.randomUUID();
beforeAll(async () => {
  await app.ready();
  await Promise.all(Object.values(mongoose.models).map(model => model.init()));
  await SaaSConfig.create({ key: "platform_config", razorpayKeyId: "rzp_test_mock_key_12345", razorpayKeySecret: "mock_secret", razorpayWebhookSecret: "mock_webhook_secret", isLiveMode: false });
});
afterEach(() => vi.restoreAllMocks());
async function fixture(free = false) {
  const retail = await pharmacyRetailFixture(["MANAGE_ORGANIZATION", "PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT", "PHARMACY_VIEW_STOCK", "PHARMACY_VIEW_REPORTS", "PHARMACY_ADJUST_STOCK"]);
  const plan = await SaaSPlan.create({ name: "Synthetic location products", slug: `products_${key()}`, description: "Test prices only", commercialFamily: "location_products", legacyTier: "starter", monthlyPrice: 0, annualPrice: 0, currency: "INR",
    commercialPricing: { revision: 1, monthly: { clinicPaise: 79900, pharmacyPaise: free ? 0 : 49901, pharmacyAddonPaise: 29900, extraDoctorPaise: 29900 }, taxMode: "inclusive", taxRateBps: 1800, includedDoctors: 1, doctorsPerAdditionalClinic: 0 },
    limits: { maxLocations: 5, maxDoctors: 10, maxStaff: 5 } });
  const input = { planId: plan.id, priceRevision: 1, billingCycle: "monthly" as const, doctorSeats: 0, locations: [{ locationId: retail.locationId, clinic: false, pharmacy: true }] };
  return { ...retail, plan, quoteInput: input };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function quote(f: Fixture, overrides = {}) {
  const response = await app.inject({ method: "POST", url: "/api/billing/quote", headers: f.headers, payload: { ...f.quoteInput, ...overrides } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().data as CommercialQuote & { quoteToken: string };
}
async function checkout(f: Fixture, q: Awaited<ReturnType<typeof quote>>, intent = key()) {
  return subscriptionService.createCheckoutOrder(f.organizationId, f.plan.id, "monthly", intent, q.quoteToken);
}
async function capture(f: Fixture, orderId: string) {
  vi.spyOn(razorpayService, "fetchCapturedPaymentForOrder").mockResolvedValue(`pay_${key().replaceAll("-", "")}`);
  return subscriptionService.reconcileCheckout(f.organizationId, orderId);
}
const sale = (f: Fixture, requestKey = key(), payload = f.input) => app.inject({ method: "POST", url: "/api/pharmacy/sales", headers: { ...f.headers, "idempotency-key": requestKey }, payload });

describe("Quote-bound product activation on the existing subscription ledger", () => {
  it("captures exact odd paise and activates standalone capacity once with no clinical identity or doctor seat", async () => {
    const f = await fixture(), q = await quote(f), order = await checkout(f, q);
    expect(order.amount).toBe(499.01);
    const payment = await SubscriptionPayment.findById(order.paymentId);
    expect(payment!.commercialQuote?.fingerprint).toBe(q.fingerprint);
    expect(Math.round((payment!.subtotal! + payment!.taxAmount!) * 100)).toBe(49901);
    expect((await getOrganizationProductEntitlements(f.organizationId)).enforcement).toBe(false);
    expect(await capture(f, order.orderId)).toMatchObject({ status: "captured", success: true });
    expect(await subscriptionService.reconcileCheckout(f.organizationId, order.orderId)).toMatchObject({ status: "captured", success: true });
    expect(await SaaSInvoice.countDocuments({ paymentId: order.paymentId })).toBe(1);
    expect(await getOrganizationProductEntitlements(f.organizationId)).toMatchObject({ enforcement: true, mode: "configured", active: true, pharmacyLocationIds: [f.locationId], clinicLocationIds: [], limits: { maxLocations: 1, maxDoctors: 0 } });
    expect((await Organization.findById(f.organizationId))!.maxDoctors).toBe(0);
  });
  it("serializes concurrent verified capture callbacks into one grant and one invoice", async () => {
    const f = await fixture(), order = await checkout(f, await quote(f));
    vi.spyOn(razorpayService, "fetchCapturedPaymentForOrder").mockResolvedValue("pay_concurrentproducts");
    const results = await Promise.all([subscriptionService.reconcileCheckout(f.organizationId, order.orderId), subscriptionService.reconcileCheckout(f.organizationId, order.orderId)]);
    expect(results.every(result => result.success)).toBe(true);
    expect(await SaaSInvoice.countDocuments({ paymentId: order.paymentId })).toBe(1);
    expect((await getOrganizationProductEntitlements(f.organizationId)).active).toBe(true);
  });
  it("binds stable intents to the exact quote and rejects altered, foreign or plaintext tokens before any provider call", async () => {
    const f = await fixture(), q = await quote(f), provider = vi.spyOn(razorpayService, "createOrder"), intent = key();
    for (const token of [JSON.stringify(q), `${q.quoteToken.slice(0, -2)}00`, sealProductQuote({ ...q, organizationId: new mongoose.Types.ObjectId().toString() })]) {
      await expect(subscriptionService.createCheckoutOrder(f.organizationId, f.plan.id, "monthly", intent, token)).rejects.toThrow(/server-issued/);
    }
    expect(provider).not.toHaveBeenCalled();
    const first = await checkout(f, q, intent), second = await checkout(f, q, intent);
    expect(second.orderId).toBe(first.orderId); expect(provider).toHaveBeenCalledTimes(1);
    const changed = await quote(f, { locations: [{ locationId: f.locationId, clinic: true, pharmacy: true }] });
    await expect(checkout(f, changed, intent)).rejects.toThrow(/another plan/);
    await expect(checkout(f, changed)).rejects.toThrow(/Another checkout/);
  });
  it("rejects concurrent payable orders and resumes the captured selection after a reload without re-quoting", async () => {
    const f = await fixture(), q = await quote(f);
    const outcomes = await Promise.allSettled([checkout(f, q), checkout(f, q)]);
    expect(outcomes.filter(result => result.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    expect(await SubscriptionPayment.countDocuments({ organizationId: f.organizationId })).toBe(1);
    const payment = await SubscriptionPayment.findOne({ organizationId: f.organizationId });
    const resumed = await app.inject({ method: "POST", url: "/api/billing/checkout", headers: f.headers, payload: { orderId: payment!.razorpayOrderId } });
    expect(resumed.statusCode, resumed.body).toBe(200); expect(resumed.json().data).toMatchObject({ orderId: payment!.razorpayOrderId, amount: 499.01, reused: true });
    const foreign = await fixture();
    expect((await app.inject({ method: "POST", url: "/api/billing/checkout", headers: foreign.headers, payload: { orderId: payment!.razorpayOrderId } })).statusCode).toBe(404);
  });
  it("requires current branch authority even when the caller retains organization management", async () => {
    const f = await fixture(), q = await quote(f);
    await OrgMember.updateOne({ organizationId: f.organizationId, userId: f.user.id }, { "locationAccess.locationIds": [] });
    const response = await app.inject({ method: "POST", url: "/api/billing/checkout", headers: f.headers, payload: { planId: f.plan.id, billingCycle: "monthly", checkoutIntentId: key(), quoteToken: q.quoteToken } });
    expect(response.statusCode, response.body).toBe(404); expect(await SubscriptionPayment.countDocuments({ organizationId: f.organizationId })).toBe(0);
  });
  it("rejects expired or repriced quotes before charging, but honors already-created captured prices", async () => {
    const f = await fixture(), q = await quote(f), provider = vi.spyOn(razorpayService, "createOrder");
    const expired = { ...q, expiresAt: new Date(Date.now() - 1).toISOString() };
    await expect(checkout(f, { ...q, quoteToken: sealProductQuote(expired) })).rejects.toThrow(/expired/);
    expect(provider).not.toHaveBeenCalled();
    const order = await checkout(f, q);
    await SaaSPlan.updateOne({ _id: f.plan.id }, { "commercialPricing.revision": 2, "commercialPricing.monthly.pharmacyPaise": 99999 });
    expect(await capture(f, order.orderId)).toMatchObject({ success: true });
    expect((await SaaSInvoice.findOne({ paymentId: order.paymentId }))!.totalAmount).toBe(499.01);
    await expect(checkout(f, q)).rejects.toThrow(/prices changed/);
  });
  it.each(["capability", "location", "manual", "amount"])("records captured-review without granting when %s changes after checkout", async change => {
    const f = await fixture(), q = await quote(f), order = await checkout(f, q);
    if (change === "capability") await Location.updateOne({ _id: f.locationId }, { "pharmacyCapability.revision": 1 });
    if (change === "location") await Location.create({ organizationId: f.organizationId, name: "New branch", city: "Pune" });
    if (change === "manual") await Subscription.updateOne({ organizationId: f.organizationId }, { currentPeriodEnd: new Date(Date.now() + 80 * 86400000) });
    if (change === "amount") await SubscriptionPayment.updateOne({ _id: order.paymentId }, { amount: 1 });
    expect(await capture(f, order.orderId)).toMatchObject({ status: "captured_review", success: false, requiresReview: true });
    expect((await SubscriptionPayment.findById(order.paymentId))!.status).toBe("captured_review");
    expect((await Subscription.findOne({ organizationId: f.organizationId }))!.commercialQuote).toBeUndefined();
    expect(await SaaSInvoice.countDocuments({ paymentId: order.paymentId })).toBe(1);
  });
  it("extends an active cancelled renewal without a future-start access gap or quote-period truncation", async () => {
    const f = await fixture(), first = await checkout(f, await quote(f)); await capture(f, first.orderId);
    const before = await Subscription.findOne({ organizationId: f.organizationId });
    await Subscription.updateOne({ _id: before!.id }, { status: "cancelled", cancelledAt: new Date() });
    const renewal = await checkout(f, await quote(f)); await capture(f, renewal.orderId);
    const after = await Subscription.findById(before!.id);
    expect(after!.currentPeriodStart).toEqual(before!.currentPeriodStart);
    expect(after!.currentPeriodEnd).toEqual(addBillingPeriod(before!.currentPeriodEnd, "monthly"));
    const future = new Date(before!.currentPeriodEnd.getTime() + 1000);
    expect(await getOrganizationProductEntitlements(f.organizationId, future)).toMatchObject({ active: true, enforcement: true });
    expect(await getOrganizationProductEntitlements(f.organizationId, after!.currentPeriodEnd)).toMatchObject({ active: false });
  });
  it("blocks an unpriced mid-period selection change before opening a new order", async () => {
    const f = await fixture(), first = await checkout(f, await quote(f)); await capture(f, first.orderId);
    const changed = await quote(f, { locations: [{ locationId: f.locationId, clinic: true, pharmacy: true }] });
    await expect(checkout(f, changed)).rejects.toThrow(/proration/);
    expect(await SubscriptionPayment.countDocuments({ organizationId: f.organizationId })).toBe(1);
  });
  it("cannot erase a product access contract by switching to a flat free or paid plan", async () => {
    const f = await fixture(), first = await checkout(f, await quote(f)); await capture(f, first.orderId);
    const flat = await SaaSPlan.create({ name: "Standard free clinic", slug: key(), description: "Current clinic workflow", monthlyPrice: 0, annualPrice: 0 });
    await expect(subscriptionService.directSwitchPlan(f.organizationId, flat.id)).rejects.toThrow(/product selection/);
    await expect(subscriptionService.createCheckoutOrder(f.organizationId, flat.id, "monthly", key())).rejects.toThrow(/product selection/);
    expect((await getOrganizationProductEntitlements(f.organizationId)).active).toBe(true);
  });
  it("revokes new business after an actual refunded source without removing the product selection", async () => {
    const f = await fixture(), order = await checkout(f, await quote(f)); await capture(f, order.orderId);
    const root = await User.create({ name: "Refund operator", email: `${key()}@example.test`, role: "root" });
    const auth = await createAuthSession({ id: root.id, role: "root", email: root.email! });
    vi.spyOn(razorpayService, "processRefund").mockResolvedValue({ id: "rfnd_synthetic", status: "processed" });
    const response = await app.inject({ method: "POST", url: `/api/admin/billing/payments/${order.paymentId}/refund`, headers: { authorization: `Bearer ${auth.accessToken}` } });
    expect(response.statusCode, response.body).toBe(200);
    expect((await SaaSInvoice.findOne({ paymentId: order.paymentId }))!.status).toBe("refunded");
    expect(await getOrganizationProductEntitlements(f.organizationId)).toMatchObject({ enforcement: true, active: false, mode: "review_required" });
    expect((await Subscription.findOne({ organizationId: f.organizationId }))!.commercialQuote).toBeTruthy();
    expect((await sale(f)).statusCode).toBe(402);
  });
  it("enforces clinic bookings per selected branch without making a clinic a pharmacy prerequisite", async () => {
    const f = await fixture(), clinic = await Location.create({ organizationId: f.organizationId, name: "Clinic branch", city: "Pune" });
    await OrgMember.updateOne({ organizationId: f.organizationId, userId: f.user.id }, { "locationAccess.locationIds": [f.locationId, clinic.id] });
    const q = await quote(f, { locations: [...f.quoteInput.locations, { locationId: clinic.id, clinic: true, pharmacy: false }] });
    const order = await checkout(f, q); await capture(f, order.orderId);
    expect(await canCreateLocationBooking(f.locationId)).toBe(false);
    expect(await canCreateLocationBooking(clinic.id)).toBe(true);
    expect((await getOrganizationBookingAccess([f.organizationId])).get(f.organizationId)).toBe(true);
  });
  it("activates a configured zero-price selection through the free switch and does not renew it on replay", async () => {
    const f = await fixture(true), q = await quote(f), provider = vi.spyOn(razorpayService, "createOrder");
    const first = await subscriptionService.directSwitchPlan(f.organizationId, f.plan.id, "monthly", q.quoteToken);
    const second = await subscriptionService.directSwitchPlan(f.organizationId, f.plan.id, "monthly", q.quoteToken);
    expect(second.subscription.currentPeriodEnd).toEqual(first.subscription.currentPeriodEnd);
    expect(await getOrganizationProductEntitlements(f.organizationId)).toMatchObject({ active: true, source: "free", enforcement: true }); expect(provider).not.toHaveBeenCalled();
  });
  it.each(["manual", "trial"] as const)("supports attributed root %s grants with configured capacity and periods", async grantKind => {
    const f = await fixture(), q = await quote(f), sub = await subscriptionService.getOrInitializeSubscription(f.organizationId);
    const root = await User.create({ name: "Reviewed operator", email: `${key()}@example.test`, role: "root" });
    const auth = await createAuthSession({ id: root.id, role: "root", email: root.email! });
    const response = await app.inject({ method: "POST", url: `/api/admin/billing/subscriptions/${sub.id}/activate`, headers: { authorization: `Bearer ${auth.accessToken}` }, payload: {
      planSlug: f.plan.slug, quoteToken: q.quoteToken, grantKind, reason: "Synthetic explicit grant review",
    } });
    expect(response.statusCode, response.body).toBe(200);
    expect(await getOrganizationProductEntitlements(f.organizationId)).toMatchObject({ active: true, source: grantKind, limits: { maxDoctors: 0 } });
    const granted = await Subscription.findById(sub.id);
    expect(String(granted!.manualGrantedBy)).toBe(root.id);
    if (grantKind === "trial") expect(granted!.trialEndsAt.getTime() - granted!.trialStartedAt.getTime()).toBe(f.plan.trialDays * 86400000);
  });
});

describe("Product expiry preserves operational continuity", () => {
  it("rolls back a new sale after expiry, replays the original sale, collects its due and exports its facts", async () => {
    const f = await fixture(), order = await checkout(f, await quote(f)); await capture(f, order.orderId);
    const customer = await PharmacyParty.create({ organizationId: f.organizationId, locationIds: [f.locationId], name: "Identified customer", normalizedName: "identified customer", address: "Recorded address", kinds: ["customer"], gstRegistration: "unregistered", createdBy: f.user.id, updatedBy: f.user.id });
    const body = { ...f.input, customerId: customer.id, expectedCustomerRevision: 0 }, saleKey = key();
    const original = await sale(f, saleKey, body); expect(original.statusCode, original.body).toBe(201);
    await Subscription.updateOne({ organizationId: f.organizationId }, { currentPeriodEnd: new Date(Date.now() - 1) });
    const stockBefore = (await Medicine.findById(f.medicine.id))!.stockQuantity;
    const denied = await sale(f, key(), { ...body, lines: [{ ...body.lines[0], expectedStockRevision: 2 }] });
    expect(denied.statusCode, denied.body).toBe(402);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(stockBefore);
    expect(await Invoice.countDocuments({ organizationId: f.organizationId })).toBe(1);
    const replay = await sale(f, saleKey, body); expect(replay.statusCode, replay.body).toBe(201); expect(replay.json().data.invoiceId).toBe(original.json().data.invoiceId);
    const collection = await app.inject({ method: "POST", url: `/api/pharmacy/invoices/${original.json().data.invoiceId}/collections`, headers: { ...f.headers, "idempotency-key": key() }, payload: {
      locationId: f.locationId, expectedPaymentRevision: 0, expectedBalancePaise: 2000, manualConfirmed: true, cashTenderedPaise: 2000,
      entries: [{ componentId: key(), amountPaise: 2000, paymentMethod: "cash" }],
    } });
    expect(collection.statusCode, collection.body).toBe(201);
    const report = await app.inject({ method: "GET", url: `/api/pharmacy/reports/sales?locationId=${f.locationId}`, headers: f.headers });
    expect(report.statusCode, report.body).toBe(200); expect(report.json().data.rows).toHaveLength(1);
    const exported = await app.inject({ method: "GET", url: `/api/pharmacy/reports/sales/export?locationId=${f.locationId}&expectedDigest=${report.json().data.digest}`, headers: f.headers });
    expect(exported.statusCode, exported.body).toBe(200);
    const access = await app.inject({ method: "GET", url: `/api/pharmacy/locations/${f.locationId}/capabilities`, headers: f.headers });
    expect(access.statusCode, access.body).toBe(200); expect(access.json().data.actions).toMatchObject({ sell: false, collect: true, viewReports: true, adjustStock: true });
    // Structured stock requires its actual lot identity for both corrections and increases.
    const { MedicineBatch } = await import("../models/MedicineBatch.ts");
    const batch = await MedicineBatch.findOne({ medicineId: f.medicine.id });
    const writeoff = await app.inject({ method: "POST", url: "/api/pharmacy/adjust-stock", headers: f.headers, payload: {
      medicineId: f.medicine.id, batchId: batch!.id, expectedQuantity: 8, expectedRevision: 2, newQuantity: 7, reason: "damaged", clientRequestId: key(),
    } });
    expect(writeoff.statusCode, writeoff.body).toBe(200);
    const increase = await app.inject({ method: "POST", url: "/api/pharmacy/adjust-stock", headers: f.headers, payload: {
      medicineId: f.medicine.id, batchId: batch!.id, expectedQuantity: 7, expectedRevision: 3, newQuantity: 8, reason: "restock", clientRequestId: key(),
    } });
    expect(increase.statusCode, increase.body).toBe(402);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(7);
  });
});
