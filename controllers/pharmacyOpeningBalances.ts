import type { FastifyReply, FastifyRequest } from "fastify";
import { createOpeningBalance, readOpeningBalance, recoverOpeningBalance } from "../services/PharmacyOpeningBalanceService.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { PharmacyInventoryError } from "../utilities/pharmacyInventory.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof CommandError || error instanceof PharmacyInventoryError) return reply.code(error.statusCode).send(errorResponse(error.message));
  if ((error as { code?: number }).code === 11000) return reply.code(409).send(errorResponse("This actual opening source is already recorded. Recover the original reference."));
  return reply.code(500).send(errorResponse("Opening source could not be confirmed. Keep the same reference and check before recording again."));
}
export async function postOpeningBalance(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store"); try { return reply.code(201).send(successResponse(await createOpeningBalance(req))); } catch (error) { return failure(reply, error); }
}
export async function getOpeningBalance(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store"); try { return reply.send(successResponse(await readOpeningBalance(req, (req.params as { id: string }).id, (req.query as { locationId?: string }).locationId))); } catch (error) { return failure(reply, error); }
}
export async function getOpeningBalanceOperation(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store"); try { return reply.send(successResponse(await recoverOpeningBalance(req, (req.query as { locationId?: string }).locationId, (req.params as { key: string }).key))); } catch (error) { return failure(reply, error); }
}
