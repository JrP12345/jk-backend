import crypto from "node:crypto";
import mongoose from "mongoose";
import { describe, it, expect } from "vitest";
import { app } from "../index.ts";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Patient } from "../models/Patient.ts";
import { Location } from "../models/Location.ts";
import { PatientRelationship } from "../models/PatientRelationship.ts";
import { FamilyRelationship } from "../models/FamilyRelationship.ts";
import { DPDPConsent } from "../models/DPDPConsent.ts";
import { createAuthSession } from "../utilities/helpers.ts";
import { CONSENT_NOTICE_VERSION } from "../services/PatientConsentService.ts";
import { Appointment } from "../models/Appointment.ts";

async function fixture() {
  const org = await Organization.create({ name: "Privacy clinic", city: "Pune" });
  const location = await Location.create({ organizationId: org.id, name: "Privacy branch", city: "Pune" });
  const patientUser = await User.create({ name: "Privacy patient", email: `${crypto.randomUUID()}@example.test`, role: "patient" });
  const patient = await Patient.create({ userId: patientUser.id, organizationId: org.id, name: "Privacy patient", phone: "9876543210", allergies: ["Private allergy"], medicalNotes: "Private note" });
  await PatientRelationship.create({ patientId: patient.id, organizationId: org.id, locationId: location.id });
  async function cookies(role: string, consumer = false) {
    const user = consumer ? patientUser : await User.create({ name: "Staff", email: `${crypto.randomUUID()}@example.test`, role });
    if (!consumer) await OrgMember.create({ userId: user.id, organizationId: org.id, role, locationAccess: { mode: "all", reviewedBy: user.id, reviewedAt: new Date() } });
    const session = await createAuthSession({ id: user.id, email: user.email!, role, organization_id: org.id }, { organizationId: org.id, ...(consumer ? {} : { workspaceRole: role }) });
    return { access_token: session.accessToken };
  }
  return { org, patient, patientUser, cookies };
}
describe("Privacy action authority", () => {
  it("allows pure patient self reads but denies cross-patient and unrelated-organization requests", async () => {
    const f = await fixture(), cookies = await f.cookies("patient", true);
    const own = await app.inject({ method: "GET", url: `/api/dpdp/consents?patientId=${f.patient.id}&organizationId=${f.org.id}`, cookies });
    expect(own.statusCode, own.body).toBe(200);
    const organizations = await app.inject({ method: "GET", url: `/api/dpdp/organizations?patientId=${f.patient.id}`, cookies });
    expect(organizations.statusCode, organizations.body).toBe(200);
    expect(organizations.json().data.items).toEqual([{ id: f.org.id, name: "Privacy clinic" }]);
    expect(await DPDPConsent.countDocuments({ patientId: f.patient.id })).toBe(0);
    const other = await Patient.create({ name: "Another patient", organizationId: f.org.id });
    expect((await app.inject({ method: "GET", url: `/api/dpdp/consents?patientId=${other.id}&organizationId=${f.org.id}`, cookies })).statusCode).toBe(403);
    const foreign = await Organization.create({ name: "Foreign", city: "Pune" });
    expect((await app.inject({ method: "GET", url: `/api/dpdp/export?organizationId=${foreign.id}`, cookies })).statusCode).toBe(404);
    await PatientRelationship.create({ patientId: f.patient.id, organizationId: foreign.id, contact: { phone: "9999999999" } });
    await Appointment.create({ patientId: f.patient.id, organizationId: foreign.id, locationId: new mongoose.Types.ObjectId(), doctorId: new mongoose.Types.ObjectId(),
      appointmentTime: new Date(), appointmentType: "walk-in", tokenNumber: 1, status: "completed" });
    const associated = await app.inject({ method: "GET", url: `/api/dpdp/export?organizationId=${foreign.id}`, cookies });
    expect(associated.statusCode, associated.body).toBe(200);
    expect(associated.json().data.patientProfile.phone).toBe("9999999999");
    expect(associated.json().data.clinicalRecords.appointments).toHaveLength(1);
    const grant = await app.inject({ method: "PUT", url: "/api/dpdp/consents", cookies, payload: { patientId: f.patient.id, organizationId: foreign.id,
      expectedRevision: 0, method: "portal_confirmation", acknowledged: true, noticeVersion: CONSENT_NOTICE_VERSION, clientRequestId: crypto.randomUUID(),
      updates: [{ purpose: "COMMUNICATION_WHATSAPP", status: "GRANTED" }] } });
    expect(grant.statusCode, grant.body).toBe(200);
    expect(await DPDPConsent.countDocuments({ organizationId: foreign.id, patientId: f.patient.id })).toBe(1);
    expect(await DPDPConsent.countDocuments({ organizationId: f.org.id, patientId: f.patient.id })).toBe(0);
  });
  it("denies export without an explicit grant and strips clinical DTOs for desk staff", async () => {
    const f = await fixture(), cookies = await f.cookies("receptionist");
    expect((await app.inject({ method: "GET", url: `/api/dpdp/export?patientId=${f.patient.id}`, cookies })).statusCode).toBe(403);
    const profile = await app.inject({ method: "GET", url: `/api/patients/${f.patient.id}`, cookies });
    expect(profile.statusCode, profile.body).toBe(200);
    expect(JSON.stringify(profile.json())).not.toMatch(/Private allergy|Private note|medicalNotes/);
    const update = await app.inject({ method: "PATCH", url: `/api/patients/${f.patient.id}`, cookies, payload: { medicalNotes: "Desk modification" } });
    expect(update.statusCode, update.body).toBe(403);
    const demographics = await app.inject({ method: "PATCH", url: `/api/patients/${f.patient.id}`, cookies, payload: { gender: "other" } });
    expect(demographics.statusCode, demographics.body).toBe(200);
    expect(JSON.stringify(demographics.json())).not.toMatch(/Private allergy|Private note|medicalNotes/);
  });
  it("requires a separate family delegation and rejects staff evidence impersonation", async () => {
    const f = await fixture(), cookies = await f.cookies("patient", true);
    const family = await Patient.create({ name: "Family patient", organizationId: f.org.id, phone: "9876543210" });
    await FamilyRelationship.create({ userId: f.patientUser.id, patientId: family.id, relationship: "spouse", status: "active" });
    expect((await app.inject({ method: "GET", url: `/api/dpdp/consents?patientId=${family.id}&organizationId=${f.org.id}`, cookies })).statusCode).toBe(403);
    const staff = await f.cookies("admin");
    const payload = { patientId: f.patient.id, expectedRevision: 0, clientRequestId: crypto.randomUUID(), method: "portal_confirmation", acknowledged: true,
      noticeVersion: CONSENT_NOTICE_VERSION, updates: [{ purpose: "COMMUNICATION_WHATSAPP", status: "GRANTED" }] };
    expect((await app.inject({ method: "PUT", url: "/api/dpdp/consents", cookies: staff, payload })).statusCode).toBe(400);
    const grant = await app.inject({ method: "PUT", url: "/api/dpdp/consents", cookies, payload: { ...payload, organizationId: f.org.id } });
    expect(grant.statusCode, grant.body).toBe(200);
    const request = await app.inject({ method: "POST", url: "/api/dpdp/erasure", cookies, payload: { patientId: f.patient.id, organizationId: f.org.id, reason: "Review CRM erasure", clientRequestId: crypto.randomUUID() } });
    expect(request.statusCode, request.body).toBe(202);
    const review = await app.inject({ method: "PUT", url: "/api/dpdp/privacy-request/review", cookies, payload: { patientId: f.patient.id, organizationId: f.org.id,
      clientRequestId: crypto.randomUUID(), expectedRevision: request.json().data.revision, decision: "under_review", reason: "Review request", retentionBasis: "Record-specific review pending" } });
    expect(review.statusCode).toBe(403);
  });
});
