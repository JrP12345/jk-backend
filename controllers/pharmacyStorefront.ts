import type { FastifyReply, FastifyRequest } from "fastify";
import { publicMedicinePage, readStorefrontSettings, saveStorefrontSettings } from "../services/PharmacyStorefrontService.ts";
import { requestPublicPickup, readPublicPickup, pickupPage, scanPickup, transitionPickup } from "../services/PharmacyPickupService.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { errorResponse, successResponse } from "../utilities/helpers.ts";

function endpoint(work: (req: FastifyRequest) => Promise<unknown>, status = 200) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
    try { return reply.code(status).send(successResponse(await work(req))); }
    catch (failure) {
      if (failure instanceof CommandError) return reply.code(failure.statusCode).send(errorResponse(failure.message));
      if ((failure as { code?: number }).code === 11000) return reply.code(409).send(errorResponse("This ticket or bill is already linked. Check the original pickup before trying again"));
      req.log.error({ err: failure instanceof Error ? failure.name : "Unknown" }, "Pharmacy pickup operation failed");
      return reply.code(500).send(errorResponse("The pickup operation could not be confirmed. Keep the same reference and check again"));
    }
  };
}
export const getPublicMedicines = endpoint(publicMedicinePage);
export const createPublicPickup = endpoint(requestPublicPickup, 201);
export const getPublicPickup = endpoint(readPublicPickup);
export const getPickupQueue = endpoint(pickupPage);
export const resolvePickupTicket = endpoint(scanPickup);
export const updatePickup = endpoint(transitionPickup);
export const getStorefront = endpoint(readStorefrontSettings);
export const updateStorefront = endpoint(saveStorefrontSettings);
