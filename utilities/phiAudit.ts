import type { FastifyRequest } from "fastify";
import { AuditLog } from "../models/AuditLog.ts";
import { requestContextStore } from "./context.ts";

export interface PhiAccessOptions {
  action: string; // e.g. "VIEW_PATIENT_SUMMARY", "VIEW_CLINICAL_NOTE", "VIEW_LAB_RESULTS"
  targetId: string;
  targetModel: string; // "Patient", "ClinicalNote", "LabOrder"
  patientId?: string;
  details?: any;
}

export async function logPhiReadAccess(req: FastifyRequest, options: PhiAccessOptions): Promise<void> {
  const context = requestContextStore.getStore();
  const userId = req.user?.id || context?.userId;
  if (!userId) return;

  const ipAddress = (req.headers["x-forwarded-for"] as string) || req.ip || context?.ipAddress || "127.0.0.1";
  const userAgent = (req.headers["user-agent"] as string) || context?.userAgent || "unknown";
  const cleanIp = Array.isArray(ipAddress) ? ipAddress[0] : ipAddress.split(",")[0].trim();

  try {
    await AuditLog.create({
      userId,
      organizationId: req.user?.organization_id || context?.organizationId || undefined,
      action: options.action,
      targetId: options.targetId,
      targetModel: options.targetModel,
      category: "CLINICAL_READ",
      ipAddress: cleanIp,
      userAgent,
      details: {
        patientId: options.patientId,
        readAt: new Date().toISOString(),
        ...options.details,
      },
    });
  } catch (err) {
    console.error("PHI Read Access log creation failed:", err);
  }
}
