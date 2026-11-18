import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { pharmacyRetailFixture } from "./helpers/pharmacyRetailFixture.ts";
import { PharmacyGlobalProduct } from "../models/PharmacyGlobalProduct.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { User } from "../models/User.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Organization } from "../models/Organization.ts";
import { syntheticCdciZip } from "./helpers/pharmacyCdciFixture.ts";
import { readCdciPackage, mapCdciBrand } from "../utilities/pharmacyCdci.ts";
import { ingestReviewedCatalogue, reviewCatalogueBatch } from "../services/PharmacyCatalogueIngestionService.ts";
import { normalizeEVitalProduct } from "../utilities/pharmacyGlobalCatalogue.ts";
import { maintainReviewedCatalogue } from "../services/PharmacyCatalogueMaintenanceService.ts";
import { Location } from "../models/Location.ts";

beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
afterEach(() => vi.restoreAllMocks());
const rights = { provider: "reviewed", release: "SYNTHETIC-TEST-ONLY", reference: "Synthetic fixture, not a medicine dataset", licenceSha256: "a".repeat(64), reviewReference: "Synthetic testing rights only", commercialStorageAndRedistributionApproved: true };
const product = (id: string = crypto.randomUUID()) => ({ sourceId: id, name: "Synthetic Brand 500", genericName: "Synthetic salt", composition: "Synthetic salt 500 mg", strength: "500 mg", manufacturer: "Synthetic Maker", dosageForm: "Tablet", packSize: "10 tablets", barcodes: [crypto.randomUUID()] });
async function fixture() {
  const f = await pharmacyRetailFixture(["MANAGE_ORGANIZATION", "PHARMACY_MANAGE_CATALOG", "PHARMACY_VIEW_STOCK"]);
  const root = await User.create({ name: "Synthetic catalogue operator", email: `${crypto.randomUUID()}@example.test`, role: "root" });
  const identity = product();
  await ingestReviewedCatalogue({ ...rights, products: [identity] }, root.id, "b".repeat(64));
  const source = (await PharmacyGlobalProduct.findOne({ sourceId: identity.sourceId }))!;
  const body = { locationId: f.locationId, expectedRevision: 1, sellingPricePaise: 129, category: "tablet", confirmedIdentity: true,
    unitDefinition: { baseUnit: "tablet", packUnit: "strip", unitsPerPack: 10 } };
  const adopt = (extra = {}, headers = f.headers) => app.inject({ method: "POST", url: `/api/pharmacy/catalogue/global/${source.id}/adopt`, headers, payload: { ...body, ...extra } });
  return { ...f, root, identity, source, body, adopt };
}
describe("shared catalogue rights, identity and branch isolation", () => {
  it("keeps a reviewed withdrawal through provider refreshes and preserves existing branch products and holds", async () => {
    const f = await fixture(), adopted = await f.adopt(); expect(adopted.statusCode, adopted.body).toBe(200);
    const medicineId = adopted.json().data.medicine.id;
    const control = { revision: 1, blocked: true, reason: "Independent store review", reviewReference: "Synthetic hold", changedAt: new Date(), blockedAt: new Date(), changedBy: f.user.id };
    await Medicine.updateOne({ _id: medicineId }, { $set: { price: 99, saleControl: control } });
    const maintenance = { productId: f.source.id, expectedRevision: 1, status: "withdrawn", reason: "Synthetic withdrawn reference", reviewReference: "TEST ONLY reviewed source notice", confirmed: true };
    await expect(maintainReviewedCatalogue(maintenance, f.user.id)).rejects.toMatchObject({ statusCode: 403 });
    expect(await maintainReviewedCatalogue(maintenance, f.root.id)).toMatchObject({ revision: 2, maintenance: { status: "withdrawn" } });
    await expect(maintainReviewedCatalogue(maintenance, f.root.id)).rejects.toMatchObject({ statusCode: 409 });
    await ingestReviewedCatalogue({ ...rights, release: "SYNTHETIC-NEXT", products: [{ ...f.identity, name: "Corrected source name" }] }, f.root.id, "c".repeat(64));
    expect((await PharmacyGlobalProduct.findById(f.source.id))!).toMatchObject({ revision: 3, maintenance: { status: "withdrawn" }, name: "Corrected source name" });
    const search = await app.inject({ method: "GET", url: `/api/pharmacy/catalogue/global?locationId=${f.locationId}`, headers: f.headers });
    expect(search.json().data.items.some((row: any) => row.id === f.source.id)).toBe(false);
    const other = await pharmacyRetailFixture(["MANAGE_ORGANIZATION", "PHARMACY_MANAGE_CATALOG", "PHARMACY_VIEW_STOCK"]);
    expect((await f.adopt({ locationId: other.locationId, expectedRevision: 3 }, other.headers)).statusCode).toBe(409);
    expect((await Medicine.findById(medicineId))!).toMatchObject({ price: 99, name: f.identity.name, stockQuantity: 0, saleControl: { blocked: true } });
    expect((await f.adopt()).json().data.reused).toBe(true); // Existing branch identity remains usable.
    expect(await maintainReviewedCatalogue({ ...maintenance, expectedRevision: 3, status: "available" }, f.root.id)).toMatchObject({ revision: 4 });
    expect((await Medicine.findById(medicineId))!.saleControl?.blocked).toBe(true);
  });

  it("creates a billing-only catalogue product with printed supply evidence and no stock", async () => {
    const f = await fixture();
    await Location.updateOne({ _id: f.locationId }, { $set: { pharmacyCapability: { enabled: true, inventoryMode: "billing_only", revision: 1 } } });
    const missing = await f.adopt(); expect(missing.statusCode, missing.body).toBe(400);
    const billingSupply = { batchNumber: "PRINTED-REAL-PACK", expiry: { precision: "month", value: "2099-12" }, mrpPaise: 500 };
    expect((await f.adopt({ billingSupply: { ...billingSupply, mrpPaise: 100 } })).statusCode).toBe(400);
    const added = await f.adopt({ billingSupply }); expect(added.statusCode, added.body).toBe(200);
    const row = added.json().data.medicine; expect(row).toMatchObject({ stockQuantity: 0, billingSupply });
    expect(await MedicineBatch.countDocuments({ medicineId: row.id })).toBe(0); expect(await StockMovement.countDocuments({ medicineId: row.id })).toBe(0);
    expect(row.dispensingReview).toBeUndefined(); // Reference adoption never grants dispensing approval.
  });

  it("rolls back catalogue availability when required audit evidence cannot be stored", async () => {
    const f = await fixture();
    const audit = vi.spyOn(AuditLog, "create").mockRejectedValueOnce(Error("Synthetic audit outage"));
    try {
      await expect(maintainReviewedCatalogue({ productId: f.source.id, expectedRevision: 1, status: "discontinued", reason: "Synthetic notice", reviewReference: "TEST ONLY reviewed notice", confirmed: true }, f.root.id)).rejects.toThrow(/audit outage/);
    } finally { audit.mockRestore(); }
    expect((await PharmacyGlobalProduct.findById(f.source.id))!).toMatchObject({ revision: 1 });
    expect((await PharmacyGlobalProduct.findById(f.source.id))!.maintenance).toBeUndefined();
  });

  it("requires rights review and strips no unknown price or stock fields silently", () => {
    expect(() => reviewCatalogueBatch({ ...rights, commercialStorageAndRedistributionApproved: false, products: [product()] })).toThrow(/commercial/);
    expect(() => reviewCatalogueBatch({ ...rights, products: [{ ...product(), price: 50 }] })).toThrow(/Unsupported/);
    expect(() => reviewCatalogueBatch({ ...rights, products: [product("same"), product("same")] })).toThrow(/Duplicate/);
    const mapped = normalizeEVitalProduct({ medicine_id: "synthetic", medicine_name: "Synthetic", content: "Salt", dosage_type: "Tablet", packing_size: "1x10", manufacturer_name: "Maker", mrp: 999, size: 0 });
    expect(mapped).toMatchObject({ sourceId: "synthetic", composition: "Salt", packSize: "1x10" }); expect(mapped).not.toHaveProperty("mrp"); expect(mapped).not.toHaveProperty("unitsPerPack");
  });
  it("blocks tenant operators from publishing shared data", async () => {
    const f = await fixture();
    await expect(ingestReviewedCatalogue({ ...rights, products: [product()] }, f.user.id, "b".repeat(64))).rejects.toThrow(/root operator/);
  });
  it("requires CDCI-specific affiliate evidence, retains exact source IDs and does not treat source suppliers as manufacturers", async () => {
    const f = await fixture(), data = readCdciPackage(syntheticCdciZip()), mapped = mapCdciBrand(data, data.tables["BrandMaster.txt"].get("000700")!);
    const batch = { ...rights, provider: "cdci", products: [mapped] };
    await expect(ingestReviewedCatalogue(batch, f.root.id, data.packageSha256)).rejects.toThrow(/affiliate/);
    await expect(ingestReviewedCatalogue({ ...batch, snomedAffiliateReference: "TEST-ONLY" }, f.root.id, data.packageSha256)).rejects.toThrow(/India-only/);
    const approved = { ...batch, snomedAffiliateReference: "SYNTHETIC affiliate test only", indiaDeploymentAndUsersConfirmed: true };
    expect(await ingestReviewedCatalogue(approved, f.root.id, data.packageSha256)).toEqual({ created: 1, updated: 0, unchanged: 0 });
    const global = (await PharmacyGlobalProduct.findOne({ provider: "cdci", sourceId: "000700" }))!;
    expect(global.supplierName).toBe("Synthetic supplier"); expect(global.manufacturer).toBe(""); expect(global.sourceIds?.generic).toBe("200");
    expect(global.source?.territory).toBe("IN"); expect(global.source?.snomedAffiliateReference).toBe("SYNTHETIC affiliate test only");
    const search = await app.inject({ method: "GET", url: `/api/pharmacy/catalogue/global?locationId=${f.locationId}&search=${encodeURIComponent("Synthetic supplier")}`, headers: f.headers });
    expect(search.statusCode, search.body).toBe(200); const row = search.json().data.items.find((item: any) => item.id === global.id);
    expect(row).toMatchObject({ supplierName: "Synthetic supplier", manufacturer: "", sourceIds: { generic: "200" } });
    expect(row).not.toHaveProperty("snomedAffiliateReference");
    const adopt = await app.inject({ method: "POST", url: `/api/pharmacy/catalogue/global/${global.id}/adopt`, headers: f.headers, payload: f.body });
    expect(adopt.statusCode, adopt.body).toBe(200); expect(adopt.json().data.medicine).toMatchObject({ stockQuantity: 0, manufacturer: "", globalProductId: global.id });
    const foreign = await pharmacyRetailFixture(["MANAGE_ORGANIZATION", "PHARMACY_VIEW_STOCK", "PHARMACY_MANAGE_CATALOG"]);
    await Organization.updateOne({ _id: foreign.organizationId }, { $set: { countryCode: "US" } });
    const foreignSearch = await app.inject({ method: "GET", url: `/api/pharmacy/catalogue/global?locationId=${foreign.locationId}`, headers: foreign.headers });
    expect(foreignSearch.statusCode, foreignSearch.body).toBe(200); expect(foreignSearch.json().data.items.some((item: any) => item.provider === "cdci")).toBe(false);
    const denied = await app.inject({ method: "POST", url: `/api/pharmacy/catalogue/global/${global.id}/adopt`, headers: foreign.headers, payload: { ...f.body, locationId: foreign.locationId } });
    expect(denied.statusCode, denied.body).toBe(403);
  });
  it("bulk ingestion retries unchanged, updates references only and rolls back the full batch when audit fails", async () => {
    const f = await fixture(), products = Array.from({ length: 25 }, () => ({ ...product(), name: "Bulk reference only", genericName: "Bulk component", composition: "Bulk component", strength: "10 mg", manufacturer: "Bulk processor" }));
    const input = { ...rights, products };
    const spy = vi.spyOn(PharmacyGlobalProduct, "bulkWrite");
    expect(await ingestReviewedCatalogue(input, f.root.id, "e".repeat(64))).toEqual({ created: 25, updated: 0, unchanged: 0 }); expect(spy).toHaveBeenCalledTimes(1);
    expect(await ingestReviewedCatalogue(input, f.root.id, "e".repeat(64))).toEqual({ created: 0, updated: 0, unchanged: 25 }); expect(spy).toHaveBeenCalledTimes(1);
    const audit = vi.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("SYNTHETIC audit persistence failure"));
    const failed = { ...rights, products: products.map(row => ({ ...row, name: "Synthetic changed identity" })) };
    await expect(ingestReviewedCatalogue(failed, f.root.id, "f".repeat(64))).rejects.toThrow(/audit persistence/); audit.mockRestore();
    expect(await PharmacyGlobalProduct.countDocuments({ sourceId: { $in: products.map(row => row.sourceId) }, revision: 1, name: products[0].name })).toBe(25);
  });
  it("does not grant catalogue adoption to a sales-only operator", async () => {
    const f = await fixture(), cashier = await pharmacyRetailFixture(["PHARMACY_SELL"]);
    expect((await f.adopt({ locationId: cashier.locationId }, cashier.headers)).statusCode).toBe(403);
    const read = await app.inject({ method: "GET", url: `/api/pharmacy/catalogue/global?locationId=${cashier.locationId}`, headers: cashier.headers });
    expect(read.statusCode).toBe(403);
  });
  it("searches literal brand, salt, manufacturer and exact barcode without exposing branch data", async () => {
    const f = await fixture();
    for (const search of ["synthetic salt", "maker", "500"]) {
      const response = await app.inject({ method: "GET", url: `/api/pharmacy/catalogue/global?locationId=${f.locationId}&search=${encodeURIComponent(search)}`, headers: f.headers });
      expect(response.statusCode, response.body).toBe(200); expect(response.json().data.items.some((row: any) => row.id === f.source.id)).toBe(true);
      expect(response.json().data.items[0]).not.toHaveProperty("price"); expect(response.json().data.items[0]).not.toHaveProperty("stockQuantity");
    }
    const scan = await app.inject({ method: "GET", url: `/api/pharmacy/catalogue/global?locationId=${f.locationId}&barcode=${f.identity.barcodes[0]}`, headers: f.headers });
    expect(scan.json().data.items).toHaveLength(1);
    const literal = await app.inject({ method: "GET", url: `/api/pharmacy/catalogue/global?locationId=${f.locationId}&search=${encodeURIComponent(".*")}`, headers: f.headers });
    expect(literal.statusCode).toBe(200); expect(literal.json().data.items).toHaveLength(0);
    const other = await pharmacyRetailFixture(["MANAGE_ORGANIZATION"]);
    const forbidden = await f.adopt({ locationId: other.locationId }); expect([403, 404]).toContain(forbidden.statusCode);
  });
  it("creates an empty unapproved branch identity, with safe retry and concurrent adoption", async () => {
    const f = await fixture(), beforeLots = await MedicineBatch.countDocuments(), beforeMovements = await StockMovement.countDocuments();
    const responses = await Promise.all([f.adopt(), f.adopt()]);
    for (const response of responses) expect(response.statusCode, response.body).toBe(200);
    expect(responses[0].json().data.medicine.id).toBe(responses[1].json().data.medicine.id);
    const medicine = (await Medicine.findOne({ locationId: f.locationId, globalProductId: f.source._id }))!;
    expect(medicine).toMatchObject({ stockQuantity: 0, price: 1.29, globalProductRevision: 1, dispensingRevision: 0, taxRevision: 0 });
    expect(medicine.costPrice).toBeUndefined(); expect(medicine.batchNumber).toBeUndefined();
    expect(await MedicineBatch.countDocuments()).toBe(beforeLots); expect(await StockMovement.countDocuments()).toBe(beforeMovements);
    const retry = await f.adopt({ sellingPricePaise: 999 }); expect(retry.statusCode).toBe(200); expect(retry.json().data.medicine.price).toBe(1.29);
    expect(await AuditLog.countDocuments({ action: "PHARMACY_GLOBAL_PRODUCT_ADOPTED", targetId: medicine._id })).toBe(1);
  });
  it("rejects unconfirmed, stale, invalid conversion and injected inventory fields", async () => {
    const f = await fixture();
    for (const extra of [{ confirmedIdentity: false }, { stockQuantity: 10 }, { unitDefinition: { baseUnit: "tablet", packUnit: "strip", unitsPerPack: 0 } }, { sellingPricePaise: 1.3 }]) expect((await f.adopt(extra)).statusCode).toBe(400);
    expect((await f.adopt({ expectedRevision: 2 })).statusCode).toBe(409);
    expect(await Medicine.countDocuments({ locationId: f.locationId, globalProductId: f.source._id })).toBe(0);
    await PharmacyGlobalProduct.updateOne({ _id: f.source._id }, { $set: { active: false } });
    expect((await f.adopt()).statusCode).toBe(409);
  });
  it("releases update shared references, never a branch's identity, prices or stock", async () => {
    const f = await fixture(); expect((await f.adopt()).statusCode).toBe(200);
    const changed = { ...rights, release: "TEST-2", products: [{ ...f.identity, name: "Synthetic revised reference" }] };
    expect(await ingestReviewedCatalogue(changed, f.root.id, "c".repeat(64))).toEqual({ created: 0, updated: 1, unchanged: 0 });
    expect(await ingestReviewedCatalogue(changed, f.root.id, "c".repeat(64))).toEqual({ created: 0, updated: 0, unchanged: 1 });
    const medicine = (await Medicine.findOne({ locationId: f.locationId, globalProductId: f.source._id }))!;
    expect(medicine.name).toBe(f.identity.name); expect(medicine.price).toBe(1.29); expect(medicine.globalProductRevision).toBe(1);
  });
  it("requires review for existing barcode or exact identity and rolls back if audit cannot persist", async () => {
    const f = await fixture();
    const local = await Medicine.create({ locationId: f.locationId, name: "Other identity", genericName: "Other", price: 99, barcodes: f.identity.barcodes });
    expect((await f.adopt()).statusCode).toBe(409); expect((await Medicine.findById(local.id))!.price).toBe(99);
    await Medicine.deleteOne({ _id: local._id });
    const audit = vi.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("Synthetic audit failure"));
    const failed = await f.adopt(); expect(failed.statusCode).toBe(500); audit.mockRestore();
    expect(await Medicine.countDocuments({ locationId: f.locationId, globalProductId: f.source._id })).toBe(0);
  });
  it("paginates in stable source order and rejects cursors for a different query", async () => {
    const f = await fixture();
    await ingestReviewedCatalogue({ ...rights, products: Array.from({ length: 27 }, () => ({ ...product(), name: "Unique paging fixture" })) }, f.root.id, "d".repeat(64));
    const url = `/api/pharmacy/catalogue/global?locationId=${f.locationId}&search=unique`;
    const first = (await app.inject({ method: "GET", url, headers: f.headers })).json().data;
    expect(first.items).toHaveLength(25); expect(first.nextCursor).toBeTruthy();
    const second = (await app.inject({ method: "GET", url: `${url}&cursor=${first.nextCursor}`, headers: f.headers })).json().data;
    expect(second.items).toHaveLength(2); expect(second.nextCursor).toBeNull();
    const wrong = await app.inject({ method: "GET", url: `/api/pharmacy/catalogue/global?locationId=${f.locationId}&search=other&cursor=${first.nextCursor}`, headers: f.headers }); expect(wrong.statusCode).toBe(400);
  });
});
