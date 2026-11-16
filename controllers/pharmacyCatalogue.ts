import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Medicine } from "../models/Medicine.ts";
import { object, identifier } from "../schemas/pharmacyPurchases.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { purchaseScope } from "../services/PharmacyPurchaseDraftService.ts";
import { COUNTER_PRODUCT_FIELDS, counterProduct } from "../utilities/pharmacyCounterProduct.ts";
import { errorResponse, successResponse } from "../utilities/helpers.ts";

/** Bounded read-only page revalidation, not a frozen stock snapshot or a billing authority. */
export async function getCounterCataloguePage(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const query = object(req.query, ["locationId", "after", "through", "knownHash", "organizationId", "organization_id"]);
    const scope = await purchaseScope(req, query.locationId);
    const after = query.after === undefined ? null : identifier(query.after), knownHash = query.knownHash;
    if (knownHash !== undefined && (typeof knownHash !== "string" || !/^[a-f0-9]{64}$/.test(knownHash))) throw new CommandError(400, "Invalid catalogue page version");
    if (after && query.through === undefined) throw new CommandError(400, "Continue within the catalogue traversal boundary");
    const owner = { locationId: scope.locationId, deletedAt: null };
    const through = query.through === undefined ? String((await Medicine.findOne(owner).select("_id").sort({ _id: -1 }).maxTimeMS(3000).lean())?._id || "") || null : identifier(query.through);
    if (after && through && after > through) throw new CommandError(400, "Catalogue cursor exceeds the traversal boundary");
    const rows = through ? await Medicine.find({ ...owner, _id: { $lte: through, ...(after ? { $gt: after } : {}) } })
      .select(COUNTER_PRODUCT_FIELDS).sort({ _id: 1 }).limit(201).maxTimeMS(3000).lean() : [];
    const items = rows.slice(0, 200).map(counterProduct), nextCursor = rows.length > 200 ? items.at(-1)!.id : null;
    // Exclude the traversal's upper ID from the fingerprint: unchanged earlier pages can
    // be reused when new products extend the branch. Page boundaries remain fingerprinted.
    const hash = createHash("sha256").update(JSON.stringify({ version: 1, locationId: scope.locationId, after, items, nextCursor })).digest("hex");
    return reply.send(successResponse({ version: 1, locationId: scope.locationId, after, through, hash, count: items.length, nextCursor, items: knownHash === hash ? null : items }));
  } catch (failure) {
    if (failure instanceof CommandError) return reply.code(failure.statusCode).send(errorResponse(failure.message));
    return reply.code(503).send(errorResponse("Offline catalogue could not be refreshed. Existing cached preparation is unchanged."));
  }
}
