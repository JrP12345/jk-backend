import mongoose from "mongoose";
import type { FastifyRequest } from "fastify";
import { Invoice } from "../models/Invoice.ts";
import { InvoiceCollectionReceipt } from "../models/InvoiceCollectionReceipt.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { pharmacyCollectionInput } from "../schemas/pharmacyCollections.ts";
import { purchaseScope } from "./PharmacyPurchaseDraftService.ts";
import { appendInvoiceCollection, invoiceBalancePaise } from "./InvoicePaymentService.ts";
import { CommandError, executeRecordedCommand } from "./CommandReceiptService.ts";
import { createWithSession, withTransaction } from "../utilities/transaction.ts";
import { requireStockTransaction } from "../utilities/pharmacyInventory.ts";
import { pinActivePharmacyLocation } from "../utilities/pharmacyCapability.ts";
import { decryptField } from "../utilities/cryptoEnvelope.ts";
import { identifier } from "../schemas/pharmacyPurchases.ts";
import { claimCashierDrawer } from "./CashierDrawerService.ts";

type Scope = Awaited<ReturnType<typeof purchaseScope>>;
const receiptScope = (scope: Scope) => `pharmacy-collection:${scope.organizationId}:${scope.locationId}`;
export async function recoverPharmacyCollection(req: FastifyRequest, locationId: unknown, key: string) {
  const scope = await purchaseScope(req, locationId);
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(400, "Invalid collection reference");
  const saved = await OperationReceipt.findOne({ scope: receiptScope(scope), key }).select("+responseCiphertext").lean();
  if (!saved?.resultId || !saved.responseCiphertext) throw new CommandError(404, "No committed collection is visible. Keep the same reference and check again.");
  let snapshot: any;
  try { snapshot = JSON.parse(decryptField(saved.responseCiphertext)); } catch { throw new CommandError(409, "Collection result needs review"); }
  if (snapshot.actorId !== scope.actorId) throw new CommandError(404, "No committed collection is visible for this operator");
  if (snapshot.version !== 1 || snapshot.data?.receiptId !== String(saved.resultId) || !await Invoice.exists({ _id: snapshot.data.invoiceId, organizationId: scope.organizationId, locationId: scope.locationId, kind: "pharmacy" })) throw new CommandError(409, "Collection source or result needs review");
  return snapshot.data;
}
export async function collectPharmacyInvoice(req: FastifyRequest, rawId: string, full = false) {
  const input = pharmacyCollectionInput(req.body), invoiceId = identifier(rawId), scope = await purchaseScope(req, input.locationId), key = req.headers["idempotency-key"];
  if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(428, "A stable Idempotency-Key is required for collection");
  if (!await Invoice.exists({ _id: invoiceId, organizationId: scope.organizationId, locationId: scope.locationId, kind: "pharmacy", deletedAt: null })) throw new CommandError(404, "Counter invoice not found");
  const command = await executeRecordedCommand(receiptScope(scope), key, { actorId: scope.actorId, invoiceId, full, ...input }, () => withTransaction(async session => {
    requireStockTransaction(session);
    const invoice = await Invoice.findOne({ _id: invoiceId, organizationId: scope.organizationId, locationId: scope.locationId, kind: "pharmacy", deletedAt: null }).session(session);
    if (!invoice || invoice.currency !== "INR") throw new CommandError(404, "Counter invoice not found");
    const before = invoiceBalancePaise(invoice, true), revision = invoice.paymentRevision ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0 || revision !== input.expectedPaymentRevision || before.balancePaise !== input.expectedBalancePaise) throw new CommandError(409, "Collection balance or revision changed; reload before receiving more money");
    const drawer = await claimCashierDrawer(scope, invoice.currency, session);
    const receiptId = new mongoose.Types.ObjectId(), paidAt = new Date();
    const result = appendInvoiceCollection(invoice, input.entries, { key, actorId: scope.actorId, receiptId, shiftId: drawer!._id, paidAt, strictLedger: true });
    if ((full || invoice.customerSnapshot?.anonymous) && result.balancePaise !== 0) throw new CommandError(409, "Full settlement is required for an anonymous customer or full-pay command; identified customers may retain a balance");
    invoice.paymentRevision = revision + 1;
    await invoice.save({ session });
    const cash = input.entries.filter(entry => entry.paymentMethod === "cash").reduce((sum, entry) => sum + entry.amountPaise, 0), cashChangePaise = input.cashTenderedPaise - cash;
    const receipt = await createWithSession<InstanceType<typeof InvoiceCollectionReceipt>>(InvoiceCollectionReceipt, {
      _id: receiptId, organizationId: scope.organizationId, locationId: scope.locationId, invoiceId, invoiceNumber: invoice.invoiceNumber, actorId: scope.actorId,
      operationKey: key, currency: "INR", paidAt, ...result, creditedPaise: before.creditedPaise, revision: invoice.paymentRevision, shiftId: drawer!._id, drawerCode: drawer!.drawerCode,
      cashTenderedPaise: input.cashTenderedPaise, cashChangePaise, evidenceMode: "staff_confirmed_manual", entries: input.entries,
    }, session);
    await createWithSession(AuditLog, { userId: scope.actorId, organizationId: scope.organizationId, action: "PHARMACY_INVOICE_COLLECTION", category: "BILLING", targetModel: "InvoiceCollectionReceipt", targetId: receiptId,
      details: { invoiceId, collectedPaise: result.collectedPaise, balancePaise: result.balancePaise, revision: invoice.paymentRevision, receiptId } }, session);
    await pinActivePharmacyLocation(scope.locationId, session, false);
    const { _id, __v: _version, ...fields } = receipt.toObject();
    const data = { ...fields, receiptId: String(_id), invoiceId, requestKey: key };
    const saved = await OperationReceipt.updateOne({ scope: receiptScope(scope), key }, { $set: { responseCiphertext: JSON.stringify({ version: 1, actorId: scope.actorId, data }) } }).session(session);
    if (saved.matchedCount !== 1) throw new CommandError(409, "Collection reservation changed; keep the same reference");
    return String(receiptId);
  }), { writeConcern: { w: "majority" } });
  return { ...await recoverPharmacyCollection(req, input.locationId, key), replayed: command.replayed };
}
