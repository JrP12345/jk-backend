import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Role } from "../models/Role.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { createAuthSession } from "../utilities/helpers.ts";
import { toBaseUnits } from "../utilities/medicineCatalogue.ts";
import { addBatchToMedicine } from "../services/PharmacyInventoryService.ts";

const unit = { baseUnit: "tablet", packUnit: "strip", unitsPerPack: 10 };
async function fixture() {
  const organizationId = (await Organization.create({ name: "Catalogue organization", city: "Pune" })).id;
  const locationId = (await Location.create({ organizationId, name: "Catalogue branch", city: "Pune" })).id;
  const user = await User.create({ name: "Catalogue operator", email: `${crypto.randomUUID()}@example.test`, role: "catalogue_operator" });
  await Role.create({ name: "catalogue_operator", organizationId, permissions: ["PHARMACY_VIEW_STOCK", "PHARMACY_MANAGE_CATALOG"] });
  await OrgMember.create({ userId: user.id, organizationId, role: user.role, locationAccess: { mode: "selected", locationIds: [locationId] } });
  const session = await createAuthSession({ id: user.id, email: user.email!, role: user.role, organization_id: organizationId });
  const admin = await User.create({ name: "Catalogue owner", email: `${crypto.randomUUID()}@example.test`, role: "admin" });
  await OrgMember.create({ organizationId, userId: admin.id, role: "admin" });
  const adminSession = await createAuthSession({ id: admin.id, role: "admin", email: admin.email!, organization_id: organizationId });
  const body = { locationId, name: "Empty formulation", genericName: "Synthetic composition", price: 10, unitDefinition: unit };
  return { organizationId, locationId, user, roleName: user.role, headers: { authorization: `Bearer ${session.accessToken}` }, adminHeaders: { authorization: `Bearer ${adminSession.accessToken}` }, body };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const create = (f: Fixture, fields: object = {}, headers = f.headers) => app.inject({ method: "POST", url: "/api/medicines", headers, payload: { ...f.body, ...fields } });
const edit = (f: Fixture, id: string, fields: object) => app.inject({ method: "PUT", url: `/api/medicines/${id}`, headers: f.headers, payload: fields });
const list = (f: Fixture, query = "") => app.inject({ method: "GET", url: `/api/medicines?locationId=${f.locationId}${query}`, headers: f.headers });
beforeAll(async () => { await app.ready(); await Medicine.init(); });

describe("Compatible medicine catalogue metadata", () => {
  it("creates zero-stock catalogue items without fabricated batch, expiry or acquisition cost", async () => {
    const f = await fixture(), response = await create(f, { price: 0, strength: "500 mg", manufacturer: "Synthetic manufacturer", category: "capsule", scheduleType: "schedule_h1", reorderLevel: 0,
      barcodes: ["0012345678905", "SKU-500"], hsnCode: "300490", gstRate: 0 });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().data).toMatchObject({ stockQuantity: 0, price: 0, strength: "500 mg", manufacturer: "Synthetic manufacturer", category: "capsule", scheduleType: "schedule_h1", reorderLevel: 0,
      unitDefinition: { ...unit, version: 1 }, hsnCode: "300490", gstRate: 0, barcodes: ["0012345678905", "SKU-500"] });
    for (const field of ["expiryDate", "batchNumber", "costPrice"]) expect(response.json().data).not.toHaveProperty(field);
    expect(response.json().data.dispensingReview?.confirmedAt).toBeUndefined(); expect(response.json().data.taxClassification?.confirmedAt).toBeUndefined();
    expect(await MedicineBatch.countDocuments({ medicineId: response.json().data.id })).toBe(0);
    expect(await StockMovement.countDocuments({ medicineId: response.json().data.id })).toBe(0);
  });
  it("preserves the authorized legacy opening-stock body and denies it to catalogue-only staff", async () => {
    const f = await fixture();
    const opening = { unitDefinition: undefined, stockQuantity: 5, costPrice: 2, batchNumber: "ACTUAL", expiryDate: "2099-12-31" };
    expect((await create(f, opening)).statusCode).toBe(403);
    const response = await create(f, opening, f.adminHeaders);
    expect(response.statusCode, response.body).toBe(201); expect(response.json().data).toMatchObject({ stockQuantity: 5, costPrice: 2, batchNumber: "ACTUAL" });
    expect((await create(f, { ...opening, expiryDate: undefined }, f.adminHeaders)).statusCode).toBe(400);
  });
  it("does not let catalogue metadata writes replace stock or approve tax/restriction changes", async () => {
    const f = await fixture(), id = (await create(f)).json().data.id;
    expect((await edit(f, id, { stockQuantity: 1 })).statusCode).toBe(409);
    expect((await edit(f, id, { costPrice: 0 })).statusCode).toBe(403);
    expect((await edit(f, id, { scheduleType: "schedule_h" })).statusCode).toBe(409);
    expect((await edit(f, id, { gstRate: 0 })).statusCode).toBe(409);
    const metadata = await edit(f, id, { manufacturer: "Updated manufacturer", strength: "250 mg", reorderLevel: 0, barcodes: ["000005"] });
    expect(metadata.statusCode, metadata.body).toBe(200); expect(metadata.json().data).toMatchObject({ stockQuantity: 0, manufacturer: "Updated manufacturer", strength: "250 mg", reorderLevel: 0, barcodes: ["000005"] });
    expect(metadata.json().data).not.toHaveProperty("costPrice");
  });
  it.each([{ name: " " }, { reorderLevel: -1 }, { reorderLevel: 0.5 }, { unitDefinition: { ...unit, unitsPerPack: 0 } }, { unitDefinition: { ...unit, unitsPerPack: 1.5 } },
    { unitDefinition: { ...unit, unitsPerPack: 1000001 } }, { barcodes: ["same", "same"] }, { barcodes: ["bad barcode"] }])("rejects invalid metadata %j", async fields => {
    const f = await fixture(); expect((await create(f, fields)).statusCode).toBe(400); expect(await Medicine.countDocuments({ locationId: f.locationId })).toBe(0);
  });
  it("keeps legacy unit identity absent and prevents declaring units over existing quantities", async () => {
    const f = await fixture();
    const medicine = await Medicine.create({ locationId: f.locationId, name: "Legacy units", genericName: "Synthetic", price: 10, costPrice: 2, stockQuantity: 5 });
    expect((await list(f)).json().data[0]).not.toHaveProperty("unitDefinition");
    expect((await edit(f, medicine.id, { unitDefinition: unit, expectedUnitVersion: 0 })).statusCode).toBe(409);
    expect((await Medicine.findById(medicine.id))!.unitDefinition).toBeUndefined();
  });
});

describe("Barcode identity and bounded search", () => {
  it("preserves leading zeros and finds an alias without numeric normalization", async () => {
    const f = await fixture(), created = await create(f, { barcodes: ["000123", "ALIAS-500"] });
    expect(created.statusCode, created.body).toBe(201);
    expect((await list(f, "&barcode=000123")).json().data[0].id).toBe(created.json().data.id);
    expect((await list(f, "&barcode=123")).json().data).toEqual([]);
    expect((await list(f, "&search=ALIAS-500")).json().data[0].id).toBe(created.json().data.id);
  });
  it("enforces concurrent alias uniqueness only within the active location catalogue", async () => {
    const f = await fixture();
    const responses = await Promise.all([create(f, { name: "First", barcodes: ["SHARED"] }), create(f, { name: "Second", barcodes: ["SHARED"] })]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([201, 409]);
    const location = await Location.create({ organizationId: f.organizationId, name: "Other branch", city: "Pune" });
    expect((await create(f, { locationId: location.id, barcodes: ["SHARED"] }, f.adminHeaders)).statusCode).toBe(201);
    const successful = responses.find(response => response.statusCode === 201)!.json().data.id;
    expect((await app.inject({ method: "DELETE", url: `/api/medicines/${successful}`, headers: f.headers })).statusCode).toBe(200);
    expect((await create(f, { barcodes: ["SHARED"] })).statusCode).toBe(201);
  });
  it("finds the correct formulation beyond the first page with one bounded search", async () => {
    const f = await fixture();
    await Medicine.insertMany(Array.from({ length: 105 }, (_, index) => ({ locationId: f.locationId, name: `A formulation ${String(index).padStart(3, "0")}`, genericName: "Synthetic", price: 10, stockQuantity: 0 })));
    const target = await Medicine.create({ locationId: f.locationId, name: "Z formulation", genericName: "Synthetic", strength: "875 mg", manufacturer: "Target manufacturer", price: 10, costPrice: 2, barcodes: ["00123499"] });
    const page = await list(f, "&limit=100&page=1"); expect(page.json().data).toHaveLength(100); expect(page.headers["x-total-count"]).toBe("106");
    expect(page.json().data.some((medicine: { id: string }) => medicine.id === target.id)).toBe(false);
    for (const search of ["875", "Target manufacturer", "00123499"]) {
      const response = await list(f, `&search=${encodeURIComponent(search)}&limit=100`);
      expect(response.statusCode, response.body).toBe(200); expect(response.json().data).toHaveLength(1); expect(response.json().data[0].id).toBe(target.id);
      expect(response.json().data[0]).not.toHaveProperty("costPrice");
    }
    expect((await list(f, `&medicineIds=${target.id}`)).json().data[0].id).toBe(target.id);
    expect((await list(f, "&limit=101")).statusCode).toBe(400);
    expect((await list(f, `&medicineIds=${Array.from({ length: 101 }, () => target.id).join(",")}`)).statusCode).toBe(400);
  });
  it("keeps barcode and selected-ID lookups within current branch authority", async () => {
    const f = await fixture(), foreign = await fixture(), id = (await create(foreign, { barcodes: ["PRIVATE"] })).json().data.id;
    expect((await list(f, "&barcode=PRIVATE")).json().data).toEqual([]);
    expect((await list(f, `&medicineIds=${id}`)).json().data).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/api/medicines?locationId=${foreign.locationId}&barcode=PRIVATE`, headers: f.headers })).statusCode).toBe(404);
  });
  it("applies low/out filters server-side and respects a zero reorder threshold", async () => {
    const f = await fixture();
    await Medicine.insertMany([{ locationId: f.locationId, name: "Zero threshold", genericName: "Synthetic", price: 1, stockQuantity: 1, reorderLevel: 0 },
      { locationId: f.locationId, name: "Low threshold", genericName: "Synthetic", price: 1, stockQuantity: 2, reorderLevel: 3 },
      { locationId: f.locationId, name: "Out", genericName: "Synthetic", price: 1, stockQuantity: 0, reorderLevel: 0 }]);
    expect((await list(f, "&stockFilter=low")).json().data.map((medicine: { name: string }) => medicine.name).sort()).toEqual(["Low threshold", "Out"]);
    expect((await list(f, "&stockFilter=out")).json().data.map((medicine: { name: string }) => medicine.name)).toEqual(["Out"]);
  });
});

describe("Versioned unit safety", () => {
  it("allows pre-stock unit edits with an expected version and rejects stale updates", async () => {
    const f = await fixture(), id = (await create(f)).json().data.id;
    const change = { unitDefinition: { ...unit, unitsPerPack: 20 }, expectedUnitVersion: 1 };
    const response = await edit(f, id, change); expect(response.statusCode, response.body).toBe(200); expect(response.json().data.unitDefinition).toMatchObject({ version: 2, unitsPerPack: 20 });
    expect((await edit(f, id, change)).statusCode).toBe(409);
    expect((await edit(f, id, { ...change, expectedUnitVersion: 2 })).json().data.unitDefinition.version).toBe(2);
  });
  it("blocks unit reinterpretation even after all historical batches are depleted", async () => {
    const f = await fixture(), id = (await create(f)).json().data.id;
    await MedicineBatch.create({ medicineId: id, locationId: f.locationId, batchNumber: "DEPLETED", expiryDate: "2099-12-31", quantity: 0, purchaseCost: 1, sellingPrice: 2, status: "depleted" });
    expect((await edit(f, id, { unitDefinition: { ...unit, unitsPerPack: 20 }, expectedUnitVersion: 1 })).statusCode).toBe(409);
    expect((await Medicine.findById(id))!.unitDefinition!.unitsPerPack).toBe(10);
  });
  it("rejects a unit edit if the first receipt commits after the history check", async () => {
    const f = await fixture(), id = (await create(f)).json().data.id;
    const exists = MedicineBatch.exists.bind(MedicineBatch); let received = false;
    const spy = vi.spyOn(MedicineBatch, "exists").mockImplementation(((...args: unknown[]) => {
      const query = Reflect.apply(exists, MedicineBatch, args), execute = query.exec.bind(query);
      query.exec = async () => {
        const result = await execute();
        if (!received && String((args[0] as { medicineId?: unknown }).medicineId) === id) {
          received = true;
          await (mongoose as any).transactionAsyncLocalStorage.run(undefined, () => addBatchToMedicine({ medicineId: id, locationId: f.locationId,
            batchNumber: "FIRST", expiryDate: "2099-12-31", quantity: 2, purchaseCost: 2, sellingPrice: 10 }));
        }
        return result;
      }; return query;
    }) as typeof MedicineBatch.exists);
    try { const response = await edit(f, id, { unitDefinition: { ...unit, unitsPerPack: 20 }, expectedUnitVersion: 1 }); expect(response.statusCode, response.body).toBe(409); }
    finally { spy.mockRestore(); }
    expect(received).toBe(true); expect((await Medicine.findById(id))!.unitDefinition!.version).toBe(1); expect((await Medicine.findById(id))!.stockQuantity).toBe(2);
  });
  it("keeps unit conversion exact and rejects unsafe multiplication", () => {
    expect(toBaseUnits(3, 10)).toBe(30); expect(() => toBaseUnits(Number.MAX_SAFE_INTEGER, 2)).toThrow(/safe/);
  });
});
