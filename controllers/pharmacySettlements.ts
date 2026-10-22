import type { FastifyReply, FastifyRequest } from "fastify";
import { recordSettlement, recoverSettlement, readInvoiceRefundSource, readSupplierStatement, readCustomerStatement } from "../services/PharmacySettlementService.ts";
import { pharmacyRequestAllows } from "../services/PharmacyCapabilityService.ts";
import { purchaseScope } from "../services/PharmacyPurchaseDraftService.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { PharmacyInventoryError } from "../utilities/pharmacyInventory.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { Invoice } from "../models/Invoice.ts";
import { object, identifier, text } from "../schemas/pharmacyPurchases.ts";
import { successResponse, errorResponse, escapeRegex } from "../utilities/helpers.ts";
import type { SettlementKind } from "../schemas/pharmacySettlements.ts";
const kinds: Record<string, SettlementKind> = { "supplier-credit": "supplier_credit", "supplier-payment": "supplier_payment", "supplier-refund": "supplier_refund", "customer-refund": "customer_refund" };
function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof CommandError || error instanceof PharmacyInventoryError) return reply.code(error.statusCode).send(errorResponse(error.message));
  if ((error as { code?: number }).code === 11000) return reply.code(409).send(errorResponse("Actual settlement reference is already recorded. Recover its original operation; do not record it again."));
  return reply.code(500).send(errorResponse("Settlement could not be confirmed. Keep the same reference and check before recording again."));
}
export async function postPharmacySettlement(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const rawKind = (req.params as { kind: string }).kind, kind = Object.hasOwn(kinds, rawKind) ? kinds[rawKind] : undefined;
    if (!kind) throw new CommandError(400, "Unsupported pharmacy settlement kind");
    if (kind !== "customer_refund" && !await pharmacyRequestAllows(req, "viewPurchases")) throw new CommandError(403, "Supplier financial-source permission is required");
    return reply.code(201).send(successResponse(await recordSettlement(req, kind)));
  } catch (error) { return failure(reply, error); }
}
export async function getPharmacySettlementOperation(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store"); try { return reply.send(successResponse(await recoverSettlement(req, (req.query as { locationId?: string }).locationId, (req.params as { key: string }).key))); } catch (error) { return failure(reply, error); }
}
export async function getPharmacyRefundSource(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store"); try { return reply.send(successResponse(await readInvoiceRefundSource(req, (req.params as { id: string }).id, (req.query as { locationId?: string }).locationId))); } catch (error) { return failure(reply, error); }
}
export async function getPharmacySupplierStatement(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store"); try { return reply.send(successResponse(await readSupplierStatement(req, (req.params as { id: string }).id, (req.query as { locationId?: string }).locationId))); } catch (error) { return failure(reply, error); }
}
export async function getPharmacyCustomerStatement(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store"); try { return reply.send(successResponse(await readCustomerStatement(req, (req.params as { id: string }).id, (req.query as { locationId?: string }).locationId))); } catch (error) { return failure(reply, error); }
}
export async function listPharmacySettlementParties(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const query = object(req.query, ["locationId", "kind", "search", "cursor", "includeArchived", "organizationId", "organization_id"]), scope = await purchaseScope(req, query.locationId);
    if (!["supplier", "customer"].includes(query.kind) || query.includeArchived !== undefined && !["true", "false"].includes(query.includeArchived)) throw new CommandError(400, "Select supplier/customer and a valid history filter");
    if (!await pharmacyRequestAllows(req, query.kind === "supplier" ? "viewPurchases" : "viewReturns")) throw new CommandError(403, "Party statement permission is required");
    const search = query.search === undefined ? "" : text(query.search, "party search", 0, 100);
    const rows = await PharmacyParty.find({ organizationId: scope.organizationId, locationIds: scope.locationId, kinds: query.kind, ...(query.includeArchived === "true" ? {} : { archived: false }), ...(search ? { normalizedName: { $regex: `^${escapeRegex(search.normalize("NFKC").toLowerCase())}` } } : {}), ...(query.cursor ? { _id: { $gt: identifier(query.cursor) } } : {}) }).select("name address archived revision").sort({ _id: 1 }).limit(26).lean(), page = rows.slice(0, 25);
    return reply.send(successResponse({ items: page.map(({ _id, ...row }) => ({ ...row, id: String(_id) })), nextCursor: rows.length > 25 ? String(page.at(-1)!._id) : null }));
  } catch (error) { return failure(reply, error); }
}
export async function listPharmacyRefundInvoices(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const query = object(req.query, ["locationId", "invoiceNumber", "cursor", "organizationId", "organization_id"]), scope = await purchaseScope(req, query.locationId);
    const rows = await Invoice.find({ kind: "pharmacy", organizationId: scope.organizationId, locationId: scope.locationId, deletedAt: null, creditedPaise: { $gt: 0 }, ...(query.invoiceNumber ? { invoiceNumber: text(query.invoiceNumber, "invoice number", 1, 50) } : {}), ...(query.cursor ? { _id: { $gt: identifier(query.cursor) } } : {}) }).select("invoiceNumber customerSnapshot amountPaid creditedPaise refundedPaise").sort({ _id: 1 }).limit(26).lean(), page = rows.slice(0, 25);
    return reply.send(successResponse({ items: page.map(({ _id, ...row }) => ({ ...row, id: String(_id) })), nextCursor: rows.length > 25 ? String(page.at(-1)!._id) : null }));
  } catch (error) { return failure(reply, error); }
}
