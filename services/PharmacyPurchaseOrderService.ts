import mongoose from "mongoose";
import type { FastifyRequest } from "fastify";
import { PharmacyPurchaseOrder } from "../models/PharmacyPurchaseOrder.ts";
import { PharmacyPurchase } from "../models/PharmacyPurchase.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { Medicine } from "../models/Medicine.ts";
import { Location } from "../models/Location.ts";
import { Organization } from "../models/Organization.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { purchaseOrderInput, purchaseOrderAction } from "../schemas/pharmacyPurchaseOrders.ts";
import { identifier, object, text } from "../schemas/pharmacyPurchases.ts";
import { purchaseScope } from "./PharmacyPurchaseDraftService.ts";
import { CommandError, executeRecordedCommand } from "./CommandReceiptService.ts";
import { createWithSession, withTransaction } from "../utilities/transaction.ts";
import { requireStockTransaction } from "../utilities/pharmacyInventory.ts";
import { normalizeUnitDefinition } from "../utilities/medicineCatalogue.ts";
import { locationDateKey, getLocationTimezone } from "../utilities/locationTime.ts";
import { escapeRegex } from "../utilities/helpers.ts";

const dto = (row: any) => { const { _id, __v: _version, normalizedReference: _normalized, supplierAccess: _access, documents: _documents, supplierEmail: _email, ...rest } = row.toObject ? row.toObject() : row; return { ...rest, id: String(_id) }; };
const requestKey = (req: FastifyRequest) => { const value = req.headers["idempotency-key"]; if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(value)) throw new CommandError(428, "Keep a stable Idempotency-Key for each order command"); return value; };
type Scope = Awaited<ReturnType<typeof purchaseScope>>;
async function activeBranch(scope: Scope, session: mongoose.ClientSession) {
  // Ordering changes no inventory; the original offline stock owner may continue billing.
  const branch = await Location.findOneAndUpdate({ _id: scope.locationId, organizationId: scope.organizationId, isActive: { $ne: false }, "pharmacyCapability.enabled": { $ne: false } }, { $inc: { __v: 1 } }, { session, returnDocument: "after", timestamps: false });
  if (!branch) throw new CommandError(409, "An active pharmacy branch is required for ordering");
  return branch;
}
async function ownedOrder(scope: Scope, id: string, session: mongoose.ClientSession | null = null) {
  const row = await PharmacyPurchaseOrder.findOne({ _id: identifier(id), organizationId: scope.organizationId, locationId: scope.locationId }).session(session);
  if (!row) throw new CommandError(404, "Order not found at this branch"); return row;
}
const add = (a: number, b: number) => { const value = a + b; if (!Number.isSafeInteger(value) || value < 0) throw new CommandError(409, "Order quantity reconciliation needs review"); return value; };
function comparison(order: any, purchases: any[]) {
  const rows = order.lines.map((line: any) => ({ lineId: line.lineId, medicineId: String(line.medicineId), name: line.medicineSnapshot.name, baseUnit: line.unitSnapshot.baseUnit,
    ordered: line.quantity, accepted: order.response?.lines.find((row: any) => row.lineId === line.lineId)?.acceptedQuantity ?? null, invoiced: 0, received: 0 }));
  const byProduct = new Map<string, typeof rows[number]>(rows.map((row: any) => [row.medicineId, row]));
  for (const purchase of purchases) for (const line of purchase.lines) {
    const row = byProduct.get(String(line.medicineId)), source = order.lines.find((value: any) => String(value.medicineId) === String(line.medicineId));
    if (!row || !source || line.unitSnapshot?.version !== source.unitSnapshot.version || line.unitSnapshot.baseUnit !== source.unitSnapshot.baseUnit || line.unitSnapshot.packUnit !== source.unitSnapshot.packUnit || line.unitSnapshot.unitsPerPack !== source.unitSnapshot.unitsPerPack) throw new CommandError(409, "Invoice products/units differ from the exact order; review substituted goods separately");
    row.invoiced = add(row.invoiced, add(line.billedBaseUnits, line.freeBaseUnits));
    const progress = purchase.receiptProgress?.find((value: any) => value.lineId === line.lineId);
    if (!progress) throw new CommandError(409, "Posted invoice receiving evidence is incomplete");
    row.received = add(row.received, add(progress.billedBaseUnits, progress.freeBaseUnits));
  }
  return rows.map((row: any) => ({ ...row, pendingInvoice: Math.max(0, (row.accepted ?? row.ordered) - row.invoiced), pendingReceipt: Math.max(0, row.invoiced - row.received),
    shortAccepted: row.accepted === null ? null : Math.max(0, row.ordered - row.accepted), overInvoiced: Math.max(0, row.invoiced - (row.accepted ?? row.ordered)) }));
}
async function linkedPurchases(scope: Scope, orderId: mongoose.Types.ObjectId, session: mongoose.ClientSession | null = null) {
  const rows = await PharmacyPurchase.find({ organizationId: scope.organizationId, locationId: scope.locationId, purchaseOrderId: orderId, status: "posted" }).select("supplierInvoiceNumber supplierId lines receiptProgress posting.payablePaise receiptCount revision").sort({ _id: 1 }).limit(51).maxTimeMS(5000).session(session).lean();
  if (rows.length > 50) throw new CommandError(409, "Order invoice bound needs review"); return rows;
}
function status(order: any, rows: any[], invoiceCount: number) {
  if (["cancelled", "draft", "rejected", "closed"].includes(order.state)) return order.state;
  if (invoiceCount) {
    if (rows.every(row => row.pendingReceipt === 0 && row.pendingInvoice === 0)) return "received";
    if (rows.some(row => row.received > 0)) return "partially_received";
    return "billed";
  }
  return order.state;
}
async function present(scope: Scope, order: any) {
  const purchases = await linkedPurchases(scope, order._id), rows = comparison(order, purchases);
  return { ...dto(order), status: status(order, rows, purchases.length), comparison: rows,
    invoices: purchases.map(row => ({ id: String(row._id), number: row.supplierInvoiceNumber, payablePaise: row.posting?.payablePaise, receiptCount: row.receiptCount, revision: row.revision })) };
}
export async function supplierOrderProgress(order: any) {
  const purchases = await linkedPurchases({ organizationId: String(order.organizationId), locationId: String(order.locationId), actorId: "" }, order._id), rows = comparison(order, purchases);
  return { status: status(order, rows, purchases.length), quantities: rows.map((row: any) => ({ lineId: row.lineId, invoiced: row.invoiced, received: row.received })) };
}
/** One tenant-scoped read for the whole page; never fetch every invoice document or query per order. */
async function listStatuses(scope: Scope, orders: any[]) {
  const linked = orders.filter(order => order.invoiceCount > 0);
  const totals = linked.length ? await PharmacyPurchase.aggregate<{ _id: { orderId: mongoose.Types.ObjectId; medicineId: mongoose.Types.ObjectId }; invoiced: number; received: number; missingEvidence: number }>([
    { $match: { organizationId: new mongoose.Types.ObjectId(scope.organizationId), locationId: new mongoose.Types.ObjectId(scope.locationId), purchaseOrderId: { $in: linked.map(order => order._id) }, status: "posted" } },
    { $project: { purchaseOrderId: 1, lines: { lineId: 1, medicineId: 1, billedBaseUnits: 1, freeBaseUnits: 1 }, receiptProgress: 1 } },
    { $unwind: "$lines" },
    { $set: { progress: { $arrayElemAt: [{ $filter: { input: { $ifNull: ["$receiptProgress", []] }, as: "progress", cond: { $eq: ["$$progress.lineId", "$lines.lineId"] } } }, 0] } } },
    { $group: { _id: { orderId: "$purchaseOrderId", medicineId: "$lines.medicineId" }, invoiced: { $sum: { $add: ["$lines.billedBaseUnits", "$lines.freeBaseUnits"] } },
      received: { $sum: { $add: ["$progress.billedBaseUnits", "$progress.freeBaseUnits"] } }, missingEvidence: { $sum: { $cond: [{ $eq: [{ $type: "$progress" }, "missing"] }, 1, 0] } } } },
  ]).option({ maxTimeMS: 5000 }) : [];
  const byOrder = new Map<string, Map<string, typeof totals[number]>>();
  for (const total of totals) {
    if (total.missingEvidence || !Number.isSafeInteger(total.invoiced) || !Number.isSafeInteger(total.received) || total.received < 0 || total.received > total.invoiced) throw new CommandError(409, "Order receiving evidence needs review");
    const id = String(total._id.orderId), products = byOrder.get(id) || new Map(); products.set(String(total._id.medicineId), total); byOrder.set(id, products);
  }
  return orders.map(order => {
    const products = byOrder.get(String(order._id));
    if (order.invoiceCount && !products?.size) throw new CommandError(409, "Linked order invoices need review");
    const progress = order.lines.map((line: any) => {
      const total = products?.get(String(line.medicineId)), expected = order.response?.lines.find((response: any) => response.lineId === line.lineId)?.acceptedQuantity ?? line.quantity;
      return { received: total?.received || 0, pendingReceipt: Math.max(0, (total?.invoiced || 0) - (total?.received || 0)), pendingInvoice: Math.max(0, expected - (total?.invoiced || 0)) };
    });
    const { lines: _lines, response: _response, ...summary } = dto(order);
    return { ...summary, status: status(order, progress, order.invoiceCount) };
  });
}
export async function listPurchaseOrders(req: FastifyRequest) {
  const query = object(req.query, ["locationId", "supplierId", "search", "cursor", "organizationId", "organization_id"]), scope = await purchaseScope(req, query.locationId);
  const search = query.search ? text(query.search, "search", 1, 100) : "";
  const rows = await PharmacyPurchaseOrder.find({ organizationId: scope.organizationId, locationId: scope.locationId,
    ...(query.supplierId ? { supplierId: identifier(query.supplierId) } : {}), ...(query.cursor ? { _id: { $lt: identifier(query.cursor) } } : {}),
    ...(search ? { $or: [{ reference: { $regex: escapeRegex(search), $options: "i" } }, { "supplierSnapshot.name": { $regex: escapeRegex(search), $options: "i" } }] } : {}) })
    .select("reference supplierId supplierSnapshot.name state revision createdAt invoiceCount lines.lineId lines.medicineId lines.quantity response.lines.lineId response.lines.acceptedQuantity").sort({ _id: -1 }).limit(26).maxTimeMS(5000).lean();
  return { items: await listStatuses(scope, rows.slice(0, 25)), nextCursor: rows.length > 25 ? String(rows[24]._id) : null };
}
export async function readPurchaseOrder(req: FastifyRequest, id: string) {
  const query = object(req.query, ["locationId", "organizationId", "organization_id"]), scope = await purchaseScope(req, query.locationId);
  return present(scope, await ownedOrder(scope, id));
}
export async function recoverPurchaseOrder(req: FastifyRequest, key: string) {
  const query = object(req.query, ["locationId", "kind", "orderId", "organizationId", "organization_id"]), scope = await purchaseScope(req, query.locationId);
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key) || !["save", "action"].includes(query.kind)) throw new CommandError(400, "Invalid original order command");
  const commandScope = query.kind === "save" ? `pharmacy-order-save:${scope.organizationId}:${scope.locationId}` : `pharmacy-order-action:${scope.organizationId}:${scope.locationId}:${identifier(query.orderId)}`;
  const prior = await OperationReceipt.findOne({ scope: commandScope, key }).select("resultId").lean();
  if (!prior?.resultId) throw new CommandError(404, "No committed order result is visible for this original reference");
  return present(scope, await ownedOrder(scope, String(prior.resultId)));
}
export async function purchaseOrderHistory(req: FastifyRequest, id: string) {
  const query = object(req.query, ["locationId", "cursor", "organizationId", "organization_id"]), scope = await purchaseScope(req, query.locationId);
  await ownedOrder(scope, id);
  const rows = await AuditLog.find({ organizationId: scope.organizationId, targetModel: "PharmacyPurchaseOrder", targetId: identifier(id), ...(query.cursor ? { _id: { $lt: identifier(query.cursor) } } : {}) })
    .select("action createdAt userId details").sort({ _id: -1 }).limit(26).maxTimeMS(5000).lean();
  return { items: rows.slice(0, 25).map(dto), nextCursor: rows.length > 25 ? String(rows[24]._id) : null };
}
export async function savePurchaseOrder(req: FastifyRequest, id?: string) {
  const input = purchaseOrderInput(req.body, Boolean(id)), scope = await purchaseScope(req, input.locationId);
  const command = await executeRecordedCommand(`pharmacy-order-save:${scope.organizationId}:${scope.locationId}`, requestKey(req), { id: id || null, actorId: scope.actorId, ...input }, () => withTransaction(async session => {
    requireStockTransaction(session);
    const branch = await activeBranch(scope, session!), organization = await Organization.findById(scope.organizationId).select("name currency countryCode").session(session);
    if (organization?.countryCode !== "IN" || organization.currency !== "INR") throw new CommandError(409, "Ordering currently requires an India/INR organization");
    const prior = id ? await ownedOrder(scope, id, session) : null;
    if (prior && (prior.state !== "draft" || prior.revision !== input.expectedRevision)) throw new CommandError(409, "Order changed or was sent; reload before editing");
    const supplier = await PharmacyParty.findOne({ _id: input.supplierId, organizationId: scope.organizationId, locationIds: scope.locationId }).session(session);
    const today = locationDateKey(new Date(), await getLocationTimezone(scope.locationId));
    if (!supplier || supplier.archived || !supplier.kinds.includes("supplier") || !supplier.licence?.number || supplier.licence.validUntil && supplier.licence.validUntil < today || supplier.revision !== input.expectedSupplierRevision) throw new CommandError(409, "Select a current active supplier with recorded licence details");
    await PharmacyParty.updateOne({ _id: supplier._id, revision: supplier.revision }, { $inc: { __v: 1 } }, { session, timestamps: false });
    const products = await Medicine.find({ _id: { $in: input.lines.map(line => line.medicineId) }, locationId: scope.locationId, deletedAt: null }).session(session);
    const lines = input.lines.map(line => {
      const product = products.find(row => String(row._id) === line.medicineId), unit = product?.unitDefinition;
      if (!product || !unit || unit.version !== line.expectedUnitVersion || product.saleControl?.blocked) throw new CommandError(409, "A product, its sale hold or units changed; review before ordering");
      normalizeUnitDefinition(unit, unit.version);
      const quantity = line.packs * unit.unitsPerPack + line.looseUnits;
      if (line.looseUnits >= unit.unitsPerPack || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1_000_000_000) throw new CommandError(400, "Use positive bounded quantities, with loose units smaller than one pack");
      return { lineId: line.lineId, medicineId: product._id, packs: line.packs, looseUnits: line.looseUnits, quantity,
        medicineSnapshot: { name: product.name, genericName: product.genericName, strength: product.strength, manufacturer: product.manufacturer },
        unitSnapshot: { version: unit.version, baseUnit: unit.baseUnit, packUnit: unit.packUnit, unitsPerPack: unit.unitsPerPack } };
    });
    const resultId = prior?._id || new mongoose.Types.ObjectId(), reference = input.reference || `PO-${resultId}`;
    if (await PharmacyPurchaseOrder.exists({ organizationId: scope.organizationId, locationId: scope.locationId, normalizedReference: reference.normalize("NFKC").toUpperCase(), _id: { $ne: resultId } }).session(session)) throw new CommandError(409, "This order reference already exists at this branch");
    const values = { reference, normalizedReference: reference.normalize("NFKC").toUpperCase(), supplierId: supplier._id,
      supplierSnapshot: { partyId: supplier._id, revision: supplier.revision, name: supplier.name, address: supplier.address, phone: supplier.phone, email: supplier.email, gstRegistration: supplier.gstRegistration, gstin: supplier.gstin, licence: supplier.licence },
      buyerSnapshot: { name: organization.name, branch: branch.name, address: branch.address || "" }, lines, notes: input.notes, updatedBy: scope.actorId };
    const saved = prior ? await PharmacyPurchaseOrder.findOneAndUpdate({ _id: prior._id, organizationId: scope.organizationId, locationId: scope.locationId, state: "draft", revision: input.expectedRevision }, { $set: values, $inc: { revision: 1 } }, { session, runValidators: true, returnDocument: "after" })
      : await createWithSession(PharmacyPurchaseOrder, { _id: resultId, ...scope, ...values, createdBy: scope.actorId }, session);
    if (!saved) throw new CommandError(409, "Order changed; reload before saving");
    await createWithSession(AuditLog, { organizationId: scope.organizationId, userId: scope.actorId, action: "PHARMACY_ORDER_SAVED", category: "BILLING", targetModel: "PharmacyPurchaseOrder", targetId: resultId,
      details: { reference, revision: saved.revision, supplierId: input.supplierId, lines, notes: input.notes, stockChanged: false } }, session);
    return String(resultId);
  }), { writeConcern: { w: "majority" } });
  return { ...await present(scope, await ownedOrder(scope, command.resultId)), replayed: command.replayed };
}
export async function actOnPurchaseOrder(req: FastifyRequest, id: string) {
  const input = purchaseOrderAction(req.body), scope = await purchaseScope(req, input.locationId);
  const command = await executeRecordedCommand(`pharmacy-order-action:${scope.organizationId}:${scope.locationId}:${identifier(id)}`, requestKey(req), { actorId: scope.actorId, ...input }, () => withTransaction(async session => {
    requireStockTransaction(session); await activeBranch(scope, session!);
    const row = await ownedOrder(scope, id, session);
    if (row.revision !== input.expectedRevision) throw new CommandError(409, "Order changed; reopen its current revision before continuing");
    const now = new Date(), evidence = { reference: input.reference, recordedAt: now, recordedBy: scope.actorId };
    const changes: Record<string, unknown> = { updatedBy: scope.actorId };
    if (input.action === "submit") {
      if (row.state !== "draft") throw new CommandError(409, "Only a saved draft can be recorded as sent");
      const supplier = await PharmacyParty.findOne({ _id: row.supplierId, organizationId: scope.organizationId, locationIds: scope.locationId }).session(session);
      if (!supplier || supplier.archived || supplier.revision !== row.supplierSnapshot.revision || !supplier.licence?.number || supplier.licence.validUntil && supplier.licence.validUntil < locationDateKey(now, await getLocationTimezone(scope.locationId))) throw new CommandError(409, "Supplier changed or its licence needs review; save a refreshed draft before sending");
      await PharmacyParty.updateOne({ _id: supplier._id }, { $inc: { __v: 1 } }, { session, timestamps: false });
      const products = await Medicine.find({ _id: { $in: row.lines.map(line => line.medicineId) }, locationId: scope.locationId, deletedAt: null, "saleControl.blocked": { $ne: true } }).select("unitDefinition").session(session);
      if (products.length !== row.lines.length || row.lines.some(line => !products.some(product => String(product._id) === String(line.medicineId) && product.unitDefinition?.version === line.unitSnapshot?.version))) throw new CommandError(409, "Products or units changed; review a refreshed draft before sending");
      const pinned = await Medicine.updateMany({ _id: { $in: products.map(product => product._id) }, locationId: scope.locationId, deletedAt: null, "saleControl.blocked": { $ne: true } }, { $inc: { __v: 1 } }, { session, timestamps: false });
      if (pinned.matchedCount !== row.lines.length) throw new CommandError(409, "Order products changed while recording dispatch to the supplier");
      changes.state = "submitted"; changes.sent = { ...evidence, channel: input.channel };
    } else if (input.action === "respond" || input.action === "dispatch") {
      Object.assign(changes, supplierOrderChanges(row, input, evidence));
    } else if (input.action === "cancel") {
      if (["cancelled", "closed"].includes(row.state) || row.invoiceCount) throw new CommandError(409, "Linked supplier invoices must be resolved through the existing purchase/returns workflow");
      changes.state = "cancelled";
    } else if (input.action === "close_remainder") {
      const purchases = await linkedPurchases(scope, row._id, session), rows = comparison(row, purchases);
      if (["draft", "cancelled", "closed"].includes(row.state) || !purchases.length || rows.some((line: any) => line.pendingReceipt > 0) || !rows.some((line: any) => line.pendingInvoice > 0)) throw new CommandError(409, "Receive all linked invoices and verify an actual unfilled remainder before closing it");
      changes.state = "closed"; changes.closure = evidence;
    } else {
      if (["draft", "cancelled", "rejected", "closed"].includes(row.state) || row.invoiceCount >= 50) throw new CommandError(409, "Link invoices only to an open sent order, at most 50 invoices per order");
      const purchase = await PharmacyPurchase.findOne({ _id: input.purchaseId, organizationId: scope.organizationId, locationId: scope.locationId, supplierId: row.supplierId, status: "posted", purchaseOrderId: { $exists: false } }).session(session);
      if (!purchase) throw new CommandError(409, "Choose an unlinked posted invoice from this exact branch and supplier");
      const purchases = await linkedPurchases(scope, row._id, session), rows = comparison(row, [...purchases, purchase]);
      if (rows.some((line: any) => line.overInvoiced > 0) && !input.confirmVariance) throw new CommandError(409, "Invoice exceeds ordered/accepted quantities. Review and explicitly confirm that variance before linking");
      const pinned = await PharmacyPurchase.updateOne({ _id: purchase._id, organizationId: scope.organizationId, locationId: scope.locationId, supplierId: row.supplierId, status: "posted", purchaseOrderId: { $exists: false } }, { $set: { purchaseOrderId: row._id } }, { session, runValidators: true, timestamps: false });
      if (pinned.modifiedCount !== 1) throw new CommandError(409, "Invoice already linked; reload its current order");
      changes.invoiceCount = row.invoiceCount + 1;
    }
    const updated = await PharmacyPurchaseOrder.updateOne({ _id: row._id, organizationId: scope.organizationId, locationId: scope.locationId, revision: input.expectedRevision }, { $set: changes, $inc: { revision: 1 } }, { session, runValidators: true });
    if (updated.modifiedCount !== 1) throw new CommandError(409, "Order changed; reload before continuing");
    await createWithSession(AuditLog, { organizationId: scope.organizationId, userId: scope.actorId, action: `PHARMACY_ORDER_${input.action.toUpperCase()}`, category: "BILLING", targetModel: "PharmacyPurchaseOrder", targetId: row._id,
      details: { revision: row.revision + 1, ...input, recordedByStaff: true, stockChanged: false } }, session);
    return String(row._id);
  }), { writeConcern: { w: "majority" } });
  return { ...await present(scope, await ownedOrder(scope, command.resultId)), replayed: command.replayed };
}

/** Shared rules for staff records and an explicitly delegated supplier order link. */
export function supplierOrderChanges(row: any, input: ReturnType<typeof purchaseOrderAction>, evidence: Record<string, unknown>) {
  if (input.action === "respond") {
    if (!["submitted", "accepted", "partially_accepted", "rejected"].includes(row.state) || row.invoiceCount) throw new CommandError(409, "Record supplier quantities before dispatch or invoice linking");
    if (input.lines!.length !== row.lines.length || input.lines!.some(line => !row.lines.some((source: any) => source.lineId === line.lineId && line.acceptedQuantity <= source.quantity))) throw new CommandError(400, "Respond to each exact order line without increasing ordered quantities");
    return { response: { ...evidence, lines: input.lines }, state: input.lines!.every(line => line.acceptedQuantity === 0) ? "rejected" : input.lines!.every(line => line.acceptedQuantity === row.lines.find((source: any) => source.lineId === line.lineId)!.quantity) ? "accepted" : "partially_accepted" };
  }
  if (input.action !== "dispatch" || !["submitted", "accepted", "partially_accepted", "dispatched"].includes(row.state)) throw new CommandError(409, "Record dispatch only for an open sent order");
  return { state: "dispatched", dispatch: { ...evidence, ...(input.expectedDelivery ? { expectedDelivery: input.expectedDelivery } : {}) } };
}
