import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";

// Never load a .env file, reuse a configured database, or connect to real Redis.
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
delete process.env.REDIS_URL;
delete process.env.REDIS_HOST;
const { app } = await import("../index.ts");
const { Organization } = await import("../models/Organization.ts");
const { Location } = await import("../models/Location.ts");
const { User } = await import("../models/User.ts");
const { Doctor } = await import("../models/Doctor.ts");
const { DoctorAssignment } = await import("../models/DoctorAssignment.ts");
const { Appointment } = await import("../models/Appointment.ts");
const { DoctorDayOverride } = await import("../models/DoctorDayOverride.ts");
const { SaaSPlan } = await import("../models/SaaSPlan.ts");
const { Subscription } = await import("../models/Subscription.ts");
const { SubscriptionPayment } = await import("../models/SubscriptionPayment.ts");
const { generateAccessToken } = await import("../utilities/helpers.ts");
const { loadPlatformDashboard } = await import("../services/platformDashboard.ts");
const { locationDayRange } = await import("../utilities/locationTime.ts");

const now = new Date("2026-10-15T12:00:00Z");
const models = [Organization, Location, User, Doctor, DoctorAssignment, Appointment, DoctorDayOverride, SaaSPlan, Subscription, SubscriptionPayment];
const replica = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
const samples: Record<string, unknown>[] = [];
const round = (value: number) => Math.round(value * 100) / 100;

function planSummary(explain: any) {
  const stages = new Set<string>();
  const indexes = new Set<string>();
  let docsExamined = 0, keysExamined = 0, returned = 0;
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.stage === "string") stages.add(node.stage);
    if (node.indexName) indexes.add(node.indexName);
    if (node.executionStats) {
      docsExamined += node.executionStats.totalDocsExamined || 0;
      keysExamined += node.executionStats.totalKeysExamined || 0;
      returned += node.executionStats.nReturned || 0;
    }
    for (const [key, value] of Object.entries(node)) if (key !== "rejectedPlans") walk(value);
  };
  walk(explain);
  return { stages: [...stages], indexes: [...indexes], docsExamined, keysExamined, returned };
}

async function resetFixtures() {
  assert.equal(mongoose.connection.name, "healthcare_scale_measurement");
  assert.equal(mongoose.connection.host, "127.0.0.1");
  // The only connection was created from replica.getUri below; this is task-owned data.
  await mongoose.connection.dropDatabase();
  await Promise.all(models.map(model => model.createIndexes()));
}

async function measure(label: string, run: () => Promise<unknown>, fixture: Record<string, unknown>, plans: Record<string, unknown>) {
  await run(); // Warm query plans, model imports and connection pool.
  const durations: number[] = [];
  let payload = "";
  for (let sample = 0; sample < 7; sample++) {
    const start = performance.now();
    const result = await run();
    payload = JSON.stringify(result);
    durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  const row = { label, fixture, samples: durations.length, medianMs: round(durations[3]),
    maxMs: round(durations[durations.length - 1]), payloadBytes: Buffer.byteLength(payload), queryPlans: plans };
  samples.push(row);
  console.log(JSON.stringify(row));
}

try {
  await mongoose.connect(replica.getUri("healthcare_scale_measurement"));
  await app.ready();
  for (const providerCount of [10, 100]) {
    await resetFixtures();
    const org = await Organization.create({ name: "Synthetic provider workload", city: "Surat", timezone: "Asia/Kolkata" });
    const location = await Location.create({ name: "Synthetic location", city: "Surat", organizationId: org.id });
    const root = await User.create({ name: "Synthetic owner", role: "root" });
    const providers = await User.insertMany(Array.from({ length: providerCount }, (_, index) => ({ name: `Synthetic provider ${index}`, role: "doctor" })));
    await DoctorAssignment.insertMany(providers.map(provider => ({ doctorId: provider._id, locationId: location._id, organizationId: org._id, workingHours: "[]" })));
    const visits = providers.flatMap(provider => Array.from({ length: 100 }, (_, index) => ({
      organizationId: org._id, locationId: location._id, doctorId: provider._id, patientId: new mongoose.Types.ObjectId(),
      appointmentTime: new Date("2026-10-15T04:00:00Z"), createdAt: now, status: "confirmed", bookingMode: "sequential_queue",
      appointmentType: "reception", tokenNumber: index + 1,
    })));
    await Appointment.collection.insertMany(visits);
    const doctorIds = providers.map(provider => provider._id);
    const range = locationDayRange("2026-10-15", "Asia/Kolkata");
    const loadPipeline = [
      { $match: { locationId: location._id, doctorId: { $in: doctorIds }, appointmentTime: { $gte: range.start, $lte: range.end }, status: { $in: ["confirmed", "checked-in", "in-consultation"] } } },
      { $group: { _id: "$doctorId", count: { $sum: 1 } } },
    ];
    const plans = { replacementLoad: planSummary(await Appointment.collection.aggregate(loadPipeline).explain("executionStats")) };
    const cookie = `access_token=${generateAccessToken({ id: root.id, email: "", role: "root" })}`;
    await measure(`${providerCount} providers: replacement API`, async () => {
      const response = await app.inject({ method: "GET", url: `/api/doctor-overrides/eligible-replacements?locationId=${location.id}&doctorId=${providers[0].id}&date=2026-10-15`, headers: { cookie } });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.data.length, providerCount - 1);
      assert.ok(body.data.every((provider: any) => provider.currentBookingsCount === 100));
      return body;
    }, { providers: providerCount, appointments: visits.length, appointmentsPerProviderOnDay: 100 }, plans);
  }
  for (const organizationCount of [50, 500]) {
    await resetFixtures();
    const plan = await SaaSPlan.create({ name: "Synthetic plan", slug: "synthetic", description: "Local measurement only", monthlyPrice: 1000, annualPrice: 10000 });
    const organizations = await Organization.insertMany(Array.from({ length: organizationCount }, (_, index) => ({ name: `Synthetic organization ${index}`, city: "Surat", isOnboarded: true, createdAt: new Date("2025-01-01") })));
    const visits: any[] = [];
    const identities: any[] = [];
    const doctors: any[] = [];
    const locations: any[] = [];
    const subscriptions: any[] = [];
    const payments: any[] = [];
    for (const [index, org] of organizations.entries()) {
      const subscriptionId = new mongoose.Types.ObjectId();
      const locationId = new mongoose.Types.ObjectId();
      const doctorIds = Array.from({ length: 10 }, () => new mongoose.Types.ObjectId());
      locations.push({ _id: locationId, organizationId: org._id, name: `Synthetic location ${index}`, city: "Surat", isActive: true });
      for (const [provider, userId] of doctorIds.entries()) {
        identities.push({ _id: userId, name: `Synthetic provider ${index}-${provider}`, role: "doctor", isActive: true });
        doctors.push({ userId, organizationId: org._id, isActive: true });
      }
      subscriptions.push({ _id: subscriptionId, organizationId: org._id, planId: plan._id, status: index % 3 ? "active" : "trialing", entitlementSource: index % 3 ? "paid" : "trial", trialEndsAt: new Date("2026-10-30"), currentPeriodEnd: new Date("2026-10-30"), createdAt: new Date("2026-10-01") });
      if (index % 3) payments.push({ organizationId: org._id, subscriptionId, planId: plan._id, razorpayOrderId: `order_synthetic${index}`, amount: 1180, currency: "INR", status: "captured", paidAt: new Date("2026-10-02") });
      for (let visit = 0; visit < 300; visit++) {
        const ageDays = visit < 100 ? visit % 40 : 90 + visit % 365;
        const createdAt = new Date(now.getTime() - ageDays * 86400000);
        visits.push({ organizationId: org._id, locationId, doctorId: doctorIds[visit % doctorIds.length],
          patientId: new mongoose.Types.ObjectId(), appointmentTime: createdAt, createdAt, appointmentType: "online",
          status: visit % 4 ? "confirmed" : "completed", bookingMode: "sequential_queue", tokenNumber: visit + 1 });
      }
    }
    await Location.collection.insertMany(locations);
    await User.collection.insertMany(identities);
    await Doctor.collection.insertMany(doctors);
    await Subscription.collection.insertMany(subscriptions);
    await SubscriptionPayment.collection.insertMany(payments);
    await Appointment.collection.insertMany(visits);
    const plans = {
      organizations: planSummary(await Organization.collection.find({}).explain("executionStats")),
      bookings: planSummary(await Appointment.collection.find({ organizationId: { $in: organizations.map(org => org._id) }, createdAt: { $gte: new Date("2026-09-01"), $lte: now }, status: { $ne: "pending_payment" } }).explain("executionStats")),
    };
    await measure(`${organizationCount} organizations: ROOT dashboard service`, async () => {
      const result = await loadPlatformDashboard("30D", now);
      assert.equal(result.organizations.total, organizationCount);
      assert.equal(result.usage.enabledDoctors, organizationCount * 10);
      assert.equal(result.usage.bookingsThisMonth, organizationCount * 45);
      assert.ok(result.organizationActivity.mostActive.length <= 6);
      assert.ok(result.organizationActivity.mostActive.every(org => org.doctors === 10));
      assert.ok(result.recentActivity.length <= 8);
      return result;
    }, { organizations: organizationCount, providers: doctors.length, locations: locations.length,
      appointments: visits.length, recentAppointments: organizationCount * 100, retainedAppointments: organizationCount * 200,
      subscriptions: subscriptions.length, capturedPayments: payments.length }, plans);
  }
  const report = { generatedAt: new Date().toISOString(), synthetic: true, deploymentCertification: false,
    environment: { node: process.version, platform: process.platform, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length,
      mongodb: (await mongoose.connection.db!.admin().serverInfo()).version, replicaNodes: 1 },
    method: "Single sequential caller, one warm-up and seven timed samples; local replica-set indexes; API injection for replacements, service calls for ROOT. No real patient/provider data, network RTT, browser, distributed load, or production SLA inference.",
    samples };
  const output = new URL("../docs/measurements/healthcare-scale-baseline.json", import.meta.url);
  await fs.mkdir(new URL("./", output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
} finally {
  await app.close();
  await mongoose.disconnect();
  await replica.stop();
}
