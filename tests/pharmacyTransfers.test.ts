import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Role } from "../models/Role.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { PharmacyTaxProfile } from "../models/PharmacyTaxProfile.ts";
import { PharmacyTransfer, PharmacyTransferEvent } from "../models/PharmacyTransfer.ts";
import { PharmacyProfessionalReview } from "../models/PharmacyProfessionalReview.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { createAuthSession } from "../utilities/helpers.ts";
import { receivePharmacyStock } from "../services/PharmacyStockReceiptService.ts";
import { remainingLotCost } from "../utilities/pharmacyLot.ts";
import { pharmacyTaxFixture } from "./helpers/pharmacyTaxFixture.ts";

const key = () => crypto.randomUUID();
beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
async function fixture(scheduleType: "general" | "schedule_h1" | "schedule_x" = "general", stockQuantity = 10) {
  const organizationId = (await Organization.create({ name: "Synthetic transfer owner", city: "Pune", countryCode: "IN", currency: "INR" })).id;
  const source = await Location.create({ organizationId, name: "Synthetic source", city: "Pune", timezone: "Asia/Kolkata" });
  const destination = await Location.create({ organizationId, name: "Synthetic destination", city: "Pune", timezone: "Asia/Kolkata" });
  const role = await Role.create({ organizationId, name: `transfer_${key()}`, permissions: ["PHARMACY_TRANSFER", "PHARMACY_VIEW_COST", "PHARMACY_VIEW_STOCK"] });
  const user = await User.create({ name: "Synthetic stock operator", role: role.name, email: `${key()}@example.test` });
  await OrgMember.create({ organizationId, userId: user.id, role: role.name, locationAccess: { mode: "all" } });
  const auth = async () => ({ authorization: `Bearer ${(await createAuthSession({ id: user.id, role: role.name, organization_id: organizationId, email: user.email! })).accessToken}` });
  const fields = { name: "Synthetic transfer medicine", genericName: "Synthetic formulation", manufacturer: "Synthetic maker", strength: "500 mg", stockQuantity: 0, price: 120,
    scheduleType, unitDefinition: { version: 1, baseUnit: "tablet", packUnit: "strip", unitsPerPack: 10 } } as const;
  const sourceMedicine = await Medicine.create({ ...fields, locationId: source.id }), destinationMedicine = await Medicine.create({ ...fields, locationId: destination.id });
  await pharmacyTaxFixture(source.id, [sourceMedicine.id], user.id); await pharmacyTaxFixture(destination.id, [destinationMedicine.id], user.id);
  const received = await receivePharmacyStock({ organizationId, locationId: source.id, actorId: user.id }, key(), { medicineId: sourceMedicine.id, locationId: source.id, receiptLineId: key(), kind: "opening", expectedUnitVersion: 1,
    packs: Math.floor(stockQuantity / 10), looseUnits: stockQuantity % 10, batchNumber: "SYNTHETIC-TRANSPORT-BATCH", expiry: { precision: "day", value: "2099-12-31" }, purchaseTotalPaise: 10001, sellingPricePaise: 12000, mrpPaise: 13000, openingSourceReference: "Synthetic physical count" });
  const body = { locationId: source.id, destinationLocationId: destination.id, sourceMedicineId: sourceMedicine.id, destinationMedicineId: destinationMedicine.id, sourceBatchId: received.batchId, quantity: 3,
    reviewReference: "Synthetic reviewed internal transfer", transportReference: "SYNTHETIC-DELIVERY-001" };
  return { organizationId, source, destination, sourceMedicine, destinationMedicine, sourceBatchId: received.batchId, role, user, auth, headers: await auth(), body };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const post = (f: Fixture, action = "create", id?: string, fields: Record<string, unknown> = {}, requestKey = key()) => app.inject({ method: "POST", url: `/api/pharmacy/transfers${id ? `/${id}/${action}` : ""}`, headers: { ...f.headers, "idempotency-key": requestKey }, payload: action === "create" ? { ...f.body, ...fields } : { locationId: f.source.id, reviewReference: "Synthetic physical stage review", ...fields } });
async function dispatched(f: Fixture) {
  const created = await post(f); expect(created.statusCode, created.body).toBe(201); const id = created.json().data.id;
  const approved = await post(f, "approve", id, { expectedRevision: 0 }); expect(approved.statusCode, approved.body).toBe(200);
  const shipped = await post(f, "dispatch", id, { expectedRevision: 1 }); expect(shipped.statusCode, shipped.body).toBe(200); return { id, shipped: shipped.json().data };
}
describe("Controlled branch stock transfers", () => {
  it("keeps consumer grants and a foreign tenant from probing or mutating transfers", async () => {
    const f = await fixture(), created = await post(f), transferId = created.json().data.id;
    const foreign = await fixture();
    const read = await app.inject({ method: "GET", url: `/api/pharmacy/transfers/${transferId}?locationId=${foreign.source.id}`, headers: foreign.headers }); expect(read.statusCode).toBe(404); expect(read.body).not.toContain("SYNTHETIC-DELIVERY");
    expect((await post(foreign, "approve", transferId, { expectedRevision: 0 })).statusCode).toBe(404);
    const patient = await User.create({ name: "Synthetic consumer", role: "patient", email: `${key()}@example.test` });
    await Role.create({ organizationId: f.organizationId, name: "patient", permissions: ["PHARMACY_TRANSFER", "PHARMACY_VIEW_COST"] });
    await OrgMember.create({ organizationId: f.organizationId, userId: patient.id, role: "patient", locationAccess: { mode: "all" } });
    const auth = { authorization: `Bearer ${(await createAuthSession({ id: patient.id, role: "patient", organization_id: f.organizationId, email: patient.email! })).accessToken}` };
    const spy = vi.spyOn(PharmacyTransfer, "find");
    try { expect((await app.inject({ method: "GET", url: `/api/pharmacy/transfers?locationId=${f.source.id}`, headers: auth })).statusCode).toBe(403); expect(spy).not.toHaveBeenCalled(); } finally { spy.mockRestore(); }
    expect((await app.inject({ method: "POST", url: "/api/pharmacy/transfers", headers: { ...auth, "idempotency-key": key() }, payload: f.body })).statusCode).toBe(403);
    expect(await PharmacyTransfer.findById(transferId)).toMatchObject({ status: "draft", revision: 0 });
  });
  it("receives already dispatched goods at the active destination even when the empty source catalogue item is archived", async () => {
    const f = await fixture(); f.body.quantity = 10; const { id } = await dispatched(f);
    await Medicine.updateOne({ _id: f.sourceMedicine.id }, { $set: { deletedAt: new Date() } });
    const result = await post(f, "receive", id, { locationId: f.destination.id, expectedRevision: 2, quantity: 10, disposition: "saleable" });
    expect(result.statusCode, result.body).toBe(200); expect(result.json().data).toMatchObject({ status: "closed", receivedQuantity: 10 });
  });
  it("paginates an actual multi-stage custody history without hiding older physical receipts", async () => {
    const f = await fixture("general", 30); f.body.quantity = 21; const { id } = await dispatched(f);
    for (let index = 0; index < 21; index++) expect((await post(f, "receive", id, { locationId: f.destination.id, expectedRevision: index + 2, quantity: 1, disposition: "saleable" })).statusCode).toBe(200);
    const read = (cursor = "") => app.inject({ method: "GET", url: `/api/pharmacy/transfers/${id}?locationId=${f.destination.id}${cursor ? `&eventCursor=${cursor}` : ""}`, headers: f.headers });
    const first = (await read()).json().data, second = (await read(first.nextEventsCursor)).json().data;
    expect(first.events).toHaveLength(20); expect(second.events).toHaveLength(4); expect(new Set([...first.events, ...second.events].map((row: any) => row.id)).size).toBe(24);
    expect(first).toMatchObject({ status: "closed", receivedQuantity: 21, inTransitQuantity: 0 }); expect(second.nextEventsCursor).toBeNull();
  });
  it("offers bounded owned product/lot lookups and recovers an original stage snapshot", async () => {
    const f = await fixture(), reference = key();
    const products = await app.inject({ method: "GET", url: `/api/pharmacy/transfer-products?locationId=${f.source.id}&search=Synthetic`, headers: f.headers });
    expect(products.statusCode, products.body).toBe(200); expect(products.json().data.items.map((row: any) => row.id)).toEqual([f.sourceMedicine.id]);
    const lots = await app.inject({ method: "GET", url: `/api/pharmacy/transfer-source-lots?locationId=${f.source.id}&medicineId=${f.sourceMedicine.id}`, headers: f.headers });
    expect(lots.statusCode, lots.body).toBe(200); expect(lots.json().data.items[0]).toMatchObject({ id: f.sourceBatchId, quantity: 10, costBasis: { totalPaise: 10001, receivedBaseUnits: 10 } });
    const created = await post(f, "create", undefined, {}, reference), id = created.json().data.id;
    const recovered = await app.inject({ method: "GET", url: `/api/pharmacy/transfer-operations/${reference}?locationId=${f.source.id}&action=create`, headers: f.headers });
    expect(recovered.statusCode, recovered.body).toBe(200); expect(recovered.json().data).toMatchObject({ id, status: "draft", revision: 0, requestKey: reference });
    await expect(PharmacyTransfer.updateOne({ _id: id }, { $set: { "sourceSnapshot.lot.costBasis.totalPaise": 1 } })).rejects.toThrow(/immutable/);
    await expect(PharmacyTransferEvent.deleteMany({ transferId: id })).rejects.toThrow(/append-only/);
  });
  it("quotes actual received transfer stock and its preserved unit/price evidence through the existing counter", async () => {
    const f = await fixture(), { id } = await dispatched(f);
    expect((await post(f, "receive", id, { locationId: f.destination.id, expectedRevision: 2, quantity: 3, disposition: "saleable" })).statusCode).toBe(200);
    await Role.updateOne({ _id: f.role._id }, { $push: { permissions: "PHARMACY_SELL" } });
    await Medicine.updateOne({ _id: f.destinationMedicine.id }, { $set: { dispensingRevision: 1, dispensingReview: { scheduleType: "general", confirmedAt: new Date(), confirmedBy: f.user.id, reviewReference: "Synthetic reviewed destination product" } } });
    const quote = await app.inject({ method: "POST", url: "/api/pharmacy/sales/quote", headers: f.headers, payload: { locationId: f.destination.id, lines: [{ lineId: key(), medicineId: f.destinationMedicine.id, quantity: 1, expectedUnitVersion: 1, discountPaise: 0 }] } });
    expect(quote.statusCode, quote.body).toBe(200); expect(quote.json().data.calculation.totals.payablePaise).toBe(12000);
  });
  it("keeps expired in-transit stock out of saleable inventory and permits a recorded quarantine receipt", async () => {
    const f = await fixture(), { id } = await dispatched(f), lot = await MedicineBatch.findById(f.sourceBatchId);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(lot!.expiryDate.getTime() + 1000));
    try {
      f.headers = await f.auth();
      const fields = { locationId: f.destination.id, expectedRevision: 2, quantity: 3, disposition: "saleable" };
      const unavailable = await post(f, "receive", id, fields); expect(unavailable.statusCode, unavailable.body).toBe(409);
      const accepted = await post(f, "receive", id, { ...fields, disposition: "quarantined" }); expect(accepted.statusCode, accepted.body).toBe(200);
      expect((await MedicineBatch.findById(accepted.json().data.receivedBatchId))!.status).toBe("quarantined");
    } finally { vi.useRealTimers(); }
  });
  it("rejects a fresh-revision over-receipt and destination medicine changes without a partial stock write", async () => {
    const f = await fixture(), { id } = await dispatched(f);
    const fields = { locationId: f.destination.id, expectedRevision: 2, quantity: 4, disposition: "saleable" };
    expect((await post(f, "receive", id, fields)).statusCode).toBe(409);
    await Medicine.updateOne({ _id: f.destinationMedicine.id }, { $set: { strength: "Different strength" } });
    expect((await post(f, "receive", id, { ...fields, quantity: 1 })).statusCode).toBe(409);
    expect((await Medicine.findById(f.destinationMedicine.id))!.stockQuantity).toBe(0); expect(await PharmacyTransfer.findById(id)).toMatchObject({ revision: 2, receivedQuantity: 0 });
  });
  it("conserves one approved lot through partial saleable/quarantine receipts and returned transit stock with exact cost and replay", async () => {
    const f = await fixture(), { id } = await dispatched(f);
    expect((await Medicine.findById(f.sourceMedicine.id))!.stockQuantity).toBe(7); expect((await Medicine.findById(f.destinationMedicine.id))!.stockQuantity).toBe(0);
    const reference = key(), input = { locationId: f.destination.id, expectedRevision: 2, quantity: 1, disposition: "saleable" };
    const first = await post(f, "receive", id, input, reference); expect(first.statusCode, first.body).toBe(200); expect(first.json().data).toMatchObject({ receivedQuantity: 1, inTransitQuantity: 2, revision: 3 });
    const lot = await MedicineBatch.findById(first.json().data.receivedBatchId);
    expect(lot).toMatchObject({ receiptKind: "transfer", receivedQuantity: 1, quantity: 1, status: "active", costBasis: { totalPaise: 10001, receivedBaseUnits: 10 } });
    expect(remainingLotCost(lot)).toEqual({ numeratorPaise: "10001", denominatorBaseUnits: 10, currency: "INR" });
    expect((await post(f, "receive", id, { locationId: f.destination.id, expectedRevision: 3, quantity: 1, disposition: "quarantined" })).statusCode).toBe(200);
    const returned = await post(f, "resolve", id, { expectedRevision: 4, quantity: 1, disposition: "return_to_source" });
    expect(returned.statusCode, returned.body).toBe(200); expect(returned.json().data).toMatchObject({ status: "closed", dispatchedQuantity: 3, receivedQuantity: 1, quarantinedQuantity: 1, returnedQuantity: 1, inTransitQuantity: 0 });
    expect((await Medicine.findById(f.sourceMedicine.id))!.stockQuantity).toBe(8); expect((await Medicine.findById(f.destinationMedicine.id))!.stockQuantity).toBe(2);
    const replay = await post(f, "receive", id, input, reference); expect(replay.statusCode).toBe(200); expect(replay.json().data).toMatchObject({ revision: 3, inTransitQuantity: 2, replayed: true });
    expect(await PharmacyTransferEvent.countDocuments({ transferId: id })).toBe(6); expect(await StockMovement.countDocuments({ "transferSource.transferId": id })).toBe(4);
  });
  it("serializes concurrent dispatch and receive stages without excess stock", async () => {
    const f = await fixture(), created = await post(f), id = created.json().data.id;
    expect((await post(f, "approve", id, { expectedRevision: 0 })).statusCode).toBe(200);
    const ships = await Promise.all([post(f, "dispatch", id, { expectedRevision: 1 }), post(f, "dispatch", id, { expectedRevision: 1 })]); expect(ships.map(row => row.statusCode).sort()).toEqual([200, 409]);
    const fields = { locationId: f.destination.id, expectedRevision: 2, quantity: 2, disposition: "saleable" };
    const receives = await Promise.all([post(f, "receive", id, fields), post(f, "receive", id, fields)]); expect(receives.map(row => row.statusCode).sort()).toEqual([200, 409]);
    expect((await Medicine.findById(f.sourceMedicine.id))!.stockQuantity).toBe(7); expect((await Medicine.findById(f.destinationMedicine.id))!.stockQuantity).toBe(2);
    expect(await PharmacyTransfer.findById(id)).toMatchObject({ dispatchedQuantity: 3, receivedQuantity: 2, revision: 3 });
  });
  it("records an approved in-transit loss without manufacturing a destination receipt", async () => {
    const f = await fixture(), { id } = await dispatched(f); const resolved = await post(f, "resolve", id, { expectedRevision: 2, quantity: 3, disposition: "lost" });
    expect(resolved.statusCode, resolved.body).toBe(200); expect(resolved.json().data).toMatchObject({ status: "closed", lostQuantity: 3, inTransitQuantity: 0 });
    expect((await Medicine.findById(f.destinationMedicine.id))!.stockQuantity).toBe(0); expect(await MedicineBatch.countDocuments({ medicineId: f.destinationMedicine.id })).toBe(0);
  });
  it("cancels an unshipped approval but refuses to cancel dispatched goods", async () => {
    const f = await fixture(), created = await post(f), id = created.json().data.id;
    expect((await post(f, "approve", id, { expectedRevision: 0 })).statusCode).toBe(200); expect((await post(f, "cancel", id, { expectedRevision: 1 })).statusCode).toBe(200);
    expect((await post(f, "dispatch", id, { expectedRevision: 2 })).statusCode).toBe(409); expect((await Medicine.findById(f.sourceMedicine.id))!.stockQuantity).toBe(10);
    const second = await dispatched(f); expect((await post(f, "cancel", second.id, { expectedRevision: 2 })).statusCode).toBe(409);
  });
  it.each(["identity", "unit", "GST registration", "foreign medicine", "invalid quantity", "restricted category", "country/currency"])("blocks an unsupported %s before creating a transfer or changing stock", async reason => {
    const f = await fixture(reason === "restricted category" ? "schedule_x" : "general"), fields: Record<string, unknown> = {};
    if (reason === "identity") await Medicine.updateOne({ _id: f.destinationMedicine.id }, { $set: { strength: "250 mg" } });
    if (reason === "unit") await Medicine.updateOne({ _id: f.destinationMedicine.id }, { $set: { "unitDefinition.unitsPerPack": 6 } });
    if (reason === "GST registration") await PharmacyTaxProfile.updateOne({ locationId: f.destination.id }, { $set: { registration: "regular", gstin: "27ABCDE1234F1Z5" } });
    if (reason === "foreign medicine") fields.destinationMedicineId = new mongoose.Types.ObjectId().toString();
    if (reason === "invalid quantity") fields.quantity = 0;
    if (reason === "country/currency") await Organization.updateOne({ _id: f.organizationId }, { $set: { currency: "USD" } });
    const response = await post(f, "create", undefined, fields); expect([400, 409], response.body).toContain(response.statusCode);
    expect(await PharmacyTransfer.countDocuments({ organizationId: f.organizationId })).toBe(0); expect((await Medicine.findById(f.sourceMedicine.id))!.stockQuantity).toBe(10);
  });
  it("requires separate current branch authority and cost permission without trusting a transfer identifier", async () => {
    const f = await fixture(), { id } = await dispatched(f);
    await OrgMember.updateOne({ organizationId: f.organizationId, userId: f.user.id }, { $set: { locationAccess: { mode: "selected", locationIds: [f.source.id] } } });
    expect([403, 404]).toContain((await post(f, "receive", id, { locationId: f.destination.id, expectedRevision: 2, quantity: 1, disposition: "saleable" })).statusCode);
    expect([403, 404]).toContain((await post(f, "resolve", id, { expectedRevision: 2, quantity: 1, disposition: "lost" })).statusCode);
    await Role.updateOne({ _id: f.role._id }, { $set: { permissions: ["PHARMACY_TRANSFER"] } });
    const response = await app.inject({ method: "GET", url: `/api/pharmacy/transfers/${id}?locationId=${f.source.id}`, headers: f.headers }); expect(response.statusCode).toBe(403);
    expect((await Medicine.findById(f.destinationMedicine.id))!.stockQuantity).toBe(0);
  });
  it("rolls back receipt stock, lots, event and revision if the required audit cannot be written", async () => {
    const f = await fixture(), { id } = await dispatched(f), reference = key(), original = AuditLog.create.bind(AuditLog);
    const mock = vi.spyOn(AuditLog, "create").mockImplementation(((...args: any[]) => (Array.isArray(args[0]) ? args[0][0] : args[0])?.action === "PHARMACY_TRANSFER_RECEIVE" ? Promise.reject(new Error("Synthetic audit outage")) : original(...args)) as any);
    const fields = { locationId: f.destination.id, expectedRevision: 2, quantity: 3, disposition: "saleable" };
    try { expect((await post(f, "receive", id, fields, reference)).statusCode).toBe(500); } finally { mock.mockRestore(); }
    expect(await PharmacyTransfer.findById(id)).toMatchObject({ revision: 2, receivedQuantity: 0 }); expect(await MedicineBatch.countDocuments({ medicineId: f.destinationMedicine.id })).toBe(0);
    expect((await post(f, "receive", id, fields, reference)).statusCode).toBe(200);
  });
  it("requires current reviewed pharmacist evidence for restricted approval/dispatch and permits a quarantine receipt without pretending it is a supply", async () => {
    const f = await fixture("schedule_h1"), created = await post(f), id = created.json().data.id;
    expect(created.statusCode, created.body).toBe(201); expect((await post(f, "approve", id, { expectedRevision: 0 })).statusCode).toBe(409);
    for (const [location, medicine] of [[f.source, f.sourceMedicine], [f.destination, f.destinationMedicine]]) {
      await Medicine.updateOne({ _id: medicine.id }, { $set: { dispensingRevision: 1, dispensingReview: { scheduleType: "schedule_h1", reviewReference: "Synthetic transfer classification", confirmedBy: f.user.id, confirmedAt: new Date() } } });
      await PharmacyProfessionalReview.create({ organizationId: f.organizationId, locationId: location.id, userId: f.user.id, profession: "pharmacist", active: true, validUntil: new Date("2099-12-31"), revision: 1,
        registrationNumber: "SYNTHETIC-PHARM-001", council: "Synthetic reviewed council", address: "Synthetic actual address", reviewReference: "Synthetic reviewed professional", confirmedBy: f.user.id, confirmedAt: new Date() });
    }
    expect((await post(f, "approve", id, { expectedRevision: 0 })).statusCode).toBe(200);
    await PharmacyProfessionalReview.updateOne({ userId: f.user.id, locationId: f.source.id }, { $set: { active: false } }); expect((await post(f, "dispatch", id, { expectedRevision: 1 })).statusCode).toBe(409);
    await PharmacyProfessionalReview.updateOne({ userId: f.user.id, locationId: f.source.id }, { $set: { active: true } }); expect((await post(f, "dispatch", id, { expectedRevision: 1 })).statusCode).toBe(200);
    await PharmacyProfessionalReview.updateOne({ userId: f.user.id, locationId: f.destination.id }, { $set: { active: false } });
    expect((await post(f, "receive", id, { locationId: f.destination.id, expectedRevision: 2, quantity: 3, disposition: "saleable" })).statusCode).toBe(409);
    const quarantined = await post(f, "receive", id, { locationId: f.destination.id, expectedRevision: 2, quantity: 3, disposition: "quarantined" }); expect(quarantined.statusCode, quarantined.body).toBe(200);
    expect((await MedicineBatch.findById(quarantined.json().data.receivedBatchId))!.status).toBe("quarantined");
  });
});
