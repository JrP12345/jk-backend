import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Clinic } from "../models/Clinic.ts";
import { isModuleEnabledForOrganization } from "../utilities/moduleAccess.ts";
import { MODULE_KEYS, getAlwaysOnModules } from "../data/moduleKeys.ts";

async function resolveModuleOrganizationId(req: FastifyRequest): Promise<string | undefined> {
  if (req.user?.organization_id) {
    return req.user.organization_id;
  }

  // Portal patients often book across clinics without an org claim in their JWT.
  const clinicId =
    (req.headers["x-clinic-id"] as string) ||
    (req.body as { clinicId?: string })?.clinicId ||
    (req.query as { clinicId?: string })?.clinicId;

  if (clinicId && mongoose.Types.ObjectId.isValid(clinicId)) {
    const clinic = await Clinic.findById(clinicId).select("organizationId").lean();
    return clinic?.organizationId?.toString();
  }

  const paramId = (req.params as { id?: string; appointmentId?: string })?.id || (req.params as { id?: string; appointmentId?: string })?.appointmentId;
  if (paramId && mongoose.Types.ObjectId.isValid(paramId)) {
    const { Appointment } = await import("../models/Appointment.ts");
    const appt = await Appointment.findById(paramId).select("organizationId clinicId").lean();
    if (appt?.organizationId) return appt.organizationId.toString();
    if (appt?.clinicId) {
      const clinic = await Clinic.findById(appt.clinicId).select("organizationId").lean();
      if (clinic?.organizationId) return clinic.organizationId.toString();
    }
  }

  return undefined;
}

/**
 * Module Guard Middleware Factory.
 *
 * Checks if the specified module is enabled for the requesting user's organization.
 * Root users bypass module checks (can always access everything).
 * Always-on modules (dashboard, settings, notifications) are never blocked.
 *
 * Usage:
 *   { preHandler: [authenticate, requireModule("laboratory")] }
 */
export function requireModule(moduleKey: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    // Root users, patients, and family members accessing self-service bypass organization-level module gating
    if (req.user?.role === "root" || req.user?.role === "patient" || req.user?.role === "family_member") {
      return;
    }

    // Always-on modules are never gated
    if (getAlwaysOnModules().includes(moduleKey)) {
      return;
    }

    // Validate the module key is known
    if (!MODULE_KEYS[moduleKey]) {
      req.log?.warn(`requireModule: unknown module key '${moduleKey}', allowing request`);
      return;
    }

    const orgId = await resolveModuleOrganizationId(req);
    if (!orgId) {
      return reply.code(403).send({
        success: false,
        error: "Module access denied",
        message: "Organization context is required to check module availability",
      });
    }

    const isEnabled = await isModuleEnabledForOrganization(orgId, moduleKey);

    if (!isEnabled) {
      return reply.code(403).send({
        success: false,
        error: "Module disabled",
        message: `The '${MODULE_KEYS[moduleKey].label}' module is not enabled for your organization. Contact your administrator to enable it.`,
        moduleKey,
      });
    }
  };
}
