import { provisioningFixtureHeaders, provisionedAdminCookies } from "./helpers/provisioningFixture.ts";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { app } from "../index.ts";
import crypto from 'node:crypto';
import { PatientRelationship } from '../models/PatientRelationship.ts';
import { OrgMember } from '../models/OrgMember.ts';
import { OutboundMessage } from '../models/OutboundMessage.ts';
import { OperationReceipt } from '../models/OperationReceipt.ts';
import { DPDPConsent } from '../models/DPDPConsent.ts';
import { patientCommunicationPolicy } from '../services/PatientCommunicationPolicy.ts';
import { readEncryptedOutboundPayload } from '../services/CommunicationOutbox.ts';
import { updatePatientConsents, CONSENT_NOTICE_VERSION } from '../services/PatientConsentService.ts';
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { User } from "../models/User.ts";
import { triggerTurnApproachingPacing } from "../controllers/queue.ts";

afterEach(() => vi.restoreAllMocks());

describe("P2 Turn Approaching Notification Loop & P3 Resend Tracker Suite", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let locationId: string;
  let doctorId: string;
  let doctorUserId: string;
  let patient1: any;
  let patient2: any;
  let patient3: any;

  beforeAll(async () => {
    // 1. Setup Organization & Super Admin
    const bootstrapRes = await app.inject({ headers: await provisioningFixtureHeaders(),
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Apollo Health Network ${Date.now()}`,
        city: "Mumbai",
        admin_name: "Apollo Ops Admin",
        admin_email: `apollo_ops_${Date.now()}@health.com`,
        admin_password: "Password123",
        plan: "enterprise",
      },
    });
    expect(bootstrapRes.statusCode).toBe(201);
    adminCookies = (await provisionedAdminCookies(bootstrapRes));
    orgId = JSON.parse(bootstrapRes.body).data.organization.id;

    // Enable WhatsApp in test org
    await Organization.updateOne(
      { _id: orgId },
      {
        $set: {
          whatsappConfig: {
            mode: "mock",
            creditsBalance: 500,
            creditsUsedThisMonth: 0,
            notifications: {
              sendTurnApproaching: true,
              sendBookingConfirmation: true,
            },
          },
        },
      }
    );

    // 2. Setup Location
    const locationRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/locations",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Apollo Bandra OPD Center",
        city: "Mumbai",
        upiVpa: "apollobandra@okhdfcbank",
        merchantName: "Apollo Locations",
      },
    });
    expect(locationRes.statusCode).toBe(201);
    locationId = JSON.parse(locationRes.body).data.id;

    // 3. Setup Doctor
    const docRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Ananya Roy",
        email: `dr.ananya_${Date.now()}@apollo.com`,
        password: "Password123",
        specialization: "General Physician",
        consultationFee: 700,
        locationIds: [locationId],
      },
    });
    expect(docRes.statusCode).toBe(201);
    const docData = JSON.parse(docRes.body).data;
    doctorId = docData.id;
    doctorUserId = docData.userId || docData.id;

    await DoctorAssignment.findOneAndUpdate({ organizationId: orgId, doctorId: doctorUserId, locationId }, { $set: {
      organizationId: orgId,
      doctorId: doctorUserId,
      locationId,
      fees: 700,
      workingHours: "[]",
      isActive: true,
    } }, { upsert: true });

    // 4. Setup Patients with associated User accounts
    const u1 = await User.create({
      name: "Rohit Sharma",
      email: `rohit_${Date.now()}@patient.com`,
      phone: "+919820011111",
      role: "patient",
      password: "Password123",
    });
    patient1 = await Patient.create({
      organizationId: orgId,
      userId: u1._id,
      name: "Rohit Sharma",
      phone: "+919820011111",
      gender: "male",
      dob: new Date("1988-04-30"),
      bloodGroup: "B+",
    });

    const u2 = await User.create({
      name: "Sneha Patil",
      email: `sneha_${Date.now()}@patient.com`,
      phone: "+919820022222",
      role: "patient",
      password: "Password123",
    });
    patient2 = await Patient.create({
      organizationId: orgId,
      userId: u2._id,
      name: "Sneha Patil",
      phone: "+919820022222",
      gender: "female",
      dob: new Date("1994-08-12"),
      bloodGroup: "O+",
    });

    const u3 = await User.create({
      name: "Karan Johar",
      email: `karan_${Date.now()}@patient.com`,
      phone: "+919820033333",
      role: "patient",
      password: "Password123",
    });
    patient3 = await Patient.create({
      organizationId: orgId,
      userId: u3._id,
      name: "Karan Johar",
      phone: "+919820033333",
      gender: "male",
      dob: new Date("1975-05-25"),
      bloodGroup: "A+",
    });
    const member = await OrgMember.findOne({ organizationId: orgId, role: 'admin' });
    await OrgMember.updateOne({ _id: member!._id }, { locationAccess: { mode: 'all', locationIds: [] } });
    for (const patient of [patient1, patient2, patient3]) {
      await PatientRelationship.create({ organizationId: orgId, patientId: patient.id, locationId });
      await updatePatientConsents(patient.id, orgId, [{ purpose: 'COMMUNICATION_WHATSAPP', status: 'GRANTED' }], { actorId: String(member!.userId), clientRequestId: crypto.randomUUID(), expectedRevision: 0, method: 'in_person_confirmation', noticeVersion: CONSENT_NOTICE_VERSION, acknowledged: true, note: 'Reviewed synthetic channel choice' });
    }
  });

  it("P2: Advances queue and autonomously triggers turn approaching alerts on next 1-2 waiting patients", async () => {
    const today = new Date();

    // Create 3 active checked-in appointments for today
    const appt1 = await Appointment.create({
      organizationId: orgId,
      locationId,
      doctorId,
      patientId: patient1._id,
      appointmentTime: today,
      appointmentType: "walk-in",
      status: "checked-in",
      tokenNumber: 201,
      queuePosition: 1,
      paymentStatus: "paid",
    });

    const appt2 = await Appointment.create({
      organizationId: orgId,
      locationId,
      doctorId,
      patientId: patient2._id,
      appointmentTime: today,
      appointmentType: "walk-in",
      status: "checked-in",
      tokenNumber: 202,
      queuePosition: 2,
      paymentStatus: "paid",
    });

    const appt3 = await Appointment.create({
      organizationId: orgId,
      locationId,
      doctorId,
      patientId: patient3._id,
      appointmentTime: today,
      appointmentType: "walk-in",
      status: "checked-in",
      tokenNumber: 203,
      queuePosition: 3,
      paymentStatus: "paid",
    });

    // Verify initially turnApproachingNotifiedAt is null
    expect(appt2.turnApproachingNotifiedAt).toBeFalsy();
    expect(appt3.turnApproachingNotifiedAt).toBeFalsy();

    // Call Next Patient (Appt 1 is summoned into cabin)
    const callRes = await app.inject({
      method: "POST",
      url: "/api/queue/call-next",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        locationId,
        doctorId,
      },
    });

    expect(callRes.statusCode).toBe(200);
    const calledData = JSON.parse(callRes.body).data;
    expect(calledData.id).toBe(appt1._id.toString());
    expect(calledData.status).toBe("in-consultation");

    // Manually trigger or allow background pacing helper to execute
    await triggerTurnApproachingPacing(locationId, doctorId);

    // Verify Appt 2 (now 1st waiting patient) received turn approaching notification timestamp
    const refreshedAppt2 = await Appointment.findById(appt2._id);
    expect(refreshedAppt2).toBeDefined();
    expect(refreshedAppt2?.turnApproachingNotifiedAt).toBeInstanceOf(Date);

    // Verify Appt 3 (now 2nd waiting patient) also received turn approaching notification timestamp
    const refreshedAppt3 = await Appointment.findById(appt3._id);
    expect(refreshedAppt3).toBeDefined();
    expect(refreshedAppt3?.turnApproachingNotifiedAt).toBeInstanceOf(Date);

    // Verify Idempotency: Re-invoking pacing does not modify the existing notification timestamp
    const originalNotifiedAt2 = refreshedAppt2?.turnApproachingNotifiedAt?.getTime();
    await triggerTurnApproachingPacing(locationId, doctorId);
    const reCheckedAppt2 = await Appointment.findById(appt2._id);
    expect(reCheckedAppt2?.turnApproachingNotifiedAt?.getTime()).toBe(originalNotifiedAt2);
  });

  it("P3: Receptionist 1-click resends tracker link to patient's registered phone", async () => {
    const today = new Date();
    const appt = await Appointment.create({
      organizationId: orgId,
      locationId,
      doctorId,
      patientId: patient1._id,
      appointmentTime: today,
      appointmentType: "walk-in",
      status: "checked-in",
      tokenNumber: 204,
      queuePosition: 4,
      paymentStatus: "paid",
    });

    await Organization.updateOne({ _id: orgId }, { 'whatsappConfig.notifications.sendTurnApproaching': false });
    const res = await app.inject({
      method: "POST",
      url: `/api/queue/${appt._id}/resend-tracker`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        channel: "whatsapp",
        clientRequestId: "tracker-request-204",
      },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.tokenNumber).toBe(204);
    expect(body.data.recipientPhone).toBeUndefined();
    expect(body.data.status).toBe("pending");
    expect(body.data.channel).toBe("whatsapp");
    expect(body.data.trackingUrl).toBeUndefined();
    const replay = await app.inject({ method: "POST", url: `/api/queue/${appt.id}/resend-tracker`, headers: { cookie: adminCookies.join("; ") }, payload: { channel: "whatsapp", clientRequestId: "tracker-request-204" } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.outboxId).toBe(body.data.outboxId);
    expect(replay.json().data.replayed).toBe(true);
    expect(await OutboundMessage.countDocuments({ _id: body.data.outboxId })).toBe(1);

    // Verify AuditLog entry was created
    const audit = await AuditLog.findOne({
      targetId: appt._id,
      action: "QUEUE_TRACKER_RESENT",
    });
    expect(audit).toBeDefined();
    expect(audit?.details.recipientPhone).toBeUndefined();
    expect(audit?.details.recipientHash).toBeTruthy();
  });

  it('rejects unsupported SMS and unreviewed alternate recipients without queueing', async () => {
    const appt = await Appointment.create({ organizationId: orgId, locationId, doctorId, patientId: patient2.id, appointmentTime: new Date(), appointmentType: 'walk-in', status: 'confirmed', tokenNumber: 205, queuePosition: 5 });
    for (const [channel, status] of [['sms', 422], ['whatsapp', 409]] as const) {
      const res = await app.inject({ method: 'POST', url: '/api/queue/' + appt.id + '/resend-tracker', headers: { cookie: adminCookies.join('; ') }, payload: { phone: '+919988776655', channel, clientRequestId: crypto.randomUUID() } });
      expect(res.statusCode).toBe(status);
    }
    expect(await OutboundMessage.countDocuments({ 'payload.appointmentId': appt.id })).toBe(0);
  });
  it('rolls message, tracker credential and receipt back on audit failure, then retries once', async () => {
    const appt = await Appointment.create({ organizationId: orgId, locationId, doctorId, patientId: patient3.id, appointmentTime: new Date(), appointmentType: 'walk-in', status: 'confirmed', tokenNumber: 206, queuePosition: 6 });
    const request = { method: 'POST' as const, url: '/api/queue/' + appt.id + '/resend-tracker', headers: { cookie: adminCookies.join('; ') }, payload: { clientRequestId: crypto.randomUUID(), channel: 'whatsapp' } };
    const spy = vi.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('audit unavailable'));
    expect((await app.inject(request)).statusCode).toBe(503); spy.mockRestore();
    expect(await OutboundMessage.countDocuments({ 'payload.appointmentId': appt.id })).toBe(0);
    expect(await OperationReceipt.countDocuments({ key: request.payload.clientRequestId })).toBe(0);
    expect((await Appointment.findById(appt.id).select('+trackerTokenHash'))?.trackerTokenHash).toBeFalsy();
    const retry = await app.inject(request); expect(retry.statusCode).toBe(200);
    const row = (await OutboundMessage.findById(retry.json().data.outboxId).select('+sensitivePayloadCiphertext'))!;
    const payload = readEncryptedOutboundPayload<any>(row);
    await DPDPConsent.updateOne({ patientId: patient3.id, organizationId: orgId }, { $set: { 'purposes.$[].status': 'WITHDRAWN' } });
    await expect(patientCommunicationPolicy(payload.communicationContext, 'whatsapp', payload.phone)).rejects.toThrow('COMMUNICATION_CONSENT_REQUIRED');
    expect((await app.inject(request)).json().data.outboxId).toBe(row.id);
  });
});
