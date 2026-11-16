import type { FastifyReply, FastifyRequest } from "fastify";
import { inspectPurchaseCsv, previewPurchaseCsv } from "../services/PharmacyPurchaseCsvService.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { rememberPurchaseCsvMapping } from "../services/PharmacyPurchaseCsvMappingService.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

export async function purchaseCsvInspection(req: FastifyRequest, reply: FastifyReply) { return read(req, reply, false); }
export async function purchaseCsvPreview(req: FastifyRequest, reply: FastifyReply) { return read(req, reply, true); }
export async function purchaseCsvRemember(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try { return reply.send(successResponse(await rememberPurchaseCsvMapping(req))); }
  catch (error) {
    if (error instanceof CommandError) return reply.code(error.statusCode).send(errorResponse(error.message));
    return reply.code(503).send(errorResponse("Supplier mapping save could not be confirmed. Retry the same mapping or choose the file again to check it; your purchase draft is unchanged"));
  }
}
async function read(req: FastifyRequest, reply: FastifyReply, preview: boolean) {
  reply.header("Cache-Control", "no-store");
  try { return reply.send(successResponse(await (preview ? previewPurchaseCsv(req) : inspectPurchaseCsv(req)))); }
  catch (error) {
    if (error instanceof CommandError) return reply.code(error.statusCode).send(errorResponse(error.message));
    return reply.code(503).send(errorResponse("Purchase CSV could not be checked. Your draft has not changed; retry the preview."));
  }
}
