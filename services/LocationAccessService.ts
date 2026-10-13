import { OrgMember } from "../models/OrgMember.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Receptionist } from "../models/Receptionist.ts";

/** undefined means all branches; [] means none. Missing grants never mean all in CRM. */
export async function resolveStaffLocationGrant(userId: string, organizationId: string, role: string, strict = false): Promise<string[] | undefined> {
  const member = await OrgMember.findOne({ userId, organizationId }).select("role locationAccess").lean();
  if (strict && (!member || member.role !== role)) return [];
  if (member?.locationAccess) {
    if (member.locationAccess.mode === "all") return undefined;
    return [...new Set((member.locationAccess.locationIds || []).map(String))];
  }
  if (!strict) return undefined; // Preserve legacy modules until a reviewed explicit grant is saved.
  if (!member || member.role !== role) return [];
  if (role === "admin") return undefined;
  if (role === "doctor") {
    const assignments = await DoctorAssignment.find({ doctorId: userId, organizationId, isActive: true }).select("locationId").lean();
    return [...new Set(assignments.map(assignment => String(assignment.locationId)))];
  }
  if (role === "receptionist") {
    const profile = await Receptionist.findOne({ userId, organizationId }).select("locationId").lean();
    return profile?.locationId ? [String(profile.locationId)] : [];
  }
  return [];
}
