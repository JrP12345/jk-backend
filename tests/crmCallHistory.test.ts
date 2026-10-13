import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.ts';
import { Organization } from '../models/Organization.ts';
import { Location } from '../models/Location.ts';
import { User } from '../models/User.ts';
import { OrgMember } from '../models/OrgMember.ts';
import { Patient } from '../models/Patient.ts';
import { PatientRelationship } from '../models/PatientRelationship.ts';
import { Inquiry } from '../models/Inquiry.ts';
import { CrmActivity } from '../models/CrmActivity.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { DPDPConsent } from '../models/DPDPConsent.ts';
import { createAuthSession } from '../utilities/helpers.ts';
async function fixture() {
  const org = await Organization.create({ name: 'Calls', city: 'Pune', plan: 'enterprise' });
  const branch = await Location.create({ name: 'Calls branch', city: 'Pune', organizationId: org.id });
  const actor = await User.create({ name: 'Calls staff', role: 'receptionist', email: `${crypto.randomUUID()}@example.test` });
  await OrgMember.create({ userId: actor.id, organizationId: org.id, role: 'receptionist', locationAccess: { mode: 'selected', locationIds: [branch.id] } });
  const patient = await Patient.create({ name: 'Patient', phone: '9876543210', organizationId: org.id });
  await PatientRelationship.create({ organizationId: org.id, locationId: branch.id, patientId: patient.id });
  const session = await createAuthSession({ id: actor.id, role: 'receptionist', email: actor.email!, organization_id: org.id }, { organizationId: org.id, workspaceRole: 'receptionist' });
  const cookies = { access_token: session.accessToken }, url = '/api/crm/communications/calls';
  const payload = { patientId: patient.id, locationId: branch.id, clientRequestId: crypto.randomUUID(), direction: 'inbound', outcome: 'contacted', occurredAt: new Date().toISOString(), subjectVerified: true, note: 'Caller asked to review booking options' };
  return { org, branch, actor, patient, cookies, url, payload, save: (extra = {}) => app.inject({ method: 'POST', url, cookies, payload: { ...payload, ...extra } }) };
}
afterEach(() => vi.restoreAllMocks());
describe('Scoped staff-reported call history', () => {
  it('restores one exact record and never creates consent or initiates a message', async () => {
    const f = await fixture(); const responses = await Promise.all([f.save(), f.save()]);
    expect(responses.map(row => row.statusCode).sort()).toEqual([200, 201]);
    expect(await CrmActivity.countDocuments({ patientId: f.patient.id, kind: 'call_recorded' })).toBe(1);
    expect(await AuditLog.countDocuments({ organizationId: f.org.id, action: 'CRM_CALL_RECORDED' })).toBe(1);
    expect(await DPDPConsent.countDocuments({ patientId: f.patient.id })).toBe(0);
    expect(responses[0].json().data).toMatchObject({ communication: { source: 'staff_reported', direction: 'inbound' }, note: f.payload.note });
    expect((await f.save({ outcome: 'declined' })).statusCode).toBe(409);
  });
  it('rolls back history when audit persistence fails, then recovers the same request', async () => {
    const f = await fixture(); vi.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('audit outage'));
    expect((await f.save()).statusCode).toBe(503);
    expect(await CrmActivity.countDocuments({ patientId: f.patient.id })).toBe(0);
    expect((await f.save()).statusCode).toBe(201);
  });
  it('requires subject review, branch association, valid time and one subject', async () => {
    const f = await fixture();
    expect((await f.save({ subjectVerified: false })).statusCode).toBe(400);
    expect((await f.save({ occurredAt: new Date(Date.now() + 86400000).toISOString() })).statusCode).toBe(400);
    const foreign = await Organization.create({ name: 'Foreign', city: 'Pune' });
    const branch = await Location.create({ name: 'Foreign', city: 'Pune', organizationId: foreign.id });
    expect((await f.save({ locationId: branch.id })).statusCode).toBe(404);
    expect((await f.save({ inquiryId: f.patient.id })).statusCode).toBe(400);
    expect(await CrmActivity.countDocuments({ patientId: f.patient.id })).toBe(0);
  });
  it('supports anonymous inquiries without creating patients, and rejects branch substitution', async () => {
    const f = await fixture();
    const inquiry = await Inquiry.create({ organizationId: f.org.id, locationId: f.branch.id, createdBy: f.actor.id, ownerId: f.actor.id, nextAction: { kind: 'review', dueAt: new Date() } });
    const payload = { ...f.payload, patientId: undefined, inquiryId: inquiry.id };
    const saved = await app.inject({ method: 'POST', url: f.url, cookies: f.cookies, payload });
    expect(saved.statusCode, saved.body).toBe(201);
    expect(await Patient.countDocuments({ organizationId: f.org.id })).toBe(1);
    expect((await CrmActivity.findOne({ inquiryId: inquiry.id }))?.patientId).toBeUndefined();
    const branch = await Location.create({ name: 'Different', city: 'Pune', organizationId: f.org.id });
    expect((await app.inject({ method: 'POST', url: f.url, cookies: f.cookies, payload: { ...payload, clientRequestId: crypto.randomUUID(), locationId: branch.id } })).statusCode).toBe(400);
  });
  it('pages bounded history and rechecks branch revocation on read and replay', async () => {
    const f = await fixture(); await f.save();
    await CrmActivity.create(Array.from({ length: 23 }, () => ({ organizationId: f.org.id, locationId: f.branch.id, patientId: f.patient.id, actorId: f.actor.id, kind: 'call_recorded', communication: { direction: 'inbound', source: 'staff_reported', occurredAt: new Date() }, outcome: 'contacted' })));
    const page = await app.inject({ method: 'GET', url: `${f.url}?patientId=${f.patient.id}`, cookies: f.cookies });
    expect(page.statusCode).toBe(200); expect(page.json().data.items).toHaveLength(20);
    const next = await app.inject({ method: 'GET', url: `${f.url}?patientId=${f.patient.id}&cursor=${page.json().data.nextCursor}`, cookies: f.cookies });
    expect(next.json().data.items).toHaveLength(4);
    await OrgMember.updateOne({ userId: f.actor.id }, { 'locationAccess.locationIds': [] });
    expect((await f.save()).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `${f.url}?patientId=${f.patient.id}`, cookies: f.cookies })).statusCode).toBe(403);
  });
});
