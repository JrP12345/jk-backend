import { fixtureAccessToken } from "./helpers/sessionFixture.ts";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { app } from "../index.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { Role } from "../models/Role.ts";
import { DoctorDayOverride } from "../models/DoctorDayOverride.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { FamilyRelationship } from "../models/FamilyRelationship.ts";
import { SaaSPlan } from "../models/SaaSPlan.ts";
import { Subscription } from "../models/Subscription.ts";
import { createTrackerCapability } from "../utilities/publicTracker.ts";
import { disruptionService } from "../services/disruptionService.ts";

const id = () => new mongoose.Types.ObjectId();
let orgA: string, locationA: string, locationB: string, doctorA: string;
let visitA: string, visitB: string, inconsistent: string;
let staffCookie: string, restrictedCookie: string, patientCookie: string, noProfileCookie: string, familyCookie: string;
let capability: ReturnType<typeof createTrackerCapability>;

beforeAll(async () => {
  const a = await Organization.create({ name: "Disruption A", city: "Surat" });
  const b = await Organization.create({ name: "Disruption B", city: "Mumbai" });
  orgA = a.id;
  const ca = await Location.create({ name: "Clinic A", city: "Surat", organizationId: a._id });
  const cb = await Location.create({ name: "Clinic B", city: "Mumbai", organizationId: b._id });
  locationA = ca.id; locationB = cb.id;
  const plan = await SaaSPlan.create({ name: "Trial", slug: "disruption_authorization", description: "Test", monthlyPrice: 100, annualPrice: 1000 });
  await Subscription.create({ organizationId: a._id, planId: plan._id, status: "trialing", entitlementSource: "trial", trialEndsAt: new Date(Date.now() + 86400000 * 10), currentPeriodEnd: new Date(Date.now() + 86400000 * 10) });
  await Role.create([{ name: "receptionist", organizationId: a._id, permissions: ["MANAGE_QUEUE", "VIEW_APPOINTMENTS"] }, { name: "admin", organizationId: a._id, permissions: [] }]);
  const users = await User.create([
    { name: "Staff", email: "staff@disruption.test", role: "receptionist" },
    { name: "Restricted Admin", email: "admin@disruption.test", role: "admin" },
    { name: "Owner", email: "owner@disruption.test", role: "patient" },
    { name: "No profile", email: "missing@disruption.test", role: "patient" },
    { name: "Family", email: "family@disruption.test", role: "family_member" },
    { name: "Doctor A", email: "doctor@disruption.test", phone: "919999999999", role: "doctor" },
  ]);
  const cookie = async (index: number, organization_id?: string) => `access_token=${(await fixtureAccessToken({ id: users[index].id, email: users[index].email || "", role: users[index].role, organization_id }))}`;
  staffCookie = (await cookie(0, orgA)); restrictedCookie = (await cookie(1, orgA));
  patientCookie = (await cookie(2)); noProfileCookie = (await cookie(3)); familyCookie = (await cookie(4));
  doctorA = users[5].id;
  const patient = await Patient.create({ name: "Owner", phone: "919000000001", organizationId: a._id, userId: users[2]._id });
  await FamilyRelationship.create({ userId: users[4]._id, patientId: patient._id, relationship: "guardian", status: "active" });
  await DoctorAssignment.create({ locationId: ca._id, doctorId: users[5]._id, organizationId: a._id, workingHours: "[]" });
  capability = createTrackerCapability();
  const base = { locationId: ca._id, organizationId: a._id, doctorId: users[5]._id, patientId: patient._id, appointmentTime: new Date(), appointmentType: "online", status: "disruption_triage", tokenNumber: 1, triageAction: "pending" } as const;
  const docs = await Appointment.create([
    { ...base, trackerTokenHash: capability.hash, trackerTokenExpiresAt: new Date(Date.now() + 86400000) },
    { ...base, locationId: cb._id, organizationId: b._id, patientId: id() },
    { ...base, organizationId: b._id },
  ]);
  visitA = docs[0].id; visitB = docs[1].id; inconsistent = docs[2].id;
  await DoctorDayOverride.create([
    { locationId: ca._id, organizationId: a._id, doctorId: users[5]._id, date: "2026-10-04", status: "unavailable", reason: "Internal leave note" },
    { locationId: ca._id, doctorId: users[5]._id, date: "2026-10-05", status: "delayed", reason: "Local day override" },
    { locationId: cb._id, organizationId: b._id, doctorId: users[5]._id, date: "2026-10-04", status: "unavailable", reason: "Foreign private note" },
    { locationId: cb._id, doctorId: users[5]._id, date: "2026-10-05", status: "delayed", reason: "Foreign override" },
  ]);
});

beforeEach(() => {
  vi.spyOn(disruptionService, "cancelByDisruption").mockResolvedValue({ status: "cancelled" } as never);
  vi.spyOn(disruptionService, "priorityReschedule").mockResolvedValue({ originalAppt: {}, newAppt: {} } as never);
  vi.spyOn(disruptionService, "batchTriageAction").mockResolvedValue({ successfulCount: 1, failedCount: 0, errors: [], processed: [] });
});
afterEach(() => vi.restoreAllMocks());
const patientAction = (headers = {}, appointmentId = visitA) => app.inject({ method: "POST", url: "/api/doctor-overrides/patient-action", headers, payload: { appointmentId, action: "cancel" } });
const batch = (appointmentIds: string[], cookie = staffCookie) => app.inject({ method: "POST", url: "/api/doctor-overrides/triage/batch", headers: { cookie }, payload: { action: "cancel", appointmentIds } });

describe("Disruption authorization boundaries", () => {
  it("never accepts an anonymous appointment ID as mutation authority", async () => {
    expect((await patientAction()).statusCode).toBe(401);
    expect(disruptionService.cancelByDisruption).not.toHaveBeenCalled();
  });
  it("requires a matching unexpired tracker capability on every public read", async () => {
    expect((await patientAction({ "x-tracker-token": "wrong" })).statusCode).toBe(403);
    expect((await patientAction({ "x-tracker-token": capability.token }, visitB)).statusCode).toBe(403);
    await Appointment.updateOne({ _id: visitA }, { trackerTokenExpiresAt: new Date(Date.now() - 1000) });
    expect((await patientAction({ "x-tracker-token": capability.token })).statusCode).toBe(403);
    expect(disruptionService.cancelByDisruption).not.toHaveBeenCalled();
    await Appointment.updateOne({ _id: visitA }, { trackerTokenExpiresAt: new Date(Date.now() + 86400000) });
    expect((await patientAction({ "x-tracker-token": capability.token })).statusCode).toBe(200);
    expect(disruptionService.cancelByDisruption).toHaveBeenCalledOnce();
  });
  it("allows the authenticated patient or active family relationship and denies a missing profile", async () => {
    expect((await patientAction({ cookie: patientCookie })).statusCode).toBe(200);
    expect((await patientAction({ cookie: familyCookie })).statusCode).toBe(200);
    expect((await patientAction({ cookie: noProfileCookie })).statusCode).toBe(403);
    expect((await patientAction({ cookie: patientCookie }, visitB)).statusCode).toBe(403);
    expect(disruptionService.cancelByDisruption).toHaveBeenCalledTimes(2);
  });
  it("checks the whole batch before any mutation, regardless of record ordering", async () => {
    for (const ids of [[visitA, visitB], [visitB, visitA], [visitA, inconsistent], [String(id()), visitA]]) {
      expect((await batch(ids)).statusCode).toBe(404);
    }
    expect(disruptionService.batchTriageAction).not.toHaveBeenCalled();
    expect((await Appointment.findById(visitA))?.status).toBe("disruption_triage");
  });
  it("bounds batches, rejects malformed IDs and processes an authorized ID only once", async () => {
    expect((await batch([visitA, "invalid"])).statusCode).toBe(400);
    expect((await batch(Array(101).fill(visitA))).statusCode).toBe(400);
    expect((await batch([visitA, visitA])).statusCode).toBe(200);
    expect(disruptionService.batchTriageAction).toHaveBeenCalledWith(expect.objectContaining({ appointmentIds: [visitA] }));
  });
  it("honors revoked organization-admin grants rather than using the role label", async () => {
    expect((await batch([visitA], restrictedCookie)).statusCode).toBe(403);
    expect(disruptionService.batchTriageAction).not.toHaveBeenCalled();
  });
  it("scopes unfiltered and all-clinic override listings to the staff organization", async () => {
    for (const suffix of ["", "?locationId=all"]) {
      const result = await app.inject({ method: "GET", url: `/api/doctor-overrides${suffix}`, headers: { cookie: staffCookie } });
      expect(result.statusCode).toBe(200);
      expect(result.json().data).toHaveLength(2);
      expect(result.body).not.toContain("Foreign private note");
      expect(result.body).not.toContain("Foreign override");
    }
    expect((await app.inject({ method: "GET", url: `/api/doctor-overrides?locationId=${locationB}`, headers: { cookie: staffCookie } })).statusCode).toBe(404);
  });
  it("limits consumer availability reads to an explicit clinic/provider and public fields", async () => {
    expect((await app.inject({ method: "GET", url: "/api/doctor-overrides", headers: { cookie: patientCookie } })).statusCode).toBe(400);
    const result = await app.inject({ method: "GET", url: `/api/doctor-overrides?locationId=${locationA}&doctorId=${doctorA}`, headers: { cookie: patientCookie } });
    expect(result.statusCode).toBe(200);
    expect(result.json().data).toHaveLength(2);
    for (const privateText of ["Internal leave note", "919999999999", "doctor@disruption.test", "createdBy"]) expect(result.body).not.toContain(privateText);
  });
});
