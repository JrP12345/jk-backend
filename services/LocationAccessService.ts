import { OrgMember } from "../models/OrgMember.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Receptionist } from "../models/Receptionist.ts";
import { Location } from "../models/Location.ts";

/** undefined means an explicit all-branch grant (or administrator); [] denies access.
 * Legacy clinical/front-desk profiles supply their existing branch assignments,
 * never organization-wide authority. No records are migrated on reads.
 */
export async function resolveStaffLocationGrant(userId: string, organizationId: string, role: string, strict = false): Promise<string[] | undefined> {
  const member = await OrgMember.findOne({ userId, organizationId }).select("role locationAccess").lean();
  if (member && member.role !== role) return [];
  if (strict && !member) return [];
  const ownedLocations = async (ids: string[]) => (await Location.find({
    _id: { $in: ids }, organizationId, isActive: { $ne: false },
  }).select("_id").lean()).map(location => String(location._id));
  if (member?.locationAccess) {
    if (member.locationAccess.mode === "all") return undefined;
    return ownedLocations([...new Set((member.locationAccess.locationIds || []).map(String))]);
  }
  if (member && role === "admin") return undefined;
  if (role === "doctor") {
    const assignments = await DoctorAssignment.find({ doctorId: userId, organizationId, isActive: true }).select("locationId").lean();
    return ownedLocations([...new Set(assignments.map(assignment => String(assignment.locationId)))]);
  }
  if (role === "receptionist") {
    const profile = await Receptionist.findOne({ userId, organizationId }).select("locationId").lean();
    return profile?.locationId ? ownedLocations([String(profile.locationId)]) : [];
  }
  return [];
}
