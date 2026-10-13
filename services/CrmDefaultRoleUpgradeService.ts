import { Role } from '../models/Role.ts';
import { User } from '../models/User.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { ADMIN_PERMISSIONS, DOCTOR_PERMISSIONS, RECEPTIONIST_PERMISSIONS, NURSE_PERMISSIONS, LOCATION_MANAGER_PERMISSIONS, BUILTIN_ROLE_PERMISSIONS, invalidateRoleCache } from '../utilities/permissions.ts';
import { withTransaction } from '../utilities/transaction.ts';

const legacyDefaults: Record<string, string[]> = {
  admin: ADMIN_PERMISSIONS, doctor: DOCTOR_PERMISSIONS,
  receptionist: RECEPTIONIST_PERMISSIONS, nurse: NURSE_PERMISSIONS,
  location_manager: LOCATION_MANAGER_PERMISSIONS,
};
const samePermissions = (actual: string[], expected: string[]) => {
  const permissions = new Set(actual);
  return permissions.size === expected.length && expected.every(code => permissions.has(code));
};

/** Explicit operator action; never runs during bootstrap or permission reads. */
export async function upgradeDevelopmentCrmDefaults(actorId: string, apply = false) {
  if (process.env.NODE_ENV === 'production') throw new Error('Development role upgrade is unavailable in production');
  if (!await User.exists({ _id: actorId, role: 'root', isActive: true })) throw new Error('An active platform root is required');
  const topology = (Role.db as any).client?.topology?.description?.type;
  if (apply && !['ReplicaSetWithPrimary', 'Sharded'].includes(topology)) throw new Error('Applying role upgrades requires a transaction-capable database');
  const results: { role: string; state: string }[] = [];
  for (const [name, baseline] of Object.entries(legacyDefaults)) {
    const changed = await withTransaction(async () => {
      const role = await Role.findOne({ name, organizationId: null, isSystemRole: true });
      if (!role || (role.version || 1) !== 1 || !samePermissions(role.permissions, baseline)) {
        results.push({ role: name, state: 'preserved' });
        return false;
      }
      if (!apply) { results.push({ role: name, state: 'eligible' }); return false; }
      const updated = await Role.updateOne({ _id: role._id, version: role.version, permissions: role.permissions },
        { $set: { permissions: BUILTIN_ROLE_PERMISSIONS[name] }, $inc: { version: 1 } });
      if (updated.modifiedCount !== 1) throw new Error('Role changed during upgrade; review again');
      await AuditLog.create({ userId: actorId, action: 'DEVELOPMENT_CRM_DEFAULT_ROLE_UPGRADE', targetId: role._id,
        targetModel: 'Role', category: 'ADMIN', details: { role: name, fromVersion: role.version, toVersion: role.version + 1 } });
      return true;
    });
    if (changed) { await invalidateRoleCache(name); results.push({ role: name, state: 'updated' }); }
  }
  return results;
}
