import type { FastifyRequest, FastifyReply } from "fastify";
import { Location } from "../models/Location.ts";
import { offlineOwnerFilter } from "../utilities/pharmacyOfflineOwnership.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { pharmacyCapabilities, pharmacyRequestAllows } from "../services/PharmacyCapabilityService.ts";
import { loadPharmacyIssuer } from "../services/PharmacyDocumentService.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { withTransaction } from "../utilities/transaction.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { PHARMACY_ROLE_PRESETS } from "../utilities/pharmacyPermissions.ts";
import { PharmacyDispense } from "../models/PharmacyDispense.ts";
import { createWithSession } from "../utilities/transaction.ts";

function failure(reply: FastifyReply, error: unknown) {
  return reply.code(error instanceof CommandError ? error.statusCode : 500).send(errorResponse(error instanceof CommandError ? error.message : "Unable to read or save pharmacy capability"));
}
export async function getPharmacyCapabilities(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try { return reply.send(successResponse(await pharmacyCapabilities(req, (req.params as { locationId: string }).locationId))); }
  catch (error) { return failure(reply, error); }
}
export async function getPharmacySettings(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const capabilities = await pharmacyCapabilities(req, (req.params as { locationId: string }).locationId);
    if (!await pharmacyRequestAllows(req, "manageSettings")) throw new CommandError(403, "Pharmacy settings permission is required");
    const location = await Location.findById(capabilities.locationId).select("pharmacyCapability").lean();
    return reply.send(successResponse({ ...capabilities, review: location?.pharmacyCapability || null }));
  } catch (error) { return failure(reply, error); }
}
export async function savePharmacySettings(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const { locationId } = req.params as { locationId: string };
    const { enabled, expectedRevision, reviewReference, inventoryMode: requestedMode } = req.body as { enabled: boolean; expectedRevision: number; reviewReference: string; inventoryMode?: "tracked" | "billing_only" };
    if (reviewReference.trim().length < 3) throw new CommandError(400, "An operating-licence review reference is required");
    await withTransaction(async session => {
      if (!session?.inTransaction()) throw new CommandError(409, "Pharmacy capability changes require a transaction-capable database");
      const current = await pharmacyCapabilities(req, locationId);
      if (!await pharmacyRequestAllows(req, "manageSettings")) throw new CommandError(403, "Pharmacy settings permission is required");
      if (current.revision !== expectedRevision) throw new CommandError(409, "Pharmacy settings changed; reload before saving");
      const inventoryMode = requestedMode || current.inventoryMode;
      if (inventoryMode === "tracked" && current.inventoryMode === "billing_only" && await PharmacyDispense.exists({ locationId, organizationId: current.organizationId, inventoryMode: "billing_only" }).session(session)) throw new CommandError(409, "Billing-only sales exist. Reconcile physical stock before enabling stock tracking; automatic switching is unavailable.");
      if (enabled) await loadPharmacyIssuer(current.organizationId!, locationId);
      const saved = await Location.findOneAndUpdate({ _id: locationId, ...offlineOwnerFilter(locationId), organizationId: current.organizationId, isActive: true,
        ...(expectedRevision === 0 ? { $or: [{ "pharmacyCapability.revision": 0 }, { pharmacyCapability: { $exists: false } }] } : { "pharmacyCapability.revision": expectedRevision }) },
      { $set: { pharmacyCapability: { enabled, inventoryMode, revision: expectedRevision + 1, reviewReference: reviewReference.trim(), confirmedBy: req.user!.id, confirmedAt: new Date() } } }, { session, returnDocument: "after", runValidators: true });
      if (!saved) throw new CommandError(409, "Pharmacy settings changed; reload before saving");
      await createWithSession(AuditLog, { organizationId: current.organizationId, userId: req.user!.id, action: "PHARMACY_CAPABILITY_REVIEWED", targetId: saved._id, targetModel: "Location", category: "ADMIN", details: { locationId, revision: expectedRevision + 1, enabled, inventoryMode, previousInventoryMode: current.inventoryMode } }, session);
    });
    return reply.send(successResponse(await pharmacyCapabilities(req, locationId)));
  } catch (error) { return failure(reply, error); }
}
export async function getPharmacyRolePresets(_req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  return reply.send(successResponse(PHARMACY_ROLE_PRESETS));
}
