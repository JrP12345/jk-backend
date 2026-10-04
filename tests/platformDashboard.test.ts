import { beforeAll, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { app } from "../index.ts";
import { Organization } from "../models/Organization.ts";
import { User } from "../models/User.ts";
import { Role } from "../models/Role.ts";
import { Doctor } from "../models/Doctor.ts";
import { SaaSPlan } from "../models/SaaSPlan.ts";
import { Subscription } from "../models/Subscription.ts";
import { SubscriptionPayment } from "../models/SubscriptionPayment.ts";
import { Appointment } from "../models/Appointment.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { generateAccessToken } from "../utilities/helpers.ts";
import { dashboardPeriod, loadPlatformDashboard } from "../services/platformDashboard.ts";

const now = new Date("2026-10-15T12:00:00Z");
const objectId = () => new mongoose.Types.ObjectId();
let rootCookie: string, adminCookie: string, impersonatedCookie: string;
let paidId: string;

beforeAll(async () => {
  await Role.create({ name: "admin", permissions: ["MANAGE_ORGANIZATION"] });
  const root = await User.create({ name: "Owner", email: "owner@dashboard.test", role: "root" });
  const admin = await User.create({ name: "Clinic Admin", email: "admin@dashboard.test", role: "admin" });
  const cookie = (user: typeof root, role: string, organization_id?: string, impersonatedBy?: { id: string; email: string; name: string; originalRole: string }) => `access_token=${generateAccessToken({ id: user.id, email: user.email || "", role, organization_id, impersonatedBy })}`;
  rootCookie = cookie(root, "root");
  const paidPlan = await SaaSPlan.create({ name: "Paid plan", slug: "dashboard_paid", description: "Paid", monthlyPrice: 1000, annualPrice: 10000 });
  const freePlan = await SaaSPlan.create({ name: "Free plan", slug: "dashboard_free", description: "Free", monthlyPrice: 0, annualPrice: 0 });
  const specs = [
    ["Paid", "active", "paid", "2026-10-20", false],
    ["Trial", "trialing", "trial", "2026-10-18", false],
    ["Expired", "active", "paid", "2026-10-10", false],
    ["Inactive", "active", "paid", "2026-12-01", true],
    ["Manual", "active", "manual", "2026-12-01", false],
    ["Free", "active", "free", "2026-12-01", false],
    ["Missing", null, null, null, false],
  ] as const;
  let paymentSequence = 0;
  for (const [name, status, source, end, inactive] of specs) {
    const org = await Organization.create({ name, city: "Surat", isActive: !inactive, isOnboarded: true, onboardingStatus: "COMPLETED", createdAt: new Date("2026-09-01") });
    if (name === "Paid") paidId = org.id;
    if (!status) continue;
    const sub = await Subscription.create({ organizationId: org._id, planId: name === "Free" ? freePlan._id : paidPlan._id, status, entitlementSource: source, trialStartedAt: new Date("2026-10-01"), trialEndsAt: new Date(end!), currentPeriodStart: new Date("2026-10-01"), currentPeriodEnd: new Date(end!) });
    if (name === "Trial") await Subscription.create({ organizationId: org._id, planId: paidPlan._id, status: "expired", createdAt: new Date("2026-06-01"), trialEndsAt: new Date("2026-06-15"), currentPeriodEnd: new Date("2026-06-15") });
    if (name !== "Paid") continue;
    const payment = (amount: number, state: "captured" | "refunded" | "captured_review" | "failed" | "created", paidAt: Date | null, currency = "INR") => SubscriptionPayment.create({ organizationId: org._id, subscriptionId: sub._id, planId: paidPlan._id, razorpayOrderId: `dashboard_order_${paymentSequence++}`, amount, currency, status: state, paidAt });
    await payment(1180, "captured", new Date("2026-10-02T10:00:00Z"));
    await payment(590, "captured", new Date("2026-09-15T11:59:00Z"));
    await payment(590, "captured", new Date("2026-09-15T12:01:00Z"));
    await payment(5000, "refunded", new Date("2026-10-03"));
    await payment(3000, "captured_review", new Date("2026-10-04"));
    await payment(2000, "failed", null);
    await payment(1000, "created", null);
    await payment(10, "captured", new Date("2026-10-05"), "USD");
    await payment(7000, "captured", null);
    const patient = objectId();
    const base = { organizationId: org._id, clinicId: objectId(), doctorId: objectId(), patientId: patient, appointmentType: "online", tokenNumber: 1, appointmentTime: new Date("2026-10-11T09:00:00Z") };
    // Isolated database fixtures avoid unrelated booking/payment providers.
    await Appointment.collection.insertMany([
      { ...base, createdAt: new Date("2026-10-02"), status: "confirmed" },
      { ...base, createdAt: new Date("2026-10-03"), status: "confirmed" },
      { ...base, createdAt: new Date("2026-10-14"), status: "cancelled" },
      { ...base, createdAt: new Date("2026-10-14"), status: "pending_payment" },
      { ...base, createdAt: new Date("2026-09-15T11:59:00Z"), status: "confirmed" },
      { ...base, createdAt: new Date("2026-09-15T12:01:00Z"), status: "confirmed" },
      { ...base, createdAt: new Date("2026-08-01"), status: "completed" },
      { ...base, organizationId: objectId(), createdAt: new Date("2026-10-02"), status: "completed", reason: "clinical secret" },
    ]);
    const doctorUser = await User.create({ name: "Configured doctor", email: "doctor@dashboard.test", role: "doctor" });
    const disabledUser = await User.create({ name: "Disabled doctor", email: "disabled@dashboard.test", role: "doctor", isActive: false });
    await Doctor.create([{ userId: doctorUser._id, organizationId: org._id, isActive: true }, { userId: disabledUser._id, organizationId: org._id, isActive: true }]);
    await AuditLog.create({ organizationId: org._id, category: "ADMIN", action: "ORGANIZATION_UPDATED", createdAt: new Date("2026-10-14"), details: { password: "private-secret", patientName: "Patient secret" } });
    await AuditLog.create({ organizationId: org._id, category: "CLINICAL_WRITE", action: "PATIENT_UPDATE", createdAt: new Date("2026-10-15"), details: { diagnosis: "clinical secret" } });
  }
  adminCookie = cookie(admin, "admin", paidId);
  impersonatedCookie = cookie(admin, "admin", paidId, { id: root.id, email: root.email || "", name: root.name, originalRole: "root" });
});

describe("Platform owner aggregates", () => {
  it("counts actual captured collections separately per currency with an elapsed-period comparison", async () => {
    const data = await loadPlatformDashboard("30D", now);
    expect(data.money.currencies).toEqual([{ currency: "INR", month: 1180, previous: 590 }, { currency: "USD", month: 10, previous: 0 }]);
    expect(data.money.undatedCaptures).toBe(1);
    expect(data.trend.find(day => day.date === "2026-10-02")?.collections).toEqual({ INR: 1180 });
    expect(data.attention.find(issue => issue.key === "reviews")?.count).toBe(1);
  });
  it("uses real expiry and payment proof rather than treating every active entitlement as paid", async () => {
    const data = await loadPlatformDashboard("30D", now);
    expect(data.organizations).toMatchObject({ total: 7, active: 3, trial: 1, expired: 1, inactive: 1, unavailable: 1, paid: 1, expiringSoon: 2 });
    expect(data.attention.find(issue => issue.key === "trials")?.count).toBe(1);
    expect(data.attention.find(issue => issue.key === "renewals")?.count).toBe(1);
    expect(data.attention.some(issue => issue.key === "setup")).toBe(false);
  });
  it("counts created bookings, distinct patients, scheduled completed visits and enabled doctor identities", async () => {
    const data = await loadPlatformDashboard("7D", now);
    expect(data.usage).toEqual({ bookingsThisMonth: 3, previousBookings: 1, completedVisitsThisMonth: 1, patientsBookedThisMonth: 1, enabledDoctors: 1 });
    expect(data.organizations.usingThisMonth).toBe(1);
    expect(data.trend).toHaveLength(7);
    expect(data.trend.reduce((sum, day) => sum + day.bookings, 0)).toBe(1);
    expect(data.organizationActivity.mostActive[0]).toMatchObject({ id: paidId, bookingsThisMonth: 3, doctors: 1, collectionsThisMonth: { INR: 1180, USD: 10 } });
    expect(data.organizationActivity.leastActive[0].bookingsThisMonth).toBe(0);
    expect(data.attention.find(issue => issue.key === "usage")?.count).toBe(5);
  });
  it("returns bounded factual events with no patient records, credentials, or raw audit details", async () => {
    const data = await loadPlatformDashboard("90D", now);
    expect(data.recentActivity.length).toBeLessThanOrEqual(8);
    expect(data.organizationActivity.mostActive).toHaveLength(6);
    expect(data.recentActivity.some(event => event.kind === "payment")).toBe(true);
    const payload = JSON.stringify(data);
    for (const forbidden of ["private-secret", "Patient secret", "clinical secret", "PATIENT_UPDATE", "razorpayOrderId", "patientId", "details", "email"]) expect(payload).not.toContain(forbidden);
    expect(data.trend).toHaveLength(90);
  });
  it("handles zero data without inventing payments or percentages", async () => {
    const data = await loadPlatformDashboard("7D", new Date("2020-01-03T10:00:00Z"));
    expect(data.money.currencies).toEqual([{ currency: "INR", month: 0, previous: 0 }]);
    expect(data.usage.bookingsThisMonth).toBe(0);
    expect(data.trend.every(day => !day.bookings && !Object.keys(day.collections).length)).toBe(true);
    expect(data.recentActivity).toEqual([]);
  });
  it("caps short previous months and handles January and leap years", () => {
    expect(dashboardPeriod("30D", new Date("2026-03-31T12:00:00Z")).previousEnd.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(dashboardPeriod("7D", new Date("2024-03-29T12:00:00Z")).previousEnd.toISOString()).toBe("2024-02-29T12:00:00.000Z");
    expect(dashboardPeriod("7D", new Date("2026-01-01T12:00:00Z")).previousStart.toISOString()).toBe("2025-12-01T00:00:00.000Z");
  });
});

describe("Platform overview authorization", () => {
  it("allows the platform owner, validates ranges and marks the response private", async () => {
    const result = await app.inject({ method: "GET", url: "/api/admin/dashboard?range=7D", headers: { cookie: rootCookie } });
    expect(result.statusCode).toBe(200);
    expect(result.headers["cache-control"]).toBe("private, no-store");
    expect(result.json().data.range).toBe("7D");
    expect((await app.inject({ method: "GET", url: "/api/admin/dashboard?range=1Y", headers: { cookie: rootCookie } })).statusCode).toBe(400);
  });
  it("rejects anonymous, tenant admins, and impersonated sessions", async () => {
    const request = (cookie?: string) => app.inject({ method: "GET", url: "/api/admin/dashboard", headers: cookie ? { cookie } : {} });
    expect((await request()).statusCode).toBe(401);
    expect((await request(adminCookie)).statusCode).toBe(403);
    expect((await request(impersonatedCookie)).statusCode).toBe(403);
  });
  it("returns a useful zero state when the platform has no organizations or payments", async () => {
    // Only the isolated MongoMemoryServer used by this test file is affected.
    await Promise.all([Organization.deleteMany({}), SubscriptionPayment.deleteMany({}), AuditLog.deleteMany({})]);
    const data = await loadPlatformDashboard("30D", now);
    expect(data.organizations.total).toBe(0);
    expect(data.attention).toEqual([]);
    expect(data.organizationActivity.mostActive).toEqual([]);
    expect(data.money.currencies).toEqual([{ currency: "INR", month: 0, previous: 0 }]);
    expect(data.recentActivity).toEqual([]);
    expect(data.usage).toEqual({ bookingsThisMonth: 0, previousBookings: 0, completedVisitsThisMonth: 0, patientsBookedThisMonth: 0, enabledDoctors: 0 });
  });
});
