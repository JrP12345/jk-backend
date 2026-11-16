import crypto from "node:crypto";
import mongoose from "mongoose";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { pharmacyRetailFixture } from "./helpers/pharmacyRetailFixture.ts";
import { createDeviceChallenge, enrollOfflineDevice, enrollmentProofMessage, revokeOfflineDevice } from "../services/PharmacyOfflineDeviceService.ts";
import { acquireOfflineAuthority, offlineAuthorityProof, readOfflineAuthority } from "../services/PharmacyOfflineAuthorityService.ts";
import { prepareOfflineAuthoritySnapshot, readOfflineSnapshotPage } from "../services/PharmacyOfflineSnapshotService.ts";
import { activateOfflineCheckout, offlineActivationMessage } from "../services/PharmacyOfflineGrantService.ts";
import { importOfflinePharmacyReceipt, offlineReceiptProofMessage } from "../services/PharmacyOfflineImportService.ts";
import { closeOfflineCheckout, offlineStopMessage } from "../services/PharmacyOfflineCloseService.ts";
import { Location } from "../models/Location.ts";
import { readFileSync } from "node:fs";
import { offlineDocumentPolicy, ORIGINAL_OFFLINE_POLICY } from "../utilities/pharmacyOfflinePolicy.ts";
import { buildOfflinePharmacyDocument as originalDocument } from "../utilities/offlinePolicies/v1/pharmacyOfflineDocument.ts";
import { buildOfflinePharmacyDocument, offlineEvidenceCanonical, type OfflineDocumentProduct, type OfflineDocumentLot, type OfflineIssuedReceipt } from "../utilities/pharmacyOfflineDocument.ts";
import { PHARMACY_CALCULATION_ENGINE_SHA256 } from "../utilities/pharmacyCalculationVersion.ts";
import { PHARMACY_OFFLINE_DOCUMENT_SHA256 } from "../utilities/pharmacyOfflineDocumentVersion.ts";
import { indiaFinancialYear } from "../utilities/indiaFinancialYear.ts";
import { CashierShift } from "../models/CashierShift.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { Invoice } from "../models/Invoice.ts";
import { InvoiceCollectionReceipt } from "../models/InvoiceCollectionReceipt.ts";
import { PharmacyOfflineAuthority } from "../models/PharmacyOfflineAuthority.ts";
import { PharmacyOfflineGrant } from "../models/PharmacyOfflineGrant.ts";
import { PharmacyOfflineImport } from "../models/PharmacyOfflineImport.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { decryptField } from "../utilities/cryptoEnvelope.ts";

beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
afterEach(() => vi.restoreAllMocks());
it("retains byte-pinned original policy sources for receipts issued before a later deployment", () => {
  for (const [name, expected] of [["pharmacyCalculation", ORIGINAL_OFFLINE_POLICY.calculation], ["pharmacyOfflineDocument", ORIGINAL_OFFLINE_POLICY.document]]) {
    const source = readFileSync(new URL(`../utilities/offlinePolicies/v1/${name}.ts`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
    expect(crypto.createHash("sha256").update(source).digest("hex")).toBe(expected);
  }
  expect(offlineDocumentPolicy(ORIGINAL_OFFLINE_POLICY.calculation, ORIGINAL_OFFLINE_POLICY.document)).toBe(originalDocument);
  expect(offlineDocumentPolicy("0".repeat(64), ORIGINAL_OFFLINE_POLICY.document)).toBeNull();
});
const digest = (value: unknown) => crypto.createHash("sha256").update(offlineEvidenceCanonical(value)).digest("hex");
async function setup(customNumbering = false, http = false) {
  const f = await pharmacyRetailFixture(["MANAGE_ORGANIZATION", "PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT"]), scope = { organizationId: f.organizationId, locationId: f.locationId, actorId: f.user.id };
  const req = { user: { id: f.user.id, role: f.role, organization_id: f.organizationId, authVersion: f.user.authVersion }, query: {} } as unknown as FastifyRequest;
  if (customNumbering) {
    const response = await app.inject({ method: "PUT", url: `/api/pharmacy/locations/${f.locationId}/invoice-numbering`, headers: f.headers,
      payload: { expectedRevision: 0, expectedFinancialYear: indiaFinancialYear().label, prefixTemplate: "OWNER/", digits: 6, resetPolicy: "continuous", nextNumber: 137, reviewReference: "Synthetic owner numbering review" } });
    expect(response.statusCode, response.body).toBe(200);
  }
  const keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }), publicKey = keys.publicKey.export({ format: "jwk" }), deviceId = crypto.randomUUID();
  const sign = (message: string) => crypto.sign("sha256", Buffer.from(message), { key: keys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  const challenge = await createDeviceChallenge(scope, deviceId, { kty: "EC", crv: "P-256", x: publicKey.x!, y: publicKey.y! });
  const enrollment = { expectedRevision: 0, expectedNumberingRevision: customNumbering ? 1 : 0, expectedFinancialYear: indiaFinancialYear().label, count: 10, deviceName: "Synthetic offline PC", reviewReference: "Synthetic operator review", confirmed: true as const };
  await enrollOfflineDevice(scope, { ...enrollment, challengeId: challenge.challengeId, proof: sign(enrollmentProofMessage(challenge.context, enrollment)) });
  const drawer = (await CashierShift.findOne({ locationId: f.locationId, status: "active" }))!;
  const claim = { authorityId: crypto.randomUUID(), deviceId, expectedDeviceRevision: 1, drawerId: drawer.id, expectedDrawerRevision: drawer.revision, requestedAt: new Date().toISOString(), reviewReference: "Synthetic stock ownership review", confirmed: true as const };
  const path = `/api/pharmacy/locations/${f.locationId}/offline-authority`;
  const post = async (action: string, payload: object) => { const response = await app.inject({ method: "POST", url: `${path}/${action}`, headers: f.headers, payload }); expect(response.statusCode, response.body).toBe(200); return response.json().data; };
  const ownership = { ...claim, proof: sign(offlineAuthorityProof(scope, claim)) };
  if (http) await post("acquire", ownership); else await acquireOfflineAuthority(req, f.locationId, ownership);
  const prepared = http ? await post("prepare", { authorityId: claim.authorityId }) : await prepareOfflineAuthoritySnapshot(req, f.locationId, claim.authorityId), manifest = JSON.parse(prepared.payload);
  const activation = { authorityId: claim.authorityId, expectedRevision: 1, manifestDigest: prepared.sha256, requestedAt: new Date().toISOString(), reviewReference: "Synthetic durable preparation confirmed", confirmed: true as const };
  const activate = { ...activation, proof: sign(offlineActivationMessage(scope, activation)) };
  const activated = http ? await post("activate", activate) : await activateOfflineCheckout(req, f.locationId, activate), grant = JSON.parse(activated.payload);
  const records = JSON.parse((await readOfflineSnapshotPage(req, f.locationId, claim.authorityId, 0)).payload).records;
  const product = records.find((row: { kind: string }) => row.kind === "product") as OfflineDocumentProduct & { stockRevision: number };
  const lot = records.find((row: { kind: string }) => row.kind === "lot") as OfflineDocumentLot;
  const seal = (receipt: OfflineIssuedReceipt) => { const value = digest(receipt); return { receipt, digest: value, deviceSignature: sign(offlineReceiptProofMessage(claim.authorityId, value)) }; };
  const command = (sequence = grant.lease.next, quantity = 2, before = 10, lotRevision = 0, productRevision = product.stockRevision, previousDigest: string | null = null) => {
    const commandId = crypto.randomUUID(), issuedAt = new Date().toISOString();
    const line = { lineId: "offline-line-0001", medicineId: product.id, discountPaise: 0, allocations: [{ lotId: lot.id, quantity, expectedRevision: lotRevision }] };
    const document = buildOfflinePharmacyDocument({ actorId: scope.actorId, issuedAt, financialYear: grant.lease.financialYear, issuer: manifest.issuer, issuerRevision: manifest.issuerRevision,
      issuerReviewReference: manifest.issuerReviewReference, invoiceDiscountPaise: 0, roundOffPaise: 0, lines: [{ lineId: line.lineId, product, allocations: [{ ...lot, quantity }], discountPaise: 0 }] });
    const payment = { manualConfirmed: true as const, shiftId: drawer.id, drawerCode: drawer.drawerCode!, cashTenderedPaise: document.calculation.totals.payablePaise + 500 };
    const original = { commandId, leaseId: grant.enrollmentId, actorId: scope.actorId, invoice: document, lines: [line], payment };
    const numbering = grant.lease.format ? { numberingVersion: 3, invoiceSeries: grant.lease.prefix, numberingSnapshot: { ...grant.lease.format, version: 1 as const, prefix: grant.lease.prefix, sequence } }
      : { numberingVersion: 2, invoiceSeries: grant.lease.prefix.slice(1, 5) };
    const receipt: OfflineIssuedReceipt = { version: 2, authorityId: claim.authorityId, manifestDigest: prepared.sha256, calculationEngineSha256: PHARMACY_CALCULATION_ENGINE_SHA256, documentEngineSha256: PHARMACY_OFFLINE_DOCUMENT_SHA256,
      scope: { organizationId: f.organizationId, locationId: f.locationId, deviceId }, commandId, leaseId: grant.enrollmentId, sequence, previousDigest, requestDigest: digest(original),
      invoice: { ...document, ...numbering, invoiceNumber: `${grant.lease.prefix}${String(sequence).padStart(grant.lease.format?.digits ?? 6, "0")}` }, lines: [line],
      payment: { ...payment, collectedPaise: document.calculation.totals.payablePaise, changePaise: 500, evidenceMode: "staff_confirmed_manual" },
      stock: [{ lotId: lot.id, before, after: before - quantity, revision: lotRevision + 1 }], products: [{ medicineId: product.id, before, after: before - quantity, revision: productRevision + 1 }] };
    return seal(receipt);
  };
  return { ...f, scope, req, keys, sign, drawer, claim, activate, activated, grant, product, lot, command, seal };
}
it("activates only the completely prepared original PC and recovers the exact grant", async () => {
  const f = await setup(); expect(f.grant).toMatchObject({ checkoutEnabled: true, actorId: f.user.id, authorityId: f.claim.authorityId });
  expect(await activateOfflineCheckout(f.req, f.locationId, f.activate)).toEqual(f.activated);
  expect(await PharmacyOfflineGrant.countDocuments({ authorityId: f.claim.authorityId })).toBe(1); expect(await Invoice.countDocuments({ locationId: f.locationId })).toBe(0);
  const changed = { ...f.activate, reviewReference: "A different declaration" };
  await expect(activateOfflineCheckout(f.req, f.locationId, { ...changed, proof: f.sign(offlineActivationMessage(f.scope, changed)) })).rejects.toMatchObject({ statusCode: 409 });
});

it("holds the branch until all device-signed receipts reach the exact stopped checkpoint, then closes once", async () => {
  const f = await setup(), command = f.command();
  const stop = { authorityId: f.claim.authorityId, sequence: command.receipt.sequence, lastDigest: command.digest, stoppedAt: new Date().toISOString(), reviewReference: "Synthetic end of offline operation", confirmed: true as const };
  const proof = f.sign(offlineStopMessage({ organizationId: f.organizationId, locationId: f.locationId, deviceId: f.claim.deviceId }, stop));
  await expect(closeOfflineCheckout(f.req, f.locationId, { ...stop, proof })).rejects.toMatchObject({ statusCode: 409 });
  expect((await Location.findById(f.locationId))!.pharmacyOfflineOwner).toBe(f.claim.authorityId);
  await importOfflinePharmacyReceipt(f.req, f.locationId, command);
  const result = await closeOfflineCheckout(f.req, f.locationId, { ...stop, proof });
  expect(result).toMatchObject({ state: "closed", sequence: command.receipt.sequence, reservedNumbersRetained: true });
  expect(await closeOfflineCheckout(f.req, f.locationId, { ...stop, proof })).toEqual(result);
  expect((await Location.findById(f.locationId))!.pharmacyOfflineOwner).toBeUndefined();
  expect((await CashierShift.findById(f.drawer.id))!.pharmacyOfflineOwner).toBeUndefined();
  const later = f.command(command.receipt.sequence + 1, 1, 8, 1, 2, command.digest);
  await expect(importOfflinePharmacyReceipt(f.req, f.locationId, later)).rejects.toMatchObject({ statusCode: 409 });
  expect(await importOfflinePharmacyReceipt(f.req, f.locationId, command)).toMatchObject({ digest: command.digest });
  const drawer = (await CashierShift.findById(f.drawer.id))!;
  const nextClaim = { ...f.claim, authorityId: crypto.randomUUID(), expectedDrawerRevision: drawer.revision, requestedAt: new Date().toISOString() };
  await expect(acquireOfflineAuthority(f.req, f.locationId, { ...nextClaim, proof: f.sign(offlineAuthorityProof(f.scope, nextClaim)) })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("never recycled") });
  const fresh = { ...nextClaim, nextAllocation: { count: 3, expectedNumberingRevision: 0, expectedFinancialYear: indiaFinancialYear().label } };
  const signed = { ...fresh, proof: f.sign(offlineAuthorityProof(f.scope, fresh)) };
  const next = await acquireOfflineAuthority(f.req, f.locationId, signed);
  expect(JSON.parse(next.payload).lease).toMatchObject({ next: f.grant.lease.last + 1, last: f.grant.lease.last + 3 });
  expect(await acquireOfflineAuthority(f.req, f.locationId, signed)).toEqual(next);
  const prepared = await prepareOfflineAuthoritySnapshot(f.req, f.locationId, fresh.authorityId);
  expect(JSON.parse(prepared.payload).lease.next).toBe(f.grant.lease.last + 1);
});

it("does not free an activated branch for a forged checkpoint or failed reconciliation audit", async () => {
  const f = await setup();
  const stop = { authorityId: f.claim.authorityId, sequence: f.grant.lease.next - 1, lastDigest: null, stoppedAt: new Date().toISOString(), reviewReference: "Synthetic unused activated ledger", confirmed: true as const };
  const proof = f.sign(offlineStopMessage({ organizationId: f.organizationId, locationId: f.locationId, deviceId: f.claim.deviceId }, stop));
  await expect(closeOfflineCheckout(f.req, f.locationId, { ...stop, proof: "A".repeat(86) })).rejects.toMatchObject({ statusCode: 403 });
  vi.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("Synthetic close audit unavailable"));
  await expect(closeOfflineCheckout(f.req, f.locationId, { ...stop, proof })).rejects.toThrow(/audit/);
  expect((await Location.findById(f.locationId))!.pharmacyOfflineOwner).toBe(f.claim.authorityId);
  expect((await CashierShift.findById(f.drawer.id))!.pharmacyOfflineOwner).toBe(f.claim.authorityId);
  vi.restoreAllMocks(); expect(await closeOfflineCheckout(f.req, f.locationId, { ...stop, proof })).toMatchObject({ state: "closed" });
});
it("imports original number, cash/payment time and stock atomically; replay creates no second financial record", async () => {
  const f = await setup(), command = f.command(), ack = await importOfflinePharmacyReceipt(f.req, f.locationId, command);
  expect(ack).toMatchObject({ commandId: command.receipt.commandId, invoiceNumber: command.receipt.invoice.invoiceNumber, digest: command.digest });
  const invoice = (await Invoice.findById(ack.serverInvoiceId))!;
  expect(invoice).toMatchObject({ status: "paid", amountPaid: 20, balanceDue: 0 }); expect(invoice.issuedAt!.toISOString()).toBe(command.receipt.invoice.issuedAt);
  const payment = (await InvoiceCollectionReceipt.findOne({ invoiceId: invoice._id }))!;
  expect(payment).toMatchObject({ collectedPaise: 2000, cashTenderedPaise: 2500, cashChangePaise: 500 }); expect(payment.paidAt.toISOString()).toBe(command.receipt.invoice.issuedAt);
  expect((await Medicine.findById(f.medicine.id))!).toMatchObject({ stockQuantity: 8, stockRevision: 2 });
  expect((await MedicineBatch.findById(f.lot.id))!).toMatchObject({ quantity: 8, offlineImportRevision: { authorityId: f.claim.authorityId, revision: 1 } });
  expect(await importOfflinePharmacyReceipt(f.req, f.locationId, command)).toEqual(ack);
  expect(await Invoice.countDocuments({ locationId: f.locationId })).toBe(1); expect(await InvoiceCollectionReceipt.countDocuments({ locationId: f.locationId })).toBe(1);
  const imported = (await PharmacyOfflineImport.findOne({ authorityId: f.claim.authorityId }).select("+evidenceCiphertext"))!;
  expect(imported.evidenceCiphertext).not.toContain("Walk-in"); expect(decryptField(imported.evidenceCiphertext)).toBe(offlineEvidenceCanonical(command.receipt));
});
it("requires ordered receipts and an exact preceding digest, while allowing late historical synchronization", async () => {
  const f = await setup(), first = f.command(), second = f.command(first.receipt.sequence + 1, 3, 8, 1, 2, first.digest);
  await expect(importOfflinePharmacyReceipt(f.req, f.locationId, second)).rejects.toMatchObject({ statusCode: 409 });
  await importOfflinePharmacyReceipt(f.req, f.locationId, first);
  const broken = structuredClone(second.receipt); broken.previousDigest = "0".repeat(64);
  await expect(importOfflinePharmacyReceipt(f.req, f.locationId, f.seal(broken))).rejects.toMatchObject({ statusCode: 409 });
  await PharmacyOfflineAuthority.collection.updateOne({ authorityId: f.claim.authorityId }, { $set: { validUntil: new Date("2020-01-01") } });
  await MedicineBatch.collection.updateOne({ _id: new mongoose.Types.ObjectId(f.lot.id) }, { $set: { status: "expired" } });
  await importOfflinePharmacyReceipt(f.req, f.locationId, second);
  expect((await Medicine.findById(f.medicine.id))!).toMatchObject({ stockQuantity: 5, stockRevision: 3 });
  expect((await MedicineBatch.findById(f.lot.id))!).toMatchObject({ quantity: 5, status: "expired" });
  expect(await Invoice.countDocuments({ locationId: f.locationId })).toBe(2);
});
it("rolls back invoice, stock, payment and import progress when required financial audit fails", async () => {
  const f = await setup(), command = f.command(); vi.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("Synthetic required financial audit failure"));
  await expect(importOfflinePharmacyReceipt(f.req, f.locationId, command)).rejects.toThrow(/audit/);
  expect(await Invoice.countDocuments({ locationId: f.locationId })).toBe(0); expect(await InvoiceCollectionReceipt.countDocuments({ locationId: f.locationId })).toBe(0);
  expect(await PharmacyOfflineImport.countDocuments({ authorityId: f.claim.authorityId })).toBe(0); expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
  expect((await MedicineBatch.findById(f.lot.id))!.quantity).toBe(10); expect((await PharmacyOfflineAuthority.findOne({ authorityId: f.claim.authorityId }))!.importedSequence).toBe(0);
  vi.restoreAllMocks(); expect((await importOfflinePharmacyReceipt(f.req, f.locationId, command)).sequence).toBe(1);
});
it("rejects signed price/number/stock conflicts and foreign device proof without silently repricing an issued bill", async () => {
  const f = await setup();
  for (const variant of ["price", "number", "stock"] as const) {
    const receipt = f.command().receipt;
    if (variant === "price") receipt.invoice.items[0].amount = 1;
    if (variant === "number") receipt.invoice.invoiceNumber = "I00012627/999999";
    if (variant === "stock") receipt.stock[0].before = 9;
    await expect(importOfflinePharmacyReceipt(f.req, f.locationId, f.seal(receipt))).rejects.toMatchObject({ statusCode: 409 });
  }
  const invalid = f.command(); invalid.deviceSignature = "a".repeat(86);
  await expect(importOfflinePharmacyReceipt(f.req, f.locationId, invalid)).rejects.toMatchObject({ statusCode: 403 });
  expect(await Invoice.countDocuments({ locationId: f.locationId })).toBe(0); expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
});
it("serializes duplicate importers into one bill/payment/stock effect", async () => {
  const f = await setup(), command = f.command();
  const results = await Promise.all([importOfflinePharmacyReceipt(f.req, f.locationId, command), importOfflinePharmacyReceipt(f.req, f.locationId, command)]);
  expect(results[0]).toEqual(results[1]); expect(await Invoice.countDocuments({ locationId: f.locationId })).toBe(1);
  expect(await InvoiceCollectionReceipt.countDocuments({ locationId: f.locationId })).toBe(1); expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(8);
});

it("preserves the owner's captured numbering rather than allocating a replacement on import", async () => {
  const f = await setup(true), command = f.command();
  const ack = await importOfflinePharmacyReceipt(f.req, f.locationId, command), invoice = (await Invoice.findById(ack.serverInvoiceId))!;
  expect(invoice.invoiceNumber).toBe("OWNER/000137"); expect(invoice.numberingVersion).toBe(3);
  expect(invoice.numberingSnapshot).toMatchObject({ prefix: "OWNER/", digits: 6, sequence: 137, configurationRevision: 1 });
  expect((await importOfflinePharmacyReceipt(f.req, f.locationId, command)).serverInvoiceId).toBe(ack.serverInvoiceId);
});

it("rejects a foreign branch operator and conflicting commands for the same original sequence", async () => {
  const f = await setup(), foreign = await setup(), first = f.command(), other = f.command();
  await expect(importOfflinePharmacyReceipt(foreign.req, f.locationId, first)).rejects.toMatchObject({ statusCode: expect.any(Number) });
  const results = await Promise.allSettled([importOfflinePharmacyReceipt(f.req, f.locationId, first), importOfflinePharmacyReceipt(f.req, f.locationId, other)]);
  expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
  expect(await Invoice.countDocuments({ locationId: f.locationId })).toBe(1); expect(await InvoiceCollectionReceipt.countDocuments({ locationId: f.locationId })).toBe(1);
  expect(await Invoice.countDocuments({ locationId: foreign.locationId })).toBe(0);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(8);
});

it("exposes bounded authenticated import and original grant reads without caching financial responses", async () => {
  const f = await setup(false, true), command = f.command(), path = `/api/pharmacy/locations/${f.locationId}/offline-authority`;
  expect((await app.inject({ method: "POST", url: `${path}/import`, payload: command })).statusCode).toBe(401);
  const bad = await app.inject({ method: "POST", url: `${path}/import`, headers: f.headers, payload: { ...command, priceOverride: 1 } }); expect(bad.statusCode).toBe(400);
  const grant = await app.inject({ method: "GET", url: `${path}/${f.claim.authorityId}/grant`, headers: f.headers }); expect(grant.statusCode, grant.body).toBe(200); expect(grant.headers["cache-control"]).toBe("no-store");
  const imported = await app.inject({ method: "POST", url: `${path}/import`, headers: f.headers, payload: command }); expect(imported.statusCode, imported.body).toBe(200); expect(imported.headers["cache-control"]).toBe("no-store");
  expect(imported.json().data).toMatchObject({ digest: command.digest, invoiceNumber: command.receipt.invoice.invoiceNumber, sequence: command.receipt.sequence });
});
it("blocks PC replacement while held, then retains original receipt replay after reconciled key replacement", async () => {
  const f = await setup(), command = f.command();
  await revokeOfflineDevice(f.scope, 1, "Synthetic reviewed PC replacement");
  const keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }), jwk = keys.publicKey.export({ format: "jwk" }), deviceId = crypto.randomUUID();
  const publicKey = { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! };
  await expect(createDeviceChallenge(f.scope, deviceId, publicKey)).rejects.toMatchObject({ statusCode: 409 });
  await PharmacyOfflineAuthority.collection.updateOne({ authorityId: f.claim.authorityId }, { $set: { validUntil: new Date("2020-01-01") } });
  await expect(createDeviceChallenge(f.scope, deviceId, publicKey)).rejects.toMatchObject({ statusCode: 409 });
  const ack = await importOfflinePharmacyReceipt(f.req, f.locationId, command);
  const stop = { authorityId: f.claim.authorityId, sequence: command.receipt.sequence, lastDigest: command.digest, stoppedAt: new Date().toISOString(), reviewReference: "Synthetic complete stopped ledger", confirmed: true as const };
  await closeOfflineCheckout(f.req, f.locationId, { ...stop, proof: f.sign(offlineStopMessage({ organizationId: f.organizationId, locationId: f.locationId, deviceId: f.claim.deviceId }, stop)) });
  const challenge = await createDeviceChallenge(f.scope, deviceId, publicKey), intent = { expectedRevision: 2, expectedNumberingRevision: 0, expectedFinancialYear: indiaFinancialYear().label, count: 3, deviceName: "Replacement PC", reviewReference: "Synthetic actual replacement review", confirmed: true as const };
  const proof = crypto.sign("sha256", Buffer.from(enrollmentProofMessage(challenge.context, intent)), { key: keys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  const result = await enrollOfflineDevice(f.scope, { ...intent, challengeId: challenge.challengeId, proof }); expect(result.device!.deviceId).toBe(deviceId);
  expect(await readOfflineAuthority(f.req, f.locationId)).toMatchObject({ owned: false, hasHistory: false });
  expect(await importOfflinePharmacyReceipt(f.req, f.locationId, command)).toEqual(ack);
  expect(await Invoice.countDocuments({ locationId: f.locationId })).toBe(1); expect(await InvoiceCollectionReceipt.countDocuments({ locationId: f.locationId })).toBe(1);
});
