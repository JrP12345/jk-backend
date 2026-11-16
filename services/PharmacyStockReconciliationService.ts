import type { FastifyRequest } from "fastify";
import type { ClientSession } from "mongoose";
import { Location } from "../models/Location.ts";
import { offlineOwnerFilter } from "../utilities/pharmacyOfflineOwnership.ts";
import { Organization } from "../models/Organization.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { purchaseScope } from "./PharmacyPurchaseDraftService.ts";
import { pharmacyRequestAllows } from "./PharmacyCapabilityService.ts";
import { CommandError, commandHash, executeRecordedCommand } from "./CommandReceiptService.ts";
import { appendStockMovement, type StockAllocation } from "./PharmacyStockMovementService.ts";
import { requireReceiptIndexes } from "./PharmacyStockReceiptService.ts";
import { loadPharmacyIssuer } from "./PharmacyDocumentService.ts";
import { createWithSession, withTransaction } from "../utilities/transaction.ts";
import { requireStockTransaction, stockRevisionFilter } from "../utilities/pharmacyInventory.ts";
import { normalizeStockReceipt, receiptQuantity, lotExpiry, validateCapturedLot, type StockReceiptInput } from "../utilities/pharmacyLot.ts";
import { decryptField } from "../utilities/cryptoEnvelope.ts";
import { identifier } from "../schemas/pharmacyPurchases.ts";

const MAX_PRODUCTS = 20000, MAX_LOTS = 50000;
const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
type Count = { medicineId: string; lots: Array<{ batchId: string; quantity: number }>; newLots: StockReceiptInput[] };
type Input = { snapshotHash: string; reference: string; counts: Count[] };
async function authority(req: FastifyRequest, locationId: unknown) {
  const scope = await purchaseScope(req, locationId);
  for (const action of ["manageSettings", "adjustStock", "receiveStock", "viewCost"] as const)
    if (!await pharmacyRequestAllows(req, action)) throw new CommandError(403, "Branch settings, stock adjustment, receiving and cost-view permissions are required for reconciliation");
  return scope;
}
function input(raw: unknown, locationId: string): Input {
  const v = raw as Input;
  if (!v || Object.keys(v).some(k => !["snapshotHash", "reference", "counts"].includes(k)) || !/^[a-f\d]{64}$/.test(v.snapshotHash) || typeof v.reference !== "string" || v.reference.trim().length < 3 || v.reference.length > 120 || !Array.isArray(v.counts) || v.counts.length > MAX_PRODUCTS) throw new CommandError(400, "Provide the complete physical count, snapshot and count reference");
  let lotCount = 0;
  const counts = v.counts.map(row => {
    if (!row || Object.keys(row).some(k => !["medicineId", "lots", "newLots"].includes(k)) || !Array.isArray(row.lots) || !Array.isArray(row.newLots)) throw new CommandError(400, "Each counted product needs its existing and new lots");
    lotCount += row.lots.length + row.newLots.length;
    const medicineId = identifier(row.medicineId);
    const lots = row.lots.map(lot => {
      if (!lot || Object.keys(lot).some(k => !["batchId", "quantity"].includes(k)) || !whole(lot.quantity)) throw new CommandError(400, "Counted base quantities must be non-negative whole numbers");
      return { batchId: identifier(lot.batchId), quantity: lot.quantity };
    }).sort((a, b) => a.batchId.localeCompare(b.batchId));
    const newLots = row.newLots.map(normalizeStockReceipt).sort((a, b) => a.receiptLineId.localeCompare(b.receiptLineId));
    if (new Set(lots.map(lot => lot.batchId)).size !== lots.length || newLots.some(lot => lot.medicineId !== medicineId || lot.locationId !== locationId || lot.kind !== "receipt")) throw new CommandError(400, "Count lots must belong to their product and branch");
    return { medicineId, lots, newLots };
  }).sort((a, b) => a.medicineId.localeCompare(b.medicineId));
  const newIds = counts.flatMap(row => row.newLots.map(lot => lot.receiptLineId));
  if (lotCount > MAX_LOTS || new Set(counts.map(row => row.medicineId)).size !== counts.length || new Set(newIds).size !== newIds.length) throw new CommandError(400, "Count contains duplicate products/lot identities or exceeds the review bound");
  return { snapshotHash: v.snapshotHash, reference: v.reference.trim(), counts };
}
async function snapshot(scope: Awaited<ReturnType<typeof authority>>, session: ClientSession | null) {
  const branch = await Location.findOne({ _id: scope.locationId, organizationId: scope.organizationId, isActive: true }).session(session).lean();
  if (!branch) throw new CommandError(404, "Branch not found");
  if (branch.pharmacyCapability?.inventoryMode !== "billing_only" || branch.pharmacyCapability.enabled !== false) throw new CommandError(409, "Pause this billing-only branch in Pharmacy settings before counting. Keep it paused until reconciliation completes.");
  const products = await Medicine.find({ locationId: scope.locationId }).select("locationId name deletedAt stockQuantity stockRevision stockLedgerStartedAt unitDefinition price billingSupply hsnCode gstRate __v updatedAt").sort({ _id: 1 }).limit(MAX_PRODUCTS + 1).session(session).lean();
  const lots = await MedicineBatch.find({ locationId: scope.locationId }).sort({ _id: 1 }).limit(MAX_LOTS + 1).session(session).lean();
  if (products.length > MAX_PRODUCTS || lots.length > MAX_LOTS) throw new CommandError(409, "Branch exceeds the 20,000-product / 50,000-lot reconciliation bound; request a reviewed count in sections");
  const productIds = new Set(products.map(row => String(row._id)));
  if (lots.some(lot => !productIds.has(String(lot.medicineId)))) throw new CommandError(409, "Orphan batch ownership needs inventory review before counting");
  const grouped = new Map<string, typeof lots>();
  for (const lot of lots) { const id = String(lot.medicineId); const rows = grouped.get(id) || []; rows.push(lot); grouped.set(id, rows); }
  const rows = products.map(product => {
    const batches = grouped.get(String(product._id)) || [];
    if (!whole(product.stockQuantity) || !whole(product.stockRevision) || batches.reduce((sum, lot) => sum + lot.quantity, 0) !== product.stockQuantity) throw new CommandError(409, `${product.name}: existing lot and aggregate balances need inventory review`);
    for (const lot of batches) {
      if (lot.lotVersion !== 1 || !["active", "depleted", "expired", "quarantined"].includes(lot.status)) throw new CommandError(409, `${product.name}: batch evidence needs inventory review`);
      validateCapturedLot(lot, product.unitDefinition, scope.organizationId);
    }
    return { id: String(product._id), name: product.name, archived: Boolean(product.deletedAt), quantity: product.stockQuantity, revision: product.stockRevision,
      unit: product.unitDefinition || null, pricePaise: Math.round(product.price * 100), billingSupply: product.billingSupply || null,
      lots: batches.map(lot => ({ id: String(lot._id), batchNumber: lot.batchNumber, expiry: { precision: lot.expirySnapshot!.precision, value: lot.expirySnapshot!.value }, quantity: lot.quantity, status: lot.status })) };
  });
  // Full owned evidence, not a timestamp alone: catalogue additions, lot corrections,
  // price/unit edits, resumed sales or settings changes invalidate a prepared count.
  const hash = commandHash({ branch, products, lots });
  return { branch, products, grouped, hash, data: { locationId: scope.locationId, snapshotHash: hash, revision: branch.pharmacyCapability.revision, products: rows } };
}
function prepare(state: Awaited<ReturnType<typeof snapshot>>, value: Input, scope: Awaited<ReturnType<typeof authority>>, timezone: string) {
  if (state.hash !== value.snapshotHash) throw new CommandError(409, "Branch data changed since counting began. Reload, recount and preview again.", { code: "COUNT_SNAPSHOT_CHANGED" });
  if (value.counts.length !== state.products.length) throw new CommandError(400, "Count every product and every existing lot, including zero counts");
  const counts = new Map(value.counts.map(row => [row.medicineId, row]));
  const changes = state.products.map(product => {
    const row = counts.get(String(product._id)), lots = state.grouped.get(String(product._id)) || [];
    const quantities = new Map(row?.lots.map(lot => [lot.batchId, lot.quantity]));
    if (!row || quantities.size !== lots.length || lots.some(lot => !quantities.has(String(lot._id)))) throw new CommandError(400, "Every existing owned lot must be explicitly counted once");
    if (product.deletedAt && row.newLots.length) throw new CommandError(409, "Restore an archived product before recording newly counted lots");
    const existing = lots.map(lot => {
      const quantity = quantities.get(String(lot._id))!;
      if (lot.status === "quarantined" && quantity > lot.quantity) throw new CommandError(409, "Quarantined return stock cannot increase or become saleable through reconciliation");
      return { lot, quantity };
    });
    const added = row.newLots.map(lot => {
      if (!product.unitDefinition) throw new CommandError(409, "Configure product units before recording counted lots");
      const quantity = receiptQuantity(lot, product.unitDefinition), expiry = lotExpiry(lot.expiry, timezone);
      if (lot.mrpPaise === undefined) throw new CommandError(400, "Record actual MRP for each newly counted batch");
      return { input: lot, quantity, expiry };
    });
    const quantity = existing.reduce((sum, lot) => sum + lot.quantity, 0) + added.reduce((sum, lot) => sum + lot.quantity, 0);
    if (!whole(quantity)) throw new CommandError(400, "Count exceeds safe quantity limits");
    return { product, existing, added, quantity, changed: added.length > 0 || existing.some(lot => lot.quantity !== lot.lot.quantity) };
  });
  const summary = { products: changes.length, changedProducts: changes.filter(row => row.changed).length,
    beforeUnits: changes.reduce((sum, row) => sum + row.product.stockQuantity, 0), countedUnits: changes.reduce((sum, row) => sum + row.quantity, 0),
    newLots: changes.reduce((sum, row) => sum + row.added.length, 0) };
  if (!whole(summary.beforeUnits) || !whole(summary.countedUnits)) throw new CommandError(400, "Branch totals exceed safe quantity limits");
  return { changes, summary };
}
export async function getStockReconciliation(req: FastifyRequest, locationId: string) {
  const scope = await authority(req, locationId);
  return withTransaction(async session => { requireStockTransaction(session); return (await snapshot(scope, session)).data; });
}
export async function previewStockReconciliation(req: FastifyRequest, locationId: string) {
  const scope = await authority(req, locationId), value = input(req.body, scope.locationId);
  return withTransaction(async session => {
    requireStockTransaction(session);
    const state = await snapshot(scope, session), org = await Organization.findById(scope.organizationId).session(session).lean();
    const prepared = prepare(state, value, scope, state.branch.timezone || org?.timezone || "Asia/Kolkata");
    return { ...prepared.summary, locationId, previewHash: commandHash({ actorId: scope.actorId, ...value }) };
  });
}
const operationScope = (org: string, branch: string) => `pharmacy-stock-reconciliation:${org}:${branch}`;
export async function recoverStockReconciliation(req: FastifyRequest, locationId: string, key: string) {
  const scope = await authority(req, locationId);
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(400, "Invalid reconciliation reference");
  const receipt = await OperationReceipt.findOne({ scope: operationScope(scope.organizationId, locationId), key }).select("+responseCiphertext").lean();
  if (!receipt?.responseCiphertext || String(receipt.resultId) !== locationId) throw new CommandError(404, "No committed count is visible. Keep the original reference.");
  const saved = JSON.parse(decryptField(receipt.responseCiphertext));
  if (saved.actorId !== scope.actorId || saved.data?.requestKey !== key || saved.data?.locationId !== locationId) throw new CommandError(404, "No committed count is visible for this operator");
  return saved.data;
}
export async function commitStockReconciliation(req: FastifyRequest, locationId: string) {
  const scope = await authority(req, locationId), raw = req.body as Input & { previewHash?: string; confirmed?: boolean };
  if (!raw || raw.confirmed !== true || !/^[a-f\d]{64}$/.test(raw.previewHash || "")) throw new CommandError(400, "Preview and explicitly confirm the physical count before enabling tracking");
  const { previewHash, confirmed: _, ...fields } = raw, value = input(fields, locationId);
  if (previewHash !== commandHash({ actorId: scope.actorId, ...value })) throw new CommandError(409, "Count differs from its preview. Preview again.");
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string") throw new CommandError(428, "Keep a stable reconciliation reference");
  const firstNew = value.counts.flatMap(row => row.newLots)[0];
  if (firstNew && !await OperationReceipt.exists({ scope: operationScope(scope.organizationId, locationId), key })) await requireReceiptIndexes(firstNew);
  const command = await executeRecordedCommand(operationScope(scope.organizationId, locationId), key, { actorId: scope.actorId, ...value }, () => withTransaction(async session => {
    requireStockTransaction(session);
    const state = await snapshot(scope, session), org = await Organization.findById(scope.organizationId).session(session).lean();
    if (org?.currency !== "INR" || org.countryCode !== "IN") throw new CommandError(409, "Physical counts require an India/INR branch");
    await loadPharmacyIssuer(scope.organizationId, locationId);
    const { changes, summary } = prepare(state, value, scope, state.branch.timezone || org.timezone || "Asia/Kolkata");
    const at = new Date();
    for (const row of changes) {
      if (!row.changed) continue;
      const allocations: StockAllocation[] = [];
      for (const { lot, quantity } of row.existing) {
        if (quantity === lot.quantity) continue;
        const status = lot.status === "quarantined" ? "quarantined" : quantity === 0 ? "depleted" : lot.expiryDate <= at ? "expired" : "active";
        const changed = await MedicineBatch.updateOne({ _id: lot._id, locationId, medicineId: row.product._id, quantity: lot.quantity, status: lot.status }, { $set: { quantity, status } }, { session });
        if (changed.matchedCount !== 1) throw new CommandError(409, "A counted batch changed. Reload and recount.");
        allocations.push({ batchId: lot._id, beforeQuantity: lot.quantity, afterQuantity: quantity, quantityDelta: quantity - lot.quantity });
      }
      for (const added of row.added) {
        const lot = added.input, quantity = added.quantity;
        const created = await createWithSession<InstanceType<typeof MedicineBatch>>(MedicineBatch, { organizationId: scope.organizationId, locationId, medicineId: row.product._id,
          lotVersion: 1, receiptLineId: lot.receiptLineId, receiptKind: "receipt", receivedAt: at, receivedQuantity: quantity,
          unitSnapshot: row.product.unitDefinition, costBasis: { totalPaise: lot.purchaseTotalPaise, receivedBaseUnits: quantity, currency: "INR" },
          sellingPricePaise: lot.sellingPricePaise, mrpPaise: lot.mrpPaise, purchaseCost: lot.purchaseTotalPaise / quantity / 100, sellingPrice: lot.sellingPricePaise / 100, mrp: lot.mrpPaise! / 100,
          expirySnapshot: added.expiry, expiryDate: added.expiry.cutoff, batchNumber: lot.batchNumber, hsnCode: row.product.hsnCode, gstRate: row.product.gstRate, quantity, status: added.expiry.cutoff <= at ? "expired" : "active",
        }, session);
        allocations.push({ batchId: created._id, beforeQuantity: 0, afterQuantity: quantity, quantityDelta: quantity });
      }
      const changed = await Medicine.updateOne({ _id: row.product._id, locationId, stockQuantity: row.product.stockQuantity, ...stockRevisionFilter(row.product.stockRevision) },
        { $set: { stockQuantity: row.quantity, stockLedgerStartedAt: row.product.stockLedgerStartedAt || at }, $inc: { stockRevision: 1 } }, { session });
      if (changed.matchedCount !== 1) throw new CommandError(409, "A counted product changed. Reload and recount.");
      await appendStockMovement(row.product, "adjustment", row.quantity, allocations, session, { reason: "physical_audit", notes: value.reference, actorId: scope.actorId, clientRequestId: key });
    }
    const revision = state.branch.pharmacyCapability!.revision + 1;
    const branch = await Location.updateOne({ _id: locationId, ...offlineOwnerFilter(locationId), organizationId: scope.organizationId, isActive: true, "pharmacyCapability.enabled": false, "pharmacyCapability.inventoryMode": "billing_only", "pharmacyCapability.revision": revision - 1, __v: state.branch.__v },
      { $set: { pharmacyCapability: { enabled: true, inventoryMode: "tracked", revision, reviewReference: value.reference, confirmedBy: scope.actorId, confirmedAt: at } }, $inc: { __v: 1 } }, { session });
    if (branch.matchedCount !== 1) throw new CommandError(409, "Branch activity changed during counting. Reload and recount.");
    await createWithSession(AuditLog, { userId: scope.actorId, organizationId: scope.organizationId, category: "ADMIN", action: "PHARMACY_STOCK_RECONCILED", targetModel: "Location", targetId: locationId, details: { ...summary, reference: value.reference, snapshotHash: value.snapshotHash, revision } }, session);
    const data = { locationId, requestKey: key, inventoryMode: "tracked", revision, ...summary };
    await OperationReceipt.updateOne({ scope: operationScope(scope.organizationId, locationId), key }, { $set: { responseCiphertext: JSON.stringify({ actorId: scope.actorId, data }) } }).session(session);
    return locationId;
  }), { writeConcern: { w: "majority" } });
  return { ...await recoverStockReconciliation(req, locationId, key), replayed: command.replayed };
}
