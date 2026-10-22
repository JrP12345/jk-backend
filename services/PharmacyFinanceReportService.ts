import { Invoice } from "../models/Invoice.ts";
import { InvoiceCollectionReceipt } from "../models/InvoiceCollectionReceipt.ts";
import { InvoiceCreditNote } from "../models/InvoiceCreditNote.ts";
import { PharmacyPurchase } from "../models/PharmacyPurchase.ts";
import { PharmacyPurchaseReturn } from "../models/PharmacyPurchaseReturn.ts";
import { PharmacyOpeningBalance } from "../models/PharmacyOpeningBalance.ts";
import { PharmacyCashEvent } from "../models/PharmacyCashEvent.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { Medicine } from "../models/Medicine.ts";
import { invoiceBalancePaise } from "./InvoicePaymentService.ts";
import { supplierOpeningBalance, supplierPurchaseBalance } from "./PharmacySettlementService.ts";
import { CommandError } from "./CommandReceiptService.ts";
import { reportColumns, reportDate, requireReportBound, sourcePage, type ReportContext, type ReportResult, type ReportRow } from "./PharmacyReportTypes.ts";

export async function financeReport(ctx: ReportContext): Promise<ReportResult> {
  const { input, scope, session, start, end } = ctx;
  const owner = { organizationId: scope.organizationId, locationId: scope.locationId }, after = input.cursor ? { _id: { $gt: input.cursor } } : {};
  const dates = { $gte: start, $lte: end }, query = async (model: any, filter: object, select: string): Promise<any[]> => model.find(filter).select(select).sort({ _id: 1 }).limit(input.limit + 1).maxTimeMS(5000).session(session).lean();
  if (["sales", "customer_dues", "tax"].includes(input.kind)) {
    const sources = await query(Invoice, { ...owner, kind: "pharmacy", deletedAt: null, ...(input.kind === "customer_dues" ? {} : { issuedAt: dates, documentVersion: { $in: [1, 2] } }), ...after }, "kind invoiceNumber currency documentVersion issuedAt totalAmount amountPaid balanceDue creditedPaise refundedPaise payments.amount payments.operationKey calculation.totals calculation.policy taxDocument.kind");
    const { page, nextCursor } = sourcePage(sources, input); requireReportBound(page.flatMap((row: any) => row.payments || []));
    const refunds = await PharmacyCashEvent.find({ ...owner, kind: "customer_refund", domain: "pharmacy", invoiceId: { $in: page.map(row => row._id) } }).select("invoiceId amountPaise currency").limit(2001).maxTimeMS(5000).session(session).lean(); requireReportBound(refunds);
    const rows: ReportRow[] = page.map((invoice: any) => {
      if (invoice.currency !== "INR") throw new CommandError(409, "Invoice report currency requires review");
      const balance = invoiceBalancePaise(invoice, true);
      const payouts = refunds.filter(row => String(row.invoiceId) === String(invoice._id));
      if (payouts.some(row => row.currency !== "INR") || payouts.reduce((sum, row) => sum + BigInt(row.amountPaise), 0n) !== BigInt(balance.refundedPaise)) throw new CommandError(409, "Invoice refund projection differs from confirmed payout evidence");
      const base: ReportRow = { id: String(invoice._id), number: invoice.invoiceNumber, issuedAt: reportDate(invoice.issuedAt), document: invoice.documentVersion === 3 ? "Opening debt statement" : invoice.taxDocument?.kind || "Unclassified supply", totalPaise: balance.totalPaise, paidPaise: balance.paidPaise, creditedPaise: balance.creditedPaise, duePaise: balance.balancePaise, refundedPaise: balance.refundedPaise, refundPayablePaise: balance.refundPayablePaise };
      if (input.kind === "tax") {
        const amounts = invoice.calculation?.totals, keys = ["baseAmountPaise", "cgstPaise", "sgstPaise", "utgstPaise", "igstPaise", "unallocatedTaxPaise", "payablePaise", "roundOffPaise"];
        const known = amounts && invoice.calculation.policy && keys.every(key => Number.isSafeInteger(amounts[key])) && amounts.payablePaise === balance.totalPaise;
        return { id: base.id, number: base.number, issuedAt: base.issuedAt, document: base.document, ...Object.fromEntries(keys.map(key => [key, known ? amounts[key] : null])), review: known ? "Captured supply; credit adjustments and filing need separate review" : "Captured calculation evidence unavailable; do not reprice" };
      }
      return base;
    }).filter((row: ReportRow) => input.kind !== "customer_dues" || Number(row.duePaise) > 0 || Number(row.refundPayablePaise) > 0);
    const columns = input.kind === "tax" ? reportColumns([["number", "Supply document"], ["issuedAt", "Issued", "date"], ["document", "Document kind"], ["baseAmountPaise", "Captured base (INR)", "paise"], ["cgstPaise", "CGST (INR)", "paise"], ["sgstPaise", "SGST (INR)", "paise"], ["utgstPaise", "UTGST (INR)", "paise"], ["igstPaise", "IGST (INR)", "paise"], ["unallocatedTaxPaise", "Unallocated tax (INR)", "paise"], ["roundOffPaise", "Round-off (INR)", "paise"], ["payablePaise", "Original payable (INR)", "paise"], ["review", "Review"]]) : reportColumns([["number", "Document"], ["issuedAt", "Issued", "date"], ["document", "Document kind"], ["totalPaise", "Original payable (INR)", "paise"], ["paidPaise", "Gross received to date (INR)", "paise"], ["creditedPaise", "Credit to date (INR)", "paise"], ["duePaise", "Current due (INR)", "paise"], ["refundedPaise", "Refunded to date (INR)", "paise"], ["refundPayablePaise", "Current refund payable (INR)", "paise"]]);
    return { rows, nextCursor, scanned: page.length, columns, basis: input.kind === "customer_dues" ? "Current outstanding pharmacy invoice and opening-debt balances, independent of issue date. Paid/refund totals are lifetime-to-read, not collections in the selected period." : input.kind === "tax" ? "Captured original supply amounts by issue time; opening debts are excluded. Commercial credit notes remain a separate report and require professional review before tax adjustment. This is not a GST return or filing." : "Original pharmacy supplies issued in the selected local-date interval; opening debts are excluded. Received, credited, due and refunded columns show current lifetime balances, not period cash flows." };
  }
  if (input.kind === "collections") {
    const sources = await query(InvoiceCollectionReceipt, { ...owner, paidAt: dates, ...after }, "invoiceId invoiceNumber actorId shiftId drawerCode paidAt entries collectedPaise cashTenderedPaise cashChangePaise currency operationKey");
    const { page, nextCursor } = sourcePage(sources, input), rows: ReportRow[] = [];
    const invoices = await Invoice.find({ ...owner, kind: "pharmacy", _id: { $in: page.map(row => row.invoiceId) } }).select("invoiceNumber currency payments totalAmount amountPaid balanceDue creditedPaise refundedPaise kind").limit(26).maxTimeMS(5000).session(session).lean();
    requireReportBound(invoices.flatMap((invoice: any) => invoice.payments || []));
    for (const receipt of page as any[]) {
      if (receipt.currency !== "INR" || !receipt.shiftId || !receipt.entries?.length || new Set(receipt.entries.map((row: any) => row.componentId)).size !== receipt.entries.length || receipt.entries.reduce((sum: number, row: any) => sum + row.amountPaise, 0) !== receipt.collectedPaise) throw new CommandError(409, "Collection receipt report evidence needs review");
      const invoice: any = invoices.find(row => String(row._id) === String(receipt.invoiceId));
      if (!invoice || invoice.currency !== "INR" || invoice.invoiceNumber !== receipt.invoiceNumber) throw new CommandError(409, "Collection invoice source needs review");
      invoiceBalancePaise(invoice, true);
      const payments = invoice.payments.filter((payment: any) => String(payment.receiptId) === String(receipt._id));
      if (payments.length !== receipt.entries.length || receipt.entries.some((entry: any) => !payments.some((payment: any) => payment.componentId === entry.componentId && payment.operationKey === (receipt.entries.length === 1 ? receipt.operationKey : `${receipt.operationKey}:${entry.componentId}`) && Math.round(payment.amount * 100) === entry.amountPaise && payment.paymentMethod === entry.paymentMethod && (payment.referenceNumber || "") === (entry.referenceNumber || "") && String(payment.shiftId) === String(receipt.shiftId) && String(payment.actorId) === String(receipt.actorId) && payment.paidAt.getTime() === receipt.paidAt.getTime()))) throw new CommandError(409, "Collection components differ from their saved invoice ledger");
      for (const entry of receipt.entries) rows.push({ id: `${receipt._id}:${entry.componentId}`, receiptId: String(receipt._id), number: receipt.invoiceNumber, collectedAt: reportDate(receipt.paidAt), method: entry.paymentMethod, receivedPaise: entry.amountPaise, reference: entry.referenceNumber || "", drawer: receipt.drawerCode, actorId: String(receipt.actorId) });
    }
    return { rows, nextCursor, scanned: page.length, columns: reportColumns([["receiptId", "Receipt"], ["number", "Document"], ["collectedAt", "Collected", "date"], ["method", "Actual method"], ["receivedPaise", "Net amount received (INR)", "paise"], ["reference", "Actual payment reference"], ["drawer", "Drawer"], ["actorId", "Operator"]]), basis: "Confirmed pharmacy receipt components by actual collection time, including opening-debt collections. Cash is net of change. Original supply turnover, refunds and generic clinical receipts are separate." };
  }
  if (input.kind === "supplier_dues") {
    const opening = input.cursor?.startsWith("o:"), rawCursor = input.cursor?.slice(2), position = rawCursor && rawCursor !== "start" ? { _id: { $gt: rawCursor } } : {};
    const sources = opening ? await query(PharmacyOpeningBalance, { ...owner, kind: "supplier_due", ...position }, "partyId statementNumber sourceDate amountPaise kind settlementRevision") : await query(PharmacyPurchase, { ...owner, status: "posted", ...position }, "supplierId supplierInvoiceNumber currency status posting.payablePaise settlementRevision");
    const { page, nextCursor: more } = sourcePage(sources, input), ids = page.map(row => row._id), field = opening ? "allocations.openingBalanceId" : "allocations.purchaseId";
    const events = await PharmacyCashEvent.find({ ...owner, [field]: { $in: ids } }).select("partyId kind allocations").limit(2001).maxTimeMS(5000).session(session).lean(); requireReportBound(events);
    const returns = opening ? [] : await PharmacyPurchaseReturn.find({ ...owner, purchaseId: { $in: ids } }).select("purchaseId expectedCreditPaise").limit(2001).maxTimeMS(5000).session(session).lean(); requireReportBound(returns);
    const rows: ReportRow[] = [];
    for (const source of page as any[]) {
      const related = events.filter(event => event.allocations.some(row => String(opening ? row.openingBalanceId : row.purchaseId) === String(source._id)));
      const balance = opening ? await supplierOpeningBalance(source, scope, session, related) : await supplierPurchaseBalance(source, scope, session, { events: related, returns: returns.filter(row => String(row.purchaseId) === String(source._id)) });
      if (!balance.duePaise && !balance.supplierRefundReceivablePaise && !balance.pendingCreditPaise) continue;
      rows.push({ id: String(source._id), number: opening ? source.statementNumber : source.supplierInvoiceNumber, supplierId: String(opening ? source.partyId : source.supplierId), source: opening ? "Opening due" : "Posted bill", payablePaise: balance.payablePaise, confirmedCreditPaise: balance.confirmedCreditPaise, pendingCreditPaise: balance.pendingCreditPaise, paidPaise: balance.paidPaise, duePaise: balance.duePaise, receivablePaise: balance.supplierRefundReceivablePaise });
    }
    const nextCursor = more ? `${opening ? "o" : "p"}:${more}` : !opening && await PharmacyOpeningBalance.exists({ ...owner, kind: "supplier_due" }).session(session).maxTimeMS(5000) ? "o:start" : null;
    return { rows, nextCursor, scanned: page.length, columns: reportColumns([["number", "Source document"], ["supplierId", "Supplier ID"], ["source", "Source kind"], ["payablePaise", "Original payable (INR)", "paise"], ["confirmedCreditPaise", "Confirmed credit (INR)", "paise"], ["pendingCreditPaise", "Pending expected credit (INR)", "paise"], ["paidPaise", "Paid to date (INR)", "paise"], ["duePaise", "Current due (INR)", "paise"], ["receivablePaise", "Refund receivable (INR)", "paise"]]), basis: "Current obligations and lifetime settlements, independent of invoice date. Posted bills are paged first, then reviewed supplier opening dues. Expected credits remain pending and do not reduce due until confirmed." };
  }
  if (input.kind === "movements") {
    const sources = await query(StockMovement, { ...owner, createdAt: dates, ...after }, "medicineId kind stockMode beforeQuantity afterQuantity quantityDelta revision disposition createdAt actorId"), { page, nextCursor } = sourcePage(sources, input);
    const medicines = await Medicine.find({ _id: { $in: page.map(row => row.medicineId) }, locationId: scope.locationId }).select("name").limit(26).maxTimeMS(5000).session(session).lean();
    return { rows: page.map((row: any) => ({ id: String(row._id), product: medicines.find(m => String(m._id) === String(row.medicineId))?.name || "Unavailable product", medicineId: String(row.medicineId), kind: row.kind, before: row.beforeQuantity, delta: row.quantityDelta, after: row.afterQuantity, revision: row.revision, disposition: row.disposition, recordedAt: reportDate(row.createdAt) })), nextCursor, scanned: page.length, columns: reportColumns([["product", "Product"], ["medicineId", "Product ID"], ["kind", "Movement"], ["before", "Before", "integer"], ["delta", "Change", "integer"], ["after", "After", "integer"], ["revision", "Stock revision", "integer"], ["disposition", "Disposition"], ["recordedAt", "Recorded", "date"]]), basis: "Append-only physical movements by recorded time. Quantities retain their source product basis; unlike product units are not summed. Use source stock revisions to reconcile consecutive movements." };
  }
  const config = input.kind === "purchases" ? { model: PharmacyPurchase, filter: { status: "posted", "posting.postedAt": dates }, select: "supplierInvoiceNumber invoiceDate posting.postedAt posting.payablePaise currency" } : input.kind === "purchase_returns" ? { model: PharmacyPurchaseReturn, filter: { createdAt: dates }, select: "supplierInvoiceNumber purchaseId createdAt expectedCreditPaise" } : input.kind === "sales_returns" ? { model: InvoiceCreditNote, filter: { issuedAt: dates }, select: "creditNoteNumber sourceInvoiceNumber issuedAt payablePaise baseAmountPaise cgstPaise sgstPaise roundOffPaise taxAdjustment" } : { model: PharmacyCashEvent, filter: { recordedAt: dates, kind: { $in: ctx.cashKinds } }, select: "kind direction amountPaise paymentMethod referenceNumber recordedAt actorId drawerCode currency" };
  const sources = await query(config.model, { ...owner, ...config.filter, ...(input.kind === "cash_events" ? { domain: "pharmacy" } : {}), ...after }, config.select), { page, nextCursor } = sourcePage(sources, input);
  let columns: ReportResult["columns"], rows: ReportRow[], basis: string;
  if (input.kind === "purchases") {
    columns = reportColumns([["number", "Supplier bill"], ["invoiceDate", "Source invoice date"], ["postedAt", "Posted", "date"], ["payablePaise", "Original payable (INR)", "paise"]]);
    rows = page.map((row: any) => ({ id: String(row._id), number: row.supplierInvoiceNumber, invoiceDate: row.invoiceDate, postedAt: reportDate(row.posting?.postedAt), payablePaise: row.posting?.payablePaise ?? null })); basis = "Immutable posted supplier obligations by posting time; these are not stock receipts or supplier payments.";
  } else if (input.kind === "purchase_returns") {
    columns = reportColumns([["number", "Original supplier bill"], ["purchaseId", "Purchase ID"], ["recordedAt", "Goods returned", "date"], ["expectedCreditPaise", "Expected credit (INR)", "paise"]]);
    rows = page.map((row: any) => ({ id: String(row._id), number: row.supplierInvoiceNumber, purchaseId: String(row.purchaseId), recordedAt: reportDate(row.createdAt), expectedCreditPaise: row.expectedCreditPaise })); basis = "Physical supplier returns and expected credit by return time. Expected credit is not confirmed credit, money received or a tax adjustment.";
  } else if (input.kind === "sales_returns") {
    columns = reportColumns([["number", "Commercial credit note"], ["invoice", "Original invoice"], ["recordedAt", "Credit issued", "date"], ["basePaise", "Source base (INR)", "paise"], ["cgstPaise", "Source CGST (INR)", "paise"], ["sgstPaise", "Source SGST (INR)", "paise"], ["roundOffPaise", "Source rounding (INR)", "paise"], ["creditPaise", "Commercial credit (INR)", "paise"], ["taxAdjustment", "Tax review"]]);
    rows = page.map((row: any) => ({ id: String(row._id), number: row.creditNoteNumber, invoice: row.sourceInvoiceNumber, recordedAt: reportDate(row.issuedAt), basePaise: row.baseAmountPaise, cgstPaise: row.cgstPaise, sgstPaise: row.sgstPaise, roundOffPaise: row.roundOffPaise, creditPaise: row.payablePaise, taxAdjustment: row.taxAdjustment })); basis = "Commercial source-bound credit notes by issue time. Returned stock stays quarantined; payouts and professional tax adjustment review remain separate.";
  } else {
    columns = reportColumns([["kind", "Event"], ["direction", "Money direction"], ["method", "Method"], ["amountPaise", "Document/event amount (INR)", "paise"], ["inPaise", "Actual inflow (INR)", "paise"], ["outPaise", "Actual outflow (INR)", "paise"], ["reference", "Actual reference"], ["drawer", "Drawer"], ["recordedAt", "Recorded", "date"]]);
    rows = page.map((row: any) => { if (row.currency !== "INR") throw new CommandError(409, "Cash-event currency needs review"); return { id: String(row._id), kind: row.kind, direction: row.direction, method: row.paymentMethod, amountPaise: row.amountPaise, inPaise: row.direction === "in" ? row.amountPaise : 0, outPaise: row.direction === "out" ? row.amountPaise : 0, reference: row.referenceNumber, drawer: row.drawerCode || "Document only", recordedAt: reportDate(row.recordedAt) }; }); basis = "Actual supplier/customer money movements and cash in/out by recording time. Supplier credit documents have direction none and zero cash flow. Customer incoming collections stay in the separate receipt report.";
  }
  return { rows, columns, nextCursor, scanned: page.length, basis };
}
