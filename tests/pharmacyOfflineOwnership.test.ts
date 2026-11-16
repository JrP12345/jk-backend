import crypto from "node:crypto";
import mongoose from "mongoose";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { pharmacyRetailFixture as fixture } from "./helpers/pharmacyRetailFixture.ts";
import { CashierShift } from "../models/CashierShift.ts";
import { Location } from "../models/Location.ts";
import { Medicine } from "../models/Medicine.ts";
import { PharmacyOfflineAuthority } from "../models/PharmacyOfflineAuthority.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Invoice } from "../models/Invoice.ts";
import { acquireOfflineAuthority, offlineAuthorityProof, readOfflineAuthority, releaseUnusedOfflineAuthority, type AuthorityIntent } from "../services/PharmacyOfflineAuthorityService.ts";
import { createDeviceChallenge, enrollOfflineDevice, enrollmentProofMessage } from "../services/PharmacyOfflineDeviceService.ts";
import { revokeOfflineDevice } from "../services/PharmacyOfflineDeviceService.ts";
import { pinActivePharmacyLocation, pinPharmacyContinuityLocation } from "../utilities/pharmacyCapability.ts";
import { withTransaction } from "../utilities/transaction.ts";
import { withVerifiedOfflineOwnership } from "../utilities/pharmacyOfflineOwnership.ts";
import { claimCashierDrawer } from "../services/CashierDrawerService.ts";
import { indiaFinancialYear } from "../utilities/indiaFinancialYear.ts";
import { PharmacyTaxProfile } from "../models/PharmacyTaxProfile.ts";
import { PHARMACY_CALCULATION_ENGINE_SHA256 } from "../services/InvoiceCalculationService.ts";
import { prepareOfflineAuthoritySnapshot, readOfflineSnapshotPage } from "../services/PharmacyOfflineSnapshotService.ts";
import { PharmacyOfflineSnapshotPage } from "../models/PharmacyOfflineSnapshotPage.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";

beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
afterEach(() => vi.restoreAllMocks());
async function setup(permissions = ["MANAGE_ORGANIZATION", "PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT", "PHARMACY_ADJUST_STOCK", "PHARMACY_RECEIVE_STOCK", "PHARMACY_VIEW_COST"]) {
  const f = await fixture(permissions), scope = { organizationId: f.organizationId, locationId: f.locationId, actorId: f.user.id }, keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }), jwk = keys.publicKey.export({ format: "jwk" });
  const deviceId = crypto.randomUUID(), challenge = await createDeviceChallenge(scope, deviceId, { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! });
  const fields = { expectedRevision: 0, expectedNumberingRevision: 0, expectedFinancialYear: indiaFinancialYear().label, count: 20, deviceName: "Synthetic PC", reviewReference: "Synthetic numbering review", confirmed: true as const };
  const proof = crypto.sign("sha256", Buffer.from(enrollmentProofMessage(challenge.context, fields)), { key: keys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  await enrollOfflineDevice(scope, { ...fields, challengeId: challenge.challengeId, proof });
  const drawer = (await CashierShift.findOne({ locationId: f.locationId, status: "active" }))!;
  const req = { user: { id: f.user.id, role: f.role, organization_id: f.organizationId, authVersion: f.user.authVersion }, query: {} } as unknown as FastifyRequest;
  const intent: AuthorityIntent = { authorityId: crypto.randomUUID(), deviceId, expectedDeviceRevision: 1, drawerId: String(drawer._id), expectedDrawerRevision: drawer.revision,
    requestedAt: new Date().toISOString(), reviewReference: "Synthetic actual ownership review", confirmed: true };
  const signed = (value = intent) => ({ ...value, proof: crypto.sign("sha256", Buffer.from(offlineAuthorityProof(scope, value)), { key: keys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") });
  const release = (authorityId = intent.authorityId) => {
    const fields = { authorityId, expectedRevision: 0, reviewReference: "Synthetic cancellation review", confirmed: true as const };
    return { ...fields, proof: crypto.sign("sha256", Buffer.from(`ekavyu.pharmacy.unused-ownership-release.v1\n${JSON.stringify(scope)}\n${JSON.stringify(fields)}`), { key: keys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
  };
  return { ...f, scope, req, drawer, intent, signed, release };
}
it("atomically owns branch and drawer without enabling checkout or changing stock/payment", async () => {
  const f = await setup(), result = await acquireOfflineAuthority(f.req, f.locationId, f.signed());
  expect(result.state).toBe("held"); expect(JSON.parse(result.payload)).toMatchObject({ authorityId: f.intent.authorityId, checkoutEnabled: false, actorId: f.user.id,
    calculation: { policy: "pharmacy-paise-v2", sha256: PHARMACY_CALCULATION_ENGINE_SHA256 } });
  expect((await Location.findById(f.locationId))!.pharmacyOfflineOwner).toBe(f.intent.authorityId);
  expect((await CashierShift.findById(f.drawer.id))!.pharmacyOfflineOwner).toBe(f.intent.authorityId);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10); expect(await Invoice.countDocuments({ locationId: f.locationId })).toBe(0);
});
it("freezes issuer and product classification while held and restores normal reviewed settings after unused release", async () => {
  const f = await setup(), initial = (await PharmacyTaxProfile.findOne({ locationId: f.locationId }))!;
  const profile = { expectedRevision: initial.revision, registration: initial.registration, legalName: initial.legalName, address: initial.address,
    stateCode: initial.stateCode, drugLicenceNumbers: [...initial.drugLicenceNumbers], authorisedSignatory: initial.authorisedSignatory,
    reviewReference: "Synthetic updated profile review", pricesIncludeTax: true, minimumHsnDigits: 4, electronicReportingRequired: false };
  const tax = { expectedRevision: 1, hsnCode: f.medicine.hsnCode, gstRate: f.medicine.gstRate, unitCode: "NOS", treatment: "taxable", reviewReference: "Synthetic product tax review" };
  const dispensing = { expectedRevision: 1, scheduleType: "general", reviewReference: "Synthetic classification review" };
  const requests = [
    { url: `/api/pharmacy/locations/${f.locationId}/tax-profile`, payload: profile },
    { url: `/api/pharmacy/medicines/${f.medicine.id}/tax-classification`, payload: tax },
    { url: `/api/pharmacy/medicines/${f.medicine.id}/dispensing-classification`, payload: dispensing },
  ];
  await acquireOfflineAuthority(f.req, f.locationId, f.signed());
  for (const request of requests) {
    const response = await app.inject({ method: "PUT", ...request, headers: f.headers }); expect(response.statusCode, response.body).toBe(409);
  }
  expect((await PharmacyTaxProfile.findById(initial.id))!.revision).toBe(initial.revision);
  expect((await Medicine.findById(f.medicine.id))!).toMatchObject({ taxRevision: 1, dispensingRevision: 1 });
  await releaseUnusedOfflineAuthority(f.req, f.locationId, f.release());
  for (const request of requests) {
    const response = await app.inject({ method: "PUT", ...request, headers: f.headers }); expect(response.statusCode, response.body).toBe(200);
  }
  expect((await Medicine.findById(f.medicine.id))!).toMatchObject({ taxRevision: 2, dispensingRevision: 2 });
});
it("publishes immutable signed preparation tied to the operator, exact issuer, products, lots and calculation version", async () => {
  const f = await setup(); await acquireOfflineAuthority(f.req, f.locationId, f.signed());
  const result = await prepareOfflineAuthoritySnapshot(f.req, f.locationId, f.intent.authorityId), manifest = JSON.parse(result.payload);
  expect(manifest).toMatchObject({ version: 1, purpose: "ekavyu.pharmacy.prepared-stock.v1", checkoutEnabled: false, authorityId: f.intent.authorityId,
    organizationId: f.organizationId, locationId: f.locationId, actorId: f.user.id, products: 1, lots: 1,
    calculation: { policy: "pharmacy-paise-v2", sha256: PHARMACY_CALCULATION_ENGINE_SHA256 }, issuer: { registration: "unregistered" } });
  expect(crypto.verify("RSA-SHA256", Buffer.from(`ekavyu.pharmacy.prepared-stock.v1\n${result.payload}`),
    crypto.createPublicKey({ key: result.signingKey!.jwk as crypto.JsonWebKeyInput["key"], format: "jwk" }), Buffer.from(result.signature!, "base64url"))).toBe(true);
  const page = await readOfflineSnapshotPage(f.req, f.locationId, f.intent.authorityId, 0), rows = JSON.parse(page.payload).records;
  expect(manifest.pages).toEqual([{ page: 0, sha256: page.sha256 }]);
  expect(crypto.createHash("sha256").update(page.payload).digest("hex")).toBe(page.sha256);
  expect(rows[0]).toMatchObject({ kind: "product", id: f.medicine.id, name: f.medicine.name, stockQuantity: 10, availableQuantity: 10, unitDefinition: { unitsPerPack: 10 }, gstRateBps: 0 });
  expect(rows[1]).toMatchObject({ kind: "lot", medicineId: f.medicine.id, quantity: 10, revision: 0, sellingPricePaise: 1000, mrpPaise: 1200, expiryPrecision: "month" });
  expect(page.payload).not.toMatch(/purchaseCost|costBasis|patientName|cardNumber/);
  expect(await prepareOfflineAuthoritySnapshot(f.req, f.locationId, f.intent.authorityId)).toEqual(result);
  expect(await PharmacyOfflineSnapshotPage.countDocuments({ authorityId: f.intent.authorityId })).toBe(2);
  expect(await AuditLog.countDocuments({ action: "PHARMACY_OFFLINE_STOCK_PREPARED", organizationId: f.organizationId })).toBe(1);
  await expect(PharmacyOfflineSnapshotPage.updateOne({ authorityId: f.intent.authorityId, page: 0 }, { $set: { payload: "changed" } })).rejects.toThrow(/overwritten/);
  await expect(PharmacyOfflineSnapshotPage.deleteMany({ authorityId: f.intent.authorityId })).rejects.toThrow(/removed/);
  expect(await Invoice.countDocuments({ locationId: f.locationId })).toBe(0);
});
it("rolls back all preparation pages and publication on required audit failure", async () => {
  const f = await setup(); await acquireOfflineAuthority(f.req, f.locationId, f.signed());
  vi.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("Synthetic preparation audit failure"));
  await expect(prepareOfflineAuthoritySnapshot(f.req, f.locationId, f.intent.authorityId)).rejects.toThrow(/audit/);
  expect(await PharmacyOfflineSnapshotPage.countDocuments({ authorityId: f.intent.authorityId })).toBe(0);
  expect((await PharmacyOfflineAuthority.findOne({ authorityId: f.intent.authorityId }))!.revision).toBe(0);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
  expect(await Invoice.countDocuments({ locationId: f.locationId })).toBe(0);
  // Failure never activates checkout, so the original audited cancellation remains valid.
  expect((await releaseUnusedOfflineAuthority(f.req, f.locationId, f.release())).state).toBe("closed");
});
it("preparation rejects inconsistent stock, missing MRP, stale operator and revoked device without publishing partial data", async () => {
  for (const variant of ["aggregate", "mrp", "operator", "revoked"] as const) {
    const f = await setup(); await acquireOfflineAuthority(f.req, f.locationId, f.signed());
    if (variant === "aggregate") await Medicine.collection.updateOne({ _id: f.medicine._id }, { $set: { stockQuantity: 9 } });
    if (variant === "mrp") await MedicineBatch.collection.updateOne({ medicineId: f.medicine._id }, { $unset: { mrpPaise: "", mrp: "" } });
    if (variant === "operator") await mongoose.models.User.collection.updateOne({ _id: f.user._id }, { $inc: { authVersion: 1 } });
    if (variant === "revoked") await revokeOfflineDevice(f.scope, 1, "Synthetic revocation review");
    await expect(prepareOfflineAuthoritySnapshot(f.req, f.locationId, f.intent.authorityId)).rejects.toMatchObject({ statusCode: variant === "operator" || variant === "revoked" ? 403 : 409 });
    expect(await PharmacyOfflineSnapshotPage.countDocuments({ authorityId: f.intent.authorityId })).toBe(0);
    expect((await PharmacyOfflineAuthority.findOne({ authorityId: f.intent.authorityId }))!.revision).toBe(0);
  }
});
it("preparation pages stay bounded and complete while restricted/unreviewed products are excluded", async () => {
  const f = await setup(), template = (await Medicine.findById(f.medicine.id))!.toObject(), originalLot = (await MedicineBatch.findOne({ medicineId: f.medicine._id }).lean())!;
  const extras = await Medicine.insertMany(Array.from({ length: 205 }, (_, i) => ({ ...template, _id: new mongoose.Types.ObjectId(), stockQuantity: 10, stockRevision: 1,
    name: `Synthetic available ${i}`, barcodes: undefined, dispensingReview: { ...template.dispensingReview, confirmedBy: f.user._id } })));
  await MedicineBatch.insertMany(extras.map(product => ({ ...originalLot, _id: new mongoose.Types.ObjectId(), medicineId: product._id, receiptLineId: crypto.randomUUID() })));
  await Medicine.create({ ...template, _id: new mongoose.Types.ObjectId(), name: "Synthetic restricted", stockQuantity: 0, scheduleType: "schedule_h" });
  await Medicine.create({ ...template, _id: new mongoose.Types.ObjectId(), name: "Synthetic unreviewed", stockQuantity: 0, dispensingReview: undefined });
  await acquireOfflineAuthority(f.req, f.locationId, f.signed());
  const lotsRead = vi.spyOn(MedicineBatch, "find");
  const result = await prepareOfflineAuthoritySnapshot(f.req, f.locationId, f.intent.authorityId), manifest = JSON.parse(result.payload);
  expect(manifest).toMatchObject({ products: 206, lots: 206 }); expect(manifest.pages).toHaveLength(3);
  const rows: Array<{ kind: string; id: string; name?: string }> = [];
  for (const reference of manifest.pages) {
    const page = await readOfflineSnapshotPage(f.req, f.locationId, f.intent.authorityId, reference.page), records = JSON.parse(page.payload).records;
    expect(records.length).toBeLessThanOrEqual(200); expect(Buffer.byteLength(page.payload)).toBeLessThanOrEqual(1024 * 1024); rows.push(...records);
  }
  expect(rows).toHaveLength(412); expect(new Set(rows.map(row => row.id)).size).toBe(412);
  expect(rows.some(row => row.name === "Synthetic restricted" || row.name === "Synthetic unreviewed")).toBe(false);
  expect(lotsRead).toHaveBeenCalledTimes(2);
});
it("serializes concurrent preparation into one immutable manifest without consuming numbers or issuing bills", async () => {
  const f = await setup(); await acquireOfflineAuthority(f.req, f.locationId, f.signed());
  const results = await Promise.all([prepareOfflineAuthoritySnapshot(f.req, f.locationId, f.intent.authorityId), prepareOfflineAuthoritySnapshot(f.req, f.locationId, f.intent.authorityId)]);
  expect(results[0]).toEqual(results[1]); expect(await PharmacyOfflineSnapshotPage.countDocuments({ authorityId: f.intent.authorityId })).toBe(2);
  expect(await AuditLog.countDocuments({ organizationId: f.organizationId, action: "PHARMACY_OFFLINE_STOCK_PREPARED" })).toBe(1);
  expect((await PharmacyOfflineAuthority.findOne({ authorityId: f.intent.authorityId }))!).toMatchObject({ revision: 1, importedSequence: 0 });
  expect(await Invoice.countDocuments({ locationId: f.locationId })).toBe(0);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
});
it("preparation read routes are scoped, uncached and cannot start preparation or enable billing", async () => {
  const f = await setup(), other = await setup(); await acquireOfflineAuthority(f.req, f.locationId, f.signed());
  await prepareOfflineAuthoritySnapshot(f.req, f.locationId, f.intent.authorityId);
  const url = `/api/pharmacy/locations/${f.locationId}/offline-authority/${f.intent.authorityId}/snapshot/-1`;
  const read = await app.inject({ method: "GET", url, headers: f.headers }); expect(read.statusCode, read.body).toBe(200); expect(read.headers["cache-control"]).toBe("no-store");
  expect(JSON.parse(read.json().data.payload).checkoutEnabled).toBe(false);
  expect((await app.inject({ method: "GET", url, headers: other.headers })).statusCode).toBe(404);
  expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
  expect((await app.inject({ method: "GET", url: url.replace("/-1", "/1e0"), headers: f.headers })).statusCode).toBe(400);
  expect((await app.inject({ method: "POST", url, headers: f.headers, payload: {} })).statusCode).toBe(404);
});
it("recovers the exact claim without advancing drawer revision or producing another audit", async () => {
  const f = await setup(), input = f.signed(), first = await acquireOfflineAuthority(f.req, f.locationId, input);
  expect(await acquireOfflineAuthority(f.req, f.locationId, input)).toEqual(first);
  expect((await CashierShift.findById(f.drawer.id))!.revision).toBe(f.drawer.revision + 1);
  expect(await AuditLog.countDocuments({ organizationId: f.organizationId, action: "PHARMACY_OFFLINE_OWNERSHIP_ACQUIRED" })).toBe(1);
  await expect(acquireOfflineAuthority(f.req, f.locationId, f.signed({ ...f.intent, reviewReference: "Changed details" }))).rejects.toMatchObject({ statusCode: 409 });
});
it("blocks online counter, receiving, returns/continuity, drawer lifecycle and branch-mode writes while held", async () => {
  const f = await setup(); await acquireOfflineAuthority(f.req, f.locationId, f.signed());
  await expect(withTransaction(session => pinActivePharmacyLocation(f.locationId, session))).rejects.toMatchObject({ statusCode: 409 });
  await expect(withTransaction(session => pinPharmacyContinuityLocation(f.locationId, session))).rejects.toMatchObject({ statusCode: 409 });
  await expect(withTransaction(session => claimCashierDrawer(f.scope, "INR", session))).rejects.toMatchObject({ statusCode: 409 });
  const mode = await app.inject({ method: "PATCH", url: `/api/pharmacy/locations/${f.locationId}/settings`, headers: f.headers,
    payload: { enabled: true, inventoryMode: "billing_only", expectedRevision: 0, reviewReference: "Synthetic mode change" } }); expect(mode.statusCode, mode.body).toBe(409);
  const stock = await app.inject({ method: "POST", url: "/api/pharmacy/stock-receipts", headers: { ...f.headers, "idempotency-key": crypto.randomUUID() }, payload: {
    medicineId: f.medicine.id, locationId: f.locationId, kind: "opening", receiptLineId: crypto.randomUUID(), expectedUnitVersion: 1, packs: 1, looseUnits: 0,
    batchNumber: "ANOTHER-ACTUAL-LOT", expiry: { precision: "month", value: "2099-12" }, purchaseTotalPaise: 1000, sellingPricePaise: 1000, mrpPaise: 1200, openingSourceReference: "Synthetic count" } }); expect(stock.statusCode, stock.body).toBe(409);
  const sale = await app.inject({ method: "POST", url: "/api/pharmacy/sales", headers: { ...f.headers, "idempotency-key": crypto.randomUUID() }, payload: f.input }); expect(sale.statusCode, sale.body).toBe(409);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
  expect(await Invoice.countDocuments({ locationId: f.locationId })).toBe(0);
});
it("only verified internal scope crosses the held branch/drawer boundary and cannot cross branches", async () => {
  const f = await setup(), other = await setup(); await acquireOfflineAuthority(f.req, f.locationId, f.signed()); await acquireOfflineAuthority(other.req, other.locationId, other.signed());
  await withVerifiedOfflineOwnership({ ...f.scope, authorityId: f.intent.authorityId, drawerId: f.drawer.id }, () => withTransaction(async session => {
    expect(await pinActivePharmacyLocation(f.locationId, session)).toBeTruthy(); expect(await claimCashierDrawer(f.scope, "INR", session)).toBeTruthy();
  }));
  await expect(withVerifiedOfflineOwnership({ ...f.scope, authorityId: f.intent.authorityId, drawerId: f.drawer.id }, () => withTransaction(session => pinActivePharmacyLocation(other.locationId, session)))).rejects.toMatchObject({ statusCode: 409 });
  await expect(withVerifiedOfflineOwnership({ ...f.scope, authorityId: "wrong-authority", drawerId: f.drawer.id }, () => withTransaction(session => pinActivePharmacyLocation(f.locationId, session)))).rejects.toMatchObject({ statusCode: 409 });
});
it("rolls back ownership and drawer revision on required audit failure", async () => {
  const f = await setup(); vi.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("Synthetic failed audit"));
  await expect(acquireOfflineAuthority(f.req, f.locationId, f.signed())).rejects.toThrow(/audit/);
  expect((await Location.findById(f.locationId))!.pharmacyOfflineOwner).toBeUndefined(); expect((await CashierShift.findById(f.drawer.id))!.pharmacyOfflineOwner).toBeUndefined();
  expect((await CashierShift.findById(f.drawer.id))!.revision).toBe(f.drawer.revision); expect(await PharmacyOfflineAuthority.countDocuments({ locationId: f.locationId })).toBe(0);
});
it("rejects another key, stale drawer revision, foreign drawer and expired ownership request", async () => {
  const f = await setup(), other = await setup();
  await expect(acquireOfflineAuthority(f.req, f.locationId, { ...f.signed(), proof: "a".repeat(86) })).rejects.toMatchObject({ statusCode: 403 });
  await expect(acquireOfflineAuthority(f.req, f.locationId, f.signed({ ...f.intent, expectedDrawerRevision: 100 }))).rejects.toMatchObject({ statusCode: 409 });
  await expect(acquireOfflineAuthority(f.req, f.locationId, f.signed({ ...f.intent, drawerId: other.drawer.id }))).rejects.toMatchObject({ statusCode: 409 });
  await expect(acquireOfflineAuthority(f.req, f.locationId, f.signed({ ...f.intent, requestedAt: "2020-01-01T00:00:00.000Z" }))).rejects.toMatchObject({ statusCode: 409 });
});
it("serializes competing ownership claims and leaves unrelated branches available", async () => {
  const f = await setup(), other = await setup();
  const results = await Promise.allSettled([acquireOfflineAuthority(f.req, f.locationId, f.signed()), acquireOfflineAuthority(f.req, f.locationId, f.signed({ ...f.intent, authorityId: crypto.randomUUID() }))]);
  expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
  expect(await PharmacyOfflineAuthority.countDocuments({ locationId: f.locationId })).toBe(1);
  await withTransaction(async session => { expect(await pinActivePharmacyLocation(other.locationId, session)).toBeTruthy(); expect(await claimCashierDrawer(other.scope, "INR", session)).toBeTruthy(); });
});
it("does not reclaim a held branch merely because the grant expires", async () => {
  const f = await setup(); await acquireOfflineAuthority(f.req, f.locationId, f.signed());
  await PharmacyOfflineAuthority.collection.updateOne({ locationId: new mongoose.Types.ObjectId(f.locationId) }, { $set: { validUntil: new Date("2020-01-01") } });
  await expect(withTransaction(session => pinActivePharmacyLocation(f.locationId, session))).rejects.toMatchObject({ statusCode: 409 });
  expect((await readOfflineAuthority(f.req, f.locationId)).owned).toBe(true);
});
it("releases only a never-activated preparation and recovers the same release without changing evidence", async () => {
  const f = await setup(); await acquireOfflineAuthority(f.req, f.locationId, f.signed());
  const input = f.release(), result = await releaseUnusedOfflineAuthority(f.req, f.locationId, input); expect(result.state).toBe("closed");
  expect(await releaseUnusedOfflineAuthority(f.req, f.locationId, input)).toEqual(result);
  expect((await Location.findById(f.locationId))!.pharmacyOfflineOwner).toBeUndefined(); expect((await CashierShift.findById(f.drawer.id))!.pharmacyOfflineOwner).toBeUndefined();
  await withTransaction(session => pinActivePharmacyLocation(f.locationId, session));
  expect(await PharmacyOfflineAuthority.countDocuments({ locationId: f.locationId })).toBe(1);
});

it("cancels an unstarted or response-lost claim without letting a late acquire strand branch ownership", async () => {
  const f = await setup(), request = f.release();
  const cancelled = await releaseUnusedOfflineAuthority(f.req, f.locationId, request);
  expect(cancelled).toMatchObject({ state: "closed", cancelledBeforeOwnership: true });
  expect(await releaseUnusedOfflineAuthority(f.req, f.locationId, request)).toEqual(cancelled);
  await expect(acquireOfflineAuthority(f.req, f.locationId, f.signed())).rejects.toMatchObject({ statusCode: 409 });
  expect((await Location.findById(f.locationId))!.pharmacyOfflineOwner).toBeUndefined();
  expect((await CashierShift.findById(f.drawer.id))!.pharmacyOfflineOwner).toBeUndefined();
});

it("serializes cancellation against an acquisition arriving on another connection", async () => {
  const f = await setup(), results = await Promise.allSettled([acquireOfflineAuthority(f.req, f.locationId, f.signed()), releaseUnusedOfflineAuthority(f.req, f.locationId, f.release())]);
  const row = await PharmacyOfflineAuthority.findOne({ authorityId: f.intent.authorityId });
  const branch = (await Location.findById(f.locationId))!;
  if (row?.state === "held") {
    expect(branch.pharmacyOfflineOwner).toBe(f.intent.authorityId);
    const release = { ...f.release(), expectedRevision: row.revision };
    expect(results.some(result => result.status === "fulfilled")).toBe(true);
    // The original release has revision zero here; a prepared/activated ledger
    // would instead require its audited lifecycle, never a new acquisition.
    await releaseUnusedOfflineAuthority(f.req, f.locationId, release);
  } else expect(branch.pharmacyOfflineOwner).toBeUndefined();
  if (row) expect((await acquireOfflineAuthority(f.req, f.locationId, f.signed())).state).toBe("closed");
  else await expect(acquireOfflineAuthority(f.req, f.locationId, f.signed())).rejects.toMatchObject({ statusCode: 409 });
});
it("cannot use unused release after checkout activation and rolls back a failed release audit", async () => {
  const f = await setup(); await acquireOfflineAuthority(f.req, f.locationId, f.signed());
  vi.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("Synthetic release audit failure"));
  await expect(releaseUnusedOfflineAuthority(f.req, f.locationId, f.release())).rejects.toThrow(/audit/);
  expect((await Location.findById(f.locationId))!.pharmacyOfflineOwner).toBe(f.intent.authorityId); expect((await CashierShift.findById(f.drawer.id))!.pharmacyOfflineOwner).toBe(f.intent.authorityId);
  await PharmacyOfflineAuthority.updateOne({ authorityId: f.intent.authorityId }, { $set: { checkoutActivatedAt: new Date() } });
  await expect(releaseUnusedOfflineAuthority(f.req, f.locationId, f.release())).rejects.toMatchObject({ statusCode: 409 });
  await expect(PharmacyOfflineAuthority.updateOne({ authorityId: f.intent.authorityId }, { $set: { payload: "tampered" } })).rejects.toThrow(/immutable/);
});

it("exposes only authorized ownership reads and leaves acquisition/release HTTP routes disabled", async () => {
  const f = await setup(), other = await setup();
  const path = `/api/pharmacy/locations/${f.locationId}/offline-authority`;
  const first = await app.inject({ method: "GET", url: path, headers: f.headers }); expect(first.statusCode, first.body).toBe(200); expect(first.json().data).toEqual({ owned: false, authority: null, hasHistory: false });
  expect(first.headers["cache-control"]).toBe("no-store");
  expect([403, 404]).toContain((await app.inject({ method: "GET", url: path, headers: other.headers })).statusCode);
  expect((await app.inject({ method: "POST", url: path, headers: f.headers, payload: f.signed() })).statusCode).toBe(404);
  await acquireOfflineAuthority(f.req, f.locationId, f.signed());
  const owned = await app.inject({ method: "GET", url: path, headers: f.headers }); expect(owned.statusCode, owned.body).toBe(200); expect(owned.json().data).toMatchObject({ owned: true, authority: { authorityId: f.intent.authorityId } });
});

it("rejects acquisition after device revocation and rejects foreign-branch ownership", async () => {
  const f = await setup(), other = await setup();
  await expect(acquireOfflineAuthority(other.req, f.locationId, f.signed())).rejects.toMatchObject({ statusCode: 404 });
  await revokeOfflineDevice(f.scope, 1, "Synthetic lost-device review");
  await expect(acquireOfflineAuthority(f.req, f.locationId, f.signed())).rejects.toMatchObject({ statusCode: 409 });
  expect((await Location.findById(f.locationId))!.pharmacyOfflineOwner).toBeUndefined();
});

it("blocks deactivation of an owned branch and restores normal deactivation after unused release", async () => {
  const f = await setup(["MANAGE_ORGANIZATION", "PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT", "MANAGE_LOCATIONS"]);
  await acquireOfflineAuthority(f.req, f.locationId, f.signed());
  const url = `/api/onboarding/locations/${f.locationId}`;
  const held = await app.inject({ method: "DELETE", url, headers: f.headers }); expect(held.statusCode, held.body).toBe(409);
  expect((await Location.findById(f.locationId))!.isActive).toBe(true);
  await releaseUnusedOfflineAuthority(f.req, f.locationId, f.release());
  const released = await app.inject({ method: "DELETE", url, headers: f.headers }); expect(released.statusCode, released.body).toBe(200);
});
