import type { FastifyReply, FastifyRequest } from "fastify";
import { PharmacyShortbook } from "../models/PharmacyShortbook.ts";
import { Medicine } from "../models/Medicine.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { object, identifier, text, whole } from "../schemas/pharmacyPurchases.ts";
import { purchaseScope } from "../services/PharmacyPurchaseDraftService.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { createWithSession, withTransaction } from "../utilities/transaction.ts";
import { pinActivePharmacyLocation } from "../utilities/pharmacyCapability.ts";
import { requireStockTransaction } from "../utilities/pharmacyInventory.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof CommandError) return reply.code(error.statusCode).send(errorResponse(error.message));
  if ((error as { code?: number }).code === 11000) return reply.code(409).send(errorResponse("Shortbook changed. Reload the existing entry before editing it."));
  return reply.code(503).send(errorResponse("Shortbook is unavailable. Reload its current entries before retrying."));
}
export async function listPharmacyShortbook(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const query = object(req.query, ["locationId", "cursor", "status", "medicineId", "organizationId", "organization_id"]), scope = await purchaseScope(req, query.locationId);
    const status = query.status ?? "open";
    if (!["open", "resolved"].includes(status)) throw new CommandError(400, "Choose open or resolved shortbook entries");
    const records = await PharmacyShortbook.find({ organizationId: scope.organizationId, locationId: scope.locationId,
      ...(query.medicineId ? { medicineId: identifier(query.medicineId) } : { status }), ...(query.cursor ? { _id: { $gt: identifier(query.cursor) } } : {}) }).sort({ _id: 1 }).limit(26).maxTimeMS(3000).lean();
    const page = records.slice(0, 25);
    const products = await Medicine.find({ locationId: scope.locationId, _id: { $in: page.map(row => row.medicineId) }, deletedAt: null })
      .select("name price hsnCode unitDefinition stockQuantity rackLocation").limit(25).maxTimeMS(3000).lean();
    return reply.send(successResponse({ items: page.map(row => {
      const product = products.find(product => String(product._id) === String(row.medicineId));
      return { id: String(row._id), medicineId: String(row.medicineId), quantity: row.quantity, unitVersion: row.unitVersion, note: row.note, status: row.status, revision: row.revision,
        updatedAt: row.updatedAt.toISOString(), product: product ? { id: String(product._id), name: product.name, price: product.price, hsnCode: product.hsnCode,
          unitDefinition: product.unitDefinition, stockQuantity: product.stockQuantity, rackLocation: product.rackLocation } : null };
    }), nextCursor: records.length > 25 ? String(page.at(-1)!._id) : null }));
  } catch (error) { return failure(reply, error); }
}
export async function savePharmacyShortbook(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const body = object(req.body, ["locationId", "quantity", "expectedUnitVersion", "expectedRevision", "note", "status", "organizationId", "organization_id"]), scope = await purchaseScope(req, body.locationId);
    const medicineId = identifier((req.params as { medicineId: string }).medicineId), quantity = whole(body.quantity, "shortbook quantity", 1_000_000), unitVersion = whole(body.expectedUnitVersion, "unit version"), expectedRevision = whole(body.expectedRevision, "shortbook revision", Number.MAX_SAFE_INTEGER - 1);
    const note = text(body.note ?? "", "shortbook note", 0, 300), status = body.status;
    if (quantity < 1 || unitVersion < 1 || !["open", "resolved"].includes(status) || /[\p{Cc}\p{Cf}]/u.test(note)) throw new CommandError(400, "Enter a positive whole quantity, valid unit version and open/resolved status");
    const saved = await withTransaction(async session => {
      requireStockTransaction(session);
      // Serialize catalogue-unit edits and concurrent entry creation at this branch, before reading.
      await pinActivePharmacyLocation(scope.locationId, session);
      const current = await PharmacyShortbook.findOne({ organizationId: scope.organizationId, locationId: scope.locationId, medicineId }).session(session);
      if ((current?.revision ?? 0) !== expectedRevision) throw new CommandError(409, "Shortbook changed. Reload the existing entry before editing it.");
      const medicine = await Medicine.findOne({ _id: medicineId, locationId: scope.locationId, deletedAt: null }).select("unitDefinition").session(session);
      const closingOriginal = status === "resolved" && current && current.quantity === quantity && current.unitVersion === unitVersion;
      if (!medicine && !closingOriginal) throw new CommandError(404, "Medicine not found at this branch");
      if (medicine?.unitDefinition?.version !== unitVersion && !closingOriginal) throw new CommandError(409, "Medicine units changed. Reload and re-enter the requested base units.");
      const fields = { quantity, unitVersion, note, status, revision: expectedRevision + 1, updatedBy: scope.actorId };
      const row = current ? await PharmacyShortbook.findOneAndUpdate({ _id: current._id, revision: expectedRevision }, { $set: fields }, { session, returnDocument: "after", runValidators: true })
        : await createWithSession<InstanceType<typeof PharmacyShortbook>>(PharmacyShortbook, { ...fields, organizationId: scope.organizationId, locationId: scope.locationId, medicineId }, session);
      if (!row) throw new CommandError(409, "Shortbook changed. Reload before editing it.");
      await createWithSession(AuditLog, { organizationId: scope.organizationId, userId: scope.actorId, category: "ADMIN", action: "PHARMACY_SHORTBOOK_UPDATED", targetModel: "PharmacyShortbook", targetId: row._id,
        details: { medicineId, quantity, unitVersion, status, revision: row.revision } }, session);
      return { id: String(row._id), revision: row.revision };
    });
    return reply.send(successResponse(saved));
  } catch (error) { return failure(reply, error); }
}
