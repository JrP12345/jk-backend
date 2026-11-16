import crypto from "node:crypto";
import mongoose from "mongoose";
import type { FastifyRequest } from "fastify";
import { PharmacyOfflineSnapshotPage } from "../models/PharmacyOfflineSnapshotPage.ts";
import { PharmacyOfflineAuthority } from "../models/PharmacyOfflineAuthority.ts";
import { PharmacyOfflineDevice } from "../models/PharmacyOfflineDevice.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { Location } from "../models/Location.ts";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { withTransaction } from "../utilities/transaction.ts";
import { createCapturedLotValidator } from "../utilities/pharmacyLot.ts";
import { normalizeUnitDefinition } from "../utilities/medicineCatalogue.ts";
import { SERVICE_PRIVATE_KEY } from "../utilities/keys.ts";
import { purchaseScope } from "./PharmacyPurchaseDraftService.ts";
import { pharmacyRequestAllows } from "./PharmacyCapabilityService.ts";
import { loadPharmacyIssuer, pricePharmacySupply, pharmacyDocumentSnapshot } from "./PharmacyDocumentService.ts";
import { PHARMACY_CALCULATION_ENGINE_SHA256, PHARMACY_CALCULATION_POLICY } from "./InvoiceCalculationService.ts";
import { CommandError } from "./CommandReceiptService.ts";
import { offlineReservationSigningKey } from "./PharmacyOfflineDeviceService.ts";
import { PHARMACY_OFFLINE_DOCUMENT_SHA256 } from "../utilities/pharmacyOfflineDocumentVersion.ts";

const PURPOSE = "ekavyu.pharmacy.prepared-stock.v1", PAGE_SIZE = 200, MAX_PRODUCTS = 10000, MAX_LOTS = 50000;
const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const validAuthority = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
function present(row: { page: number; payload: string; sha256: string; signature?: string | null; signingKeyId?: string | null; signingPublicKey?: unknown }) {
  return { page: row.page, payload: row.payload, sha256: row.sha256,
    ...(row.page === -1 ? { signature: row.signature, signingKey: { id: row.signingKeyId, jwk: row.signingPublicKey } } : {}) };
}
async function authorizedScope(req: FastifyRequest, locationId: string, authorityId: string) {
  if (!validAuthority(authorityId)) throw new CommandError(400, "Invalid original offline authority reference");
  const scope = await purchaseScope(req, locationId);
  const row = await PharmacyOfflineAuthority.findOne({ ...scope, authorityId });
  if (!row) throw new CommandError(404, "Offline preparation is not visible for this operator");
  return { scope, row };
}
/** Internal preparation only. Manifest explicitly cannot authorize final checkout.
 * No acquisition/preparation HTTP mutations exist until import/recovery is ready.
 */
export async function prepareOfflineAuthoritySnapshot(req: FastifyRequest, locationId: string, authorityId: string) {
  for (const action of ["sell", "collect", "manageSettings"] as const) if (!await pharmacyRequestAllows(req, action)) throw new CommandError(403, "Current branch settings, selling and collection authority are required");
  const { scope } = await authorizedScope(req, locationId, authorityId);
  const indexes = await PharmacyOfflineSnapshotPage.collection.listIndexes().toArray();
  if (!indexes.some(index => index.unique && Object.keys(index.key).length === 2 && index.key.authorityId === 1 && index.key.page === 1 && !index.sparse && !index.partialFilterExpression)) throw new CommandError(503, "Prepare unique offline snapshot indexes first");
  try {
    return await withTransaction(async session => {
      if (!session?.inTransaction()) throw new CommandError(503, "Consistent offline preparation requires transactions");
      const { row } = await authorizedScope(req, locationId, authorityId);
      const existing = await PharmacyOfflineSnapshotPage.findOne({ organizationId: scope.organizationId, locationId, authorityId, page: -1 }).lean();
      if (existing) return present(existing);
      const now = new Date(), grant = JSON.parse(row.payload);
      if (row.state !== "held" || row.checkoutActivatedAt || row.importedSequence !== row.firstSequence - 1 || row.validUntil <= now || row.inventoryMode !== "tracked" ||
          grant.checkoutEnabled !== false || grant.calculation?.sha256 !== PHARMACY_CALCULATION_ENGINE_SHA256 || grant.calculation?.documentSha256 !== PHARMACY_OFFLINE_DOCUMENT_SHA256) throw new CommandError(409, "Original stock-tracked preparation, time window or calculation version requires review");
      const device = await PharmacyOfflineDevice.findOne({ organizationId: scope.organizationId, locationId, deviceId: row.deviceId, enrollmentId: row.enrollmentId, status: "enrolled" });
      const actor = await User.findById(scope.actorId).select("authVersion isActive").lean();
      if (!device || !actor || actor.isActive === false || (actor.authVersion ?? 0) !== row.actorAuthVersion) throw new CommandError(403, "Original enrolled operator/device authorization changed");
      const pinnedDevice = await PharmacyOfflineDevice.updateOne({ _id: device._id, status: "enrolled", authorityRevision: device.authorityRevision }, { $set: { authorityRevision: device.authorityRevision + 1 } });
      if (pinnedDevice.modifiedCount !== 1) throw new CommandError(409, "Original device changed during preparation");
      const branch = await Location.findOneAndUpdate({ _id: locationId, organizationId: scope.organizationId, isActive: { $ne: false }, pharmacyOfflineOwner: authorityId,
        "pharmacyCapability.enabled": { $ne: false }, "pharmacyCapability.inventoryMode": { $ne: "billing_only" } }, { $inc: { __v: 1 } });
      const organization = branch?.timezone ? null : await Organization.findById(scope.organizationId).select("timezone").lean();
      if (!branch || (branch.timezone || organization?.timezone || "Asia/Kolkata") !== "Asia/Kolkata") throw new CommandError(409, "Owned India branch changed during preparation");
      const issuer = await loadPharmacyIssuer(scope.organizationId, locationId), validateLot = createCapturedLotValidator();
      const pages: Array<{ page: number; payload: string; sha256: string; recordIds: string[] }> = [], buffer: unknown[] = [];
      const flush = () => {
        if (!buffer.length) return;
        const payload = JSON.stringify({ version: 1, authorityId, page: pages.length, records: buffer });
        if (Buffer.byteLength(payload) > 1024 * 1024) throw new CommandError(409, "Prepared catalogue page exceeds its supported bound");
        pages.push({ page: pages.length, payload, sha256: hash(payload), recordIds: buffer.map(record => (record as { id: string }).id) }); buffer.length = 0;
      };
      const append = (record: unknown) => { buffer.push(record); if (buffer.length === PAGE_SIZE) flush(); };
      let cursor: mongoose.Types.ObjectId | undefined, scannedProducts = 0, productCount = 0, lotCount = 0, scannedLots = 0;
      while (true) {
        const products = await Medicine.find({ locationId, deletedAt: null, ...(cursor ? { _id: { $gt: cursor } } : {}) }).sort({ _id: 1 }).limit(PAGE_SIZE);
        if (!products.length) break;
        scannedProducts += products.length;
        if (scannedProducts > MAX_PRODUCTS) throw new CommandError(409, "Branch exceeds the reviewed 10,000-product offline preparation bound");
        const reviewed = products.filter(product => product.scheduleType === "general" && product.dispensingRevision >= 1 && product.dispensingReview?.scheduleType === "general" &&
          product.dispensingReview.confirmedBy && product.dispensingReview.confirmedAt && product.dispensingReview.reviewReference);
        const inventory = reviewed.length ? await MedicineBatch.find({ medicineId: { $in: reviewed.map(product => product._id) } }).sort({ expiryDate: 1, receivedAt: 1, _id: 1 }).limit(MAX_LOTS - scannedLots + 1) : [];
        scannedLots += inventory.length;
        if (scannedLots > MAX_LOTS) throw new CommandError(409, "Branch exceeds the reviewed 50,000-lot offline preparation bound");
        const byProduct = new Map<string, typeof inventory>();
        for (const lot of inventory) { const key = String(lot.medicineId), group = byProduct.get(key) || []; group.push(lot); byProduct.set(key, group); }
        for (const product of reviewed) {
          const lots = byProduct.get(String(product._id)) || [];
          if (!lots.length) { if (product.stockQuantity !== 0) throw new CommandError(409, "Product stock lacks captured lots; reconcile before preparing"); continue; }
          if (!product.unitDefinition || !Number.isSafeInteger(product.unitDefinition.version) || product.unitDefinition.version < 1) throw new CommandError(409, "Product units require review");
          const unitDefinition = normalizeUnitDefinition(product.unitDefinition, product.unitDefinition.version);
          if (lots.length > 5000 || lots.some(lot => lot.lotVersion !== 1 || String(lot.organizationId) !== scope.organizationId || String(lot.locationId) !== locationId || lot.expirySnapshot?.timezone !== "Asia/Kolkata")) throw new CommandError(409, "Offline stock requires owned captured India lots within the counter bound");
          for (const lot of lots) validateLot(lot, product.unitDefinition, scope.organizationId);
          if (!Number.isSafeInteger(product.stockQuantity) || product.stockQuantity < 0 || lots.reduce((total, lot) => total + BigInt(lot.quantity), 0n) !== BigInt(product.stockQuantity)) throw new CommandError(409, "Product and lot stock differ; reconcile before offline preparation");
          const eligible = lots.filter(lot => lot.status === "active" && lot.quantity > 0 && lot.expiryDate > now);
          if (!eligible.length) continue;
          const priced = pricePharmacySupply(product, eligible.map(lot => ({ quantity: lot.quantity, unitPrice: lot.sellingPrice, hsnCode: lot.hsnCode || "", gstRate: lot.gstRate })), issuer);
          if (!Number.isSafeInteger(product.stockRevision) || product.stockRevision < 0 || !Number.isSafeInteger(product.taxRevision) || product.taxRevision < 1 ||
              eligible.some(lot => !Number.isSafeInteger(lot.mrpPaise) || lot.sellingPricePaise! > lot.mrpPaise!)) throw new CommandError(409, "Reviewed product revisions and lot MRP are required");
          productCount++;
          append({ kind: "product", id: String(product._id), name: product.name, genericName: product.genericName, barcodes: [...(product.barcodes || [])], unitDefinition,
            stockQuantity: product.stockQuantity, availableQuantity: eligible.reduce((sum, lot) => sum + lot.quantity, 0),
            stockRevision: product.stockRevision, dispensingRevision: product.dispensingRevision, taxRevision: product.taxRevision,
            hsnSacCode: priced.hsnSacCode, unitCode: priced.unitCode, gstRateBps: Math.round(priced.gstRate * 100), classificationGstRateBps: Math.round(product.gstRate * 100), taxTreatment: priced.taxTreatment, taxReviewReference: priced.taxReviewReference });
          for (const lot of eligible) {
            lotCount++;
            append({ kind: "lot", id: String(lot._id), medicineId: String(product._id), quantity: lot.quantity, revision: 0, batchNumber: lot.batchNumber,
              expiryValue: lot.expirySnapshot!.value, expiryPrecision: lot.expirySnapshot!.precision === "day" ? "date" : "month", expiryCutoff: lot.expiryDate.toISOString(),
              sellingPricePaise: lot.sellingPricePaise, mrpPaise: lot.mrpPaise, hsnCode: lot.hsnCode, gstRateBps: Math.round(lot.gstRate! * 100) });
          }
        }
        cursor = products[products.length - 1]._id;
        if (products.length < PAGE_SIZE) break;
      }
      flush();
      const document = await pharmacyDocumentSnapshot(issuer, { name: "Walk-in customer", address: "", state: issuer.stateCode }, scope.actorId, now, []);
      const payload = JSON.stringify({ version: 1, purpose: PURPOSE, checkoutEnabled: false, ...scope, authorityId, deviceId: row.deviceId,
        enrollmentId: row.enrollmentId, inventoryMode: "tracked", calculation: grant.calculation, lease: grant.lease, drawer: grant.drawer,
        preparedAt: now.toISOString(), validUntil: row.validUntil.toISOString(), issuer: document.issuer, issuerRevision: issuer.revision, issuerReviewReference: issuer.reviewReference,
        products: productCount, lots: lotCount, pages: pages.map(page => ({ page: page.page, sha256: page.sha256 })) });
      const signing = offlineReservationSigningKey(), signature = crypto.sign("RSA-SHA256", Buffer.from(`${PURPOSE}\n${payload}`), SERVICE_PRIVATE_KEY).toString("base64url");
      const manifest = { page: -1, payload, sha256: hash(payload), signature, signingKeyId: signing.id, signingPublicKey: signing.jwk };
      if (pages.length) await PharmacyOfflineSnapshotPage.insertMany(pages.map(page => ({ organizationId: scope.organizationId, locationId, authorityId, ...page })), { ordered: true });
      const published = await PharmacyOfflineSnapshotPage.create({ organizationId: scope.organizationId, locationId, authorityId, ...manifest });
      const pinned = await PharmacyOfflineAuthority.updateOne({ _id: row._id, revision: row.revision, state: "held", checkoutActivatedAt: { $exists: false } }, { $inc: { revision: 1 } });
      if (pinned.modifiedCount !== 1) throw new CommandError(409, "Original ownership changed while preparing");
      await AuditLog.create({ userId: scope.actorId, organizationId: scope.organizationId, action: "PHARMACY_OFFLINE_STOCK_PREPARED", category: "BILLING", targetModel: "PharmacyOfflineAuthority", targetId: row._id,
        details: { authorityId, locationId, products: productCount, lots: lotCount, pages: pages.length, manifestDigest: manifest.sha256, checkoutEnabled: false, calculationPolicy: PHARMACY_CALCULATION_POLICY } });
      return present(published);
    }, { writeConcern: { w: "majority" } });
  } catch (failure) {
    if ((failure as { code?: number }).code !== 11000) throw failure;
    const existing = await PharmacyOfflineSnapshotPage.findOne({ organizationId: scope.organizationId, locationId, authorityId, page: -1 }).lean();
    if (existing) return present(existing);
    throw failure;
  }
}

export async function readOfflineSnapshotPage(req: FastifyRequest, locationId: string, authorityId: string, page: number) {
  if (!Number.isSafeInteger(page) || page < -1 || page > 500) throw new CommandError(400, "Invalid offline preparation page");
  if (!await pharmacyRequestAllows(req, "viewSales")) throw new CommandError(403, "Pharmacy history access is required");
  const { scope } = await authorizedScope(req, locationId, authorityId);
  const row = await PharmacyOfflineSnapshotPage.findOne({ organizationId: scope.organizationId, locationId, authorityId, page }).lean();
  if (!row) throw new CommandError(404, "Complete offline preparation is not available");
  return present(row);
}
