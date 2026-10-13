import { DPDPConsent, DPDP_PURPOSES, type DPDPPurpose } from "../models/DPDPConsent.ts";
import { CrmActivity } from "../models/CrmActivity.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { authorizedFamilyRelationship, familyAuthorization, organizationCommunicationRecipient, pinFamilyAuthority } from "./FamilyAuthorityService.ts";
import { getOrganizationPatient } from "./PatientRecordAccessService.ts";
import { computeBlindIndex } from "../utilities/cryptoEnvelope.ts";
import { CommandError, executeRecordedCommand } from "./CommandReceiptService.ts";

export const CONSENT_NOTICE_VERSION = "communication-choices-2026-10-v1";
export type ConsentMethod = "portal_confirmation" | "in_person_confirmation" | "written_consent" | "verified_patient_request";
export interface ConsentCommand {
  actorId: string; clientRequestId: string; expectedRevision: number;
  method: ConsentMethod; noticeVersion: string; acknowledged: boolean; note?: string;
  familyRelationshipId?: string;
}
export async function consentRecipientHash(patientId: string, organizationId: string, purpose: DPDPPurpose) {
  const patient = await getOrganizationPatient(patientId, organizationId);
  if (!patient) throw new CommandError(404, "Patient not found in this organization");
  const selected = await organizationCommunicationRecipient(patientId, organizationId);
  const phone = selected.phone, email = selected.email;
  const recipient = purpose === "COMMUNICATION_EMAIL" ? email : purpose === "AI_CLINICAL_ASSISTANCE" ? patientId : phone;
  const familyBinding = purpose !== "AI_CLINICAL_ASSISTANCE" && selected.recipientType === "family" ? `:family:${selected.familyRelationshipId}:${selected.familyAuthorityRevision}` : "";
  return recipient ? computeBlindIndex(`${organizationId}:${patientId}:${purpose}:${recipient}${familyBinding}`) : "";
}
export async function getPatientConsents(patientId: string, organizationId: string) {
  const doc = await DPDPConsent.findOne({ patientId, organizationId }).lean();
  const purposes = await Promise.all(DPDP_PURPOSES.map(async purpose => {
    const row = doc?.purposes.find(entry => entry.purpose === purpose);
    const evidence = row?.evidence;
    const recipientHash = await consentRecipientHash(patientId, organizationId, purpose);
    const delegation = evidence?.familyRelationshipId ? await authorizedFamilyRelationship(patientId, organizationId, "consent", { _id: evidence.familyRelationshipId, userId: evidence.recordedBy }) : null;
    const delegationValid = !evidence?.familyRelationshipId || !!delegation && familyAuthorization(delegation, organizationId).revision === evidence.familyAuthorityRevision;
    const activityValid = !!evidence?.activityId && !!await CrmActivity.exists({ _id: evidence.activityId, organizationId, patientId, visibility: "consent", actorId: evidence.recordedBy });
    const evidenced = !!(evidence?.noticeVersion === CONSENT_NOTICE_VERSION && evidence?.method && evidence?.recordedBy && evidence?.recordedAt && activityValid && delegationValid);
    const validRecipient = !!recipientHash && evidence?.recipientHash === recipientHash;
    const status = row?.status === "WITHDRAWN" ? "WITHDRAWN" : row?.status === "GRANTED" && evidenced && validRecipient ? "GRANTED" : "UNKNOWN";
    return { purpose, status, updatedAt: row?.updatedAt, reviewRequired: row?.status === "GRANTED" && status === "UNKNOWN" };
  }));
  return { patientId, organizationId, revision: doc?.revision || 0, noticeVersion: CONSENT_NOTICE_VERSION, purposes };
}
export async function updatePatientConsents(patientId: string, organizationId: string,
  updates: { purpose: DPDPPurpose; status: "GRANTED" | "WITHDRAWN" }[], command: ConsentCommand) {
  if (!Array.isArray(updates) || !updates.length || updates.length > DPDP_PURPOSES.length ||
    new Set(updates.map(row => row.purpose)).size !== updates.length ||
    updates.some(row => !DPDP_PURPOSES.includes(row.purpose) || !["GRANTED", "WITHDRAWN"].includes(row.status))) throw new CommandError(400, "Choose valid, distinct consent purposes and statuses");
  if (!Number.isInteger(command.expectedRevision) || command.expectedRevision < 0) throw new CommandError(400, "Consent revision is required");
  if (!["portal_confirmation", "in_person_confirmation", "written_consent", "verified_patient_request"].includes(command.method)) throw new CommandError(400, "A valid evidence method is required");
  if (updates.some(row => row.status === "GRANTED") && (command.acknowledged !== true || command.noticeVersion !== CONSENT_NOTICE_VERSION)) throw new CommandError(400, "Confirm the current notice before granting consent");
  if ((command.note?.length || 0) > 500 || (command.method !== "portal_confirmation" && !command.note?.trim())) throw new CommandError(400, "Record a bounded patient instruction as evidence");
  await executeRecordedCommand(`patient-consent:${organizationId}:${command.actorId}:${patientId}`, command.clientRequestId, { updates, ...command }, async () => {
    const familyAuthorityRevision = command.familyRelationshipId ? await pinFamilyAuthority(patientId, organizationId, "consent", command.familyRelationshipId, command.actorId) : undefined;
    await DPDPConsent.updateOne({ patientId, organizationId }, { $setOnInsert: { revision: 0, purposes: [], history: [] } }, { upsert: true });
    const doc = await DPDPConsent.findOne({ patientId, organizationId });
    if (!doc || (doc.revision || 0) !== command.expectedRevision) throw new CommandError(409, "Consent choices changed. Reload before saving.");
    const activity = await CrmActivity.create({ organizationId, patientId, actorId: command.actorId, kind: "consent_recorded", visibility: "consent", consentChanges: updates, note: command.note?.trim(), revision: command.expectedRevision + 1 });
    const now = new Date();
    const purposes = doc.purposes.map(row => row.toObject());
    for (const update of updates) {
      const recipientHash = await consentRecipientHash(patientId, organizationId, update.purpose);
      if (update.status === "GRANTED" && !recipientHash) throw new CommandError(400, "A verified recipient is required for this channel");
      const row = { ...update, updatedAt: now, evidence: { noticeVersion: CONSENT_NOTICE_VERSION, method: command.method, recordedBy: command.actorId,
        recordedAt: now, activityId: activity._id, recipientHash, familyRelationshipId: command.familyRelationshipId, familyAuthorityRevision } };
      const index = purposes.findIndex(entry => entry.purpose === update.purpose);
      if (index < 0) purposes.push(row as any); else purposes[index] = row as any;
    }
    const changed = await DPDPConsent.updateOne({ _id: doc._id, $or: [{ revision: command.expectedRevision }, ...(command.expectedRevision === 0 ? [{ revision: { $exists: false } }] : [])] },
      { $set: { purposes }, $inc: { revision: 1 }, $push: { history: { $each: updates.map(row => ({ purpose: row.purpose, action: row.status, timestamp: now,
        actorId: command.actorId, source: command.method === "portal_confirmation" ? "PATIENT_PORTAL" : "LOCATION_DESK" })), $slice: -100 } } }, { runValidators: true });
    if (changed.modifiedCount !== 1) throw new CommandError(409, "Consent choices changed. Reload before saving.");
    await AuditLog.create({ userId: command.actorId, organizationId, action: "DPDP_CONSENT_UPDATED", targetId: patientId, targetModel: "Patient", category: "COMPLIANCE_DPDP", details: { updates, revision: command.expectedRevision + 1, activityId: activity.id } });
    return doc.id;
  });
  return getPatientConsents(patientId, organizationId);
}
