import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../index.ts";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Role } from "../models/Role.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { Patient } from "../models/Patient.ts";
import { Encounter } from "../models/Encounter.ts";
import { Prescription } from "../models/Prescription.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { PrescriptionSealingService } from "../services/PrescriptionSealingService.ts";
import { ScheduleH1Register } from "../models/ScheduleH1Register.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { ModuleRegistry } from "../models/ModuleRegistry.ts";
import { createAuthSession } from "../utilities/helpers.ts";

async function principal(role: string, organizationId?: string, locationIds?: string[]) {
  const user = await User.create({ name: `Pharmacy ${role}`, email: `${crypto.randomUUID()}@example.test`, role });
  if (organizationId && !["root", "patient", "family_member", "guest"].includes(role)) {
    await OrgMember.create({ userId: user._id, organizationId, role,
      ...(locationIds ? { locationAccess: { mode: "selected", locationIds } } : {}) });
  }
  const session = await createAuthSession({ id: user.id, role, email: user.email!, organization_id: organizationId });
  return { user, headers: { authorization: `Bearer ${session.accessToken}` } };
}

async function branch(organizationId: string, label: string) {
  const location = await Location.create({ organizationId, name: label, city: "Pune" });
  const medicine = await Medicine.create({ locationId: location._id, name: `${label} stock`, genericName: "Test formulation",
    stockQuantity: 10, price: 80, costPrice: 37, batchNumber: label, expiryDate: new Date("2099-12-31") });
  const batch = await MedicineBatch.create({ organizationId, locationId: location._id, medicineId: medicine._id,
    batchNumber: label, expiryDate: new Date("2099-12-31"), quantity: 10, purchaseCost: 37, sellingPrice: 80 });
  const patient = await Patient.create({ organizationId, name: `${label} patient`, phone: "9000000000" });
  const doctor = await User.create({ name: `${label} doctor`, email: `${crypto.randomUUID()}@example.test`, role: "doctor" });
  const encounter = await Encounter.create({ organizationId, locationId: location._id, patientId: patient._id,
    doctorId: doctor._id, status: "completed" });
  const prescription = await Prescription.create({ organizationId, locationId: location._id, patientId: patient._id,
    doctorId: doctor._id, encounterId: encounter._id, medicineId: medicine._id,
    medicineName: medicine.name, dosage: "1 tablet", frequency: "once daily", duration: "1 day" });
  await PrescriptionSealingService.sealPrescription(prescription.id, doctor.id);
  await ClinicalNote.create({ organizationId, locationId: location.id, patientId: patient.id, doctorId: doctor.id, encounterId: encounter.id,
    subjective: { chiefComplaint: "Authorization fixture" }, status: "signed", plan: { prescriptionIds: [prescription.id] },
    signature: { signerId: doctor.id, signerName: doctor.name, signedAt: new Date() } });
  // Explicit historical incomplete row, bypassing new-write validation to test retained legacy access.
  const entry = { _id: new mongoose.Types.ObjectId(), organizationId: new mongoose.Types.ObjectId(organizationId), locationId: location._id, medicineId: medicine._id,
    medicineName: medicine.name, scheduleType: "schedule_h1", batchNumber: label,
    quantityDispensed: 1, patientId: patient._id, patientName: patient.name };
  await ScheduleH1Register.collection.insertOne(entry);
  return { location, medicine, batch, patient, prescription, entry: { ...entry, id: entry._id.toString() } };
}

type Branch = Awaited<ReturnType<typeof branch>>;
type Principal = Awaited<ReturnType<typeof principal>>;

const readUrls = (target: Branch) => [
  `/api/medicines?locationId=${target.location.id}`,
  `/api/pharmacy/medicines/${target.medicine.id}/batches`,
  `/api/pharmacy/expiring?locationId=${target.location.id}&days=36500`,
  `/api/pharmacy/pending-prescriptions?locationId=${target.location.id}`,
  `/api/pharmacy/prescriptions/pending?locationId=${target.location.id}`,
  `/api/pharmacy/schedule-h1-register?locationId=${target.location.id}`,
  `/api/pharmacy/schedule-h1-register/export?locationId=${target.location.id}`,
  `/api/pharmacy/medicines/${target.medicine.id}/stock-movements`,
];

const stockWrites = (target: Branch) => [
  { method: "POST" as const, url: "/api/medicines", payload: { locationId: target.location.id, name: "Unauthorized stock",
    genericName: "Test", stockQuantity: 1, price: 80, costPrice: 37, batchNumber: "unauthorized", expiryDate: "2099-12-31" } },
  { method: "PUT" as const, url: `/api/medicines/${target.medicine.id}`, payload: { name: "Unauthorized edit" } },
  { method: "DELETE" as const, url: `/api/medicines/${target.medicine.id}` },
  { method: "POST" as const, url: "/api/pharmacy/batches", payload: { medicineId: target.medicine.id,
    locationId: target.location.id, batchNumber: "unauthorized", expiryDate: "2099-12-31", quantity: 1, purchaseCost: 37, sellingPrice: 80 } },
  { method: "POST" as const, url: "/api/pharmacy/adjust-stock", payload: { medicineId: target.medicine.id, newQuantity: 100, reason: "physical_audit" } },
  { method: "POST" as const, url: "/api/pharmacy/dispense", payload: { patientId: target.patient.id,
    locationId: target.location.id, items: [{ medicineId: target.medicine.id, quantity: 1 }] } },
];

describe("Pharmacy operational API authorization", () => {
  let organizationId: string;
  let otherOrganizationId: string;
  let allowed: Branch;
  let sibling: Branch;
  let foreign: Branch;
  let pharmacist: Principal;
  let reader: Principal;
  let admin: Principal;
  let root: Principal;
  const consumers: Record<string, Principal> = {};

  beforeAll(async () => {
    organizationId = (await Organization.create({ name: "Pharmacy A", city: "Pune" })).id;
    otherOrganizationId = (await Organization.create({ name: "Pharmacy B", city: "Pune" })).id;
    allowed = await branch(organizationId, "Allowed branch");
    sibling = await branch(organizationId, "Unassigned branch");
    foreign = await branch(otherOrganizationId, "Other tenant");
    pharmacist = await principal("pharmacist", organizationId, [allowed.location.id]);
    await Role.create({ name: "pharmacy_reader", organizationId, permissions: ["VIEW_EHR"] });
    reader = await principal("pharmacy_reader", organizationId, [allowed.location.id]);
    admin = await principal("admin", organizationId);
    root = await principal("root");
    for (const role of ["patient", "family_member", "guest"]) consumers[role] = await principal(role, organizationId);
  });

  it("requires an authenticated session", async () => {
    expect((await app.inject({ method: "GET", url: "/api/medicines" })).statusCode).toBe(401);
  });

  it("protects operation lookup with current management and branch authority", async () => {
    const url = (branch: Branch) => `/api/pharmacy/dispense-operations/fixture-key?locationId=${branch.location.id}`;
    for (const role of ["patient", "family_member", "guest"]) expect((await app.inject({ method: "GET", url: url(allowed), headers: consumers[role].headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: url(allowed), headers: reader.headers })).statusCode).toBe(403);
    for (const branch of [sibling, foreign]) expect((await app.inject({ method: "GET", url: url(branch), headers: pharmacist.headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/pharmacy/dispense-operations/fixture-key", headers: pharmacist.headers })).statusCode).toBe(400);
  });

  it.each(["patient", "family_member", "guest"])("denies %s access to every operational pharmacy read", async role => {
    for (const url of [...readUrls(allowed), ...readUrls(foreign), "/api/medicines", "/api/pharmacy/schedule-h1-register"]) {
      const response = await app.inject({ method: "GET", url, headers: consumers[role].headers });
      expect(response.statusCode, url).toBe(403);
      expect(response.json().data, url).toBeUndefined();
    }
  });

  it.each(["patient", "family_member", "guest"])("denies %s writes even if a role document grants medicine management", async role => {
    const grant = await Role.create({ name: role, organizationId, permissions: ["VIEW_EHR", "MANAGE_MEDICINES"] });
    try {
      for (const operation of stockWrites(allowed)) {
        expect((await app.inject({ ...operation, headers: consumers[role].headers })).statusCode, operation.url).toBe(403);
      }
    } finally {
      await Role.deleteOne({ _id: grant._id });
    }
  });

  it("limits a location-free catalogue read to assigned branches and ignores forged tenant headers", async () => {
    const response = await app.inject({ method: "GET", url: "/api/medicines", headers: {
      ...pharmacist.headers, "x-organization-id": otherOrganizationId, "x-location-id": sibling.location.id,
    } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((item: { id: string }) => item.id)).toEqual([allowed.medicine.id]);
  });

  it("retains authorized pharmacist reads, both queue aliases and management costs", async () => {
    for (const url of readUrls(allowed)) expect((await app.inject({ method: "GET", url, headers: pharmacist.headers })).statusCode, url).toBe(200);
    const catalogue = await app.inject({ method: "GET", url: `/api/medicines?locationId=${allowed.location.id}`, headers: pharmacist.headers });
    expect(catalogue.json().data[0].costPrice).toBe(37);
    const batches = await app.inject({ method: "GET", url: readUrls(allowed)[1], headers: pharmacist.headers });
    expect(batches.json().data[0].purchaseCost).toBe(37);
    const pending = await app.inject({ method: "GET", url: readUrls(allowed)[3], headers: pharmacist.headers });
    expect(pending.json().data[0].prescriptions[0].id).toBe(allowed.prescription.id);
  });

  it("preserves read-only staff stock and queue access without exposing acquisition costs", async () => {
    for (const url of readUrls(allowed).slice(0, 3)) {
      const response = await app.inject({ method: "GET", url, headers: reader.headers });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toHaveLength(1);
      expect(response.json().data[0]).not.toHaveProperty("costPrice");
      expect(response.json().data[0]).not.toHaveProperty("purchaseCost");
    }
    expect((await app.inject({ method: "GET", url: readUrls(allowed)[3], headers: reader.headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: readUrls(allowed)[6], headers: reader.headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: readUrls(allowed)[7], headers: reader.headers })).statusCode).toBe(403);
    for (const operation of stockWrites(allowed)) expect((await app.inject({ ...operation, headers: reader.headers })).statusCode).toBe(403);
  });

  it.each(["sibling", "foreign"])("rejects direct %s branch reads and writes, including the register", async target => {
    const denied = target === "sibling" ? sibling : foreign;
    for (const url of readUrls(denied)) expect((await app.inject({ method: "GET", url, headers: pharmacist.headers })).statusCode, url).toBe(404);
    for (const operation of stockWrites(denied)) expect((await app.inject({ ...operation, headers: pharmacist.headers })).statusCode, operation.url).toBe(404);
  });

  it.each(["/api/pharmacy/schedule-h1-register", "/api/pharmacy/schedule-h1-register/export"])("scopes %s without a location before counting or exporting", async url => {
    const response = await app.inject({ method: "GET", url, headers: pharmacist.headers });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const records = Array.isArray(body.data) ? body.data : body.data.records;
    expect(records.map((entry: { _id: string }) => entry._id)).toEqual([allowed.entry.id]);
    expect(body.pagination?.total ?? body.data.totalRecords).toBe(1);
  });

  it("preserves organization-wide administrator reads without leaking another tenant", async () => {
    const response = await app.inject({ method: "GET", url: "/api/pharmacy/schedule-h1-register/export", headers: admin.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.records.map((entry: { locationId: string }) => entry.locationId).sort())
      .toEqual([allowed.location.id, sibling.location.id].sort());
  });

  it("returns no location-free records and denies direct access for an explicitly empty branch grant", async () => {
    const unassigned = await principal("pharmacist", organizationId, []);
    for (const url of ["/api/medicines", "/api/pharmacy/schedule-h1-register", "/api/pharmacy/schedule-h1-register/export"]) {
      const response = await app.inject({ method: "GET", url, headers: unassigned.headers });
      expect(response.statusCode).toBe(200);
      expect(Array.isArray(response.json().data) ? response.json().data : response.json().data.records).toEqual([]);
    }
    expect((await app.inject({ method: "GET", url: readUrls(allowed)[5], headers: unassigned.headers })).statusCode).toBe(404);
  });

  it("keeps legacy clinical staff branch assignments for catalogue and register reads", async () => {
    const doctor = await principal("doctor", organizationId);
    await DoctorAssignment.create({ organizationId, doctorId: doctor.user._id, locationId: allowed.location._id,
      workingHours: "[]", isActive: true });
    expect((await app.inject({ method: "GET", url: readUrls(allowed)[0], headers: doctor.headers })).statusCode).toBe(200);
    const response = await app.inject({ method: "GET", url: "/api/pharmacy/schedule-h1-register", headers: doctor.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((entry: { _id: string }) => entry._id)).toEqual([allowed.entry.id]);
  });

  it("does not accept a query or body organization as staff authority", async () => {
    for (const url of ["/api/medicines", "/api/pharmacy/schedule-h1-register", "/api/pharmacy/schedule-h1-register/export"]) {
      expect((await app.inject({ method: "GET", url: `${url}?organizationId=${otherOrganizationId}`, headers: pharmacist.headers })).statusCode).toBe(403);
    }
    const response = await app.inject({ method: "PUT", url: `/api/medicines/${allowed.medicine.id}`,
      headers: pharmacist.headers, payload: { organizationId: otherOrganizationId, name: "Forged tenant" } });
    expect(response.statusCode).toBe(403);
  });

  it("fails closed without an organization even when staff supply a foreign location", async () => {
    const unscoped = await principal("pharmacist");
    for (const url of readUrls(allowed)) expect((await app.inject({ method: "GET", url, headers: unscoped.headers })).statusCode).toBe(403);
  });

  it("allows root register access only with consistent explicit organization or location context", async () => {
    expect((await app.inject({ method: "GET", url: "/api/pharmacy/schedule-h1-register/export", headers: root.headers })).statusCode).toBe(400);
    const locationScoped = await app.inject({ method: "GET", url: readUrls(foreign)[6], headers: root.headers });
    expect(locationScoped.statusCode).toBe(200);
    expect(locationScoped.json().data.records.map((entry: { _id: string }) => entry._id)).toEqual([foreign.entry.id]);
    const orgScoped = await app.inject({ method: "GET", url: `/api/pharmacy/schedule-h1-register?organizationId=${otherOrganizationId}`, headers: root.headers });
    expect(orgScoped.statusCode).toBe(200);
    expect(orgScoped.json().data.map((entry: { _id: string }) => entry._id)).toEqual([foreign.entry.id]);
    expect((await app.inject({ method: "GET", url: `${readUrls(foreign)[6]}&organizationId=${organizationId}`, headers: root.headers })).statusCode).toBe(404);
  });

  it("rejects malformed register locations and handles a valid nonexistent location without exposing records", async () => {
    for (const suffix of ["", "/export"]) {
      expect((await app.inject({ method: "GET", url: `/api/pharmacy/schedule-h1-register${suffix}?locationId=invalid`, headers: pharmacist.headers })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: `/api/pharmacy/schedule-h1-register${suffix}?locationId=${new mongoose.Types.ObjectId()}`, headers: pharmacist.headers })).statusCode).toBe(404);
    }
  });

  it("applies live branch and role revocation to register reads", async () => {
    const staff = await principal("pharmacist", organizationId, [allowed.location.id]);
    await OrgMember.updateOne({ userId: staff.user._id, organizationId }, { $set: { "locationAccess.locationIds": [] } });
    expect((await app.inject({ method: "GET", url: readUrls(allowed)[5], headers: staff.headers })).statusCode).toBe(404);
    const scoped = await app.inject({ method: "GET", url: "/api/pharmacy/schedule-h1-register", headers: staff.headers });
    expect(scoped.json().data).toEqual([]);
    const role = await Role.create({ name: "pharmacy_revocable", organizationId, permissions: ["VIEW_EHR"] });
    const revocable = await principal("pharmacy_revocable", organizationId, [allowed.location.id]);
    expect((await app.inject({ method: "GET", url: readUrls(allowed)[5], headers: revocable.headers })).statusCode).toBe(200);
    await Role.updateOne({ _id: role._id }, { $set: { permissions: [] } });
    expect((await app.inject({ method: "GET", url: readUrls(allowed)[5], headers: revocable.headers })).statusCode).toBe(403);
  });

  it("retains organization module gating", async () => {
    const toggle = await ModuleRegistry.create({ organizationId, moduleKey: "pharmacy", enabled: false, priority: "P1", label: "Pharmacy" });
    try {
      expect((await app.inject({ method: "GET", url: readUrls(allowed)[0], headers: pharmacist.headers })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: readUrls(allowed)[5], headers: pharmacist.headers })).statusCode).toBe(403);
    } finally {
      await ModuleRegistry.deleteOne({ _id: toggle._id });
    }
  });
});
