import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { Doctor } from "../models/Doctor.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Role } from "../models/Role.ts";
import { ModuleRegistry } from "../models/ModuleRegistry.ts";
import { SaaSPlan } from "../models/SaaSPlan.ts";
import { Subscription } from "../models/Subscription.ts";
import { SubscriptionPayment } from "../models/SubscriptionPayment.ts";
import { SaaSInvoice } from "../models/SaaSInvoice.ts";
import { OrgInvite } from "../models/OrgInvite.ts";
import { createAuthSession } from "../utilities/helpers.ts";
import { calculateCommercialQuote, quoteFingerprint, type CommercialPricing, type CommercialQuote } from "../utilities/commercialQuote.ts";
import { getOrganizationProductEntitlements } from "../services/billing/ProductEntitlementService.ts";
import { subscriptionService } from "../services/billing/SubscriptionService.ts";
import { razorpayService } from "../services/billing/RazorpayService.ts";

const orgId = "aaaaaaaaaaaaaaaaaaaaaaaa", first = "bbbbbbbbbbbbbbbbbbbbbbbb", second = "cccccccccccccccccccccccc";
const now = new Date("2027-01-31T10:15:00.000Z");
const pricing = (): CommercialPricing => ({ revision: 1, monthly: { clinicPaise: 79900, pharmacyPaise: 49900, pharmacyAddonPaise: 29900, extraDoctorPaise: 29900 },
  taxMode: "inclusive", taxRateBps: 0, includedDoctors: 1, doctorsPerAdditionalClinic: 0 });
const planInput = () => ({ id: "dddddddddddddddddddddddd", commercialFamily: "location_products" as const, legacyTier: "starter" as const, currency: "INR", commercialPricing: pricing(), limits: { maxLocations: 5, maxDoctors: 10, maxStaff: 5 } });
const selected = (clinic: boolean, pharmacy: boolean, locationId = first) => ({ locationId, clinic, pharmacy, capabilityRevision: 0 });
const calculate = (clinic: boolean, pharmacy: boolean, doctorSeats: number, plan = planInput()) => calculateCommercialQuote(orgId, plan,
  { priceRevision: plan.commercialPricing.revision, billingCycle: "monthly", doctorSeats, locations: [selected(clinic, pharmacy)] }, now);
async function principal(role: string, organizationId?: string, locationIds?: string[]) {
  const user = await User.create({ name: "Commercial fixture", email: `${crypto.randomUUID()}@example.test`, role });
  if (organizationId && !["root", "patient", "guest", "family_member"].includes(role)) await OrgMember.create({ userId: user.id, organizationId, role,
    ...(locationIds ? { locationAccess: { mode: "selected", locationIds } } : {}) });
  const session = await createAuthSession({ id: user.id, role, email: user.email!, organization_id: organizationId });
  return { user, headers: { authorization: `Bearer ${session.accessToken}` } };
}
async function fixture() {
  const organization = await Organization.create({ name: "Commercial pharmacy", city: "Pune", countryCode: "IN", currency: "INR", maxDoctors: 0, maxStaff: 10, maxLocations: 5 });
  const location = await Location.create({ organizationId: organization.id, name: "Physical clinic", city: "Pune", facilityType: "clinic", pharmacyCapability: { enabled: false, revision: 2 } });
  const plan = await SaaSPlan.create({ ...planInput(), name: "Configured products", slug: `products_${crypto.randomUUID()}`, description: "Synthetic configured rates", monthlyPrice: 0, annualPrice: 0 });
  const admin = await principal("admin", organization.id);
  const root = await principal("root");
  const input = { planId: plan.id, priceRevision: 1, billingCycle: "monthly" as const, doctorSeats: 0, locations: [{ locationId: location.id, clinic: false, pharmacy: true }] };
  return { organization, location, plan, admin, root, input };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const postQuote = (f: Fixture, payload: object = f.input, headers = f.admin.headers) => app.inject({ method: "POST", url: "/api/billing/quote", headers, payload });
async function snapshotSubscription(f: Fixture, source: "trial" | "manual" | "paid" | "free" = "manual") {
  const current = new Date(), quote = calculateCommercialQuote(f.organization.id, { ...f.plan.toObject(), id: f.plan.id },
    { ...f.input, locations: [{ ...f.input.locations[0], capabilityRevision: 2 }] }, current);
  const subscription = await Subscription.create({ organizationId: f.organization.id, planId: f.plan.id, status: source === "trial" ? "trialing" : "active", entitlementSource: source,
    trialStartedAt: current, trialEndsAt: new Date(quote.periodEnd), currentPeriodStart: current, currentPeriodEnd: new Date(quote.periodEnd), commercialQuote: quote,
    ...(source === "manual" ? { manualGrantedBy: f.root.user.id, manualGrantedAt: current, manualGrantReason: "Synthetic reviewed manual grant" } : {}) });
  return { subscription, quote };
}

beforeAll(async () => { await app.ready(); });
describe("Configured location-product arithmetic", () => {
  it.each([[false, true, 0, 49900], [true, false, 1, 79900], [true, true, 1, 109800], [true, true, 2, 139700]] as const)("quotes clinic=%s pharmacy=%s doctors=%s at %s paise", (clinic, pharmacy, doctors, total) => {
    const quote = calculate(clinic, pharmacy, doctors); expect(quote.totalPaise).toBe(total);
    expect(quote.entitlements.maxLocations).toBe(1); expect(quote.entitlements.maxDoctors).toBe(clinic ? Math.max(1, doctors) : doctors);
  });
  it("adds a second clinic once while doctor inclusion remains explicitly configured", () => {
    const plan = planInput(), selection = { priceRevision: 1, billingCycle: "monthly" as const, doctorSeats: 1, locations: [selected(true, false), selected(true, false, second)] };
    const quote = calculateCommercialQuote(orgId, plan, selection, now);
    expect(quote.totalPaise).toBe(159800); expect(quote.entitlements).toMatchObject({ maxDoctors: 1, maxLocations: 2 });
    plan.commercialPricing.doctorsPerAdditionalClinic = 1;
    expect(calculateCommercialQuote(orgId, plan, selection, now).entitlements.maxDoctors).toBe(2);
  });
  it("rejects duplicate physical locations, including case variants", () => {
    expect(() => calculateCommercialQuote(orgId, planInput(), { priceRevision: 1, billingCycle: "monthly", doctorSeats: 1,
      locations: [selected(true, false), selected(false, true, first.toUpperCase())] }, now)).toThrow(/once/);
  });
  it("rejects unsupported annual and additional-pharmacy prices instead of inventing them", () => {
    const base = { priceRevision: 1, doctorSeats: 0, locations: [selected(false, true)] };
    expect(() => calculateCommercialQuote(orgId, planInput(), { ...base, billingCycle: "annual" }, now)).toThrow(/Annual/);
    for (const locations of [[selected(false, true), selected(false, true, second)], [selected(true, true), selected(false, true, second)]]) {
      expect(() => calculateCommercialQuote(orgId, planInput(), { ...base, billingCycle: "monthly", locations }, now)).toThrow(/Additional standalone/);
    }
  });
  it("uses an explicitly configured additional-pharmacy price", () => {
    const plan = planInput(); plan.commercialPricing.monthly.additionalPharmacyPaise = 69900;
    const quote = calculateCommercialQuote(orgId, plan, { priceRevision: 1, doctorSeats: 0, billingCycle: "monthly", locations: [selected(false, true), selected(false, true, second)] }, now);
    expect(quote.totalPaise).toBe(119800);
  });
  it("uses explicit annual rates and clamps effective periods at month/year ends", () => {
    const plan = planInput(); plan.commercialPricing.annual = { ...plan.commercialPricing.monthly, pharmacyPaise: 500000 };
    expect(calculate(false, true, 0).periodEnd).toBe("2027-02-28T10:15:00.000Z");
    const quote = calculateCommercialQuote(orgId, plan, { priceRevision: 1, billingCycle: "annual", doctorSeats: 0, locations: [selected(false, true)] }, new Date("2028-02-29T00:00:00Z"));
    expect(quote.totalPaise).toBe(500000); expect(quote.periodEnd).toBe("2029-02-28T00:00:00.000Z");
  });
  it("calculates inclusive and exclusive tax in exact paise", () => {
    const plan = planInput(); plan.commercialPricing.monthly.pharmacyPaise = 10000; plan.commercialPricing.taxRateBps = 1800;
    expect(calculate(false, true, 0, plan)).toMatchObject({ subtotalPaise: 8475, taxPaise: 1525, totalPaise: 10000 });
    plan.commercialPricing.taxMode = "exclusive";
    expect(calculate(false, true, 0, plan)).toMatchObject({ subtotalPaise: 10000, taxPaise: 1800, totalPaise: 11800 });
    plan.commercialPricing.taxMode = "inclusive"; plan.commercialPricing.monthly.pharmacyPaise = 4;
    expect(calculate(false, true, 0, plan)).toMatchObject({ subtotalPaise: 3, taxPaise: 1, totalPaise: 4 });
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER, NaN])("rejects unsafe requested doctor capacity %s", doctors => {
    expect(() => calculate(false, true, doctors)).toThrow();
  });
  it("rejects stale prices, zero resource capacity and excessive monetary totals", () => {
    const plan = planInput(); plan.commercialPricing.revision = 2;
    expect(() => calculateCommercialQuote(orgId, plan, { priceRevision: 1, billingCycle: "monthly", doctorSeats: 0, locations: [selected(false, true)] }, now)).toThrow(/prices changed/);
    plan.limits.maxLocations = 0; expect(() => calculate(false, true, 0, plan)).toThrow(/capacity/);
    plan.limits.maxLocations = 5; plan.commercialPricing.monthly.extraDoctorPaise = 100_000_000_000;
    expect(() => calculate(false, true, 2, plan)).toThrow(/Quote amount/);
  });
  it("normalizes selection order and binds location capability revisions into the fingerprint", () => {
    const input = { priceRevision: 1, billingCycle: "monthly" as const, doctorSeats: 1, locations: [selected(true, false), selected(true, false, second)] };
    const firstQuote = calculateCommercialQuote(orgId, planInput(), input, now);
    expect(calculateCommercialQuote(orgId, planInput(), { ...input, locations: [...input.locations].reverse() }, now).fingerprint).toBe(firstQuote.fingerprint);
    input.locations[0].capabilityRevision = 1;
    expect(calculateCommercialQuote(orgId, planInput(), input, now).fingerprint).not.toBe(firstQuote.fingerprint);
  });
});

describe("Commercial API and compatibility boundaries", () => {
  it("quotes an existing physical branch without changing subscription, modules or location capability", async () => {
    const f = await fixture(), response = await postQuote(f);
    expect(response.statusCode, response.body).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json().data).toMatchObject({ totalPaise: 49900, legacyTier: "starter", purchaseAvailable: true, entitlements: { maxLocations: 1, maxDoctors: 0 } });
    expect(response.json().data.quoteToken).toMatch(/^enc:v1:/);
    expect((await Location.findById(f.location.id))!.pharmacyCapability).toMatchObject({ enabled: false, revision: 2 });
    expect((await Organization.findById(f.organization.id))!.plan).toBe("starter");
    expect(await Subscription.countDocuments({ organizationId: f.organization.id })).toBe(0); expect(await ModuleRegistry.countDocuments({ organizationId: f.organization.id })).toBe(0);
    expect(await SubscriptionPayment.countDocuments({ organizationId: f.organization.id })).toBe(0);
  });
  it("adds pharmacy to a clinic as an add-on on the same ID", async () => {
    const f = await fixture();
    const response = await postQuote(f, { ...f.input, doctorSeats: 2, locations: [{ locationId: f.location.id, clinic: true, pharmacy: true }] });
    expect(response.statusCode, response.body).toBe(200); expect(response.json().data.totalPaise).toBe(139700);
    expect(response.json().data.lines.map((line: { kind: string }) => line.kind)).toEqual(["clinic", "pharmacy_addon", "extra_doctor"]);
  });
  it("requires the current permission, branch and tenant authority", async () => {
    const f = await fixture(), foreign = await fixture();
    const denied = await principal("pharmacist", f.organization.id, [f.location.id]);
    expect((await postQuote(f, f.input, denied.headers)).statusCode).toBe(403);
    expect((await postQuote(f, { ...f.input, locations: [{ locationId: foreign.location.id, clinic: true, pharmacy: false }] })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/billing/quote?organizationId=${foreign.organization.id}`, headers: f.admin.headers, payload: f.input })).statusCode).toBe(403);
    expect((await postQuote(f, { ...f.input, organizationId: foreign.organization.id })).statusCode).toBe(403);
    const role = await Role.create({ name: "scoped_commerce", organizationId: f.organization.id, permissions: ["MANAGE_ORGANIZATION"] });
    const scoped = await principal(role.name, f.organization.id, []);
    expect((await postQuote(f, f.input, scoped.headers)).statusCode).toBe(404);
  });
  it.each(["patient", "family_member", "guest"])("denies a %s commercial quote even with an explicit organization-management grant", async role => {
    const f = await fixture(); await Role.create({ name: role, organizationId: f.organization.id, permissions: ["MANAGE_ORGANIZATION"] });
    const consumer = await principal(role, f.organization.id);
    expect((await postQuote(f, f.input, consumer.headers)).statusCode).toBe(403);
  });
  it("rejects invalid/stale selections and an active footprint larger than the quoted products", async () => {
    const f = await fixture();
    expect((await postQuote(f, { ...f.input, priceRevision: 99 })).statusCode).toBe(409);
    const untrusted = await postQuote(f, { ...f.input, totalPaise: 1 });
    expect(untrusted.statusCode, untrusted.body).toBe(200); expect(untrusted.json().data.totalPaise).toBe(49900);
    await Location.create({ organizationId: f.organization.id, name: "Second physical branch", city: "Pune" });
    expect((await postQuote(f)).statusCode).toBe(409);
  });
  it("separates location-product catalogues from legacy flat-price plan lists", async () => {
    const f = await fixture();
    const legacy = await app.inject({ method: "GET", url: "/api/billing/plans" });
    expect(legacy.json().data.every((plan: { commercialFamily?: string }) => !plan.commercialFamily)).toBe(true);
    const products = await app.inject({ method: "GET", url: "/api/billing/plans?kind=location_products" });
    expect(products.json().data.some((plan: { id: string }) => plan.id === f.plan.id)).toBe(true);
  });
  it("keeps an explicitly mapped compatibility tier separate from a commercial catalogue slug", async () => {
    const f = await fixture();
    const plan = await SaaSPlan.create({ name: "Compatible flat plan", slug: `flat_${crypto.randomUUID()}`, legacyTier: "professional", description: "Synthetic compatibility mapping", monthlyPrice: 0, annualPrice: 0,
      limits: { maxLocations: 5, maxDoctors: 0, maxStaff: 10 } });
    await subscriptionService.directSwitchPlan(f.organization.id, plan.id);
    expect((await Organization.findById(f.organization.id))!.plan).toBe("professional");
    expect((await Organization.findById(f.organization.id))!.maxDoctors).toBe(0);
  });
  it("rejects a zero-doctor quote when active legacy doctor profiles still consume capacity", async () => {
    const f = await fixture();
    const doctor = await principal("doctor", f.organization.id, [f.location.id]);
    await Doctor.create({ organizationId: f.organization.id, userId: doctor.user.id });
    expect((await postQuote(f)).statusCode).toBe(409);
    const clinic = await postQuote(f, { ...f.input, locations: [{ locationId: f.location.id, clinic: true, pharmacy: false }] });
    expect(clinic.statusCode, clinic.body).toBe(200); expect(clinic.json().data.entitlements.maxDoctors).toBe(1);
  });
  it("does not let flat-plan checkout, free switching or manual activation bypass product selection", async () => {
    const f = await fixture(), order = vi.spyOn(razorpayService, "createOrder");
    try {
      await expect(subscriptionService.createCheckoutOrder(f.organization.id, f.plan.id, "monthly")).rejects.toThrow(/location-product quote/);
      await expect(subscriptionService.directSwitchPlan(f.organization.id, f.plan.id)).rejects.toThrow(/location-product quote/);
      const { subscription } = await snapshotSubscription(f);
      const response = await app.inject({ method: "POST", url: `/api/admin/billing/subscriptions/${subscription.id}/activate`, headers: f.root.headers,
        payload: { planSlug: f.plan.slug, reason: "Synthetic manual grant attempt" } });
      expect(response.statusCode, response.body).toBe(409); expect(order).not.toHaveBeenCalled();
    } finally { order.mockRestore(); }
  });
  it("validates catalogue configuration and rejects stale revisions or legacy-plan conversion", async () => {
    const f = await fixture();
    const save = (payload: object) => app.inject({ method: "POST", url: "/api/admin/billing/plans", headers: f.root.headers, payload });
    expect((await save({ name: f.plan.name, slug: f.plan.slug, commercialFamily: null })).statusCode).toBe(409);
    expect((await save({ name: f.plan.name, slug: f.plan.slug, commercialPricing: { ...pricing(), monthly: { ...pricing().monthly, pharmacyPaise: 1 } } })).statusCode).toBe(409);
    const response = await save({ name: f.plan.name, slug: f.plan.slug, commercialPricing: { ...pricing(), revision: 2 } });
    expect(response.statusCode, response.body).toBe(200);
    expect((await save({ name: f.plan.name, slug: f.plan.slug, limits: { maxDoctors: 0 } })).statusCode).toBe(409);
    const capacity = await save({ name: f.plan.name, slug: f.plan.slug, limits: { maxDoctors: 0 }, commercialPricing: { ...pricing(), revision: 3 } });
    expect(capacity.statusCode, capacity.body).toBe(200); expect(capacity.json().data.limits).toMatchObject({ maxDoctors: 0, maxLocations: 5, maxStaff: 5 });
    expect((await save({ name: f.plan.name, slug: f.plan.slug, commercialPricing: pricing() })).statusCode).toBe(409);
    const legacy = await SaaSPlan.create({ name: "Legacy", slug: crypto.randomUUID(), description: "Old tier", monthlyPrice: 0, annualPrice: 0 });
    expect((await save({ name: legacy.name, slug: legacy.slug, commercialFamily: "location_products", legacyTier: "starter", commercialPricing: pricing() })).statusCode).toBe(409);
  });
});

describe("Snapshot entitlement evaluation", () => {
  it("requires a selection for product plans and preserves standard-plan inclusion without backfilling grants", async () => {
    const f = await fixture();
    const { subscription } = await snapshotSubscription(f, "trial"); await Subscription.updateOne({ _id: subscription.id }, { $unset: { commercialQuote: 1 } });
    expect(await getOrganizationProductEntitlements(f.organization.id)).toMatchObject({ mode: "review_required", enforcement: true, active: false });
    const standard = await SaaSPlan.create({ name: "Standard clinic", slug: crypto.randomUUID(), description: "Current bundled module contract", monthlyPrice: 0, annualPrice: 0 });
    await Subscription.updateOne({ _id: subscription.id }, { planId: standard.id });
    expect(await getOrganizationProductEntitlements(f.organization.id)).toMatchObject({ mode: "legacy_included", enforcement: false, active: true, limits: { maxDoctors: 0 }, pharmacyLocationIds: [] });
    expect((await Subscription.findById(subscription.id))!.commercialQuote).toBeUndefined();
  });
  it("uses reviewed stored capacity instead of mutable catalogue prices and expires it at the exact period boundary", async () => {
    const f = await fixture(), { quote } = await snapshotSubscription(f);
    await SaaSPlan.updateOne({ _id: f.plan.id }, { $set: { "limits.maxDoctors": 999, "commercialPricing.monthly.pharmacyPaise": 999999 } });
    expect(await getOrganizationProductEntitlements(f.organization.id)).toMatchObject({ mode: "configured", active: true, limits: { maxDoctors: 0 }, pharmacyLocationIds: [f.location.id] });
    expect(await getOrganizationProductEntitlements(f.organization.id, new Date(quote.periodEnd))).toMatchObject({ mode: "configured", active: false, pharmacyLocationIds: [] });
  });
  it("requires an exact captured-payment snapshot for paid grants", async () => {
    const f = await fixture(), { subscription, quote } = await snapshotSubscription(f, "paid");
    expect((await getOrganizationProductEntitlements(f.organization.id)).mode).toBe("review_required");
    await SubscriptionPayment.create({ organizationId: f.organization.id, subscriptionId: subscription.id, planId: f.plan.id,
      razorpayOrderId: `order_${crypto.randomUUID()}`, amount: quote.totalPaise / 100, currency: "INR", status: "captured", paidAt: new Date(), commercialQuote: quote });
    expect((await getOrganizationProductEntitlements(f.organization.id)).active).toBe(true);
    await SubscriptionPayment.updateOne({ subscriptionId: subscription.id }, { $set: { status: "captured_review" } });
    expect((await getOrganizationProductEntitlements(f.organization.id)).mode).toBe("review_required");
  });
  it("fails closed for corrupt, foreign or ambiguous stored selections", async () => {
    const f = await fixture(), { subscription } = await snapshotSubscription(f);
    await Subscription.collection.updateOne({ _id: subscription._id }, { $set: { "commercialQuote.totalPaise": 1 } });
    expect((await getOrganizationProductEntitlements(f.organization.id)).mode).toBe("review_required");
    await Subscription.updateOne({ _id: subscription.id }, { $unset: { commercialQuote: 1 } });
    await snapshotSubscription(f); expect((await getOrganizationProductEntitlements(f.organization.id)).mode).toBe("review_required");
  });
  it("round-trips a complete quote snapshot through existing payment and invoice documents", async () => {
    const f = await fixture(), { subscription, quote } = await snapshotSubscription(f);
    const payment = await SubscriptionPayment.create({ organizationId: f.organization.id, subscriptionId: subscription.id, planId: f.plan.id, razorpayOrderId: `order_${crypto.randomUUID()}`,
      amount: quote.totalPaise / 100, commercialQuote: quote });
    const invoice = await SaaSInvoice.create({ invoiceNumber: crypto.randomUUID(), organizationId: f.organization.id, subscriptionId: subscription.id, paymentId: payment.id,
      planName: f.plan.name, subtotal: quote.subtotalPaise / 100, taxAmount: quote.taxPaise / 100, totalAmount: quote.totalPaise / 100, billingDetails: { orgName: f.organization.name }, commercialQuote: quote });
    for (const document of [subscription, payment, invoice]) {
      const stored = document.toObject().commercialQuote as unknown as CommercialQuote;
      const { fingerprint, ...body } = stored;
      expect(quoteFingerprint(body)).toBe(fingerprint); expect(stored).toEqual(quote);
    }
  });
});

describe("Explicit zero doctor quotas", () => {
  const addDoctor = (f: Fixture) => app.inject({ method: "POST", url: "/api/onboarding/doctor", headers: f.admin.headers,
    payload: { name: "Synthetic doctor", email: `${crypto.randomUUID()}@example.test`, password: "SyntheticPassword42!", specialization: "General Physician" } });
  it("blocks zero-doctor creation through both generic staff and doctor-profile routes", async () => {
    const f = await fixture();
    expect((await addDoctor(f)).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/onboarding/staff", headers: f.admin.headers,
      payload: { name: "Synthetic doctor", email: `${crypto.randomUUID()}@example.test`, password: "SyntheticPassword42!", role: "doctor" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/onboarding/admin/enable-doctor-profile", headers: f.admin.headers, payload: { specialization: "General Physician" } })).statusCode).toBe(403);
    expect(await Doctor.countDocuments({ organizationId: f.organization.id })).toBe(0);
  });
  it("rejects accepting a doctor invitation with zero seats and keeps it pending", async () => {
    const f = await fixture(), token = crypto.randomBytes(32).toString("hex");
    const invite = await OrgInvite.create({ organizationId: f.organization.id, email: `${crypto.randomUUID()}@example.test`, role: "doctor",
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 3600000), invitedBy: f.admin.user.id });
    const response = await app.inject({ method: "POST", url: "/api/auth/accept-invitation", payload: { token, name: "Invited doctor", password: "SyntheticPassword42!" } });
    expect(response.statusCode, response.body).toBe(403); expect((await OrgInvite.findById(invite.id))!.status).toBe("pending");
    expect(await User.countDocuments({ email: invite.email })).toBe(0);
  });
  it("serializes concurrent doctor creation at the last available seat", async () => {
    const f = await fixture(); await Organization.updateOne({ _id: f.organization.id }, { $set: { maxDoctors: 1 } });
    const results = await Promise.all([addDoctor(f), addDoctor(f)]);
    expect(results.map(result => result.statusCode).sort()).toEqual([201, 403]);
    expect(await Doctor.countDocuments({ organizationId: f.organization.id })).toBe(1);
  });
  it("honors zero location and staff limits instead of substituting defaults", async () => {
    const f = await fixture(); await Organization.updateOne({ _id: f.organization.id }, { $set: { maxLocations: 0, maxStaff: 0 } });
    await Location.updateOne({ _id: f.location.id }, { $set: { isActive: false } });
    expect((await app.inject({ method: "POST", url: "/api/onboarding/locations", headers: f.admin.headers, payload: { name: "Forbidden branch", city: "Pune" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/onboarding/staff", headers: f.admin.headers,
      payload: { name: "Forbidden staff", email: `${crypto.randomUUID()}@example.test`, password: "SyntheticPassword42!", role: "pharmacist" } })).statusCode).toBe(403);
  });
});
