import mongoose from "mongoose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { pharmacyPurchaseFixture as fixture } from "./helpers/pharmacyPurchaseFixture.ts";
import { PharmacyPurchaseCsvFormat, PharmacySupplierItemMapping } from "../models/PharmacyPurchaseCsvMapping.ts";
import { purchaseCsvFields } from "../services/PharmacyPurchaseCsvService.ts";
import { Medicine } from "../models/Medicine.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { PharmacyPurchase } from "../models/PharmacyPurchase.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Role } from "../models/Role.ts";
import { ModuleRegistry } from "../models/ModuleRegistry.ts";
import { Location } from "../models/Location.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { purchaseCsvFormatId, purchaseCsvFormatKey } from "../utilities/pharmacyPurchaseCsvMapping.ts";

beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
afterEach(() => vi.restoreAllMocks());
type Fixture = Awaited<ReturnType<typeof fixture>>;
const mapping = Object.fromEntries(purchaseCsvFields.map(field => [field, field]));
const source = (code = "001", reversed = false, extra = false) => {
  const values = { source: code, packs: "1", looseUnits: "0", freePacks: "0", freeLooseUnits: "0", baseAmount: "100.00", discount: "0", gst: "0", hsn: "300490", sellingPrice: "10.00", mrp: "12.00", alternate: code };
  const fields = [...purchaseCsvFields, ...(extra ? ["alternate" as const] : [])];
  if (reversed) fields.reverse();
  return fields.join(",") + "\n" + fields.map(field => values[field]).join(",");
};
const post = (f: Fixture, kind: string, input: object) => app.inject({ method: "POST", url: `/api/pharmacy/purchase-csv/${kind}`, headers: f.headers, payload: { locationId: f.locationId, supplierId: f.party.id, ...input } });
const save = (f: Fixture, input: object) => app.inject({ method: "PUT", url: "/api/pharmacy/purchase-csv/profile", headers: f.headers, payload: { locationId: f.locationId, supplierId: f.party.id, ...input } });
async function reviewed(f: Fixture, csv = source(), revision = 0, fields = mapping) {
  const input = { csv, mapping: fields, priceBasis: "base_unit", matches: [{ sourceValue: csv.split("\n")[1].split(",")[0], medicineId: f.medicine.id, expectedUnitVersion: 1 }] };
  const result = await post(f, "preview", input); expect(result.statusCode, result.body).toBe(200);
  const row = result.json().data.rows[0]; expect(row.error).toBeNull();
  return { ...input, matches: [{ ...input.matches[0], expectedIdentityHash: row.product.identityHash }], expectedRevision: revision, confirmedMappings: true };
}
const inspect = (f: Fixture, csv = source(), extra = {}) => post(f, "inspect", { csv, ...extra });
const events = (f: Fixture) => AuditLog.countDocuments({ organizationId: f.organizationId, action: "PHARMACY_PURCHASE_CSV_MAPPINGS_SAVED" });
const formats = (f: Fixture) => PharmacyPurchaseCsvFormat.countDocuments({ supplierId: f.party.id });
const items = (f: Fixture) => PharmacySupplierItemMapping.countDocuments({ formatId: purchaseCsvFormatId(f.organizationId, f.locationId, f.party.id, purchaseCsvFormatKey([...purchaseCsvFields])) });

describe("Supplier CSV mappings", () => {
  it("remembers only reviewed identities and restores this supplier's matching format without financial effects", async () => {
    const f = await fixture(), input = await reviewed(f);
    const initial = await inspect(f); expect(initial.json().data.profile).toBeNull();
    const saved = await save(f, input); expect(saved.statusCode, saved.body).toBe(200); expect(saved.headers["cache-control"]).toBe("no-store");
    expect(saved.json().data).toMatchObject({ supplierId: f.party.id, locationId: f.locationId, revision: 1, formatKey: initial.json().data.formatKey });
    const loaded = (await inspect(f)).json().data;
    expect(loaded.profile).toMatchObject({ revision: 1, mapping, priceBasis: "base_unit", matches: [{ sourceValue: "001", error: null, product: { id: f.medicine.id, identityHash: input.matches[0].expectedIdentityHash, unitDefinition: { version: 1, unitsPerPack: 10 } } }] });
    expect(loaded.profile.matches[0].product).not.toHaveProperty("costPrice");
    const stored = await PharmacyPurchaseCsvFormat.findOne({ supplierId: f.party.id }).lean();
    expect(stored).not.toHaveProperty("csv"); expect(stored).not.toHaveProperty("rows"); expect(stored).not.toHaveProperty("amounts");
    expect(await PharmacyPurchase.countDocuments({ organizationId: f.organizationId })).toBe(1);
    expect(await StockMovement.countDocuments({ medicineId: f.medicine.id })).toBe(0); expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(0);
    expect(await events(f)).toBe(1);
  });
  it("retains previous item codes, reads only the current file's codes, and handles reordered columns by name", async () => {
    const f = await fixture(); expect((await save(f, await reviewed(f))).statusCode).toBe(200);
    const second = (await inspect(f, source("002"))).json().data;
    expect(second.profile.revision).toBe(1); expect(second.profile.matches).toEqual([]);
    expect((await save(f, await reviewed(f, source("002"), 1))).statusCode).toBe(200);
    expect((await inspect(f)).json().data.profile.matches.map((item: { sourceValue: string }) => item.sourceValue)).toEqual(["001"]);
    expect((await inspect(f, source("002"))).json().data.profile.matches.map((item: { sourceValue: string }) => item.sourceValue)).toEqual(["002"]);
    const reordered = (await inspect(f, source("001", true))).json().data;
    expect(reordered.profile).toMatchObject({ revision: 2, matches: [{ sourceValue: "001", product: { id: f.medicine.id } }] });
    expect(await items(f)).toBe(2);
  });
  it("does not reuse mappings across suppliers, branches, organizations or different header sets", async () => {
    const f = await fixture(), foreign = await fixture(); expect((await save(f, await reviewed(f))).statusCode).toBe(200);
    const other = await PharmacyParty.create({ organizationId: f.organizationId, locationIds: [f.locationId], name: "Other supplier", normalizedName: "other supplier", kinds: ["supplier"], address: "Other address", licence: { number: "OTHER-LICENCE" }, gstRegistration: "unregistered", createdBy: f.user.id, updatedBy: f.user.id });
    expect((await inspect(f, source(), { supplierId: other.id })).json().data.profile).toBeNull();
    expect((await inspect(foreign)).json().data.profile).toBeNull();
    expect((await inspect(f, source("001", false, true))).json().data.profile).toBeNull();
    expect((await inspect(f, source(), { supplierId: foreign.party.id })).statusCode).toBe(404);
    const branch = await Location.create({ organizationId: f.organizationId, name: "Other branch", city: "Pune" });
    await PharmacyParty.updateOne({ _id: f.party.id }, { $addToSet: { locationIds: branch._id } });
    await OrgMember.updateOne({ organizationId: f.organizationId, userId: f.user.id }, { $set: { locationAccess: { mode: "all", locationIds: [] } } });
    expect((await inspect(f, source(), { locationId: branch.id })).json().data.profile).toBeNull();
  });
  it.each(["name", "unit", "deleted"])("requires rematching when saved medicine %s changes", async kind => {
    const f = await fixture(), input = await reviewed(f); expect((await save(f, input)).statusCode).toBe(200);
    await Medicine.updateOne({ _id: f.medicine.id }, { $set: kind === "name" ? { name: "Changed strength/name" } : kind === "unit" ? { "unitDefinition.version": 2, "unitDefinition.unitsPerPack": 20 } : { deletedAt: new Date() } });
    const response = await inspect(f); expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.profile.matches[0]).toMatchObject({ sourceValue: "001", product: null, error: expect.any(String) });
    expect((await save(f, { ...input, expectedRevision: 1 })).statusCode).toBe(409);
    expect(await events(f)).toBe(1);
  });
  it("rejects changed identity evidence between restore and preview even when the pack version is unchanged", async () => {
    const f = await fixture(), input = await reviewed(f); expect((await save(f, input)).statusCode).toBe(200);
    await Medicine.updateOne({ _id: f.medicine.id }, { $set: { manufacturer: "Different manufacturer" } });
    const { expectedRevision: _revision, confirmedMappings: _confirmed, ...preview } = input;
    const result = await post(f, "preview", preview);
    expect(result.statusCode).toBe(200); expect(result.json().data.rows[0]).toMatchObject({ product: null, error: expect.stringContaining("details changed") });
  });
  it("does not overwrite competing edits and allows an identical uncertain-save retry without duplicate revision/audit", async () => {
    const f = await fixture(), input = await reviewed(f);
    const responses = await Promise.all([save(f, input), save(f, input)]);
    expect(responses.map(response => response.statusCode)).toEqual([200, 200]);
    expect(responses.map(response => response.json().data.revision)).toEqual([1, 1]); expect(await events(f)).toBe(1);
    const conflicting = await save(f, { ...input, priceBasis: "pack" });
    expect(conflicting.statusCode, conflicting.body).toBe(409);
    expect((await save(f, { ...input, priceBasis: "pack", expectedRevision: 1 })).json().data.revision).toBe(2);
    expect(await events(f)).toBe(2); expect(await formats(f)).toBe(1);
  });
  it("rolls back preferences and item mappings if their audit fails, then permits a safe retry", async () => {
    const f = await fixture(), input = await reviewed(f);
    const audit = vi.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("Synthetic audit failure"));
    expect((await save(f, input)).statusCode).toBe(503); audit.mockRestore();
    expect(await formats(f)).toBe(0); expect(await items(f)).toBe(0);
    expect((await save(f, input)).statusCode).toBe(200); expect(await events(f)).toBe(1);
  });
  it("requires explicit reviewed identities and purchase authority, and blocks archived suppliers/disabled modules", async () => {
    const f = await fixture(), input = await reviewed(f);
    expect((await save(f, { ...input, confirmedMappings: false })).statusCode).toBe(400);
    expect((await save(f, { ...input, matches: [{ ...input.matches[0], expectedIdentityHash: "a".repeat(64) }] })).statusCode).toBe(409);
    expect((await app.inject({ method: "PUT", url: "/api/pharmacy/purchase-csv/profile", payload: input })).statusCode).toBe(401);
    await PharmacyParty.updateOne({ _id: f.party.id }, { $set: { archived: true } });
    expect((await save(f, input)).statusCode).toBe(409); await PharmacyParty.updateOne({ _id: f.party.id }, { $set: { archived: false } });
    const disabled = await ModuleRegistry.create({ organizationId: f.organizationId, moduleKey: "pharmacy", enabled: false, priority: "P1", label: "Pharmacy" });
    expect((await save(f, input)).statusCode).toBe(403); await ModuleRegistry.deleteOne({ _id: disabled._id });
    await Role.updateOne({ name: f.role, organizationId: f.organizationId }, { $set: { permissions: [] } });
    expect((await save(f, input)).statusCode).toBe(403); expect(await formats(f)).toBe(0);
  });
});
