import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { createAuthSession } from "../utilities/helpers.ts";
import { addBatchToMedicine, dispenseMedicineFEFO } from "../services/PharmacyInventoryService.ts";

describe("Atomic pharmacy stock movements", () => {
  let organizationId: string;
  let locationId: string;
  let actorId: string;
  let headers: { authorization: string };

  beforeAll(async () => {
    organizationId = (await Organization.create({ name: "Stock movements", city: "Pune" })).id;
    locationId = (await Location.create({ organizationId, name: "Count branch", city: "Pune" })).id;
    const user = await User.create({ name: "Counting pharmacist", email: `${crypto.randomUUID()}@example.test`, role: "pharmacist" });
    actorId = user.id;
    await OrgMember.create({ organizationId, userId: actorId, role: "pharmacist", locationAccess: { mode: "selected", locationIds: [locationId] } });
    const session = await createAuthSession({ id: user.id, role: user.role, email: user.email!, organization_id: organizationId });
    headers = { authorization: `Bearer ${session.accessToken}` };
    await Promise.all([StockMovement.init(), OperationReceipt.init()]);
  });

  async function stock(structured = true) {
    const medicine = await Medicine.create({ locationId, name: "Counted medicine", genericName: "Test",
      stockQuantity: 10, price: 10, costPrice: 5, expiryDate: new Date("2099-12-31"), batchNumber: "LEGACY" });
    const batch = structured ? await MedicineBatch.create({ medicineId: medicine.id, locationId,
      batchNumber: "COUNTED", expiryDate: new Date("2099-12-31"), quantity: 10, purchaseCost: 5, sellingPrice: 10 }) : null;
    const input = { medicineId: medicine.id, ...(batch ? { batchId: batch.id } : {}), expectedQuantity: 10,
      expectedRevision: 0, newQuantity: 7, reason: "physical_audit", clientRequestId: crypto.randomUUID() };
    return { medicine, batch, input };
  }
  const adjust = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/pharmacy/adjust-stock", headers, payload });
  async function balance(medicineId: string, quantity: number, revision: number) {
    const medicine = (await Medicine.findById(medicineId))!;
    expect(medicine.stockQuantity).toBe(quantity);
    expect(medicine.stockRevision).toBe(revision);
    const batch = await MedicineBatch.findOne({ medicineId });
    if (batch) expect(batch.quantity).toBe(quantity);
  }

  it("atomically records a baseline, batch delta, aggregate projection, reason and audit", async () => {
    const { medicine, batch, input } = await stock();
    const response = await adjust(input);
    expect(response.statusCode, response.body).toBe(200);
    await balance(medicine.id, 7, 1);
    const movements = await StockMovement.find({ medicineId: medicine.id }).sort({ revision: 1 }).lean();
    expect(movements.map(item => item.kind)).toEqual(["opening_baseline", "adjustment"]);
    expect(movements[0]).toMatchObject({ beforeQuantity: 10, afterQuantity: 10, quantityDelta: 0, revision: 0 });
    expect(movements[1]).toMatchObject({ beforeQuantity: 10, afterQuantity: 7, quantityDelta: -3,
      revision: 1, reason: "physical_audit", disposition: "count_correction", stockMode: "batch" });
    expect(String(movements[1].actorId)).toBe(actorId);
    expect(movements[1].allocations).toHaveLength(1);
    expect(String(movements[1].allocations[0].batchId)).toBe(batch!.id);
    expect(movements[1].allocations[0]).toMatchObject({ beforeQuantity: 10, afterQuantity: 7, quantityDelta: -3 });
    expect((await Medicine.findById(medicine.id))!.stockLedgerStartedAt).toBeTruthy();
    expect(await AuditLog.countDocuments({ targetId: medicine._id, action: "MEDICINE_STOCK_ADJUSTMENT" })).toBe(1);
  });

  it("supports revision-zero historical aggregate records without backfilling or inventing batches", async () => {
    const { medicine, input } = await stock(false);
    await Medicine.collection.updateOne({ _id: medicine._id }, { $unset: { stockRevision: 1, stockLedgerStartedAt: 1 } });
    expect((await adjust(input)).statusCode).toBe(200);
    await balance(medicine.id, 7, 1);
    expect(await MedicineBatch.countDocuments({ medicineId: medicine.id })).toBe(0);
    expect((await StockMovement.findOne({ medicineId: medicine.id, kind: "adjustment" }))!.stockMode).toBe("legacy_aggregate");
  });

  it("replays the original immutable result after subsequent stock activity without another movement", async () => {
    const { medicine, input } = await stock();
    const first = await adjust(input);
    expect(first.statusCode, first.body).toBe(200);
    await dispenseMedicineFEFO(medicine.id, locationId, 2);
    const replay = await adjust(input);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().data.movement).toEqual(first.json().data.movement);
    expect(replay.json().data.replayed).toBe(true);
    await balance(medicine.id, 5, 2);
    expect(await StockMovement.countDocuments({ medicineId: medicine.id, kind: "adjustment" })).toBe(1);
    expect(await AuditLog.countDocuments({ targetId: medicine._id, action: "MEDICINE_STOCK_ADJUSTMENT" })).toBe(1);
    expect((await adjust({ ...input, newQuantity: 6 })).statusCode).toBe(409);
  });

  it("records one adjustment for concurrent retries of the same command", async () => {
    const { medicine, input } = await stock();
    const responses = await Promise.all([adjust(input), adjust(input)]);
    expect(responses.map(response => response.statusCode)).toEqual([200, 200]);
    expect(responses[0].json().data.movement).toEqual(responses[1].json().data.movement);
    expect(responses.filter(response => response.json().data.replayed)).toHaveLength(1);
    await balance(medicine.id, 7, 1);
    expect(await StockMovement.countDocuments({ medicineId: medicine.id })).toBe(2);
  });

  it("rejects a second count from the same revision even under a different request key", async () => {
    const { medicine, input } = await stock();
    const responses = await Promise.all([adjust(input), adjust({ ...input, newQuantity: 6, clientRequestId: crypto.randomUUID() })]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
    const quantity = responses[0].statusCode === 200 ? 7 : 6;
    await balance(medicine.id, quantity, 1);
    expect(await StockMovement.countDocuments({ medicineId: medicine.id, kind: "adjustment" })).toBe(1);
  });

  it("does not overwrite a real sale committed after the count reads its batch", async () => {
    const { medicine, input } = await stock();
    const find = MedicineBatch.findOne.bind(MedicineBatch);
    let sold = false;
    const mock = vi.spyOn(MedicineBatch, "findOne").mockImplementation(((...args: any[]) => {
      const query = (find as any)(...args);
      const execute = query.exec.bind(query);
      query.exec = async () => {
        const result = await execute();
        if (!sold && String(args[0]?._id) === input.batchId) {
          sold = true;
          await (mongoose as any).transactionAsyncLocalStorage.run(undefined,
            () => dispenseMedicineFEFO(medicine.id, locationId, 2));
        }
        return result;
      };
      return query;
    }) as typeof MedicineBatch.findOne);
    try {
      const response = await adjust(input);
      expect(sold).toBe(true);
      expect(response.statusCode, response.body).toBe(409);
      await balance(medicine.id, 8, 1);
      expect(await StockMovement.countDocuments({ medicineId: medicine.id, kind: "adjustment" })).toBe(0);
      expect(await StockMovement.countDocuments({ medicineId: medicine.id, kind: "dispense" })).toBe(1);
    } finally { mock.mockRestore(); }
  });

  it("rejects a stale count even if sale and receipt restore the same aggregate quantity", async () => {
    const { medicine, input } = await stock(false);
    await dispenseMedicineFEFO(medicine.id, locationId, 2);
    await addBatchToMedicine({ medicineId: medicine.id, locationId, batchNumber: "NEW", expiryDate: "2099-12-31",
      quantity: 2, purchaseCost: 5, sellingPrice: 10 });
    expect((await adjust(input)).statusCode).toBe(409);
    const current = (await Medicine.findById(medicine.id))!;
    expect(current.stockQuantity).toBe(10);
    expect(current.stockRevision).toBe(2);
  });

  it("rejects a legacy count when the first structured receipt commits after its absence check", async () => {
    const { medicine, input } = await stock(false);
    const exists = MedicineBatch.exists.bind(MedicineBatch);
    let received = false;
    const mock = vi.spyOn(MedicineBatch, "exists").mockImplementation(((...args: any[]) => {
      const query = (exists as any)(...args);
      const execute = query.exec.bind(query);
      query.exec = async () => {
        const result = await execute();
        if (!received && String(args[0]?.medicineId) === medicine.id) {
          received = true;
          await (mongoose as any).transactionAsyncLocalStorage.run(undefined, () => addBatchToMedicine({
            medicineId: medicine.id, locationId, batchNumber: "FIRST", expiryDate: "2099-12-31",
            quantity: 2, purchaseCost: 5, sellingPrice: 10,
          }));
        }
        return result;
      };
      return query;
    }) as typeof MedicineBatch.exists);
    try {
      const response = await adjust(input);
      expect(received).toBe(true);
      expect(response.statusCode, response.body).toBe(409);
      expect((await Medicine.findById(medicine.id))!.stockQuantity).toBe(12);
      expect((await MedicineBatch.findOne({ medicineId: medicine.id }))!.quantity).toBe(2);
      expect(await StockMovement.countDocuments({ medicineId: medicine.id, kind: "adjustment" })).toBe(0);
    } finally { mock.mockRestore(); }
  });

  it("does not commit an adjustment after concurrent medicine deletion", async () => {
    const { medicine, input } = await stock();
    const update = Medicine.findOneAndUpdate.bind(Medicine);
    let deleted = false;
    const mock = vi.spyOn(Medicine, "findOneAndUpdate").mockImplementation(((...args: any[]) => {
      const query = (update as any)(...args);
      const execute = query.exec.bind(query);
      query.exec = async () => {
        if (!deleted) {
          deleted = true;
          await Medicine.collection.updateOne({ _id: medicine._id }, { $set: { deletedAt: new Date() } });
        }
        return execute();
      };
      return query;
    }) as typeof Medicine.findOneAndUpdate);
    try {
      const response = await adjust(input);
      expect(deleted).toBe(true);
      expect(response.statusCode, response.body).toBe(404);
      await balance(medicine.id, 10, 0);
      expect(await StockMovement.countDocuments({ medicineId: medicine.id })).toBe(0);
      expect(await OperationReceipt.countDocuments({ key: input.clientRequestId })).toBe(0);
    } finally { mock.mockRestore(); }
  });

  it.each(["movement", "audit"])("rolls back batch, aggregate, baseline and receipt on injected %s failure", async failure => {
    const { medicine, input } = await stock();
    const model = failure === "movement" ? StockMovement : AuditLog;
    const original = model.create.bind(model);
    const mock = vi.spyOn(model, "create").mockImplementation(((...args: any[]) => {
      const doc = Array.isArray(args[0]) ? args[0][0] : args[0];
      if (failure === "movement" ? doc.kind === "adjustment" : doc.action === "MEDICINE_STOCK_ADJUSTMENT") {
        throw new Error("Injected required write failure");
      }
      return (original as any)(...args);
    }) as any);
    try {
      expect((await adjust(input)).statusCode).toBe(500);
      await balance(medicine.id, 10, 0);
      expect((await Medicine.findById(medicine.id))!.stockLedgerStartedAt).toBeNull();
      expect(await StockMovement.countDocuments({ medicineId: medicine.id })).toBe(0);
      expect(await OperationReceipt.countDocuments({ key: input.clientRequestId })).toBe(0);
    } finally { mock.mockRestore(); }
    expect((await adjust(input)).statusCode).toBe(200);
    await balance(medicine.id, 7, 1);
  });

  it.each(["receipt", "dispense"])("rolls back %s if its movement cannot be recorded", async kind => {
    const { medicine } = await stock();
    const original = StockMovement.create.bind(StockMovement);
    const mock = vi.spyOn(StockMovement, "create").mockImplementation(((...args: any[]) => {
      const doc = Array.isArray(args[0]) ? args[0][0] : args[0];
      if (doc.kind === kind) throw new Error("Injected movement failure");
      return (original as any)(...args);
    }) as typeof StockMovement.create);
    try {
      const operation = kind === "dispense" ? dispenseMedicineFEFO(medicine.id, locationId, 2)
        : addBatchToMedicine({ medicineId: medicine.id, locationId, batchNumber: "RECEIPT", expiryDate: "2099-12-31",
          quantity: 2, purchaseCost: 5, sellingPrice: 10 });
      await expect(operation).rejects.toThrow("Injected movement failure");
      await balance(medicine.id, 10, 0);
      expect(await MedicineBatch.countDocuments({ medicineId: medicine.id })).toBe(1);
      expect(await StockMovement.countDocuments({ medicineId: medicine.id })).toBe(0);
    } finally { mock.mockRestore(); }
  });

  it.each([
    { expectedQuantity: 9 }, { expectedRevision: 1 }, { newQuantity: -1 }, { newQuantity: 1.5 },
    { newQuantity: Number.MAX_SAFE_INTEGER + 1 }, { expectedRevision: -1 }, { reason: "invented" },
    { reason: "damaged", newQuantity: 11 }, { reason: "restock", newQuantity: 9 }, { reason: "other", notes: " " },
  ])("rejects invalid or stale counts without mutation: %j", async overrides => {
    const { medicine, input } = await stock();
    expect([400, 409]).toContain((await adjust({ ...input, ...overrides })).statusCode);
    await balance(medicine.id, 10, 0);
    expect(await StockMovement.countDocuments({ medicineId: medicine.id })).toBe(0);
  });

  it("requires batch identity and refuses unreconciled totals or another medicine's batch", async () => {
    const { medicine, input } = await stock();
    const other = await stock();
    const { batchId: _batchId, ...aggregateInput } = input;
    expect((await adjust(aggregateInput)).statusCode).toBe(409);
    expect((await adjust({ ...input, batchId: other.batch!.id })).statusCode).toBe(404);
    await Medicine.updateOne({ _id: medicine.id }, { $set: { stockQuantity: 20 } });
    expect((await adjust(input)).statusCode).toBe(409);
    expect((await Medicine.findById(medicine.id))!.stockQuantity).toBe(20);
    expect((await MedicineBatch.findById(input.batchId))!.quantity).toBe(10);
  });

  it("writes off damaged stock without claiming physical disposal or refund", async () => {
    const { medicine, input } = await stock();
    const response = await adjust({ ...input, reason: "damaged", newQuantity: 0, notes: "Separated damaged units for review" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.movement).toMatchObject({ reason: "damaged", disposition: "write_off", quantityDelta: -10 });
    expect((await MedicineBatch.findById(input.batchId))!.status).toBe("depleted");
    await balance(medicine.id, 0, 1);
  });

  it("allows removing expired stock but never restores it to saleable stock", async () => {
    const { medicine, input } = await stock();
    await MedicineBatch.updateOne({ _id: input.batchId }, { $set: { status: "expired", expiryDate: new Date("2000-01-01") } });
    expect((await adjust({ ...input, newQuantity: 11, reason: "restock" })).statusCode).toBe(409);
    expect((await adjust({ ...input, newQuantity: 5, reason: "expired" })).statusCode).toBe(200);
    expect((await MedicineBatch.findById(input.batchId))!.status).toBe("expired");
    await expect(dispenseMedicineFEFO(medicine.id, locationId, 1)).rejects.toThrow(/eligible batch/);
    await balance(medicine.id, 5, 1);
  });

  it("never substitutes catalogue expiry for a batch with unknown expiry", async () => {
    const { medicine, input } = await stock();
    await MedicineBatch.collection.updateOne({ _id: new mongoose.Types.ObjectId(input.batchId) }, { $unset: { expiryDate: 1 } });
    expect((await adjust({ ...input, newQuantity: 11, reason: "restock" })).statusCode).toBe(409);
    await balance(medicine.id, 10, 0);
    expect(await StockMovement.countDocuments({ medicineId: medicine.id })).toBe(0);
  });

  it("rejects reductions beyond the aggregate and corrupt quantities in other lots", async () => {
    const { medicine, input } = await stock();
    await Medicine.updateOne({ _id: medicine.id }, { $set: { stockQuantity: 5 } });
    expect((await adjust({ ...input, newQuantity: 0 })).statusCode).toBe(409);
    expect((await MedicineBatch.findById(input.batchId))!.quantity).toBe(10);
    await Medicine.updateOne({ _id: medicine.id }, { $set: { stockQuantity: 11 } });
    for (const batchNumber of ["CORRUPT-A", "CORRUPT-B"]) {
      await MedicineBatch.collection.insertOne({ medicineId: medicine._id, locationId: medicine.locationId,
        batchNumber, expiryDate: new Date("2099-12-31"), quantity: 0.5, purchaseCost: 5, sellingPrice: 10, status: "active" });
    }
    expect((await adjust(input)).statusCode).toBe(409);
    expect((await Medicine.findById(medicine.id))!.stockQuantity).toBe(11);
    expect(await StockMovement.countDocuments({ medicineId: medicine.id })).toBe(0);
  });

  it("keeps the prospective ledger continuous across receipt, FEFO and adjustment", async () => {
    const { medicine } = await stock(false);
    await Medicine.updateOne({ _id: medicine.id }, { $set: { stockQuantity: 0 } });
    await addBatchToMedicine({ medicineId: medicine.id, locationId, batchNumber: "INWARD", expiryDate: "2099-12-31",
      quantity: 10, purchaseCost: 5, sellingPrice: 10 });
    await dispenseMedicineFEFO(medicine.id, locationId, 2);
    const batch = (await MedicineBatch.findOne({ medicineId: medicine.id }))!;
    expect((await adjust({ medicineId: medicine.id, batchId: batch.id, expectedQuantity: 8, expectedRevision: 2,
      newQuantity: 7, reason: "physical_audit", clientRequestId: crypto.randomUUID() })).statusCode).toBe(200);
    const rows = await StockMovement.find({ medicineId: medicine.id }).sort({ revision: 1 });
    expect(rows.map(row => row.kind)).toEqual(["opening_baseline", "receipt", "dispense", "adjustment"]);
    expect(rows.map(row => row.revision)).toEqual([0, 1, 2, 3]);
    expect(rows.map(row => [row.beforeQuantity, row.afterQuantity, row.quantityDelta])).toEqual([[0, 0, 0], [0, 10, 10], [10, 8, -2], [8, 7, -1]]);
    await balance(medicine.id, 7, 3);
  });

  it("paginates authorized history and retains it after soft deletion", async () => {
    const { medicine, input } = await stock();
    expect((await adjust(input)).statusCode).toBe(200);
    await Medicine.updateOne({ _id: medicine.id }, { $set: { deletedAt: new Date() } });
    const url = `/api/pharmacy/medicines/${medicine.id}/stock-movements`;
    const first = await app.inject({ method: "GET", url: `${url}?limit=1`, headers });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.movements.map((row: any) => row.revision)).toEqual([1]);
    const next = await app.inject({ method: "GET", url: `${url}?limit=2&beforeRevision=${first.json().data.nextBeforeRevision}`, headers });
    expect(next.json().data.movements.map((row: any) => row.revision)).toEqual([0]);
    expect((await app.inject({ method: "GET", url: `${url}?limit=101`, headers })).statusCode).toBe(400);
    expect((await adjust(input)).statusCode).toBe(404);
  });

  it("checks current branch authority before replaying a committed command", async () => {
    const { medicine, input } = await stock();
    expect((await adjust(input)).statusCode).toBe(200);
    const member = (await OrgMember.findOne({ userId: actorId, organizationId }))!;
    await OrgMember.updateOne({ _id: member._id }, { $set: { "locationAccess.locationIds": [] } });
    try {
      expect((await adjust(input)).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `/api/pharmacy/medicines/${medicine.id}/stock-movements`, headers })).statusCode).toBe(404);
    } finally { await OrgMember.updateOne({ _id: member._id }, { $set: { "locationAccess.locationIds": [locationId] } }); }
  });

  it("prevents updates and deletes of committed movements through Mongoose", async () => {
    const { medicine, input } = await stock();
    expect((await adjust(input)).statusCode).toBe(200);
    const movement = (await StockMovement.findOne({ medicineId: medicine.id, kind: "adjustment" }))!;
    movement.notes = "Rewritten";
    await expect(movement.save()).rejects.toThrow("append-only");
    await expect(StockMovement.updateOne({ _id: movement.id }, { $set: { quantityDelta: 100 } })).rejects.toThrow("append-only");
    await expect(StockMovement.deleteOne({ _id: movement.id })).rejects.toThrow("append-only");
    await expect(movement.deleteOne()).rejects.toThrow("append-only");
    await expect(StockMovement.bulkWrite([{ deleteOne: { filter: { _id: movement._id } } }])).rejects.toThrow("append-only");
  });

  it("fails closed before stock writes on a standalone MongoDB topology", async () => {
    const { medicine, input } = await stock();
    const mock = vi.spyOn((mongoose.connection as any).client.topology, "description", "get").mockReturnValue({ type: "Single" });
    try {
      expect((await adjust(input)).statusCode).toBe(503);
      await expect(dispenseMedicineFEFO(medicine.id, locationId, 1)).rejects.toThrow(/replica set/i);
      await expect(addBatchToMedicine({ medicineId: medicine.id, locationId, batchNumber: "UNSUPPORTED", expiryDate: "2099-12-31",
        quantity: 1, purchaseCost: 5, sellingPrice: 10 })).rejects.toThrow(/replica set/i);
    } finally { mock.mockRestore(); }
    await balance(medicine.id, 10, 0);
    expect(await StockMovement.countDocuments({ medicineId: medicine.id })).toBe(0);
  });
});
