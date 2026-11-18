import type { FastifyReply, FastifyRequest } from "fastify";
import { readMedicineSaleControls, savePharmacySaleControl, readOfflineSaleControlStatus } from "../services/PharmacySaleControlService.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { PharmacyInventoryError } from "../utilities/pharmacyInventory.ts";
import { errorResponse, successResponse } from "../utilities/helpers.ts";

export const pharmacySaleControlController = (kind: "read" | "product" | "batch" | "offline") => async (req: FastifyRequest, reply: FastifyReply) => {
  reply.header("Cache-Control", "no-store");
  try {
    const params = req.params as { id: string; locationId: string; authorityId: string };
    const result = kind === "read" ? await readMedicineSaleControls(req, params.id) : kind === "offline" ? await readOfflineSaleControlStatus(req, params.locationId, params.authorityId) : await savePharmacySaleControl(req, params.id, kind);
    return reply.send(successResponse(result));
  } catch (error) {
    const known = error instanceof CommandError || error instanceof PharmacyInventoryError;
    if (!known) req.log.error({ err: error }, "Sale control failed");
    return reply.code(known ? error.statusCode : 500).send(errorResponse(known ? error.message : "Sale control could not be confirmed. Reload its current result before retrying."));
  }
};
