import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { checkLocationAccess } from "../utilities/tenant.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { cancelDeviceEnrollment, createDeviceChallenge, enrollOfflineDevice, readOfflineDevice, revokeOfflineDevice, type EnrollmentInput } from "../services/PharmacyOfflineDeviceService.ts";

export function offlineDeviceController(action: "read" | "history" | "challenge" | "enroll" | "revoke" | "cancel") {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const { locationId } = req.params as { locationId: string };
      if (!mongoose.isValidObjectId(locationId)) throw new CommandError(400, "Invalid branch");
      const access = await checkLocationAccess(req, locationId);
      if (!access.allowed) return reply.code(access.statusCode).send(errorResponse(access.message));
      const scope = { organizationId: access.organizationId!, locationId, actorId: req.user!.id };
      const body = req.body as Record<string, unknown>;
      if (action !== "read" && action !== "history") {
        const keys = action === "challenge" ? ["deviceId", "publicKey"] : action === "cancel" ? ["challengeId", "confirmed"] : action === "revoke" ? ["expectedRevision", "reviewReference", "confirmed"]
          : ["expectedRevision", "expectedNumberingRevision", "expectedFinancialYear", "count", "deviceName", "reviewReference", "confirmed", "challengeId", "proof"];
        if (!body || typeof body !== "object" || Array.isArray(body) || keys.some(key => !Object.hasOwn(body, key)) || Object.keys(body).some(key => !keys.includes(key))) throw new CommandError(400, "Use only the required PC enrollment fields");
      }
      if ((action === "revoke" || action === "cancel") && body.confirmed !== true) throw new CommandError(400, "Confirm cancellation or revocation of this PC enrollment");
      const result = action === "read" ? await readOfflineDevice(scope) : action === "history" ? await readOfflineDevice(scope, (req.params as { deviceId: string }).deviceId) : action === "challenge" ? await createDeviceChallenge(scope, body.deviceId, body.publicKey)
        : action === "enroll" ? await enrollOfflineDevice(scope, body as unknown as EnrollmentInput) : action === "cancel" ? await cancelDeviceEnrollment(scope, body.challengeId) : await revokeOfflineDevice(scope, body.expectedRevision as number, body.reviewReference as string);
      return reply.send(successResponse(result));
    } catch (failure) {
      return reply.code(failure instanceof CommandError ? failure.statusCode : 500).send(errorResponse(failure instanceof CommandError ? failure.message : "PC enrollment outcome could not be confirmed. Check the branch before retrying."));
    }
  };
}
