import mongoose from "mongoose";
import type { FastifyRequest } from "fastify";
import { CashierShift, assertDrawerEvidence } from "../models/CashierShift.ts";
import { Invoice } from "../models/Invoice.ts";
import { PharmacyCashEvent } from "../models/PharmacyCashEvent.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { User } from "../models/User.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { purchaseScope } from "./PharmacyPurchaseDraftService.ts";
import { pharmacyRequestAllows } from "./PharmacyCapabilityService.ts";
import { CommandError, commandHash, executeRecordedCommand } from "./CommandReceiptService.ts";
import { object, identifier, text, whole } from "../schemas/pharmacyPurchases.ts";
import { createWithSession, withTransaction } from "../utilities/transaction.ts";
import { collectionPaise } from "./TillCollectionService.ts";
import { getLocationTimezone, locationDateKey } from "../utilities/locationTime.ts";
import { pinPharmacyContinuityLocation } from "../utilities/pharmacyCapability.ts";
import { decryptField } from "../utilities/cryptoEnvelope.ts";
import { indiaFinancialYear } from "../utilities/invoiceNumber.ts";
import { invoiceBalancePaise } from "./InvoicePaymentService.ts";

import { getEffectivePermissions } from "../utilities/permissions.ts";
export type DrawerChannel = "pharmacy" | "billing";
type Scope = Awaited<ReturnType<typeof purchaseScope>>;
const commandScope = (scope: Scope) => `cashier-drawer:${scope.organizationId}:${scope.locationId}`;
const bucket = (method: string) => method === "cash" ? "cash" : method === "upi" ? "upi" : method === "card" ? "card" : "other";
const empty = () => ({ cash: 0, upi: 0, card: 0, other: 0 });
function safe(value: bigint) { if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new CommandError(409, "Drawer amount requires review"); return Number(value); }

/** Writing the shared drawer serializes posting against close, including split receipts. */
export async function claimCashierDrawer(scope: Scope, currency: string, session: mongoose.ClientSession | null, required = true) {
  if (!session) throw new CommandError(503, "Drawer postings require a transaction");
  const drawer = await CashierShift.findOne({ kind: "drawer", organizationId: scope.organizationId, locationId: scope.locationId, cashierId: scope.actorId, status: "active" }).session(session);
  if (!drawer) { if (!required) return null; throw new CommandError(428, "Open your physical drawer before recording collections or payouts"); }
  if (drawer.currency !== currency || drawer.revision >= 1000) throw new CommandError(409, "Drawer currency differs or its posting limit was reached; review and close this drawer");
  const claimed = await CashierShift.updateOne({ _id: drawer._id, kind: "drawer", status: "active", revision: drawer.revision }, { $inc: { revision: 1, __v: 1 } }, { session, timestamps: false });
  if (claimed.modifiedCount !== 1) throw new CommandError(409, "Drawer changed; reload and keep the same operation reference");
  return drawer;
}

export async function drawerLedger(drawer: any, session: mongoose.ClientSession | null) {
  const scope = { organizationId: drawer.organizationId, locationId: drawer.locationId };
  const invoices = await Invoice.find({ ...scope, "payments.shiftId": drawer._id }).select("payments currency kind totalAmount amountPaid balanceDue creditedPaise refundedPaise").sort({ _id: 1 }).limit(1001).session(session).lean();
  const events = await PharmacyCashEvent.find({ ...scope, shiftId: drawer._id }).sort({ _id: 1 }).limit(1001).session(session).lean();
  if (invoices.length > 1000 || events.length > 1000) throw new CommandError(409, "Drawer history exceeds its review bound");
  const incoming = empty(), outgoing = empty(), eventIncoming = empty(), receiptEvidence: any[] = [], eventEvidence: any[] = [];
  const add = (target: ReturnType<typeof empty>, method: string, amount: number) => { const key = bucket(method); target[key] = safe(BigInt(target[key]) + BigInt(amount)); };
  const identities = new Set<string>();
  for (const invoice of invoices) {
    invoiceBalancePaise(invoice, invoice.kind === "pharmacy");
    for (const payment of invoice.payments || []) {
    if (String(payment.shiftId) !== String(drawer._id)) continue;
    const amount = collectionPaise(payment.amount), at = payment.paidAt;
    const identity = `${invoice._id}:${payment.operationKey}`;
    if (invoice.currency !== drawer.currency || !amount || !["cash", "upi", "card", "other", "net-banking", "insurance", "online"].includes(payment.paymentMethod) || !payment.operationKey || identities.has(identity) || String(payment.actorId) !== String(drawer.cashierId) || !at || at < drawer.startedAt || drawer.endedAt && at > drawer.endedAt) throw new CommandError(409, "Drawer receipt evidence does not reconcile");
    identities.add(identity); add(incoming, payment.paymentMethod, amount);
    receiptEvidence.push({ invoiceId: String(invoice._id), paymentId: String(payment._id), operationKey: payment.operationKey, amountPaise: amount, paymentMethod: payment.paymentMethod, paidAt: at.toISOString(), actorId: String(payment.actorId) });
    }
  }
  if (receiptEvidence.length > 10000) throw new CommandError(409, "Drawer receipt history exceeds its review bound");
  for (const event of events) {
    if (event.currency !== drawer.currency || String(event.drawerOwnerId) !== String(drawer.cashierId) || event.drawerCode !== drawer.drawerCode || event.direction === "none" || event.recordedAt < drawer.startedAt || drawer.endedAt && event.recordedAt > drawer.endedAt) throw new CommandError(409, "Drawer movement evidence does not reconcile");
    add(event.direction === "in" ? eventIncoming : outgoing, event.paymentMethod, event.amountPaise);
    eventEvidence.push({ eventId: String(event._id), kind: event.kind, direction: event.direction, amountPaise: event.amountPaise, paymentMethod: event.paymentMethod, recordedAt: event.recordedAt.toISOString(), actorId: String(event.actorId), referenceNumber: event.referenceNumber });
  }
  const expectedCashPaise = safe(BigInt(drawer.openingFloatPaise) + BigInt(incoming.cash) + BigInt(eventIncoming.cash) - BigInt(outgoing.cash));
  return { totals: { incoming, outgoing, eventIncoming, expectedCashPaise, receiptCount: receiptEvidence.length, eventCount: events.length, invoiceCount: invoices.length }, receiptEvidence, eventEvidence };
}
async function authority(req: FastifyRequest, action: "viewTill" | "openTill" | "closeTill" | "moveTillCash", channel: DrawerChannel = "pharmacy") {
  if (channel === "billing") {
    if (!req.user || ["patient", "family_member", "guest"].includes(req.user.role)) throw new CommandError(403, "Drawer access requires authorized staff");
    const permissions = await getEffectivePermissions(req.user.role, req.user.organization_id, req.user.authVersion, true);
    if (req.user.role !== "root" && !permissions.has("MANAGE_BILLING")) throw new CommandError(403, "Current billing management permission is required");
    return;
  }
  if (!await pharmacyRequestAllows(req, action)) throw new CommandError(403, "Current drawer permission is required");
}
async function canManageOthers(req: FastifyRequest) { return req.user?.role === "root" || await pharmacyRequestAllows(req, "openingBalances"); }
async function source(req: FastifyRequest, scope: Scope, id: string, session: mongoose.ClientSession | null) {
  const drawer = await CashierShift.findOne({ _id: identifier(id), kind: "drawer", organizationId: scope.organizationId, locationId: scope.locationId }).session(session);
  if (!drawer || String(drawer.cashierId) !== scope.actorId && !await canManageOthers(req)) throw new CommandError(404, "Drawer not found for this operator");
  return drawer;
}
function present(drawer: any, ledger?: Awaited<ReturnType<typeof drawerLedger>>) { assertDrawerEvidence(drawer); return { ...drawer.toObject(), id: String(drawer._id), ...(ledger ? { drawerTotals: ledger.totals } : {}) }; }
export async function readDrawers(req: FastifyRequest, locationId: unknown, id?: string, history = false, channel: DrawerChannel = "pharmacy") {
  await authority(req, "viewTill", channel); const scope = await purchaseScope(req, locationId);
  return withTransaction(async session => {
    if (id) { const drawer = await source(req, scope, id, session); return present(drawer, drawer.status === "active" ? await drawerLedger(drawer, session) : undefined); }
    const cursor = (req.query as { cursor?: string }).cursor;
    const query = { kind: "drawer" as const, organizationId: scope.organizationId, locationId: scope.locationId, ...(!history || !await canManageOthers(req) ? { cashierId: scope.actorId } : {}), ...(history ? { ...(cursor ? { _id: { $lt: identifier(cursor) } } : {}) } : { status: "active" as const }) };
    const rows = await CashierShift.find(query).sort({ _id: -1 }).limit(history ? 26 : 1).session(session);
    if (history) {
      const items = [];
      for (const row of rows.slice(0, 25)) items.push(present(row, row.status === "active" ? await drawerLedger(row, session) : undefined));
      return { items, nextCursor: rows.length > 25 ? String(rows[24]._id) : null };
    }
    return { active: rows[0] ? present(rows[0], await drawerLedger(rows[0], session)) : null };
  }, { readConcern: { level: "snapshot" } });
}
export async function recoverDrawerCommand(req: FastifyRequest, locationId: unknown, key: string, channel: DrawerChannel = "pharmacy") {
  await authority(req, "viewTill", channel); const scope = await purchaseScope(req, locationId);
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(400, "Invalid drawer operation reference");
  const record = await OperationReceipt.findOne({ scope: commandScope(scope), key }).select("+responseCiphertext").lean();
  if (!record?.resultId || !record.responseCiphertext) throw new CommandError(404, "No committed drawer operation is visible; keep the same reference");
  let saved: any; try { saved = JSON.parse(decryptField(record.responseCiphertext)); } catch { throw new CommandError(409, "Drawer operation evidence requires review"); }
  if (saved.actorId !== scope.actorId) throw new CommandError(404, "Drawer operation is not visible for this operator");
  if (saved.version !== 1 || saved.data?.resultId !== String(record.resultId) || saved.data.locationId !== scope.locationId) throw new CommandError(409, "Drawer operation scope requires review");
  return saved.data;
}
export async function writeDrawerCommand(req: FastifyRequest, kind: "open" | "close" | "movement", rawId?: string, channel: DrawerChannel = "pharmacy") {
  const action = kind === "open" ? "openTill" : kind === "close" ? "closeTill" : "moveTillCash";
  await authority(req, action, channel);
  const body = object(req.body, ["locationId", "drawerCode", "openingFloatPaise", "expectedRevision", "countedCashPaise", "varianceReason", "handoverNotes", "direction", "amountPaise", "referenceNumber", "reviewReference"]);
  const scope = await purchaseScope(req, body.locationId), key = req.headers["idempotency-key"], id = rawId ? identifier(rawId) : undefined;
  if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(428, "A stable Idempotency-Key is required for drawer operations");
  const input = kind === "open" ? { drawerCode: text(body.drawerCode, "drawer code", 1, 40).toUpperCase(), openingFloatPaise: whole(body.openingFloatPaise, "opening float") } : kind === "close" ? {
    expectedRevision: whole(body.expectedRevision, "drawer revision"), countedCashPaise: whole(body.countedCashPaise, "counted cash"), varianceReason: text(body.varianceReason ?? "", "variance explanation", 0, 500), handoverNotes: text(body.handoverNotes ?? "", "handover notes", 0, 1000),
  } : { expectedRevision: whole(body.expectedRevision, "drawer revision"), direction: body.direction, amountPaise: whole(body.amountPaise, "cash movement"), referenceNumber: text(body.referenceNumber, "actual cash movement reference", 3, 100), reviewReference: text(body.reviewReference, "movement explanation", 3, 500) };
  if (Object.keys(body).some(field => field !== "locationId" && !Object.hasOwn(input, field))) throw new CommandError(400, "Unsupported fields for this drawer command");
  if (kind === "open" && !/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(input.drawerCode!) || kind === "movement" && (!["in", "out"].includes(input.direction) || !input.amountPaise)) throw new CommandError(400, "Invalid drawer code or cash movement");
  const result = await executeRecordedCommand(commandScope(scope), key, { kind, actorId: scope.actorId, id, ...input }, () => withTransaction(async session => {
    if (!session) throw new CommandError(503, "Drawer lifecycle requires transactions");
    await authority(req, action, channel); await purchaseScope(req, scope.locationId);
    const actor = await User.findById(scope.actorId).select("name").session(session); if (!actor) throw new CommandError(403, "Cashier identity requires review");
    let drawer: any, resultId: string;
    if (kind === "open") {
      // Serialize uniqueness even before initial index setup has been performed.
      const organization = await Organization.findOneAndUpdate({ _id: scope.organizationId }, { $inc: { __v: 1 } }, { session, returnDocument: "after" });
      const location = await Location.findOne({ _id: scope.locationId, organizationId: scope.organizationId, isActive: { $ne: false } }).session(session);
      if (!organization || !location || !organization.currency) throw new CommandError(409, "Drawer branch and currency need review");
      if (await CashierShift.exists({ kind: "drawer", organizationId: scope.organizationId, locationId: scope.locationId, status: "active", $or: [{ cashierId: scope.actorId }, { drawerCode: input.drawerCode }] }).session(session)) throw new CommandError(409, "Cashier or physical drawer already has an active session");
      const timezone = await getLocationTimezone(scope.locationId), startedAt = new Date();
      drawer = await createWithSession(CashierShift, { ...scope, kind: "drawer", cashierId: scope.actorId, cashierName: actor.name, organizationName: organization.name, locationName: location.name, drawerCode: input.drawerCode, openingFloatPaise: input.openingFloatPaise, collectionBasis: "drawer_v1", currency: organization.currency, timezone, shiftDate: locationDateKey(startedAt, timezone), startedAt, status: "active" }, session);
      resultId = String(drawer._id);
    } else {
      drawer = await source(req, scope, id!, session);
      if (drawer.status !== "active" || drawer.revision !== input.expectedRevision) throw new CommandError(409, "Drawer closed or changed; reload before recording this operation");
      // Same document is written by all money commands: close and posting cannot both win an old snapshot.
      const claimed = await CashierShift.updateOne({ _id: drawer._id, kind: "drawer", status: "active", revision: drawer.revision }, { $inc: { revision: 1, __v: 1 } }, { session, timestamps: false });
      if (claimed.modifiedCount !== 1) throw new CommandError(409, "Drawer changed; keep the same operation reference");
      drawer.revision++; drawer.__v++;
      if (kind === "movement") {
        if (drawer.revision > 1000) throw new CommandError(409, "Drawer posting limit reached; close this drawer");
        const recordedAt = new Date(), eventId = new mongoose.Types.ObjectId();
        await createWithSession(PharmacyCashEvent, { _id: eventId, domain: channel, organizationId: scope.organizationId, locationId: scope.locationId, actorId: scope.actorId, shiftId: drawer._id, drawerCode: drawer.drawerCode, drawerOwnerId: drawer.cashierId, kind: input.direction === "in" ? "cash_in" : "cash_out", direction: input.direction, amountPaise: input.amountPaise, currency: drawer.currency, paymentMethod: "cash", referenceNumber: input.referenceNumber, normalizedReference: input.referenceNumber!.normalize("NFKC").toUpperCase(), financialYear: indiaFinancialYear(recordedAt).label, reviewReference: input.reviewReference, evidenceMode: "staff_confirmed_manual", operationKey: key, recordedAt, allocations: [] }, session);
        await drawerLedger(drawer, session); resultId = String(eventId);
      } else {
        const ledger = await drawerLedger(drawer, session), variance = input.countedCashPaise! - ledger.totals.expectedCashPaise;
        if (variance !== 0 && !input.varianceReason) throw new CommandError(400, "Explain the counted cash variance before closing");
        drawer.status = "closed"; drawer.endedAt = new Date(); drawer.asOf = drawer.endedAt; drawer.periodEnd = drawer.endedAt;
        drawer.closedBy = scope.actorId; drawer.closedByName = actor.name; drawer.drawerTotals = ledger.totals;
        drawer.receiptEvidence = ledger.receiptEvidence; drawer.eventEvidence = ledger.eventEvidence;
        drawer.evidenceHash = commandHash({ totals: ledger.totals, receipts: ledger.receiptEvidence, events: ledger.eventEvidence });
        drawer.actualCashCounted = input.countedCashPaise! / 100; drawer.cashVariance = variance / 100; drawer.varianceReason = input.varianceReason; drawer.handoverNotes = input.handoverNotes;
        await drawer.save({ session }); resultId = String(drawer._id);
      }
    }
    await createWithSession(AuditLog, { organizationId: scope.organizationId, userId: scope.actorId, action: `CASHIER_DRAWER_${kind.toUpperCase()}`, category: "BILLING", targetModel: "CashierShift", targetId: drawer._id, details: { resultId, drawerCode: drawer.drawerCode, ownerId: String(drawer.cashierId), revision: drawer.revision, ...input } }, session);
    await pinPharmacyContinuityLocation(scope.locationId, session);
    const data = { kind, resultId, locationId: scope.locationId, requestKey: key, drawer: present(drawer, drawer.status === "active" ? await drawerLedger(drawer, session) : undefined) };
    const saved = await OperationReceipt.updateOne({ scope: commandScope(scope), key }, { $set: { responseCiphertext: JSON.stringify({ version: 1, actorId: scope.actorId, data }) } }).session(session);
    if (saved.matchedCount !== 1) throw new CommandError(409, "Drawer command reservation changed; keep the same reference");
    return resultId;
  }), { writeConcern: { w: "majority" } });
  return { ...await recoverDrawerCommand(req, scope.locationId, key, channel), replayed: result.replayed };
}
