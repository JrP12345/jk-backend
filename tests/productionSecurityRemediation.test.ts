import { fixtureAccessToken } from "./helpers/sessionFixture.ts";
import { describe, it, expect } from "vitest";
import app from "../index.ts";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { FamilyRelationship } from "../models/FamilyRelationship.ts";
import { OutboundMessage } from "../models/OutboundMessage.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { Invoice } from "../models/Invoice.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { DocumentUpload } from "../models/DocumentUpload.ts";
import { contextEngine } from "../services/ai/ContextEngine.ts";
import { Role } from "../models/Role.ts";
import { getEffectivePermissions } from "../utilities/permissions.ts";

describe("Production security remediation", () => {
  async function tenant(name: string) {
    const org = await Organization.create({ name, city: "Test City" });
    const location = await Location.create({ name: `${name} Clinic`, city: "Test City", organizationId: org._id });
    const admin = await User.create({ name: `${name} Admin`, role: "admin" });
    await OrgMember.create({ userId: admin._id, organizationId: org._id, role: "admin" });
    const cookie = `access_token=${(await fixtureAccessToken({ id: admin.id, email: "", role: "admin", organization_id: org.id }))}`;
    return { org, location, admin, cookie };
  }

  it("keeps anonymous booking contact out of an existing account's recovery identity", async () => {
    const user = await User.create({ name: "Patient 9123400001", phone: "9123400001", role: "patient", authMethod: "phone_otp" });
    const patient = await Patient.create({ userId: user._id, name: user.name, phone: user.phone });
    const response = await app.inject({ method: "POST", url: "/api/public/booking-session", payload: {
      name: "Unverified booking name", phone: user.phone, email: "unverified-recovery@example.invalid",
    } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.user.role).toBe("guest");
    const unchanged = await User.findById(user._id);
    expect(unchanged?.email).toBeUndefined();
    expect(unchanged?.name).toBe(user.name);
    expect((await Patient.findById(patient._id))?.name).toBe(patient.name);
    expect(await FamilyRelationship.countDocuments({ userId: user._id })).toBe(0);
    const bookingPatient = await Patient.findById(response.json().data.patient.id);
    expect(bookingPatient?.email).toBe("unverified-recovery@example.invalid");
    expect(bookingPatient?.userId).toBeUndefined();
    expect(bookingPatient?.accountType).toBe("walkin");
    const emailsBefore = await OutboundMessage.countDocuments({ kind: "transactional_email" });
    await app.inject({ method: "POST", url: "/api/auth/forgot-password", payload: { email: "unverified-recovery@example.invalid" } });
    expect((await User.findById(user._id))?.passwordResetToken).toBeUndefined();
    expect(await OutboundMessage.countDocuments({ kind: "transactional_email" })).toBe(emailsBefore);
  });

  it("does not bind an attacker phone to an existing email-only account", async () => {
    const victim = await User.create({ name: "Email-only patient", email: "existing-email@example.invalid", role: "patient" });
    const response = await app.inject({ method: "POST", url: "/api/public/booking-session", payload: {
      name: "Guest", phone: "9123400002", email: victim.email,
    } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.user.id).not.toBe(victim.id);
    expect((await User.findById(victim._id))?.phone).toBeUndefined();
    expect((await User.findById(response.json().data.user.id))?.email).toBeUndefined();
  });

  it("does not rewrite legacy phone spelling or existing clinical contact fields", async () => {
    const user = await User.create({ name: "Patient Legacy", phone: "+919123400003", role: "patient" });
    const patient = await Patient.create({ userId: user._id, name: user.name, phone: user.phone });
    const response = await app.inject({ method: "POST", url: "/api/public/booking-session", payload: {
      name: user.name, phone: "9123400003", email: "new-contact@example.invalid",
    } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.patient.id).toBe(patient.id);
    expect((await User.findById(user._id))?.phone).toBe(user.phone);
    expect((await Patient.findById(patient._id))?.email).toBeUndefined();
  });

  it("rejects a foreign clinic filter and explicitly scopes analytics aggregation", async () => {
    const a = await tenant("Analytics A");
    const b = await tenant("Analytics B");
    // Include an inconsistent location/org pair to verify the explicit aggregate
    // organization condition as well as location ownership validation.
    await Invoice.collection.insertMany([
      { invoiceNumber: "AUDIT-B", organizationId: b.org._id, locationId: b.location._id, status: "paid", totalAmount: 777 },
      { invoiceNumber: "AUDIT-INCONSISTENT", organizationId: b.org._id, locationId: a.location._id, status: "paid", totalAmount: 888 },
      { invoiceNumber: "AUDIT-A", organizationId: a.org._id, locationId: a.location._id, status: "paid", totalAmount: 123 },
    ]);
    const foreign = await app.inject({ method: "GET", url: `/api/analytics/executive?locationId=${b.location.id}`, headers: { cookie: a.cookie } });
    expect(foreign.statusCode, foreign.body).toBe(404);
    const own = await app.inject({ method: "GET", url: `/api/analytics/executive?locationId=${a.location.id}`, headers: { cookie: a.cookie } });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().data.overall.totalRevenue).toBe(123);
    const root = await User.create({ name: "Analytics Root", role: "root" });
    const rootCookie = `access_token=${(await fixtureAccessToken({ id: root.id, email: "", role: "root" }))}`;
    const global = await app.inject({ method: "GET", url: `/api/analytics/executive?locationId=${b.location.id}`, headers: { cookie: rootCookie } });
    expect(global.statusCode, global.body).toBe(200);
    expect(global.json().data.overall.totalRevenue).toBe(777);
    const empty = await Organization.create({ name: "Empty root scope", city: "Test" });
    const scopedRoot = await app.inject({ method: "GET", url: `/api/analytics/executive?organizationId=${empty.id}`, headers: { cookie: rootCookie } });
    expect(scopedRoot.json().data.overall.totalRevenue).toBe(0);
  });

  it("keeps empty-tenant AI context empty and does not let a route grant financial permissions", async () => {
    const b = await tenant("AI B");
    await Invoice.collection.insertOne({ invoiceNumber: "AUDIT-AI-B", organizationId: b.org._id, locationId: b.location._id, status: "paid", totalAmount: 777 });
    const emptyOrg = await Organization.create({ name: "AI Empty", city: "Test" });
    const admin = await User.create({ name: "AI Empty Admin", role: "admin" });
    await OrgMember.create({ userId: admin._id, organizationId: emptyOrg._id, role: "admin" });
    const empty = await contextEngine.build6DContext({ userId: admin.id, organizationId: emptyOrg.id, currentRoute: "/billing" });
    expect(empty.organizationContext).not.toContain("AI B Clinic");
    expect(empty.organizationContext).not.toContain("777");
    expect(empty.organizationContext).toContain("Active Locations (0)");
    const nurse = await User.create({ name: "AI Nurse", role: "nurse" });
    await OrgMember.create({ userId: nurse._id, organizationId: b.org._id, role: "nurse" });
    const forbidden = await contextEngine.build6DContext({ userId: nurse.id, organizationId: b.org.id, currentRoute: "/billing", userRole: "admin" });
    expect(forbidden.organizationContext).not.toContain("Revenue");
    expect(forbidden.organizationContext).not.toContain("777");
    const allowed = await contextEngine.build6DContext({ userId: b.admin.id, organizationId: b.org.id, currentRoute: "/billing" });
    expect(allowed.organizationContext).toContain("777");
  });

  it("denies another patient's documents and AI context while allowing self and verified family", async () => {
    const org = await Organization.create({ name: "Consumer ownership", city: "Test" });
    const victim = await User.create({ name: "Victim", role: "patient" });
    const consumer = await User.create({ name: "Other patient", role: "patient" });
    const patient = await Patient.create({ userId: victim._id, organizationId: org._id, conditions: ["PRIVATE-CONDITION"] });
    await DocumentUpload.create({ patientId: patient._id, organizationId: org._id, fileName: "Private.pdf", fileUrl: "private-key", mimeType: "application/pdf", uploadedByUserId: victim._id });
    const cookie = `access_token=${(await fixtureAccessToken({ id: consumer.id, email: "", role: "patient", organization_id: org.id }))}`;
    const denied = await app.inject({ method: "GET", url: `/api/documents/patient/${patient.id}`, headers: { cookie } });
    expect(denied.statusCode, denied.body).toBe(404);
    await expect(contextEngine.build6DContext({ userId: consumer.id, organizationId: org.id, activePatientId: patient.id })).rejects.toThrow("Patient not found");
    const own = await contextEngine.build6DContext({ userId: victim.id, organizationId: org.id, activePatientId: patient.id });
    expect(own.patientRecordContext).toContain("PRIVATE-CONDITION");
    await FamilyRelationship.create({ userId: consumer._id, patientId: patient._id, relationship: "other", status: "active" });
    const family = await app.inject({ method: "GET", url: `/api/documents/patient/${patient.id}`, headers: { cookie } });
    expect(family.statusCode, family.body).toBe(200);
    const familyContext = await contextEngine.build6DContext({ userId: consumer.id, organizationId: org.id, activePatientId: patient.id });
    expect(familyContext.patientRecordContext).toContain("PRIVATE-CONDITION");
  });

  it("creates tenant role overrides without editing global roles or another tenant's custom roles", async () => {
    const a = await tenant("Roles A");
    const b = await tenant("Roles B");
    const global = await Role.create({ name: "doctor", organizationId: null, isSystemRole: true, permissions: ["VIEW_EHR"] });
    const other = await Role.create({ name: "custom_review", organizationId: b.org._id, permissions: ["VIEW_EHR"] });
    const update = await app.inject({ method: "PUT", url: "/api/roles/doctor", headers: { cookie: a.cookie }, payload: { permissions: [] } });
    expect(update.statusCode, update.body).toBe(200);
    expect((await Role.findById(global._id))?.permissions).toEqual(["VIEW_EHR"]);
    expect((await Role.findOne({ name: "doctor", organizationId: a.org._id }))?.permissions).toEqual([]);
    expect((await getEffectivePermissions("doctor", a.org.id)).size).toBe(0);
    expect(await getEffectivePermissions("doctor", b.org.id)).toEqual(new Set(["VIEW_EHR"]));
    const remove = await app.inject({ method: "DELETE", url: "/api/roles/custom_review", headers: { cookie: a.cookie } });
    expect(remove.statusCode, remove.body).toBe(404);
    expect(await Role.exists({ _id: other._id })).toBeTruthy();
    const list = await app.inject({ method: "GET", url: "/api/roles", headers: { cookie: a.cookie } });
    expect(list.statusCode, list.body).toBe(200);
    const doctors = list.json().data.filter((role: any) => role.name === "doctor");
    expect(doctors).toHaveLength(1);
    expect(doctors[0].permissions).toEqual([]);
  });
});
