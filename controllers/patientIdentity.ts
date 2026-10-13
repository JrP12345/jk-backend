import type { FastifyRequest, FastifyReply } from "fastify";
import { FamilyRelationship } from "../models/FamilyRelationship.ts";
import { Patient } from "../models/Patient.ts";
import { PatientRelationship } from "../models/PatientRelationship.ts";
import { User } from "../models/User.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { CrmActivity } from "../models/CrmActivity.ts";
import { crmPatientAuthority } from "../services/CrmAuthorityService.ts";
import { crmAuthority } from "../services/CrmAuthorityService.ts";
import { checkLocationAccess } from "../utilities/tenant.ts";
import { hasPatientRecordAccess } from "../services/PatientRecordAccessService.ts";
import { patientAdministrativeDTO } from "../services/PatientAdministrativeDTO.ts";
import { CommandError, executeRecordedCommand } from "../services/CommandReceiptService.ts";
import { successResponse, errorResponse, normalizePhone } from "../utilities/helpers.ts";

async function respondFailure(req: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof CommandError) return reply.code(error.statusCode).send(errorResponse(error.message, error.details));
  req.log.error({ err: error }, "Patient identity command failed");
  return reply.code(503).send(errorResponse("The update could not be confirmed. Retry the same request."));
}
export async function associateOrganizationPatient(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const authority = await crmAuthority(req);
    const input = req.body as any;
    const branch = await checkLocationAccess(req, input.locationId, { requireExplicitScope: true });
    if (!branch.allowed || branch.organizationId !== authority.organizationId) throw new CommandError(404, "Location not available in this workspace");
    const proof = input.verificationMethod === "in_person" ? input.identityVerified === true
      : await hasPatientRecordAccess(req.headers["x-patient-record-access"] as string | undefined, id, authority.actorId, authority.organizationId, req.user?.sessionId);
    if (!proof || !input.reason.trim()) throw new CommandError(403, "Verify the patient identity and authority before associating an existing record");
    await executeRecordedCommand(`patient-association:${authority.organizationId}:${authority.actorId}:${id}`, input.clientRequestId, input, async () => {
      const patient = await Patient.findById(id).setOptions({ bypassTenantFilter: true }).select("dpdpStatus");
      if (!patient || patient.dpdpStatus === "ANONYMIZED") throw new CommandError(404, "Patient record not available for association");
      const relationship = await PatientRelationship.findOneAndUpdate({ organizationId: authority.organizationId, patientId: id },
        { $setOnInsert: { locationId: input.locationId, status: "active", revision: 0 } }, { upsert: true, returnDocument: "after" });
      if (relationship.status !== "active") throw new CommandError(409, "The organization relationship is archived and requires review");
      await CrmActivity.create({ organizationId: authority.organizationId, locationId: input.locationId, patientId: id, actorId: authority.actorId,
        kind: "patient_associated", outcome: input.verificationMethod, note: input.reason.trim() });
      await AuditLog.create({ organizationId: authority.organizationId, userId: authority.actorId, action: "PATIENT_ORGANIZATION_ASSOCIATED",
        targetId: id, targetModel: "Patient", category: "ADMIN", details: { verificationMethod: input.verificationMethod, locationId: input.locationId } });
      return id;
    });
    const patient = await Patient.findById(id).setOptions({ bypassTenantFilter: true }).populate("userId", "name phone email").lean();
    return reply.send(successResponse(patientAdministrativeDTO(patient), "Existing patient associated with this organization"));
  } catch (error) { return respondFailure(req, reply, error); }
}
export async function listPatientIdentityClaims(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    await crmPatientAuthority(req, id);
    const { cursor } = req.query as { cursor?: string };
    const claims = await FamilyRelationship.find({ patientId: id, status: "pending", identityClaim: true, ...(cursor ? { _id: { $gt: cursor } } : {}) })
      .populate("userId", "name").sort({ _id: 1 }).limit(21).lean();
    return reply.send(successResponse({ items: claims.slice(0, 20).map((claim: any) => ({ id: String(claim._id),
      accountName: claim.userId?.name || "Patient account", requestedAt: claim.createdAt })), nextCursor: claims.length > 20 ? String(claims[19]._id) : null }));
  } catch (error) { return respondFailure(req, reply, error); }
}
export async function reviewPatientIdentityClaim(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id, claimId } = req.params as { id: string; claimId: string };
    const authority = await crmPatientAuthority(req, id);
    const input = req.body as { decision: "approve" | "reject"; reason: string; identityVerified?: boolean; clientRequestId: string };
    const reason = input.reason.trim();
    if (!reason || (input.decision === "approve" && input.identityVerified !== true)) throw new CommandError(400, "Verified identity and a review reason are required for approval");
    await executeRecordedCommand(`patient-identity-review:${authority.organizationId}:${authority.actorId}:${claimId}`, input.clientRequestId, input, async () => {
      const claim = await FamilyRelationship.findOne({ _id: claimId, patientId: id, status: "pending", identityClaim: true });
      if (!claim) throw new CommandError(409, "The claim has already changed. Reload before reviewing.");
      const user = await User.findOne({ _id: claim.userId, isActive: true, role: { $in: ["patient", "family_member"] } });
      if (!user || String(user._id) === authority.actorId) throw new CommandError(403, "A separate authorized reviewer must verify the patient account");
      if (input.decision === "approve") {
        const existing = await Patient.exists({ userId: claim.userId, _id: { $ne: id } }).setOptions({ bypassTenantFilter: true });
        if (existing) throw new CommandError(409, "The account already has a patient identity. Resolve the identity conflict through a reviewed duplicate-resolution process; do not overwrite either record.");
        const linked = await Patient.updateOne({ _id: id, $or: [{ userId: { $exists: false } }, { userId: null }] },
          { $set: { userId: claim.userId, accountType: "self" } }).setOptions({ bypassTenantFilter: true });
        if (linked.modifiedCount !== 1) throw new CommandError(409, "The patient identity has already changed");
      }
      const changed = await FamilyRelationship.updateOne({ _id: claimId, status: "pending" }, { $set: {
        status: input.decision === "approve" ? "active" : "revoked", reviewedBy: authority.actorId, reviewedAt: new Date(), reviewReason: reason,
      } });
      if (changed.modifiedCount !== 1) throw new CommandError(409, "The claim has already changed");
      await CrmActivity.create({ organizationId: authority.organizationId, patientId: id, actorId: authority.actorId,
        kind: "identity_claim_reviewed", outcome: input.decision, note: reason });
      await AuditLog.create({ organizationId: authority.organizationId, userId: authority.actorId, action: "PATIENT_IDENTITY_CLAIM_REVIEWED",
        targetId: id, targetModel: "Patient", category: "ADMIN", details: { claimId, decision: input.decision } });
      return claimId;
    });
    return reply.send(successResponse(null, "Identity review recorded"));
  } catch (error) { return respondFailure(req, reply, error); }
}
export async function getOrganizationPatientContact(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const authority = await crmPatientAuthority(req, id);
    const relationship = await PatientRelationship.findOne({ organizationId: authority.organizationId, patientId: id }).lean() as any;
    return reply.send(successResponse({ revision: relationship?.revision || 0,
      phone: relationship?.contact?.phone ?? authority.patient.phone ?? (authority.patient.userId as any)?.phone ?? "",
      email: relationship?.contact?.email ?? authority.patient.email ?? (authority.patient.userId as any)?.email ?? "",
      availability: relationship?.contact?.availability || "unknown" }));
  } catch (error) { return respondFailure(req, reply, error); }
}
export async function correctOrganizationPatientContact(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const authority = await crmPatientAuthority(req, id);
    const input = req.body as any;
    const phone = input.phone ? normalizePhone(input.phone) : "";
    const email = input.email?.trim().toLowerCase() || "";
    if (phone && !/^\d{10}$/.test(phone)) throw new CommandError(400, "Enter a valid Indian phone number");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CommandError(400, "Enter a valid contact email");
    if (!input.reason.trim()) throw new CommandError(400, "A contact correction reason is required");
    await executeRecordedCommand(`patient-contact:${authority.organizationId}:${authority.actorId}:${id}`, input.clientRequestId, input, async () => {
      await PatientRelationship.updateOne({ organizationId: authority.organizationId, patientId: id },
        { $setOnInsert: { revision: 0, status: "active" } }, { upsert: true });
      const relationship = await PatientRelationship.findOneAndUpdate({ organizationId: authority.organizationId,
        patientId: id, revision: input.expectedRevision }, { $set: { contact: { phone, email,
        availability: input.availability, recipientType: "patient", correctedAt: new Date(), correctedBy: authority.actorId } }, $inc: { revision: 1 } },
        { returnDocument: "after", runValidators: true });
      if (!relationship) throw new CommandError(409, "Contact details have changed. Reload before saving.");
      await CrmActivity.create({ organizationId: authority.organizationId, patientId: id, actorId: authority.actorId,
        kind: "contact_corrected", outcome: input.availability, note: input.reason.trim(), revision: relationship.revision });
      await AuditLog.create({ organizationId: authority.organizationId, userId: authority.actorId, action: "PATIENT_ORGANIZATION_CONTACT_CORRECTED",
        targetId: id, targetModel: "Patient", category: "ADMIN", details: { revision: relationship.revision } });
      return relationship.id;
    });
    return getOrganizationPatientContact(req, reply);
  } catch (error) { return respondFailure(req, reply, error); }
}
