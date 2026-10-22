import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Patient } from "../models/Patient.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { Encounter } from "../models/Encounter.ts";
import { Prescription } from "../models/Prescription.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { Invoice } from "../models/Invoice.ts";
import { PharmacyDispense } from "../models/PharmacyDispense.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { ScheduleH1Register } from "../models/ScheduleH1Register.ts";
import { PharmacyProfessionalReview } from "../models/PharmacyProfessionalReview.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { createAuthSession } from "../utilities/helpers.ts";
import { PrescriptionSealingService } from "../services/PrescriptionSealingService.ts";
import { dispenseMedicineFEFO } from "../services/PharmacyInventoryService.ts";
import { pharmacyTaxFixture } from "./helpers/pharmacyTaxFixture.ts";
import { pharmacyRestrictedFixture } from "./helpers/pharmacyRestrictedFixture.ts";

describe("Restricted supply and captured H/H1 register production path", () => {
  let organizationId: string, doctorId: string, actorId: string, adminId: string;
  let headers: { authorization: string }, adminHeaders: { authorization: string };
  beforeAll(async () => {
    organizationId = (await Organization.create({ name: "Synthetic restricted counter", city: "Pune" })).id;
    const auth = async (role: string) => {
      const user = await User.create({ name: `Synthetic ${role}`, role, email: `${crypto.randomUUID()}@example.test` });
      await OrgMember.create({ organizationId, userId: user.id, role, locationAccess: { mode: "all" } });
      return { user, headers: { authorization: `Bearer ${(await createAuthSession({ id: user.id, role, email: user.email!, organization_id: organizationId })).accessToken}` } };
    };
    const pharmacist = await auth("pharmacist"), admin = await auth("admin"), doctor = await auth("doctor");
    actorId = pharmacist.user.id; headers = pharmacist.headers; adminId = admin.user.id; adminHeaders = admin.headers; doctorId = doctor.user.id;
    await Promise.all([ScheduleH1Register.init(), PharmacyProfessionalReview.init(), PharmacyDispense.init(), OperationReceipt.init(), Invoice.init()]);
  });
  async function fixture(scheduleType: "general" | "schedule_h" | "schedule_h1" | "schedule_x" | "narcotic" = "schedule_h1", twoPrescriptions = false, authorizedQuantity?: number) {
    const location = await Location.create({ organizationId, name: "Synthetic branch", city: "Pune" });
    const medicine = await Medicine.create({ locationId: location.id, name: "Synthetic restricted medicine", genericName: "Synthetic formulation", manufacturer: "Synthetic maker",
      scheduleType, stockQuantity: 10, price: 12, costPrice: 5, expiryDate: new Date("2099-12-31"), batchNumber: "AGGREGATE-001",
      ...(authorizedQuantity ? { unitDefinition: { version: 1, baseUnit: "tablet", packUnit: "strip", unitsPerPack: 10 } } : {}) });
    const batches = await MedicineBatch.create([2, 8].map((quantity, i) => ({ medicineId: medicine.id, locationId: location.id,
      batchNumber: `SYNTHETIC-LOT-${i}`, expiryDate: new Date(i ? "2099-12-31" : "2098-12-31"), quantity, purchaseCost: 5, sellingPrice: 12 })));
    await pharmacyTaxFixture(location.id, [medicine.id], adminId);
    await pharmacyRestrictedFixture(location.id, medicine.id, organizationId, doctorId, actorId);
    const patient = await Patient.create({ organizationId, name: "Synthetic recipient", address: "Synthetic patient address" });
    const encounter = await Encounter.create({ organizationId, locationId: location.id, patientId: patient.id, doctorId, status: "completed" });
    const prescriptions = await Prescription.create(Array.from({ length: twoPrescriptions ? 2 : 1 }, () => ({ organizationId, locationId: location.id, patientId: patient.id, encounterId: encounter.id,
      doctorId, medicineId: medicine.id, medicineName: medicine.name, dosage: "Synthetic dose", frequency: "Daily", duration: "Synthetic course",
      ...(authorizedQuantity ? { authorizedQuantity, authorizedBaseUnit: "tablet" } : {}) })));
    for (const rx of prescriptions) await PrescriptionSealingService.sealPrescription(rx.id, doctorId);
    const note = await ClinicalNote.create({ organizationId, locationId: location.id, patientId: patient.id, encounterId: encounter.id, doctorId,
      subjective: { chiefComplaint: "Synthetic test" }, status: "signed", plan: { prescriptionIds: prescriptions.map((rx: { id: string }) => rx.id) },
      signature: { signerId: doctorId, signerName: "Synthetic doctor", signedAt: new Date() } });
    const body = { locationId: location.id, patientId: patient.id, doctorId, encounterId: encounter.id, prescriptionIds: prescriptions.map((rx: { id: string }) => rx.id),
      items: [{ medicineId: medicine.id, quantity: 4 }], prescriptionAllocations: prescriptions.map((rx: { id: string }, i: number) => ({ prescriptionId: rx.id, medicineId: medicine.id, quantity: twoPrescriptions ? (i ? 1 : 3) : 4 })) };
    return { location, medicine, batches, patient, encounter, prescriptions, note, body, key: crypto.randomUUID() };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const post = (f: Fixture) => app.inject({ method: "POST", url: "/api/pharmacy/dispense", headers: { ...headers, "idempotency-key": f.key }, payload: f.body });
  const professionalUrl = (f: Fixture) => `/api/pharmacy/locations/${f.location.id}/professionals/${actorId}/pharmacist`;
  const declaration = (expectedRevision = 1) => ({ expectedRevision, registrationNumber: "SYNTHETIC-PHARM-001", council: "Synthetic reviewed council", address: "Synthetic reviewed address", reviewReference: "Synthetic review only", validUntil: "2099-12-31T00:00:00Z", active: true });
  async function noSupply(f: Fixture) {
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
    expect((await MedicineBatch.find({ medicineId: f.medicine.id })).reduce((sum, batch) => sum + batch.quantity, 0)).toBe(10);
    for (const rx of f.prescriptions) expect((await Prescription.findById(rx.id))!.status).toBe("active");
    expect(await ScheduleH1Register.countDocuments({ medicineId: f.medicine.id })).toBe(0);
    expect(await PharmacyDispense.countDocuments({ patientId: f.patient.id })).toBe(0);
    expect(await Invoice.countDocuments({ patientId: f.patient.id })).toBe(0);
    expect(await StockMovement.countDocuments({ medicineId: f.medicine.id, kind: "dispense" })).toBe(0);
    expect(await OperationReceipt.countDocuments({ key: f.key })).toBe(0);
  }
  it("records separate H1 partial fills against one sealed allowance without duplicating a replayed register entry", async () => {
    const f = await fixture("schedule_h1", false, 10), prescriptionId = f.prescriptions[0].id;
    const partial = (quantity: number, revision: number, remaining: number) => ({ ...f.body, items: [{ medicineId: f.medicine.id, quantity }], prescriptionAllocations: [{ prescriptionId, medicineId: f.medicine.id, quantity, expectedFulfillmentRevision: revision, expectedRemainingQuantity: remaining }] });
    const headersFor = (key: string) => ({ ...headers, "idempotency-key": key });
    const firstBody = partial(3, 0, 10);
    const first = await app.inject({ method: "POST", url: "/api/pharmacy/dispense", headers: headersFor(f.key), payload: firstBody });
    expect(first.statusCode, first.body).toBe(201);
    const second = await app.inject({ method: "POST", url: "/api/pharmacy/dispense", headers: headersFor(crypto.randomUUID()), payload: partial(7, 1, 7) });
    expect(second.statusCode, second.body).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/pharmacy/dispense", headers: headersFor(f.key), payload: firstBody })).statusCode).toBe(200);
    const rows = await ScheduleH1Register.find({ medicineId: f.medicine.id }).lean();
    expect(rows).toHaveLength(3); expect(rows.reduce((sum, row) => sum + row.quantityDispensed, 0)).toBe(10);
    expect(new Set(rows.map(row => String(row.dispenseId))).size).toBe(2);
    expect(await Prescription.findById(prescriptionId)).toMatchObject({ status: "dispensed", suppliedQuantity: 10, fulfillmentRevision: 2 });
  });
  it.each(["schedule_h", "schedule_h1"] as const)("captures authentic %s lot/prescription links exactly once through the route", async type => {
    const f = await fixture(type, true);
    const first = await post(f); expect(first.statusCode, first.body).toBe(201);
    const rows = await ScheduleH1Register.find({ medicineId: f.medicine.id }).sort({ batchNumber: 1, prescriptionId: 1 }).lean();
    expect(rows).toHaveLength(3);
    expect(rows.reduce((sum, row) => sum + row.quantityDispensed, 0)).toBe(4);
    for (const row of rows) {
      expect(row).toMatchObject({ recordVersion: 1, patientName: "Synthetic recipient", patientAddress: "Synthetic patient address", doctorName: "Synthetic doctor", doctorAddress: "Synthetic reviewed professional address", doctorRegNumber: "SYNTHETIC-RMP-001", dispensedByName: "Synthetic pharmacist", pharmacistRegNumber: "SYNTHETIC-PHARM-001" });
      expect(String(row.invoiceId)).toBe(first.json().data.id); expect(String(row.clinicalNoteId)).toBe(f.note.id);
      expect(row.expiryDate).toBeTruthy(); expect(row.batchId).toBeTruthy(); expect(row.dispenseId).toBeTruthy();
    }
    await PharmacyProfessionalReview.updateOne({ locationId: f.location.id, profession: "pharmacist" }, { $set: { active: false } });
    expect((await post(f)).json().data).toEqual(first.json().data);
    expect(await ScheduleH1Register.countDocuments({ medicineId: f.medicine.id })).toBe(3);
  });
  it("does not create a statutory register row for general medicine", async () => {
    const f = await fixture("general"); expect((await post(f)).statusCode).toBe(201);
    expect(await ScheduleH1Register.countDocuments({ medicineId: f.medicine.id })).toBe(0);
  });
  it("accepts genuine short recipient names and lot labels", async () => {
    const f = await fixture(); await Patient.updateOne({ _id: f.patient.id }, { $set: { name: "Li" } });
    await MedicineBatch.updateOne({ _id: f.batches[0]._id }, { $set: { batchNumber: "1" } });
    const result = await post(f); expect(result.statusCode, result.body).toBe(201);
    expect((await ScheduleH1Register.findOne({ medicineId: f.medicine.id, batchNumber: "1" }))!.patientName).toBe("Li");
  });
  it.each(["schedule_x", "narcotic"] as const)("blocks %s regardless of reviewed credentials", async type => {
    const f = await fixture(type); expect((await post(f)).statusCode).toBe(409); await noSupply(f);
  });
  it.each(["pharmacist review", "expired qualification", "revoked qualification", "prescriber address", "patient address", "classification review", "changed classification", "doctor registration", "signature signer", "missing raw category"])("rolls back the entire supply for missing/stale %s", async reason => {
    const f = await fixture(); const scope = { locationId: f.location.id, profession: "pharmacist" as const };
    if (reason === "pharmacist review") await PharmacyProfessionalReview.deleteMany(scope);
    if (reason === "expired qualification") await PharmacyProfessionalReview.updateOne(scope, { $set: { validUntil: new Date("2000-01-01") } });
    if (reason === "revoked qualification") await PharmacyProfessionalReview.updateOne(scope, { $set: { active: false } });
    if (reason === "prescriber address") await PharmacyProfessionalReview.updateOne({ locationId: f.location.id, profession: "prescriber" }, { $set: { address: "Address Not Recorded" } });
    if (reason === "patient address") await Patient.updateOne({ _id: f.patient.id }, { $unset: { address: 1 } });
    if (reason === "classification review") await Medicine.updateOne({ _id: f.medicine.id }, { $unset: { dispensingReview: 1 } });
    if (reason === "changed classification") await Medicine.updateOne({ _id: f.medicine.id }, { $set: { "dispensingReview.scheduleType": "general" } });
    if (reason === "doctor registration") await PharmacyProfessionalReview.updateOne({ locationId: f.location.id, profession: "prescriber" }, { $set: { registrationNumber: "SYNTHETIC-OTHER-REG" } });
    if (reason === "signature signer") await ClinicalNote.collection.updateOne({ _id: f.note._id }, { $set: { "signature.signerId": new mongoose.Types.ObjectId() } });
    if (reason === "missing raw category") {
      await Medicine.collection.updateOne({ _id: f.medicine._id }, { $unset: { scheduleType: 1 } });
      expect((await app.inject({ method: "PUT", url: `/api/medicines/${f.medicine.id}`, headers, payload: { price: 13, scheduleType: "general" } })).statusCode).toBe(409);
      expect((await Medicine.collection.findOne({ _id: f.medicine._id }))!.scheduleType).toBeUndefined();
    }
    const result = await post(f); expect(result.statusCode, result.body).toBe(409); await noSupply(f);
  });
  it("fails closed for allocator calls with fabricated display strings and no trusted source", async () => {
    const f = await fixture();
    await expect(dispenseMedicineFEFO(f.medicine.id, f.location.id, 4, undefined, { organizationId, patientName: "Invented Patient", doctorName: "Invented Doctor", dispensedByName: "Invented Pharmacist" })).rejects.toThrow(/Restricted supply/);
    await noSupply(f);
  });
  it("preserves an actual aggregate lot, and refuses a missing lot label", async () => {
    const f = await fixture(); await MedicineBatch.deleteMany({ medicineId: f.medicine.id });
    const first = await post(f); expect(first.statusCode, first.body).toBe(201);
    expect((await ScheduleH1Register.findOne({ medicineId: f.medicine.id }))!.batchNumber).toBe("AGGREGATE-001");
    const missing = await fixture(); await MedicineBatch.deleteMany({ medicineId: missing.medicine.id });
    await Medicine.updateOne({ _id: missing.medicine.id }, { $unset: { batchNumber: 1 } });
    expect((await post(missing)).statusCode).toBe(409);
    expect((await Medicine.findById(missing.medicine.id))!.stockQuantity).toBe(10);
  });
  it("rolls back lot/aggregate/register/receipt when register creation fails", async () => {
    const f = await fixture(); const spy = vi.spyOn(ScheduleH1Register, "create").mockRejectedValueOnce(new Error("Synthetic register failure"));
    try { expect((await post(f)).statusCode).toBe(500); } finally { spy.mockRestore(); }
    await noSupply(f);
  });
  it("serializes different keys for a single prescription", async () => {
    const f = await fixture(); const results = await Promise.all([post(f), post({ ...f, key: crypto.randomUUID() })]);
    expect(results.map(result => result.statusCode).sort()).toEqual([201, 409]);
    expect(await ScheduleH1Register.countDocuments({ medicineId: f.medicine.id })).toBe(2);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(6);
  });
  it("uses organization-management authority, revisions and trusted review actor", async () => {
    const f = await fixture();
    expect((await app.inject({ method: "PUT", url: professionalUrl(f), headers, payload: declaration() })).statusCode).toBe(403);
    const reviewed = await app.inject({ method: "PUT", url: professionalUrl(f), headers: adminHeaders, payload: { ...declaration(), confirmedBy: actorId } });
    expect(reviewed.statusCode, reviewed.body).toBe(200); expect(reviewed.json().data.confirmedBy).toBe(adminId); expect(reviewed.json().data.revision).toBe(2);
    expect((await app.inject({ method: "PUT", url: professionalUrl(f), headers: adminHeaders, payload: declaration() })).statusCode).toBe(409);
    expect(await AuditLog.countDocuments({ action: "PHARMACY_PROFESSIONAL_REVIEWED", targetId: reviewed.json().data._id })).toBe(1);
  });
  it("prevents ordinary edits from removing restrictions, and audits an authorized classification review", async () => {
    const f = await fixture();
    expect((await app.inject({ method: "PUT", url: `/api/medicines/${f.medicine.id}`, headers, payload: { scheduleType: "general" } })).statusCode).toBe(409);
    const url = `/api/pharmacy/medicines/${f.medicine.id}/dispensing-classification`;
    const payload = { expectedRevision: 1, scheduleType: "schedule_h", reviewReference: "Synthetic reclassification review" };
    expect((await app.inject({ method: "PUT", url, headers, payload })).statusCode).toBe(403);
    const result = await app.inject({ method: "PUT", url, headers: adminHeaders, payload }); expect(result.statusCode, result.body).toBe(200);
    expect(result.json().data.costPrice).toBeUndefined(); expect(result.json().data.dispensingRevision).toBe(2);
    expect((await app.inject({ method: "PUT", url, headers: adminHeaders, payload })).statusCode).toBe(409);
    expect((await post(f)).statusCode).toBe(201);
  });
  it("flags historical gaps without inventing or overwriting fields", async () => {
    const f = await fixture(); expect((await post(f)).statusCode).toBe(201); const legacyId = new mongoose.Types.ObjectId();
    await ScheduleH1Register.collection.insertOne({ _id: legacyId, organizationId: new mongoose.Types.ObjectId(organizationId), locationId: f.location._id,
      medicineId: f.medicine._id, medicineName: "Historical medicine", scheduleType: "schedule_h1", batchNumber: "OLD", quantityDispensed: 1, patientId: f.patient._id, patientName: "Historical recipient", dispensedAt: new Date() });
    for (const suffix of ["", "/export"]) {
      const result = await app.inject({ method: "GET", url: `/api/pharmacy/schedule-h1-register${suffix}?locationId=${f.location.id}`, headers });
      expect(result.statusCode).toBe(200); expect(result.headers["cache-control"]).toBe("no-store"); const rows = suffix ? result.json().data.records : result.json().data;
      expect(rows.find((row: any) => row._id === legacyId.toString())).toMatchObject({ requiresReview: true, missingEvidence: expect.arrayContaining(["doctorAddress", "captured_supply_evidence"]) });
      expect(rows.filter((row: any) => row.recordVersion === 1).every((row: any) => row.requiresReview === false)).toBe(true);
    }
    expect((await ScheduleH1Register.collection.findOne({ _id: legacyId }))!.doctorAddress).toBeUndefined();
  });
  it("protects entries against save, query, delete and bulk rewriting", async () => {
    const f = await fixture(); expect((await post(f)).statusCode).toBe(201); const entry = (await ScheduleH1Register.findOne({ medicineId: f.medicine.id }))!;
    entry.patientName = "Rewritten"; await expect(entry.save()).rejects.toThrow(/append-only/);
    await expect(ScheduleH1Register.updateOne({ _id: entry._id }, { $set: { patientAddress: "Changed" } })).rejects.toThrow(/append-only/);
    await expect(entry.deleteOne()).rejects.toThrow(/append-only/);
    await expect(ScheduleH1Register.bulkWrite([{ deleteOne: { filter: { _id: entry._id } } }])).rejects.toThrow(/append-only/);
  });
  it("keeps H1 exports separate from H prescription entries", async () => {
    const f = await fixture("schedule_h"); expect((await post(f)).statusCode).toBe(201);
    const url = `/api/pharmacy/schedule-h1-register/export?locationId=${f.location.id}`;
    expect((await app.inject({ method: "GET", url, headers })).json().data.records).toEqual([]);
    const explicit = await app.inject({ method: "GET", url: `${url}&scheduleType=schedule_h`, headers });
    expect(explicit.json().data).toMatchObject({ scheduleType: "schedule_h", totalRecords: 2 });
    expect(explicit.json().data.records.every((row: any) => row.registerKind === "prescription")).toBe(true);
    expect((await app.inject({ method: "GET", url: `${url}&scheduleType=unknown`, headers })).statusCode).toBe(400);
  });
  it("reads scoped professional revisions and rejects foreign branch/subject configuration", async () => {
    const f = await fixture();
    const current = await app.inject({ method: "GET", url: professionalUrl(f), headers: adminHeaders });
    expect(current.statusCode).toBe(200); expect(current.headers["cache-control"]).toBe("no-store"); expect(current.json().data.revision).toBe(1);
    expect((await app.inject({ method: "GET", url: professionalUrl(f), headers })).statusCode).toBe(403);
    const foreignOrg = await Organization.create({ name: "Foreign synthetic organization", city: "Pune" });
    const foreignLocation = await Location.create({ organizationId: foreignOrg.id, name: "Foreign counter", city: "Pune" });
    const foreign = { ...f, location: foreignLocation };
    for (const method of ["GET", "PUT"] as const) {
      expect((await app.inject({ method, url: professionalUrl(foreign), headers: adminHeaders, ...(method === "PUT" ? { payload: declaration() } : {}) })).statusCode).toBe(404);
    }
    const foreignUser = await User.create({ name: "Foreign pharmacist", role: "pharmacist", email: `${crypto.randomUUID()}@example.test` });
    expect((await app.inject({ method: "PUT", url: professionalUrl(f).replace(actorId, foreignUser.id), headers: adminHeaders, payload: declaration(0) })).statusCode).toBe(404);
  });
  it("creates a new review once under concurrent stale submissions", async () => {
    const f = await fixture(); await PharmacyProfessionalReview.deleteMany({ locationId: f.location.id, profession: "pharmacist" });
    const put = () => app.inject({ method: "PUT", url: professionalUrl(f), headers: adminHeaders, payload: declaration(0) });
    const results = await Promise.all([put(), put()]); expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
    const record = await PharmacyProfessionalReview.findOne({ locationId: f.location.id, profession: "pharmacist" });
    expect(record!.revision).toBe(1); expect(String(record!.confirmedBy)).toBe(adminId);
  });
  it("serializes qualification revocation with a new supply and blocks subsequent supply", async () => {
    const f = await fixture();
    const [revoke, supply] = await Promise.all([
      app.inject({ method: "PUT", url: professionalUrl(f), headers: adminHeaders, payload: { ...declaration(), active: false } }), post(f),
    ]);
    expect(revoke.statusCode, revoke.body).toBe(200); expect([201, 409]).toContain(supply.statusCode);
    if (supply.statusCode === 409) await noSupply(f);
    else expect(await ScheduleH1Register.countDocuments({ medicineId: f.medicine.id })).toBe(2);
    const next = { ...f, key: crypto.randomUUID() }; expect((await post(next)).statusCode).toBe(409);
    expect((await PharmacyProfessionalReview.findOne({ locationId: f.location.id, profession: "pharmacist" }))!.active).toBe(false);
  });
  it("rolls back a professional review when its required audit fails", async () => {
    const f = await fixture(); const spy = vi.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("Synthetic review audit failure"));
    try { expect((await app.inject({ method: "PUT", url: professionalUrl(f), headers: adminHeaders, payload: declaration() })).statusCode).toBe(500); }
    finally { spy.mockRestore(); }
    const saved = await PharmacyProfessionalReview.findOne({ locationId: f.location.id, profession: "pharmacist" }); expect(saved!.revision).toBe(1);
  });
  it.each([{ address: "   " }, { registrationNumber: "NMC-UNSPECIFIED" }, { active: true, validUntil: "2000-01-01T00:00:00Z" }])("rejects unusable professional declarations %j", async change => {
    const f = await fixture();
    expect((await app.inject({ method: "PUT", url: professionalUrl(f), headers: adminHeaders, payload: { ...declaration(), ...change } })).statusCode).toBe(409);
  });
});
