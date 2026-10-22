import type { FastifyReply, FastifyRequest } from "fastify";
import { commitPharmacyReturn, getPharmacyReturnSource, previewPharmacyReturn, recoverPharmacyReturn } from "../services/PharmacyReturnService.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { PharmacyInventoryError } from "../utilities/pharmacyInventory.ts";
import { purchaseScope } from "../services/PharmacyPurchaseDraftService.ts";
import { object, identifier, text } from "../schemas/pharmacyPurchases.ts";
import { Invoice } from "../models/Invoice.ts";
import { PharmacyReturn } from "../models/PharmacyReturn.ts";
import { InvoiceCreditNote } from "../models/InvoiceCreditNote.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof CommandError || error instanceof PharmacyInventoryError) return reply.code(error.statusCode).send(errorResponse(error.message));
  if ((error as { code?: number }).code === 11000) return reply.code(409).send(errorResponse("Return identity conflicts; recover the original reference"));
  return reply.code(500).send(errorResponse("Return could not be confirmed. Keep the same reference and check before posting again."));
}
export async function listReturnInvoices(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const query = object(req.query, ["locationId", "invoiceNumber", "cursor", "organizationId", "organization_id"]), scope = await purchaseScope(req, query.locationId);
    const rows = await Invoice.find({ kind: "pharmacy", documentVersion: 2, organizationId: scope.organizationId, locationId: scope.locationId, deletedAt: null,
      ...(query.invoiceNumber ? { invoiceNumber: text(query.invoiceNumber, "invoice number", 1, 50) } : {}), ...(query.cursor ? { _id: { $gt: identifier(query.cursor) } } : {}) }).select("invoiceNumber issuedAt status totalAmount currency customerSnapshot").sort({ _id: 1 }).limit(26).lean(), page = rows.slice(0, 25);
    return reply.send(successResponse({ items: page.map(({ _id, ...row }) => ({ ...row, id: String(_id) })), nextCursor: rows.length > 25 ? String(page.at(-1)!._id) : null }));
  } catch (error) { return failure(reply, error); }
}
export async function getReturnSource(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try { return reply.send(successResponse(await getPharmacyReturnSource(req, (req.query as { locationId?: string }).locationId, (req.params as { id: string }).id))); } catch (error) { return failure(reply, error); }
}
export async function quoteReturn(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try { return reply.send(successResponse(await previewPharmacyReturn(req, (req.params as { id: string }).id))); } catch (error) { return failure(reply, error); }
}
export async function postReturn(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try { return reply.code(201).send(successResponse(await commitPharmacyReturn(req, (req.params as { id: string }).id))); } catch (error) { return failure(reply, error); }
}
export async function getReturnOperation(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try { return reply.send(successResponse(await recoverPharmacyReturn(req, (req.query as { locationId?: string }).locationId, (req.params as { key: string }).key))); } catch (error) { return failure(reply, error); }
}
export async function getReturn(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const scope = await purchaseScope(req, (req.query as { locationId?: string }).locationId), id = identifier((req.params as { id: string }).id);
    const row = await PharmacyReturn.findOne({ _id: id, organizationId: scope.organizationId, locationId: scope.locationId }).lean();
    if (!row) throw new CommandError(404, "Return not found");
    const creditNote = await InvoiceCreditNote.findOne({ _id: row.creditNoteId, returnId: row._id, organizationId: scope.organizationId, locationId: scope.locationId }).lean();
    if (!creditNote) throw new CommandError(409, "Return credit note needs review");
    return reply.send(successResponse({ ...row, id: String(row._id), creditNote: { ...creditNote, id: String(creditNote._id) } }));
  } catch (error) { return failure(reply, error); }
}
