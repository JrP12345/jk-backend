import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.ts';
import { Organization } from '../models/Organization.ts';
import { Location } from '../models/Location.ts';
import { User } from '../models/User.ts';
import { OrgMember } from '../models/OrgMember.ts';
import { Role } from '../models/Role.ts';
import { TaskModel } from '../models/Task.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { createAuthSession } from '../utilities/helpers.ts';
import { OrgInvite } from '../models/OrgInvite.ts';
async function fixture() {
  const org = await Organization.create({ name: 'Revocation clinic', city: 'Pune' });
  const other = await Organization.create({ name: 'Other employer', city: 'Pune' });
  const branch = await Location.create({ organizationId: org.id, name: 'Authorized branch', city: 'Pune' });
  const admin = await User.create({ name: 'Manager', role: 'admin', email: `${crypto.randomUUID()}@example.test` });
  const staff = await User.create({ name: 'Shared staff identity', role: 'receptionist', email: `${crypto.randomUUID()}@example.test` });
  await OrgMember.create([{ organizationId: org.id, userId: admin.id, role: 'admin' }, { organizationId: org.id, userId: staff.id, role: 'steward', locationAccess: { mode: 'all' } }, { organizationId: other.id, userId: staff.id, role: 'admin' }]);
  await Role.create({ organizationId: org.id, name: 'steward', permissions: ['VIEW_CRM', 'MANAGE_CRM_TASKS', 'MANAGE_CRM_INQUIRIES'] });
  await Role.create({ organizationId: org.id, name: 'nurse', permissions: [] });
  const cookies = async (user: any, organization: any, role: string) => ({ access_token: (await createAuthSession({ id: user.id, email: user.email!, role, organization_id: organization?.id }, { organizationId: organization?.id, ...(organization ? { workspaceRole: role } : {}) })).accessToken });
  const adminCookies = await cookies(admin, org, 'admin'), staffCookies = await cookies(staff, org, 'steward'), otherCookies = await cookies(staff, other, 'admin');
  const task = await TaskModel.create({ organizationId: org.id, locationId: branch.id, kind: 'crm_callback', title: 'Administrative action', assignedTo: staff.id, dueDate: new Date() });
  return { org, other, branch, admin, staff, task, cookies, adminCookies, staffCookies, otherCookies };
}
afterEach(() => vi.restoreAllMocks());
describe('Revocation stays within the authorized organization command', () => {
  it('changes only the selected membership, hands off lost work and preserves another workspace session', async () => {
    const f = await fixture();
    const result = await app.inject({ method: 'PUT', url: `/api/users/${f.staff.id}/role`, cookies: f.adminCookies, payload: { role: 'nurse' } });
    expect(result.statusCode, result.body).toBe(200);
    expect((await OrgMember.findOne({ organizationId: f.org.id, userId: f.staff.id }))?.role).toBe('nurse');
    expect((await OrgMember.findOne({ organizationId: f.other.id, userId: f.staff.id }))?.role).toBe('admin');
    expect((await User.findById(f.staff.id))?.role).toBe('receptionist');
    expect((await TaskModel.findById(f.task.id))?.assignedTo).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', cookies: f.staffCookies })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', cookies: f.otherCookies })).statusCode).toBe(200);
  });
  it('rolls the role and CRM handoff back together when audit persistence fails', async () => {
    const f = await fixture(); vi.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('audit unavailable'));
    expect((await app.inject({ method: 'PUT', url: `/api/users/${f.staff.id}/role`, cookies: f.adminCookies, payload: { role: 'nurse' } })).statusCode).toBe(500);
    expect((await OrgMember.findOne({ organizationId: f.org.id, userId: f.staff.id }))?.role).toBe('steward');
    expect(String((await TaskModel.findById(f.task.id))?.assignedTo)).toBe(f.staff.id);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', cookies: f.staffCookies })).statusCode).toBe(200);
  });
  it('applies a scoped permission loss to its members without affecting another tenant role', async () => {
    const f = await fixture();
    const retained = await TaskModel.create({ organizationId: f.other.id, locationId: f.branch.id, kind: 'crm_callback', title: 'Other tenant work', assignedTo: f.staff.id });
    const result = await app.inject({ method: 'PUT', url: '/api/roles/steward', cookies: f.adminCookies, payload: { permissions: ['VIEW_CRM', 'MANAGE_CRM_INQUIRIES'] } });
    expect(result.statusCode, result.body).toBe(200);
    expect((await TaskModel.findById(f.task.id))?.needsAssignment).toBe(true);
    expect(String((await TaskModel.findById(retained.id))?.assignedTo)).toBe(f.staff.id);
  });
  it('serializes simultaneous administrator removals and retains one active administrator', async () => {
    const f = await fixture();
    await OrgMember.updateOne({ organizationId: f.org.id, userId: f.staff.id }, { role: 'admin' });
    const root = await User.create({ name: 'Governance reviewer', role: 'root', email: `${crypto.randomUUID()}@example.test` });
    const auth = await f.cookies(root, undefined, 'root');
    const results = await Promise.all([f.admin.id, f.staff.id].map(id => app.inject({ method: 'DELETE', url: `/api/organizations/${f.org.id}/members/${id}`, cookies: auth })));
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
    expect(await OrgMember.countDocuments({ organizationId: f.org.id, role: 'admin' })).toBe(1);
  });
  it('requires an explicit workspace for a platform role change on an existing staff identity', async () => {
    const f = await fixture();
    const root = await User.create({ name: 'Platform reviewer', role: 'root', email: crypto.randomUUID() + '@example.test' });
    const auth = await f.cookies(root, undefined, 'root');
    const result = await app.inject({ method: 'PUT', url: '/api/users/' + f.staff.id + '/role', cookies: auth, payload: { role: 'nurse' } });
    expect(result.statusCode).toBe(409);
    expect((await User.findById(f.staff.id))?.role).toBe('receptionist');
    expect((await OrgMember.findOne({ userId: f.staff.id, organizationId: f.org.id }))?.role).toBe('steward');
    expect(String((await TaskModel.findById(f.task.id))?.assignedTo)).toBe(f.staff.id);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', cookies: f.staffCookies })).statusCode).toBe(200);
  });

  it('rejects deleting an assigned role without falling back to a broader shared grant', async () => {
    const f = await fixture();
    await Role.create({ name: 'steward', organizationId: null, permissions: ['MANAGE_BILLING'] });
    const result = await app.inject({ method: 'DELETE', url: '/api/roles/steward', cookies: f.adminCookies });
    expect(result.statusCode).toBe(409);
    expect(await Role.exists({ name: 'steward', organizationId: f.org.id })).toBeTruthy();
    expect(String((await TaskModel.findById(f.task.id))?.assignedTo)).toBe(f.staff.id);
    expect(await AuditLog.countDocuments({ action: 'ROLE_DELETED' })).toBe(0);
  });
  it('requires organization-scoped permission edits for a role used by staff', async () => {
    const f = await fixture();
    const shared = await Role.findOneAndUpdate({ name: 'steward', organizationId: null },
      { $set: { permissions: ['VIEW_CRM', 'MANAGE_CRM_TASKS'] } }, { upsert: true, returnDocument: 'after' });
    await OrgMember.updateOne({ organizationId: f.other.id, userId: f.staff.id }, { role: 'steward' });
    const root = await User.create({ name: 'Platform reviewer', role: 'root', email: crypto.randomUUID() + '@example.test' });
    const result = await app.inject({ method: 'PUT', url: '/api/roles/steward', cookies: await f.cookies(root, undefined, 'root'), payload: { permissions: [] } });
    expect(result.statusCode).toBe(409);
    expect((await Role.findById(shared!.id))?.permissions).toEqual(['VIEW_CRM', 'MANAGE_CRM_TASKS']);
    expect(String((await TaskModel.findById(f.task.id))?.assignedTo)).toBe(f.staff.id);
  });
  it('rolls an unused-role deletion back when its audit cannot persist', async () => {
    const f = await fixture();
    const role = await Role.create({ name: 'unused_review', organizationId: f.org.id, permissions: [] });
    vi.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('Audit unavailable'));
    const result = await app.inject({ method: 'DELETE', url: '/api/roles/unused_review', cookies: f.adminCookies });
    expect(result.statusCode).toBe(500);
    expect(await Role.exists({ _id: role._id })).toBeTruthy();
  });
  it('serializes a custom-role assignment against deletion', async () => {
    const f = await fixture();
    await Role.create({ name: 'race_review', organizationId: f.org.id, permissions: [] });
    const results = await Promise.all([
      app.inject({ method: 'PUT', url: `/api/users/${f.staff.id}/role`, cookies: f.adminCookies, payload: { role: 'race_review' } }),
      app.inject({ method: 'DELETE', url: '/api/roles/race_review', cookies: f.adminCookies }),
    ]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
    const member = await OrgMember.findOne({ organizationId: f.org.id, userId: f.staff.id });
    if (member?.role === 'race_review') expect(await Role.exists({ name: member.role, organizationId: f.org.id })).toBeTruthy();
    else expect(member?.role).toBe('steward');
  });
  it('rejects accepting an invitation after its custom role was deleted', async () => {
    const f = await fixture();
    await Organization.updateOne({ _id: f.org.id }, { maxStaff: 10 });
    const token = crypto.randomBytes(32).toString('hex');
    const email = crypto.randomUUID() + '@example.test';
    const invite = await OrgInvite.create({ organizationId: f.org.id, invitedBy: f.admin.id, email,
      role: 'deleted_review', tokenHash: crypto.createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 60000) });
    const result = await app.inject({ method: 'POST', url: '/api/auth/accept-invitation', payload: { token, name: 'Invited staff', password: 'StrongPassword123!' } });
    expect(result.statusCode, result.body).toBe(409);
    expect(await User.exists({ email })).toBeNull();
    expect((await OrgInvite.findById(invite.id))?.status).toBe('pending');
  });
});
