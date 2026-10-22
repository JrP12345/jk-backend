import mongoose from "mongoose";
import type { FastifyRequest } from "fastify";
import { PharmacyOpeningBalance } from "../models/PharmacyOpeningBalance.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { Invoice } from "../models/Invoice.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { object, identifier, text, whole, calendarDate } from "../schemas/pharmacyPurchases.ts";
import { purchaseScope } from "./PharmacyPurchaseDraftService.ts";
import { CommandError, executeRecordedCommand } from "./CommandReceiptService.ts";
import { loadPharmacyIssuer } from "./PharmacyDocumentService.ts";
import { pharmacyRequestAllows } from "./PharmacyCapabilityService.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import { requireStockTransaction } from "../utilities/pharmacyInventory.ts";
import { pinActivePharmacyLocation } from "../utilities/pharmacyCapability.ts";
import { allocateOpeningBalanceNumber } from "../utilities/invoiceNumber.ts";
import { locationDateKey, getLocationTimezone } from "../utilities/locationTime.ts";
import { decryptField } from "../utilities/cryptoEnvelope.ts";
type Scope = Awaited<ReturnType<typeof purchaseScope>>;
const commandScope = (scope: Scope) => `pharmacy-opening-balance:${scope.organizationId}:${scope.locationId}`;
export function openingBalanceInput(raw: unknown) {
  const body = object(raw, ["locationId", "partyId", "kind", "expectedPartyRevision", "amountPaise", "sourceDate", "sourceReference", "reviewReference", "confirmedSource", "organizationId", "organization_id"]);
  const amountPaise = whole(body.amountPaise, "reviewed opening due");
  if (!amountPaise || body.confirmedSource !== true || !["supplier_due", "customer_due"].includes(body.kind)) throw new CommandError(400, "Confirm an actual dated customer/supplier due source with a positive exact amount");
  const sourceReference = text(body.sourceReference, "actual opening source", 3, 200).normalize("NFKC");
  if (/[\p{Cc}\p{Cf}]/u.test(sourceReference)) throw new CommandError(400, "Opening source cannot contain hidden format/control characters");
  return { locationId: identifier(body.locationId), partyId: identifier(body.partyId), kind: body.kind as "supplier_due" | "customer_due", expectedPartyRevision: whole(body.expectedPartyRevision, "party revision", Number.MAX_SAFE_INTEGER - 1), amountPaise, sourceDate: calendarDate(body.sourceDate), sourceReference, normalizedReference: sourceReference.toUpperCase().replace(/\s+/g, ""), reviewReference: text(body.reviewReference, "opening source review", 3, 200), confirmedSource: true };
}
export async function readOpeningBalance(req: FastifyRequest, id: string, locationId: unknown) {
  const scope = await purchaseScope(req, locationId), openingId = identifier(id);
  const row = await PharmacyOpeningBalance.findOne({ _id: openingId, organizationId: scope.organizationId, locationId: scope.locationId }).lean();
  if (!row) throw new CommandError(404, "Opening balance source not found");
  if (!await pharmacyRequestAllows(req, row.kind === "supplier_due" ? "viewPurchases" : "viewReturns")) throw new CommandError(403, "Opening balance history permission is required");
  if (row.kind === "customer_due" && !await Invoice.exists({ _id: row.invoiceId, openingBalanceId: row._id, documentVersion: 3, kind: "pharmacy", organizationId: scope.organizationId, locationId: scope.locationId })) throw new CommandError(409, "Opening balance statement/source needs review");
  const { _id, __v: _version, normalizedReference: _normalized, ...fields } = row;
  return { ...fields, id: String(_id) };
}
export async function recoverOpeningBalance(req: FastifyRequest, locationId: unknown, key: string) {
  const scope = await purchaseScope(req, locationId);
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(400, "Invalid opening balance reference");
  const saved = await OperationReceipt.findOne({ scope: commandScope(scope), key }).select("+responseCiphertext").lean();
  if (!saved?.resultId || !saved.responseCiphertext) throw new CommandError(404, "No committed opening source is visible. Keep the same reference.");
  let result: any; try { result = JSON.parse(decryptField(saved.responseCiphertext)); } catch { throw new CommandError(409, "Opening balance evidence needs review"); }
  if (result.actorId !== scope.actorId) throw new CommandError(404, "No opening balance source is visible for this operator");
  if (result.version !== 1 || result.data?.openingBalanceId !== String(saved.resultId)) throw new CommandError(409, "Opening balance result needs review");
  await readOpeningBalance(req, String(saved.resultId), scope.locationId);
  return result.data;
}
export async function createOpeningBalance(req: FastifyRequest) {
  const input = openingBalanceInput(req.body), scope = await purchaseScope(req, input.locationId), key = req.headers["idempotency-key"];
  if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(428, "A stable Idempotency-Key is required for an opening balance source");
  const command = await executeRecordedCommand(commandScope(scope), key, { actorId: scope.actorId, ...input }, () => withTransaction(async session => {
    requireStockTransaction(session);
    const recordedAt = new Date();
    if (input.sourceDate > locationDateKey(recordedAt, await getLocationTimezone(scope.locationId))) throw new CommandError(400, "Opening source cannot be dated in the future");
    const issuer = await loadPharmacyIssuer(scope.organizationId, scope.locationId), partyKind = input.kind === "supplier_due" ? "supplier" : "customer";
    const party = await PharmacyParty.findOneAndUpdate({ _id: input.partyId, organizationId: scope.organizationId, locationIds: scope.locationId, kinds: partyKind, revision: input.expectedPartyRevision, archived: false }, { $inc: { __v: 1 } }, { session, returnDocument: "after", timestamps: false });
    if (!party) throw new CommandError(409, "Opening source party or revision needs review");
    const openingBalanceId = new mongoose.Types.ObjectId(), invoiceId = input.kind === "customer_due" ? new mongoose.Types.ObjectId() : undefined, numbering = await allocateOpeningBalanceNumber(scope.locationId, recordedAt);
    const issuerSnapshot = { legalName: issuer.legalName, address: issuer.address, drugLicenceNumbers: [...issuer.drugLicenceNumbers] }, partySnapshot = { name: party.name, address: party.address, phone: party.phone };
    await createWithSession(PharmacyOpeningBalance, { _id: openingBalanceId, organizationId: scope.organizationId, locationId: scope.locationId, partyId: party._id, kind: input.kind, currency: "INR", amountPaise: input.amountPaise,
      statementNumber: numbering.statementNumber, sourceDate: input.sourceDate, sourceReference: input.sourceReference, normalizedReference: input.normalizedReference, reviewReference: input.reviewReference, partyRevision: party.revision, partySnapshot, issuerSnapshot, actorId: scope.actorId, operationKey: key, recordedAt, invoiceId }, session);
    if (invoiceId) await createWithSession(Invoice, { _id: invoiceId, kind: "pharmacy", createdBy: scope.actorId, organizationId: scope.organizationId, locationId: scope.locationId, currency: "INR", openingBalanceId,
      openingBalanceSnapshot: { amountPaise: input.amountPaise, sourceDate: input.sourceDate, sourceReference: input.sourceReference, reviewReference: input.reviewReference, issuer: issuerSnapshot },
      customerSnapshot: { anonymous: false, partyId: party._id, revision: party.revision, ...partySnapshot }, invoiceNumber: numbering.statementNumber, numberingVersion: numbering.numberingVersion, financialYear: numbering.financialYear, invoiceSeries: numbering.invoiceSeries, documentVersion: 3, issuedAt: recordedAt,
      items: [], subtotal: input.amountPaise / 100, taxableAmount: 0, tax: 0, discount: 0, totalAmount: input.amountPaise / 100, cgstTotal: 0, sgstTotal: 0, igstTotal: 0, amountPaid: 0, balanceDue: input.amountPaise / 100, status: "unpaid", notes: "Reviewed opening balance statement; no current supply, tax or stock movement." }, session);
    await createWithSession(AuditLog, { organizationId: scope.organizationId, userId: scope.actorId, action: "PHARMACY_OPENING_BALANCE_RECORDED", category: "BILLING", targetModel: "PharmacyOpeningBalance", targetId: openingBalanceId,
      details: { kind: input.kind, partyId: party._id, amountPaise: input.amountPaise, sourceDate: input.sourceDate, sourceReference: input.sourceReference, statementNumber: numbering.statementNumber, invoiceId } }, session);
    await pinActivePharmacyLocation(scope.locationId, session);
    const data = { openingBalanceId: String(openingBalanceId), invoiceId: invoiceId ? String(invoiceId) : undefined, kind: input.kind, partyId: String(party._id), locationId: scope.locationId, statementNumber: numbering.statementNumber, amountPaise: input.amountPaise, sourceDate: input.sourceDate, requestKey: key };
    const saved = await OperationReceipt.updateOne({ scope: commandScope(scope), key }, { $set: { responseCiphertext: JSON.stringify({ version: 1, actorId: scope.actorId, data }) } }).session(session);
    if (saved.matchedCount !== 1) throw new CommandError(409, "Opening balance reservation changed; keep the same reference");
    return String(openingBalanceId);
  }), { writeConcern: { w: "majority" } });
  return { ...await recoverOpeningBalance(req, input.locationId, key), replayed: command.replayed };
}
