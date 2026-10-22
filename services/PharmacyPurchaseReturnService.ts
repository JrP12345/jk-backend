import mongoose from "mongoose";
import type { FastifyRequest } from "fastify";
import { PharmacyPurchase } from "../models/PharmacyPurchase.ts";
import { PharmacyPurchaseReceipt } from "../models/PharmacyPurchaseReceipt.ts";
import { PharmacyPurchaseReturn } from "../models/PharmacyPurchaseReturn.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { Medicine } from "../models/Medicine.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { purchaseReturnInput } from "../schemas/pharmacyPurchaseReturns.ts";
import { identifier } from "../schemas/pharmacyPurchases.ts";
import { purchaseScope } from "./PharmacyPurchaseDraftService.ts";
import { allocateSourceCredit } from "./InvoiceCalculationService.ts";
import { CommandError, executeRecordedCommand } from "./CommandReceiptService.ts";
import { appendStockMovement } from "./PharmacyStockMovementService.ts";
import { createWithSession, withTransaction } from "../utilities/transaction.ts";
import { requireStockTransaction, stockRevisionFilter } from "../utilities/pharmacyInventory.ts";
import { validateCapturedLot } from "../utilities/pharmacyLot.ts";
import { pinPharmacyContinuityLocation } from "../utilities/pharmacyCapability.ts";
import { decryptField } from "../utilities/cryptoEnvelope.ts";

type Scope = Awaited<ReturnType<typeof purchaseScope>>;
const operationScope = (scope: Scope) => `pharmacy-purchase-return:${scope.organizationId}:${scope.locationId}`;
export async function purchaseReturnSource(scope: Scope, purchaseId: string, session: mongoose.ClientSession | null) {
  const purchase = await PharmacyPurchase.findOne({ _id: purchaseId, organizationId: scope.organizationId, locationId: scope.locationId, status: "posted" }).session(session);
  if (!purchase?.posting) throw new CommandError(404, "Posted supplier purchase not found");
  const receipts = await PharmacyPurchaseReceipt.find({ purchaseId, organizationId: scope.organizationId, locationId: scope.locationId }).sort({ revision: 1 }).limit(101).session(session).lean();
  const returns = await PharmacyPurchaseReturn.find({ purchaseId, organizationId: scope.organizationId, locationId: scope.locationId }).limit(1001).session(session).lean();
  if (receipts.length > 100 || receipts.length !== purchase.receiptCount || returns.length > 1000) throw new CommandError(409, "Supplier receipt/return history exceeds its review bound");
  const allocations = allocateSourceCredit(purchase.lines.map(line => {
    const captured = purchase.posting!.calculation.lines.find(row => row.lineId === line.lineId), quantity = line.billedBaseUnits + line.freeBaseUnits;
    if (!captured || !quantity) throw new CommandError(409, "Supplier calculation/source units need review");
    return { lineId: line.lineId, quantity, baseAmountPaise: captured.grossAmountPaise, cgstPaise: 0, sgstPaise: 0, lots: [{ batchId: line.lineId, quantity, unitPricePaise: 1 }] };
  }), purchase.posting.payablePaise);
  const offsets = new Map<string, number>(), rows: any[] = [];
  for (const receipt of receipts) for (const received of receipt.lines) {
    const line = purchase.lines.find(line => line.lineId === received.purchaseLineId), basis = allocations.find(row => row.lineId === received.purchaseLineId);
    if (!line || !basis || !line.unitSnapshot) throw new CommandError(409, "Received supplier source is incomplete");
    const quantity = received.billedBaseUnits + received.freeBaseUnits, offset = offsets.get(line.lineId) || 0;
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || offset + quantity > basis.quantity) throw new CommandError(409, "Supplier received quantities do not reconcile");
    offsets.set(line.lineId, offset + quantity);
    const batch = await MedicineBatch.findOne({ _id: received.batchId, medicineId: received.medicineId, organizationId: scope.organizationId, locationId: scope.locationId, lotVersion: 1, receiptKind: "receipt", "purchaseSource.purchaseId": purchaseId, "purchaseSource.receiptId": receipt._id, "purchaseSource.purchaseLineId": line.lineId }).session(session);
    const medicine = await Medicine.findOne({ _id: received.medicineId, locationId: scope.locationId }).session(session);
    if (!batch || !medicine?.unitDefinition || batch.receivedQuantity !== quantity) throw new CommandError(409, "Owned received lot evidence needs review");
    validateCapturedLot(batch, line.unitSnapshot, scope.organizationId); validateCapturedLot(batch, medicine.unitDefinition, scope.organizationId);
    const returned = returns.flatMap(row => row.lines).filter(row => String(row.receiptId) === String(receipt._id) && row.receiptLineId === received.lineId).reduce((sum, row) => sum + row.quantity, 0);
    if (!Number.isSafeInteger(returned) || returned > quantity) throw new CommandError(409, "Supplier returned quantities need review");
    const budget = BigInt(basis.payablePaise) * BigInt(offset + quantity) / BigInt(basis.quantity) - BigInt(basis.payablePaise) * BigInt(offset) / BigInt(basis.quantity);
    rows.push({ receiptId: String(receipt._id), receiptLineId: received.lineId, purchaseLineId: line.lineId, batchId: String(batch._id), medicineId: String(medicine._id), description: line.medicineSnapshot?.name || "Captured product", batchNumber: batch.batchNumber,
      unitSnapshot: line.unitSnapshot, expiryValue: batch.expirySnapshot!.value, receivedQuantity: quantity, returnedQuantity: returned, onHandQuantity: batch.quantity, remainingQuantity: Math.min(quantity - returned, batch.quantity), expectedStockRevision: medicine.stockRevision, creditBudgetPaise: Number(budget) });
  }
  if (rows.length > 1000 || purchase.lines.some(line => { const progress = purchase.receiptProgress?.find(row => row.lineId === line.lineId); return !progress || (offsets.get(line.lineId) || 0) !== progress.billedBaseUnits + progress.freeBaseUnits; })) throw new CommandError(409, "Supplier receipt progress needs review");
  return { purchase, rows, returns };
}
export async function readPurchaseReturnSource(req: FastifyRequest, id: string, locationId: unknown) {
  const scope = await purchaseScope(req, locationId), purchaseId = identifier(id);
  return withTransaction(async session => {
    const source = await purchaseReturnSource(scope, purchaseId, session);
    return { purchaseId, locationId: scope.locationId, supplierId: String(source.purchase.supplierId), supplierName: source.purchase.supplierSnapshot.name, supplierInvoiceNumber: source.purchase.supplierInvoiceNumber, currency: "INR", purchaseRevision: source.purchase.revision, settlementRevision: source.purchase.settlementRevision, payablePaise: source.purchase.posting!.payablePaise,
      lines: source.rows, returns: source.returns.map(({ _id, ...row }) => ({ ...row, id: String(_id) })) };
  }, { readConcern: { level: "snapshot" } });
}
async function prepare(scope: Scope, purchaseId: string, input: ReturnType<typeof purchaseReturnInput>, session: mongoose.ClientSession | null) {
  const source = await purchaseReturnSource(scope, purchaseId, session);
  const lines = input.lines.map(line => {
    const row = source.rows.find(row => row.receiptId === line.receiptId && row.receiptLineId === line.receiptLineId);
    if (!row || line.quantity > row.remainingQuantity) throw new CommandError(409, "Supplier return exceeds original received or remaining on-hand source quantity");
    const budget = BigInt(row.creditBudgetPaise), before = BigInt(row.returnedQuantity), quantity = BigInt(line.quantity), received = BigInt(row.receivedQuantity);
    return { receiptId: row.receiptId, receiptLineId: row.receiptLineId, purchaseLineId: row.purchaseLineId, medicineId: row.medicineId, batchId: row.batchId, batchNumber: row.batchNumber, quantity: line.quantity, expectedStockRevision: row.expectedStockRevision,
      expectedCreditPaise: Number(budget * (before + quantity) / received - budget * before / received) };
  });
  const expected = lines.reduce((sum, line) => sum + BigInt(line.expectedCreditPaise), 0n);
  if (expected > BigInt(Number.MAX_SAFE_INTEGER)) throw new CommandError(409, "Expected supplier credit exceeds supported bounds");
  return { source, lines, expectedCreditPaise: Number(expected) };
}
export async function quotePurchaseReturn(req: FastifyRequest, rawId: string) {
  const input = purchaseReturnInput(req.body), scope = await purchaseScope(req, input.locationId), purchaseId = identifier(rawId);
  return withTransaction(async session => {
    const prepared = await prepare(scope, purchaseId, input, session);
    return { purchaseId, locationId: scope.locationId, currency: "INR", expectedCreditPaise: prepared.expectedCreditPaise, lines: prepared.lines,
      issueInput: { ...input, expectedPurchaseRevision: prepared.source.purchase.revision, expectedSettlementRevision: prepared.source.purchase.settlementRevision, expectedCreditPaise: prepared.expectedCreditPaise,
        lines: prepared.lines.map(({ receiptId, receiptLineId, quantity, expectedStockRevision }) => ({ receiptId, receiptLineId, quantity, expectedStockRevision })) } };
  }, { readConcern: { level: "snapshot" } });
}
export async function recoverPurchaseReturn(req: FastifyRequest, locationId: unknown, key: string) {
  const scope = await purchaseScope(req, locationId);
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(400, "Invalid supplier return reference");
  const saved = await OperationReceipt.findOne({ scope: operationScope(scope), key }).select("+responseCiphertext").lean();
  if (!saved?.resultId || !saved.responseCiphertext) throw new CommandError(404, "No committed supplier return is visible. Keep the same reference.");
  let captured: any; try { captured = JSON.parse(decryptField(saved.responseCiphertext)); } catch { throw new CommandError(409, "Supplier return evidence needs review"); }
  if (captured.actorId !== scope.actorId) throw new CommandError(404, "No supplier return is visible for this operator");
  if (captured.version !== 1 || captured.data?.returnId !== String(saved.resultId) || !await PharmacyPurchaseReturn.exists({ _id: saved.resultId, organizationId: scope.organizationId, locationId: scope.locationId })) throw new CommandError(409, "Supplier return result needs review");
  return captured.data;
}
export async function commitPurchaseReturn(req: FastifyRequest, rawId: string) {
  const input = purchaseReturnInput(req.body, true), scope = await purchaseScope(req, input.locationId), purchaseId = identifier(rawId), key = req.headers["idempotency-key"];
  if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(428, "A stable Idempotency-Key is required for supplier return");
  const command = await executeRecordedCommand(operationScope(scope), key, { actorId: scope.actorId, purchaseId, ...input }, () => withTransaction(async session => {
    requireStockTransaction(session);
    const prepared = await prepare(scope, purchaseId, input, session), purchase = prepared.source.purchase;
    if (purchase.revision !== input.expectedPurchaseRevision || purchase.settlementRevision !== input.expectedSettlementRevision || prepared.expectedCreditPaise !== input.expectedCreditPaise || input.lines.some(line => prepared.lines.find(row => row.receiptId === line.receiptId && row.receiptLineId === line.receiptLineId)!.expectedStockRevision !== line.expectedStockRevision)) throw new CommandError(409, "Supplier source, stock or settlement changed; refresh the return review");
    const returnId = new mongoose.Types.ObjectId(), lines: any[] = [];
    for (const line of prepared.lines) {
      const medicine = await Medicine.findOne({ _id: line.medicineId, locationId: scope.locationId }).session(session), batch = await MedicineBatch.findOne({ _id: line.batchId, organizationId: scope.organizationId, locationId: scope.locationId }).session(session);
      if (!medicine?.unitDefinition || !batch || !["active", "expired", "depleted"].includes(batch.status) || batch.quantity < line.quantity) throw new CommandError(409, "Received supplier stock needs review");
      const inventory = await MedicineBatch.find({ medicineId: medicine._id }).limit(5001).session(session);
      if (inventory.length > 5000 || inventory.some(lot => lot.lotVersion !== 1 || String(lot.locationId) !== scope.locationId)) throw new CommandError(409, "Supplier lot history needs inventory review");
      for (const lot of inventory) validateCapturedLot(lot, medicine.unitDefinition, scope.organizationId);
      if (inventory.reduce((sum, lot) => sum + BigInt(lot.quantity), 0n) !== BigInt(medicine.stockQuantity)) throw new CommandError(409, "Supplier lots and physical aggregate do not reconcile");
      const quantity = batch.quantity - line.quantity, changed = await MedicineBatch.findOneAndUpdate({ _id: batch._id, quantity: batch.quantity }, { $set: { quantity, status: quantity === 0 ? "depleted" : batch.status } }, { session });
      if (!changed) throw new CommandError(409, "Supplier batch changed; refresh the return review");
      const updated = await Medicine.findOneAndUpdate({ _id: medicine._id, locationId: scope.locationId, stockQuantity: medicine.stockQuantity, ...stockRevisionFilter(medicine.stockRevision) }, { $inc: { stockQuantity: -line.quantity, stockRevision: 1 } }, { session, returnDocument: "after" });
      if (!updated) throw new CommandError(409, "Supplier stock changed; refresh the return review");
      const movement = await appendStockMovement(medicine, "purchase_return", updated.stockQuantity, [{ batchId: batch._id, beforeQuantity: batch.quantity, afterQuantity: quantity, quantityDelta: -line.quantity }], session,
        { actorId: scope.actorId, clientRequestId: key, returnId: String(returnId), notes: input.reason, purchaseSource: { purchaseId, purchaseLineId: line.purchaseLineId, receiptId: line.receiptId } });
      const { expectedStockRevision: _stock, ...captured } = line; lines.push({ ...captured, movementId: movement._id });
    }
    purchase.settlementRevision++; await purchase.save({ session });
    await createWithSession(PharmacyPurchaseReturn, { _id: returnId, organizationId: scope.organizationId, locationId: scope.locationId, purchaseId, supplierId: purchase.supplierId, supplierInvoiceNumber: purchase.supplierInvoiceNumber, actorId: scope.actorId, operationKey: key, settlementRevision: purchase.settlementRevision, createdAt: new Date(), reason: input.reason, reviewReference: input.reviewReference, expectedCreditPaise: prepared.expectedCreditPaise, lines }, session);
    await createWithSession(AuditLog, { organizationId: scope.organizationId, userId: scope.actorId, action: "PHARMACY_PURCHASE_RETURN", category: "BILLING", targetModel: "PharmacyPurchaseReturn", targetId: returnId, details: { purchaseId, expectedCreditPaise: prepared.expectedCreditPaise, settlementRevision: purchase.settlementRevision, supplierCreditConfirmed: false } }, session);
    await pinPharmacyContinuityLocation(scope.locationId, session);
    const data = { returnId: String(returnId), purchaseId, locationId: scope.locationId, expectedCreditPaise: prepared.expectedCreditPaise, supplierCreditConfirmed: false, settlementRevision: purchase.settlementRevision, requestKey: key };
    const saved = await OperationReceipt.updateOne({ scope: operationScope(scope), key }, { $set: { responseCiphertext: JSON.stringify({ version: 1, actorId: scope.actorId, data }) } }).session(session);
    if (saved.matchedCount !== 1) throw new CommandError(409, "Supplier return reservation changed; keep the same reference");
    return String(returnId);
  }), { writeConcern: { w: "majority" } });
  return { ...await recoverPurchaseReturn(req, input.locationId, key), replayed: command.replayed };
}
