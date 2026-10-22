import mongoose from "mongoose";
import type { FastifyRequest } from "fastify";
import { PharmacyCashEvent } from "../models/PharmacyCashEvent.ts";
import { PharmacyPurchaseReturn } from "../models/PharmacyPurchaseReturn.ts";
import { PharmacyPurchase } from "../models/PharmacyPurchase.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { PharmacyOpeningBalance } from "../models/PharmacyOpeningBalance.ts";
import { Invoice } from "../models/Invoice.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { settlementInput, type SettlementKind } from "../schemas/pharmacySettlements.ts";
import { identifier } from "../schemas/pharmacyPurchases.ts";
import { purchaseScope } from "./PharmacyPurchaseDraftService.ts";
import { pharmacyRequestAllows } from "./PharmacyCapabilityService.ts";
import { invoiceBalancePaise } from "./InvoicePaymentService.ts";
import { CommandError, executeRecordedCommand } from "./CommandReceiptService.ts";
import { createWithSession, withTransaction } from "../utilities/transaction.ts";
import { requireStockTransaction } from "../utilities/pharmacyInventory.ts";
import { pinPharmacyContinuityLocation } from "../utilities/pharmacyCapability.ts";
import { indiaFinancialYear } from "../utilities/invoiceNumber.ts";
import { decryptField } from "../utilities/cryptoEnvelope.ts";
import { locationDateKey, getLocationTimezone } from "../utilities/locationTime.ts";
import { claimCashierDrawer, drawerLedger } from "./CashierDrawerService.ts";

type Scope = Awaited<ReturnType<typeof purchaseScope>>;
const operationScope = (scope: Scope) => `pharmacy-cash-event:${scope.organizationId}:${scope.locationId}`;
function bounded(value: bigint) { if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new CommandError(409, "Settlement amounts need review"); return Number(value); }
function supplierAmounts(total: number, expectedCredit: bigint | null, events: any[], partyId: string, sourceId: string, sourceField: "purchaseId" | "openingBalanceId") {
  let credit = 0n, payment = 0n, refunded = 0n;
  for (const event of events) {
    if (String(event.partyId) !== partyId) throw new CommandError(409, "Supplier event ownership needs review");
    for (const row of event.allocations.filter((row: any) => String(row[sourceField]) === sourceId)) {
      if (event.kind === "supplier_credit") credit += BigInt(row.amountPaise);
      else if (event.kind === "supplier_payment") payment += BigInt(row.amountPaise);
      else if (event.kind === "supplier_refund") refunded += BigInt(row.amountPaise);
      else throw new CommandError(409, "Unexpected supplier settlement evidence");
    }
  }
  const gross = BigInt(total), expected = expectedCredit ?? credit;
  if (credit > expected || credit > gross || refunded > credit + payment || payment > gross) throw new CommandError(409, "Supplier credit/payment evidence does not reconcile");
  const signed = gross - credit - payment + refunded;
  return { payablePaise: bounded(gross), confirmedCreditPaise: bounded(credit), expectedCreditPaise: bounded(expected), pendingCreditPaise: bounded(expected - credit), paidPaise: bounded(payment), supplierRefundedPaise: bounded(refunded), duePaise: bounded(signed > 0n ? signed : 0n), supplierRefundReceivablePaise: bounded(signed < 0n ? -signed : 0n) };
}
export async function supplierPurchaseBalance(purchase: any, scope: Scope, session: mongoose.ClientSession | null, existing?: { events: any[]; returns: any[] }) {
  if (purchase.status !== "posted" || !purchase.posting || purchase.currency !== "INR") throw new CommandError(409, "Supplier source is not a posted INR payable");
  const events = existing?.events || await PharmacyCashEvent.find({ organizationId: scope.organizationId, locationId: scope.locationId, "allocations.purchaseId": purchase._id }).limit(1001).session(session).lean();
  const returns = existing?.returns || await PharmacyPurchaseReturn.find({ organizationId: scope.organizationId, locationId: scope.locationId, purchaseId: purchase._id }).limit(1001).session(session).lean();
  if (events.length > 1000 || returns.length > 1000) throw new CommandError(409, "Supplier settlement history exceeds its review bound");
  const expected = returns.reduce((sum: bigint, row: any) => sum + BigInt(row.expectedCreditPaise), 0n);
  return { purchaseId: String(purchase._id), supplierInvoiceNumber: purchase.supplierInvoiceNumber, ...supplierAmounts(purchase.posting.payablePaise, expected, events, String(purchase.supplierId), String(purchase._id), "purchaseId"), settlementRevision: purchase.settlementRevision };
}
export async function supplierOpeningBalance(opening: any, scope: Scope, session: mongoose.ClientSession | null, existing?: any[]) {
  const events = existing || await PharmacyCashEvent.find({ organizationId: scope.organizationId, locationId: scope.locationId, "allocations.openingBalanceId": opening._id }).limit(1001).session(session).lean();
  if (opening.kind !== "supplier_due" || events.length > 1000) throw new CommandError(409, "Supplier opening balance source/history needs review");
  return { openingBalanceId: String(opening._id), statementNumber: opening.statementNumber, sourceDate: opening.sourceDate, ...supplierAmounts(opening.amountPaise, null, events, String(opening.partyId), String(opening._id), "openingBalanceId"), settlementRevision: opening.settlementRevision };
}
export async function refundableInvoice(scope: Scope, id: string, session: mongoose.ClientSession | null) {
  const invoice = await Invoice.findOne({ _id: id, kind: "pharmacy", organizationId: scope.organizationId, locationId: scope.locationId, deletedAt: null }).session(session);
  if (!invoice || invoice.currency !== "INR") throw new CommandError(404, "Counter invoice not found");
  const balance = invoiceBalancePaise(invoice, true), refunds = await PharmacyCashEvent.find({ organizationId: scope.organizationId, locationId: scope.locationId, invoiceId: invoice._id, kind: "customer_refund" }).limit(501).session(session).lean();
  if (refunds.length > 500 || refunds.reduce((sum, row) => sum + BigInt(row.amountPaise), 0n) !== BigInt(balance.refundedPaise)) throw new CommandError(409, "Confirmed refund ledger needs review");
  return { invoice, balance, refunds };
}
export async function readInvoiceRefundSource(req: FastifyRequest, rawId: string, locationId: unknown) {
  const scope = await purchaseScope(req, locationId), id = identifier(rawId);
  return withTransaction(async session => {
    const source = await refundableInvoice(scope, id, session);
    return { invoiceId: id, invoiceNumber: source.invoice.invoiceNumber, locationId: scope.locationId, customerName: source.invoice.taxDocument?.recipient?.name || source.invoice.customerSnapshot?.name || "Recorded customer", currency: "INR", paymentRevision: source.invoice.paymentRevision, ...source.balance,
      refunds: source.refunds.map(({ _id, amountPaise, referenceNumber, paymentMethod, recordedAt }) => ({ id: String(_id), amountPaise, referenceNumber, paymentMethod, recordedAt })) };
  }, { readConcern: { level: "snapshot" } });
}
export async function readSupplierStatement(req: FastifyRequest, rawId: string, locationId: unknown) {
  const scope = await purchaseScope(req, locationId), supplierId = identifier(rawId);
  return withTransaction(async session => {
    const party = await PharmacyParty.findOne({ _id: supplierId, organizationId: scope.organizationId, locationIds: scope.locationId, kinds: "supplier" }).session(session);
    if (!party) throw new CommandError(404, "Supplier not found");
    const purchases = await PharmacyPurchase.find({ organizationId: scope.organizationId, locationId: scope.locationId, supplierId, status: "posted" }).limit(1001).session(session);
    const events = await PharmacyCashEvent.find({ organizationId: scope.organizationId, locationId: scope.locationId, partyId: supplierId }).limit(10001).session(session).lean();
    const returns = await PharmacyPurchaseReturn.find({ organizationId: scope.organizationId, locationId: scope.locationId, supplierId }).limit(10001).session(session).lean();
    const openings = await PharmacyOpeningBalance.find({ organizationId: scope.organizationId, locationId: scope.locationId, partyId: supplierId, kind: "supplier_due" }).limit(1001).session(session);
    if (purchases.length > 1000 || events.length > 10000 || returns.length > 10000 || openings.length > 1000) throw new CommandError(409, "Supplier statement exceeds its review bound; use a bounded report");
    const rows: any[] = [];
    for (const purchase of purchases) rows.push(await supplierPurchaseBalance(purchase, scope, session, { events: events.filter(event => event.allocations.some(row => String(row.purchaseId) === String(purchase._id))), returns: returns.filter(row => String(row.purchaseId) === String(purchase._id)) }));
    const openingRows: any[] = [];
    for (const opening of openings) openingRows.push(await supplierOpeningBalance(opening, scope, session, events.filter(event => event.allocations.some(row => String(row.openingBalanceId) === String(opening._id)))));
    const sum = (key: string) => bounded([...rows, ...openingRows].reduce((sum, row) => sum + BigInt(row[key]), 0n));
    return { supplierId, supplierName: party.name, locationId: scope.locationId, currency: "INR", purchases: rows, openingBalances: openingRows, returns: returns.map(({ _id, purchaseId, expectedCreditPaise, createdAt }) => ({ id: String(_id), purchaseId: String(purchaseId), expectedCreditPaise, createdAt,
      confirmedCreditPaise: bounded(events.filter(event => event.kind === "supplier_credit").flatMap(event => event.allocations).filter(row => String(row.purchaseReturnId) === String(_id)).reduce((sum, row) => sum + BigInt(row.amountPaise), 0n)) })),
      totals: { openingDuePaise: bounded(openingRows.reduce((sum, row) => sum + BigInt(row.payablePaise), 0n)), payablePaise: sum("payablePaise"), confirmedCreditPaise: sum("confirmedCreditPaise"), pendingCreditPaise: sum("pendingCreditPaise"), paidPaise: sum("paidPaise"), supplierRefundedPaise: sum("supplierRefundedPaise"), duePaise: sum("duePaise"), supplierRefundReceivablePaise: sum("supplierRefundReceivablePaise") } };
  }, { readConcern: { level: "snapshot" } });
}
export async function readCustomerStatement(req: FastifyRequest, rawId: string, locationId: unknown) {
  const scope = await purchaseScope(req, locationId), customerId = identifier(rawId);
  return withTransaction(async session => {
    const party = await PharmacyParty.findOne({ _id: customerId, organizationId: scope.organizationId, locationIds: scope.locationId, kinds: "customer" }).session(session);
    if (!party) throw new CommandError(404, "Customer not found");
    const invoices = await Invoice.find({ kind: "pharmacy", organizationId: scope.organizationId, locationId: scope.locationId, "customerSnapshot.partyId": customerId, deletedAt: null }).limit(1001).session(session);
    const refunds = await PharmacyCashEvent.find({ kind: "customer_refund", organizationId: scope.organizationId, locationId: scope.locationId, partyId: customerId }).limit(10001).session(session).lean();
    if (invoices.length > 1000 || refunds.length > 10000) throw new CommandError(409, "Customer statement exceeds its review bound");
    const rows = invoices.map(invoice => {
      const balance = invoiceBalancePaise(invoice, true), recorded = refunds.filter(row => String(row.invoiceId) === String(invoice._id)).reduce((sum, row) => sum + BigInt(row.amountPaise), 0n);
      if (recorded !== BigInt(balance.refundedPaise)) throw new CommandError(409, "Customer refund ledger needs review");
      return { invoiceId: String(invoice._id), invoiceNumber: invoice.invoiceNumber, documentVersion: invoice.documentVersion, openingBalanceId: invoice.openingBalanceId ? String(invoice.openingBalanceId) : undefined, paymentRevision: invoice.paymentRevision, ...balance };
    });
    const sum = (key: keyof typeof rows[number]) => bounded(rows.reduce((sum, row) => sum + BigInt(row[key] as number), 0n));
    return { customerId, customerName: party.name, locationId: scope.locationId, currency: "INR", invoices: rows, totals: { totalPaise: sum("totalPaise"), paidPaise: sum("paidPaise"), creditedPaise: sum("creditedPaise"), duePaise: sum("balancePaise"), refundedPaise: sum("refundedPaise"), refundPayablePaise: sum("refundPayablePaise") } };
  }, { readConcern: { level: "snapshot" } });
}
export async function recoverSettlement(req: FastifyRequest, locationId: unknown, key: string) {
  const scope = await purchaseScope(req, locationId);
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(400, "Invalid settlement reference");
  const record = await OperationReceipt.findOne({ scope: operationScope(scope), key }).select("+responseCiphertext").lean();
  if (!record?.resultId || !record.responseCiphertext) throw new CommandError(404, "No committed settlement is visible. Keep the same reference.");
  let saved: any; try { saved = JSON.parse(decryptField(record.responseCiphertext)); } catch { throw new CommandError(409, "Settlement result needs review"); }
  if (saved.actorId !== scope.actorId) throw new CommandError(404, "No settlement is visible for this operator");
  if (saved.version !== 1 || saved.data?.eventId !== String(record.resultId)) throw new CommandError(409, "Settlement evidence needs review");
  if (!await pharmacyRequestAllows(req, saved.data.kind === "customer_refund" ? "viewReturns" : "viewPurchases")) throw new CommandError(403, "Settlement history permission is required");
  if (!await PharmacyCashEvent.exists({ _id: record.resultId, organizationId: scope.organizationId, locationId: scope.locationId })) throw new CommandError(409, "Settlement source needs review");
  return saved.data;
}
export async function recordSettlement(req: FastifyRequest, kind: SettlementKind) {
  const input = settlementInput(req.body, kind), scope = await purchaseScope(req, input.locationId), key = req.headers["idempotency-key"];
  if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(428, "A stable Idempotency-Key is required for settlement");
  const command = await executeRecordedCommand(operationScope(scope), key, { actorId: scope.actorId, kind, ...input }, () => withTransaction(async session => {
    requireStockTransaction(session);
    const drawer = kind === "supplier_credit" ? null : await claimCashierDrawer(scope, "INR", session);
    const eventId = new mongoose.Types.ObjectId(), recordedAt = new Date(), allocations: Array<{ purchaseId?: string; purchaseReturnId?: string; openingBalanceId?: string; invoiceId?: string; amountPaise: number }> = [];
    let partyId: string | undefined = input.supplierId, after: any;
    if (kind === "customer_refund") {
      const source = await refundableInvoice(scope, input.invoiceId!, session), invoice = source.invoice;
      if (invoice.paymentRevision !== input.expectedPaymentRevision || source.balance.refundPayablePaise !== input.expectedRefundPayablePaise || input.amountPaise > source.balance.refundPayablePaise) throw new CommandError(409, "Refund payable or revision changed; review the original invoice");
      invoice.refundedPaise += input.amountPaise; invoice.paymentRevision++;
      await invoice.save({ session }); allocations.push({ invoiceId: String(invoice._id), amountPaise: input.amountPaise }); partyId = invoice.customerSnapshot?.partyId ? String(invoice.customerSnapshot.partyId) : undefined;
      after = { invoiceId: String(invoice._id), refundPayablePaise: source.balance.refundPayablePaise - input.amountPaise, refundedPaise: invoice.refundedPaise, paymentRevision: invoice.paymentRevision };
    } else {
      if (!await PharmacyParty.exists({ _id: input.supplierId, organizationId: scope.organizationId, locationIds: scope.locationId, kinds: "supplier" }).session(session)) throw new CommandError(404, "Supplier not found");
      if (input.sourceDate && input.sourceDate > locationDateKey(recordedAt, await getLocationTimezone(scope.locationId))) throw new CommandError(400, "Supplier credit evidence cannot be dated in the future");
      const purchases = new Map<string, { purchase: any; opening: boolean; expected: number; allocated: number }>();
      for (const row of input.allocations) {
        let purchaseId = row.purchaseId;
        if (row.openingBalanceId) {
          const opening = await PharmacyOpeningBalance.findOne({ _id: row.openingBalanceId, organizationId: scope.organizationId, locationId: scope.locationId, partyId: input.supplierId, kind: "supplier_due" }).session(session);
          if (!opening) throw new CommandError(404, "Supplier opening balance source not found");
          const mapKey = `opening:${opening._id}`;
          let state = purchases.get(mapKey);
          if (!state) { state = { purchase: opening, opening: true, expected: row.expectedSettlementRevision, allocated: 0 }; purchases.set(mapKey, state); }
          if (state.expected !== row.expectedSettlementRevision || opening.settlementRevision !== row.expectedSettlementRevision) throw new CommandError(409, "Supplier opening settlement changed; refresh the statement");
          state.allocated += row.amountPaise; allocations.push({ openingBalanceId: String(opening._id), amountPaise: row.amountPaise }); continue;
        }
        if (kind === "supplier_credit") {
          const returned = await PharmacyPurchaseReturn.findOne({ _id: row.purchaseReturnId, organizationId: scope.organizationId, locationId: scope.locationId, supplierId: input.supplierId }).session(session);
          if (!returned) throw new CommandError(404, "Supplier return source not found");
          purchaseId = String(returned.purchaseId);
          const prior = await PharmacyCashEvent.find({ organizationId: scope.organizationId, locationId: scope.locationId, kind: "supplier_credit", "allocations.purchaseReturnId": returned._id }).limit(1001).session(session).lean();
          const confirmed = prior.flatMap(event => event.allocations).filter(allocation => String(allocation.purchaseReturnId) === String(returned._id)).reduce((sum, allocation) => sum + BigInt(allocation.amountPaise), 0n);
          if (prior.length > 1000 || confirmed + BigInt(row.amountPaise) > BigInt(returned.expectedCreditPaise)) throw new CommandError(409, "Supplier credit exceeds the remaining expected return credit");
        }
        let state = purchases.get(purchaseId!);
        if (!state) {
          const purchase = await PharmacyPurchase.findOne({ _id: purchaseId, organizationId: scope.organizationId, locationId: scope.locationId, supplierId: input.supplierId, status: "posted" }).session(session);
          if (!purchase) throw new CommandError(404, "Supplier payable not found");
          state = { purchase, opening: false, expected: row.expectedSettlementRevision, allocated: 0 }; purchases.set(purchaseId!, state);
        }
        if (state.expected !== row.expectedSettlementRevision || state.purchase.settlementRevision !== row.expectedSettlementRevision) throw new CommandError(409, "Supplier settlement changed; refresh the statement");
        state.allocated += row.amountPaise;
        allocations.push({ purchaseId, ...(kind === "supplier_credit" ? { purchaseReturnId: row.purchaseReturnId } : {}), amountPaise: row.amountPaise });
      }
      for (const state of purchases.values()) {
        const balance = state.opening ? await supplierOpeningBalance(state.purchase, scope, session) : await supplierPurchaseBalance(state.purchase, scope, session);
        if (kind === "supplier_payment" && state.allocated > balance.duePaise || kind === "supplier_refund" && state.allocated > balance.supplierRefundReceivablePaise || state.opening && kind === "supplier_credit" && state.allocated > balance.payablePaise - balance.confirmedCreditPaise) throw new CommandError(409, "Supplier allocation exceeds its exact payable, credit basis or refund receivable");
        state.purchase.settlementRevision++; await state.purchase.save({ session });
      }
      after = { purchases: [...purchases.values()].map(state => ({ ...(state.opening ? { openingBalanceId: String(state.purchase._id) } : { purchaseId: String(state.purchase._id) }), settlementRevision: state.purchase.settlementRevision })) };
    }
    const financialYear = indiaFinancialYear(input.sourceDate ? new Date(`${input.sourceDate}T12:00:00Z`) : recordedAt).label;
    await createWithSession(PharmacyCashEvent, { _id: eventId, organizationId: scope.organizationId, locationId: scope.locationId, partyId, invoiceId: input.invoiceId, actorId: scope.actorId, kind, ...(drawer ? { shiftId: drawer._id, drawerCode: drawer.drawerCode, drawerOwnerId: drawer.cashierId } : {}),
      direction: kind === "supplier_credit" ? "none" : kind === "supplier_refund" ? "in" : "out", amountPaise: input.amountPaise, paymentMethod: input.paymentMethod, currency: "INR", referenceNumber: input.referenceNumber, normalizedReference: input.normalizedReference, financialYear, sourceDate: input.sourceDate, reviewReference: input.reviewReference, evidenceMode: "staff_confirmed_manual", operationKey: key, recordedAt, allocations }, session);
    if (drawer) await drawerLedger(drawer, session);
    await createWithSession(AuditLog, { organizationId: scope.organizationId, userId: scope.actorId, action: "PHARMACY_SETTLEMENT_RECORDED", category: "BILLING", targetModel: "PharmacyCashEvent", targetId: eventId, details: { kind, amountPaise: input.amountPaise, partyId, allocations, referenceNumber: input.referenceNumber, shiftId: drawer?._id } }, session);
    await pinPharmacyContinuityLocation(scope.locationId, session);
    const data = { eventId: String(eventId), locationId: scope.locationId, partyId, invoiceId: input.invoiceId, kind, shiftId: drawer ? String(drawer._id) : undefined, drawerCode: drawer?.drawerCode, amountPaise: input.amountPaise, currency: "INR", paymentMethod: input.paymentMethod, referenceNumber: input.referenceNumber, sourceDate: input.sourceDate, recordedAt, allocations, after, requestKey: key };
    const saved = await OperationReceipt.updateOne({ scope: operationScope(scope), key }, { $set: { responseCiphertext: JSON.stringify({ version: 1, actorId: scope.actorId, data }) } }).session(session);
    if (saved.matchedCount !== 1) throw new CommandError(409, "Settlement reservation changed; keep the same reference");
    return String(eventId);
  }), { writeConcern: { w: "majority" } });
  return { ...await recoverSettlement(req, input.locationId, key), replayed: command.replayed };
}
