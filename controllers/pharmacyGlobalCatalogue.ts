import type { FastifyRequest, FastifyReply } from "fastify";
import { searchGlobalCatalogue, adoptGlobalProduct } from "../services/PharmacyGlobalCatalogueService.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { errorResponse, successResponse } from "../utilities/helpers.ts";

export const globalCatalogueController = (adopt = false) => async (req: FastifyRequest, reply: FastifyReply) => {
  reply.header("Cache-Control", "no-store");
  try { return reply.send(successResponse(adopt ? await adoptGlobalProduct(req, (req.params as { id: string }).id) : await searchGlobalCatalogue(req))); }
  catch (error) {
    const duplicate = (error as { code?: number }).code === 11000;
    if (!(error instanceof CommandError) && !duplicate) req.log.error({ err: error }, "Shared catalogue request failed");
    return reply.code(error instanceof CommandError ? error.statusCode : duplicate ? 409 : 500).send(errorResponse(error instanceof CommandError ? error.message : duplicate ? "Product already exists; reload the branch catalogue" : "Catalogue unavailable. Existing branch products remain usable. Check the branch before retrying an add."));
  }
};
