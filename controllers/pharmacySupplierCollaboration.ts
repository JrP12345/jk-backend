import type { FastifyReply, FastifyRequest } from "fastify";
import { CommandError } from "../services/CommandReceiptService.ts";
import { errorResponse, successResponse } from "../utilities/helpers.ts";
import * as collaboration from "../services/PharmacySupplierCollaborationService.ts";

export function supplierCollaborationController(kind: keyof typeof collaboration, publicRoute = false) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer").header("X-Robots-Tag", "noindex, nofollow").header("X-Content-Type-Options", "nosniff");
    try { return reply.send(successResponse(await collaboration[kind](req, publicRoute ? undefined! : (req.params as { id: string }).id))); }
    catch (error) {
      if (error instanceof CommandError) return reply.code(error.statusCode).send(errorResponse(error.message));
      // Do not log request bodies, capability tokens, filenames or provider payloads.
      req.log.error({ event: "supplier_collaboration_failed", kind }, "Supplier collaboration failed");
      return reply.code(503).send(errorResponse("The supplier operation could not be confirmed. Keep the original request reference, refresh and retry."));
    }
  };
}
