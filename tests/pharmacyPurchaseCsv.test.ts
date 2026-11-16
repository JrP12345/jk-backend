import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../index.ts";
import { pharmacyPurchaseFixture as fixture } from "./helpers/pharmacyPurchaseFixture.ts";
import { Medicine } from "../models/Medicine.ts";
import { PharmacyPurchase } from "../models/PharmacyPurchase.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { Role } from "../models/Role.ts";
import { ModuleRegistry } from "../models/ModuleRegistry.ts";
import { purchaseCsvFields } from "../services/PharmacyPurchaseCsvService.ts";

beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
type Fixture = Awaited<ReturnType<typeof fixture>>;
const headers = [...purchaseCsvFields];
const mapping = Object.fromEntries(headers.map(field => [field, field]));
const cells = { source: "001", packs: "2", looseUnits: "1", freePacks: "1", freeLooseUnits: "0", baseAmount: "123.45", discount: "0.01", gst: "18", hsn: "300490", sellingPrice: "10.00", mrp: "12.00" };
const csv = (overrides: Partial<typeof cells> = {}) => headers.join(",") + "\r\n" + headers.map(field => ({ ...cells, ...overrides })[field]).join(",");
const post = (f: Fixture, kind: string, body: object) => app.inject({ method: "POST", url: `/api/pharmacy/purchase-csv/${kind}`, headers: f.headers, payload: { locationId: f.locationId, supplierId: f.party.id, ...body } });
const body = (f: Fixture, overrides: object = {}) => ({ csv: csv(), mapping, priceBasis: "base_unit", matches: [{ sourceValue: "001", medicineId: f.medicine.id, expectedUnitVersion: 1 }], ...overrides });

describe("Purchase CSV preparation", () => {
  it("preserves literal source codes, escaped quotes and original physical lines without writes", async () => {
    const f = await fixture();
    const input = '\uFEFFItem,Amount\r\n"001, cotton\nroll ""large""",0.29\r\n002,1.00';
    const response = await post(f, "inspect", { csv: input });
    expect(response.statusCode, response.body).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json().data).toMatchObject({ headers: ["Item", "Amount"], fields: purchaseCsvFields,
      records: [{ sourceLine: 2, cells: { Item: '001, cotton\nroll "large"', Amount: "0.29" } }, { sourceLine: 4, cells: { Item: "002", Amount: "1.00" } }] });
    expect(await PharmacyPurchase.countDocuments({ organizationId: f.organizationId })).toBe(1);
    expect(await MedicineBatch.countDocuments({ medicineId: f.medicine.id })).toBe(0);
    expect(await StockMovement.countDocuments({ medicineId: f.medicine.id })).toBe(0);
  });
  it("prepares exact billed/free amounts with real current units and reuses normal draft validation/deduplication", async () => {
    const f = await fixture(), response = await post(f, "preview", body(f));
    expect(response.statusCode, response.body).toBe(200);
    const preview = response.json().data;
    expect(preview).toMatchObject({ ignoredColumns: [], rows: [{ sourceLine: 2, sourceValue: "001", error: null,
      line: { medicineId: f.medicine.id, expectedUnitVersion: 1, packs: 2, looseUnits: 1, freePacks: 1, freeLooseUnits: 0,
        baseAmountPaise: 12345, discountPaise: 1, gstRateBps: 1800, hsnCode: "300490", sellingPricePaise: 1000, mrpPaise: 1200 }, product: { id: f.medicine.id, unitDefinition: { unitsPerPack: 10 } } }] });
    expect(preview.rows[0].product).not.toHaveProperty("costPrice");
    const payload = { ...f.body, supplierInvoiceNumber: "CSV-001", lines: preview.rows.map((row: { line: unknown }) => row.line) }, key = crypto.randomUUID();
    const save = () => app.inject({ method: "POST", url: "/api/pharmacy/purchases", headers: { ...f.headers, "idempotency-key": key }, payload });
    const saved = await save(); expect(saved.statusCode, saved.body).toBe(201);
    expect((await save()).json().data.id).toBe(saved.json().data.id);
    expect((await app.inject({ method: "POST", url: "/api/pharmacy/purchases", headers: { ...f.headers, "idempotency-key": crypto.randomUUID() }, payload })).statusCode).toBe(409);
    expect(await MedicineBatch.countDocuments({ medicineId: f.medicine.id })).toBe(0);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(0);
  });
  it("reports row errors rather than coercing money, formulas, percentages, units or missing tax", async () => {
    const f = await fixture();
    for (const invalid of [{ baseAmount: "1.001" }, { packs: "1.5" }, { packs: "=2+1" }, { packs: "9007199254740991" }, { looseUnits: "10" }, { discount: "999" }, { gst: "18%" }, { gst: "" }, { hsn: "300" }, { sellingPrice: "13" }, { packs: "0", looseUnits: "0" }]) {
      const response = await post(f, "preview", body(f, { csv: csv(invalid) }));
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data.rows[0]).toMatchObject({ sourceLine: 2, error: expect.any(String), line: null, product: null });
    }
    expect(await PharmacyPurchase.countDocuments({ organizationId: f.organizationId })).toBe(1);
  });
  it("converts explicitly selected pack selling prices/MRP without silently rounding fractional paise", async () => {
    const f = await fixture();
    const valid = await post(f, "preview", body(f, { priceBasis: "pack", csv: csv({ sellingPrice: "100.00", mrp: "120.00" }) }));
    expect(valid.statusCode, valid.body).toBe(200);
    expect(valid.json().data.rows[0].line).toMatchObject({ sellingPricePaise: 1000, mrpPaise: 1200, baseAmountPaise: 12345 });
    const invalid = await post(f, "preview", body(f, { priceBasis: "pack", csv: csv({ sellingPrice: "100.01", mrp: "120.00" }) }));
    expect(invalid.json().data.rows[0]).toMatchObject({ error: expect.stringContaining("does not convert to whole paise"), line: null });
    expect((await post(f, "preview", body(f, { priceBasis: "guessed" }))).statusCode).toBe(400);
  });
  it("requires explicit mapping, distinct columns and at least one billed quantity column", async () => {
    const f = await fixture();
    const without = (...keys: string[]) => Object.fromEntries(Object.entries(mapping).filter(([key]) => !keys.includes(key)));
    for (const bad of [without("gst"), without("packs", "looseUnits"), { ...mapping, looseUnits: "packs" }, { ...mapping, mrp: "not-a-header" }, { ...mapping, inferredSchedule: "source" }]) {
      expect((await post(f, "preview", body(f, { mapping: bad }))).statusCode).toBe(400);
    }
    const reduced = without("packs", "freePacks", "freeLooseUnits", "discount", "mrp");
    const valid = await post(f, "preview", body(f, { mapping: reduced }));
    expect(valid.statusCode, valid.body).toBe(200);
    expect(valid.json().data.rows[0].line).toMatchObject({ packs: 0, freePacks: 0, discountPaise: 0 });
    expect(valid.json().data.rows[0].line).not.toHaveProperty("mrpPaise");
    expect(valid.json().data.ignoredColumns).toContain("mrp");
  });
  it("does not auto-match a medicine, silently accept stale pack versions or expose foreign/deleted medicines", async () => {
    const f = await fixture(), foreign = await fixture();
    for (const matches of [[], [{ sourceValue: "001", medicineId: foreign.medicine.id, expectedUnitVersion: 1 }], [{ sourceValue: "001", medicineId: f.medicine.id, expectedUnitVersion: 0 }]]) {
      const response = await post(f, "preview", body(f, { matches }));
      expect(response.statusCode).toBe(200); expect(response.json().data.rows[0].product).toBeNull(); expect(response.json().data.rows[0].error).toBeTruthy();
    }
    await Medicine.updateOne({ _id: f.medicine.id }, { $set: { deletedAt: new Date() } });
    expect((await post(f, "preview", body(f))).json().data.rows[0].line).toBeNull();
  });
  it("matches repeated source codes explicitly while retaining separate source lines and line identities", async () => {
    const f = await fixture(), input = csv() + "\n" + csv({ baseAmount: "0.29", gst: "0", discount: "0" }).split("\r\n")[1];
    const response = await post(f, "preview", body(f, { csv: input }));
    const rows = response.json().data.rows;
    expect(rows).toHaveLength(2); expect(rows.every((row: { error: unknown }) => row.error === null)).toBe(true);
    expect(rows[0].line.lineId).not.toBe(rows[1].line.lineId); expect(rows[1].line.baseAmountPaise).toBe(29);
    expect((await post(f, "preview", body(f, { matches: [...body(f).matches, ...body(f).matches] }))).statusCode).toBe(400);
  });
  it("bounds source files/rows and rejects malformed CSV before querying medicine data", async () => {
    const f = await fixture();
    for (const input of ["X,X\n1,2", "X,Y\n1", 'X\n"unclosed', "X\n" + "a".repeat(512000), "X\n" + Array.from({ length: 101 }, () => "row").join("\n")]) {
      expect((await post(f, "inspect", { csv: input })).statusCode).toBe(400);
    }
  });
  it("requires purchase authority and branch/module access for inspect and preview", async () => {
    const f = await fixture(), foreign = await fixture();
    for (const kind of ["inspect", "preview"]) {
      expect((await post(f, kind, { ...(kind === "inspect" ? { csv: csv() } : body(f)), locationId: foreign.locationId })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: `/api/pharmacy/purchase-csv/${kind}`, payload: { locationId: f.locationId, csv: csv() } })).statusCode).toBe(401);
    }
    const disabled = await ModuleRegistry.create({ organizationId: f.organizationId, moduleKey: "pharmacy", enabled: false, priority: "P1", label: "Pharmacy" });
    expect((await post(f, "inspect", { csv: csv() })).statusCode).toBe(403);
    expect((await post(f, "preview", body(f))).statusCode).toBe(403);
    await ModuleRegistry.deleteOne({ _id: disabled._id });
    await Role.updateOne({ name: f.role, organizationId: f.organizationId }, { $set: { permissions: [] } });
    expect((await post(f, "inspect", { csv: csv() })).statusCode).toBe(403);
    expect((await post(f, "preview", body(f))).statusCode).toBe(403);
  });
});
