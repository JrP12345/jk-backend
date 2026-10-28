import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import app from "../index.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Role } from "../models/Role.ts";
import { Receptionist } from "../models/Receptionist.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { Invoice } from "../models/Invoice.ts";
import { createRefreshTokenDetails, generateAccessToken } from "../utilities/helpers.ts";

describe("Bounded request lifecycle measurements", () => {
  let organizationId: string, locationId: string, otherLocationId: string, doctorId: string;
  let patient: any, headers: { cookie: string };
  const now = new Date("2026-10-15T10:00:00Z");

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
    const org = await Organization.create({ name: "Performance fixture", city: "Surat", plan: "enterprise" });
    const otherOrg = await Organization.create({ name: "Other tenant", city: "Surat", plan: "enterprise" });
    organizationId = org.id;
    const location = await Location.create({ organizationId, name: "Measured branch", city: "Surat" });
    locationId = location.id;
    otherLocationId = (await Location.create({ organizationId: otherOrg.id, name: "Other branch", city: "Surat" })).id;
    const staff = await User.create({ name: "Measured staff", email: "perf-staff@example.test", role: "receptionist" });
    const doctor = await User.create({ name: "Measured doctor", email: "perf-doctor@example.test", role: "doctor" });
    const patientUser = await User.create({ name: "Synthetic linked patient", email: "perf-patient@example.test", phone: "9876500099", role: "patient" });
    doctorId = doctor.id;
    await OrgMember.create([staff, doctor].map(user => ({ userId: user.id, organizationId, role: user.role, locationAccess: { mode: "all" as const } })));
    await DoctorAssignment.create({ organizationId, locationId, doctorId, isActive: true, appointmentDuration: 15, workingHours: "[]" });
    patient = await Patient.create({ organizationId, userId: patientUser.id, name: "Synthetic profile", phone: "9876500088" });
    const { rawToken, sessionId } = await createRefreshTokenDetails(staff.id, { organizationId });
    headers = { cookie: `access_token=${generateAccessToken({ id: staff.id, email: staff.email || "", role: staff.role, organization_id: organizationId, sessionId })}; refresh_token=${rawToken}` };
    await Promise.all([Appointment.init(), ClinicalNote.init()]);
    await Appointment.collection.insertMany(Array.from({ length: 100 }, (_, i) => ({
      organizationId: org._id, locationId: location._id, doctorId: doctor._id, patientId: patient._id,
      status: "checked-in", bookingMode: "sequential_queue", tokenNumber: i + 1, queuePosition: i + 1,
      appointmentTime: now, appointmentType: "walk-in", notes: "Synthetic consultation context ".repeat(100),
    })));
    await Invoice.collection.insertMany([
      { organizationId: org._id, locationId: location._id, doctorId: doctor._id, patientId: patient._id, currency: "INR", status: "partially_paid", totalAmount: 1000, amountPaid: 250, createdAt: new Date(now.getTime() - 2 * 86400000), payments: [{ amount: 250, paidAt: now }] },
      { organizationId: org._id, locationId: location._id, doctorId: doctor._id, patientId: patient._id, currency: "INR", status: "partially_paid", totalAmount: 500, amountPaid: 100, createdAt: now, payments: [{ amount: 100, paidAt: now }] },
      { organizationId: otherOrg._id, locationId: new mongoose.Types.ObjectId(otherLocationId), currency: "INR", status: "paid", totalAmount: 9999, createdAt: now, payments: [{ amount: 9999, paidAt: now }] },
    ].map((invoice, i) => ({ ...invoice, invoiceNumber: `PERF-${i}` })));
  });
  afterAll(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await app.close(); });

  function summaryUrl(extra = "") {
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1); end.setMilliseconds(-1);
    return `/api/analytics/daily-summary?${new URLSearchParams({ locationId, startDate: start.toISOString(), endDate: end.toISOString() })}${extra}`;
  }

  it("omits unused populated appointments while keeping authoritative counts and finances identical", async () => {
    const reads = vi.spyOn(Appointment, "find");
    const full = await app.inject({ method: "GET", url: summaryUrl(), headers });
    expect(full.statusCode, full.body).toBe(200);
    const fullFinds = reads.mock.calls.length;
    reads.mockClear();
    const summary = await app.inject({ method: "GET", url: summaryUrl("&includeAppointments=false"), headers });
    expect(summary.statusCode, summary.body).toBe(200);
    const { recentAppointments, ...fullTotals } = full.json().data;
    const { recentAppointments: omitted, ...summaryTotals } = summary.json().data;
    expect(recentAppointments).toHaveLength(100); expect(omitted).toEqual([]);
    expect(recentAppointments[0]).not.toHaveProperty("notes");
    expect(summaryTotals).toEqual(fullTotals); expect(reads).not.toHaveBeenCalled();
    expect(summaryTotals.moneyByCurrency).toContainEqual({ currency: "INR", collections: 350, outstanding: 400 });
    process.stdout.write(`PERF_DAILY_SUMMARY ${JSON.stringify({ fixtureVisits: 100, before: { appointmentFinds: fullFinds, responseBytes: Buffer.byteLength(full.body) }, after: { appointmentFinds: reads.mock.calls.length, responseBytes: Buffer.byteLength(summary.body) } })}\n`);
    reads.mockRestore();
    expect((await app.inject({ method: "GET", url: summaryUrl("&includeAppointments=invalid"), headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: summaryUrl("&includeAppointments=false").replace(locationId, otherLocationId), headers })).statusCode).toBe(403);
  });

  it("serves assigned-location counts for a custom receptionist without granting location-management reads", async () => {
    const org = await Organization.create({ name: "Restricted reception fixture", city: "Surat", plan: "enterprise" });
    const branch = await Location.create({ organizationId: org.id, name: "Assigned branch", city: "Surat" });
    await Location.create({ organizationId: org.id, name: "Unassigned branch", city: "Surat" });
    await Role.create({ name: "receptionist", organizationId: org.id, permissions: ["VIEW_PATIENTS", "MANAGE_APPOINTMENTS", "MANAGE_QUEUE", "VIEW_BILLING", "MANAGE_BILLING", "MANAGE_ORDERS", "MANAGE_MEDICINES", "VIEW_APPOINTMENTS", "MANAGE_PATIENTS"] });
    const desk = await User.create({ name: "Restricted receptionist", role: "receptionist", email: "restricted-reception@example.test" });
    await OrgMember.create({ userId: desk.id, organizationId: org.id, role: "receptionist" });
    await Receptionist.create({ userId: desk.id, organizationId: org.id, locationId: branch.id });
    const { sessionId } = await createRefreshTokenDetails(desk.id, { organizationId: org.id });
    const access = generateAccessToken({ id: desk.id, email: desk.email!, role: "receptionist", organization_id: org.id, sessionId });
    const scopedHeaders = { cookie: `access_token=${access}` };
    expect((await app.inject({ method: "GET", url: "/api/onboarding/locations", headers: scopedHeaders })).statusCode).toBe(403);
    const response = await app.inject({ method: "GET", url: summaryUrl().replace(`locationId=${locationId}&`, ""), headers: scopedHeaders });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({ locationCount: 1, appointments: 0, financialVisible: true });
    expect(response.json().data).not.toHaveProperty("locations");
    expect((await app.inject({ method: "GET", url: summaryUrl(), headers: scopedHeaders })).statusCode).toBe(403);
  });

  it("aggregates complete dashboard trends beyond list limits without returning historical patient records", async () => {
    await Appointment.collection.insertMany(Array.from({ length: 130 }, (_, index) => ({
      organizationId: new mongoose.Types.ObjectId(organizationId), locationId: new mongoose.Types.ObjectId(locationId),
      patientId: patient._id, doctorId: new mongoose.Types.ObjectId(doctorId), status: "completed", appointmentType: "walk-in",
      tokenNumber: index + 1, appointmentTime: new Date(now.getTime() - 2 * 86400000),
    })));
    const response = await app.inject({ method: "GET", url: summaryUrl("&includeAppointments=false&trendDays=7&timezone=Asia%2FKolkata"), headers });
    expect(response.statusCode, response.body).toBe(200);
    const data = response.json().data;
    expect(data.recentAppointments).toEqual([]);
    expect(data.trends.days.reduce((sum: number, row: any) => sum + row.count, 0)).toBe(230);
    expect(data.trends.locations.reduce((sum: number, row: any) => sum + row.count, 0)).toBe(100);
    expect((await app.inject({ method: "GET", url: summaryUrl("&trendDays=365"), headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: summaryUrl("&trendDays=7&timezone=Invalid"), headers })).statusCode).toBe(400);
  });

  it("avoids patient and user population when no booked patients need delay alerts", async () => {
    const patientReads = vi.spyOn(Patient, "find"), userReads = vi.spyOn(User, "find");
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1); end.setMilliseconds(-1);
    // Reproduce the previous delay-read shape against the exact same fixture.
    await Appointment.find({ locationId, doctorId, appointmentTime: { $gte: start, $lte: end } })
      .populate({ path: "patientId", populate: { path: "userId", select: "name email phone" } }).sort({ queuePosition: 1, tokenNumber: 1 });
    const before = { patientFinds: patientReads.mock.calls.length, userFinds: userReads.mock.calls.length };
    patientReads.mockClear(); userReads.mockClear();
    const response = await app.inject({ method: "GET", url: `/api/queue/delay-status?${new URLSearchParams({ locationId, doctorId })}`, headers });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({ isDelayed: false, affectedCount: 0, delayedPatients: [] });
    expect(patientReads).not.toHaveBeenCalled(); expect(userReads).not.toHaveBeenCalled();
    process.stdout.write(`PERF_QUEUE_DELAY ${JSON.stringify({ fixtureVisits: 100, before, after: { patientFinds: patientReads.mock.calls.length, userFinds: userReads.mock.calls.length } })}\n`);
    patientReads.mockRestore(); userReads.mockRestore();
  });

  it("preserves delayed-patient contact fallback, queue order and location authorization", async () => {
    const visit = await Appointment.findOne({ locationId, tokenNumber: 1 });
    await Appointment.updateOne({ _id: visit!._id }, { $set: { status: "confirmed", appointmentTime: new Date(now.getTime() - 60 * 60_000), lastNotifiedDelayMinutes: 20 } });
    const url = `/api/queue/delay-status?${new URLSearchParams({ locationId, doctorId })}`;
    const response = await app.inject({ method: "GET", url, headers });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.delayedPatients).toContainEqual(expect.objectContaining({ appointmentId: visit!.id, tokenNumber: 1, patientName: "Synthetic linked patient", phone: "9876500099", delayMinutes: 60, lastNotifiedDelayMinutes: 20 }));
    await Patient.updateOne({ _id: patient._id }, { $unset: { userId: 1 } });
    const fallback = await app.inject({ method: "GET", url, headers });
    expect(fallback.json().data.delayedPatients[0]).toMatchObject({ patientName: "Synthetic profile", phone: "9876500088" });
    expect((await app.inject({ method: "GET", url: url.replace(locationId, otherLocationId), headers })).statusCode).toBe(404);
  });

  it("serves the same deterministic history page without sorting every matching note", async () => {
    const org = new mongoose.Types.ObjectId(organizationId), otherOrg = new mongoose.Types.ObjectId();
    const docs = Array.from({ length: 4000 }, (_, i) => ({ organizationId: i < 2000 ? org : otherOrg, patientId: patient._id, isLatest: i % 2 === 0, createdAt: new Date(now.getTime() - Math.floor(i / 2) * 1000), subjective: { chiefComplaint: "Synthetic history fixture" } }));
    await ClinicalNote.collection.insertMany(docs);
    const filter = { organizationId: org, patientId: patient._id };
    const baseline = () => ClinicalNote.collection.find(filter).sort({ createdAt: -1, _id: -1 }).limit(21).hint({ organizationId: 1, patientId: 1, isLatest: 1 });
    const optimized = () => ClinicalNote.collection.find(filter).sort({ createdAt: -1, _id: -1 }).limit(21).hint("clinical_history_by_patient");
    expect((await optimized().toArray()).map(row => String(row._id))).toEqual((await baseline().toArray()).map(row => String(row._id)));
    const before = await baseline().explain("executionStats"), after = await optimized().explain("executionStats");
    const chosen = await ClinicalNote.collection.find(filter).sort({ createdAt: -1, _id: -1 }).limit(21).explain("executionStats");
    expect(after.executionStats.nReturned).toBe(21);
    expect(after.executionStats.totalDocsExamined).toBeLessThan(before.executionStats.totalDocsExamined);
    expect(JSON.stringify(after.queryPlanner.winningPlan)).not.toContain('"stage":"SORT"');
    expect(chosen.executionStats.totalDocsExamined).toBe(21);
    expect(JSON.stringify(chosen.queryPlanner.winningPlan)).not.toContain('"stage":"SORT"');
    const metrics = (plan: any) => ({ returned: plan.executionStats.nReturned, documentsExamined: plan.executionStats.totalDocsExamined, keysExamined: plan.executionStats.totalKeysExamined, blockingSort: JSON.stringify(plan.queryPlanner.winningPlan).includes('"stage":"SORT"') });
    process.stdout.write(`PERF_CLINICAL_HISTORY ${JSON.stringify({ fixtureNotes: docs.length, before: metrics(before), after: metrics(after) })}\n`);
  });
});
