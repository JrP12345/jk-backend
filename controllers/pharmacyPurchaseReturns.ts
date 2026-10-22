import type { FastifyReply, FastifyRequest } from "fastify";
import { readPurchaseReturnSource, quotePurchaseReturn, commitPurchaseReturn, recoverPurchaseReturn } from "../services/PharmacyPurchaseReturnService.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { PharmacyInventoryError } from "../utilities/pharmacyInventory.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof CommandError || error instanceof PharmacyInventoryError) return reply.code(error.statusCode).send(errorResponse(error.message));
  if ((error as { code?: number }).code === 11000) return reply.code(409).send(errorResponse("Supplier return identity conflicts; recover the original reference"));
  return reply.code(500).send(errorResponse("Supplier return could not be confirmed. Keep the same reference and check before posting again."));
}
export async function readSupplierReturnSource(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store"); try { return reply.send(successResponse(await readPurchaseReturnSource(req, (req.params as { id: string }).id, (req.query as { locationId?: string }).locationId))); } catch (error) { return failure(reply, error); }
}
export async function previewSupplierReturn(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store"); try { return reply.send(successResponse(await quotePurchaseReturn(req, (req.params as { id: string }).id))); } catch (error) { return failure(reply, error); }
}
export async function postSupplierReturn(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store"); try { return reply.code(201).send(successResponse(await commitPurchaseReturn(req, (req.params as { id: string }).id))); } catch (error) { return failure(reply, error); }
}
export async function recoverSupplierReturn(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store"); try { return reply.send(successResponse(await recoverPurchaseReturn(req, (req.query as { locationId?: string }).locationId, (req.params as { key: string }).key))); } catch (error) { return failure(reply, error); }
}
