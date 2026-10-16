import { Role } from '../models/Role.ts';
import { BUILTIN_ROLE_PERMISSIONS } from '../utilities/permissions.ts';
import { CommandError } from './CommandReceiptService.ts';

// Share the caller's transaction. Writing the role serializes assignment with
// permission edits/deletion, so a preflight lookup cannot create a dangling grant.
export async function pinAssignableRole(name: string, organizationId?: string) {
  if (organizationId && ["root", "patient", "family_member", "guest"].includes(name)) {
    throw new CommandError(403, 'Consumer and platform identities cannot be assigned as staff workspace roles');
  }
  const role = await Role.findOne({ name, ...(organizationId
    ? { $or: [{ organizationId }, { organizationId: null }] }
    : { organizationId: null }) }).sort({ organizationId: -1 }).select('_id').lean();
  if (!role) {
    if (name === 'root' || Object.hasOwn(BUILTIN_ROLE_PERMISSIONS, name)) return;
    throw new CommandError(409, 'Role is no longer configured; reload before assigning staff');
  }
  const pinned = await Role.updateOne({ _id: role._id }, { $inc: { assignmentRevision: 1 } });
  if (pinned.matchedCount !== 1) throw new CommandError(409, 'Role changed; reload before assigning staff');
}
