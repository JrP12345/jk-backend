import crypto from "node:crypto";
import { pharmacyTaxFixture } from "./helpers/pharmacyTaxFixture.ts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { Patient } from "../models/Patient.ts";
import { Invoice } from "../models/Invoice.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Encounter } from "../models/Encounter.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { Prescription } from "../models/Prescription.ts";
import { PrescriptionSealingService } from "../services/PrescriptionSealingService.ts";
import { createAuthSession } from "../utilities/helpers.ts";

describe("Pharmacy stock mutation boundaries", () => {
  let locationId: string;
  let patientId: string;
  let headers: { authorization: string };
  let organizationId: string;
  let doctorId: string;

  beforeAll(async () => {
    const organization = await Organization.create({ name: "Stock validation", city: "Pune" });
    organizationId = organization.id;
    doctorId = (await User.create({ name: "Stock doctor", email: `${crypto.randomUUID()}@example.test`, role: "doctor" })).id;
    locationId = (await Location.create({ organizationId: organization.id, name: "Stock branch", city: "Pune" })).id;
    patientId = (await Patient.create({ organizationId: organization.id, name: "Stock patient", phone: "9000000000" })).id;
    const user = await User.create({ name: "Stock pharmacist", email: `${crypto.randomUUID()}@example.test`, role: "pharmacist" });
    await OrgMember.create({ organizationId: organization.id, userId: user.id, role: "pharmacist",
      locationAccess: { mode: "selected", locationIds: [locationId] } });
    const session = await createAuthSession({ id: user.id, role: user.role, email: user.email!, organization_id: organization.id });
    headers = { authorization: `Bearer ${session.accessToken}` };
  });

  async function stock(structured = false) {
    const medicine = await Medicine.create({ locationId, name: "Guarded stock", genericName: "Test generic",
      stockQuantity: 10, price: 10, costPrice: 5, expiryDate: new Date("2099-12-31"), batchNumber: "OPENING" });
    if (structured) await MedicineBatch.create({ medicineId: medicine.id, locationId, batchNumber: "LOT",
      expiryDate: new Date("2099-12-31"), quantity: 10, sellingPrice: 10, purchaseCost: 5 });
    return medicine;
  }

  async function connectedSupply(items: Array<{ medicineId: string; quantity: number }>) {
    await pharmacyTaxFixture(locationId, items.map(item => item.medicineId), doctorId);
    const encounter = await Encounter.create({ organizationId, locationId, patientId, doctorId, status: "completed" });
    const prescriptionIds: string[] = [];
    for (const item of items) {
      const rx = await Prescription.create({ organizationId, locationId, patientId, doctorId, encounterId: encounter.id,
        medicineId: item.medicineId, medicineName: "Guarded stock", dosage: "1 tablet", frequency: "Daily", duration: "2 days" });
      await PrescriptionSealingService.sealPrescription(rx.id, doctorId);
      prescriptionIds.push(rx.id);
    }
    await ClinicalNote.create({ organizationId, locationId, patientId, doctorId, encounterId: encounter.id,
      subjective: { chiefComplaint: "Stock test" }, status: "signed", plan: { prescriptionIds },
      signature: { signerId: doctorId, signerName: "Stock doctor", signedAt: new Date() } });
    return { patientId, locationId, doctorId, encounterId: encounter.id, prescriptionIds, items };
  }

  it.each([
    { stockQuantity: -1 }, { stockQuantity: 1.5 }, { stockQuantity: Number.MAX_SAFE_INTEGER + 1 },
    { stockQuantity: "2" }, { stockQuantity: null }, { price: -1 }, { costPrice: -1 },
    { price: "10" }, { costPrice: null }, { expiryDate: "invalid" }, { expiryDate: null },
  ])("rejects invalid metadata PUT before persisting any fields: %j", async payload => {
    const medicine = await stock();
    const response = await app.inject({ method: "PUT", url: `/api/medicines/${medicine.id}`, headers,
      payload: { name: "Must not persist", ...payload } });
    expect(response.statusCode, response.body).toBe(400);
    const stored = (await Medicine.findById(medicine.id))!;
    expect(stored.name).toBe("Guarded stock");
    expect(stored.stockQuantity).toBe(10);
    expect(stored.price).toBe(10);
    expect(stored.costPrice).toBe(5);
  });

  it("rejects structured quantity edits and keeps metadata edits with unchanged stock compatible", async () => {
    const medicine = await stock(true);
    const rejected = await app.inject({ method: "PUT", url: `/api/medicines/${medicine.id}`, headers,
      payload: { stockQuantity: 20, name: "Must not persist" } });
    expect(rejected.statusCode, rejected.body).toBe(409);
    expect((await Medicine.findById(medicine.id))!.name).toBe("Guarded stock");
    const adjusted = await app.inject({ method: "POST", url: "/api/pharmacy/adjust-stock", headers,
      payload: { medicineId: medicine.id, newQuantity: 20, reason: "physical_audit" } });
    expect(adjusted.statusCode, adjusted.body).toBe(409);
    const edited = await app.inject({ method: "PUT", url: `/api/medicines/${medicine.id}`, headers,
      payload: { stockQuantity: 10, name: "Renamed stock", price: 12, costPrice: 0 } });
    expect(edited.statusCode, edited.body).toBe(200);
    expect((await Medicine.findById(medicine.id))!.stockQuantity).toBe(10);
    expect((await MedicineBatch.findOne({ medicineId: medicine.id }))!.quantity).toBe(10);
    expect(await AuditLog.countDocuments({ targetId: medicine._id, action: "MEDICINE_STOCK_ADJUSTMENT" })).toBe(0);
  });

  it.each(["expired", "depleted"])("rejects absolute edits even when all structured batches are %s", async status => {
    const medicine = await stock(true);
    await MedicineBatch.updateOne({ medicineId: medicine.id }, { $set: { status, quantity: 0 } });
    for (const operation of [
      { method: "PUT" as const, url: `/api/medicines/${medicine.id}`, payload: { stockQuantity: 20 } },
      { method: "POST" as const, url: "/api/pharmacy/adjust-stock", payload: { medicineId: medicine.id, newQuantity: 20, reason: "restock" } },
    ]) expect((await app.inject({ ...operation, headers })).statusCode).toBe(409);
    expect((await Medicine.findById(medicine.id))!.stockQuantity).toBe(10);
  });

  it("preserves valid zero opening stock and legacy aggregate-only adjustment with its audit", async () => {
    const created = await app.inject({ method: "POST", url: "/api/medicines", headers,
      payload: { locationId, name: "Zero opening", genericName: "Test", stockQuantity: 0, price: 0,
        costPrice: 0, expiryDate: "2099-12-31", batchNumber: "ZERO" } });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().data.id;
    expect((await app.inject({ method: "PUT", url: `/api/medicines/${id}`, headers,
      payload: { stockQuantity: 4 } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/pharmacy/adjust-stock", headers,
      payload: { medicineId: id, newQuantity: 2, expectedQuantity: 0, expectedRevision: 0,
        clientRequestId: crypto.randomUUID(), reason: "physical_audit", notes: "Counted" } })).statusCode).toBe(200);
    expect((await Medicine.findById(id))!.stockQuantity).toBe(2);
    const audit = await AuditLog.findOne({ targetId: id, action: "MEDICINE_STOCK_ADJUSTMENT" });
    expect(audit?.details).toMatchObject({ oldQuantity: 0, newQuantity: 2, adjustmentDelta: 2 });
  });

  it("does not overwrite a deletion committed after an aggregate edit reads the medicine", async () => {
    const medicine = await stock();
    const save = Medicine.prototype.save;
    let deleted = false;
    const mock = vi.spyOn(Medicine.prototype, "save").mockImplementation(async function (this: typeof medicine, ...args: any[]) {
      if (this.id === medicine.id && !deleted) {
        deleted = true;
        // Native collection writes represent another connection and deliberately
        // bypass the request transaction's Mongoose session propagation.
        await Medicine.collection.updateOne({ _id: medicine._id }, { $set: { deletedAt: new Date() } }, { maxTimeMS: 5_000 });
      }
      return save.apply(this, args as Parameters<typeof save>);
    });
    try {
      const response = await app.inject({ method: "PUT", url: `/api/medicines/${medicine.id}`, headers,
        payload: { stockQuantity: 10, name: "Renamed during deletion" } });
      expect(deleted).toBe(true);
      expect(response.statusCode, response.body).toBe(404);
      const stored = (await Medicine.findById(medicine.id))!;
      expect(stored.stockQuantity).toBe(10);
      expect(stored.deletedAt).toBeTruthy();
    } finally { mock.mockRestore(); }
  });

  it("rejects legacy quantity edits through metadata PUT before writing", async () => {
    const medicine = await stock();
    const response = await app.inject({ method: "PUT", url: `/api/medicines/${medicine.id}`, headers,
      payload: { stockQuantity: 20 } });
    expect(response.statusCode, response.body).toBe(409);
    expect((await Medicine.findById(medicine.id))!.stockQuantity).toBe(10);
  });

  it("rolls back a legacy adjustment if its required audit fails", async () => {
    const medicine = await stock();
    const original = AuditLog.create.bind(AuditLog);
    const mock = vi.spyOn(AuditLog, "create").mockImplementation(((...args: any[]) => {
      const input = Array.isArray(args[0]) ? args[0][0] : args[0];
      if (input.action === "MEDICINE_STOCK_ADJUSTMENT") throw new Error("Injected audit failure");
      return (original as any)(...args);
    }) as typeof AuditLog.create);
    try {
      const response = await app.inject({ method: "POST", url: "/api/pharmacy/adjust-stock", headers,
        payload: { medicineId: medicine.id, newQuantity: 2, expectedQuantity: 10, expectedRevision: 0,
          clientRequestId: crypto.randomUUID(), reason: "physical_audit" } });
      expect(response.statusCode).toBe(500);
      expect((await Medicine.findById(medicine.id))!.stockQuantity).toBe(10);
    } finally { mock.mockRestore(); }
  });

  it.each([1.5, Number.MAX_SAFE_INTEGER + 1, -1])("rejects invalid absolute adjustment quantities: %s", async newQuantity => {
    const medicine = await stock();
    expect((await app.inject({ method: "POST", url: "/api/pharmacy/adjust-stock", headers,
      payload: { medicineId: medicine.id, newQuantity, reason: "physical_audit" } })).statusCode).toBe(400);
    expect((await Medicine.findById(medicine.id))!.stockQuantity).toBe(10);
  });

  it("excludes deleted medicines from receipt, adjustment and dispensing without creating invoices", async () => {
    const medicine = await stock(true);
    await Medicine.updateOne({ _id: medicine.id }, { $set: { deletedAt: new Date() } });
    for (const operation of [
      { url: "/api/pharmacy/batches", payload: { medicineId: medicine.id, locationId, batchNumber: "DELETED",
        expiryDate: "2099-12-31", quantity: 1, purchaseCost: 5, sellingPrice: 10 } },
      { url: "/api/pharmacy/adjust-stock", payload: { medicineId: medicine.id, newQuantity: 2, reason: "physical_audit" } },
      { url: "/api/pharmacy/dispense", payload: await connectedSupply([{ medicineId: medicine.id, quantity: 1 }]) },
    ]) expect((await app.inject({ method: "POST", ...operation, headers: { ...headers, "idempotency-key": crypto.randomUUID() } })).statusCode, operation.url).toBe(404);
    expect((await Medicine.findById(medicine.id))!.stockQuantity).toBe(10);
    expect(await MedicineBatch.countDocuments({ medicineId: medicine.id })).toBe(1);
    expect(await Invoice.countDocuments({ locationId })).toBe(0);
  });

  it("rolls back all allocations when another line has no eligible batches", async () => {
    const first = await stock(true);
    const second = await stock(true);
    await MedicineBatch.updateOne({ medicineId: second.id }, { $set: { status: "expired", expiryDate: new Date("2000-01-01") } });
    const response = await app.inject({ method: "POST", url: "/api/pharmacy/dispense", headers: { ...headers, "idempotency-key": crypto.randomUUID() },
      payload: await connectedSupply([{ medicineId: first.id, quantity: 2 }, { medicineId: second.id, quantity: 2 }]) });
    expect(response.statusCode, response.body).toBe(400);
    for (const medicine of [first, second]) {
      expect((await Medicine.findById(medicine.id))!.stockQuantity).toBe(10);
      expect((await MedicineBatch.findOne({ medicineId: medicine.id }))!.quantity).toBe(10);
    }
    expect(await Invoice.countDocuments({ locationId })).toBe(0);
  });
});
