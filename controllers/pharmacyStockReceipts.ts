import type { FastifyRequest, FastifyReply } from "fastify";
import { Medicine } from "../models/Medicine.ts";
import { checkLocationAccess, checkOperationalRecordAccess } from "../utilities/tenant.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { normalizeStockReceipt } from "../utilities/pharmacyLot.ts";
import { PharmacyInventoryError } from "../utilities/pharmacyInventory.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { pharmacyRequestAllows } from "../services/PharmacyCapabilityService.ts";
import { receivePharmacyStock, recoverPharmacyStockReceipt } from "../services/PharmacyStockReceiptService.ts";

async function redact(req: FastifyRequest, data: any) {
  if (!await pharmacyRequestAllows(req, "viewCost") && data.batch) { delete data.batch.purchaseCost; delete data.batch.costBasis; }
  return data;
}
function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof CommandError || error instanceof PharmacyInventoryError) return reply.code(error.statusCode).send(errorResponse(error.message));
  if ((error as { code?: number }).code === 11000) return reply.code(409).send(errorResponse("Receipt identity or batch-label constraint changed. Keep the reference and request inventory review."));
  return reply.code(500).send(errorResponse("Stock receipt outcome is uncertain. Keep the same reference and check its outcome before receiving again."));
}
export async function postPharmacyStockReceipt(req: FastifyRequest, reply: FastifyReply) {
  try {
    const input = normalizeStockReceipt(req.body);
    const access = await checkLocationAccess(req, input.locationId);
    if (!access.allowed) return reply.code(access.statusCode).send(errorResponse(access.message));
    const medicine = await Medicine.findOne({ _id: input.medicineId, locationId: input.locationId });
    if (!medicine) return reply.code(404).send(errorResponse("Medicine not found"));
    const record = await checkOperationalRecordAccess(req, medicine);
    if (!record.allowed) return reply.code(record.statusCode).send(errorResponse(record.message));
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(428, "A stable Idempotency-Key containing 8 to 100 letters, digits, underscores or hyphens is required");
    const result = await receivePharmacyStock({ organizationId: access.organizationId!, locationId: input.locationId, actorId: req.user!.id }, key, input);
    reply.header("Cache-Control", "no-store");
    return reply.code(result.replayed ? 200 : 201).send(successResponse(await redact(req, result), "Stock receipt recorded"));
  } catch (error) { return failure(reply, error); }
}
export async function getPharmacyStockReceipt(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { key } = req.params as { key: string }, { locationId } = req.query as { locationId?: string };
    if (!locationId || !/^[a-f\d]{24}$/i.test(locationId)) throw new CommandError(400, "A location is required to recover a stock receipt");
    const access = await checkLocationAccess(req, locationId);
    if (!access.allowed) return reply.code(access.statusCode).send(errorResponse(access.message));
    const data = await recoverPharmacyStockReceipt({ organizationId: access.organizationId!, locationId: locationId.toLowerCase(), actorId: req.user!.id }, key);
    reply.header("Cache-Control", "no-store");
    return reply.code(200).send(successResponse(await redact(req, data), "Committed stock receipt recovered"));
  } catch (error) { return failure(reply, error); }
}
