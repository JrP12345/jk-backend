import { Invoice } from "../models/Invoice.ts";
import { Organization } from "../models/Organization.ts";
import { getLocationTimezone, locationDateKey, locationDayRange } from "../utilities/locationTime.ts";
import { CommandError } from "./CommandReceiptService.ts";

export function collectionPaise(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const rounded = Math.round(value * 100);
  return Number.isSafeInteger(rounded) && Math.abs(value * 100 - rounded) < 0.000001 ? rounded : null;
}
function methodBucket(value: unknown): "cash" | "upi" | "card" | "other" | null {
  if (typeof value !== "string") return null;
  const method = value.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (method === "cash") return "cash";
  if (["upi", "upi qr", "qr", "soundbox", "bharatpe", "bharatpe upi"].includes(method)) return "upi";
  if (["card", "pos", "card pos"].includes(method)) return "card";
  if (["online", "net banking", "bank transfer", "cheque", "insurance", "other"].includes(method)) return "other";
  return null;
}
const validDate = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime());

/** Only committed Invoice.payments are receipts. Current invoice status never reverses a receipt. */
export async function collectTillReceipts(organizationId: string, locationId: string, requestedDate?: string, asOf = new Date()) {
  const timezone = await getLocationTimezone(locationId);
  let date: string, range: { start: Date; end: Date };
  try {
    date = requestedDate || locationDateKey(asOf, timezone);
    range = locationDayRange(date, timezone);
  } catch {
    throw new CommandError(requestedDate ? 400 : 409, "A valid collection date and configured location timezone are required");
  }
  const organization = await Organization.findById(organizationId).select("currency").lean();
  if (!organization?.currency) throw new CommandError(409, "Location collection currency requires review");
  const currency = organization.currency;
  // Include undated/corrupt payment evidence for review, never assigning it an updatedAt date.
  const candidateEvidence = [
    { "payments.paidAt": { $gte: range.start, $lte: range.end } },
    { payments: { $elemMatch: { paidAt: { $not: { $type: "date" } } } } },
    { paymentDate: { $gte: range.start, $lte: range.end } },
    { $and: [{ "payments.0": { $exists: false } }, { paymentDate: { $not: { $type: "date" } } },
      { $or: [{ amountPaid: { $gt: 0 } }, { status: { $in: ["paid", "partially_paid", "refunded"] } }] }] },
  ];
  const invoices = await Invoice.find({ organizationId, locationId, $or: candidateEvidence }).select("invoiceNumber payments amountPaid totalAmount paymentDate paymentMethod currency status deletedAt kind creditedPaise")
    .limit(10001).lean();
  if (invoices.length > 10000) throw new CommandError(409, "Collection evidence exceeds the review limit; use a reviewed reporting workflow");
  const totals = { cash: 0, upi: 0, card: 0, other: 0 };
  const contributing = new Set<string>(), issueKeys = new Set<string>();
  const issues: Array<{ invoiceId: string; invoiceNumber: string; reason: string }> = [];
  // The location is authorized by the caller. Only detect unowned evidence here; never adopt it
  // into this tenant's totals or expose its identifiers. Explicitly foreign ownership remains excluded.
  const unowned = await Invoice.exists({ locationId, organizationId: null, $and: [{ $or: candidateEvidence }, { $or: [
    { amountPaid: { $gt: 0 } }, { "payments.amount": { $gt: 0 } },
    { status: { $in: ["paid", "partially_paid", "refunded"] }, totalAmount: { $gt: 0 } },
  ] }] }).setOptions({ bypassTenantFilter: true });
  if (unowned) {
    issueKeys.add("unassigned_invoice_organization");
    issues.push({ invoiceId: "", invoiceNumber: "Unassigned branch payment records", reason: "missing_invoice_organization" });
  }
  let receiptCount = 0, legacyReceiptCount = 0;
  const issue = (invoice: any, reason: string) => {
    const key = `${invoice._id}:${reason}`;
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    if (issues.length < 20) issues.push({ invoiceId: String(invoice._id), invoiceNumber: invoice.invoiceNumber, reason });
  };
  const add = (invoice: any, amount: number, method: ReturnType<typeof methodBucket>, legacy = false) => {
    if (amount === 0) return;
    if (invoice.currency && invoice.currency !== currency) { issue(invoice, "different_currency"); return; }
    if (!method) { issue(invoice, "unknown_payment_method"); return; }
    if (!Number.isSafeInteger(totals[method] + amount)) throw new CommandError(409, "Collection totals exceed the supported amount bound");
    totals[method] += amount;
    contributing.add(String(invoice._id)); receiptCount++; if (legacy) legacyReceiptCount++;
    if (invoice.status === "refunded" || invoice.status === "cancelled" || invoice.deletedAt) issue(invoice, "reversal_or_deleted_invoice");
  };
  const inDay = (paidAt: Date) => paidAt >= range.start && paidAt <= range.end;
  for (const invoice of invoices) {
    const payments = invoice.payments;
    if (payments != null && !Array.isArray(payments)) { issue(invoice, "invalid_receipt_ledger"); continue; }
    if (payments?.length) {
      const ids = new Set<string>(), keys = new Set<string>();
      let ledgerTotal = 0, validLedger = true, relevant = false;
      for (const payment of payments) {
        const at = payment?.paidAt;
        if (!validDate(at)) { issue(invoice, "missing_receipt_date"); relevant = true; }
        const amount = collectionPaise(payment?.amount);
        const isRelevant = !validDate(at) || inDay(at);
        relevant ||= isRelevant;
        if (amount === null) { validLedger = false; if (isRelevant) issue(invoice, "invalid_receipt_amount"); continue; }
        const id = payment?._id ? String(payment._id) : undefined;
        const key = typeof payment?.operationKey === "string" && payment.operationKey ? payment.operationKey : undefined;
        if ((id && ids.has(id)) || (key && keys.has(key))) { validLedger = false; if (isRelevant) issue(invoice, "duplicate_receipt_identity"); continue; }
        if (id) ids.add(id); if (key) keys.add(key);
        ledgerTotal += amount;
        if (!Number.isSafeInteger(ledgerTotal)) throw new CommandError(409, "Receipt ledger exceeds the supported amount bound");
        if (!validDate(at) || !inDay(at)) continue;
        if (at > asOf) { if (at > new Date()) issue(invoice, "future_receipt_date"); continue; }
        add(invoice, amount, methodBucket(payment.paymentMethod));
      }
      if (relevant && (!validLedger || collectionPaise(invoice.amountPaid) !== ledgerTotal)) issue(invoice, "receipt_balance_mismatch");
      continue; // Never fill gaps from invoice-level dates/methods when any receipt entries exist.
    }
    const amount = collectionPaise(invoice.amountPaid), total = collectionPaise(invoice.totalAmount);
    if (amount === 0 && total === 0) continue; // Zero-fee/waiver is not money received.
    if (invoice.kind === "pharmacy" && amount === 0 && invoice.status === "paid" && invoice.creditedPaise === total) continue; // Full commercial credit is not money received.
    if (amount === 0 && invoice.status === "unpaid") continue;
    if (validDate(invoice.paymentDate) && !inDay(invoice.paymentDate)) continue;
    if (invoice.status !== "paid" || amount === null || !amount || total === null || amount !== total || !validDate(invoice.paymentDate)) {
      issue(invoice, "incomplete_legacy_payment_evidence"); continue;
    }
    if (invoice.paymentDate > asOf) { if (invoice.paymentDate > new Date()) issue(invoice, "future_receipt_date"); continue; }
    add(invoice, amount, methodBucket(invoice.paymentMethod), true);
  }
  const total = totals.cash + totals.upi + totals.card + totals.other;
  if (!Number.isSafeInteger(total)) throw new CommandError(409, "Collection totals exceed the supported amount bound");
  return { date, locationId, collectionBasis: "receipt_v1" as const, timezone, currency, asOf,
    periodStart: range.start, periodEnd: range.end,
    systemTotals: { cash: totals.cash / 100, upi: totals.upi / 100, card: totals.card / 100, other: totals.other / 100,
      total: total / 100, invoiceCount: contributing.size, receiptCount, legacyReceiptCount },
    reconciliation: { requiresReview: issueKeys.size > 0, issueCount: issueKeys.size, issues, truncated: issueKeys.size > issues.length },
  };
}
