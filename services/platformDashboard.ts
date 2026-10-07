import { Organization } from "../models/Organization.ts";
import { Subscription } from "../models/Subscription.ts";
import { SubscriptionPayment } from "../models/SubscriptionPayment.ts";
import { SaaSPlan } from "../models/SaaSPlan.ts";
import { Appointment } from "../models/Appointment.ts";
import { Doctor } from "../models/Doctor.ts";
import { User } from "../models/User.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { summarizeSubscription } from "./billing/subscriptionSummary.ts";

const DAY = 86400000;
export type DashboardRange = "7D" | "30D" | "90D";

/** Every boundary and chart bucket uses UTC, including the comparison month. */
export function dashboardPeriod(range: DashboardRange, now: Date) {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const previousStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastPreviousDay = new Date(monthStart.getTime() - DAY).getUTCDate();
  const previousEnd = now.getUTCDate() > lastPreviousDay ? monthStart : new Date(Date.UTC(
    previousStart.getUTCFullYear(), previousStart.getUTCMonth(), now.getUTCDate(),
    now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(), now.getUTCMilliseconds(),
  ));
  const days = Number(range.slice(0, -1));
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { monthStart, previousStart, previousEnd, rangeStart: new Date(today.getTime() - (days - 1) * DAY), now };
}

const inside = (date: string, start: Date, end: Date) => new Date(date) >= start && new Date(date) <= end;
const iso = (date: Date | string | null | undefined) => date ? new Date(date).toISOString() : null;

export async function loadPlatformDashboard(range: DashboardRange, now = new Date()) {
  const period = dashboardPeriod(range, now);
  const inactivityStart = new Date(now.getTime() - 30 * DAY);
  const scanStart = new Date(Math.min(period.previousStart.getTime(), period.rangeStart.getTime(), inactivityStart.getTime()));
  const organizations = await Organization.find({}).select("name city plan status isActive isOnboarded onboardingStatus createdAt").lean();
  const organizationIds = organizations.map(org => org._id);
  const organizationMatch = { organizationId: { $in: organizationIds } };
  const [subscriptions, plans, payments, paymentProof, reviewCount, undatedCaptures, bookings, visits, doctors, audit, comparison, recentPayments] = await Promise.all([
    Subscription.aggregate([
      { $match: organizationMatch },
      { $sort: { createdAt: -1, _id: -1 } },
      { $group: { _id: "$organizationId", subscription: { $first: "$$ROOT" } } },
      { $replaceRoot: { newRoot: "$subscription" } },
      { $project: { organizationId: 1, planId: 1, status: 1, billingCycle: 1, entitlementSource: 1, trialStartedAt: 1, trialEndsAt: 1, currentPeriodStart: 1, currentPeriodEnd: 1, cancelledAt: 1 } },
    ]),
    SaaSPlan.find({}).select("name slug monthlyPrice annualPrice").lean(),
    // SubscriptionPayment.amount is stored in major currency units, including tax.
    // Never combine currencies or use location Invoice/AppointmentPayment amounts here.
    SubscriptionPayment.aggregate([
      { $match: { status: "captured", paidAt: { $gte: scanStart, $lte: now } } },
      { $group: { _id: { date: { $dateToString: { date: "$paidAt", format: "%Y-%m-%d", timezone: "UTC" } }, currency: { $ifNull: ["$currency", "INR"] }, organizationId: "$organizationId" }, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
    SubscriptionPayment.aggregate([
      { $match: { ...organizationMatch, status: "captured" } },
      { $group: { _id: "$subscriptionId" } },
    ]),
    SubscriptionPayment.countDocuments({ status: "captured_review" }),
    SubscriptionPayment.countDocuments({ status: "captured", paidAt: null }),
    Appointment.aggregate([
      { $match: { ...organizationMatch, status: { $ne: "pending_payment" }, createdAt: { $gte: scanStart, $lte: now } } },
      { $facet: {
        daily: [{ $group: { _id: { $dateToString: { date: "$createdAt", format: "%Y-%m-%d", timezone: "UTC" } }, count: { $sum: 1 } } }],
        organizations: [{ $group: {
          _id: "$organizationId",
          month: { $sum: { $cond: [{ $gte: ["$createdAt", period.monthStart] }, 1, 0] } },
          last30Days: { $sum: { $cond: [{ $gte: ["$createdAt", inactivityStart] }, 1, 0] } },
        } }],
        patients: [{ $match: { createdAt: { $gte: period.monthStart }, patientId: { $ne: null } } }, { $group: { _id: "$patientId" } }, { $count: "count" }],
        previous: [{ $match: { createdAt: { $gte: period.previousStart, $lt: period.previousEnd } } }, { $count: "count" }],
      } },
    ]),
    // Completion timestamps are not recorded consistently. Count completed visits
    // by scheduled date, and label them accordingly instead of claiming throughput.
    Appointment.countDocuments({ ...organizationMatch, status: "completed", appointmentTime: { $gte: period.monthStart, $lte: now } }),
    Doctor.aggregate([
      { $match: { ...organizationMatch, isActive: true } },
      { $lookup: { from: User.collection.name, localField: "userId", foreignField: "_id", as: "identity" } },
      { $match: { "identity.0": { $exists: true }, "identity.isActive": { $ne: false } } },
      { $group: { _id: "$organizationId", count: { $sum: 1 } } },
    ]),
    // The dashboard never returns audit details, actor identities or clinical events.
    AuditLog.find({ category: { $in: ["ADMIN", "BILLING"] }, createdAt: { $lte: now }, $or: [{ organizationId: { $in: organizationIds } }, { organizationId: null }] })
      .sort({ createdAt: -1 }).limit(8).select("action category organizationId createdAt").lean(),
    // Match comparison periods against exact timestamps, not midnight chart buckets.
    SubscriptionPayment.aggregate([
      { $match: { status: "captured", paidAt: { $gte: period.previousStart, $lte: now } } },
      { $group: {
        _id: { $ifNull: ["$currency", "INR"] },
        month: { $sum: { $cond: [{ $gte: ["$paidAt", period.monthStart] }, "$amount", 0] } },
        previous: { $sum: { $cond: [{ $and: [{ $lt: ["$paidAt", period.monthStart] }, { $lt: ["$paidAt", period.previousEnd] }] }, "$amount", 0] } },
      } },
    ]),
    SubscriptionPayment.find({ status: "captured", paidAt: { $ne: null, $lte: now } }).sort({ paidAt: -1 }).limit(6).select("organizationId paidAt").lean(),
  ]);

  const planMap = new Map(plans.map(plan => [String(plan._id), plan]));
  const subscriptionMap = new Map(subscriptions.map(sub => [String(sub.organizationId), sub]));
  const capturedSubscriptions = new Set(paymentProof.map(payment => String(payment._id)));
  const doctorMap = new Map(doctors.map(row => [String(row._id), row.count as number]));
  const bookingData = bookings[0] || { daily: [], organizations: [], patients: [] };
  const bookingMap = new Map<string, { month: number; last30Days: number }>(bookingData.organizations.map((row: { _id: unknown; month: number; last30Days: number }) => [String(row._id), row]));
  const dailyBookings = new Map<string, number>(bookingData.daily.map((row: { _id: string; count: number }) => [row._id, row.count]));
  const currencies = Array.from(new Set<string>(payments.map(payment => payment._id.currency))).sort();
  if (!currencies.length) currencies.push("INR");
  const dailyPayments = new Map<string, Record<string, number>>();
  const monthlyByOrganization = new Map<string, Record<string, number>>();
  for (const payment of payments) {
    const { date, currency, organizationId } = payment._id;
    const amounts = dailyPayments.get(date) || {};
    amounts[currency] = (amounts[currency] || 0) + payment.amount;
    dailyPayments.set(date, amounts);
    if (inside(date, period.monthStart, now)) {
      const key = String(organizationId);
      const totals = monthlyByOrganization.get(key) || {};
      totals[currency] = (totals[currency] || 0) + payment.amount;
      monthlyByOrganization.set(key, totals);
    }
  }
  const money = currencies.map(currency => {
    const totals = comparison.find(row => row._id === currency);
    return { currency, month: totals?.month || 0, previous: totals?.previous || 0 };
  });
  const health = { active: 0, trial: 0, expired: 0, inactive: 0, paymentIssue: 0, cancelled: 0, unavailable: 0, paid: 0, expiringSoon: 0 };
  const attention: { key: string; title: string; count: number; destination: "organizations" | "billing" }[] = [];
  const activity = audit.map(entry => ({ id: `audit-${entry._id}`, kind: "audit", title: String(entry.action).replaceAll("_", " ").toLowerCase(), organizationId: entry.organizationId ? String(entry.organizationId) : null, createdAt: iso(entry.createdAt)! }));
  for (const payment of recentPayments) activity.push({ id: `payment-${payment._id}`, kind: "payment", title: "Subscription payment captured", organizationId: String(payment.organizationId), createdAt: iso(payment.paidAt)! });
  let trialEnding = 0, renewalEnding = 0, missingDoctors = 0, incomplete = 0, lowUsage = 0;
  const rows = organizations.map(org => {
    const id = String(org._id);
    const sub = subscriptionMap.get(id);
    const summary = summarizeSubscription(org, sub ? { ...sub, planId: planMap.get(String(sub.planId)) || null } : null, sub ? capturedSubscriptions.has(String(sub._id)) : false, now);
    const state = summary.status === "disabled" ? "inactive" : summary.status === "expiring_soon" ? (summary.basis === "trial" ? "trial" : "active") : summary.status === "payment_pending" || summary.status === "payment_failed" ? "paymentIssue" : summary.status;
    if (state in health) health[state as keyof typeof health]++;
    if (summary.bookingAvailable && summary.basis === "paid" && sub && capturedSubscriptions.has(String(sub._id))) health.paid++;
    if (summary.status === "expiring_soon") {
      health.expiringSoon++;
      if (summary.basis === "trial") trialEnding++; else renewalEnding++;
    }
    const configuredDoctors = doctorMap.get(id) || 0;
    const usage = bookingMap.get(id) || { month: 0, last30Days: 0 };
    const enabled = org.isActive !== false && org.status !== "inactive";
    if (enabled && !configuredDoctors) missingDoctors++;
    if (enabled && !org.isOnboarded && org.onboardingStatus !== "COMPLETED") incomplete++;
    if (enabled && new Date(org.createdAt) <= inactivityStart && usage.last30Days === 0) lowUsage++;
    if (org.createdAt && org.createdAt <= now) activity.push({ id: `organization-${id}`, kind: "organization", title: "Organization created", organizationId: id, createdAt: iso(org.createdAt)! });
    return {
      id, name: org.name, city: org.city, createdAt: iso(org.createdAt),
      planName: summary.planName, status: summary.status, basis: summary.basis, expiresAt: iso(summary.expiresAt),
      doctors: configuredDoctors, bookingsThisMonth: usage.month, bookingsLast30Days: usage.last30Days,
      collectionsThisMonth: monthlyByOrganization.get(id) || {},
    };
  });
  const issues: [string, string, number, "organizations" | "billing"][] = [
    ["reviews", "Captured payments need review", reviewCount, "billing"],
    ["payment", "Organizations with payment issues", health.paymentIssue, "billing"],
    ["trials", "Trials end within 7 days", trialEnding, "billing"],
    ["renewals", "Plans end within 7 days", renewalEnding, "billing"],
    ["expired", "Expired subscriptions", health.expired, "billing"],
    ["unavailable", "Organizations without a subscription", health.unavailable, "organizations"],
    ["doctors", "Organizations without enabled doctors", missingDoctors, "organizations"],
    ["setup", "Organization setup incomplete", incomplete, "organizations"],
    ["usage", "No bookings in the last 30 days", lowUsage, "organizations"],
  ];
  for (const [key, title, count, destination] of issues) if (count) attention.push({ key, title, count, destination });
  const trend = [];
  for (let day = period.rangeStart.getTime(); day <= now.getTime(); day += DAY) {
    const date = new Date(day).toISOString().slice(0, 10);
    trend.push({ date, bookings: dailyBookings.get(date) || 0, collections: dailyPayments.get(date) || {}, organizations: rows.filter(org => org.createdAt?.slice(0, 10) === date).length });
  }
  const monthBookings = Array.from(bookingMap.values()).reduce((total, usage) => total + usage.month, 0);
  const previousBookings = bookingData.previous?.[0]?.count || 0;
  rows.sort((a, b) => b.bookingsThisMonth - a.bookingsThisMonth || a.name.localeCompare(b.name));
  return {
    generatedAt: now.toISOString(), range, timezone: "UTC",
    period: { monthStart: period.monthStart.toISOString(), previousStart: period.previousStart.toISOString(), previousEnd: period.previousEnd.toISOString(), rangeStart: period.rangeStart.toISOString() },
    money: { currencies: money, undatedCaptures },
    organizations: { total: rows.length, ...health, newThisMonth: rows.filter(org => org.createdAt && inside(org.createdAt, period.monthStart, now)).length, usingThisMonth: rows.filter(org => org.bookingsThisMonth > 0).length },
    usage: { bookingsThisMonth: monthBookings, previousBookings, completedVisitsThisMonth: visits, patientsBookedThisMonth: bookingData.patients[0]?.count || 0, enabledDoctors: doctors.reduce((total, row) => total + row.count, 0) },
    trend,
    attention,
    organizationActivity: { mostActive: rows.slice(0, 6), leastActive: [...rows].sort((a, b) => a.bookingsThisMonth - b.bookingsThisMonth || a.name.localeCompare(b.name)).slice(0, 6) },
    recentActivity: activity.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8).map(event => ({ ...event, organizationName: rows.find(org => org.id === event.organizationId)?.name || null })),
  };
}
