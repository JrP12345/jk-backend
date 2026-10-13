import { describe, expect, it, vi } from 'vitest';
import { Role } from '../models/Role.ts';
import { User } from '../models/User.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { ADMIN_PERMISSIONS, getEffectivePermissions } from '../utilities/permissions.ts';
import { upgradeDevelopmentCrmDefaults } from '../services/CrmDefaultRoleUpgradeService.ts';
import { getRoles } from '../controllers/role.ts';

describe('Explicit development CRM defaults upgrade', () => {
  it('previews then updates an unchanged global default once, preserving explicit denials and overrides', async () => {
    const root = await User.create({ name: 'Development operator', role: 'root', email: 'crm-upgrade@example.test' });
    await Role.deleteMany({ name: { $in: ['admin', 'nurse', 'doctor', 'receptionist'] }, organizationId: null });
    const admin = await Role.create({ name: 'admin', isSystemRole: true, permissions: ADMIN_PERMISSIONS });
    const denied = await Role.create({ name: 'nurse', isSystemRole: true, permissions: [] });
    const edited = await Role.create({ name: 'doctor', isSystemRole: true, permissions: ['VIEW_PATIENTS'], version: 2 });
    const org = new (await import('mongoose')).default.Types.ObjectId();
    const override = await Role.create({ name: 'admin', organizationId: org, permissions: [] });
    expect(await upgradeDevelopmentCrmDefaults(root.id)).toContainEqual({ role: 'admin', state: 'eligible' });
    expect((await Role.findById(admin.id))!.permissions).not.toContain('VIEW_CRM');
    expect(await upgradeDevelopmentCrmDefaults(root.id, true)).toContainEqual({ role: 'admin', state: 'updated' });
    expect(await getEffectivePermissions('admin', undefined, 1, true)).toContain('VIEW_CRM');
    expect((await Role.findById(denied.id))!.permissions).toEqual([]);
    expect((await Role.findById(edited.id))!.permissions).toEqual(['VIEW_PATIENTS']);
    expect((await Role.findById(override.id))!.permissions).toEqual([]);
    expect(await upgradeDevelopmentCrmDefaults(root.id, true)).not.toContainEqual({ role: 'admin', state: 'updated' });
    expect(await AuditLog.countDocuments({ action: 'DEVELOPMENT_CRM_DEFAULT_ROLE_UPGRADE', targetId: admin._id })).toBe(1);
  });
  it('rejects non-root callers', async () => {
    const staff = await User.create({ name: 'Desk', role: 'receptionist', email: 'crm-upgrade-denied@example.test' });
    await expect(upgradeDevelopmentCrmDefaults(staff.id, true)).rejects.toThrow('platform root');
  });
  it('rolls back the grant if its audit cannot be recorded', async () => {
    const root = await User.findOne({ role: 'root', email: 'crm-upgrade@example.test' });
    await Role.deleteMany({ name: 'admin', organizationId: null });
    const role = await Role.create({ name: 'admin', isSystemRole: true, permissions: ADMIN_PERMISSIONS });
    const audit = vi.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('audit unavailable'));
    try { await expect(upgradeDevelopmentCrmDefaults(root!.id, true)).rejects.toThrow('audit unavailable'); }
    finally { audit.mockRestore(); }
    expect((await Role.findById(role.id))!.permissions).toEqual(ADMIN_PERMISSIONS);
    expect((await Role.findById(role.id))!.version).toBe(1);
  });
  it('uses the canonical defaults when the role-list endpoint seeds missing roles', async () => {
    await Role.deleteMany({ organizationId: null });
    const reply = { code: vi.fn().mockReturnThis(), send: vi.fn() };
    await getRoles({ user: { role: 'root' }, body: {}, query: {} } as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(200);
    const admin = await Role.findOne({ name: 'admin', organizationId: null });
    expect(admin!.permissions).toContain('VIEW_CRM');
    expect(admin!.permissions).not.toContain('EXPORT_CRM');
    expect((await Role.findOne({ name: 'receptionist', organizationId: null }))!.permissions).toContain('VIEW_CRM');
  });
});
