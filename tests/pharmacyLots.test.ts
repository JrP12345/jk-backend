import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Role } from "../models/Role.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { receivePharmacyStock, recoverPharmacyStockReceipt } from "../services/PharmacyStockReceiptService.ts";
import { dispenseMedicineFEFO, addBatchToMedicine } from "../services/PharmacyInventoryService.ts";
import { lotExpiry, normalizeStockReceipt, remainingLotCost, type StockReceiptInput } from "../utilities/pharmacyLot.ts";
import { createAuthSession } from "../utilities/helpers.ts";

const key = () => crypto.randomUUID();
async function fixture(permissions = ["PHARMACY_RECEIVE_STOCK", "PHARMACY_VIEW_STOCK", "PHARMACY_VIEW_COST"]) {
  const organizationId = (await Organization.create({ name: "Synthetic lot owner", city: "Pune", countryCode: "IN", currency: "INR" })).id;
  const locationId = (await Location.create({ organizationId, name: "Synthetic lot branch", city: "Pune", timezone: "Asia/Kolkata" })).id;
  const role = `lot_${key()}`;
  await Role.create({ organizationId, name: role, permissions });
  const user = await User.create({ name: "Synthetic stock receiver", email: `${key()}@example.test`, role });
  await OrgMember.create({ organizationId, userId: user.id, role, locationAccess: { mode: "selected", locationIds: [locationId] } });
  const session = await createAuthSession({ id: user.id, email: user.email!, role, organization_id: organizationId });
  const medicine = await Medicine.create({ locationId, name: "Synthetic lot medicine", genericName: "Synthetic", stockQuantity: 0, price: 10,
    unitDefinition: { version: 1, baseUnit: "tablet", packUnit: "strip", unitsPerPack: 10 } });
  const input: StockReceiptInput = { medicineId: medicine.id, locationId, receiptLineId: key(), kind: "opening", expectedUnitVersion: 1, packs: 1, looseUnits: 2, batchNumber: "PRINTED-001",
    expiry: { precision: "month", value: "2099-12" }, purchaseTotalPaise: 100, sellingPricePaise: 1000, mrpPaise: 1200, openingSourceReference: "Synthetic physical count reference" };
  const authority = { organizationId, locationId, actorId: user.id };
  return { organizationId, locationId, user, medicine, input, authority, headers: { authorization: `Bearer ${session.accessToken}` } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const post = (f: Fixture, fields = {}, requestKey = key()) => app.inject({ method: "POST", url: "/api/pharmacy/stock-receipts", headers: { ...f.headers, "idempotency-key": requestKey }, payload: { ...f.input, ...fields } });
const recover = (f: Fixture, requestKey: string) => app.inject({ method: "GET", url: `/api/pharmacy/stock-receipts/${requestKey}?locationId=${f.locationId}`, headers: f.headers });
beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });

describe("Captured lot receipts and compatible inward", () => {
  it("retains a real legacy label index and blocks repeated labels until reviewed cutover", async () => {
    // Index operations are confined to this file's MongoMemoryReplSet database.
    expect(process.env.NODE_ENV).toBe("test");
    await MedicineBatch.collection.createIndex({ medicineId: 1, locationId: 1, batchNumber: 1 }, { name: "synthetic_legacy_label", unique: true });
    try {
      const f = await fixture();
      expect((await post(f)).statusCode).toBe(201);
      const repeated = await post(f, { kind: "receipt", receiptLineId: key() });
      expect(repeated.statusCode, repeated.body).toBe(409); expect(repeated.json().message).toMatch(/legacy batch-label/);
      expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(12);
    } finally { await MedicineBatch.collection.dropIndex("synthetic_legacy_label"); }
  });
  it("captures exact units, expiry, rational cost and a distinct opening movement without purchase liability", async () => {
    const f = await fixture(), response = await post(f);
    expect(response.statusCode, response.body).toBe(201); expect(response.headers["cache-control"]).toBe("no-store");
    const data = response.json().data;
    expect(data).toMatchObject({ receivedQuantity: 12, kind: "opening", replayed: false, batch: { lotVersion: 1, organizationId: f.organizationId, receivedQuantity: 12,
      unitSnapshot: { version: 1, unitsPerPack: 10, baseUnit: "tablet", packUnit: "strip" }, costBasis: { totalPaise: 100, receivedBaseUnits: 12, currency: "INR" },
      expirySnapshot: { precision: "month", value: "2099-12", timezone: "Asia/Kolkata", cutoff: "2099-12-31T18:30:00.000Z" } } });
    const movements = await StockMovement.find({ medicineId: f.medicine.id }).sort({ revision: 1 }).lean();
    expect(movements.map(row => [row.kind, row.beforeQuantity, row.afterQuantity, row.quantityDelta])).toEqual([["opening_baseline", 0, 0, 0], ["opening_receipt", 0, 12, 12]]);
    expect(await AuditLog.countDocuments({ targetId: data.batchId, action: "PHARMACY_STOCK_RECEIPT" })).toBe(1);
  });
  it("stores repeated printed batches as distinct cost/MRP lots when the legacy index is absent", async () => {
    const f = await fixture(), first = (await post(f)).json().data;
    const second = await post(f, { kind: "receipt", receiptLineId: key(), purchaseTotalPaise: 240, mrpPaise: 1500, sellingPricePaise: 1100 });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().data.batchId).not.toBe(first.batchId);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(24);
    const lots = await MedicineBatch.find({ medicineId: f.medicine.id }).sort({ receivedAt: 1, _id: 1 });
    expect(lots.map(lot => lot.batchNumber)).toEqual(["PRINTED-001", "PRINTED-001"]);
    expect(lots.map(lot => lot.costBasis!.totalPaise)).toEqual([100, 240]);
    expect(lots.map(lot => lot.mrpPaise)).toEqual([1200, 1500]);
  });
  it("replays the captured received result after dispensing without incrementing stock again", async () => {
    const f = await fixture(), requestKey = key();
    const first = await receivePharmacyStock(f.authority, requestKey, f.input);
    await dispenseMedicineFEFO(f.medicine.id, f.locationId, 2);
    const second = await receivePharmacyStock(f.authority, requestKey, f.input);
    expect(second).toEqual({ ...first, replayed: true });
    expect(second.batch.quantity).toBe(12); expect((await MedicineBatch.findById(first.batchId))!.quantity).toBe(10);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
    expect((await recover(f, requestKey)).json().data.batch.quantity).toBe(12);
  });
  it("rejects changed-key payloads and a repeated source line under a different key", async () => {
    const f = await fixture(), requestKey = key(); expect((await post(f, {}, requestKey)).statusCode).toBe(201);
    expect((await post(f, { packs: 2 }, requestKey)).statusCode).toBe(409);
    expect((await post(f, { kind: "receipt" })).statusCode).toBe(409);
    expect(await MedicineBatch.countDocuments({ medicineId: f.medicine.id })).toBe(1);
  });
  it("serializes concurrent replay and distinct concurrent receipt lines without losing quantities", async () => {
    const f = await fixture(), requestKey = key();
    const replay = await Promise.all([post(f, {}, requestKey), post(f, {}, requestKey)]);
    expect(replay.map(row => row.statusCode).sort()).toEqual([200, 201]);
    const receipts = await Promise.all([post(f, { kind: "receipt", receiptLineId: key(), packs: 0, looseUnits: 3 }), post(f, { kind: "receipt", receiptLineId: key(), packs: 0, looseUnits: 4 })]);
    expect(receipts.map(row => row.statusCode)).toEqual([201, 201]); expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(19);
    expect(await MedicineBatch.countDocuments({ medicineId: f.medicine.id })).toBe(3);
  });
  it("rejects concurrent duplicate source lines even under different operation keys", async () => {
    const f = await fixture();
    const outcomes = await Promise.all([post(f), post(f)]);
    expect(outcomes.map(row => row.statusCode).sort()).toEqual([201, 409]);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(12);
  });
  it("keeps legacy duplicate-label behavior and rejects mixing legacy inward into captured stock", async () => {
    const f = await fixture(); await post(f);
    await expect(addBatchToMedicine({ medicineId: f.medicine.id, locationId: f.locationId, batchNumber: "OTHER", expiryDate: "2099-12-31", quantity: 2, purchaseCost: 2, sellingPrice: 3 })).rejects.toThrow(/explicit stock receipts/);
    const legacy = await Medicine.create({ locationId: f.locationId, name: "Legacy", genericName: "Synthetic", stockQuantity: 0, price: 10 });
    const body = { medicineId: legacy.id, locationId: f.locationId, batchNumber: "LEGACY-LABEL", expiryDate: "2099-12-31", quantity: 2, purchaseCost: 2, sellingPrice: 3 };
    const outcomes = await Promise.allSettled([addBatchToMedicine(body), addBatchToMedicine(body)]);
    expect(outcomes.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect((await Medicine.findById(legacy.id))!.stockQuantity).toBe(2);
  });
  it("fails closed when the receipt identity index is absent and still recovers an existing operation", async () => {
    const f = await fixture(), requestKey = key(); expect((await post(f, {}, requestKey)).statusCode).toBe(201);
    await MedicineBatch.collection.dropIndex("pharmacy_receipt_line_v1");
    try {
      const other = await fixture(), rejected = await post(other);
      expect(rejected.statusCode, rejected.body).toBe(503);
      expect((await Medicine.findById(other.medicine.id))!.stockQuantity).toBe(0);
      expect((await post(f, {}, requestKey)).statusCode).toBe(200);
    } finally { await MedicineBatch.collection.createIndex({ organizationId: 1, locationId: 1, receiptLineId: 1 }, { name: "pharmacy_receipt_line_v1", unique: true, partialFilterExpression: { lotVersion: 1 } }); }
  });
  it.each([{ purchaseTotalPaise: "100" }, { sellingPricePaise: null }, { looseUnits: 10 }, { packs: Number.MAX_SAFE_INTEGER }, { packs: 0, looseUnits: 0 },
    { sellingPricePaise: 1201 }, { expectedUnitVersion: 2 }, { openingSourceReference: "" }, { expiry: { precision: "month", value: "2099-13" } }, { expiry: { precision: "day", value: "2000-01-01" } }])("rejects invalid or stale receipt %j without stock or movement writes", async fields => {
    const f = await fixture(), response = await post(f, fields);
    expect([400, 409]).toContain(response.statusCode);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(0); expect(await MedicineBatch.countDocuments({ medicineId: f.medicine.id })).toBe(0);
    expect(await StockMovement.countDocuments({ medicineId: f.medicine.id })).toBe(0);
  });
  it("does not turn legacy aggregate, depleted history or inconsistent lots into opening receipts", async () => {
    const f = await fixture();
    await Medicine.updateOne({ _id: f.medicine.id }, { $set: { stockQuantity: 5 } });
    expect((await post(f)).statusCode).toBe(409);
    expect((await post(f, { kind: "receipt" })).statusCode).toBe(409);
    await Medicine.updateOne({ _id: f.medicine.id }, { $set: { stockQuantity: 0 } });
    await MedicineBatch.create({ medicineId: f.medicine.id, locationId: f.locationId, batchNumber: "OLD", quantity: 0, status: "depleted", expiryDate: new Date("2099-12-31"), purchaseCost: 2, sellingPrice: 3 });
    expect((await post(f)).statusCode).toBe(409); expect((await post(f, { kind: "receipt" })).statusCode).toBe(409);
  });
  it("reports a corrupt stock revision as a review conflict without reserving stock or an operation", async () => {
    const f = await fixture(), requestKey = key();
    await Medicine.collection.updateOne({ _id: f.medicine._id }, { $set: { stockRevision: -1 } });
    const response = await post(f, {}, requestKey);
    expect(response.statusCode, response.body).toBe(409); expect(response.json().message).toMatch(/revision/);
    expect(await OperationReceipt.countDocuments({ key: requestKey })).toBe(0); expect(await MedicineBatch.countDocuments({ medicineId: f.medicine.id })).toBe(0);
  });
  it("enforces grants, tenant assertions and branch ownership; redacts rational acquisition cost", async () => {
    const f = await fixture(["PHARMACY_RECEIVE_STOCK"]), requestKey = key();
    const result = await post(f, {}, requestKey); expect(result.statusCode, result.body).toBe(201);
    expect(result.json().data.batch).not.toHaveProperty("purchaseCost"); expect(result.json().data.batch).not.toHaveProperty("costBasis");
    expect((await recover(f, requestKey)).json().data.batch).not.toHaveProperty("costBasis");
    const foreign = await fixture();
    expect((await post(f, { organizationId: foreign.organizationId })).statusCode).toBe(403);
    expect((await post(f, { medicineId: foreign.medicine.id })).statusCode).toBe(404);
    const viewer = await fixture(["PHARMACY_VIEW_STOCK"]);
    expect((await post(viewer)).statusCode).toBe(403); expect((await recover(viewer, requestKey)).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/pharmacy/stock-receipts", headers: f.headers, payload: f.input })).statusCode).toBe(428);
  });
  it("recovers committed results after disable and soft delete, while new stock remains blocked", async () => {
    const f = await fixture(), requestKey = key(); await post(f, {}, requestKey);
    await Location.updateOne({ _id: f.locationId }, { $set: { pharmacyCapability: { enabled: false, revision: 1 } } });
    await Medicine.updateOne({ _id: f.medicine.id }, { $set: { deletedAt: new Date() } });
    expect((await recover(f, requestKey)).statusCode).toBe(200);
    expect((await post(f, { kind: "receipt", receiptLineId: key() })).statusCode).toBe(409);
    await expect(recoverPharmacyStockReceipt({ ...f.authority, actorId: new mongoose.Types.ObjectId().toString() }, requestKey)).rejects.toThrow(/this operator/);
  });
  it("denies consumers and immediately revoked receiving grants, independently of broad permissions", async () => {
    const f = await fixture();
    const patient = await User.create({ name: "Synthetic consumer", email: `${key()}@example.test`, role: "patient" });
    const session = await createAuthSession({ id: patient.id, email: patient.email!, role: "patient", organization_id: f.organizationId });
    const denied = await app.inject({ method: "POST", url: "/api/pharmacy/stock-receipts", headers: { authorization: `Bearer ${session.accessToken}`, "idempotency-key": key() }, payload: f.input });
    expect(denied.statusCode).toBe(403);
    await Role.updateOne({ organizationId: f.organizationId, name: f.user.role }, { $set: { permissions: [] } });
    expect((await post(f)).statusCode).toBe(403); expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(0);
  });
  it("rolls back a receipt if capability disable commits before its final location pin", async () => {
    const f = await fixture(), requestKey = key(), update = Location.findOneAndUpdate.bind(Location); let disabled = false;
    const spy = vi.spyOn(Location, "findOneAndUpdate").mockImplementation(((...args: any[]) => {
      const query = Reflect.apply(update, Location, args), execute = query.exec.bind(query);
      query.exec = async () => {
        if (!disabled && String(args[0]._id) === f.locationId) {
          disabled = true;
          await Location.collection.updateOne({ _id: new mongoose.Types.ObjectId(f.locationId) }, { $set: { pharmacyCapability: { enabled: false, revision: 1 } } });
        }
        return execute();
      }; return query;
    }) as typeof Location.findOneAndUpdate);
    try { expect((await post(f, {}, requestKey)).statusCode).toBe(409); } finally { spy.mockRestore(); }
    expect(disabled).toBe(true); expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(0);
    expect(await MedicineBatch.countDocuments({ medicineId: f.medicine.id })).toBe(0); expect(await StockMovement.countDocuments({ medicineId: f.medicine.id })).toBe(0);
    expect(await OperationReceipt.countDocuments({ key: requestKey })).toBe(0);
  });
  it("rejects unknown units, foreign lot ownership and a non-INR acquisition basis", async () => {
    const f = await fixture();
    await Medicine.updateOne({ _id: f.medicine.id }, { $unset: { unitDefinition: 1 } });
    expect((await post(f)).statusCode).toBe(409);
    await Medicine.updateOne({ _id: f.medicine.id }, { $set: { unitDefinition: { version: 1, baseUnit: "tablet", packUnit: "strip", unitsPerPack: 10 } } });
    await Organization.updateOne({ _id: f.organizationId }, { $set: { currency: "USD" } });
    expect((await post(f)).statusCode).toBe(409);
    await Organization.updateOne({ _id: f.organizationId }, { $set: { currency: "INR" } });
    const first = (await post(f)).json().data;
    await MedicineBatch.collection.updateOne({ _id: new mongoose.Types.ObjectId(first.batchId) }, { $set: { organizationId: new mongoose.Types.ObjectId() } });
    expect((await post(f, { kind: "receipt", receiptLineId: key() })).statusCode).toBe(409);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(12);
  });
  it("rolls back the lot, aggregate, ledger, audit and operation reservation on a required-audit failure", async () => {
    const f = await fixture(), requestKey = key(), create = AuditLog.create.bind(AuditLog);
    const spy = vi.spyOn(AuditLog, "create").mockImplementation(((...args: any[]) => {
      const rows = Array.isArray(args[0]) ? args[0] : [args[0]];
      if (rows.some(row => row.action === "PHARMACY_STOCK_RECEIPT")) return Promise.reject(new Error("Synthetic audit unavailable"));
      return Reflect.apply(create, AuditLog, args);
    }) as typeof AuditLog.create);
    try { expect((await post(f, {}, requestKey)).statusCode).toBe(500); } finally { spy.mockRestore(); }
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(0); expect(await MedicineBatch.countDocuments({ medicineId: f.medicine.id })).toBe(0);
    expect(await StockMovement.countDocuments({ medicineId: f.medicine.id })).toBe(0); expect(await OperationReceipt.countDocuments({ key: requestKey })).toBe(0);
    expect((await post(f, {}, requestKey)).statusCode).toBe(201);
  });
  it("uses FEFO then receipt time/ID, preserves distinct costs and rejects corrupted snapshots", async () => {
    const f = await fixture();
    const first = (await post(f, { expiry: { precision: "month", value: "2099-10" }, purchaseTotalPaise: 101 })).json().data;
    const second = (await post(f, { kind: "receipt", receiptLineId: key(), expiry: { precision: "day", value: "2099-09-30" }, purchaseTotalPaise: 503 })).json().data;
    const supply = await dispenseMedicineFEFO(f.medicine.id, f.locationId, 13);
    expect(supply.dispensedBatches.map(row => [row.batchId, row.quantity])).toEqual([[second.batchId, 12], [first.batchId, 1]]);
    const remaining = (await MedicineBatch.findById(first.batchId))!;
    expect(remainingLotCost(remaining)).toEqual({ numeratorPaise: "1111", denominatorBaseUnits: 12, currency: "INR" });
    await MedicineBatch.collection.updateOne({ _id: remaining._id }, { $set: { sellingPrice: 999 } });
    await expect(dispenseMedicineFEFO(f.medicine.id, f.locationId, 1)).rejects.toThrow(/snapshot/);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(11);
  });
});

describe("Printed expiry and strict base-unit contracts", () => {
  it("handles leap months, inclusive days and local DST cutoffs without fake precision", () => {
    expect(lotExpiry({ precision: "month", value: "2028-02" }, "Asia/Kolkata").cutoff.toISOString()).toBe("2028-02-29T18:30:00.000Z");
    expect(lotExpiry({ precision: "day", value: "2026-03-08" }, "America/New_York").cutoff.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(lotExpiry({ precision: "day", value: "2026-11-01" }, "America/New_York").cutoff.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(() => lotExpiry({ precision: "day", value: "2027-02-29" }, "Asia/Kolkata")).toThrow(/Invalid/);
    expect(() => lotExpiry({ precision: "month", value: "2028-02" }, "bad-zone")).toThrow(/timezone/);
  });
  it("does not coerce quantities, prices, hidden fields or unit versions", async () => {
    const f = await fixture();
    expect(() => normalizeStockReceipt({ ...f.input, patientId: "unneeded" })).toThrow();
    expect(() => normalizeStockReceipt({ ...f.input, expectedUnitVersion: "1" })).toThrow();
    expect(() => normalizeStockReceipt({ ...f.input, purchaseTotalPaise: 0.5 })).toThrow();
  });
});
