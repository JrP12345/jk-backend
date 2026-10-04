import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { app } from '../index.ts';
import { s3Client, getObjectBuffer, storeVerifiedObject, generatePresignedUrl } from '../utilities/r2.ts';
import { validateUploadBytes, isVerifiedClinicalAttachment } from '../utilities/uploadPolicy.ts';
import { Organization } from '../models/Organization.ts';
import { Clinic } from '../models/Clinic.ts';
import { Patient } from '../models/Patient.ts';
import { User } from '../models/User.ts';
import { UploadIntent } from '../models/UploadIntent.ts';
import { DocumentUpload } from '../models/DocumentUpload.ts';
import { createAuthSession } from '../utilities/helpers.ts';
import { handleClinicalWebSocket, sendToClinicClinicalLocally, resolveWebSocketAuth } from '../notifications/websocket.ts';
import { revokeUserSessions } from '../utilities/sessionResolver.ts';
import { escapeCsv } from '../services/ReportExportService.ts';
import mongoose from 'mongoose';
import { analyticsPath, referrerOrigin } from '../utilities/trafficPrivacy.ts';
import { scrubTelemetry } from '../utilities/telemetry.ts';
import { sanitizeMiddleware } from '../middleware/sanitize.ts';
import { LabOrder } from '../models/LabOrder.ts';
import { ObservationScore } from '../models/ObservationScore.ts';
import { ClinicalSearchService } from '../services/ClinicalSearchService.ts';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

describe('Phase 1 file and clinical authority', () => {
  it('accepts only a verified attachment matching the lab patient and organization', async () => {
    const org = new mongoose.Types.ObjectId(), patient = new mongoose.Types.ObjectId(), user = new mongoose.Types.ObjectId();
    const key = `tenants/${org}/verified/lab-fixture.pdf`;
    await UploadIntent.create({ organizationId: org, patientId: patient, userId: user, objectKey: key, originalFileName: 'fixture.pdf',
      contentClass: 'lab_report', permittedMimeTypes: ['application/pdf'], maxSizeBytes: 100, status: 'completed', magicBytesVerified: true, malwareClean: true });
    expect(await isVerifiedClinicalAttachment(key, org, patient)).toBe(true);
    expect(await isVerifiedClinicalAttachment(key, org, new mongoose.Types.ObjectId())).toBe(false);
    expect(await isVerifiedClinicalAttachment('data:application/pdf;base64,fixture', org, patient)).toBe(false);
    expect(await isVerifiedClinicalAttachment('https://foreign.example.test/fixture.pdf', org, patient)).toBe(false);
    expect(await isVerifiedClinicalAttachment('', org, patient)).toBe(true);
  });
  it('minimizes analytics and transaction data and rejects nested query injection', async () => {
    expect(analyticsPath('/dashboard/patients/111111111111111111111111?token=fixture#fragment')).toBe('/dashboard/patients/:id');
    expect(referrerOrigin('https://example.test/track/private?token=fixture')).toBe('https://example.test');
    expect(referrerOrigin('javascript:fixture')).toBe('');
    const event: any = scrubTelemetry({ type: 'transaction', transaction: 'GET /patients/111111111111111111111111?token=fixture',
      request: { cookies: { token: 'fixture' } }, user: { email: 'fixture@example.test' }, contexts: { private: { secret: 'fixture' } },
      spans: [{ span_id: '0123456789abcdef', trace_id: '0123456789abcdef0123456789abcdef', start_timestamp: 1,
        op: 'db', description: 'private query', data: { patient: 'fixture' } }], tags: { private: 'fixture' } });
    expect(event.request).toBeUndefined();
    expect(event.contexts).toBeUndefined();
    expect(event.transaction).toBe('GET /patients/:id');
    expect(event.spans[0].data).toEqual({});
    expect(event.spans[0].description).toBe('db');
    const req: any = { body: JSON.parse('{"safe":{"name":"fixture","$where":"fixture","__proto__":{"polluted":true}}}') };
    await sanitizeMiddleware(req, {} as any);
    expect(req.body.safe.name).toBe('fixture');
    expect(Object.keys(req.body.safe)).toEqual(['name']);
    let nested: any = {};
    for (let i = 0; i < 34; i++) nested = { child: nested };
    await expect(sanitizeMiddleware({ body: nested } as any, {} as any)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('preserves quality counters while excluding foreign organization history', async () => {
    const org = new mongoose.Types.ObjectId(), foreign = new mongoose.Types.ObjectId(), id = new mongoose.Types.ObjectId();
    await LabOrder.create([{ organizationId: org, clinicId: id, patientId: id, testId: id, status: 'result-uploaded', result: { isAbnormal: true } },
      { organizationId: org, clinicId: id, patientId: id, testId: id, status: 'ordered' },
      { organizationId: foreign, clinicId: id, patientId: id, testId: id, status: 'result-uploaded', result: { isAbnormal: true } }]);
    const score = { clinicId: id, patientId: id, encounterId: id, algorithmId: 'NEWS2', algorithmVersion: '1', isComplete: true };
    await ObservationScore.create([{ ...score, organizationId: org, totalScore: 2, riskCategory: 'Low' },
      { ...score, organizationId: org, totalScore: 8, riskCategory: 'High' },
      { ...score, organizationId: foreign, totalScore: 20, riskCategory: 'High' }]);
    const metrics = await ClinicalSearchService.getQualityMetrics(org.toString());
    expect(metrics.diagnostics).toEqual({ totalOrders: 2, completedResults: 1, abnormalResults: 1, abnormalRatePercentage: 100 });
    expect(metrics.clinical).toEqual({ totalNews2Evaluations: 2, averageNews2Score: 5, highRiskEvaluationsCount: 1 });
    expect((await ClinicalSearchService.getQualityMetrics(new mongoose.Types.ObjectId().toString())).clinical.totalNews2Evaluations).toBe(0);
  });

  it('registers the canonical upload route and seals verified bytes away from the writable staging key', async () => {
    const org = await Organization.create({ name: 'Upload route fixture', city: 'Pune' });
    const user = await User.create({ name: 'Upload operator', role: 'root', email: 'upload-route@example.test' });
    const auth = await createAuthSession({ id: user.id, role: 'root', email: user.email!, organization_id: org.id });
    const created = await app.inject({ method: 'POST', url: '/api/uploads/intent', cookies: { access_token: auth.accessToken },
      payload: { originalFilename: 'fixture.png', contentType: 'image/png', contentClass: 'avatar', fileSizeBytes: png.length } });
    expect(created.statusCode).toBe(201);
    const data = created.json().data;
    vi.spyOn(s3Client, 'send').mockImplementation(async (command: any) => command.input.Body ? {} : { Body: Readable.from([png]), ContentLength: png.length } as any);
    const verified = await app.inject({ method: 'POST', url: '/api/uploads/verify', cookies: { access_token: auth.accessToken }, payload: { intentId: data.intentId } });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().data.objectKey).not.toBe(data.objectKey);
    expect(verified.json().data.objectKey).toContain('/verified/');
    expect((await UploadIntent.findById(data.intentId))?.expiresAt).toBeUndefined();
  });

  it('keeps linked and unlinked patient search results scoped before joining identities', async () => {
    const org = await Organization.create({ name: 'Search fixture', city: 'Pune' });
    const foreign = await Organization.create({ name: 'Search foreign', city: 'Pune' });
    const operator = await User.create({ name: 'Search doctor', role: 'doctor', email: 'search-doctor@example.test' });
    const identity = await User.create({ name: 'Needle linked', role: 'patient', email: 'linked-needle@example.test' });
    await Patient.create([{ name: 'Legacy patient', userId: identity._id, organizationId: org._id },
      { name: 'Needle unlinked', organizationId: org._id }, { name: 'Needle foreign', organizationId: foreign._id }]);
    const auth = await createAuthSession({ id: operator.id, role: 'doctor', email: operator.email!, organization_id: org.id });
    const request = (search: string) => app.inject({ method: 'GET', url: '/api/patients?search=' + encodeURIComponent(search), cookies: { access_token: auth.accessToken } });
    const response = await request('Needle');
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(2);
    expect(response.headers['x-total-count']).toBe('2');
    expect(response.json().data.some((p: any) => p.name === 'Needle foreign')).toBe(false);
    expect((await request('[Needle')).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/admin/operations/profiling' })).statusCode).toBe(401);
  });
  it('bounds both declared storage length and chunked storage reads, and checks MIME', async () => {
    const stream = Readable.from([Buffer.alloc(4), Buffer.alloc(4)]);
    const send = vi.spyOn(s3Client, 'send').mockResolvedValue({ Body: stream } as never);
    await expect(getObjectBuffer('fixture', 6)).rejects.toThrow('UPLOAD_TOO_LARGE');
    expect(stream.destroyed).toBe(true);
    send.mockResolvedValue({ ContentLength: 100, Body: Readable.from([]) } as never);
    await expect(getObjectBuffer('fixture', 6)).rejects.toThrow('UPLOAD_TOO_LARGE');
    expect(() => validateUploadBytes(png, 'application/pdf', 100)).toThrow('signature');
    expect(validateUploadBytes(png, 'image/png', 100)).toBe('image/png');
    send.mockResolvedValue({} as never);
    const key = await storeVerifiedObject(png, 'image/png', '111111111111111111111111');
    expect(key).toMatch(/\/verified\//);
    expect((send.mock.calls.at(-1)![0] as any).input.Body).toBe(png);
    const signed = await generatePresignedUrl('fixture.png', 'image/png', '111111111111111111111111', 100, png.length);
    expect(new URL(signed.uploadUrl).searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
  });

  it('uses verified patient-bound metadata once and denies another patient/tenant', async () => {
    const org = await Organization.create({ name: 'File fixture', city: 'Pune' });
    const root = await User.create({ name: 'File operator', role: 'root', email: 'file-operator@example.test' });
    const auth = await createAuthSession({ id: root.id, role: 'root', email: root.email!, organization_id: org.id });
    const patient = await Patient.create({ name: 'File patient', organizationId: org._id });
    const other = await Patient.create({ name: 'Other file patient', organizationId: org._id });
    const intent = await UploadIntent.create({ organizationId: org._id, userId: root._id, patientId: patient._id,
      objectKey: 'tenants/' + org.id + '/verified/fixture.pdf', originalFileName: 'fixture.pdf',
      permittedMimeTypes: ['application/pdf'], maxSizeBytes: 1000, status: 'completed', actualMimeType: 'application/pdf',
      actualSizeBytes: 100, magicBytesVerified: true, malwareClean: true });
    const register = (patientId: string) => app.inject({ method: 'POST', url: '/api/documents/upload',
      cookies: { access_token: auth.accessToken }, payload: { patientId, uploadIntentId: intent.id, fileUrl: 'http://127.0.0.1/private', fileName: 'forged', mimeType: 'text/html' } });
    expect((await register(other.id)).statusCode).toBe(409);
    const response = await register(patient.id);
    expect(response.statusCode).toBe(201);
    expect(response.json().data.fileUrl).toBe(intent.objectKey);
    expect(response.json().data.mimeType).toBe('application/pdf');
    expect((await register(patient.id)).statusCode).toBe(409);
    expect(await DocumentUpload.countDocuments({ patientId: patient._id })).toBe(1);
    const foreign = await Organization.create({ name: 'Foreign tenant', city: 'Pune' });
    const staff = await User.create({ name: 'Foreign doctor', role: 'doctor', email: 'foreign-file@example.test' });
    const session = await createAuthSession({ id: staff.id, role: 'doctor', email: staff.email!, organization_id: foreign.id });
    expect((await app.inject({ method: 'GET', url: '/api/patients/' + patient.id + '/search', cookies: { access_token: session.accessToken } })).statusCode).toBe(404);
  });

  it('closes revoked clinical sockets and rejects a foreign browser origin', async () => {
    const org = await Organization.create({ name: 'Socket fixture', city: 'Pune' });
    const clinic = await Clinic.create({ name: 'Socket clinic', organizationId: org._id, city: 'Pune' });
    const user = await User.create({ name: 'Socket doctor', role: 'doctor', email: 'socket-fixture@example.test' });
    const auth = await createAuthSession({ id: user.id, role: 'doctor', email: user.email!, organization_id: org.id });
    const req = { cookies: { access_token: auth.accessToken }, headers: {}, query: { clinicId: clinic.id } } as any;
    expect(await resolveWebSocketAuth({ ...req, headers: { origin: 'https://foreign.example.test' } })).toBeNull();
    const socket = Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn(), ping: vi.fn(), close: vi.fn() });
    socket.close.mockImplementation(() => { socket.readyState = 3; socket.emit('close'); });
    try {
      await handleClinicalWebSocket(socket as any, req);
      sendToClinicClinicalLocally(clinic.id, { type: 'LAB_RESULTS_READY', data: { fixture: true } });
      await vi.waitFor(() => expect(socket.send).toHaveBeenCalledTimes(2));
      await revokeUserSessions(user.id);
      sendToClinicClinicalLocally(clinic.id, { type: 'LAB_RESULTS_READY', data: { forbidden: true } });
      expect(socket.close).toHaveBeenCalled();
      expect(socket.send).toHaveBeenCalledTimes(2);
    } finally { socket.close(); }
  });

  it('does not trust forwarded hosts as production CSRF authority or CSV formulas', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { csrfProtection } = await import('../middleware/csrf.ts');
    const reply = { code: vi.fn().mockReturnThis(), send: vi.fn() } as any;
    await csrfProtection({ method: 'POST', url: '/api/auth/logout', cookies: { access_token: 'fixture' },
      headers: { origin: 'https://attacker.example.test', 'x-forwarded-host': 'attacker.example.test' } } as any, reply);
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(escapeCsv('=HYPERLINK("https://foreign.example", "Click")')).toMatch(/^"'/);
  });
});
