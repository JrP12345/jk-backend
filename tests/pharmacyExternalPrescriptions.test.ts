import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { pharmacyRetailFixture } from "./helpers/pharmacyRetailFixture.ts";
import { PharmacyProfessionalReview } from "../models/PharmacyProfessionalReview.ts";
import { PharmacyExternalPrescription } from "../models/PharmacyExternalPrescription.ts";
import { ScheduleH1Register } from "../models/ScheduleH1Register.ts";
import { PharmacyDispense } from "../models/PharmacyDispense.ts";
import { Invoice } from "../models/Invoice.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { registerEvidenceStatus } from "../services/PharmacyRestrictedSupply.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { InvoiceCollectionReceipt } from "../models/InvoiceCollectionReceipt.ts";
import { authorizeExternalSale } from "../services/PharmacyExternalPrescriptionService.ts";
import { withTransaction } from "../utilities/transaction.ts";
import type { FastifyRequest } from "fastify";

beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
const key = () => crypto.randomUUID();
async function fixture(schedule = "schedule_h1", qualified = true, permissions = ["PHARMACY_DISPENSE_RESTRICTED", "PHARMACY_COLLECT_PAYMENT", "PHARMACY_VIEW_STOCK"]) {
  const f = await pharmacyRetailFixture(permissions);
  await Organization.updateOne({ _id: f.organizationId }, { $set: { workspaceProfile: "pharmacy" } });
  await Medicine.updateOne({ _id: f.medicine.id }, { $set: { scheduleType: schedule, "dispensingReview.scheduleType": schedule } });
  if (qualified) await PharmacyProfessionalReview.create({ organizationId: f.organizationId, locationId: f.locationId, userId: f.user.id, profession: "pharmacist", registrationNumber: "SYNTHETIC-PHARM-123", council: "Synthetic council", address: "Synthetic pharmacist address", reviewReference: "Synthetic registration evidence", validUntil: new Date("2099-12-31"), active: true, revision: 1, confirmedBy: f.user.id, confirmedAt: new Date() });
  const input = { locationId: f.locationId, reference: `RX-${key()}`, issuedOn: new Date().toISOString().slice(0, 10), validUntil: "2099-12-31", patientName: "Synthetic outside patient", patientAddress: "Synthetic recipient address", patientPhone: "9876543210", prescriberName: "Synthetic outside prescriber", prescriberAddress: "Synthetic outside practice address", prescriberRegistration: "SYNTHETIC-RMP-123", prescriberCouncil: "Synthetic medical council", prescriberReviewReference: "Synthetic prescriber evidence", sourceReference: "Retained synthetic signed prescription RX-123", reviewConfirmed: true,
    lines: [{ medicineId: f.medicine.id, quantity: 6, expectedUnitVersion: 1, expectedDispensingRevision: 1, instructions: "Original synthetic written directions" }] };
  return { ...f, rxInput: input };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const record = (f: Fixture, input = f.rxInput, requestKey = key()) => app.inject({ method: "POST", url: "/api/pharmacy/external-prescriptions", headers: { ...f.headers, "idempotency-key": requestKey }, payload: input });
async function source(f: Fixture) { const response = await record(f); expect(response.statusCode, response.body).toBe(201); return response.json().data; }
async function quote(f: Fixture, rx: any, quantity = 2) {
  return app.inject({ method: "POST", url: "/api/pharmacy/external-prescriptions/quote", headers: f.headers, payload: { locationId: f.locationId, externalPrescription: { id: rx.id, revision: rx.revision }, lines: [{ lineId: key(), medicineId: f.medicine.id, quantity, expectedUnitVersion: 1 }] } });
}
const save = (f: Fixture, input: any, requestKey = key()) => app.inject({ method: "POST", url: "/api/pharmacy/external-prescriptions/supply", headers: { ...f.headers, "idempotency-key": requestKey }, payload: { ...input, includeDocument: true } });
async function read(f: Fixture, id: string) { return app.inject({ method: "GET", url: `/api/pharmacy/external-prescriptions/${id}?locationId=${f.locationId}`, headers: f.headers }); }

it.each(["general", "schedule_h", "schedule_h1"])("records an encrypted reviewed external %s prescription without a clinic visit; supplies partial quantities with linked immutable history", async schedule => {
  const f = await fixture(schedule), recordKey = key(), created = await record(f, f.rxInput, recordKey);
  expect(created.statusCode, created.body).toBe(201); const rx = created.json().data;
  expect((await record(f, f.rxInput, recordKey)).json().data.id).toBe(rx.id);
  expect((await record(f)).statusCode).toBe(409);
  const raw = await PharmacyExternalPrescription.collection.findOne({ _id: new mongoose.Types.ObjectId(rx.id) });
  expect(raw!.evidenceCiphertext).toMatch(/^enc:v1:/); expect(JSON.stringify(raw)).not.toContain(f.rxInput.patientName);
  const q = await quote(f, rx); expect(q.statusCode, q.body).toBe(200);
  const requestKey = key(), saved = await save(f, q.json().data.issueInput, requestKey);
  expect(saved.statusCode, saved.body).toBe(201); const result = saved.json().data;
  expect(result).toMatchObject({ status: "unpaid", totalPaise: 2000, document: { totalAmount: 20 } });
  expect((await save(f, q.json().data.issueInput, requestKey)).json().data.invoiceId).toBe(result.invoiceId);
  expect((await app.inject({ method: "GET", url: `/api/pharmacy/external-prescription-operations/${requestKey}?locationId=${f.locationId}`, headers: f.headers })).json().data.invoiceId).toBe(result.invoiceId);
  const progress = (await read(f, rx.id)).json().data;
  expect(progress).toMatchObject({ revision: 1, status: "approved", lines: [{ quantity: 6, supplied: 2 }], supplies: [{ invoiceId: result.invoiceId, lines: [{ quantity: 2 }] }] });
  const dispense = await PharmacyDispense.findById(result.dispenseId);
  expect(String(dispense!.externalPrescriptionId)).toBe(rx.id); expect(dispense!.patientId).toBeUndefined();
  const entries = await ScheduleH1Register.find({ invoiceId: result.invoiceId }).lean();
  expect(entries).toHaveLength(schedule === "general" ? 0 : 1);
  if (entries.length) expect(registerEvidenceStatus(entries[0])).toMatchObject({ recordVersion: 2, externalPrescriptionRevision: 1, patientName: f.rxInput.patientName, doctorName: f.rxInput.prescriberName, quantityDispensed: 2, requiresReview: false });
  const remainder = await quote(f, progress, 4); expect(remainder.statusCode, remainder.body).toBe(200);
  expect((await save(f, remainder.json().data.issueInput)).statusCode).toBe(201);
  expect((await read(f, rx.id)).json().data).toMatchObject({ status: "completed", revision: 2, lines: [{ supplied: 6 }] });
  expect((await quote(f, { ...rx, revision: 2 }, 1)).statusCode).toBe(409);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(4);
});

it.each(["general", "schedule_h", "schedule_h1"])("retains external %s authorization and register evidence in billing-only mode without deducting stock", async schedule => {
  const f = await fixture(schedule);
  await Location.updateOne({ _id: f.locationId }, { $set: { pharmacyCapability: { enabled: true, inventoryMode: "billing_only", revision: 1 } } });
  await Medicine.updateOne({ _id: f.medicine.id }, { $set: { billingSupply: { batchNumber: "MANUAL-RX-LOT", expiry: { precision: "month", value: "2099-12" }, mrpPaise: 1200 } } });
  const rx = await source(f), q = await app.inject({ method: "POST", url: "/api/pharmacy/external-prescriptions/quote", headers: f.headers, payload: { locationId: f.locationId, expectedInventoryMode: "billing_only", externalPrescription: { id: rx.id, revision: rx.revision }, lines: [{ lineId: key(), medicineId: f.medicine.id, quantity: 2, expectedUnitVersion: 1 }] } });
  expect(q.statusCode, q.body).toBe(200);
  const saved = await save(f, q.json().data.issueInput); expect(saved.statusCode, saved.body).toBe(201);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
  expect((await MedicineBatch.findOne({ medicineId: f.medicine.id }))!.quantity).toBe(10);
  const entries = await ScheduleH1Register.find({ invoiceId: saved.json().data.invoiceId }).lean();
  expect(entries).toHaveLength(schedule === "general" ? 0 : 1);
  if (entries.length) expect(registerEvidenceStatus(entries[0])).toMatchObject({ requiresReview: false, batchNumber: "MANUAL-RX-LOT", quantityDispensed: 2, recordVersion: 2 });
  expect((await read(f, rx.id)).json().data.lines[0].supplied).toBe(2);
});

it("requires explicit dispensing permission and current pharmacist qualification, and retains standalone clinical separation", async () => {
  const cashier = await fixture("general", true, ["PHARMACY_SELL"]);
  expect((await record(cashier)).statusCode).toBe(403);
  const unqualified = await fixture("general", false); expect((await record(unqualified)).statusCode).toBe(409);
  const f = await fixture(), rx = await source(f);
  const caps = await app.inject({ method: "GET", url: `/api/pharmacy/locations/${f.locationId}/capabilities`, headers: f.headers });
  expect(caps.json().data.actions).toMatchObject({ viewRxQueue: false, dispense: false, externalDispense: true, viewExternalPrescriptions: true });
  await PharmacyProfessionalReview.updateOne({ userId: f.user.id }, { $set: { active: false } });
  expect((await quote(f, rx)).statusCode).toBe(409);
  expect(await Invoice.countDocuments({ organizationId: f.organizationId })).toBe(0);
});

it("fails closed on absent proof, future/invalid dates, unreviewed classification, unsupported schedules and unrelated products", async () => {
  const f = await fixture();
  for (const patch of [{ reviewConfirmed: false }, { prescriberReviewReference: "" }, { patientAddress: "" }, { issuedOn: "2099-01-01" }, { issuedOn: "2026-99-99" }, { validUntil: "2020-01-01" }, { lines: [{ ...f.rxInput.lines[0], expectedUnitVersion: 2 }] }]) expect((await record(f, { ...f.rxInput, ...patch } as typeof f.rxInput)).statusCode).toBeGreaterThanOrEqual(400);
  const rx = await source(f), foreign = await fixture();
  expect((await read(foreign, rx.id)).statusCode).toBe(404);
  const unrelated = await app.inject({ method: "POST", url: "/api/pharmacy/external-prescriptions/quote", headers: f.headers, payload: { locationId: f.locationId, externalPrescription: { id: rx.id, revision: 0 }, lines: [{ lineId: key(), medicineId: foreign.medicine.id, quantity: 1, expectedUnitVersion: 1 }] } });
  expect(unrelated.statusCode).toBe(409);
  for (const scheduleType of ["schedule_x", "narcotic"]) { const blocked = await fixture(scheduleType); expect((await record(blocked)).statusCode).toBe(409); }
  await Medicine.updateOne({ _id: f.medicine.id }, { $inc: { dispensingRevision: 1 } });
  expect((await quote(f, rx)).statusCode).toBe(409);
});

it("serializes competing partial fills on source revision even when stock remains, and refuses overfills", async () => {
  const f = await fixture(), rx = await source(f), q = await quote(f, rx, 4);
  expect(q.statusCode, q.body).toBe(200);
  const replies = await Promise.all([save(f, q.json().data.issueInput), save(f, q.json().data.issueInput)]);
  expect(replies.map(reply => reply.statusCode).sort()).toEqual([201, 409]);
  expect(await Invoice.countDocuments({ organizationId: f.organizationId })).toBe(1);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(6);
  expect((await quote(f, { ...rx, revision: 1 }, 3)).statusCode).toBe(409);
  expect((await quote(f, rx, 1)).statusCode).toBe(409);
});

it("rolls back prescription allowance, register, bill and batches together when required invoice audit fails", async () => {
  const f = await fixture(), rx = await source(f), q = await quote(f, rx), requestKey = key();
  const original = AuditLog.create.bind(AuditLog), stub = vi.spyOn(AuditLog, "create").mockImplementation((...args: any[]) => {
    const doc = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (doc?.action === "PHARMACY_COUNTER_INVOICE_ISSUED") return Promise.reject(Error("Synthetic audit outage")) as any;
    return (original as any)(...args);
  });
  try { expect((await save(f, q.json().data.issueInput, requestKey)).statusCode).toBe(500); } finally { stub.mockRestore(); }
  expect((await read(f, rx.id)).json().data).toMatchObject({ revision: 0, supplies: [], lines: [{ supplied: 0 }] });
  expect(await ScheduleH1Register.countDocuments({ organizationId: f.organizationId })).toBe(0);
  expect(await Invoice.countDocuments({ organizationId: f.organizationId })).toBe(0);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
  expect((await MedicineBatch.findOne({ medicineId: f.medicine.id }))!.quantity).toBe(10);
  expect((await save(f, q.json().data.issueInput, requestKey)).statusCode).toBe(201);
});

it("cancels only the remaining allowance and retains prior bills/history", async () => {
  const f = await fixture(), rx = await source(f), q = await quote(f, rx);
  expect((await save(f, q.json().data.issueInput)).statusCode).toBe(201);
  const cancel = await app.inject({ method: "POST", url: `/api/pharmacy/external-prescriptions/${rx.id}/cancel`, headers: f.headers, payload: { locationId: f.locationId, expectedRevision: 1 } });
  expect(cancel.statusCode, cancel.body).toBe(200); expect(cancel.json().data).toMatchObject({ status: "cancelled", revision: 2, lines: [{ supplied: 2 }] });
  expect((await quote(f, { ...rx, revision: 2 })).statusCode).toBe(409);
  expect(await Invoice.countDocuments({ organizationId: f.organizationId })).toBe(1);
});

it("commits a confirmed external supply payment once and exposes its historical bill without granting ordinary sales access", async () => {
  const f = await fixture(), rx = await source(f), q = await quote(f, rx), input = q.json().data.issueInput, requestKey = key();
  const paid = { ...input, payment: { locationId: f.locationId, expectedPaymentRevision: 0, expectedBalancePaise: 2000, cashTenderedPaise: 2500, manualConfirmed: true, entries: [{ componentId: key(), paymentMethod: "cash", amountPaise: 2000 }] } };
  const saved = await save(f, paid, requestKey); expect(saved.statusCode, saved.body).toBe(201);
  expect(saved.json().data).toMatchObject({ status: "paid", collection: { collectedPaise: 2000, cashChangePaise: 500 }, document: { status: "paid", amountPaid: 20 } });
  expect((await save(f, paid, requestKey)).json().data.invoiceId).toBe(saved.json().data.invoiceId);
  expect(await InvoiceCollectionReceipt.countDocuments({ organizationId: f.organizationId })).toBe(1);
  const progress = (await read(f, rx.id)).json().data;
  expect(progress.supplies[0]).toMatchObject({ invoiceNumber: saved.json().data.invoiceNumber });
  const historical = await app.inject({ method: "GET", url: `/api/pharmacy/external-prescription-invoices/${saved.json().data.invoiceId}?locationId=${f.locationId}`, headers: f.headers });
  expect(historical.statusCode, historical.body).toBe(200); expect(historical.json().data).toEqual(saved.json().data.document);
  const foreign = await fixture();
  expect((await app.inject({ method: "GET", url: `/api/pharmacy/external-prescription-invoices/${saved.json().data.invoiceId}?locationId=${foreign.locationId}`, headers: foreign.headers })).statusCode).toBe(404);
  const ordinary = await app.inject({ method: "POST", url: "/api/pharmacy/sales", headers: { ...f.headers, "idempotency-key": key() }, payload: f.input });
  expect(ordinary.statusCode).toBe(403);
});

it("rechecks qualification, expiry and payment drawer after quote without consuming prescription or stock", async () => {
  const f = await fixture("schedule_h1", true, ["PHARMACY_DISPENSE_RESTRICTED", "PHARMACY_COLLECT_PAYMENT", "PHARMACY_CLOSE_TILL", "PHARMACY_VIEW_STOCK"]), rx = await source(f), q = await quote(f, rx), input = q.json().data.issueInput;
  await PharmacyProfessionalReview.updateOne({ userId: f.user.id }, { $set: { active: false } });
  expect((await save(f, input)).statusCode).toBe(409);
  await PharmacyProfessionalReview.updateOne({ userId: f.user.id }, { $set: { active: true } });
  // Simulates time having advanced beyond the immutable captured deadline.
  const now = vi.spyOn(Date, "now").mockReturnValue(new Date("2100-01-01").getTime());
  try {
    const req = { user: { id: f.user.id, role: f.role, organization_id: f.organizationId } } as FastifyRequest;
    await expect(withTransaction(() => authorizeExternalSale(req, { organizationId: f.organizationId, locationId: f.locationId, actorId: f.user.id }, { id: rx.id, revision: 0 }, input.lines, true))).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("deadline") });
  } finally { now.mockRestore(); }
  const drawer = (await app.inject({ method: "GET", url: `/api/pharmacy/till?locationId=${f.locationId}`, headers: f.headers })).json().data.active;
  const closed = await app.inject({ method: "POST", url: `/api/pharmacy/till/${drawer.id}/close`, headers: { ...f.headers, "idempotency-key": key() }, payload: { locationId: f.locationId, expectedRevision: drawer.revision, countedCashPaise: 100000 } });
  expect(closed.statusCode, closed.body).toBe(201);
  const paid = { ...input, payment: { locationId: f.locationId, expectedPaymentRevision: 0, expectedBalancePaise: 2000, cashTenderedPaise: 2000, manualConfirmed: true, entries: [{ componentId: key(), paymentMethod: "cash", amountPaise: 2000 }] } };
  const failed = await save(f, paid); expect(failed.statusCode, failed.body).toBe(428);
  expect((await read(f, rx.id)).json().data).toMatchObject({ revision: 0, supplies: [], lines: [{ supplied: 0 }] });
  expect(await Invoice.countDocuments({ organizationId: f.organizationId })).toBe(0); expect(await ScheduleH1Register.countDocuments({ organizationId: f.organizationId })).toBe(0);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
});

it("lets an authorized administrator configure and revoke actual pharmacist evidence through the existing review API", async () => {
  const f = await fixture("schedule_h1", false, ["MANAGE_ORGANIZATION", "PHARMACY_DISPENSE_RESTRICTED"]), url = `/api/pharmacy/locations/${f.locationId}/professionals/${f.user.id}/pharmacist`;
  expect((await record(f)).statusCode).toBe(409);
  const declaration = { expectedRevision: 0, registrationNumber: "SYNTHETIC-PHARM-123", council: "Synthetic council", address: "Synthetic professional address", reviewReference: "Synthetic reviewed evidence", validUntil: "2099-12-31T18:29:59.999Z", active: true };
  const saved = await app.inject({ method: "PUT", url, headers: f.headers, payload: declaration });
  expect(saved.statusCode, saved.body).toBe(200); expect(saved.json().data).toMatchObject({ revision: 1, active: true });
  const rx = await source(f); expect((await quote(f, rx)).statusCode).toBe(200);
  expect((await app.inject({ method: "PUT", url, headers: f.headers, payload: declaration })).statusCode).toBe(409);
  const revoked = await app.inject({ method: "PUT", url, headers: f.headers, payload: { ...declaration, expectedRevision: 1, active: false } });
  expect(revoked.statusCode, revoked.body).toBe(200); expect((await quote(f, rx)).statusCode).toBe(409);
  const ordinaryPharmacist = await fixture("general", false);
  expect((await app.inject({ method: "PUT", url: `/api/pharmacy/locations/${ordinaryPharmacist.locationId}/professionals/${ordinaryPharmacist.user.id}/pharmacist`, headers: ordinaryPharmacist.headers, payload: declaration })).statusCode).toBe(403);
});
