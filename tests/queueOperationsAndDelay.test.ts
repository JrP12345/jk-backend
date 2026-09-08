import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { Organization } from "../models/Organization.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Invoice } from "../models/Invoice.ts";

describe("Queue Standby / Park, Delay Cascading & Disruption Fee Reconciliation Tests", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let doctorId: string;
  let doctor2Id: string;
  let patient1: any;
  let patient2: any;
  let patient3: any;
  let appt1: any;
  let appt2: any;
  let appt3: any;

  beforeAll(async () => {
    // 1. Setup Organization & Admin
    const bootstrapRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Queue Ops Hospital ${Date.now()}`,
        city: "Delhi",
        admin_name: "Ops Admin",
        admin_email: `ops_admin_${Date.now()}@hospital.com`,
        admin_password: "Password123",
        plan: "enterprise",
      },
    });
    expect(bootstrapRes.statusCode).toBe(201);
    adminCookies = (bootstrapRes.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);
    orgId = JSON.parse(bootstrapRes.body).data.organization.id;

    // 2. Setup Clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: { name: "Delhi OPD Wing", city: "Delhi" },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Setup Primary Doctor (Doc 1: fee ₹500)
    const doc1Res = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Rajesh Sharma",
        email: `rajesh_${Date.now()}@hospital.com`,
        password: "Password123",
        phone: "+919811111111",
        specialization: "General Physician",
      },
    });
    doctorId = JSON.parse(doc1Res.body).data.id;

    // 4. Setup Replacement Doctor (Doc 2: Senior specialist, fee ₹800)
    const doc2Res = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Sunita Sen",
        email: `sunita_${Date.now()}@hospital.com`,
        password: "Password123",
        phone: "+919822222222",
        specialization: "General Physician",
      },
    });
    doctor2Id = JSON.parse(doc2Res.body).data.id;

    // Set consultation fees via DoctorAssignment
    await DoctorAssignment.findOneAndUpdate(
      { doctorId, clinicId },
      { organizationId: orgId, fees: 500, consultationFee: 500, workingHours: "[]", isActive: true },
      { upsert: true, returnDocument: "after" }
    );
    await DoctorAssignment.findOneAndUpdate(
      { doctorId: doctor2Id, clinicId },
      { organizationId: orgId, fees: 800, consultationFee: 800, workingHours: "[]", isActive: true },
      { upsert: true, returnDocument: "after" }
    );

    // 5. Setup Patients
    patient1 = await Patient.create({
      organizationId: orgId,
      name: "Amit Kumar",
      phone: "+919999900001",
      gender: "male",
    });

    patient2 = await Patient.create({
      organizationId: orgId,
      name: "Bhavna Patel",
      phone: "+919999900002",
      gender: "female",
    });

    patient3 = await Patient.create({
      organizationId: orgId,
      name: "Chetan Verma",
      phone: "+919999900003",
      gender: "male",
    });
  });

  it("Scenario 1: Park patient into Standby state and re-index active waiting queue", async () => {
    const today = new Date();

    // Create 2 checked-in waiting patients
    appt1 = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId,
      patientId: patient1._id,
      appointmentTime: today,
      appointmentType: "walk-in",
      status: "checked-in",
      tokenNumber: 1,
      queuePosition: 1,
    });

    appt2 = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId,
      patientId: patient2._id,
      appointmentTime: today,
      appointmentType: "walk-in",
      status: "checked-in",
      tokenNumber: 2,
      queuePosition: 2,
    });

    // Patient 1 steps out for blood tests -> Park Patient 1
    const parkRes = await app.inject({
      method: "POST",
      url: `/api/queue/${appt1._id}/park`,
      headers: { cookie: adminCookies.join("; ") },
      payload: { reason: "Stepped out for pathology sample collection" },
    });

    expect(parkRes.statusCode).toBe(200);
    const parkBody = JSON.parse(parkRes.body);
    expect(parkBody.success).toBe(true);
    expect(parkBody.data.status).toBe("standby");
    expect(parkBody.data.parkedReason).toBe("Stepped out for pathology sample collection");
    expect(parkBody.data.parkedAt).toBeDefined();

    // Verify patient 1 in DB has status "standby" and null queuePosition
    const dbAppt1 = await Appointment.findById(appt1._id);
    expect(dbAppt1?.status).toBe("standby");
    expect(dbAppt1?.queuePosition).toBeFalsy();

    // Patient 2 must now have moved up to queuePosition: 1
    const dbAppt2 = await Appointment.findById(appt2._id);
    expect(dbAppt2?.queuePosition).toBe(1);

    // Verify Audit Log was generated
    const audit = await AuditLog.findOne({
      action: "QUEUE_PATIENT_PARKED",
      targetId: appt1._id,
    });
    expect(audit).toBeDefined();
    expect(audit?.details.reason).toBe("Stepped out for pathology sample collection");
  });

  it("Scenario 2: Resume parked patient and restore as Priority Next Up (queuePosition: 1)", async () => {
    // Add another waiting patient (Patient 3) who checked in while Patient 1 was away
    const today = new Date();
    appt3 = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId,
      patientId: patient3._id,
      appointmentTime: today,
      appointmentType: "walk-in",
      status: "checked-in",
      tokenNumber: 3,
      queuePosition: 2, // Behind appt2
    });

    // Patient 1 returns from blood test -> Reception resumes Patient 1
    const resumeRes = await app.inject({
      method: "POST",
      url: `/api/queue/${appt1._id}/resume`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(resumeRes.statusCode).toBe(200);
    const resumeBody = JSON.parse(resumeRes.body);
    expect(resumeBody.success).toBe(true);
    expect(resumeBody.data.status).toBe("checked-in");
    expect(resumeBody.data.queuePosition).toBe(1); // Next Up!

    // Verify Patient 1 in DB
    const freshAppt1 = await Appointment.findById(appt1._id);
    expect(freshAppt1?.status).toBe("checked-in");
    expect(freshAppt1?.queuePosition).toBe(1);

    // Patient 2 and Patient 3 should have been shifted down to positions 2 and 3
    const freshAppt2 = await Appointment.findById(appt2._id);
    const freshAppt3 = await Appointment.findById(appt3._id);
    expect(freshAppt2?.queuePosition).toBe(2);
    expect(freshAppt3?.queuePosition).toBe(3);

    // Verify Audit Log
    const audit = await AuditLog.findOne({
      action: "QUEUE_PATIENT_RESUMED",
      targetId: appt1._id,
    });
    expect(audit).toBeDefined();
    expect(audit?.details.restoredPosition).toBe(1);
    expect(audit?.details.isPriorityNextUp).toBe(true);
  });

  it("Scenario 3: Queue delay calculation and cascading WhatsApp alert trigger", async () => {
    // Setup a remote confirmed patient booked for today
    const slotTime = new Date();
    slotTime.setMinutes(slotTime.getMinutes() - 30); // slot was 30 mins ago

    const delayedRemoteAppt = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId,
      patientId: patient3._id,
      appointmentTime: slotTime,
      appointmentType: "online",
      status: "confirmed",
      tokenNumber: 4,
    });

    // Put Patient 1 into consultation to simulate an active consultation
    await Appointment.findByIdAndUpdate(appt1._id, { status: "in-consultation" });

    // Fetch delay status
    const delayStatusRes = await app.inject({
      method: "GET",
      url: `/api/queue/delay-status?clinicId=${clinicId}&doctorId=${doctorId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(delayStatusRes.statusCode).toBe(200);
    const delayData = JSON.parse(delayStatusRes.body).data;
    expect(delayData.affectedCount).toBeGreaterThanOrEqual(1);

    // Trigger proactive delay alerts
    const alertRes = await app.inject({
      method: "POST",
      url: "/api/queue/trigger-delay-alerts",
      headers: { cookie: adminCookies.join("; ") },
      payload: { clinicId, doctorId },
    });

    expect(alertRes.statusCode).toBe(200);
    const alertBody = JSON.parse(alertRes.body);
    expect(alertBody.success).toBe(true);
    expect(alertBody.data.notifiedCount).toBeGreaterThanOrEqual(1);

    // Verify appt in DB now has delayNotifiedAt timestamp
    const freshDelayedAppt = await Appointment.findById(delayedRemoteAppt._id);
    expect(freshDelayedAppt?.delayNotifiedAt).toBeDefined();
    expect(freshDelayedAppt?.lastNotifiedDelayMinutes).toBeGreaterThanOrEqual(20);

    // Second immediate trigger should be debounced (0 notified)
    const secondAlertRes = await app.inject({
      method: "POST",
      url: "/api/queue/trigger-delay-alerts",
      headers: { cookie: adminCookies.join("; ") },
      payload: { clinicId, doctorId },
    });
    const secondAlertBody = JSON.parse(secondAlertRes.body);
    expect(secondAlertBody.data.notifiedCount).toBe(0); // Debounced!
  });

  it("Scenario 4: Disruption transfer reconciles fee difference and absorbs courtesy waiver", async () => {
    // Create appointment booked with Doctor 1 (fee ₹500)
    const today = new Date();
    const apptToTransfer = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId,
      patientId: patient2._id,
      appointmentTime: today,
      appointmentType: "online",
      status: "disruption_triage",
      tokenNumber: 5,
      paymentStatus: "paid",
    });

    // Create original invoice for ₹500
    const invoice = await Invoice.create({
      organizationId: orgId,
      clinicId,
      doctorId,
      patientId: patient2._id,
      appointmentId: apptToTransfer._id,
      invoiceNumber: `INV-DISRUPT-${Date.now()}`,
      items: [{ description: "Consultation Fee - Dr. Rajesh Sharma", quantity: 1, amount: 500 }],
      subtotal: 500,
      totalAmount: 500,
      amountPaid: 500,
      status: "paid",
    }) as any;

    // Transfer patient to Doctor 2 (fee ₹800)
    const transferRes = await app.inject({
      method: "POST",
      url: "/api/doctor-overrides/triage/transfer",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        appointmentId: apptToTransfer._id.toString(),
        replacementDoctorId: doctor2Id,
        reason: "Dr. Rajesh has emergency schedule disruption",
      },
    });

    expect(transferRes.statusCode).toBe(200);
    const transferBody = JSON.parse(transferRes.body);
    expect(transferBody.success).toBe(true);

    // Verify appointment fee variance and resolution
    const transferred = await Appointment.findById(apptToTransfer._id);
    expect(transferred?.doctorId?.toString()).toBe(doctor2Id);
    expect(transferred?.feeVariance).toBe(300); // 800 - 500 = +300
    expect(transferred?.feeResolution).toBe("waived_courtesy");

    // Verify invoice note updated with courtesy waiver
    const freshInvoice = await Invoice.findById(invoice._id);
    expect(freshInvoice?.notes).toContain("Disruption Courtesy: Original fee ₹500 honored");
    expect(freshInvoice?.notes).toContain("₹300 difference absorbed by clinic");

    // Verify AuditLog recorded the fee absorption
    const audit = await AuditLog.findOne({
      action: "APPOINTMENT_TRANSFERRED",
      targetId: apptToTransfer._id,
    });
    expect(audit).toBeDefined();
    expect(audit?.details.feeVariance).toBe(300);
    expect(audit?.details.feeResolution).toBe("waived_courtesy");
  });

  it("Scenario 5: Public tracker exposes standby & delay fields, and public clinic details reports online cutoff", async () => {
    // 1. Create standby appointment
    const standbyAppt = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId,
      patientId: patient1._id,
      appointmentTime: new Date(),
      appointmentType: "walk-in",
      status: "standby",
      tokenNumber: 10,
      parkedAt: new Date(),
      parkedReason: "Pathology sample collection",
      delayNotifiedAt: new Date(),
      lastNotifiedDelayMinutes: 25,
    });

    // 2. Call public tracker endpoint
    const trackerRes = await app.inject({
      method: "GET",
      url: `/api/public/track/${standbyAppt._id}`,
    });

    expect(trackerRes.statusCode).toBe(200);
    const trackerData = JSON.parse(trackerRes.body).data;
    expect(trackerData.status).toBe("standby");
    expect(trackerData.parkedReason).toBe("Pathology sample collection");
    expect(trackerData.parkedAt).toBeDefined();
    expect(trackerData.delayNotifiedAt).toBeDefined();
    expect(trackerData.lastNotifiedDelayMinutes).toBe(25);
    expect(trackerData.peopleAhead).toBe(0); // Next up upon return!

    // 3. Call public clinic details
    const clinicDetailsRes = await app.inject({
      method: "GET",
      url: `/api/public/clinics/${clinicId}`,
    });

    expect(clinicDetailsRes.statusCode).toBe(200);
    const clinicData = JSON.parse(clinicDetailsRes.body).data;
    const docInfo = clinicData.doctors.find((d: any) => d.id === doctorId);
    expect(docInfo).toBeDefined();
    expect(docInfo).toHaveProperty("isOnlineBookingClosed");
  });
});
