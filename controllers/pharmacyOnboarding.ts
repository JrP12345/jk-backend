import type { FastifyRequest, FastifyReply } from "fastify";
import { pharmacyOnboardingOptions, startPharmacyOnboarding, resendPharmacyOnboarding, verifyPharmacyOnboarding, pharmacyOnboardingStatus, completePharmacyOnboarding } from "../services/PharmacyOnboardingService.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { WorkspaceError } from "../services/WorkspaceService.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { User } from "../models/User.ts";
import { completeVerifiedLogin } from "./auth.ts";

export function pharmacyOnboardingController(stage: "options" | "start" | "resend" | "verify" | "status" | "complete") {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    try {
      if (stage === "complete") {
        const completed = await completePharmacyOnboarding(req.body, req.headers["idempotency-key"]);
        const owner = await User.findOne({ _id: completed.ownerUserId, isActive: true });
        if (!owner) throw new CommandError(403, "Account is unavailable; sign in again");
        return await completeVerifiedLogin(req, reply, owner, { onboarding: completed }, false, completed.organization.id);
      }
      const data = stage === "options" ? await pharmacyOnboardingOptions() : stage === "start" ? await startPharmacyOnboarding(req.body)
        : stage === "resend" ? await resendPharmacyOnboarding(req.body) : stage === "verify" ? await verifyPharmacyOnboarding(req.body) : await pharmacyOnboardingStatus(req.body);
      return reply.code(stage === "start" ? 201 : 200).send(successResponse(data));
    } catch (error) {
      if (error instanceof CommandError || error instanceof WorkspaceError) return reply.code(error.statusCode).send(errorResponse(error.message));
      if ((error as { code?: number })?.code === 11000) return reply.code(409).send(errorResponse("This identity already has a setup claim. Sign in or resume its existing request"));
      req.log.error({ stage, reason: (error as Error)?.name || "unknown" }, "Verified pharmacy setup failed");
      return reply.code(500).send(errorResponse("Setup could not be confirmed. Keep the original proof and completion reference; check status before trying again"));
    }
  };
}
