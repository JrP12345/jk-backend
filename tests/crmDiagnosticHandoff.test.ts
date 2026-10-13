import mongoose from 'mongoose';
import crypto from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Organization } from '../models/Organization.ts';
import { Location } from '../models/Location.ts';
import { Patient } from '../models/Patient.ts';
import { User } from '../models/User.ts';
import { LabTest } from '../models/LabTest.ts';
import { LabOrder } from '../models/LabOrder.ts';
import { Encounter } from '../models/Encounter.ts';
import { TaskModel } from '../models/Task.ts';
import { CrmActivity } from '../models/CrmActivity.ts';
import { DomainEventOutbox } from '../models/DomainEventOutbox.ts';
import { Notification } from '../models/Notification.ts';
import { NotificationDelivery } from '../models/NotificationDelivery.ts';
import { OrdersService } from '../services/OrdersService.ts';
import { syncDiagnosticHandoff } from '../services/DiagnosticHandoffService.ts';
import { readEncryptedDomainEvent } from '../services/DomainEventOutboxService.ts';
import { notificationService } from '../notifications/services/NotificationService.ts';
import { withClinicalTransaction } from '../utilities/transaction.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { Appointment } from '../models/Appointment.ts';
import { OrgMember } from '../models/OrgMember.ts';
import { createAuthSession } from '../utilities/helpers.ts';
import { app } from '../index.ts';
afterEach(() => vi.restoreAllMocks());
async function authorizedDiagnosticFixture() {
  const f = await fixture();
  await User.updateOne({ _id: f.staff.id }, { role: 'admin' });
  await OrgMember.create({ organizationId: f.org.id, userId: f.staff.id, role: 'admin', locationAccess: { mode: 'all' } });
  const session = await createAuthSession({ id: f.staff.id, email: f.staff.email!, role: 'admin', organization_id: f.org.id }, { organizationId: f.org.id, workspaceRole: 'admin' });
  const visit = await Appointment.create({ organizationId: f.org.id, locationId: f.branch.id, patientId: f.patient.id, doctorId: f.staff.id, appointmentTime: new Date(), appointmentType: 'reception', status: 'in-consultation', tokenNumber: 1 });
  const encounter = await Encounter.create({ organizationId: f.org.id, locationId: f.branch.id, patientId: f.patient.id, doctorId: f.staff.id, appointmentId: visit.id, encounterType: 'opd', status: 'in_progress' });
  return { ...f, visit, encounter, cookies: { access_token: session.accessToken } };
}
it('rolls back an encounter order and administrative handoff when its route audit fails', async () => {
  const f = await authorizedDiagnosticFixture();
  vi.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('audit unavailable'));
  const response = await app.inject({ method: 'POST', url: `/api/encounters/${f.encounter.id}/orders`, cookies: f.cookies, payload: { testId: f.test.id } });
  expect(response.statusCode).toBe(500);
  expect(await LabOrder.countDocuments({ organizationId: f.org.id })).toBe(0);
  expect(await TaskModel.countDocuments({ organizationId: f.org.id })).toBe(0);
  expect(await CrmActivity.countDocuments({ organizationId: f.org.id })).toBe(0);
});
it('rolls back a critical result, its visit projection and handoff if route audit fails', async () => {
  const f = await authorizedDiagnosticFixture(), { order } = await OrdersService.placeOrder({ ...f.payload, encounterId: f.encounter.id });
  vi.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('audit unavailable'));
  const response = await app.inject({ method: 'PUT', url: `/api/orders/${order.id}/result`, cookies: f.cookies, payload: { value: 'Restricted result', interpretation: 'critical' } });
  expect(response.statusCode).toBe(500);
  expect((await LabOrder.findById(order.id))?.status).toBe('ordered');
  expect((await TaskModel.findOne({ orderId: order.id }))?.status).not.toBe('completed');
  expect((await Appointment.findById(f.visit.id))?.investigationResults || []).toHaveLength(0);
  expect(await TaskModel.countDocuments({ organizationId: f.org.id })).toBe(1);
});
async function fixture() {
  const org = await Organization.create({ name: 'Diagnostic clinic', city: 'Pune' });
  const branch = await Location.create({ organizationId: org.id, name: 'Canonical laboratory', city: 'Pune' });
  const user = await User.create({ name: 'Actual patient', role: 'patient', email: `${crypto.randomUUID()}@example.test` });
  const patient = await Patient.create({ organizationId: org.id, userId: user.id, name: user.name });
  const staff = await User.create({ name: 'Clinical staff', role: 'doctor', email: `${crypto.randomUUID()}@example.test` });
  const test = await LabTest.create({ organizationId: org.id, locationId: branch.id, name: 'Restricted test name', code: `TEST-${crypto.randomUUID()}`, department: 'Pathology', sampleType: 'Blood', price: 200, normalRange: 'Restricted reference' });
  const payload = { organizationId: org.id, locationId: branch.id, patientId: patient.id, testId: test.id, orderedBy: staff.id, clinicalReason: 'Restricted clinical reason' };
  return { org, branch, user, patient, staff, test, payload };
}
it('reuses Task for administrative diagnostic references, without copying test names, results or clinical escalation', async () => {
  const f = await fixture(), { order } = await OrdersService.placeOrder(f.payload);
  await withClinicalTransaction(() => syncDiagnosticHandoff(order.id, f.staff.id));
  const waiting = await TaskModel.findOne({ organizationId: f.org.id, orderId: order.id });
  expect(waiting).toMatchObject({ kind: 'crm_diagnostic', needsAssignment: true });
  expect(waiting!.description).toBeUndefined();
  await OrdersService.recordResult(order.id, { resultedBy: f.staff.id, value: 'Restricted value', notes: 'Restricted result note', interpretation: 'critical' });
  expect((await TaskModel.findById(waiting!.id))?.status).toBe('completed');
  await withClinicalTransaction(() => syncDiagnosticHandoff(order.id, f.staff.id));
  const tasks = await TaskModel.find({ organizationId: f.org.id }); expect(tasks).toHaveLength(2);
  const activities = await CrmActivity.find({ organizationId: f.org.id }).select('+note');
  const administrative = JSON.stringify({ tasks, activities });
  for (const privateValue of ['Restricted test name', 'Restricted clinical reason', 'Restricted value', 'Restricted result note', 'critical']) expect(administrative).not.toContain(privateValue);
  expect((await LabOrder.findById(order.id))?.result?.interpretation).toBe('critical');
});
it('rolls back the clinical order and handoff together after durable event failure', async () => {
  const f = await fixture();
  vi.spyOn(DomainEventOutbox, 'findOneAndUpdate').mockRejectedValueOnce(new Error('outbox unavailable'));
  await expect(OrdersService.placeOrder(f.payload)).rejects.toThrow('outbox unavailable');
  expect(await LabOrder.countDocuments({ organizationId: f.org.id })).toBe(0);
  expect(await TaskModel.countDocuments({ organizationId: f.org.id })).toBe(0);
  expect(await CrmActivity.countDocuments({ organizationId: f.org.id })).toBe(0);
});
it('rolls back a result and waiting-task transition on handoff failure', async () => {
  const f = await fixture(), { order } = await OrdersService.placeOrder(f.payload);
  vi.spyOn(DomainEventOutbox, 'findOneAndUpdate').mockRejectedValueOnce(new Error('handoff unavailable'));
  await expect(OrdersService.recordResult(order.id, { resultedBy: f.staff.id, value: 'Restricted result' })).rejects.toThrow('handoff unavailable');
  expect((await LabOrder.findById(order.id))?.status).toBe('ordered');
  expect((await TaskModel.findOne({ orderId: order.id }))?.status).toBe('todo');
  expect(await TaskModel.countDocuments({ orderId: order.id })).toBe(1);
});
it('rejects a mismatched encounter, catalog branch or unrelated patient organization before committing', async () => {
  const f = await fixture(); const other = await Patient.create({ organizationId: f.org.id, name: 'Other subject' });
  const encounter = await Encounter.create({ organizationId: f.org.id, locationId: f.branch.id, patientId: other.id, doctorId: f.staff.id, encounterType: 'opd', status: 'in_progress' });
  await expect(OrdersService.placeOrder({ ...f.payload, encounterId: encounter.id })).rejects.toThrow('Encounter not found');
  const branch = await Location.create({ organizationId: f.org.id, name: 'Other branch', city: 'Pune' });
  await expect(OrdersService.placeOrder({ ...f.payload, locationId: branch.id })).rejects.toThrow('Lab test not found');
  const unrelated = await Organization.create({ name: 'Other organization', city: 'Pune' });
  await Patient.updateOne({ _id: f.patient.id }, { organizationId: unrelated.id });
  await expect(OrdersService.placeOrder(f.payload)).rejects.toThrow('Diagnostic patient organization mismatch');
  expect(await LabOrder.countDocuments({ organizationId: f.org.id })).toBe(0);
});
it('delivers a generic owned diagnostic inbox update without email or stale state and rejects changed ownership', async () => {
  const f = await fixture(), { order } = await OrdersService.placeOrder(f.payload);
  const row = await DomainEventOutbox.findOne({ eventType: 'crm.diagnostic.inbox', organizationId: f.org.id }).select('+payloadCiphertext');
  const event = readEncryptedDomainEvent(row!);
  await OrdersService.collectSample(order.id, f.staff.id);
  await notificationService.handleDomainEvent(event);
  expect(await Notification.countDocuments({ targetUser: f.user.id })).toBe(0);
  const current = await DomainEventOutbox.findOne({ idempotencyKey: `diagnostic:${order.id}:sample-collected:inApp` }).select('+payloadCiphertext');
  await notificationService.handleDomainEvent({ ...readEncryptedDomainEvent(current!), title: 'Restricted result', message: 'Restricted value', metadata: { ...readEncryptedDomainEvent(current!).metadata, requestedChannels: { email: true } } });
  const notice = await Notification.findOne({ targetUser: f.user.id }); expect(notice!.message).not.toContain('Restricted'); expect(notice!.actionUrl).toBe(`/dashboard/laboratory?orderId=${order.id}`);
  expect(await NotificationDelivery.countDocuments({ notificationId: notice!.id, channel: 'email' })).toBe(0);
  await Patient.updateOne({ _id: f.patient.id }, { $unset: { userId: 1 } });
  await notificationService.handleDomainEvent({ ...readEncryptedDomainEvent(current!), eventId: 'new-owner-rejected' });
  expect(await Notification.countDocuments({ targetUser: f.user.id })).toBe(1);
});

it('keeps the original source predicate across a driver-managed clinical transaction retry', async () => {
  const f = await authorizedDiagnosticFixture(), { order } = await OrdersService.placeOrder({ ...f.payload, encounterId: f.encounter.id });
  const original = AuditLog.create.bind(AuditLog);
  vi.spyOn(AuditLog, 'create').mockImplementationOnce(async (...args: any[]) => {
    await (original as any)(...args);
    const transient = new mongoose.mongo.MongoServerError({ errmsg: 'Synthetic transient commit-boundary conflict' });
    transient.addErrorLabel('TransientTransactionError');
    throw transient;
  });
  const response = await app.inject({ method: 'PUT', url: '/api/lab-orders/' + order.id + '/status', cookies: f.cookies, payload: { status: 'sample-collected' } });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data.status).toBe('sample-collected');
  expect((await LabOrder.findById(order.id))?.status).toBe('sample-collected');
  expect(await AuditLog.countDocuments({ targetId: order.id, action: 'LAB_ORDER_STATUS_UPDATE' })).toBe(1);
  expect(await TaskModel.countDocuments({ orderId: order.id })).toBe(1);
  expect(await CrmActivity.countDocuments({ organizationId: f.org.id, eventKey: 'diagnostic:' + order.id + ':sample-collected' })).toBe(1);
});
it('returns one committed update and one reviewable conflict for competing clinical status changes', async () => {
  const f = await authorizedDiagnosticFixture(), { order } = await OrdersService.placeOrder({ ...f.payload, encounterId: f.encounter.id });
  const original = LabOrder.findOneAndUpdate.bind(LabOrder);
  let writes = 0, release!: () => void;
  const bothValidated = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(LabOrder, 'findOneAndUpdate').mockImplementation((...args: any[]) => {
    const query = (original as any)(...args), exec = query.exec.bind(query);
    query.exec = async () => { if (++writes === 2) release(); await bothValidated; return exec(); };
    return query;
  });
  const results = await Promise.all([
    app.inject({ method: 'PUT', url: '/api/lab-orders/' + order.id + '/status', cookies: f.cookies, payload: { status: 'sample-collected' } }),
    app.inject({ method: 'PUT', url: '/api/lab-orders/' + order.id + '/status', cookies: f.cookies, payload: { status: 'cancelled', cancellationReason: 'Synthetic competing operator review' } }),
  ]);
  expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
  expect((await LabOrder.findById(order.id))?.status).toBe(results.find(result => result.statusCode === 200)!.json().data.status);
  expect(await AuditLog.countDocuments({ targetId: order.id, action: 'LAB_ORDER_STATUS_UPDATE' })).toBe(1);
});
