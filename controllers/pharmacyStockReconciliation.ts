import type { FastifyReply, FastifyRequest } from "fastify";
import { CommandError } from "../services/CommandReceiptService.ts";
import { getStockReconciliation, previewStockReconciliation, commitStockReconciliation, recoverStockReconciliation } from "../services/PharmacyStockReconciliationService.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

export function stockReconciliationController(stage: "snapshot" | "preview" | "commit" | "recover") {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const { locationId, key } = req.params as { locationId: string; key: string };
      const data = stage === "snapshot" ? await getStockReconciliation(req, locationId) : stage === "preview" ? await previewStockReconciliation(req, locationId) : stage === "commit" ? await commitStockReconciliation(req, locationId) : await recoverStockReconciliation(req, locationId, key);
      return reply.send(successResponse(data));
    } catch (error) {
      return reply.code(error instanceof CommandError ? error.statusCode : 500).send({ ...errorResponse(error instanceof CommandError ? error.message : "Count outcome could not be confirmed. Keep its reference and check the saved result before retrying."), ...(error instanceof CommandError && error.details ? { details: error.details } : {}) });
    }
  };
}
