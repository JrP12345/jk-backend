import type { FastifyReply, FastifyRequest } from "fastify";
import { Invoice } from "../models/Invoice.ts";
import { InvoiceCollectionReceipt } from "../models/InvoiceCollectionReceipt.ts";
import { collectPharmacyInvoice, recoverPharmacyCollection } from "../services/PharmacyCollectionService.ts";
import { purchaseScope } from "../services/PharmacyPurchaseDraftService.ts";
import { object, identifier } from "../schemas/pharmacyPurchases.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { errorResponse, successResponse } from "../utilities/helpers.ts";
function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof CommandError) return reply.code(error.statusCode).send(errorResponse(error.message));
  if ((error as { code?: number }).code === 11000) return reply.code(409).send(errorResponse("Receipt identity conflicts; recover the original collection reference"));
  return reply.code(500).send(errorResponse("Collection could not be confirmed. Keep the same reference and check the result before collecting again."));
}
export async function postPharmacyCollection(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try { return reply.code(201).send(successResponse(await collectPharmacyInvoice(req, (req.params as { id: string }).id))); } catch (error) { return failure(reply, error); }
}
export async function payPharmacyInvoice(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try { return reply.code(201).send(successResponse(await collectPharmacyInvoice(req, (req.params as { id: string }).id, true))); } catch (error) { return failure(reply, error); }
}
export async function getPharmacyCollectionOperation(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try { return reply.send(successResponse(await recoverPharmacyCollection(req, (req.query as { locationId?: string }).locationId, (req.params as { key: string }).key))); } catch (error) { return failure(reply, error); }
}
export async function listPharmacyCollections(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const query = object(req.query, ["locationId", "cursor", "organizationId", "organization_id"]), scope = await purchaseScope(req, query.locationId), id = identifier((req.params as { id: string }).id);
    if (!await Invoice.exists({ _id: id, organizationId: scope.organizationId, locationId: scope.locationId, kind: "pharmacy", deletedAt: null })) throw new CommandError(404, "Counter invoice not found");
    const rows = await InvoiceCollectionReceipt.find({ organizationId: scope.organizationId, locationId: scope.locationId, invoiceId: id, ...(query.cursor ? { _id: { $gt: identifier(query.cursor) } } : {}) }).sort({ _id: 1 }).limit(21).lean(), page = rows.slice(0, 20);
    return reply.send(successResponse({ items: page.map(({ _id, __v: _version, ...fields }) => ({ ...fields, receiptId: String(_id) })), nextCursor: rows.length > 20 ? String(page.at(-1)!._id) : null }));
  } catch (error) { return failure(reply, error); }
}
