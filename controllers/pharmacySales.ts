import type { FastifyReply, FastifyRequest } from "fastify";
import { Invoice } from "../models/Invoice.ts";
import { PharmacyDispense } from "../models/PharmacyDispense.ts";
import { issuePharmacySale, recoverPharmacySale } from "../services/PharmacySaleService.ts";
import { purchaseScope } from "../services/PharmacyPurchaseDraftService.ts";
import { object, identifier } from "../schemas/pharmacyPurchases.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { PharmacyInventoryError } from "../utilities/pharmacyInventory.ts";
import { errorResponse, successResponse } from "../utilities/helpers.ts";
import { quoteCounterSale } from "../services/PharmacySaleQuoteService.ts";
import { Medicine } from "../models/Medicine.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { PharmacyOpeningBalance } from "../models/PharmacyOpeningBalance.ts";
import { text } from "../schemas/pharmacyPurchases.ts";

function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof CommandError || error instanceof PharmacyInventoryError) return reply.code(error.statusCode).send(errorResponse(error.message));
  if ((error as { code?: number }).code === 11000) return reply.code(409).send(errorResponse("Sale source or invoice identity conflicts; recover the original reference"));
  return reply.code(500).send(errorResponse("Counter issue could not be confirmed. Keep the same reference and check the result before another issue."));
}
export async function postCounterInvoice(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try { return reply.code(201).send(successResponse(await issuePharmacySale(req))); } catch (error) { return failure(reply, error); }
}
export async function postCounterQuote(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try { return reply.send(successResponse(await quoteCounterSale(req))); } catch (error) { return failure(reply, error); }
}
const escapeSearch = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export async function searchCounterProducts(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const query = object(req.query, ["locationId", "search", "barcode", "cursor", "organizationId", "organization_id"]), scope = await purchaseScope(req, query.locationId);
    if (query.search !== undefined && query.barcode !== undefined) throw new CommandError(400, "Use either an exact barcode or product search");
    const barcode = query.barcode === undefined ? undefined : text(query.barcode, "barcode", 1, 100);
    const search = query.search === undefined ? "" : text(query.search, "product search", 0, 100);
    const prefix = new RegExp(`^${escapeSearch(search)}`, "i");
    const rows = await Medicine.find({ locationId: scope.locationId, deletedAt: null,
      ...(barcode ? { barcodes: barcode } : search ? { $or: [{ name: prefix }, { genericName: prefix }] } : {}),
      ...(query.cursor ? { _id: { $gt: identifier(query.cursor) } } : {}) }).select("name genericName strength manufacturer unitDefinition stockQuantity scheduleType dispensingRevision dispensingReview").sort({ _id: 1 }).limit(26).lean();
    const page = rows.slice(0, 25);
    return reply.send(successResponse({ items: page.map(row => ({ id: String(row._id), name: row.name, genericName: row.genericName, strength: row.strength, manufacturer: row.manufacturer,
      unitDefinition: row.unitDefinition, stockQuantity: row.stockQuantity, eligible: Boolean(row.unitDefinition && row.scheduleType === "general" && row.dispensingReview?.scheduleType === "general" && row.dispensingReview.confirmedAt && row.dispensingReview.confirmedBy && row.dispensingReview.reviewReference && row.dispensingRevision >= 1) })), nextCursor: rows.length > 25 ? String(page.at(-1)!._id) : null }));
  } catch (error) { return failure(reply, error); }
}
export async function searchCounterCustomers(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const query = object(req.query, ["locationId", "search", "cursor", "organizationId", "organization_id"]), scope = await purchaseScope(req, query.locationId);
    const search = query.search === undefined ? "" : text(query.search, "customer search", 0, 100);
    const rows = await PharmacyParty.find({ organizationId: scope.organizationId, locationIds: scope.locationId, kinds: "customer", archived: false, gstin: { $exists: false },
      ...(search ? { normalizedName: { $regex: `^${escapeSearch(search.normalize("NFKC").toLowerCase())}` } } : {}), ...(query.cursor ? { _id: { $gt: identifier(query.cursor) } } : {}) }).select("name address phone revision").sort({ _id: 1 }).limit(26).lean();
    const page = rows.slice(0, 25);
    return reply.send(successResponse({ items: page.map(row => ({ id: String(row._id), name: row.name, address: row.address, phone: row.phone, revision: row.revision })), nextCursor: rows.length > 25 ? String(page.at(-1)!._id) : null }));
  } catch (error) { return failure(reply, error); }
}
export async function getCounterOperation(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try { return reply.send(successResponse(await recoverPharmacySale(req, (req.query as { locationId?: string }).locationId, (req.params as { key: string }).key))); } catch (error) { return failure(reply, error); }
}
export async function getCounterInvoice(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const scope = await purchaseScope(req, (req.query as { locationId?: string }).locationId), id = identifier((req.params as { id: string }).id);
    const invoice = await Invoice.findOne({ _id: id, kind: "pharmacy", organizationId: scope.organizationId, locationId: scope.locationId, deletedAt: null }).lean();
    if (!invoice) throw new CommandError(404, "Counter invoice not found");
    if (invoice.documentVersion === 3) {
      if (!await PharmacyOpeningBalance.exists({ _id: invoice.openingBalanceId, invoiceId: invoice._id, organizationId: scope.organizationId, locationId: scope.locationId, kind: "customer_due" })) throw new CommandError(409, "Opening balance statement source needs review");
      const { _id, __v: _version, ...fields } = invoice;
      return reply.send(successResponse({ ...fields, id: String(_id) }));
    }
    const source = await PharmacyDispense.findOne({ invoiceId: id, kind: "pharmacy", organizationId: scope.organizationId, locationId: scope.locationId }).lean();
    if (!source || source.lines.length !== invoice.items.length) throw new CommandError(409, "Counter invoice source evidence needs review");
    const items = invoice.items.map((item: any) => { const line = source.lines.find(line => String(line._id) === String(item.pharmacyDispenseLineId));
      if (!line) throw new CommandError(409, "Counter invoice source line needs review");
      return { ...item, unitSnapshot: line.unitSnapshot, batches: line.pricingAllocations.map(lot => ({ batchId: lot.batchId, batchNumber: lot.batchNumber, expiryValue: lot.expiryValue, expiryPrecision: lot.expiryPrecision, quantity: lot.quantity, sellingPricePaise: Math.round(lot.unitPrice * 100), mrpPaise: lot.mrpPaise })) };
    });
    const { _id, __v: _version, ...fields } = invoice;
    return reply.send(successResponse({ ...fields, id: String(_id), items }));
  } catch (error) { return failure(reply, error); }
}
export async function listCounterInvoices(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const query = object(req.query, ["locationId", "cursor", "organizationId", "organization_id"]), scope = await purchaseScope(req, query.locationId);
    const rows = await Invoice.find({ kind: "pharmacy", organizationId: scope.organizationId, locationId: scope.locationId, deletedAt: null, ...(query.cursor ? { _id: { $gt: identifier(query.cursor) } } : {}) }).select("invoiceNumber issuedAt status totalAmount currency customerSnapshot documentVersion").sort({ _id: 1 }).limit(26).lean();
    const page = rows.slice(0, 25);
    return reply.send(successResponse({ items: page.map(({ _id, ...fields }: any) => ({ ...fields, id: String(_id) })), nextCursor: rows.length > 25 ? String(page.at(-1)!._id) : null }));
  } catch (error) { return failure(reply, error); }
}
