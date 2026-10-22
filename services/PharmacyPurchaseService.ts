import crypto from "node:crypto";
import mongoose from "mongoose";
import type { FastifyRequest } from "fastify";
import { PharmacyPurchase } from "../models/PharmacyPurchase.ts";
import { PharmacyPurchaseReceipt } from "../models/PharmacyPurchaseReceipt.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { PharmacyTaxProfile } from "../models/PharmacyTaxProfile.ts";
import { Medicine } from "../models/Medicine.ts";
import { Organization } from "../models/Organization.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { CommandError, executeRecordedCommand } from "./CommandReceiptService.ts";
import { purchaseScope, scopedPurchase } from "./PharmacyPurchaseDraftService.ts";
import { calculatePharmacyDocument, PHARMACY_CALCULATION_POLICY } from "./InvoiceCalculationService.ts";
import { receivePharmacyStockInTransaction, requireReceiptIndexes } from "./PharmacyStockReceiptService.ts";
import { purchasePostingInput, purchaseReceiptInput } from "../schemas/pharmacyPurchases.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import { requireStockTransaction } from "../utilities/pharmacyInventory.ts";
import { validatePharmacyProfile } from "../utilities/pharmacyTax.ts";
import { pinActivePharmacyLocation } from "../utilities/pharmacyCapability.ts";
import { getLocationTimezone, locationDateKey } from "../utilities/locationTime.ts";
import { decryptField } from "../utilities/cryptoEnvelope.ts";
import type { StockReceiptInput } from "../utilities/pharmacyLot.ts";

type Scope = Awaited<ReturnType<typeof purchaseScope>>;
const commandScope = (scope: Scope, purchaseId: string, kind: "post" | "receipt") => `pharmacy-purchase-${kind}:${scope.organizationId}:${scope.locationId}:${purchaseId}`;
function requestKey(req: FastifyRequest) {
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(428, "A stable Idempotency-Key is required for posting or receiving");
  return key;
}
async function capture(scope: Scope, purchaseId: string, kind: "post" | "receipt", key: string, resultId: string, data: unknown) {
  const saved = await OperationReceipt.updateOne({ scope: commandScope(scope, purchaseId, kind), key }, { $set: { responseCiphertext: JSON.stringify({ version: 1, actorId: scope.actorId, resultId, data }) } });
  if (saved.matchedCount !== 1) throw new CommandError(409, "Purchase command reservation changed; keep the same reference");
}
export async function recoverPharmacyPurchaseOperation(req: FastifyRequest, id: string, locationId: unknown, kind: "post" | "receipt", key: string) {
  const { scope, draft } = await scopedPurchase(req, id, locationId);
  if (!["post", "receipt"].includes(kind) || !/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(400, "Invalid purchase operation reference");
  const record = await OperationReceipt.findOne({ scope: commandScope(scope, String(draft._id), kind), key }).select("+responseCiphertext").lean();
  if (!record?.responseCiphertext || !record.resultId) throw new CommandError(404, "No committed result is visible. Keep the same reference and check again.");
  let snapshot: any;
  try { snapshot = JSON.parse(decryptField(record.responseCiphertext)); } catch { throw new CommandError(409, "Purchase operation evidence needs review"); }
  if (snapshot.actorId !== scope.actorId) throw new CommandError(404, "No committed result is visible for this operator");
  if (snapshot.version !== 1 || snapshot.resultId !== String(record.resultId) || snapshot.data?.purchaseId !== String(draft._id)) throw new CommandError(409, "Purchase operation evidence needs review");
  return snapshot.data;
}
export async function postPharmacyPurchase(req: FastifyRequest, id: string) {
  const input = purchasePostingInput(req.body), { scope, draft } = await scopedPurchase(req, id, input.locationId), key = requestKey(req), purchaseId = String(draft._id);
  const command = await executeRecordedCommand(commandScope(scope, purchaseId, "post"), key, { actorId: scope.actorId, purchaseId, ...input }, () => withTransaction(async session => {
    requireStockTransaction(session);
    const current = (await scopedPurchase(req, purchaseId, input.locationId)).draft;
    if (current.status !== "draft" || current.revision !== input.expectedRevision || current.posting) throw new CommandError(409, "Purchase is posted or changed; reopen before posting");
    const organization = await Organization.findById(scope.organizationId).select("currency countryCode").session(session);
    if (organization?.currency !== "INR" || organization.countryCode !== "IN") throw new CommandError(409, "Posting requires an explicit India/INR organization");
    const profile = await PharmacyTaxProfile.findOneAndUpdate({ organizationId: scope.organizationId, locationId: scope.locationId }, { $inc: { __v: 1 } }, { session, returnDocument: "after" });
    if (!profile?.confirmedAt || !profile.confirmedBy || profile.revision < 1) throw new CommandError(409, "Review the recipient branch tax profile before posting");
    validatePharmacyProfile(profile, false);
    if ((input.supplierStateCode !== profile.stateCode) !== (input.taxMode === "igst")) throw new CommandError(409, "Reviewed GST mode differs from supplier and recipient states");
    const supplier = await PharmacyParty.findOneAndUpdate({ _id: current.supplierId, organizationId: scope.organizationId, locationIds: scope.locationId, revision: input.expectedSupplierRevision, archived: false, kinds: "supplier" }, { $inc: { __v: 1 } }, { session, returnDocument: "after", timestamps: false });
    const today = locationDateKey(new Date(), await getLocationTimezone(scope.locationId));
    if (!supplier?.licence?.number || supplier.licence.validUntil && supplier.licence.validUntil < today) throw new CommandError(409, "Supplier eligibility or revision needs review before posting");
    if ((supplier.gstin || "") !== (current.supplierSnapshot.gstin || "") || supplier.gstin && supplier.gstin.slice(0, 2) !== input.supplierStateCode) throw new CommandError(409, "Supplier tax identity differs from the reviewed source bill");
    const products = await Medicine.find({ _id: { $in: current.lines.map(line => line.medicineId) }, locationId: scope.locationId, deletedAt: null }).session(session);
    for (const line of current.lines) {
      const unit = products.find(product => String(product._id) === String(line.medicineId))?.unitDefinition;
      if (!unit || !line.unitSnapshot || (["version", "baseUnit", "packUnit", "unitsPerPack"] as const).some(field => unit[field] !== line.unitSnapshot![field])) throw new CommandError(409, "A source product or its units changed; review the draft");
      if (supplier.gstRegistration === "unregistered" && line.gstRateBps !== 0) throw new CommandError(409, "Unregistered supplier cannot collect GST on this purchase");
    }
    const calculation = calculatePharmacyDocument({ policy: PHARMACY_CALCULATION_POLICY, currency: "INR", priceMode: "exclusive", taxMode: input.taxMode, roundOffPaise: input.roundOffPaise,
      lines: current.lines.map(line => ({ lineId: line.lineId, quantity: line.billedBaseUnits + line.freeBaseUnits,
        unitPrice: { numeratorPaise: line.baseAmountPaise, denominatorUnits: line.billedBaseUnits + line.freeBaseUnits }, lineDiscountPaise: line.discountPaise, gstRateBps: line.gstRateBps })) });
    if (calculation.totals.payablePaise !== current.statedTotalPaise) throw new CommandError(409, "Calculated payable differs from supplier stated total; correct the draft or record reviewed round-off");
    if (calculation.lines.some(line => (input.costTreatment === "include_tax" ? line.grossAmountPaise : line.baseAmountPaise) > 100_000_000_000)) throw new CommandError(409, "A source line exceeds the supported receiving cost bound; split the source bill through review");
    const posting = { postedAt: new Date(), postedBy: scope.actorId, supplierRevision: supplier.revision, profileRevision: profile.revision,
      supplierStateCode: input.supplierStateCode, recipientStateCode: profile.stateCode, costTreatment: input.costTreatment, reviewReference: input.reviewReference, calculation, payablePaise: calculation.totals.payablePaise };
    const updated = await PharmacyPurchase.findOneAndUpdate({ _id: current._id, organizationId: scope.organizationId, locationId: scope.locationId, status: "draft", revision: input.expectedRevision },
      { $set: { status: "posted", posting, receiptCount: 0, receiptProgress: current.lines.map(line => ({ lineId: line.lineId, billedBaseUnits: 0, freeBaseUnits: 0, costPaise: 0 })), updatedBy: scope.actorId }, $inc: { revision: 1 } }, { session, returnDocument: "after", runValidators: true });
    if (!updated) throw new CommandError(409, "Purchase changed; reopen before posting");
    await createWithSession(AuditLog, { organizationId: scope.organizationId, userId: scope.actorId, action: "PHARMACY_PURCHASE_POSTED", category: "BILLING", targetModel: "PharmacyPurchase", targetId: current._id, details: { revision: updated.revision, payablePaise: posting.payablePaise, policy: calculation.policy, stockPosted: false } }, session);
    await pinActivePharmacyLocation(scope.locationId, session);
    await capture(scope, purchaseId, "post", key, purchaseId, { purchaseId, status: "posted", revision: updated.revision, payablePaise: posting.payablePaise, requestKey: key });
    return purchaseId;
  }), { writeConcern: { w: "majority" } });
  return { ...await recoverPharmacyPurchaseOperation(req, purchaseId, input.locationId, "post", key), replayed: command.replayed };
}
function cumulativeCost(total: number, quantity: number, expected: number) {
  return Number((BigInt(total) * BigInt(quantity) * 2n + BigInt(expected)) / (BigInt(expected) * 2n));
}
function stockInput(purchase: any, delivery: ReturnType<typeof purchaseReceiptInput>["lines"][number], purchaseId: string, receiptId: string, cost: number): StockReceiptInput {
  const source = purchase.lines.find((line: any) => line.lineId === delivery.purchaseLineId);
  if (!source?.unitSnapshot) throw new CommandError(409, "Delivery does not match a captured purchase line");
  const quantity = delivery.billedBaseUnits + delivery.freeBaseUnits, factor = source.unitSnapshot.unitsPerPack;
  return { medicineId: String(source.medicineId), locationId: String(purchase.locationId), kind: "receipt", receiptLineId: crypto.createHash("sha256").update(`${purchaseId}:${receiptId}:${delivery.lineId}`).digest("hex"),
    expectedUnitVersion: source.unitSnapshot.version, packs: Math.floor(quantity / factor), looseUnits: quantity % factor, batchNumber: delivery.batchNumber, expiry: delivery.expiry,
    purchaseTotalPaise: cost, sellingPricePaise: source.sellingPricePaise, ...(source.mrpPaise !== undefined ? { mrpPaise: source.mrpPaise } : {}) };
}
export async function receivePharmacyPurchase(req: FastifyRequest, id: string) {
  const input = purchaseReceiptInput(req.body), { scope, draft } = await scopedPurchase(req, id, input.locationId), key = requestKey(req), purchaseId = String(draft._id);
  if (!await OperationReceipt.exists({ scope: commandScope(scope, purchaseId, "receipt"), key })) for (const line of input.lines) await requireReceiptIndexes(stockInput(draft, line, purchaseId, "preflight", 0));
  const command = await executeRecordedCommand(commandScope(scope, purchaseId, "receipt"), key, { actorId: scope.actorId, purchaseId, ...input }, () => withTransaction(async session => {
    requireStockTransaction(session);
    const current = (await scopedPurchase(req, purchaseId, input.locationId)).draft;
    if (current.status !== "posted" || !current.posting || current.revision !== input.expectedRevision) throw new CommandError(409, "Purchase must be posted and at the expected revision before receiving");
    if ((current.receiptCount ?? 0) >= 100) throw new CommandError(409, "Purchase reached 100 deliveries; remaining stock needs a reviewed workflow");
    if (await PharmacyPurchaseReceipt.exists({ organizationId: scope.organizationId, locationId: scope.locationId, purchaseId, normalizedDeliveryReference: input.normalizedDeliveryReference }).session(session)) throw new CommandError(409, "Delivery reference already received; recover the original receipt");
    const progress = current.receiptProgress?.map(row => ({ lineId: row.lineId, billedBaseUnits: row.billedBaseUnits, freeBaseUnits: row.freeBaseUnits, costPaise: row.costPaise }));
    if (!progress || progress.length !== current.lines.length || new Set(progress.map(row => row.lineId)).size !== current.lines.length) throw new CommandError(409, "Purchase receipt progress needs review");
    const receiptId = new mongoose.Types.ObjectId(), received: any[] = [];
    for (const delivery of input.lines) {
      const source = current.lines.find(line => line.lineId === delivery.purchaseLineId), state = progress.find(row => row.lineId === delivery.purchaseLineId), priced = current.posting.calculation.lines.find(line => line.lineId === delivery.purchaseLineId);
      if (!source || !state || !priced) throw new CommandError(409, "Delivery does not match a posted purchase line");
      const expected = source.billedBaseUnits + source.freeBaseUnits, costTotal = current.posting.costTreatment === "include_tax" ? priced.grossAmountPaise : priced.baseAmountPaise;
      if (![state.billedBaseUnits, state.freeBaseUnits, state.costPaise].every(value => Number.isSafeInteger(value) && value >= 0) || state.billedBaseUnits > source.billedBaseUnits || state.freeBaseUnits > source.freeBaseUnits || state.costPaise !== cumulativeCost(costTotal, state.billedBaseUnits + state.freeBaseUnits, expected)) throw new CommandError(409, "Purchase received quantity or cost needs review");
      const billed = state.billedBaseUnits + delivery.billedBaseUnits, free = state.freeBaseUnits + delivery.freeBaseUnits;
      if (!Number.isSafeInteger(billed + free) || billed > source.billedBaseUnits || free > source.freeBaseUnits) throw new CommandError(409, "Delivery exceeds remaining billed or free source quantity");
      const costAfter = cumulativeCost(costTotal, billed + free, expected), costPaise = costAfter - state.costPaise;
      const lot = await receivePharmacyStockInTransaction(scope, key, stockInput(current, delivery, purchaseId, String(receiptId), costPaise), session,
        { purchaseSource: { purchaseId, purchaseLineId: source.lineId, receiptId: String(receiptId) }, hsnCode: source.hsnCode, gstRate: source.gstRateBps / 100,
          unitSnapshot: { version: source.unitSnapshot!.version!, baseUnit: source.unitSnapshot!.baseUnit!, packUnit: source.unitSnapshot!.packUnit!, unitsPerPack: source.unitSnapshot!.unitsPerPack! } });
      state.billedBaseUnits = billed; state.freeBaseUnits = free; state.costPaise = costAfter;
      received.push({ ...delivery, medicineId: source.medicineId, batchId: lot.batchId, movementId: lot.movementId, costPaise });
    }
    const updated = await PharmacyPurchase.findOneAndUpdate({ _id: current._id, organizationId: scope.organizationId, locationId: scope.locationId, status: "posted", revision: input.expectedRevision },
      { $set: { receiptProgress: progress, updatedBy: scope.actorId }, $inc: { receiptCount: 1, revision: 1 } }, { session, returnDocument: "after", runValidators: true });
    if (!updated) throw new CommandError(409, "Purchase receipt changed; reopen before receiving");
    await createWithSession(PharmacyPurchaseReceipt, { _id: receiptId, organizationId: scope.organizationId, locationId: scope.locationId, purchaseId, deliveryReference: input.deliveryReference,
      normalizedDeliveryReference: input.normalizedDeliveryReference, actorId: scope.actorId, receivedAt: new Date(), revision: updated.revision, lines: received }, session);
    await createWithSession(AuditLog, { organizationId: scope.organizationId, userId: scope.actorId, action: "PHARMACY_PURCHASE_RECEIVED", category: "BILLING", targetModel: "PharmacyPurchaseReceipt", targetId: receiptId, details: { purchaseId, revision: updated.revision, lineCount: received.length } }, session);
    await pinActivePharmacyLocation(scope.locationId, session);
    await capture(scope, purchaseId, "receipt", key, String(receiptId), { purchaseId, receiptId: String(receiptId), deliveryReference: input.deliveryReference, revision: updated.revision, lines: received, requestKey: key });
    return String(receiptId);
  }), { writeConcern: { w: "majority" } });
  return { ...await recoverPharmacyPurchaseOperation(req, purchaseId, input.locationId, "receipt", key), replayed: command.replayed };
}
