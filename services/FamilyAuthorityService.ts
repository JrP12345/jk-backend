import { FamilyRelationship } from "../models/FamilyRelationship.ts";
import { User } from "../models/User.ts";
import { PatientRelationship } from "../models/PatientRelationship.ts";
import { getOrganizationPatient } from "./PatientRecordAccessService.ts";
import { CommandError } from "./CommandReceiptService.ts";

export type FamilyPurpose = "communication" | "consent" | "dataRights";
export function familyAuthorization(relationship: any, organizationId: string) {
  return relationship?.organizationAuthorizations?.find((row: any) => String(row.organizationId) === organizationId);
}

export async function authorizedFamilyRelationship(patientId: string, organizationId: string, purpose: FamilyPurpose, filter: Record<string, unknown> = {}) {
  const relationship = await FamilyRelationship.findOne({ ...filter, patientId, status: "active", organizationAuthorizations: { $elemMatch: { organizationId, [purpose]: true, reviewedBy: { $type: "objectId" }, reviewedAt: { $type: "date" } } } }).lean();
  if (!relationship || !await User.exists({ _id: relationship.userId, isActive: true, role: { $in: ["patient", "family_member"] } })) return null;
  return relationship;
}
/** Pin a reviewed delegation in a transaction so revocation conflicts with use. */
export async function pinFamilyAuthority(patientId: string, organizationId: string, purpose: FamilyPurpose, relationshipId: string, actorId?: string) {
  const relationship = await authorizedFamilyRelationship(patientId, organizationId, purpose, { _id: relationshipId, ...(actorId ? { userId: actorId } : {}) });
  if (!relationship) throw new CommandError(403, "Current organization family authority is required");
  const revision = relationship.authorityRevision || 0;
  const changed = await FamilyRelationship.updateOne({ _id: relationshipId, status: "active", $or: [{ authorityRevision: revision }, ...(revision === 0 ? [{ authorityRevision: { $exists: false } }] : [])] }, { $inc: { authorityUseRevision: 1 } });
  if (changed.modifiedCount !== 1) throw new CommandError(409, "Family authority changed. Reload before continuing.");
  return familyAuthorization(relationship, organizationId).revision;
}
// Resolve only the explicitly selected organization recipient. Never choose an
// arbitrary family member from a shared phone or first matching relationship.
export async function organizationCommunicationRecipient(patientId: string, organizationId: string) {
  const patient = await getOrganizationPatient(patientId, organizationId);
  if (!patient) throw new CommandError(404, "Patient not found in this organization");
  const relationship = await PatientRelationship.findOne({ patientId, organizationId, status: "active" }).lean() as any;
  if (relationship?.contact?.recipientType === "family") {
    const family = relationship.contact.familyRelationshipId && await authorizedFamilyRelationship(patientId, organizationId, "communication", { _id: relationship.contact.familyRelationshipId });
    if (!family) return { phone: "", email: "", recipientType: "family", available: false, doNotContact: true, familyRelationshipId: String(relationship.contact.familyRelationshipId || "") };
    const user = await User.findById(family.userId).select("phone email name").lean();
    return { phone: user?.phone || "", email: user?.email || "", userId: String(family.userId), recipientType: "family", familyRelationshipId: String(family._id), familyAuthorityRevision: familyAuthorization(family, organizationId).revision, available: !["unreachable", "invalid"].includes(relationship.contact.availability), doNotContact: relationship.preferences?.doNotContact === true };
  }
  return { phone: relationship?.contact?.phone ?? patient.phone ?? (patient.userId as any)?.phone ?? "", email: relationship?.contact?.email ?? patient.email ?? (patient.userId as any)?.email ?? "", userId: (patient.userId as any)?._id?.toString(), recipientType: "patient", available: !["unreachable", "invalid"].includes(relationship?.contact?.availability), doNotContact: relationship?.preferences?.doNotContact === true };
}
