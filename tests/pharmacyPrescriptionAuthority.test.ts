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
import { Appointment } from "../models/Appointment.ts";
import { Prescription } from "../models/Prescription.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { Invoice } from "../models/Invoice.ts";
import { PharmacyDispense } from "../models/PharmacyDispense.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { createAuthSession } from "../utilities/helpers.ts";
import { PrescriptionSealingService } from "../services/PrescriptionSealingService.ts";
import { autoGenerateEncounterInvoice, compileAppointmentCharges, compileEncounterCharges } from "../services/ChargeCaptureService.ts";

describe("Finalized prescription authority and pharmacy charge provenance", () => {
  let organizationId: string, locationId: string, doctorId: string;
  let headers: { authorization: string };
  beforeAll(async () => {
    organizationId = (await Organization.create({ name: "Source authority", city: "Pune" })).id;
    locationId = (await Location.create({ organizationId, name: "Source counter", city: "Pune" })).id;
    const actor = await User.create({ name: "Source manager", email: `${crypto.randomUUID()}@example.test`, role: "admin" });
    doctorId = (await User.create({ name: "Source doctor", email: `${crypto.randomUUID()}@example.test`, role: "doctor" })).id;
    await OrgMember.create({ organizationId, userId: actor.id, role: "admin" });
    const session = await createAuthSession({ id: actor.id, role: "admin", email: actor.email!, organization_id: organizationId });
    headers = { authorization: `Bearer ${session.accessToken}` };
    await Promise.all([PharmacyDispense.init(), Invoice.init(), OperationReceipt.init(), StockMovement.init()]);
  });
  async function fixture(authorizedQuantity?: number) {
    const patient = await Patient.create({ organizationId, name: "Source patient" });
    const appointment = await Appointment.create({ organizationId, locationId, patientId: patient.id, doctorId,
      appointmentTime: new Date(), appointmentType: "walk-in", status: "completed", paymentAmount: 100, tokenNumber: 1 });
    const encounter = await Encounter.create({ organizationId, locationId, patientId: patient.id, doctorId,
      appointmentId: appointment.id, status: "completed" });
    const medicine = await Medicine.create({ locationId, name: "Source medicine", genericName: "Source formulation",
      stockQuantity: 30, price: 999, costPrice: 5, expiryDate: new Date("2099-12-31"), batchNumber: "LEGACY",
      ...(authorizedQuantity ? { unitDefinition: { version: 1, baseUnit: "tablet", packUnit: "strip", unitsPerPack: 10 } } : {}) });
    await MedicineBatch.create({ medicineId: medicine.id, locationId, batchNumber: "ACTUAL-A", expiryDate: new Date("2098-12-31"),
      quantity: 2, purchaseCost: 5, sellingPrice: 10 });
    await MedicineBatch.create({ medicineId: medicine.id, locationId, batchNumber: "ACTUAL-B", expiryDate: new Date("2099-12-31"),
      quantity: 28, purchaseCost: 5, sellingPrice: 20 });
    const rx = await Prescription.create({ organizationId, locationId, patientId: patient.id, doctorId, encounterId: encounter.id,
      medicineId: medicine.id, medicineName: medicine.name, dosage: "1 tablet", frequency: "Daily", duration: "4 days",
      ...(authorizedQuantity ? { authorizedQuantity, authorizedBaseUnit: "tablet" } : {}) });
    await PrescriptionSealingService.sealPrescription(rx.id, doctorId);
    const note = await ClinicalNote.create({ organizationId, locationId, patientId: patient.id, doctorId, encounterId: encounter.id,
      subjective: { chiefComplaint: "Authority test" }, plan: { prescriptionIds: [rx.id] }, status: "signed",
      signature: { signerId: doctorId, signerName: "Source doctor", signedAt: new Date() } });
    const body = { patientId: patient.id, locationId, doctorId, encounterId: encounter.id, appointmentId: appointment.id,
      prescriptionIds: [rx.id], items: [{ medicineId: medicine.id, quantity: 4 }],
      prescriptionAllocations: [{ prescriptionId: rx.id, medicineId: medicine.id, quantity: 4 }] };
    await pharmacyTaxFixture(locationId, [medicine.id], doctorId);
    return { patient, appointment, encounter, medicine, rx, note, body };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const post = (body: Record<string, unknown>, key = crypto.randomUUID()) => app.inject({ method: "POST", url: "/api/pharmacy/dispense",
    headers: { ...headers, "idempotency-key": key }, payload: body });
  const checkout = (f: Fixture, extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/api/billing/checkout/consolidate",
    headers: { ...headers, "idempotency-key": crypto.randomUUID() }, payload: { appointmentId: f.appointment.id, paymentMethod: "cash", ...extra } });
  async function untouched(f: Fixture) {
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(30);
    expect(await PharmacyDispense.countDocuments({ encounterId: f.encounter.id })).toBe(0);
    expect(await Invoice.countDocuments({ patientId: f.patient.id })).toBe(0);
    expect(await StockMovement.countDocuments({ medicineId: f.medicine.id })).toBe(0);
  }
  it.each(["missing", "unknown", "duplicate", "mixed", "wrong patient", "wrong doctor", "wrong encounter", "wrong appointment", "no mappings", "wrong mapping", "wrong quantity"])("rejects %s selection atomically", async kind => {
    const f = await fixture();
    const otherId = new mongoose.Types.ObjectId().toString();
    let body: Record<string, unknown> = { ...f.body };
    if (kind === "missing") body.prescriptionIds = [];
    if (kind === "unknown") body.prescriptionIds = [otherId];
    if (kind === "duplicate") body.prescriptionIds = [f.rx.id, f.rx.id];
    if (kind === "mixed") body.prescriptionIds = [f.rx.id, otherId];
    if (kind === "wrong patient") body.patientId = (await Patient.create({ organizationId, name: "Other patient" })).id;
    if (kind === "wrong doctor") body.doctorId = otherId;
    if (kind === "wrong encounter") body.encounterId = otherId;
    if (kind === "wrong appointment") body.appointmentId = otherId;
    if (kind === "no mappings") body.prescriptionAllocations = [{ ...f.body.prescriptionAllocations[0], prescriptionId: otherId }];
    if (kind === "wrong mapping") body.prescriptionAllocations = [{ ...f.body.prescriptionAllocations[0], medicineId: otherId }];
    if (kind === "wrong quantity") body.prescriptionAllocations = [{ ...f.body.prescriptionAllocations[0], quantity: 3 }];
    const response = await post(body);
    expect(response.statusCode, response.body).toBe(409);
    await untouched(f);
  });
  it.each(["draft note", "old note", "duplicate latest notes", "unsigned", "superseded", "discontinued", "deleted", "tampered", "note excludes row", "encounter cancelled", "appointment wrong patient", "cross tenant"])("rejects %s authority without moving stock", async kind => {
    const f = await fixture();
    if (kind === "draft note") await ClinicalNote.updateOne({ _id: f.note.id }, { $set: { status: "draft" } });
    if (kind === "old note") await ClinicalNote.updateOne({ _id: f.note.id }, { $set: { isLatest: false } });
    if (kind === "duplicate latest notes") {
      const { _id, ...note } = f.note.toObject();
      await ClinicalNote.create({ ...note, version: 2 });
    }
    if (kind === "unsigned") await Prescription.collection.updateOne({ _id: f.rx._id }, { $set: { isSealed: false } });
    if (kind === "superseded") await Prescription.updateOne({ _id: f.rx.id }, { $set: { status: "superseded" } });
    if (kind === "discontinued") await Prescription.updateOne({ _id: f.rx.id }, { $set: { status: "discontinued" } });
    if (kind === "deleted") await Prescription.updateOne({ _id: f.rx.id }, { $set: { deletedAt: new Date() } });
    if (kind === "tampered") await Prescription.collection.updateOne({ _id: f.rx._id }, { $set: { dosage: "tampered" } });
    if (kind === "note excludes row") await ClinicalNote.updateOne({ _id: f.note.id }, { $set: { "plan.prescriptionIds": [] } });
    if (kind === "encounter cancelled") await Encounter.updateOne({ _id: f.encounter.id }, { $set: { status: "cancelled" } });
    if (kind === "appointment wrong patient") await Appointment.updateOne({ _id: f.appointment.id }, { $set: { patientId: new mongoose.Types.ObjectId() } });
    if (kind === "cross tenant") await Prescription.collection.updateOne({ _id: f.rx._id }, { $set: { organizationId: new mongoose.Types.ObjectId() } });
    const response = await post(f.body);
    expect(response.statusCode, response.body).toBe(409);
    await untouched(f);
  });
  it("shows only finalized current rows on the pending desk", async () => {
    const f = await fixture();
    await ClinicalNote.updateOne({ _id: f.note.id }, { $set: { status: "draft" } });
    let response = await app.inject({ method: "GET", url: `/api/pharmacy/pending-prescriptions?locationId=${locationId}`, headers });
    expect(response.json().data.some((group: any) => group.encounterId === f.encounter.id)).toBe(false);
    await ClinicalNote.updateOne({ _id: f.note.id }, { $set: { status: "signed" } });
    response = await app.inject({ method: "GET", url: `/api/pharmacy/pending-prescriptions?locationId=${locationId}`, headers });
    expect(response.json().data.find((group: any) => group.encounterId === f.encounter.id).prescriptions.map((rx: any) => rx.id)).toEqual([f.rx.id]);
  });
  it("exposes unsupplied rows as unbilled in both charge compilers", async () => {
    const f = await fixture();
    for (const preview of [await compileEncounterCharges(f.encounter.id), await compileAppointmentCharges(f.appointment.id)]) {
      expect(preview.items.filter(item => item.category === "pharmacy")).toEqual([]);
      expect(preview.unfilledPrescriptions).toEqual([{ prescriptionId: f.rx.id, medicineName: f.medicine.name }]);
    }
  });
  it("records actual mixed-batch price and preserves it through checkout and generation", async () => {
    const f = await fixture();
    const invoice = await autoGenerateEncounterInvoice(f.encounter.id);
    expect(invoice.items.some((item: any) => item.pharmacyDispenseId)).toBe(false);
    const supplied = await post(f.body);
    expect(supplied.statusCode, supplied.body).toBe(201);
    expect(supplied.json().data.supplementForInvoiceId).toBe(invoice.id);
    expect(supplied.json().data.dispenseOperation.addedAmount).toBe(60);
    const source = await PharmacyDispense.findOne({ encounterId: f.encounter.id }).lean();
    if (!source) throw new Error("Committed supply missing");
    expect(source.lines[0]).toMatchObject({ quantity: 4, amount: 15, lineAmount: 60 });
    expect(source.lines[0].prescriptions.map((rx: any) => ({ id: String(rx.prescriptionId), quantity: rx.quantity }))).toEqual([{ id: f.rx.id, quantity: 4 }]);
    await Medicine.updateOne({ _id: f.medicine.id }, { $set: { price: 2000 } });
    await MedicineBatch.updateMany({ medicineId: f.medicine.id }, { $set: { sellingPrice: 2000 } });
    const settled = await checkout(f);
    expect(settled.statusCode, settled.body).toBe(200);
    expect(settled.json().data.items.filter((item: any) => item.pharmacyDispenseId)).toHaveLength(0);
    const pharmacyInvoice = await Invoice.findById(supplied.json().data.id).lean();
    const lines = pharmacyInvoice.items.filter((item: any) => item.pharmacyDispenseId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ quantity: 4, amount: 15 });
    expect(String(lines[0].pharmacyDispenseId)).toBe(String(source._id));
    expect(String(lines[0].pharmacyDispenseLineId)).toBe(String(source.lines[0]._id));
    expect((await autoGenerateEncounterInvoice(f.encounter.id)).id).toBe(invoice.id);
    expect(await Invoice.countDocuments({ patientId: f.patient.id })).toBe(2);
  });
  it.each(["paid", "partially_paid", "issued"])("links a supplement after a %s visit bill without changing the original", async state => {
    const f = await fixture();
    const invoice = await autoGenerateEncounterInvoice(f.encounter.id);
    await Invoice.updateOne({ _id: invoice.id }, { $set: state === "issued" ? { issuedAt: new Date() } : { status: state, amountPaid: state === "paid" ? invoice.totalAmount : 1 } });
    const original = await Invoice.findById(invoice.id).lean();
    const response = await post(f.body);
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().data.supplementForInvoiceId).toBe(invoice.id);
    expect(response.json().data.totalAmount).toBe(60);
    expect(await Invoice.findById(invoice.id).lean()).toEqual(original);
    expect((await compileEncounterCharges(f.encounter.id)).items.filter(item => item.category === "pharmacy")).toHaveLength(0);
  });
  it("serializes different keys for the same source even when stock is plentiful", async () => {
    const f = await fixture();
    const responses = await Promise.all([post(f.body), post(f.body)]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([201, 409]);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(26);
    expect(await PharmacyDispense.countDocuments({ encounterId: f.encounter.id })).toBe(1);
  });
  it("keeps unselected rows pending and preserves separate subsequent supplies", async () => {
    const f = await fixture();
    const rx2 = await Prescription.create({ organizationId, locationId, patientId: f.patient.id, doctorId, encounterId: f.encounter.id,
      medicineId: f.medicine.id, medicineName: f.medicine.name, dosage: "2 tablets", frequency: "Daily", duration: "2 days" });
    await PrescriptionSealingService.sealPrescription(rx2.id, doctorId);
    await ClinicalNote.updateOne({ _id: f.note.id }, { $push: { "plan.prescriptionIds": rx2._id } });
    expect((await post(f.body)).statusCode).toBe(201);
    expect((await Prescription.findById(rx2.id)).status).toBe("active");
    const second = await post({ ...f.body, prescriptionIds: [rx2.id], prescriptionAllocations: [{ prescriptionId: rx2.id, medicineId: f.medicine.id, quantity: 4 }] });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().data.items.filter((item: any) => item.pharmacyDispenseId)).toHaveLength(1);
    expect((await compileAppointmentCharges(f.appointment.id)).items.filter(item => item.category === "pharmacy")).toHaveLength(0);
    expect((await compileAppointmentCharges(f.appointment.id)).pharmacyInvoices).toHaveLength(2);
  });
  it("accepts a finalized focused visit using its existing audit without creating a SOAP note", async () => {
    const f = await fixture();
    await ClinicalNote.deleteOne({ _id: f.note.id });
    const denied = await post(f.body);
    expect(denied.statusCode).toBe(409);
    const audit = await AuditLog.create({ organizationId, userId: doctorId, action: "CONSULTATION_COMPLETED_WITHOUT_CLINICAL_NOTE",
      targetId: f.appointment._id, targetModel: "Appointment", details: { encounterId: f.encounter._id } });
    const preview = await compileEncounterCharges(f.encounter.id);
    expect(preview.unfilledPrescriptions).toHaveLength(1);
    const pending = await app.inject({ method: "GET", url: `/api/pharmacy/pending-prescriptions?locationId=${locationId}`, headers });
    expect(pending.json().data.some((group: any) => group.encounterId === f.encounter.id)).toBe(true);
    const supplied = await post(f.body);
    expect(supplied.statusCode, supplied.body).toBe(201);
    const source = await PharmacyDispense.findOne({ encounterId: f.encounter.id });
    expect(String(source?.focusedCompletionAuditId)).toBe(audit.id);
    expect(await ClinicalNote.countDocuments({ encounterId: f.encounter.id })).toBe(0);
  });
  it("keeps actual supply when checkout follows dispensing before a visit bill exists", async () => {
    const f = await fixture();
    const supplied = await post(f.body);
    expect(supplied.statusCode, supplied.body).toBe(201);
    const settled = await checkout(f);
    expect(settled.statusCode, settled.body).toBe(200);
    expect(settled.json().data.totalAmount).toBe(100);
    expect(settled.json().data.items.filter((item: any) => item.pharmacyDispenseId)).toHaveLength(0);
    expect(await Invoice.countDocuments({ patientId: f.patient.id })).toBe(2);
    expect((await Appointment.findById(f.appointment.id))!.paymentStatus).toBe("partially_paid");
    const payment = await app.inject({ method: "POST", url: `/api/invoices/${supplied.json().data.id}/payments`,
      headers: { ...headers, "idempotency-key": crypto.randomUUID() }, payload: { amount: 60, paymentMethod: "cash" } });
    expect(payment.statusCode, payment.body).toBe(200);
    expect((await Appointment.findById(f.appointment.id))!.paymentStatus).toBe("paid");
  });
  it("reconciles explicit allocations when two selected prescriptions share one stock line", async () => {
    const f = await fixture();
    const rx2 = await Prescription.create({ organizationId, locationId, patientId: f.patient.id, doctorId, encounterId: f.encounter.id,
      medicineId: f.medicine.id, medicineName: f.medicine.name, dosage: "2 tablets", frequency: "Daily", duration: "2 days" });
    await PrescriptionSealingService.sealPrescription(rx2.id, doctorId);
    await ClinicalNote.updateOne({ _id: f.note.id }, { $push: { "plan.prescriptionIds": rx2._id } });
    const body = { ...f.body, prescriptionIds: [f.rx.id, rx2.id], prescriptionAllocations: [
      { prescriptionId: f.rx.id, medicineId: f.medicine.id, quantity: 1 }, { prescriptionId: rx2.id, medicineId: f.medicine.id, quantity: 3 },
    ] };
    const key = crypto.randomUUID();
    expect((await post(body, key)).statusCode).toBe(201);
    expect((await post({ ...body, prescriptionIds: [...body.prescriptionIds].reverse(), prescriptionAllocations: [...body.prescriptionAllocations].reverse() }, key)).statusCode).toBe(200);
    const source = await PharmacyDispense.findOne({ encounterId: f.encounter.id });
    expect(source?.lines).toHaveLength(1);
    expect(source?.lines[0].prescriptions.map(item => item.quantity)).toEqual([1, 3]);
    expect(await Prescription.countDocuments({ _id: { $in: body.prescriptionIds }, status: "dispensed", fulfillmentRevision: 1 })).toBe(2);
  });
  it("keeps counter collection tied to consultation while an issued pharmacy bill remains due", async () => {
    const f = await fixture();
    const consultation = await autoGenerateEncounterInvoice(f.encounter.id);
    const supply = await post(f.body); expect(supply.statusCode, supply.body).toBe(201);
    const collection = await app.inject({ method: "POST", url: "/api/appointment-payments/collect-counter", headers,
      payload: { appointmentId: f.appointment.id, paymentMethod: "cash" } });
    expect(collection.statusCode, collection.body).toBe(200);
    expect(collection.json().data.invoice.id).toBe(consultation.id);
    expect((await Appointment.findById(f.appointment.id))!.paymentStatus).toBe("partially_paid");
    expect((await Invoice.findById(supply.json().data.id)).status).toBe("unpaid");
  });
  it("still previews and collects unbilled consultation after pharmacy is paid first", async () => {
    const f = await fixture();
    const supply = await post(f.body); expect(supply.statusCode, supply.body).toBe(201);
    const paid = await app.inject({ method: "POST", url: `/api/invoices/${supply.json().data.id}/payments`,
      headers: { ...headers, "idempotency-key": crypto.randomUUID() }, payload: { amount: 60, paymentMethod: "cash" } });
    expect(paid.statusCode, paid.body).toBe(200);
    const preview = await app.inject({ method: "GET", url: `/api/billing/checkout/preview/${f.appointment.id}`, headers });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().data.isAlreadyPaid).toBe(false);
    expect(preview.json().data.isFeeEditable).toBe(true);
    expect(preview.json().data.totalAmount).toBe(100);
    const settled = await checkout(f); expect(settled.statusCode, settled.body).toBe(200);
    expect(settled.json().data.totalAmount).toBe(100);
    expect((await Appointment.findById(f.appointment.id))!.paymentStatus).toBe("paid");
    expect(await Invoice.countDocuments({ patientId: f.patient.id })).toBe(2);
  });
  it("blocks ambiguous old charges without description matching or stock changes", async () => {
    const f = await fixture();
    await Invoice.create({ organizationId, locationId, patientId: f.patient.id, doctorId, encounterId: f.encounter.id,
      invoiceNumber: crypto.randomUUID(), items: [{ description: "Unclassified historical charge", amount: 60, quantity: 1 }], subtotal: 60, totalAmount: 60 });
    const response = await post(f.body);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().message).toMatch(/provenance/);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(30);
    expect(await PharmacyDispense.countDocuments({ encounterId: f.encounter.id })).toBe(0);
  });
  it("serializes checkout racing with supply without losing or copying the medicine charge", async () => {
    const f = await fixture();
    const responses = await Promise.all([checkout(f), post(f.body)]);
    expect(responses[0].statusCode, responses[0].body).toBe(200);
    expect(responses[1].statusCode, responses[1].body).toBe(201);
    const invoices = await Invoice.find({ patientId: f.patient.id }).lean();
    expect(invoices.flatMap(invoice => invoice.items).filter((item: any) => item.pharmacyDispenseId)).toHaveLength(1);
    expect(invoices.reduce((sum, invoice) => sum + invoice.totalAmount, 0)).toBe(160);
    expect(await PharmacyDispense.countDocuments({ encounterId: f.encounter.id })).toBe(1);
  });
  it("rolls back stock, source and invoice when the conditional fulfillment loses authority", async () => {
    const f = await fixture();
    const original = Prescription.updateOne.bind(Prescription);
    const mock = vi.spyOn(Prescription, "updateOne").mockImplementation(((filter: any, update: any, ...rest: any[]) =>
      update?.$set?.pharmacyDispenseId ? Promise.resolve({ modifiedCount: 0 }) : original(filter, update, ...rest)) as any);
    try {
      expect((await post(f.body)).statusCode).toBe(409);
      await untouched(f);
    } finally { mock.mockRestore(); }
  });
  it("prevents recharging a missing or altered committed invoice line", async () => {
    const f = await fixture();
    const response = await post(f.body);
    // Simulate out-of-band database corruption; application updates are guarded.
    await Invoice.collection.updateOne({ _id: new mongoose.Types.ObjectId(response.json().data.id) }, { $set: { items: [] } });
    await expect(compileAppointmentCharges(f.appointment.id)).rejects.toThrow(/committed source/);
    const settled = await checkout(f);
    expect(settled.statusCode).toBe(409);
    expect(await PharmacyDispense.countDocuments({ encounterId: f.encounter.id })).toBe(1);
  });
  it("keeps the operational source immutable", async () => {
    const f = await fixture();
    expect((await post(f.body)).statusCode).toBe(201);
    await expect(PharmacyDispense.updateOne({ encounterId: f.encounter.id }, { $set: { actorId: doctorId } })).rejects.toThrow(/append-only/);
    await expect(PharmacyDispense.deleteMany({ encounterId: f.encounter.id })).rejects.toThrow(/append-only/);
  });
  const partialBody = (f: Fixture, quantity: number, revision: number, remaining: number) => ({ ...f.body,
    items: [{ medicineId: f.medicine.id, quantity }], prescriptionAllocations: [{ prescriptionId: f.rx.id, medicineId: f.medicine.id, quantity,
      expectedFulfillmentRevision: revision, expectedRemainingQuantity: remaining }] });
  it("supplies 10 then 20 of 30 with exact separate charges, remaining allowance and immutable replay", async () => {
    const f = await fixture(30), firstKey = crypto.randomUUID(), firstBody = partialBody(f, 10, 0, 30);
    const first = await post(firstBody, firstKey);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().data.totalAmount).toBe(180);
    expect(first.json().data.dispenseOperation.prescriptionProgress[0]).toMatchObject({ suppliedAfter: 10, remainingAfter: 20, completed: false, revisionAfter: 1 });
    expect(await Prescription.findById(f.rx.id)).toMatchObject({ status: "active", suppliedQuantity: 10, fulfillmentRevision: 1 });
    const pending = await app.inject({ method: "GET", url: `/api/pharmacy/pending-prescriptions?locationId=${locationId}`, headers });
    expect(pending.json().data.find((row: any) => row.encounterId === f.encounter.id).prescriptions[0].fulfillment).toMatchObject({ remainingQuantity: 20, revision: 1, baseUnit: "tablet" });
    expect((await post(firstBody)).statusCode).toBe(409);
    expect((await checkout(f)).statusCode).toBe(200);
    const paid = await Invoice.findById(first.json().data.id).lean();
    const second = await post(partialBody(f, 20, 1, 20));
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().data.totalAmount).toBe(400);
    expect(await Prescription.findById(f.rx.id)).toMatchObject({ status: "dispensed", suppliedQuantity: 30, fulfillmentRevision: 2 });
    expect((await Invoice.findById(paid._id).lean())!.items).toEqual(paid.items);
    expect((await Invoice.findById(paid._id).lean())!.payments).toEqual(paid.payments);
    const replay = await post(firstBody, firstKey);
    expect(replay.statusCode).toBe(200); expect(replay.json().data).toEqual(first.json().data);
    expect(await PharmacyDispense.countDocuments({ encounterId: f.encounter.id })).toBe(2);
    const compiled = await compileEncounterCharges(f.encounter.id);
    expect(compiled.pharmacyInvoices.reduce((sum, row) => sum + row.totalAmount, 0)).toBe(580);
    expect(compiled.items.filter(row => row.category === "pharmacy")).toHaveLength(0);
    expect(compiled.unfilledPrescriptions).toHaveLength(0);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(0);
  });
  it("serializes concurrent 25 + 25 against one 30-unit allowance", async () => {
    const f = await fixture(30);
    const results = await Promise.all([post(partialBody(f, 25, 0, 30)), post(partialBody(f, 25, 0, 30))]);
    expect(results.map(row => row.statusCode).sort()).toEqual([201, 409]);
    expect(await Prescription.findById(f.rx.id)).toMatchObject({ suppliedQuantity: 25, status: "active", fulfillmentRevision: 1 });
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(5);
    expect(await PharmacyDispense.countDocuments({ encounterId: f.encounter.id })).toBe(1);
  });
  it.each(["missing revision", "wrong remaining", "over allowance", "unit mismatch", "sealed quantity tamper"])("rejects quantity supply with %s before stock or money changes", async kind => {
    const f = await fixture(30), body = partialBody(f, 10, 0, 30);
    if (kind === "missing revision") delete (body.prescriptionAllocations[0] as any).expectedFulfillmentRevision;
    if (kind === "wrong remaining") body.prescriptionAllocations[0].expectedRemainingQuantity = 29;
    if (kind === "over allowance") { body.items[0].quantity = 31; body.prescriptionAllocations[0].quantity = 31; }
    if (kind === "unit mismatch") await Medicine.collection.updateOne({ _id: f.medicine._id }, { $set: { "unitDefinition.baseUnit": "ml" } });
    if (kind === "sealed quantity tamper") await Prescription.collection.updateOne({ _id: f.rx._id }, { $set: { authorizedQuantity: 60 } });
    const response = await post(body); expect(response.statusCode, response.body).toBe(409); await untouched(f);
  });
  it("keeps further unquantified supply blocked and requires an explicit new prescriber quantity after a partial fill", async () => {
    const single = await fixture(); expect((await post(single.body)).statusCode).toBe(201); expect((await post(single.body)).statusCode).toBe(409);
    const f = await fixture(30); expect((await post(partialBody(f, 10, 0, 30))).statusCode).toBe(201);
    await expect(PrescriptionSealingService.amendPrescription(f.rx.id, doctorId, { dosage: "New dose", amendmentReason: "Reviewed subsequent supply" })).rejects.toThrow(/explicit new quantity/);
    expect(await Prescription.findById(f.rx.id)).toMatchObject({ status: "active", suppliedQuantity: 10 });
    await expect(Prescription.updateOne({ _id: f.rx.id }, { $set: { authorizedQuantity: 50 } })).rejects.toThrow(/immutable/);
  });
  it("enforces source-line uniqueness across invoices and within a single invoice", async () => {
    const f = await fixture();
    const response = await post(f.body);
    const committed = await Invoice.findById(response.json().data.id).lean();
    const copy = { organizationId, locationId, patientId: f.patient.id, doctorId,
      invoiceNumber: crypto.randomUUID(), items: committed.items, subtotal: 60, totalAmount: 60 };
    await expect(Invoice.create(copy)).rejects.toMatchObject({ code: 11000 });
    await expect(Invoice.create({ ...copy, invoiceNumber: crypto.randomUUID(), items: [...copy.items, ...copy.items] })).rejects.toThrow(/complete and unique/);
    expect(await Invoice.countDocuments({ patientId: f.patient.id })).toBe(1);
  });
});
