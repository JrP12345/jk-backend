import type { FastifyRequest, FastifyReply } from "fastify";
import { errorResponse, successResponse } from "../utilities/helpers.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { acquireOfflineAuthority, readOfflineAuthority, releaseUnusedOfflineAuthority, type AuthorityIntent } from "../services/PharmacyOfflineAuthorityService.ts";
import { prepareOfflineAuthoritySnapshot, readOfflineSnapshotPage } from "../services/PharmacyOfflineSnapshotService.ts";
import { activateOfflineCheckout, readOfflineCheckoutGrant, type OfflineActivationIntent } from "../services/PharmacyOfflineGrantService.ts";
import { importOfflinePharmacyReceipt } from "../services/PharmacyOfflineImportService.ts";
import { closeOfflineCheckout } from "../services/PharmacyOfflineCloseService.ts";

// Every mutation uses current permissions and original signed device evidence.
// Acquisition/preparation alone never enable local issuance.
export async function getOfflineAuthority(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try { return reply.send(successResponse(await readOfflineAuthority(req, (req.params as { locationId: string }).locationId))); }
  catch (failure) { return reply.code(failure instanceof CommandError ? failure.statusCode : 500).send(errorResponse(failure instanceof CommandError ? failure.message : "Branch ownership could not be confirmed")); }
}
export async function getOfflineSnapshotPage(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const { locationId, authorityId, page } = req.params as { locationId: string; authorityId: string; page: string };
    if (!/^-1$|^(0|[1-9][0-9]{0,2})$/.test(page)) throw new CommandError(400, "Invalid offline preparation page");
    return reply.send(successResponse(await readOfflineSnapshotPage(req, locationId, authorityId, Number(page))));
  } catch (failure) { return reply.code(failure instanceof CommandError ? failure.statusCode : 500).send(errorResponse(failure instanceof CommandError ? failure.message : "Offline preparation could not be read")); }
}

export function offlineCheckoutController(action: "acquire" | "prepare" | "activate" | "grant" | "cancel" | "import" | "close") {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const { locationId, authorityId } = req.params as { locationId: string; authorityId?: string }, body = req.body as Record<string, unknown>;
      if (action !== "grant") {
        const fields = action === "acquire" ? ["authorityId", "deviceId", "expectedDeviceRevision", "drawerId", "expectedDrawerRevision", "reviewReference", "confirmed", "requestedAt", "proof", "nextAllocation"]
          : action === "prepare" ? ["authorityId"] : action === "activate" ? ["authorityId", "expectedRevision", "manifestDigest", "reviewReference", "requestedAt", "confirmed", "proof"]
          : action === "cancel" ? ["authorityId", "expectedRevision", "reviewReference", "confirmed", "proof"] : action === "import" ? ["receipt", "digest", "deviceSignature"]
          : ["authorityId", "sequence", "lastDigest", "stoppedAt", "reviewReference", "confirmed", "proof"];
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key)) || fields.filter(key => key !== "nextAllocation").some(key => !Object.hasOwn(body, key))) throw new CommandError(400, "Use only the required original offline checkout fields");
      }
      const result = action === "acquire" ? await acquireOfflineAuthority(req, locationId, body as unknown as AuthorityIntent & { proof: string })
        : action === "prepare" ? await prepareOfflineAuthoritySnapshot(req, locationId, String(body.authorityId))
        : action === "activate" ? await activateOfflineCheckout(req, locationId, body as unknown as OfflineActivationIntent & { proof: string })
        : action === "grant" ? await readOfflineCheckoutGrant(req, locationId, authorityId || "")
        : action === "cancel" ? await releaseUnusedOfflineAuthority(req, locationId, body as unknown as Parameters<typeof releaseUnusedOfflineAuthority>[2])
        : action === "import" ? await importOfflinePharmacyReceipt(req, locationId, body) : await closeOfflineCheckout(req, locationId, body);
      return reply.send(successResponse(result));
    } catch (failure) {
      return reply.code(failure instanceof CommandError ? failure.statusCode : 500).send(errorResponse(failure instanceof CommandError ? failure.message : "Offline operation could not be confirmed. Recover its original reference before retrying."));
    }
  };
}
