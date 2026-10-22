import type { FastifyReply, FastifyRequest } from "fastify";
import { readDrawers, recoverDrawerCommand, writeDrawerCommand } from "../services/CashierDrawerService.ts";
import type { DrawerChannel } from "../services/CashierDrawerService.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { errorResponse, successResponse } from "../utilities/helpers.ts";
function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof CommandError) return reply.code(error.statusCode).send(errorResponse(error.message));
  if ((error as { code?: number }).code === 11000) return reply.code(409).send(errorResponse("Drawer identity or cash reference already exists; recover the original operation"));
  return reply.code(500).send(errorResponse("Drawer operation could not be confirmed; keep the same reference and check its result"));
}
export const readCashierDrawer = (history = false, channel: DrawerChannel = "pharmacy") => async (req: FastifyRequest, reply: FastifyReply) => {
  reply.header("Cache-Control", "no-store");
  try { return reply.send(successResponse(await readDrawers(req, (req.query as { locationId?: string }).locationId, (req.params as { id?: string }).id, history, channel))); }
  catch (error) { return failure(reply, error); }
};
export const postCashierDrawer = (kind: "open" | "close" | "movement", channel: DrawerChannel = "pharmacy") => async (req: FastifyRequest, reply: FastifyReply) => {
  reply.header("Cache-Control", "no-store");
  try { return reply.code(201).send(successResponse(await writeDrawerCommand(req, kind, (req.params as { id?: string }).id, channel))); }
  catch (error) { return failure(reply, error); }
};
export const getCashierDrawerOperation = (channel: DrawerChannel = "pharmacy") => async (req: FastifyRequest, reply: FastifyReply) => {
  reply.header("Cache-Control", "no-store");
  try { return reply.send(successResponse(await recoverDrawerCommand(req, (req.query as { locationId?: string }).locationId, (req.params as { key: string }).key, channel))); }
  catch (error) { return failure(reply, error); }
};
