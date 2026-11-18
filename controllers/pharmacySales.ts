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
import { COUNTER_PRODUCT_FIELDS, counterProduct } from "../utilities/pharmacyCounterProduct.ts";
import { counterInvoiceDocument } from "../utilities/pharmacyInvoiceDocument.ts";
import { PharmacySaveTimings } from "../services/PharmacySaveTimings.ts";
import { medicineSearchFilter, customerSearchFilter } from "../utilities/pharmacySearch.ts";

function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof CommandError || error instanceof PharmacyInventoryError) return reply.code(error.statusCode).send(errorResponse(error.message, error instanceof CommandError ? error.details : undefined));
  if ((error as { code?: number }).code === 11000) return reply.code(409).send(errorResponse("Sale source or invoice identity conflicts; recover the original reference"));
  return reply.code(500).send(errorResponse("Counter issue could not be confirmed. Keep the same reference and check the result before another issue."));
}
function searchFailure(reply: FastifyReply, error: unknown, kind: "Medicine" | "Customer" | "Sale") {
  if (error instanceof CommandError || error instanceof PharmacyInventoryError) return failure(reply, error);
  return reply.code(503).send(errorResponse(`${kind} search is unavailable. Try a more specific search or retry.`));
}
export async function postCounterInvoice(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  const started = performance.now(), timings = new PharmacySaveTimings();
  try { const saved = await issuePharmacySale(req, timings); reply.header("Server-Timing", timings.header(performance.now() - started)); return reply.code(201).send(successResponse(saved)); }
  catch (error) { reply.header("Server-Timing", timings.header(performance.now() - started)); return failure(reply, error); }
}
export async function postCounterQuote(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try { return reply.send(successResponse(await quoteCounterSale(req))); } catch (error) { return failure(reply, error); }
}
export async function searchCounterProducts(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const query = object(req.query, ["locationId", "search", "barcode", "cursor", "organizationId", "organization_id"]), scope = await purchaseScope(req, query.locationId);
    if (query.search !== undefined && query.barcode !== undefined) throw new CommandError(400, "Use either an exact barcode or product search");
    const barcode = query.barcode === undefined ? undefined : text(query.barcode, "barcode", 1, 100);
    const search = query.search === undefined ? "" : text(query.search, "product search", 0, 100);
    const rows = await Medicine.find({ locationId: scope.locationId, deletedAt: null,
      ...(barcode ? { barcodes: barcode } : medicineSearchFilter(search)),
      ...(query.cursor ? { _id: { $gt: identifier(query.cursor) } } : {}) }).select(COUNTER_PRODUCT_FIELDS).sort({ _id: 1 }).limit(26).maxTimeMS(3000).lean();
    const page = rows.slice(0, 25);
    return reply.send(successResponse({ items: page.map(counterProduct), nextCursor: rows.length > 25 ? String(page.at(-1)!._id) : null }));
  } catch (error) { return searchFailure(reply, error, "Medicine"); }
}
export async function searchCounterCustomers(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const query = object(req.query, ["locationId", "search", "cursor", "organizationId", "organization_id"]), scope = await purchaseScope(req, query.locationId);
    const search = query.search === undefined ? "" : text(query.search, "customer search", 0, 100);
    const rows = await PharmacyParty.find({ organizationId: scope.organizationId, locationIds: scope.locationId, kinds: "customer", archived: false, gstin: { $exists: false },
      ...customerSearchFilter(search), ...(query.cursor ? { _id: { $gt: identifier(query.cursor) } } : {}) }).select("name address phone revision").sort({ _id: 1 }).limit(26).maxTimeMS(3000).lean();
    const page = rows.slice(0, 25);
    return reply.send(successResponse({ items: page.map(row => ({ id: String(row._id), name: row.name, address: row.address, phone: row.phone, revision: row.revision })), nextCursor: rows.length > 25 ? String(page.at(-1)!._id) : null }));
  } catch (error) { return searchFailure(reply, error, "Customer"); }
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
    return reply.send(successResponse(counterInvoiceDocument(invoice, source)));
  } catch (error) { return failure(reply, error); }
}
export async function listCounterInvoices(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const query = object(req.query, ["locationId", "cursor", "customerId", "search", "status", "organizationId", "organization_id"]), scope = await purchaseScope(req, query.locationId);
    const customerId = query.customerId === undefined ? undefined : identifier(query.customerId);
    const search = query.search === undefined ? "" : text(query.search, "sale search", 0, 100);
    const status = query.status === undefined ? "all" : text(query.status, "sale status", 1, 20);
    if (!["all", "paid", "unpaid"].includes(status)) throw new CommandError(400, "Invalid sale payment filter");
    const pattern = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (customerId && !await PharmacyParty.exists({ _id: customerId, organizationId: scope.organizationId, locationIds: scope.locationId, kinds: "customer" })) throw new CommandError(404, "Customer not found at this branch");
    const rows = await Invoice.find({ kind: "pharmacy", organizationId: scope.organizationId, locationId: scope.locationId, deletedAt: null,
      ...(customerId ? { "customerSnapshot.partyId": customerId } : {}),
      ...(search ? { $or: [{ invoiceNumber: { $regex: pattern, $options: "i" } }, { "customerSnapshot.name": { $regex: pattern, $options: "i" } }] } : {}),
      ...(status === "paid" ? { status: "paid" } : status === "unpaid" ? { status: { $in: ["unpaid", "partially_paid"] } } : {}),
      ...(query.cursor ? { _id: { $lt: identifier(query.cursor) } } : {})
    }).select("invoiceNumber issuedAt status totalAmount amountPaid balanceDue currency customerSnapshot documentVersion").sort({ _id: -1 }).limit(26).maxTimeMS(3000).lean();
    const page = rows.slice(0, 25);
    return reply.send(successResponse({ ...(customerId ? { customerId, locationId: scope.locationId } : {}), items: page.map(({ _id, ...fields }: any) => ({ ...fields, id: String(_id) })), nextCursor: rows.length > 25 ? String(page.at(-1)!._id) : null }));
  } catch (error) { return searchFailure(reply, error, "Sale"); }
}
