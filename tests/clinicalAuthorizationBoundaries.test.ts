import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../index.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Role } from "../models/Role.ts";
import { Patient } from "../models/Patient.ts";
import { FamilyRelationship } from "../models/FamilyRelationship.ts";
import { Encounter } from "../models/Encounter.ts";
import { ObservationScore } from "../models/ObservationScore.ts";
import { Observation } from "../models/Observation.ts";
import { Prescription } from "../models/Prescription.ts";
import { OpdTemplate } from "../models/OpdTemplate.ts";
import { SoapTemplate } from "../models/SoapTemplate.ts";
import { fixtureAccessToken } from "./helpers/sessionFixture.ts";

describe("Clinical object and workspace authorization boundaries", () => {
  let orgA: any, orgB: any, locationA: any, locationB: any, otherBranch: any, doctor: any;
  let patientA: any, patientB: any, encounterA: any, encounterB: any, encounterC: any, prescriptionB: any;
  let patientHeaders: { cookie: string }, familyHeaders: { cookie: string }, doctorHeaders: { cookie: string }, doctorBHeaders: { cookie: string }, nurseHeaders: { cookie: string }, readOnlyHeaders: { cookie: string }, receptionistHeaders: { cookie: string }, rootHeaders: { cookie: string };
  let familyLink: any, foreignPreset: any;

  beforeAll(async () => {
    orgA = await Organization.create({ name: "Security tenant A", city: "Surat", plan: "enterprise" });
    orgB = await Organization.create({ name: "Security tenant B", city: "Surat", plan: "enterprise" });
    locationA = await Location.create({ organizationId: orgA.id, name: "Security branch A", city: "Surat" });
    locationB = await Location.create({ organizationId: orgB.id, name: "Security branch B", city: "Surat" });
    otherBranch = await Location.create({ organizationId: orgA.id, name: "Restricted sibling branch", city: "Surat" });
    doctor = await User.create({ name: "Shared doctor", email: "boundary-doctor@example.test", role: "doctor" });
    const nurse = await User.create({ name: "Nurse", role: "nurse" });
    const labTech = await User.create({ name: "Read-only clinical staff", role: "lab_tech" });
    const receptionist = await User.create({ name: "Receptionist", role: "receptionist" });
    const patientUser = await User.create({ name: "Patient A", role: "patient" });
    const family = await User.create({ name: "Authorized family", role: "family_member" });
    const root = await User.create({ name: "Platform root", role: "root" });
    await OrgMember.create([
      ...[doctor, nurse, receptionist, labTech].map(user => ({ userId: user.id, organizationId: orgA.id, role: user.role, locationAccess: { mode: "all" as const } })),
      { userId: doctor.id, organizationId: orgB.id, role: "doctor", locationAccess: { mode: "all" as const } },
    ]);
    const headers = async (user: any, organizationId?: string) => ({ cookie: `access_token=${await fixtureAccessToken({ id: user.id, role: user.role, email: user.email || "", organization_id: organizationId })}` });
    patientHeaders = await headers(patientUser); familyHeaders = await headers(family);
    doctorHeaders = await headers(doctor, orgA.id); doctorBHeaders = await headers(doctor, orgB.id);
    nurseHeaders = await headers(nurse, orgA.id); receptionistHeaders = await headers(receptionist, orgA.id); rootHeaders = await headers(root);
    readOnlyHeaders = await headers(labTech, orgA.id);
    patientA = await Patient.create({ organizationId: orgA.id, userId: patientUser.id, name: "Patient A", phone: "9876500031" });
    patientB = await Patient.create({ organizationId: orgA.id, name: "Unrelated patient B", phone: "9876500032" });
    const patientC = await Patient.create({ organizationId: orgB.id, name: "Other tenant patient", phone: "9876500033" });
    familyLink = await FamilyRelationship.create({ userId: family.id, patientId: patientA.id, relationship: "guardian", status: "active" });
    const encounter = (patient: any, org: any, location: any) => Encounter.create({ organizationId: org.id, locationId: location.id, patientId: patient.id, doctorId: doctor.id });
    encounterA = await encounter(patientA, orgA, locationA); encounterB = await encounter(patientB, orgA, locationA); encounterC = await encounter(patientC, orgB, locationB);
    for (const item of [encounterA, encounterB, encounterC]) {
      await ObservationScore.create({ organizationId: item.organizationId, locationId: item.locationId, encounterId: item.id, patientId: item.patientId, algorithmId: "NEWS2", algorithmVersion: "test", totalScore: 7, riskCategory: "High", isComplete: true, parameterBreakdown: [{ code: "respiratory_rate", value: 30 }] });
    }
    prescriptionB = await Prescription.create({ organizationId: orgA.id, locationId: locationA.id, encounterId: encounterB.id, patientId: patientB.id, doctorId: doctor.id, medicineName: "Synthetic medicine", dosage: "1", frequency: "daily", duration: "1 day" });
    foreignPreset = await OpdTemplate.create({ title: "Tenant B private preset", organizationId: orgB.id, doctorId: doctor.id, isPublic: false });
    await OpdTemplate.create({ title: "Tenant A preset", organizationId: orgA.id, doctorId: doctor.id, isPublic: false });
    await SoapTemplate.create({ title: "Legacy tenant B public flag", specialty: "General", organizationId: orgB.id, isPublic: true });
    await SoapTemplate.create({ title: "Platform catalog template", specialty: "General", isPublic: true });
    for (const [org, location, value] of [[orgA, locationA, "80"], [orgB, locationB, "190"], [orgA, otherBranch, "175"]]) {
      const visit = await encounter(patientA, org, location);
      await Observation.create({ organizationId: org.id, locationId: location.id, encounterId: visit.id, patientId: patientA.id, recordedBy: doctor.id, code: "HR", name: "Heart rate", value, unit: "bpm" });
    }
  });
  afterAll(async () => { await app.close(); });

  it("denies unrelated same-tenant and cross-tenant encounter scores to portal users", async () => {
    for (const headers of [patientHeaders, familyHeaders]) for (const encounter of [encounterB, encounterC]) {
      const response = await app.inject({ method: "GET", url: `/api/encounters/${encounter.id}/scores`, headers });
      expect(response.statusCode, response.body).toBe(404);
      expect(response.body).not.toContain("respiratory_rate");
    }
  });

  it("allows own scores and active family authority, and applies revocation immediately", async () => {
    const url = `/api/encounters/${encounterA.id}/scores`;
    for (const headers of [patientHeaders, familyHeaders, readOnlyHeaders]) {
      const response = await app.inject({ method: "GET", url, headers });
      expect(response.statusCode, response.body).toBe(200); expect(response.json().data).toHaveLength(1);
    }
    await FamilyRelationship.updateOne({ _id: familyLink.id }, { $set: { status: "revoked" } });
    expect((await app.inject({ method: "GET", url, headers: familyHeaders })).statusCode).toBe(404);
  });

  it("denies score persistence to portal users and read-only clinical staff", async () => {
    const before = await ObservationScore.countDocuments();
    for (const headers of [patientHeaders, familyHeaders, readOnlyHeaders]) {
      const response = await app.inject({ method: "POST", url: `/api/encounters/${encounterA.id}/evaluate-score`, headers, payload: {} });
      expect(response.statusCode, response.body).toBe(403);
    }
    expect(await ObservationScore.countDocuments()).toBe(before);
  });

  it("preserves nurse scoring and staff tenant boundaries", async () => {
    const response = await app.inject({ method: "POST", url: `/api/encounters/${encounterA.id}/evaluate-score`, headers: nurseHeaders, payload: {} });
    expect(response.statusCode, response.body).toBe(201);
    expect((await app.inject({ method: "GET", url: `/api/encounters/${encounterC.id}/scores`, headers: doctorHeaders })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/encounters/invalid/scores", headers: patientHeaders })).statusCode).toBe(400);
  });

  it("denies another patient's prescription integrity metadata", async () => {
    expect((await app.inject({ method: "GET", url: `/api/prescriptions/${prescriptionB.id}/verify-integrity`, headers: patientHeaders })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/prescriptions/${prescriptionB.id}/verify-integrity`, headers: doctorHeaders })).statusCode).toBe(200);
  });

  it("isolates the same doctor's OPD templates by active workspace", async () => {
    const response = await app.inject({ method: "GET", url: "/api/clinical/opd-templates", headers: doctorHeaders });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.customPresets.map((item: any) => item.title)).toContain("Tenant A preset");
    expect(response.body).not.toContain("Tenant B private preset");
    const deletion = await app.inject({ method: "DELETE", url: `/api/clinical/opd-templates/${foreignPreset.id}`, headers: doctorHeaders });
    expect(deletion.statusCode, deletion.body).toBe(404);
    expect(await OpdTemplate.exists({ _id: foreignPreset.id })).toBeTruthy();
  });

  it("requires clinical write permission and validates template location references", async () => {
    const before = await OpdTemplate.countDocuments();
    expect((await app.inject({ method: "POST", url: "/api/clinical/opd-templates", headers: receptionistHeaders, payload: { title: "Unauthorized" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/clinical/opd-templates", headers: doctorHeaders, payload: { title: "Foreign branch", locationId: locationB.id } })).statusCode).toBe(404);
    expect(await OpdTemplate.countDocuments()).toBe(before);
    const allowed = await app.inject({ method: "POST", url: "/api/clinical/opd-templates", headers: doctorHeaders, payload: { title: "Authorized", locationId: locationA.id } });
    expect(allowed.statusCode, allowed.body).toBe(201);
  });

  it("keeps new SOAP templates private and excludes other tenants' legacy public flags", async () => {
    const created = await app.inject({ method: "POST", url: "/api/soap-templates", headers: doctorHeaders, payload: { title: "Private SOAP context", specialty: "General", subjective: "Synthetic sensitive clinical context" } });
    expect(created.statusCode, created.body).toBe(201); expect(created.json().data.isPublic).toBe(false);
    const other = await app.inject({ method: "GET", url: "/api/soap-templates", headers: doctorBHeaders });
    expect(other.body).not.toContain("Private SOAP context");
    const own = await app.inject({ method: "GET", url: "/api/soap-templates", headers: doctorHeaders });
    expect(own.statusCode).toBe(200); expect(own.body).toContain("Platform catalog template");
    expect(own.body).not.toContain("Legacy tenant B public flag");
  });

  it("reserves publication of global SOAP templates for platform root", async () => {
    const payload = { title: "Publish attempt", specialty: "General", isPublic: true };
    expect((await app.inject({ method: "POST", url: "/api/soap-templates", headers: doctorHeaders, payload })).statusCode).toBe(403);
    const allowed = await app.inject({ method: "POST", url: "/api/soap-templates", headers: rootHeaders, payload });
    expect(allowed.statusCode, allowed.body).toBe(201); expect(allowed.json().data.isPublic).toBe(true);
  });

  it("keeps default catalog setup working when private tenant templates already exist", async () => {
    await SoapTemplate.deleteMany({ organizationId: null });
    const privateCount = await SoapTemplate.countDocuments({ organizationId: orgA.id });
    const response = await app.inject({ method: "POST", url: "/api/soap-templates/seed", headers: doctorHeaders, payload: {} });
    expect(response.statusCode, response.body).toBe(201); expect(response.json().data).toHaveLength(3);
    expect(await SoapTemplate.countDocuments({ organizationId: orgA.id })).toBe(privateCount);
    expect(await SoapTemplate.countDocuments({ organizationId: null, isPublic: true })).toBe(3);
  });

  it("scopes staff vital trends to their organization and granted branches", async () => {
    await OrgMember.updateOne({ userId: doctor.id, organizationId: orgA.id }, { $set: { locationAccess: { mode: "selected", locationIds: [locationA.id] } } });
    const response = await app.inject({ method: "GET", url: `/api/patients/${patientA.id}/vital-trends`, headers: doctorHeaders });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.HR.map((point: any) => point.value)).toEqual(["80"]);
  });

  it("preserves a patient's own longitudinal vital trends without exposing other patients", async () => {
    const response = await app.inject({ method: "GET", url: `/api/patients/${patientA.id}/vital-trends`, headers: patientHeaders });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.HR.map((point: any) => point.value).sort()).toEqual(["175", "190", "80"]);
    expect((await app.inject({ method: "GET", url: `/api/patients/${patientB.id}/vital-trends`, headers: patientHeaders })).statusCode).toBe(404);
  });

  it("honors explicit scoring permission and rejects it after removal from a custom role", async () => {
    const role = await Role.create({ name: "score_operator", organizationId: orgA.id, permissions: ["VIEW_EHR", "EVALUATE_NEWS2"] });
    const user = await User.create({ name: "Scoring operator", role: role.name });
    await OrgMember.create({ userId: user.id, organizationId: orgA.id, role: role.name, locationAccess: { mode: "all" } });
    const headers = { cookie: `access_token=${await fixtureAccessToken({ id: user.id, role: role.name, email: "", organization_id: orgA.id })}` };
    const url = `/api/encounters/${encounterA.id}/evaluate-score`;
    expect((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode).toBe(201);
    await Role.updateOne({ _id: role.id }, { $set: { permissions: ["VIEW_EHR"] } });
    expect((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode).toBe(403);
  });
});
