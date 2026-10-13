import { OrgMember } from "../models/OrgMember.ts";
import { User } from "../models/User.ts";
import { resolveStaffLocationGrant } from "./LocationAccessService.ts";
import { CommandError } from "./CommandReceiptService.ts";
import { getEffectivePermissions } from "../utilities/permissions.ts";

export async function validateCrmAssignee(userId: string, organizationId: string, locationId: string, permission = "VIEW_CRM") {
  const member = await OrgMember.findOne({ userId, organizationId }).lean();
  if (!member || ["patient", "family_member", "guest", "root"].includes(member.role) || !await User.exists({ _id: userId, isActive: true })) throw new CommandError(400, "Choose an active staff member in this workspace");
  const grant = await resolveStaffLocationGrant(userId, organizationId, member.role, true);
  if (grant !== undefined && !grant.includes(locationId)) throw new CommandError(400, "The assignee does not have access to this branch");
  const permissions = await getEffectivePermissions(member.role, organizationId, 1, true);
  if (!permissions.has("VIEW_CRM") || !permissions.has(permission)) throw new CommandError(400, "The assignee does not have permission to work on this CRM item");
  return member;
}
