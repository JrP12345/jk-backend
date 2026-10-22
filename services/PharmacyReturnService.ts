import mongoose from "mongoose";
import crypto from "node:crypto";
import type { FastifyRequest } from "fastify";
import { Invoice } from "../models/Invoice.ts";
import { PharmacyDispense } from "../models/PharmacyDispense.ts";
import { PharmacyReturn } from "../models/PharmacyReturn.ts";
import { InvoiceCreditNote } from "../models/InvoiceCreditNote.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { identifier } from "../schemas/pharmacyPurchases.ts";
import { pharmacyReturnInput } from "../schemas/pharmacyReturns.ts";
import { purchaseScope } from "./PharmacyPurchaseDraftService.ts";
import { allocateSourceCredit, cumulativeSourceCredit } from "./InvoiceCalculationService.ts";
import { invoiceBalancePaise } from "./InvoicePaymentService.ts";
import { CommandError, executeRecordedCommand } from "./CommandReceiptService.ts";
import { appendStockMovement } from "./PharmacyStockMovementService.ts";
import { createWithSession, withTransaction } from "../utilities/transaction.ts";
import { requireStockTransaction, stockRevisionFilter } from "../utilities/pharmacyInventory.ts";
import { validateCapturedLot } from "../utilities/pharmacyLot.ts";
import { allocateCreditNoteNumber } from "../utilities/invoiceNumber.ts";
import { decryptField } from "../utilities/cryptoEnvelope.ts";
import { pinPharmacyContinuityLocation } from "../utilities/pharmacyCapability.ts";
import { toPaise } from "../utilities/pharmacyTax.ts";

type Scope = Awaited<ReturnType<typeof purchaseScope>>;
type ReturnInput = ReturnType<typeof pharmacyReturnInput>;
const operationScope = (scope: Scope) => `pharmacy-return:${scope.organizationId}:${scope.locationId}`;
async function returnSource(scope: Scope, invoiceId: string, session: mongoose.ClientSession | null) {
  const invoice = await Invoice.findOne({ _id: invoiceId, organizationId: scope.organizationId, locationId: scope.locationId, kind: "pharmacy", documentVersion: 2, deletedAt: null }).session(session);
  if (!invoice) throw new CommandError(404, "Returnable counter invoice not found");
  if (["cancelled", "refunded"].includes(invoice.status)) throw new CommandError(409, "Invoice needs a reviewed correction workflow");
  const source = await PharmacyDispense.findOne({ invoiceId, organizationId: scope.organizationId, locationId: scope.locationId, kind: "pharmacy" }).session(session);
  if (!source || source.lines.length !== invoice.items.length) throw new CommandError(409, "Original sold source evidence needs review");
  const history = await PharmacyReturn.find({ invoiceId, organizationId: scope.organizationId, locationId: scope.locationId }).sort({ revision: 1 }).limit(1001).session(session).lean();
  if (history.length > 1000 || history.length !== invoice.returnRevision || history.some((row, index) => row.revision !== index + 1)) throw new CommandError(409, "Return ledger revision needs review");
  const credits = await InvoiceCreditNote.find({ invoiceId, organizationId: scope.organizationId, locationId: scope.locationId }).limit(1001).session(session).lean();
  if (credits.length !== history.length || credits.reduce((sum, row) => sum + BigInt(row.payablePaise), 0n) !== BigInt(invoice.creditedPaise ?? 0) || history.some(row => !credits.some(credit => String(credit._id) === String(row.creditNoteId) && String(credit.returnId) === String(row._id)))) throw new CommandError(409, "Credit ledger needs review");
  const basis = allocateSourceCredit(source.lines.map(line => {
    const item = invoice.items.find((item: any) => String(item.pharmacyDispenseLineId) === String(line._id));
    if (!item || !line.unitSnapshot?.version || !line.pricingAllocations.length || line.quantity !== item.quantity || ["baseAmountPaise", "cgstPaise", "sgstPaise", "grossAmountPaise"].some(field => (line as any)[field] !== (item as any)[field])) throw new CommandError(409, "Original invoice/source amounts need review");
    return { lineId: String(line._id), quantity: line.quantity, baseAmountPaise: line.baseAmountPaise!, cgstPaise: line.cgstPaise!, sgstPaise: line.sgstPaise!,
      lots: line.pricingAllocations.map(lot => { if (!lot.batchId) throw new CommandError(409, "Original lot identity missing"); return { batchId: String(lot.batchId), quantity: lot.quantity, unitPricePaise: toPaise(lot.unitPrice) }; }) };
  }), invoice.calculation!.totals!.payablePaise!);
  if (basis.length > 1000) throw new CommandError(409, "Source lot count exceeds the return review bound");
  const balances = invoiceBalancePaise(invoice, true);
  const rows: any[] = [];
  for (const part of basis) {
    const line = source.lines.find(line => String(line._id) === part.lineId)!, allocation = line.pricingAllocations.find(lot => String(lot.batchId) === part.batchId)!;
    const lot = await MedicineBatch.findOne({ _id: part.batchId, medicineId: line.medicineId, locationId: scope.locationId, organizationId: scope.organizationId, lotVersion: 1 }).session(session);
    if (!lot || lot.receiptKind === "return") throw new CommandError(409, "Original owned lot evidence needs review");
    validateCapturedLot(lot, line.unitSnapshot, scope.organizationId);
    const returned = history.flatMap(row => row.lines).filter(row => String(row.sourceLineId) === part.lineId && String(row.sourceBatchId) === part.batchId).reduce((sum, row) => sum + row.quantity, 0);
    if (!Number.isSafeInteger(returned) || returned > part.quantity) throw new CommandError(409, "Returned source quantity needs review");
    rows.push({ ...part, sourceLineId: part.lineId, sourceBatchId: part.batchId, medicineId: String(line.medicineId), description: line.description, batchNumber: allocation.batchNumber,
      unitSnapshot: (line.unitSnapshot as any).toObject?.() || line.unitSnapshot, soldQuantity: part.quantity, returnedQuantity: returned, remainingQuantity: part.quantity - returned, expiryValue: allocation.expiryValue, expiryPrecision: allocation.expiryPrecision, lot });
  }
  return { invoice, rows, balances, history, credits };
}
function sourceView(source: Awaited<ReturnType<typeof returnSource>>) {
  return { invoiceId: String(source.invoice._id), invoiceNumber: source.invoice.invoiceNumber, locationId: String(source.invoice.locationId), currency: "INR", customerName: source.invoice.taxDocument!.recipient!.name,
    returnRevision: source.invoice.returnRevision, paymentRevision: source.invoice.paymentRevision, ...source.balances,
    lines: source.rows.map(({ lot: _lot, ...row }) => row), credits: source.credits.map(({ _id, issuerSnapshot: _issuer, __v: _version, ...row }) => ({ ...row, id: String(_id) })) };
}
export async function getPharmacyReturnSource(req: FastifyRequest, locationId: unknown, rawId: string) {
  const scope = await purchaseScope(req, locationId), invoiceId = identifier(rawId);
  return withTransaction(async session => sourceView(await returnSource(scope, invoiceId, session)), { readConcern: { level: "snapshot" } });
}
async function preparedReturn(scope: Scope, invoiceId: string, input: ReturnInput, session: mongoose.ClientSession | null) {
  const source = await returnSource(scope, invoiceId, session);
  const lines = input.lines.map(requested => {
    const sold = source.rows.find(row => row.sourceLineId === requested.sourceLineId && row.sourceBatchId === requested.sourceBatchId);
    if (!sold) throw new CommandError(409, "Selected source lot was not sold on this invoice");
    const credit = cumulativeSourceCredit(sold, sold.returnedQuantity, requested.quantity);
    return { sourceLineId: requested.sourceLineId, sourceBatchId: requested.sourceBatchId, medicineId: sold.medicineId, description: sold.description, batchNumber: sold.batchNumber, quantity: requested.quantity, condition: requested.condition, ...credit };
  });
  const sum = (field: "baseAmountPaise" | "cgstPaise" | "sgstPaise" | "grossAmountPaise" | "payablePaise" | "roundOffPaise") => { const value = lines.reduce((sum, line) => sum + BigInt(line[field]), 0n); if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) throw new CommandError(409, "Credit exceeds supported bounds"); return Number(value); };
  const totals = { baseAmountPaise: sum("baseAmountPaise"), cgstPaise: sum("cgstPaise"), sgstPaise: sum("sgstPaise"), grossAmountPaise: sum("grossAmountPaise"), payablePaise: sum("payablePaise"), roundOffPaise: sum("roundOffPaise") };
  if (totals.payablePaise > source.balances.totalPaise - source.balances.creditedPaise) throw new CommandError(409, "Credit exceeds the original remaining value");
  return { source, lines, totals };
}
export async function previewPharmacyReturn(req: FastifyRequest, rawId: string) {
  const input = pharmacyReturnInput(req.body), scope = await purchaseScope(req, input.locationId), invoiceId = identifier(rawId);
  return withTransaction(async session => {
    const result = await preparedReturn(scope, invoiceId, input, session);
    return { invoiceId, invoiceNumber: result.source.invoice.invoiceNumber, locationId: scope.locationId, currency: "INR", disposition: "quarantined", policy: "source-credit-paise-v1", taxAdjustment: "professional_review_required", lines: result.lines, totals: result.totals,
      issueInput: { ...input, expectedReturnRevision: result.source.invoice.returnRevision, expectedPaymentRevision: result.source.invoice.paymentRevision, expectedCreditPaise: result.totals.payablePaise } };
  }, { readConcern: { level: "snapshot" } });
}
export async function recoverPharmacyReturn(req: FastifyRequest, locationId: unknown, key: string) {
  const scope = await purchaseScope(req, locationId);
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(400, "Invalid return reference");
  const saved = await OperationReceipt.findOne({ scope: operationScope(scope), key }).select("+responseCiphertext").lean();
  if (!saved?.resultId || !saved.responseCiphertext) throw new CommandError(404, "No committed return is visible. Keep the same reference and check again.");
  let result: any; try { result = JSON.parse(decryptField(saved.responseCiphertext)); } catch { throw new CommandError(409, "Return result needs review"); }
  if (result.actorId !== scope.actorId) throw new CommandError(404, "No committed return is visible for this operator");
  if (result.version !== 1 || result.data?.returnId !== String(saved.resultId) || !await PharmacyReturn.exists({ _id: saved.resultId, organizationId: scope.organizationId, locationId: scope.locationId })) throw new CommandError(409, "Return source/result needs review");
  return result.data;
}
export async function commitPharmacyReturn(req: FastifyRequest, rawId: string) {
  const input = pharmacyReturnInput(req.body, true), scope = await purchaseScope(req, input.locationId), invoiceId = identifier(rawId), key = req.headers["idempotency-key"];
  if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(428, "A stable Idempotency-Key is required for return");
  const command = await executeRecordedCommand(operationScope(scope), key, { actorId: scope.actorId, invoiceId, ...input }, () => withTransaction(async session => {
    requireStockTransaction(session);
    const prepared = await preparedReturn(scope, invoiceId, input, session), invoice = prepared.source.invoice;
    if (invoice.returnRevision !== input.expectedReturnRevision || invoice.paymentRevision !== input.expectedPaymentRevision || prepared.totals.payablePaise !== input.expectedCreditPaise) throw new CommandError(409, "Return or payment changed; refresh the return review");
    const returnId = new mongoose.Types.ObjectId(), creditNoteId = new mongoose.Types.ObjectId(), issuedAt = new Date(), lines: any[] = [];
    for (const line of prepared.lines) {
      const sold = prepared.source.rows.find(row => row.sourceLineId === line.sourceLineId && row.sourceBatchId === line.sourceBatchId)!, original = sold.lot;
      const medicine = await Medicine.findOne({ _id: line.medicineId, locationId: scope.locationId }).session(session);
      if (!medicine?.unitDefinition) throw new CommandError(409, "Source product/unit ownership needs review");
      const inventory = await MedicineBatch.find({ medicineId: medicine._id }).limit(5001).session(session);
      if (inventory.length > 5000 || inventory.some(lot => lot.lotVersion !== 1 || String(lot.locationId) !== scope.locationId)) throw new CommandError(409, "Source inventory requires review");
      for (const lot of inventory) validateCapturedLot(lot, medicine.unitDefinition, scope.organizationId);
      if (inventory.reduce((sum, lot) => sum + BigInt(lot.quantity), 0n) !== BigInt(medicine.stockQuantity) || !Number.isSafeInteger(medicine.stockQuantity + line.quantity)) throw new CommandError(409, "Source lot and aggregate stock do not reconcile");
      const quarantineBatchId = new mongoose.Types.ObjectId();
      await createWithSession(MedicineBatch, { _id: quarantineBatchId, organizationId: scope.organizationId, locationId: scope.locationId, medicineId: medicine._id,
        lotVersion: 1, receiptKind: "return", receiptLineId: crypto.randomUUID(), receivedAt: issuedAt, receivedQuantity: line.quantity, quantity: line.quantity,
        returnSource: { returnId, originalBatchId: original._id, invoiceId }, unitSnapshot: original.unitSnapshot.toObject?.() || original.unitSnapshot, costBasis: original.costBasis.toObject?.() || original.costBasis,
        expirySnapshot: original.expirySnapshot.toObject?.() || original.expirySnapshot, expiryDate: original.expiryDate, batchNumber: original.batchNumber,
        sellingPricePaise: original.sellingPricePaise, sellingPrice: original.sellingPrice, mrpPaise: original.mrpPaise, mrp: original.mrp, purchaseCost: original.purchaseCost, hsnCode: original.hsnCode, gstRate: original.gstRate, status: "quarantined" }, session);
      const updated = await Medicine.findOneAndUpdate({ _id: medicine._id, locationId: scope.locationId, stockQuantity: medicine.stockQuantity, ...stockRevisionFilter(medicine.stockRevision) }, { $inc: { stockQuantity: line.quantity, stockRevision: 1 } }, { session, returnDocument: "after" });
      if (!updated) throw new CommandError(409, "Source stock changed; refresh return review");
      await appendStockMovement(medicine, "sales_return", updated.stockQuantity, [{ batchId: quarantineBatchId, beforeQuantity: 0, afterQuantity: line.quantity, quantityDelta: line.quantity }], session, { actorId: scope.actorId, clientRequestId: key, returnId: String(returnId), notes: input.reason });
      lines.push({ ...line, quarantineBatchId });
    }
    const revision = invoice.returnRevision + 1, creditNoteNumber = await allocateCreditNoteNumber(scope.locationId, issuedAt);
    await createWithSession(PharmacyReturn, { _id: returnId, organizationId: scope.organizationId, locationId: scope.locationId, invoiceId, invoiceNumber: invoice.invoiceNumber, creditNoteId, actorId: scope.actorId, approvedBy: scope.actorId, operationKey: key, revision, reason: input.reason, reviewReference: input.reviewReference, createdAt: issuedAt, disposition: "quarantined", lines }, session);
    const note = await createWithSession<InstanceType<typeof InvoiceCreditNote>>(InvoiceCreditNote, { _id: creditNoteId, organizationId: scope.organizationId, locationId: scope.locationId, invoiceId, returnId, creditNoteNumber, sourceInvoiceNumber: invoice.invoiceNumber, sourceIssuedAt: invoice.issuedAt, issuedAt, currency: "INR", policy: "source-credit-paise-v1", taxAdjustment: "professional_review_required", issuerSnapshot: invoice.taxDocument!.toObject(), actorId: scope.actorId, reason: input.reason, reviewReference: input.reviewReference, ...prepared.totals }, session);
    invoice.creditedPaise += prepared.totals.payablePaise; invoice.returnRevision = revision; invoice.paymentRevision++;
    const due = Math.max(0, prepared.source.balances.totalPaise - prepared.source.balances.paidPaise - invoice.creditedPaise);
    invoice.balanceDue = due / 100; invoice.status = due === 0 ? "paid" : invoice.amountPaid > 0 ? "partially_paid" : "unpaid";
    await invoice.save({ session });
    await createWithSession(AuditLog, { organizationId: scope.organizationId, userId: scope.actorId, action: "PHARMACY_SALES_RETURN", category: "BILLING", targetModel: "PharmacyReturn", targetId: returnId,
      details: { invoiceId, creditNoteId, creditNoteNumber, payablePaise: prepared.totals.payablePaise, disposition: "quarantined", reviewReference: input.reviewReference, revision } }, session);
    await pinPharmacyContinuityLocation(scope.locationId, session);
    const data = { returnId: String(returnId), invoiceId, invoiceNumber: invoice.invoiceNumber, locationId: scope.locationId, creditNoteId: String(creditNoteId), creditNoteNumber, creditedPaise: prepared.totals.payablePaise, totalCreditedPaise: invoice.creditedPaise,
      balancePaise: due, refundPayablePaise: Math.max(0, prepared.source.balances.paidPaise - (prepared.source.balances.totalPaise - invoice.creditedPaise) - prepared.source.balances.refundedPaise), disposition: "quarantined", revision, taxAdjustment: note.taxAdjustment, requestKey: key };
    const saved = await OperationReceipt.updateOne({ scope: operationScope(scope), key }, { $set: { responseCiphertext: JSON.stringify({ version: 1, actorId: scope.actorId, data }) } }).session(session);
    if (saved.matchedCount !== 1) throw new CommandError(409, "Return reservation changed; keep the same reference");
    return String(returnId);
  }), { writeConcern: { w: "majority" } });
  return { ...await recoverPharmacyReturn(req, input.locationId, key), replayed: command.replayed };
}
