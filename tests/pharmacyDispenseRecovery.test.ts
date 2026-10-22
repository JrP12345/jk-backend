import crypto from "node:crypto";
import { pharmacyTaxFixture } from "./helpers/pharmacyTaxFixture.ts";
import mongoose from "mongoose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { Patient } from "../models/Patient.ts";
import { Encounter } from "../models/Encounter.ts";
import { Prescription } from "../models/Prescription.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { PrescriptionSealingService } from "../services/PrescriptionSealingService.ts";
import { Invoice } from "../models/Invoice.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { ScheduleH1Register } from "../models/ScheduleH1Register.ts";
import { pharmacyRestrictedFixture } from "./helpers/pharmacyRestrictedFixture.ts";
import { createAuthSession } from "../utilities/helpers.ts";
import { executePharmacyDispense } from "../services/PharmacyOperationService.ts";
import { dispenseMedicineFEFO } from "../services/PharmacyInventoryService.ts";
import * as websocket from "../notifications/websocket.ts";

describe("Recorded pharmacy dispensing and recovery", () => {
  let organizationId: string;
  let locationId: string;
  let actorId: string;
  let doctorId: string;
  let headers: { authorization: string };

  beforeAll(async () => {
    organizationId = (await Organization.create({ name: "Dispense recovery", city: "Pune" })).id;
    locationId = (await Location.create({ organizationId, name: "Recovery counter", city: "Pune" })).id;
    const user = await User.create({ name: "Recovery pharmacist", email: `${crypto.randomUUID()}@example.test`, role: "pharmacist" });
    actorId = user.id;
    doctorId = (await User.create({ name: "Recovery doctor", email: `${crypto.randomUUID()}@example.test`, role: "doctor" })).id;
    await OrgMember.create({ organizationId, userId: actorId, role: "pharmacist", locationAccess: { mode: "selected", locationIds: [locationId] } });
    const session = await createAuthSession({ id: actorId, role: user.role, email: user.email!, organization_id: organizationId });
    headers = { authorization: `Bearer ${session.accessToken}` };
    await Promise.all([OperationReceipt.init(), StockMovement.init()]);
  });

  async function fixture(scheduleType: "general" | "schedule_h1" = "general") {
    const medicine = await Medicine.create({ locationId, name: "Recovery medicine", genericName: "Test formulation",
      stockQuantity: 10, price: 12, costPrice: 5, scheduleType, expiryDate: new Date("2099-12-31"), batchNumber: "LEGACY" });
    const batch = await MedicineBatch.create({ medicineId: medicine.id, locationId, batchNumber: "TRACKED",
      expiryDate: new Date("2099-12-31"), quantity: 10, purchaseCost: 5, sellingPrice: 12 });
    const patient = await Patient.create({ organizationId, name: "Recovery patient", phone: "9000000000", address: "Synthetic recipient address" });
    if (scheduleType !== "general") await pharmacyRestrictedFixture(locationId, medicine.id, organizationId, doctorId, actorId);
    const encounter = await Encounter.create({ organizationId, locationId, patientId: patient.id, doctorId, status: "completed" });
    const prescription = await Prescription.create({ organizationId, locationId, patientId: patient.id, encounterId: encounter.id,
      doctorId, medicineId: medicine.id, medicineName: medicine.name, dosage: "1 tablet", frequency: "Daily", duration: "2 days" });
    await PrescriptionSealingService.sealPrescription(prescription.id, doctorId);
    await ClinicalNote.create({ organizationId, locationId, patientId: patient.id, encounterId: encounter.id, doctorId,
      subjective: { chiefComplaint: "Recovery test" }, status: "signed", plan: { prescriptionIds: [prescription.id] },
      signature: { signerId: doctorId, signerName: "Recovery doctor", signedAt: new Date() } });
    const body = { patientId: patient.id, doctorId, locationId, encounterId: encounter.id,
      prescriptionIds: [prescription.id], items: [{ medicineId: medicine.id, quantity: 2 }] };
    await pharmacyTaxFixture(locationId, [medicine.id], actorId);
    return { medicine, batch, patient, encounter, prescription, body, key: crypto.randomUUID() };
  }
  const post = (body: Record<string, unknown>, key?: string) => app.inject({ method: "POST", url: "/api/pharmacy/dispense",
    headers: { ...headers, ...(key ? { "idempotency-key": key } : {}) }, payload: body });
  const lookup = (key: string, location = locationId, auth = headers) => app.inject({ method: "GET",
    url: `/api/pharmacy/dispense-operations/${key}?locationId=${location}`, headers: auth });

  it("requires a stable key before business writes", async () => {
    const f = await fixture();
    expect((await post(f.body)).statusCode).toBe(428);
    expect((await post(f.body, "bad")).statusCode).toBe(428);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
    expect(await Invoice.countDocuments({ patientId: f.patient.id })).toBe(0);
  });

  it("recovers a lost response and replays exactly after stock, prescription and invoice change", async () => {
    const f = await fixture();
    const first = await post(f.body, f.key);
    expect(first.statusCode, first.body).toBe(201);
    const data = first.json().data;
    expect(data.dispenseOperation).toMatchObject({ version: 1, key: f.key, addedAmount: 24, appendedToExisting: false });
    expect(data.dispenseOperation.allocations[0]).toMatchObject({ medicineId: f.medicine.id, quantity: 2, lineAmount: 24 });
    await expect(Invoice.updateOne({ _id: data.id }, { $set: { totalAmount: 100 } })).rejects.toThrow(/cannot be rewritten/);
    await Invoice.updateOne({ _id: data.id }, { $set: { status: "paid", amountPaid: 24, balanceDue: 0 } });
    await Medicine.updateOne({ _id: f.medicine.id }, { $set: { stockQuantity: 0, deletedAt: new Date() } });
    const replay = await post(f.body, f.key);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().data).toEqual(data);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    const recovered = await lookup(f.key);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.headers["cache-control"]).toBe("no-store");
    expect(recovered.json().data).toEqual(data);
    expect(await StockMovement.countDocuments({ medicineId: f.medicine.id, kind: "dispense" })).toBe(1);
    expect(await AuditLog.countDocuments({ targetId: data.id, action: "PRESCRIPTION_DISPENSE" })).toBe(1);
    expect(await Invoice.countDocuments({ patientId: f.patient.id })).toBe(1);
    expect((await Prescription.findById(f.prescription.id))!.status).toBe("dispensed");
    const receipt = await OperationReceipt.findOne({ key: f.key }).select("+responseCiphertext").lean();
    expect(receipt.responseCiphertext).toMatch(/^enc:v1:/);
    expect(receipt.responseCiphertext).not.toContain(f.patient.id);
  });

  it("commits only once for simultaneous same-key requests, including fulfillment and movements", async () => {
    const f = await fixture();
    const responses = await Promise.all([post(f.body, f.key), post(f.body, f.key)]);
    expect(responses.map(item => item.statusCode).sort()).toEqual([200, 201]);
    expect(responses[0].json().data).toEqual(responses[1].json().data);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(8);
    expect((await MedicineBatch.findById(f.batch.id))!.quantity).toBe(8);
    expect(await Invoice.countDocuments({ patientId: f.patient.id })).toBe(1);
    expect((await Prescription.findById(f.prescription.id))!.status).toBe("dispensed");
    expect(await StockMovement.countDocuments({ medicineId: f.medicine.id, kind: "dispense" })).toBe(1);
    expect(await OperationReceipt.countDocuments({ key: f.key })).toBe(1);
  });

  it("records one controlled-register entry through the production route under simultaneous retries", async () => {
    const f = await fixture("schedule_h1");
    const results = await Promise.all([post(f.body, f.key), post(f.body, f.key)]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 201]);
    expect(results[0].json().data).toEqual(results[1].json().data);
    expect(await ScheduleH1Register.countDocuments({ medicineId: f.medicine.id })).toBe(1);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(8);
  });

  it("rejects the same key with changed quantities without a second mutation", async () => {
    const f = await fixture();
    expect((await post(f.body, f.key)).statusCode).toBe(201);
    expect((await post({ ...f.body, items: [{ medicineId: f.medicine.id, quantity: 3 }] }, f.key)).statusCode).toBe(409);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(8);
  });

  it("rolls back rather than persisting a replay snapshot with non-finite amounts", async () => {
    const f = await fixture();
    await MedicineBatch.updateOne({ _id: f.batch.id }, { $set: { sellingPrice: Number.MAX_VALUE } });
    expect((await post(f.body, f.key)).statusCode).toBe(409);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
    expect((await Prescription.findById(f.prescription.id))!.status).toBe("active");
    expect(await Invoice.countDocuments({ patientId: f.patient.id })).toBe(0);
    expect(await OperationReceipt.countDocuments({ key: f.key })).toBe(0);
  });

  it("canonicalizes item and selected-prescription order for replay", async () => {
    const f = await fixture();
    const other = await fixture();
    const secondRx = await Prescription.create({ organizationId, locationId, patientId: f.patient.id, encounterId: f.encounter.id,
      doctorId, medicineId: other.medicine.id, medicineName: other.medicine.name, dosage: "1 tablet", frequency: "Daily", duration: "2 days" });
    await PrescriptionSealingService.sealPrescription(secondRx.id, doctorId);
    await ClinicalNote.updateOne({ encounterId: f.encounter.id }, { $push: { "plan.prescriptionIds": secondRx._id } });
    const body = { ...f.body, prescriptionIds: [f.prescription.id, secondRx.id],
      items: [...f.body.items, ...other.body.items] };
    const first = await post(body, f.key);
    expect(first.statusCode, first.body).toBe(201);
    const replay = await post({ ...body, items: [...body.items].reverse(), prescriptionIds: [...body.prescriptionIds].reverse() }, f.key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data).toEqual(first.json().data);
  });

  it("does not oversell stock under different concurrent keys", async () => {
    const f = await fixture();
    const body = { ...f.body, items: [{ medicineId: f.medicine.id, quantity: 6 }] };
    const responses = await Promise.all([post(body, f.key), post(body, crypto.randomUUID())]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([201, 409]);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(4);
    expect((await MedicineBatch.findById(f.batch.id))!.quantity).toBe(4);
    expect(await Invoice.countDocuments({ patientId: f.patient.id })).toBe(1);
  });

  it("snapshots a separately issued pharmacy supplement without changing the clinical draft", async () => {
    const f = await fixture();
    const invoice = await Invoice.create({ clinicalChargeVersion: 1, organizationId, locationId, patientId: f.patient.id, doctorId, encounterId: f.encounter.id,
      invoiceNumber: `TEST-${crypto.randomUUID()}`, items: [{ description: "Consultation", amount: 100, quantity: 1 }],
      subtotal: 100, totalAmount: 100, status: "unpaid" });
    const first = await post(f.body, f.key);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().data.id).not.toBe(invoice.id);
    expect(first.json().data.supplementForInvoiceId).toBe(invoice.id);
    expect(first.json().data.dispenseOperation).toMatchObject({ addedAmount: 24, appendedToExisting: false });
    expect(first.json().data.totalAmount).toBe(24);
    expect(first.json().data.items).toHaveLength(1);
    expect((await post(f.body, f.key)).json().data).toEqual(first.json().data);
    expect((await Invoice.findById(invoice.id))!.items).toHaveLength(1);
  });

  it.each(["invoice", "snapshot", "audit"])("rolls back all business effects when required %s persistence fails", async failure => {
    const f = await fixture();
    const model = failure === "invoice" ? Invoice : failure === "snapshot" ? OperationReceipt : AuditLog;
    const method = failure === "snapshot" ? "updateOne" : "create";
    const original = model[method].bind(model);
    const mock = vi.spyOn(model, method).mockImplementation(((...args: any[]) => {
      const doc = Array.isArray(args[0]) ? args[0][0] : args[0];
      if (failure === "invoice" || (failure === "snapshot" ? args[1]?.$set?.responseCiphertext : doc.action === "PRESCRIPTION_DISPENSE")) throw new Error("Injected dispense persistence failure");
      return (original as any)(...args);
    }) as any);
    try {
      expect((await post(f.body, f.key)).statusCode).toBe(500);
      expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
      expect((await MedicineBatch.findById(f.batch.id))!.quantity).toBe(10);
      expect((await Medicine.findById(f.medicine.id))!.stockRevision).toBe(0);
      expect((await Prescription.findById(f.prescription.id))!.status).toBe("active");
      expect(await StockMovement.countDocuments({ medicineId: f.medicine.id })).toBe(0);
      expect(await Invoice.countDocuments({ patientId: f.patient.id })).toBe(0);
      expect(await OperationReceipt.countDocuments({ key: f.key })).toBe(0);
    } finally { mock.mockRestore(); }
    expect((await post(f.body, f.key)).statusCode).toBe(201);
  });

  it("does not turn a missing or corrupt result into permission to submit a new operation", async () => {
    const f = await fixture();
    const absent = await lookup(f.key);
    expect(absent.statusCode).toBe(404);
    expect(absent.headers["cache-control"]).toBe("no-store");
    expect(absent.json().message).toContain("do not start another bill");
    expect((await post(f.body, f.key)).statusCode).toBe(201);
    await OperationReceipt.collection.updateOne({ key: f.key }, { $set: { responseCiphertext: "corrupt" } });
    expect((await lookup(f.key)).statusCode).toBe(409);
    expect((await post(f.body, f.key)).statusCode).toBe(409);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(8);
  });

  it("keeps a committed dispense when notification fails and does not notify again on replay", async () => {
    const f = await fixture();
    const notify = vi.spyOn(websocket, "broadcastQueueUpdate").mockImplementation(() => { throw new Error("Injected socket failure"); });
    try {
      expect((await post(f.body, f.key)).statusCode).toBe(201);
      expect((await post(f.body, f.key)).statusCode).toBe(200);
      expect(notify).toHaveBeenCalledTimes(1);
      expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(8);
    } finally { notify.mockRestore(); }
  });

  it("rechecks live authority before replay or lookup and isolates another actor's reference", async () => {
    const f = await fixture();
    expect((await post(f.body, f.key)).statusCode).toBe(201);
    const other = await User.create({ name: "Other pharmacist", email: `${crypto.randomUUID()}@example.test`, role: "pharmacist" });
    await OrgMember.create({ organizationId, userId: other.id, role: "pharmacist", locationAccess: { mode: "selected", locationIds: [locationId] } });
    const auth = await createAuthSession({ id: other.id, role: "pharmacist", email: other.email!, organization_id: organizationId });
    expect((await lookup(f.key, locationId, { authorization: `Bearer ${auth.accessToken}` })).statusCode).toBe(404);
    const otherPost = await app.inject({ method: "POST", url: "/api/pharmacy/dispense", payload: f.body,
      headers: { authorization: `Bearer ${auth.accessToken}`, "idempotency-key": f.key } });
    expect(otherPost.statusCode).toBe(409);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(8);
    await OrgMember.updateOne({ userId: actorId, organizationId }, { $set: { "locationAccess.locationIds": [] } });
    try {
      expect((await lookup(f.key)).statusCode).toBe(404);
      expect((await post(f.body, f.key)).statusCode).toBe(404);
    } finally { await OrgMember.updateOne({ userId: actorId, organizationId }, { $set: { "locationAccess.locationIds": [locationId] } }); }
  });

  it("uses majority write concern for dispense commits and fails closed on standalone MongoDB", async () => {
    const f = await fixture();
    const transaction = vi.spyOn(mongoose.connection, "transaction");
    expect((await post(f.body, f.key)).statusCode).toBe(201);
    expect(transaction.mock.calls.some(call => call[1]?.writeConcern?.w === "majority")).toBe(true);
    transaction.mockRestore();
    const fresh = await fixture();
    const topology = vi.spyOn((mongoose.connection as any).client.topology, "description", "get").mockReturnValue({ type: "Single" });
    try { expect((await post(fresh.body, fresh.key)).statusCode).toBe(503); }
    finally { topology.mockRestore(); }
    expect((await Medicine.findById(fresh.medicine.id))!.stockQuantity).toBe(10);
  });
});
