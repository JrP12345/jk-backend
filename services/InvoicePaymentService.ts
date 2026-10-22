import mongoose from "mongoose";
import { collectionPaise } from "./TillCollectionService.ts";
import { CommandError } from "./CommandReceiptService.ts";

export function invoiceBalancePaise(invoice: any, requireLedger = false) {
  const total = collectionPaise(invoice.totalAmount), paid = collectionPaise(invoice.amountPaid ?? 0);
  if (total === null || paid === null || paid > total) throw new CommandError(409, "Invoice amounts require review before collection");
  const credited = invoice.kind === "pharmacy" ? invoice.creditedPaise ?? 0 : 0;
  if (!Number.isSafeInteger(credited) || credited < 0 || credited > total) throw new CommandError(409, "Invoice credits require review before collection");
  const balance = Math.max(0, total - paid - credited);
  const refunded = invoice.kind === "pharmacy" ? invoice.refundedPaise ?? 0 : 0, refundable = Math.max(0, paid - (total - credited));
  if (!Number.isSafeInteger(refunded) || refunded < 0 || refunded > refundable) throw new CommandError(409, "Invoice refund evidence requires review");
  if (invoice.balanceDue !== undefined && collectionPaise(invoice.balanceDue) !== balance) throw new CommandError(409, "Invoice balance does not reconcile");
  if (requireLedger) {
    let sum = 0n; const identities = new Set<string>();
    if (!Array.isArray(invoice.payments)) throw new CommandError(409, "Receipt ledger requires review");
    for (const payment of invoice.payments) {
      const amount = collectionPaise(payment.amount);
      if (amount === null || amount <= 0 || !payment.operationKey || identities.has(payment.operationKey)) throw new CommandError(409, "Receipt evidence requires review");
      identities.add(payment.operationKey); sum += BigInt(amount);
    }
    if (sum !== BigInt(paid)) throw new CommandError(409, "Receipt ledger differs from the paid balance");
  }
  return { totalPaise: total, paidPaise: paid, creditedPaise: credited, balancePaise: balance, refundedPaise: refunded, refundPayablePaise: refundable - refunded };
}
export interface CollectionEntry { componentId: string; amountPaise: number; paymentMethod: string; referenceNumber?: string; notes?: string }
/** Shared exact-money mutation. Caller authorizes and saves/audits inside its transaction. */
export function appendInvoiceCollection(invoice: any, entries: CollectionEntry[], context: { key: string; actorId: string; receiptId?: mongoose.Types.ObjectId; shiftId?: mongoose.Types.ObjectId; paidAt: Date; strictLedger?: boolean }) {
  if (["cancelled", "refunded"].includes(invoice.status)) throw new CommandError(409, "Invoice cannot accept collections");
  const balance = invoiceBalancePaise(invoice, context.strictLedger);
  if (!entries.length || entries.length > 10 || !Number.isFinite(context.paidAt.getTime())) throw new CommandError(400, "Invalid receipt components or collection date");
  if ((invoice.payments?.length || 0) + entries.length > 500) throw new CommandError(409, "Invoice receipt history reached its supported bound; use a reviewed settlement workflow");
  const ids = new Set<string>(); let collected = 0n;
  for (const entry of entries) {
    if (!entry.componentId || ids.has(entry.componentId) || !Number.isSafeInteger(entry.amountPaise) || entry.amountPaise <= 0) throw new CommandError(400, "Receipt components require distinct references and positive whole paise");
    ids.add(entry.componentId); collected += BigInt(entry.amountPaise);
  }
  if (collected > BigInt(balance.balancePaise)) throw new CommandError(409, "Collection exceeds the exact remaining invoice balance");
  const collectedPaise = Number(collected), paidPaise = balance.paidPaise + collectedPaise, balancePaise = balance.balancePaise - collectedPaise;
  invoice.amountPaid = paidPaise / 100; invoice.balanceDue = balancePaise / 100;
  invoice.status = balancePaise === 0 ? "paid" : "partially_paid";
  invoice.paymentMethod = entries.length === 1 ? entries[0].paymentMethod : "other";
  invoice.paymentDate = context.paidAt;
  invoice.payments ||= [];
  for (const entry of entries) invoice.payments.push({ amount: entry.amountPaise / 100, paymentMethod: entry.paymentMethod,
    operationKey: entries.length === 1 ? context.key : `${context.key}:${entry.componentId}`, componentId: entry.componentId,
    receiptId: context.receiptId, shiftId: context.shiftId, actorId: context.actorId, paidAt: context.paidAt, referenceNumber: entry.referenceNumber, notes: entry.notes });
  return { collectedPaise, paidPaise, balancePaise, status: invoice.status as "paid" | "partially_paid" };
}
