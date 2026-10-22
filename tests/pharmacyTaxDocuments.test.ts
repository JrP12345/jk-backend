import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../index.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { Patient } from "../models/Patient.ts";
import { Encounter } from "../models/Encounter.ts";
import { Prescription } from "../models/Prescription.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { PharmacyTaxProfile } from "../models/PharmacyTaxProfile.ts";
import { PharmacyDispense } from "../models/PharmacyDispense.ts";
import { Invoice } from "../models/Invoice.ts";
import { InvoiceSeries } from "../models/InvoiceSeries.ts";
import { Counter } from "../models/Counter.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { createAuthSession } from "../utilities/helpers.ts";
import { allocateInvoiceNumber, indiaFinancialYear } from "../utilities/invoiceNumber.ts";
import { inclusiveTax } from "../utilities/pharmacyTax.ts";
import { PrescriptionSealingService } from "../services/PrescriptionSealingService.ts";
import { addBatchToMedicine } from "../services/PharmacyInventoryService.ts";

describe("Pharmacy issued documents, reviewed tax profiles and fiscal numbering", () => {
  let organizationId: string, doctorId: string, adminId: string;
  let headers: { authorization: string }, pharmacistHeaders: { authorization: string };
  beforeAll(async () => {
    organizationId = (await Organization.create({ name: "Tax test", city: "Pune", countryCode: "IN", currency: "INR" })).id;
    const admin = await User.create({ name: "Tax owner", role: "admin", email: `${crypto.randomUUID()}@example.test` });
    adminId = admin.id;
    const pharmacist = await User.create({ name: "Tax pharmacist", role: "pharmacist", email: `${crypto.randomUUID()}@example.test` });
    doctorId = (await User.create({ name: "Tax doctor", role: "doctor", email: `${crypto.randomUUID()}@example.test` })).id;
    await OrgMember.create([admin, pharmacist].map(user => ({ organizationId, userId: user.id, role: user.role, locationAccess: { mode: "all" as const } })));
    const auth = async (user: any) => ({ authorization: `Bearer ${(await createAuthSession({ id: user.id, role: user.role, email: user.email, organization_id: organizationId })).accessToken}` });
    headers = await auth(admin); pharmacistHeaders = await auth(pharmacist);
    await Promise.all([Invoice.init(), InvoiceSeries.init(), Counter.init(), PharmacyTaxProfile.init(), PharmacyDispense.init(), OperationReceipt.init(), StockMovement.init()]);
  });
  const profile = (registration = "regular") => ({ expectedRevision: 0, registration, legalName: "Synthetic Licensed Pharmacy",
    address: "Synthetic business address, Pune 411001", stateCode: "27", ...(registration !== "unregistered" ? { gstin: "27ABCDE1234F1Z5" } : {}),
    drugLicenceNumbers: ["SYNTHETIC-LICENCE-20", "SYNTHETIC-LICENCE-21"], authorisedSignatory: "Synthetic authorised person",
    reviewReference: "Synthetic test review; no real professional approval", pricesIncludeTax: true, minimumHsnDigits: 6, electronicReportingRequired: false });
  const taxClass = (gstRate = 5) => ({ expectedRevision: 0, hsnCode: "300490", unitCode: "NOS", gstRate,
    treatment: gstRate ? "taxable" : "nil_rated", reviewReference: "Synthetic tax classification reference" });
  const putProfile = (id: string, body: Record<string, unknown>, auth = headers) => app.inject({ method: "PUT", url: `/api/pharmacy/locations/${id}/tax-profile`, headers: auth, payload: body });
  const putClass = (id: string, body: Record<string, unknown>, auth = headers) => app.inject({ method: "PUT", url: `/api/pharmacy/medicines/${id}/tax-classification`, headers: auth, payload: body });
  const post = (body: any, key = crypto.randomUUID()) => app.inject({ method: "POST", url: "/api/pharmacy/dispense", headers: { ...pharmacistHeaders, "idempotency-key": key }, payload: body });
  async function fixture(registration = "regular", configured = true) {
    const location = await Location.create({ organizationId, name: "Tax counter", city: "Pune" });
    const medicine = await Medicine.create({ locationId: location.id, name: "Tax medicine", genericName: "Test", price: 105, costPrice: 10,
      stockQuantity: 20, batchNumber: "LEGACY", expiryDate: new Date("2099-12-31") });
    const patient = await Patient.create({ organizationId, name: "Synthetic recipient", address: "Synthetic recipient address", state: "Maharashtra" });
    const encounter = await Encounter.create({ organizationId, locationId: location.id, patientId: patient.id, doctorId, status: "completed" });
    const rx = await Prescription.create({ organizationId, locationId: location.id, patientId: patient.id, encounterId: encounter.id, doctorId,
      medicineId: medicine.id, medicineName: medicine.name, dosage: "1", frequency: "Daily", duration: "2 days" });
    await PrescriptionSealingService.sealPrescription(rx.id, doctorId);
    await ClinicalNote.create({ organizationId, locationId: location.id, patientId: patient.id, encounterId: encounter.id, doctorId,
      subjective: { chiefComplaint: "Tax test" }, status: "signed", signature: { signerId: doctorId, signerName: "Doctor", signedAt: new Date() }, plan: { prescriptionIds: [rx.id] } });
    if (configured) {
      const result = await putProfile(location.id, profile(registration)); expect(result.statusCode, result.body).toBe(200);
      const classified = await putClass(medicine.id, taxClass()); expect(classified.statusCode, classified.body).toBe(200);
    }
    return { location, medicine, patient, encounter, rx, body: { patientId: patient.id, locationId: location.id, doctorId, encounterId: encounter.id,
      prescriptionIds: [rx.id], items: [{ medicineId: medicine.id, quantity: 2 }], prescriptionAllocations: [{ prescriptionId: rx.id, medicineId: medicine.id, quantity: 2 }] } };
  }
  async function noSupply(f: Awaited<ReturnType<typeof fixture>>) {
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(20);
    expect((await Prescription.findById(f.rx.id)).status).toBe("active");
    expect(await Invoice.countDocuments({ patientId: f.patient.id })).toBe(0);
    expect(await PharmacyDispense.countDocuments({ patientId: f.patient.id })).toBe(0);
    expect(await StockMovement.countDocuments({ medicineId: f.medicine.id })).toBe(0);
  }
  it("clears a previous GSTIN when the reviewed branch changes to unregistered without a GSTIN field", async () => {
    const f = await fixture(); const before = await PharmacyTaxProfile.findOne({ locationId: f.location.id });
    const response = await putProfile(f.location.id, { ...profile("unregistered"), expectedRevision: before!.revision });
    expect(response.statusCode, response.body).toBe(200); expect(response.json().data).toMatchObject({ registration: "unregistered", gstin: "", issueSupported: true });
    expect(await PharmacyTaxProfile.findOne({ locationId: f.location.id })).toMatchObject({ registration: "unregistered", gstin: "" });
    await addBatchToMedicine({ medicineId: f.medicine.id, locationId: f.location.id, batchNumber: "SYNTHETIC-REGISTER-CHANGE", expiryDate: "2099-12-31", quantity: 20, purchaseCost: 10, sellingPrice: 105, unlinkedInwardReason: "Synthetic invoice transition" });
    const supplied = await post(f.body); expect(supplied.statusCode, supplied.body).toBe(201); expect(supplied.json().data.tax).toBe(0);
  });
  it("denies issuer reads and writes outside the live assigned branch even for a manager", async () => {
    const own = await fixture(), sibling = await Location.create({ organizationId, name: "Separate branch", city: "Pune" });
    await OrgMember.updateOne({ organizationId, userId: adminId }, { $set: { locationAccess: { mode: "selected", locationIds: [own.location.id] } } });
    try {
      const read = (id: string) => app.inject({ method: "GET", url: `/api/pharmacy/locations/${id}/tax-profile`, headers });
      expect((await read(own.location.id)).statusCode).toBe(200); expect([403, 404]).toContain((await read(sibling.id)).statusCode);
      expect([403, 404]).toContain((await putProfile(sibling.id, profile())).statusCode); expect(await PharmacyTaxProfile.exists({ locationId: sibling.id })).toBeNull();
    } finally { await OrgMember.updateOne({ organizationId, userId: adminId }, { $set: { locationAccess: { mode: "all", locationIds: [] } } }); }
  });
  it("uses the India financial-year boundary rather than UTC or calendar year", () => {
    expect(indiaFinancialYear(new Date("2026-03-31T18:29:59Z")).label).toBe("2025-26");
    expect(indiaFinancialYear(new Date("2026-03-31T18:30:00Z")).label).toBe("2026-27");
    expect(() => indiaFinancialYear(new Date("invalid"))).toThrow(/issue date/);
  });
  it("reserves globally distinct series for locations with identical ID suffixes", async () => {
    const locations = await Location.create(["000001000000000000abcdef", "000002000000000000abcdef"].map(_id => ({ _id, organizationId, name: "Collision test", city: "Pune" })));
    const numbers = await Promise.all(locations.map(location => allocateInvoiceNumber(location.id)));
    expect(new Set(numbers.map(number => number.invoiceNumber)).size).toBe(2);
    expect(numbers.every(number => number.invoiceNumber.length === 16 && /^I[A-Z0-9]{8}\/[0-9]{6}$/.test(number.invoiceNumber))).toBe(true);
    const reservation = await InvoiceSeries.findOne({ locationId: locations[0].id });
    await expect(reservation!.deleteOne()).rejects.toThrow(/immutable/);
    expect(await InvoiceSeries.exists({ _id: reservation!._id })).toBeTruthy();
  });
  it("allocates unique sequential numbers under concurrent first use", async () => {
    const location = await Location.create({ organizationId, name: "Concurrent fiscal series", city: "Pune" });
    const numbers = await Promise.all(Array.from({ length: 12 }, () => allocateInvoiceNumber(location.id)));
    expect(new Set(numbers.map(number => number.invoiceNumber)).size).toBe(12);
    expect(numbers.map(number => Number(number.invoiceNumber.slice(-6))).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(await InvoiceSeries.countDocuments({ locationId: location.id })).toBe(1);
  });
  it("restarts sequence per financial year without changing the reserved series", async () => {
    const location = await Location.create({ organizationId, name: "Fiscal counter", city: "Pune" });
    const before = await allocateInvoiceNumber(location.id, new Date("2026-03-31T18:29:59Z"));
    const after = await allocateInvoiceNumber(location.id, new Date("2026-03-31T18:30:00Z"));
    expect(before.invoiceSeries).toBe(after.invoiceSeries);
    expect(before.invoiceNumber).not.toBe(after.invoiceNumber);
    expect(before.invoiceNumber.endsWith("/000001") && after.invoiceNumber.endsWith("/000001")).toBe(true);
  });
  it("aborts the supply and leaves a saturated counter unchanged", async () => {
    const f = await fixture(); const number = await allocateInvoiceNumber(f.location.id);
    const fiscal = indiaFinancialYear(); const id = `invoice-v2:${number.invoiceSeries}:${fiscal.start}`;
    await Counter.updateOne({ id }, { $set: { seq: 999999 } });
    const response = await post(f.body); expect(response.statusCode, response.body).toBe(409);
    await noSupply(f); expect((await Counter.findOne({ id })).seq).toBe(999999);
  });
  it("captures inclusive GST, issuer, units and exact paise in an unpaid issued invoice", async () => {
    const f = await fixture(); const key = crypto.randomUUID();
    const response = await post(f.body, key); expect(response.statusCode, response.body).toBe(201);
    const data = response.json().data;
    expect(data).toMatchObject({ documentVersion: 1, numberingVersion: 2, subtotal: 200, tax: 10, cgstTotal: 5, sgstTotal: 5, totalAmount: 210, status: "unpaid", balanceDue: 210 });
    expect(data.taxDocument).toMatchObject({ kind: "tax_invoice", profileRevision: 1, issuedBy: expect.any(String),
      issuer: { legalName: profile().legalName, gstin: profile().gstin, stateCode: "27" }, recipient: { name: f.patient.name }, signatureMode: "manual_on_print" });
    expect(data.items[0]).toMatchObject({ amount: 100, quantity: 2, hsnSacCode: "300490", unitCode: "NOS", gstRate: 5, baseAmountPaise: 20000, cgstPaise: 500, sgstPaise: 500, grossAmountPaise: 21000 });
    expect((await post(f.body, key)).json().data).toEqual(data);
    expect(await Invoice.countDocuments({ patientId: f.patient.id })).toBe(1);
  });
  it.each(["unregistered", "composition"])("does not collect GST for a reviewed %s issuer", async registration => {
    const f = await fixture(registration);
    const response = await post(f.body); expect(response.statusCode, response.body).toBe(201);
    expect(response.json().data).toMatchObject({ subtotal: 210, tax: 0, totalAmount: 210 });
    expect(response.json().data.taxDocument.kind).toBe(registration === "unregistered" ? "ordinary_bill" : "bill_of_supply");
    expect(response.json().data.taxDocument.notice).toMatch(registration === "unregistered" ? /not collected/ : /not eligible to collect/);
  });
  it("preserves zero-rated classification and chooses a bill of supply", async () => {
    const f = await fixture();
    expect((await putClass(f.medicine.id, { ...taxClass(0), expectedRevision: 1 })).statusCode).toBe(200);
    const response = await post(f.body); expect(response.statusCode, response.body).toBe(201);
    expect(response.json().data.tax).toBe(0); expect(response.json().data.taxDocument.kind).toBe("bill_of_supply");
  });
  it("issues an invoice-cum-bill of supply for reviewed taxable and zero-rated medicines", async () => {
    const f = await fixture();
    const medicine = await Medicine.create({ locationId: f.location.id, name: "Zero-rated test", genericName: "Test", price: 105,
      costPrice: 10, stockQuantity: 5, batchNumber: "ZERO", expiryDate: new Date("2099-12-31") });
    expect((await putClass(medicine.id, taxClass(0))).statusCode).toBe(200);
    const rx = await Prescription.create({ organizationId, locationId: f.location.id, patientId: f.patient.id, encounterId: f.encounter.id,
      doctorId, medicineId: medicine.id, medicineName: medicine.name, dosage: "1", frequency: "Daily", duration: "2 days" });
    await PrescriptionSealingService.sealPrescription(rx.id, doctorId);
    await ClinicalNote.updateOne({ encounterId: f.encounter.id }, { $push: { "plan.prescriptionIds": rx._id } });
    const response = await post({ ...f.body, prescriptionIds: [...f.body.prescriptionIds, rx.id],
      items: [...f.body.items, { medicineId: medicine.id, quantity: 1 }],
      prescriptionAllocations: [...f.body.prescriptionAllocations, { prescriptionId: rx.id, medicineId: medicine.id, quantity: 1 }] });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().data).toMatchObject({ subtotal: 305, tax: 10, totalAmount: 315, taxDocument: { kind: "invoice_cum_bill_of_supply" } });
  });
  it("enforces the issuer's explicitly reviewed minimum HSN length", async () => {
    const f = await fixture();
    await putClass(f.medicine.id, { ...taxClass(), expectedRevision: 1, hsnCode: "3004" });
    const response = await post(f.body); expect(response.statusCode, response.body).toBe(409); await noSupply(f);
  });
  it("denies cross-organization profile and classification access", async () => {
    const other = await Organization.create({ name: "Other issuer", city: "Delhi", countryCode: "IN", currency: "INR" });
    const location = await Location.create({ organizationId: other.id, name: "Other branch", city: "Delhi" });
    const medicine = await Medicine.create({ locationId: location.id, name: "Other stock", genericName: "Test", price: 105, costPrice: 10, stockQuantity: 0 });
    expect([403, 404]).toContain((await putProfile(location.id, profile())).statusCode);
    expect([403, 404]).toContain((await putClass(medicine.id, taxClass())).statusCode);
    const read = await app.inject({ method: "GET", url: `/api/pharmacy/locations/${location.id}/tax-profile`, headers });
    expect([403, 404]).toContain(read.statusCode);
    expect(await PharmacyTaxProfile.countDocuments({ locationId: location.id })).toBe(0);
  });
  it("keeps a zero tax rate when a later batch inherits reviewed catalogue tax", async () => {
    const f = await fixture();
    await putClass(f.medicine.id, { ...taxClass(0), expectedRevision: 1 });
    const batch = await addBatchToMedicine({ medicineId: f.medicine.id, locationId: f.location.id, quantity: 2,
      batchNumber: "ZERO", expiryDate: "2099-12-31", purchaseCost: 10, sellingPrice: 105 });
    expect(batch.gstRate).toBe(0);
  });
  it.each(["missing profile", "missing classification", "changed catalogue", "batch mismatch", "unknown batch tax", "recipient address"])("fails closed for %s without committing stock or money", async reason => {
    const f = await fixture("regular", reason !== "missing profile");
    if (reason === "missing classification") await Medicine.updateOne({ _id: f.medicine.id }, { $unset: { taxClassification: 1 } });
    if (reason === "changed catalogue") await Medicine.updateOne({ _id: f.medicine.id }, { $set: { gstRate: 18 } });
    if (["batch mismatch", "unknown batch tax"].includes(reason)) {
      const batch = await MedicineBatch.create({ medicineId: f.medicine.id, locationId: f.location.id, batchNumber: "MISMATCH", expiryDate: new Date("2099-12-31"), quantity: 20, purchaseCost: 10, sellingPrice: 105, hsnCode: "300490", gstRate: 18 });
      if (reason === "unknown batch tax") await MedicineBatch.collection.updateOne({ _id: batch._id }, { $unset: { gstRate: 1 } });
    }
    if (reason === "recipient address") {
      await Patient.updateOne({ _id: f.patient.id }, { $unset: { address: 1 } });
      await Medicine.updateOne({ _id: f.medicine.id }, { $set: { price: 30000 } });
    }
    const response = await post(f.body); expect(response.statusCode, response.body).toBe(409); await noSupply(f);
  });
  it.each([{ stateCode: "29" }, { gstin: "invalid" }, { registration: "unregistered" }])("rejects inconsistent issuer settings %j", async change => {
    const f = await fixture("regular", false);
    expect((await putProfile(f.location.id, { ...profile(), ...change })).statusCode).toBe(409);
    expect(await PharmacyTaxProfile.countDocuments({ locationId: f.location.id })).toBe(0);
  });
  it.each([{ pricesIncludeTax: false }, { electronicReportingRequired: true }])("records unsupported requirements %j and stops further issue", async change => {
    const f = await fixture();
    const updated = await putProfile(f.location.id, { ...profile(), expectedRevision: 1, ...change });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().data.issueSupported).toBe(false);
    const response = await post(f.body); expect(response.statusCode, response.body).toBe(409); await noSupply(f);
  });
  it("requires current setting revisions and trusted actor/time fields", async () => {
    const f = await fixture();
    expect((await putProfile(f.location.id, profile())).statusCode).toBe(409);
    expect((await putClass(f.medicine.id, taxClass())).statusCode).toBe(409);
    // Fastify removes unknown body fields; persisted actor/time are always supplied by the server.
    expect((await putProfile(f.location.id, { ...profile(), expectedRevision: 1, confirmedBy: doctorId })).statusCode).toBe(200);
    const stored = await PharmacyTaxProfile.findOne({ locationId: f.location.id }); expect(String(stored!.confirmedBy)).toBe(adminId);
  });
  it("does not let a pharmacist approve issuer or medicine tax configuration", async () => {
    const f = await fixture();
    expect((await putProfile(f.location.id, { ...profile(), expectedRevision: 1 }, pharmacistHeaders)).statusCode).toBe(403);
    expect((await putClass(f.medicine.id, { ...taxClass(), expectedRevision: 1 }, pharmacistHeaders)).statusCode).toBe(403);
  });
  it("keeps the issued snapshot unchanged after later issuer and catalogue changes", async () => {
    const f = await fixture(); const key = crypto.randomUUID(); const result = await post(f.body, key); expect(result.statusCode, result.body).toBe(201);
    const data = result.json().data;
    await putProfile(f.location.id, { ...profile(), expectedRevision: 1, legalName: "Changed legal issuer" });
    await putClass(f.medicine.id, { ...taxClass(18), expectedRevision: 1 });
    expect((await post(f.body, key)).json().data).toEqual(data);
    expect((await Invoice.findById(data.id)).taxDocument.issuer.legalName).toBe(profile().legalName);
  });
  it("protects issued amounts and identity through document, query and bulk operations", async () => {
    const f = await fixture(); const response = await post(f.body); expect(response.statusCode, response.body).toBe(201);
    const invoice = await Invoice.findById(response.json().data.id); invoice.subtotal = 1;
    await expect(invoice.save()).rejects.toThrow();
    await expect(Invoice.updateOne({ _id: invoice.id }, { $unset: { issuedAt: 1 } })).rejects.toThrow(/cannot be rewritten/);
    await expect(Invoice.updateOne({ _id: invoice.id }, { $rename: { notes: "taxDocument.notice" } })).rejects.toThrow(/cannot be rewritten/);
    await expect(Invoice.deleteOne({ _id: invoice.id })).rejects.toThrow(/cannot be rewritten/);
    await expect(Invoice.bulkWrite([{ updateOne: { filter: { _id: invoice.id }, update: { $set: { totalAmount: 1 } } } }])).rejects.toThrow(/guarded invoice/);
  });
  it("allows settlement while preserving the issued tax snapshot", async () => {
    const f = await fixture(); const response = await post(f.body); const data = response.json().data;
    const payment = await app.inject({ method: "POST", url: `/api/invoices/${data.id}/payments`, headers: { ...headers, "idempotency-key": crypto.randomUUID() }, payload: { amount: 210, paymentMethod: "cash" } });
    expect(payment.statusCode, payment.body).toBe(200);
    expect((await Invoice.findById(data.id)).status).toBe("paid");
    expect((await Invoice.findById(data.id)).taxDocument.toObject()).toEqual(data.taxDocument && { ...data.taxDocument, issuedAt: new Date(data.taxDocument.issuedAt), issuedBy: new mongoose.Types.ObjectId(data.taxDocument.issuedBy) });
  });
  it("retains a historical invoice number and rupee amounts during settlement", async () => {
    const f = await fixture(); const invoice = await Invoice.create({ organizationId, locationId: f.location.id, patientId: f.patient.id, doctorId,
      invoiceNumber: `INV-2026-ABCDEF-${crypto.randomUUID()}`, items: [{ description: "Historical", amount: 10.23, quantity: 1 }], subtotal: 10.23, totalAmount: 10.23 });
    const before = invoice.toObject();
    const paid = await app.inject({ method: "POST", url: `/api/invoices/${invoice.id}/payments`, headers: { ...headers, "idempotency-key": crypto.randomUUID() }, payload: { amount: 10.23, paymentMethod: "cash" } });
    expect(paid.statusCode).toBe(200); const stored = await Invoice.findById(invoice.id);
    expect(stored.invoiceNumber).toBe(before.invoiceNumber); expect(stored.totalAmount).toBe(before.totalAmount); expect(stored.documentVersion).toBeUndefined();
  });
  it("reconciles inclusive rounding at a one-paise boundary without losing a paise", () => {
    for (const gross of [1, 3, 7, 105, 199, 10001]) {
      const tax = inclusiveTax(gross, 18);
      expect(tax.baseAmountPaise + tax.cgstPaise + tax.sgstPaise).toBe(gross);
      expect(Math.abs(tax.cgstPaise - tax.sgstPaise)).toBeLessThanOrEqual(1);
    }
  });
});
