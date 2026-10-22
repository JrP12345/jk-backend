import type { FastifyRequest, FastifyReply } from "fastify";
import { CommandError } from "../services/CommandReceiptService.ts";
import { PharmacyInventoryError } from "../utilities/pharmacyInventory.ts";
import { commandPharmacyTransfer, listPharmacyTransfers, readPharmacyTransfer, recoverPharmacyTransfer, transferProducts, transferSourceLots } from "../services/PharmacyTransferService.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import type { TransferAction } from "../schemas/pharmacyTransfers.ts";

export function pharmacyTransferController(action: TransferAction | "list" | "read" | "recover" | "products" | "lots") {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const params = req.params as { id?: string; key?: string }, query = req.query as { locationId?: string; cursor?: string; eventCursor?: string; action?: TransferAction; transferId?: string; medicineId?: string; search?: string };
      let result;
      if (action === "products") result = await transferProducts(req, query.locationId!, query.search);
      else if (action === "lots") result = await transferSourceLots(req, query.locationId!, query.medicineId!, query.cursor);
      else if (action === "list") result = await listPharmacyTransfers(req, query.locationId!, query.cursor);
      else if (action === "read") result = await readPharmacyTransfer(req, params.id!, query.locationId!, query.eventCursor);
      else if (action === "recover") {
        if (!["create", "approve", "dispatch", "receive", "resolve", "cancel"].includes(query.action || "") || !/^[a-zA-Z0-9_-]{8,100}$/.test(params.key || "") || query.action !== "create" && !query.transferId) throw new CommandError(400, "Provide the original transfer stage and reference");
        result = await recoverPharmacyTransfer(req, query.locationId!, query.action!, params.key!, query.transferId);
      } else result = await commandPharmacyTransfer(req, action, params.id);
      return reply.code(action === "create" && !result.replayed ? 201 : 200).send(successResponse(result));
    } catch (error) {
      return reply.code(error instanceof CommandError || error instanceof PharmacyInventoryError ? error.statusCode : 500).send(errorResponse(error instanceof CommandError || error instanceof PharmacyInventoryError ? error.message : "Transfer could not be confirmed. Retain the stage reference and request review"));
    }
  };
}
