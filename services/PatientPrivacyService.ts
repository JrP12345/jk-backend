import { PatientRelationship } from "../models/PatientRelationship.ts";
import { TaskModel } from "../models/Task.ts";
import { CrmActivity } from "../models/CrmActivity.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { getOrganizationPatient } from "./PatientRecordAccessService.ts";
import { CommandError, executeRecordedCommand } from "./CommandReceiptService.ts";
import { pinFamilyAuthority } from "./FamilyAuthorityService.ts";

export async function getPrivacyRequest(patientId: string, organizationId: string) {
  const relationship = await PatientRelationship.findOne({ patientId, organizationId }).lean() as any;
  return { patientId, organizationId, revision: relationship?.revision || 0, request: relationship?.privacyRequest || null,
    scope: "Organization CRM contact, preferences and administrative notes. Shared identity, accounts, consent evidence and clinical/billing records require separate retention review." };
}
export async function requestPatientErasure(patientId: string, actorId: string, organizationId: string,
  input: { clientRequestId: string; reason: string }, familyRelationshipId?: string) {
  if (!input.reason?.trim() || input.reason.length > 500) throw new CommandError(400, "Provide a request reason of at most 500 characters");
  await executeRecordedCommand(`privacy-request:${organizationId}:${actorId}:${patientId}`, input.clientRequestId, input, async () => {
    if (familyRelationshipId) await pinFamilyAuthority(patientId, organizationId, "dataRights", familyRelationshipId, actorId);
    if (!await getOrganizationPatient(patientId, organizationId)) throw new CommandError(404, "Patient not found in this organization");
    const relationship = await PatientRelationship.findOneAndUpdate({ patientId, organizationId }, { $setOnInsert: { status: "active", revision: 0 } }, { upsert: true, returnDocument: "after" }) as any;
    if (["requested", "under_review"].includes(relationship.privacyRequest?.status)) return relationship.id;
    const task = await TaskModel.findOneAndUpdate({ organizationId, dedupeKey: `privacy:${patientId}` }, { $set: { status: "review" }, $setOnInsert: {
      title: "Review a privacy request", kind: "privacy_review", patientId, locationId: relationship.locationId, createdBy: actorId, priority: "high" } }, { upsert: true, returnDocument: "after" });
    await PatientRelationship.updateOne({ _id: relationship._id }, { $set: { privacyRequest: { status: "requested", requestedAt: new Date() } }, $inc: { revision: 1 } });
    await CrmActivity.create({ organizationId, locationId: relationship.locationId, patientId, actorId, taskId: task._id, kind: "privacy_requested", visibility: "privacy", note: input.reason.trim() });
    await AuditLog.create({ userId: actorId, organizationId, action: "PRIVACY_REQUESTED", targetId: patientId, targetModel: "Patient", category: "COMPLIANCE_DPDP" });
    return relationship.id;
  });
  return getPrivacyRequest(patientId, organizationId);
}
export async function reviewPrivacyRequest(patientId: string, actorId: string, organizationId: string,
  input: { clientRequestId: string; expectedRevision: number; decision: "under_review" | "retained" | "rejected" | "fulfilled"; reason: string; retentionBasis: string; scopeConfirmed?: boolean }) {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 || !["under_review", "retained", "rejected", "fulfilled"].includes(input.decision) ||
    !input.reason?.trim() || input.reason.length > 500 || !input.retentionBasis?.trim() || input.retentionBasis.length > 200) throw new CommandError(400, "A revision, decision, bounded review reason and record-specific retention basis are required");
  if (input.decision === "fulfilled" && input.scopeConfirmed !== true) throw new CommandError(400, "Confirm the limited CRM erasure scope");
  await executeRecordedCommand(`privacy-review:${organizationId}:${actorId}:${patientId}`, input.clientRequestId, input, async () => {
    const relationship = await PatientRelationship.findOne({ patientId, organizationId }) as any;
    if (!relationship || !["requested", "under_review"].includes(relationship.privacyRequest?.status) || relationship.revision !== input.expectedRevision) throw new CommandError(409, "Privacy request changed. Reload before reviewing.");
    const update: any = { "privacyRequest.status": input.decision, "privacyRequest.reviewedBy": actorId, "privacyRequest.reviewedAt": new Date(), "privacyRequest.retentionBasis": input.retentionBasis.trim() };
    if (input.decision === "fulfilled") {
      update.contact = { phone: "", email: "", availability: "unknown", recipientType: "patient" };
      update.preferences = { doNotContact: true, preferredChannel: "none" };
      await CrmActivity.updateMany({ organizationId, patientId, $or: [{ visibility: "administrative" }, { visibility: { $exists: false } }] }, { $unset: { note: 1 } });
    }
    const changed = await PatientRelationship.updateOne({ _id: relationship._id, revision: input.expectedRevision }, { $set: update, $inc: { revision: 1 } }, { runValidators: true });
    if (changed.modifiedCount !== 1) throw new CommandError(409, "Privacy request changed. Reload before reviewing.");
    await TaskModel.updateOne({ organizationId, dedupeKey: `privacy:${patientId}` }, { $set: { status: input.decision === "under_review" ? "review" : "completed" }, $inc: { revision: 1 } });
    await CrmActivity.create({ organizationId, locationId: relationship.locationId, patientId, actorId, kind: "privacy_reviewed", visibility: "privacy", outcome: input.decision, note: input.reason.trim(), revision: input.expectedRevision + 1 });
    await AuditLog.create({ userId: actorId, organizationId, action: "PRIVACY_REVIEWED", targetId: patientId, targetModel: "Patient", category: "COMPLIANCE_DPDP", details: { decision: input.decision, scope: "organization_crm", retentionBasis: input.retentionBasis.trim() } });
    return relationship.id;
  });
  return getPrivacyRequest(patientId, organizationId);
}
