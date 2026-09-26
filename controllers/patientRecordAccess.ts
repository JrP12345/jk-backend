import type { FastifyRequest, FastifyReply } from "fastify";
import crypto from "node:crypto";
import { otpService } from "../services/OtpService.ts";
import { getOrganizationPatient, recordTokenHash } from "../services/PatientRecordAccessService.ts";
import { PatientRecordAccess } from "../models/PatientRecordAccess.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";

async function accessContext(req: FastifyRequest) {
  const { id } = req.params as { id: string };
  const scope = resolveAuthorizedOrganizationScope(req);
  if (!scope.allowed || !scope.organizationId || !req.user?.sessionId || ["guest", "patient", "family_member"].includes(req.user.role)) return null;
  if (!/^[a-f\d]{24}$/i.test(id)) return null;
  const patient = await getOrganizationPatient(id, scope.organizationId);
  if (!patient) return null;
  const account = patient.userId as any;
  const target = account?.phone || patient.phone ? { phone: account?.phone || patient.phone } : { email: account?.email || patient.email };
  if (!target.phone && !target.email) throw new Error("Patient has no contact number or email. Update their contact details first.");
  return { patientId: id, organizationId: scope.organizationId, userId: req.user.id, sessionId: req.user.sessionId, target,
    context: `${id}:${scope.organizationId}:${req.user.id}:${req.user.sessionId}` };
}
export async function requestPatientRecordOtp(req: FastifyRequest, reply: FastifyReply) {
  try {
    const access = await accessContext(req);
    if (!access) return reply.code(404).send(errorResponse("Patient not found in this organization"));
    const result = await otpService.requestOtp(access.target, "record_access", access.context);
    return reply.send(successResponse({ expiresInSeconds: result.expiresInSeconds }, "An OTP was sent to the patient's registered contact to approve access to their full history."));
  } catch (error: any) { return reply.code(400).send(errorResponse(error.message || "Could not send patient approval OTP")); }
}
export async function verifyPatientRecordOtp(req: FastifyRequest, reply: FastifyReply) {
  try {
    const access = await accessContext(req);
    if (!access) return reply.code(404).send(errorResponse("Patient not found in this organization"));
    const { otp } = req.body as { otp: string };
    const verification = await otpService.verifyOtp(access.target, otp, "record_access", access.context);
    if (!verification.verified) return reply.code(400).send(errorResponse(verification.message));
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await AuditLog.create({ userId: access.userId, organizationId: access.organizationId, action: "PATIENT_RECORD_ACCESS_APPROVED", targetId: access.patientId, targetModel: "Patient", category: "CLINICAL_READ", details: { method: "patient_otp", expiresAt } });
    await PatientRecordAccess.create({ tokenHash: recordTokenHash(token), patientId: access.patientId, userId: access.userId, organizationId: access.organizationId, sessionId: access.sessionId, expiresAt });
    return reply.send(successResponse({ token, expiresAt }, "Patient approved full-history access for 10 minutes"));
  } catch { return reply.code(400).send(errorResponse("Could not verify patient approval. Please request a new OTP.")); }
}
