import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { PharmacyPurchase } from "../models/PharmacyPurchase.ts";
import { PharmacyPurchaseReceipt } from "../models/PharmacyPurchaseReceipt.ts";
import { postPharmacyPurchase, receivePharmacyPurchase, recoverPharmacyPurchaseOperation } from "../services/PharmacyPurchaseService.ts";
import { Medicine } from "../models/Medicine.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { PharmacyInventoryError } from "../utilities/pharmacyInventory.ts";
import { purchaseScope, scopedParty, scopedPurchase, savePharmacyParty, savePharmacyPurchaseDraft } from "../services/PharmacyPurchaseDraftService.ts";
import { object, identifier } from "../schemas/pharmacyPurchases.ts";
import { successResponse, errorResponse, escapeRegex } from "../utilities/helpers.ts";

function dto(row: any) { const value = typeof row.toObject === "function" ? row.toObject() : row; const { _id, __v: _version, normalizedName: _name, normalizedInvoiceNumber: _invoice, ...fields } = value; return { ...fields, id: String(_id) }; }
function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof CommandError || error instanceof PharmacyInventoryError) return reply.code(error.statusCode).send(errorResponse(error.message));
  if ((error as { code?: number }).code === 11000) return reply.code(409).send(errorResponse("This GST identity or supplier invoice already exists in the business. Reopen the existing record or ask an authorized owner to review it."));
  if (error instanceof mongoose.Error.ValidationError) return reply.code(400).send(errorResponse("Invalid party or purchase draft fields"));
  return reply.code(500).send(errorResponse("Save could not be confirmed. Keep your details and reference, then reload the record before starting another draft."));
}
export async function listPharmacyParties(req: FastifyRequest, reply: FastifyReply) { return list(req, reply, true); }
export async function listPharmacyPurchases(req: FastifyRequest, reply: FastifyReply) { return list(req, reply, false); }
export async function listPharmacyPurchaseProducts(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const query = object(req.query, ["locationId", "limit", "cursor", "search", "organizationId", "organization_id"]), scope = await purchaseScope(req, query.locationId);
    const limit = query.limit === undefined ? 25 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || query.search !== undefined && (typeof query.search !== "string" || query.search.length > 100)) throw new CommandError(400, "Invalid product search or page size");
    const rows = await Medicine.find({ locationId: scope.locationId, deletedAt: null, unitDefinition: { $exists: true }, ...(query.cursor ? { _id: { $gt: identifier(query.cursor) } } : {}),
      ...(query.search?.trim() ? { $or: [{ name: { $regex: escapeRegex(query.search.trim()), $options: "i" } }, { genericName: { $regex: escapeRegex(query.search.trim()), $options: "i" } }, { barcodes: query.search.trim() }] } : {}) })
      .select("name genericName strength unitDefinition price hsnCode").sort({ _id: 1 }).limit(limit + 1).lean();
    const page = rows.slice(0, limit);
    return reply.send(successResponse({ items: page.map(dto), nextCursor: rows.length > limit ? String(page.at(-1)!._id) : null }));
  } catch (error) { return failure(reply, error); }
}
async function list(req: FastifyRequest, reply: FastifyReply, parties: boolean) {
  reply.header("Cache-Control", "no-store");
  try {
    const query = object(req.query, ["locationId", "cursor", "limit", "search", "kind", "archived", "organizationId", "organization_id"]), scope = await purchaseScope(req, query.locationId);
    const limit = query.limit === undefined ? 25 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || query.search !== undefined && (typeof query.search !== "string" || query.search.length > 100) ||
        query.kind !== undefined && !["supplier", "customer"].includes(query.kind) || query.archived !== undefined && !["true", "false"].includes(query.archived)) throw new CommandError(400, "Invalid list filters or page size");
    const filter: any = { organizationId: scope.organizationId, ...(parties ? { locationIds: scope.locationId, archived: query.archived === "true" } : { locationId: scope.locationId }),
      ...(query.cursor ? { _id: { $gt: identifier(query.cursor) } } : {}) };
    if (parties && query.kind) filter.kinds = query.kind;
    if (query.search?.trim()) filter[parties ? "normalizedName" : "supplierInvoiceNumber"] = { $regex: escapeRegex(query.search.trim().normalize("NFKC").toLowerCase()), $options: "i" };
    const rows = parties ? await PharmacyParty.find(filter).sort({ _id: 1 }).limit(limit + 1).lean() : await PharmacyPurchase.find(filter).sort({ _id: 1 }).limit(limit + 1).select("-lines").lean();
    const page = rows.slice(0, limit);
    return reply.send(successResponse({ items: page.map(dto), nextCursor: rows.length > limit ? String(page.at(-1)!._id) : null }));
  } catch (error) { return failure(reply, error); }
}
export async function readPharmacyParty(req: FastifyRequest, reply: FastifyReply) { return read(req, reply, true); }
export async function readPharmacyPurchase(req: FastifyRequest, reply: FastifyReply) { return read(req, reply, false); }
async function read(req: FastifyRequest, reply: FastifyReply, parties: boolean) {
  reply.header("Cache-Control", "no-store");
  try { const id = (req.params as { id: string }).id, locationId = (req.query as { locationId?: string }).locationId; const result = parties ? (await scopedParty(req, id, locationId)).party : (await scopedPurchase(req, id, locationId)).draft; return reply.send(successResponse(dto(result))); }
  catch (error) { return failure(reply, error); }
}
export async function writePharmacyParty(req: FastifyRequest, reply: FastifyReply) { return write(req, reply, true); }
export async function writePharmacyPurchase(req: FastifyRequest, reply: FastifyReply) { return write(req, reply, false); }
export async function postPurchase(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try { return reply.send(successResponse(await postPharmacyPurchase(req, (req.params as { id: string }).id))); }
  catch (error) { return failure(reply, error); }
}
export async function receivePurchase(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try { return reply.code(201).send(successResponse(await receivePharmacyPurchase(req, (req.params as { id: string }).id))); }
  catch (error) { return failure(reply, error); }
}
export async function recoverPurchase(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try { const { id, kind, key } = req.params as { id: string; kind: "post" | "receipt"; key: string }; return reply.send(successResponse(await recoverPharmacyPurchaseOperation(req, id, (req.query as { locationId?: string }).locationId, kind, key))); }
  catch (error) { return failure(reply, error); }
}
export async function listPurchaseReceipts(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const query = object(req.query, ["locationId", "cursor", "organizationId", "organization_id"]), { scope, draft } = await scopedPurchase(req, (req.params as { id: string }).id, query.locationId);
    const rows = await PharmacyPurchaseReceipt.find({ organizationId: scope.organizationId, locationId: scope.locationId, purchaseId: draft._id, ...(query.cursor ? { _id: { $gt: identifier(query.cursor) } } : {}) }).sort({ _id: 1 }).limit(11).lean();
    const page = rows.slice(0, 10);
    return reply.send(successResponse({ items: page.map(row => { const { normalizedDeliveryReference: _reference, ...value } = dto(row); return value; }), nextCursor: rows.length > 10 ? String(page.at(-1)!._id) : null }));
  } catch (error) { return failure(reply, error); }
}
async function write(req: FastifyRequest, reply: FastifyReply, parties: boolean) {
  reply.header("Cache-Control", "no-store");
  try { const id = (req.params as { id?: string }).id, row = parties ? await savePharmacyParty(req, id) : await savePharmacyPurchaseDraft(req, id); return reply.code(id ? 200 : 201).send(successResponse(dto(row))); }
  catch (error) { return failure(reply, error); }
}
