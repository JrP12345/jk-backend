import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { checkLocationAccess } from "../utilities/tenant.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { readPharmacyNumbering, savePharmacyNumbering, type PharmacyNumberingInput } from "../services/PharmacyInvoiceNumberingService.ts";

export function pharmacyNumberingSettings(save = false) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const { locationId } = req.params as { locationId: string };
      if (!mongoose.isValidObjectId(locationId)) throw new CommandError(400, "Invalid branch");
      const access = await checkLocationAccess(req, locationId);
      if (!access.allowed) return reply.code(access.statusCode).send(errorResponse(access.message));
      const result = save ? await savePharmacyNumbering(access.organizationId!, locationId, req.user!.id, req.body as PharmacyNumberingInput)
        : await readPharmacyNumbering(access.organizationId!, locationId);
      return reply.send(successResponse(result));
    } catch (failure) { return reply.code(failure instanceof CommandError ? failure.statusCode : 500).send(errorResponse(failure instanceof CommandError ? failure.message : "Invoice numbering could not be confirmed. Reload before saving.")); }
  };
}
export async function assertPharmacyNumberingBody(req: FastifyRequest) {
  const allowed = new Set(["expectedRevision", "expectedFinancialYear", "prefixTemplate", "digits", "resetPolicy", "nextNumber", "reviewReference"]);
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).some(key => !allowed.has(key)))
    throw new CommandError(400, "Use only the invoice numbering fields for this branch");
}
export const pharmacyNumberingSchema = { body: { type: "object", additionalProperties: false,
  required: ["expectedRevision", "expectedFinancialYear", "prefixTemplate", "digits", "resetPolicy", "nextNumber", "reviewReference"], properties: {
    expectedFinancialYear: { type: "string", pattern: "^20[0-9]{2}-[0-9]{2}$" },
    expectedRevision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 }, prefixTemplate: { type: "string", minLength: 2, maxLength: 20 },
    digits: { type: "integer", minimum: 1, maximum: 9 }, resetPolicy: { type: "string", enum: ["continuous", "financial_year"] },
    nextNumber: { type: "integer", minimum: 1, maximum: 999999999 }, reviewReference: { type: "string", minLength: 3, maxLength: 500 },
  } } };
