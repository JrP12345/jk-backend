import crypto from 'node:crypto';
import { describe, expect, it, afterEach, vi } from 'vitest';
import { app } from '../index.ts';
import { Organization } from '../models/Organization.ts';
import { Location } from '../models/Location.ts';
import { User } from '../models/User.ts';
import { OrgMember } from '../models/OrgMember.ts';
import { TaskModel } from '../models/Task.ts';
import { Inquiry } from '../models/Inquiry.ts';
import { CrmActivity } from '../models/CrmActivity.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { createAuthSession } from '../utilities/helpers.ts';
async function fixture() {
  const org = await Organization.create({ name: 'Task clinic', city: 'Pune', plan: 'enterprise' });
  const branch = await Location.create({ organizationId: org.id, name: 'Branch', city: 'Pune' });
  const admin = await User.create({ name: 'Manager', email: `${crypto.randomUUID()}@example.test`, role: 'admin' });
  const desk = await User.create({ name: 'Desk', email: `${crypto.randomUUID()}@example.test`, role: 'receptionist' });
  await OrgMember.create([{ userId: admin.id, organizationId: org.id, role: 'admin' }, { userId: desk.id, organizationId: org.id, role: 'receptionist', locationAccess: { mode: 'selected', locationIds: [branch.id] } }]);
  async function cookies(user: any, role: string) { return { access_token: (await createAuthSession({ id: user.id, email: user.email, role, organization_id: org.id }, { organizationId: org.id, workspaceRole: role })).accessToken }; }
  const adminCookies = await cookies(admin, 'admin'), deskCookies = await cookies(desk, 'receptionist');
  const payload = { clientRequestId: crypto.randomUUID(), locationId: branch.id, kind: 'crm_callback', dueDate: new Date(Date.now() - 60000).toISOString(), note: 'Administrative callback instruction' };
  const create = (extra = {}, auth = adminCookies) => app.inject({ method: 'POST', url: '/api/crm/tasks', cookies: auth, payload: { ...payload, ...extra } });
  const update = (id: string, revision: number, action: string, extra = {}, auth = adminCookies) => app.inject({ method: 'PATCH', url: `/api/crm/tasks/${id}`, cookies: auth, payload: { clientRequestId: crypto.randomUUID(), expectedRevision: revision, action, ...extra } });
  return { org, branch, admin, desk, adminCookies, deskCookies, payload, create, update };
}
afterEach(() => vi.restoreAllMocks());
describe('Daily CRM tasks on the existing Task model', () => {
  it('moves unfinished revoked work to unassigned and preserves another organization session', async () => {
    const f = await fixture();
    const other = await Organization.create({ name: 'Second employer', city: 'Pune' });
    await OrgMember.create({ organizationId: other.id, userId: f.desk.id, role: 'receptionist' });
    const otherSession = await createAuthSession({ id: f.desk.id, email: f.desk.email!, role: 'receptionist', organization_id: other.id }, { organizationId: other.id, workspaceRole: 'receptionist' });
    const inquiry = await app.inject({ method: 'POST', url: '/api/crm/inquiries', cookies: f.adminCookies, payload: { clientRequestId: crypto.randomUUID(), locationId: f.branch.id, ownerId: f.desk.id, nextAction: { kind: 'contact', dueAt: f.payload.dueDate } } });
    expect(inquiry.statusCode, inquiry.body).toBe(201);
    const task = (await TaskModel.findOne({ inquiryId: inquiry.json().data.id }))!;
    const removed = await app.inject({ method: 'DELETE', url: `/api/organizations/${f.org.id}/members/${f.desk.id}`, cookies: f.adminCookies });
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await TaskModel.findById(task.id))?.assignedTo).toBeUndefined();
    expect((await TaskModel.findById(task.id))?.needsAssignment).toBe(true);
    expect((await Inquiry.findById(inquiry.json().data.id))?.ownerId).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', cookies: f.deskCookies })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { access_token: otherSession.accessToken } })).statusCode).toBe(200);
    const claimed = await f.update(task.id, 1, 'assign', { assignedTo: f.admin.id, reason: 'Continue revoked staff work' });
    expect(claimed.statusCode, claimed.body).toBe(200);
  });
  it('keeps retained-branch work and hands off only removed-branch assignments atomically', async () => {
    const f = await fixture();
    const retained = await Location.create({ organizationId: f.org.id, name: 'Retained branch', city: 'Pune' });
    await OrgMember.updateOne({ userId: f.desk.id, organizationId: f.org.id }, { 'locationAccess.locationIds': [f.branch.id, retained.id] });
    const lost = (await f.create({ assignedTo: f.desk.id })).json().data.id;
    const kept = (await f.create({ clientRequestId: crypto.randomUUID(), locationId: retained.id, assignedTo: f.desk.id })).json().data.id;
    const revoked = await app.inject({ method: 'PATCH', url: `/api/organizations/${f.org.id}/members/${f.desk.id}/location-access`, cookies: f.adminCookies, payload: { expectedRevision: 0, mode: 'selected', locationIds: [retained.id] } });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect((await TaskModel.findById(lost))?.assignedTo).toBeUndefined();
    expect(String((await TaskModel.findById(kept))?.assignedTo)).toBe(f.desk.id);
  });
  it('restores one task on concurrent capture retries and isolates it from generic task writes', async () => {
    const f = await fixture(); const pair = await Promise.all([f.create(), f.create()]);
    expect(pair.map(row => row.statusCode).sort()).toEqual([200, 201]);
    const id = pair[0].json().data.id;
    expect(await TaskModel.countDocuments({ organizationId: f.org.id })).toBe(1);
    const generic = await app.inject({ method: 'PATCH', url: `/api/tasks/${id}/status`, cookies: f.adminCookies, payload: { status: 'completed' } });
    expect(generic.statusCode).toBe(403);
    const detail = await app.inject({ method: 'GET', url: `/api/crm/tasks/${id}`, cookies: f.adminCookies });
    expect(detail.json().data.activities.some((row: any) => row.note === f.payload.note)).toBe(true);
    expect(detail.json().data).not.toHaveProperty('description');
  });
  it('requires own-work or manager authority and uses live eligible assignment', async () => {
    const f = await fixture(), created = await f.create(), id = created.json().data.id;
    expect((await f.update(id, 0, 'complete', { outcome: 'contacted' }, f.deskCookies)).statusCode).toBe(403);
    expect((await f.update(id, 0, 'assign', { assignedTo: f.desk.id, reason: 'Branch handoff' })).statusCode).toBe(200);
    expect((await f.update(id, 0, 'complete', { outcome: 'contacted' }, f.deskCookies)).statusCode).toBe(409);
    await User.updateOne({ _id: f.desk.id }, { isActive: false });
    expect((await f.update(id, 1, 'assign', { assignedTo: f.desk.id, reason: 'Inactive user' })).statusCode).toBe(400);
    expect((await TaskModel.findById(id))?.revision).toBe(1);
  });
  it('lets an eligible staff member claim an unassigned task once under simultaneous claims', async () => {
    const f = await fixture(), created = await f.create({ assignedTo: null }), id = created.json().data.id;
    const pair = await Promise.all([f.update(id, 0, 'assign', { assignedTo: f.desk.id, reason: 'Claim next action' }, f.deskCookies), f.update(id, 0, 'assign', { assignedTo: f.admin.id, reason: 'Manager claims' })]);
    expect(pair.map(row => row.statusCode).sort()).toEqual([200, 409]);
    expect((await TaskModel.findById(id))?.revision).toBe(1);
  });
  it('snoozes out of due work, records outcomes, and reopens with an explicit due time', async () => {
    const f = await fixture(), id = (await f.create()).json().data.id;
    expect((await f.update(id, 0, 'snooze', { snoozedUntil: new Date(Date.now() - 1000).toISOString(), reason: 'Invalid past snooze' })).statusCode).toBe(400);
    const due = new Date(Date.now() + 86400000).toISOString();
    expect((await f.update(id, 0, 'snooze', { snoozedUntil: due, reason: 'Requested later call' })).statusCode).toBe(200);
    const queue = await app.inject({ method: 'GET', url: '/api/crm/tasks?owner=mine&due=due', cookies: f.adminCookies });
    expect(queue.json().data.items).toHaveLength(0);
    expect((await f.update(id, 1, 'complete', { outcome: 'no_response' })).statusCode).toBe(200);
    expect((await TaskModel.findById(id))?.outcome).toBe('no_response');
    expect((await f.update(id, 2, 'reopen', { dueDate: due, reason: 'New callback requested' })).statusCode).toBe(200);
    expect((await TaskModel.findById(id))?.status).toBe('todo');
  });
  it('synchronizes one inquiry next-action task across edits, outcomes, close and reopen', async () => {
    const f = await fixture();
    const capture = await app.inject({ method: 'POST', url: '/api/crm/inquiries', cookies: f.adminCookies, payload: { clientRequestId: crypto.randomUUID(), locationId: f.branch.id, nextAction: { kind: 'contact', dueAt: f.payload.dueDate } } });
    expect(capture.statusCode, capture.body).toBe(201);
    const inquiryId = capture.json().data.id;
    let task = (await TaskModel.findOne({ organizationId: f.org.id, inquiryId }))!;
    expect(task.kind).toBe('crm_inquiry');
    const next = { kind: 'book', dueAt: new Date(Date.now() + 86400000).toISOString() };
    const complete = await f.update(task.id, task.revision!, 'complete', { outcome: 'contacted', nextAction: next });
    expect(complete.statusCode, complete.body).toBe(200);
    expect(complete.json().data).toMatchObject({ status: 'todo', title: 'Arrange inquiry booking', outcome: 'contacted' });
    expect((await Inquiry.findById(inquiryId))?.nextAction.kind).toBe('book');
    task = (await TaskModel.findById(task.id))!;
    const closed = await f.update(task.id, task.revision!, 'complete', { outcome: 'resolved', closeInquiry: true, closeReason: 'resolved' });
    expect(closed.statusCode, closed.body).toBe(200);
    expect((await Inquiry.findById(inquiryId))?.status).toBe('closed');
    const current = (await Inquiry.findById(inquiryId))!;
    const reopen = await app.inject({ method: 'PATCH', url: `/api/crm/inquiries/${inquiryId}`, cookies: f.adminCookies, payload: { clientRequestId: crypto.randomUUID(), expectedRevision: current.revision, status: 'open', nextAction: { kind: 'review', dueAt: next.dueAt } } });
    expect(reopen.statusCode, reopen.body).toBe(200);
    expect(await TaskModel.countDocuments({ organizationId: f.org.id, inquiryId })).toBe(1);
    expect((await TaskModel.findById(task.id))?.status).toBe('todo');
  });
  it('rolls back task, activity and inquiry updates when audit persistence fails', async () => {
    const f = await fixture(), id = (await f.create()).json().data.id;
    const before = await CrmActivity.countDocuments({ taskId: id });
    vi.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('Audit unavailable'));
    expect((await f.update(id, 0, 'complete', { outcome: 'contacted' })).statusCode).toBe(503);
    expect((await TaskModel.findById(id))?.status).toBe('todo');
    expect((await TaskModel.findById(id))?.revision).toBe(0);
    expect(await CrmActivity.countDocuments({ taskId: id })).toBe(before);
  });
  it('bounds task lists and denies foreign organization and branch references', async () => {
    const f = await fixture();
    await TaskModel.create(Array.from({ length: 22 }, () => ({ organizationId: f.org.id, locationId: f.branch.id, kind: 'crm_callback', title: 'Callback', assignedTo: f.admin.id, createdBy: f.admin.id, dueDate: new Date() })));
    const page = await app.inject({ method: 'GET', url: '/api/crm/tasks?owner=team', cookies: f.adminCookies });
    expect(page.json().data.items).toHaveLength(20); expect(page.json().data.nextCursor).toBeTruthy();
    const foreign = await Organization.create({ name: 'Foreign', city: 'Pune' });
    const location = await Location.create({ organizationId: foreign.id, name: 'Foreign', city: 'Pune' });
    const task = await TaskModel.create({ organizationId: foreign.id, locationId: location.id, kind: 'crm_callback', title: 'Hidden', assignedTo: f.admin.id, createdBy: f.admin.id });
    const denied = await app.inject({ method: 'GET', url: `/api/crm/tasks/${task.id}`, cookies: f.adminCookies });
    expect(denied.statusCode).toBe(404);
    expect((await f.create({ locationId: location.id })).statusCode).toBe(404);
  });
});
