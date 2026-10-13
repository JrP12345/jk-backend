import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { PatientRelationship } from "../models/PatientRelationship.ts";
import { CrmActivity } from "../models/CrmActivity.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { FamilyRelationship } from "../models/FamilyRelationship.ts";
import { Organization } from "../models/Organization.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Location } from "../models/Location.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { createAuthSession } from "../utilities/helpers.ts";
import { patientMatchingService } from "../services/PatientMatchingService.ts";

async function fixture() {
  const org = await Organization.create({ name: "Identity clinic", city: "Pune" });
  const location = await Location.create({ name: "Clinic branch", city: "Pune", organizationId: org._id });
  const admin = await User.create({ name: "Identity reviewer", email: `${crypto.randomUUID()}@example.test`, role: "admin" });
  await OrgMember.create({ organizationId: org._id, userId: admin._id, role: "admin" });
  const session = await createAuthSession({ id: admin.id, email: admin.email!, role: "admin", organization_id: org.id }, { organizationId: org.id, workspaceRole: "admin" });
  const cookies = { access_token: session.accessToken };
  const phone = `98${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  return { org, location, admin, cookies, phone };
}
describe("Canonical registration and reviewed identity", () => {
  it("registers name and phone without a fake login, and restores concurrent/retried commands exactly once", async () => {
    const f = await fixture();
    const payload = { name: "Minimal patient", phone: f.phone, locationId: f.location.id, clientRequestId: crypto.randomUUID() };
    const register = () => app.inject({ method: "POST", url: "/api/patients", cookies: f.cookies, payload });
    const responses = await Promise.all([register(), register()]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 201]);
    const id = responses[0].json().data.id;
    expect(responses[1].json().data.id).toBe(id);
    expect((await register()).json().data.id).toBe(id);
    expect(await Patient.countDocuments({ organizationId: f.org._id })).toBe(1);
    expect(await PatientRelationship.countDocuments({ organizationId: f.org._id, patientId: id })).toBe(1);
    expect(await CrmActivity.countDocuments({ organizationId: f.org._id, patientId: id })).toBe(1);
    expect(await User.countDocuments({ phone: f.phone })).toBe(0);
    const changed = await app.inject({ method: "POST", url: "/api/patients", cookies: f.cookies, payload: { ...payload, name: "Different details" } });
    expect(changed.statusCode).toBe(409);
  });
  it("serializes matching across different request identifiers and requires a reason for family members sharing a contact", async () => {
    const f = await fixture();
    const register = (extra: object = {}) => app.inject({ method: "POST", url: "/api/patients", cookies: f.cookies,
      payload: { name: "Shared contact patient", phone: f.phone, clientRequestId: crypto.randomUUID(), ...extra } });
    const pair = await Promise.all([register(), register()]);
    expect(pair.map(response => response.statusCode).sort()).toEqual([201, 409]);
    const denied = await register({ name: "Other family member", ignoreDuplicate: true });
    expect(denied.statusCode).toBe(400);
    const reviewed = await register({ name: "Other family member", distinctPersonReason: "Different adult family member present with their own identity." });
    expect(reviewed.statusCode, reviewed.body).toBe(201);
    expect(await Patient.countDocuments({ organizationId: f.org._id, phone: f.phone })).toBe(2);
  });
  it("rolls back registration, relationship, activity and receipt when the audit write fails", async () => {
    const f = await fixture();
    const key = crypto.randomUUID();
    const audit = vi.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("Audit unavailable"));
    try {
      const response = await app.inject({ method: "POST", url: "/api/patients", cookies: f.cookies, payload: { name: "Rollback patient", phone: f.phone, clientRequestId: key } });
      expect(response.statusCode).toBe(503);
    } finally { audit.mockRestore(); }
    expect(await Patient.countDocuments({ organizationId: f.org._id })).toBe(0);
    expect(await PatientRelationship.countDocuments({ organizationId: f.org._id })).toBe(0);
    expect(await CrmActivity.countDocuments({ organizationId: f.org._id })).toBe(0);
    expect(await OperationReceipt.countDocuments({ key })).toBe(0);
  });
  it("returns bounded administrative matching hints only within the organization", async () => {
    const f = await fixture();
    const other = await Organization.create({ name: "Foreign organization", city: "Pune" });
    await Patient.create({ name: "Foreign identity", phone: f.phone, organizationId: other._id, conditions: ["Private condition"] });
    for (let index = 0; index < 22; index++) await Patient.create({ name: `Family ${index}`, phone: f.phone, organizationId: f.org._id, medicalNotes: "Private note" });
    const matches = await patientMatchingService.findMatchingPatients({ phone: f.phone, organizationId: f.org.id });
    expect(matches.truncated).toBe(true);
    expect(matches.mediumConfidence).toHaveLength(20);
    expect(JSON.stringify(matches)).not.toMatch(/Private|Foreign identity|medicalNotes|conditions/);
    expect(matches.mediumConfidence.every(patient => patient.identityVerified === false)).toBe(true);
    expect(await patientMatchingService.findMatchingPatients({ phone: f.phone })).toMatchObject({ highConfidence: [], mediumConfidence: [], lowConfidence: [] });
  });
  it("includes an existing cross-organization relationship as a candidate without moving canonical patient ownership", async () => {
    const f = await fixture();
    const other = await Organization.create({ name: "Home organization", city: "Pune" });
    const patient = await Patient.create({ name: "Returning patient", phone: f.phone, organizationId: other._id });
    await PatientRelationship.create({ organizationId: f.org._id, patientId: patient._id, locationId: f.location._id });
    const matches = await patientMatchingService.findMatchingPatients({ name: "Returning patient", phone: f.phone, organizationId: f.org.id });
    expect(matches.highConfidence[0].id).toBe(patient.id);
    expect(String((await Patient.findById(patient.id))!.organizationId)).toBe(other.id);
  });
  it("associates a verified existing patient, exposes only administrative fields, and preserves canonical ownership", async () => {
    const f = await fixture();
    const home = await Organization.create({ name: "Existing patient's home", city: "Pune" });
    const patient = await Patient.create({ name: "Verified existing patient", phone: f.phone, organizationId: home._id, conditions: ["Private condition"], medicalNotes: "Private note" });
    const payload = { locationId: f.location.id, verificationMethod: "in_person", identityVerified: true, reason: "Patient presented their record reference and was independently verified.", clientRequestId: crypto.randomUUID() };
    const unverified = await app.inject({ method: "POST", url: `/api/patients/${patient.id}/associate`, cookies: f.cookies, payload: { ...payload, identityVerified: false } });
    expect(unverified.statusCode).toBe(403);
    expect(await PatientRelationship.countDocuments({ organizationId: f.org._id, patientId: patient._id })).toBe(0);
    const associate = () => app.inject({ method: "POST", url: `/api/patients/${patient.id}/associate`, cookies: f.cookies, payload });
    expect((await associate()).statusCode).toBe(200);
    expect((await associate()).statusCode).toBe(200);
    const directory = await app.inject({ method: "GET", url: `/api/patients?search=${encodeURIComponent(f.phone)}`, cookies: f.cookies });
    expect(directory.statusCode).toBe(200);
    expect(directory.json().data.map((value: any) => value.id)).toContain(patient.id);
    expect(directory.body).not.toMatch(/Private condition|Private note|medicalNotes|conditions/);
    expect(await Patient.countDocuments({ phone: f.phone })).toBe(1);
    expect(String((await Patient.findById(patient.id))!.organizationId)).toBe(home.id);
    expect(await CrmActivity.countDocuments({ organizationId: f.org._id, patientId: patient._id, kind: "patient_associated" })).toBe(1);
  });
  it("does not let a branch-limited staff member correct another branch's patient", async () => {
    const f = await fixture();
    const branch = await Location.create({ organizationId: f.org._id, name: "Other branch", city: "Pune" });
    const desk = await User.create({ name: "Restricted desk", email: `${crypto.randomUUID()}@example.test`, role: "receptionist" });
    await OrgMember.create({ organizationId: f.org._id, userId: desk._id, role: "receptionist", locationAccess: { mode: "selected", locationIds: [f.location._id] } });
    const session = await createAuthSession({ id: desk.id, email: desk.email!, role: "receptionist", organization_id: f.org.id }, { organizationId: f.org.id, workspaceRole: "receptionist" });
    const patient = await Patient.create({ name: "Other branch patient", phone: f.phone, organizationId: f.org._id });
    await PatientRelationship.create({ organizationId: f.org._id, patientId: patient._id, locationId: branch._id });
    const response = await app.inject({ method: "PATCH", url: `/api/patients/${patient.id}/contact`, cookies: { access_token: session.accessToken }, payload: {
      phone: "9222233333", email: "", availability: "reachable", reason: "Attempted foreign branch correction", expectedRevision: 0, clientRequestId: crypto.randomUUID(),
    } });
    expect(response.statusCode).toBe(404);
    expect((await PatientRelationship.findOne({ organizationId: f.org._id, patientId: patient._id }))!.revision).toBe(0);
    const directory = await app.inject({ method: "GET", url: "/api/patients", cookies: { access_token: session.accessToken } });
    expect(directory.statusCode).toBe(200);
    expect(directory.json().data.map((value: any) => value.id)).not.toContain(patient.id);
  });
  it("does not attach an existing unlinked record from contact email possession during OTP login", async () => {
    const f = await fixture();
    const email = `${crypto.randomUUID()}@example.test`;
    const patient = await Patient.create({ name: "Another person sharing email", email, organizationId: f.org._id, medicalNotes: "Private record" });
    await app.inject({ method: "POST", url: "/api/auth/otp/request", payload: { email, purpose: "authentication" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/otp/verify", payload: { email, otp: "123456", purpose: "authentication", name: "Contact owner" } });
    expect(login.statusCode, login.body).toBe(200);
    expect(login.json().data.patient.id).not.toBe(patient.id);
    expect(login.body).not.toContain("Private record");
    expect((await Patient.findById(patient.id))!.userId).toBeUndefined();
  });
  it("corrects organization contacts with revision checks without changing a login or another organization's contact", async () => {
    const f = await fixture();
    const user = await User.create({ name: "Patient login", email: `${crypto.randomUUID()}@example.test`, phone: f.phone, role: "patient" });
    const patient = await Patient.create({ userId: user._id, name: user.name, phone: f.phone, organizationId: f.org._id });
    const other = await Organization.create({ name: "Other clinic contact", city: "Pune" });
    await PatientRelationship.create({ organizationId: other._id, patientId: patient._id, contact: { phone: "9111122222" } });
    const payload = { phone: "9222233333", email: "", availability: "reachable", reason: "Patient provided the current organization contact.", expectedRevision: 0, clientRequestId: crypto.randomUUID() };
    const update = () => app.inject({ method: "PATCH", url: `/api/patients/${patient.id}/contact`, cookies: f.cookies, payload });
    const response = await update();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({ phone: "9222233333", revision: 1 });
    expect((await update()).statusCode).toBe(200);
    const stale = await app.inject({ method: "PATCH", url: `/api/patients/${patient.id}/contact`, cookies: f.cookies, payload: { ...payload, clientRequestId: crypto.randomUUID(), phone: "9333344444" } });
    expect(stale.statusCode).toBe(409);
    expect((await User.findById(user.id))!.phone).toBe(f.phone);
    expect((await Patient.findById(patient.id))!.phone).toBe(f.phone);
    expect((await PatientRelationship.findOne({ organizationId: other._id, patientId: patient._id }))!.contact.phone).toBe("9111122222");
  });
  it("keeps shared-phone claims pending without medical access, then allows an authorized independent identity review", async () => {
    const f = await fixture();
    const patient = await Patient.create({ name: "Unlinked walk-in", phone: f.phone, organizationId: f.org._id, medicalNotes: "Do not expose" });
    const user = await User.create({ name: "Patient claimant", email: `${crypto.randomUUID()}@example.test`, phone: f.phone, role: "patient" });
    const session = await createAuthSession({ id: user.id, email: user.email!, role: "patient" });
    const cookies = { access_token: session.accessToken };
    const claimed = await app.inject({ method: "POST", url: "/api/family/claim", cookies, payload: { patientId: patient.id, otp: "123456" } });
    expect(claimed.statusCode).toBe(202);
    expect(claimed.json().data.status).toBe("pending");
    expect(JSON.stringify(claimed.json())).not.toContain("Do not expose");
    expect((await Patient.findById(patient.id))!.userId).toBeUndefined();
    const detail = await app.inject({ method: "GET", url: `/api/patients/${patient.id}`, cookies });
    expect([403, 404]).toContain(detail.statusCode);
    const claimId = claimed.json().data.relationshipId;
    const payload = { decision: "approve", identityVerified: true, reason: "Verified the person in person and their account independently.", clientRequestId: crypto.randomUUID() };
    const unauthorized = await app.inject({ method: "POST", url: `/api/patients/${patient.id}/identity-claims/${claimId}/review`, cookies, payload });
    expect(unauthorized.statusCode).toBe(403);
    const approved = await app.inject({ method: "POST", url: `/api/patients/${patient.id}/identity-claims/${claimId}/review`, cookies: f.cookies, payload });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(String((await Patient.findById(patient.id))!.userId)).toBe(user.id);
    expect((await FamilyRelationship.findById(claimId))!.status).toBe("active");
    expect((await app.inject({ method: "GET", url: `/api/patients/${patient.id}`, cookies })).statusCode).toBe(200);
  });
});
