import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { Organization } from "../models/Organization.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { Invoice } from "../models/Invoice.ts";
import { DoctorDayOverride } from "../models/DoctorDayOverride.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { runDisruptionTimeoutSweep } from "../jobs/disruptionTimeoutJob.ts";

describe("Doctor Availability Disruption & Patient Triage End-to-End Tests", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let doc1Id: string;
  let doc2Id: string;
  let patient1: any;
  let patient2: any;
  let patient3: any;
  let patient4: any;

  const todayStr = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    // 1. Setup Organization & Admin
    const bootstrapRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Disruption General Hospital ${Date.now()}`,
        city: "Bangalore",
        admin_name: "Disruption Admin",
        admin_email: `disrupt_admin_${Date.now()}@disruption.com`,
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
      payload: { name: "Bangalore Central Clinic", city: "Bangalore" },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Setup Primary Doctor (Doc 1)
    const doc1Res = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Arvind Swamy",
        email: `arvind_${Date.now()}@disruption.com`,
        password: "Password123",
        specialization: "General Medicine",
      },
    });
    expect(doc1Res.statusCode).toBe(201);
    doc1Id = JSON.parse(doc1Res.body).data.id;

    // Assign Doc 1
    await app.inject({
      method: "POST",
      url: "/api/onboarding/doctors/assignments",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        doctorId: doc1Id,
        clinicId,
        fees: 600,
        appointmentDuration: 15,
        bookingMode: "sequential_queue",
        workingHours: JSON.stringify([{ start: "09:00", end: "17:00" }]),
      },
    });

    // 4. Setup Replacement Doctor (Doc 2)
    const doc2Res = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Priya Nair",
        email: `priya_${Date.now()}@disruption.com`,
        password: "Password123",
        specialization: "General Medicine",
      },
    });
    expect(doc2Res.statusCode).toBe(201);
    doc2Id = JSON.parse(doc2Res.body).data.id;

    // Assign Doc 2
    await app.inject({
      method: "POST",
      url: "/api/onboarding/doctors/assignments",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        doctorId: doc2Id,
        clinicId,
        fees: 600,
        appointmentDuration: 15,
        bookingMode: "sequential_queue",
        workingHours: JSON.stringify([{ start: "09:00", end: "17:00" }]),
      },
    });

    // 5. Create 4 Patients
    patient1 = await Patient.create({
      organizationId: orgId,
      name: "Patient One",
      phone: "919000000001",
      gender: "female",
      dob: "1990-01-01",
    });
    patient2 = await Patient.create({
      organizationId: orgId,
      name: "Patient Two",
      phone: "919000000002",
      gender: "male",
      dob: "1985-05-12",
    });
    patient3 = await Patient.create({
      organizationId: orgId,
      name: "Patient Three",
      phone: "919000000003",
      gender: "female",
      dob: "1992-08-20",
    });
    patient4 = await Patient.create({
      organizationId: orgId,
      name: "Patient Four",
      phone: "919000000004",
      gender: "male",
      dob: "1988-11-04",
    });
  });

  let apptInConsultation: any;
  let apptCheckedIn: any;
  let apptConfirmed: any;
  let apptPending: any;

  it("Scenario A, B, C: Sets doctor unavailable, preserving in-consultation, placing checked-in in triage, and notifying confirmed/pending", async () => {
    const today = new Date();
    today.setHours(10, 0, 0, 0);

    // Create 4 appointments for Doc 1 today
    apptInConsultation = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId: doc1Id,
      patientId: patient1._id,
      appointmentTime: today,
      appointmentType: "reception",
      status: "in-consultation",
      tokenNumber: 1,
    });

    apptCheckedIn = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId: doc1Id,
      patientId: patient2._id,
      appointmentTime: today,
      appointmentType: "walk-in",
      status: "checked-in",
      tokenNumber: 2,
    });

    apptConfirmed = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId: doc1Id,
      patientId: patient3._id,
      appointmentTime: today,
      appointmentType: "online",
      status: "confirmed",
      tokenNumber: 3,
    });

    apptPending = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId: doc1Id,
      patientId: patient4._id,
      appointmentTime: today,
      appointmentType: "online",
      status: "pending",
      tokenNumber: 4,
    });

    // Doctor 1 becomes unavailable today
    const overrideRes = await app.inject({
      method: "POST",
      url: "/api/doctor-overrides",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        doctorId: doc1Id,
        date: todayStr,
        status: "unavailable",
        reason: "Medical emergency leave",
      },
    });

    expect(overrideRes.statusCode).toBe(200);
    const body = JSON.parse(overrideRes.body);
    expect(body.success).toBe(true);
    expect(body.data.affectedSummary.inConsultationPreservedCount).toBe(1);
    expect(body.data.affectedSummary.checkedInTriageCount).toBe(1);
    expect(body.data.affectedSummary.remoteNotifiedCount).toBe(2);

    // Verify In-Consultation: PRESERVED and untouched
    const freshInConsultation = await Appointment.findById(apptInConsultation._id);
    expect(freshInConsultation?.status).toBe("in-consultation");

    // Verify Checked-in: In disruption_triage, NOT auto-cancelled!
    const freshCheckedIn = await Appointment.findById(apptCheckedIn._id);
    expect(freshCheckedIn?.status).toBe("disruption_triage");
    expect(freshCheckedIn?.triageAction).toBe("pending");
    expect(freshCheckedIn?.notes).toContain("[TRIAGE: Doctor unavailable - awaiting reception action]");

    // Verify Confirmed & Pending: In disruption_triage with 60-min deadline
    const freshConfirmed = await Appointment.findById(apptConfirmed._id);
    expect(freshConfirmed?.status).toBe("disruption_triage");
    expect(freshConfirmed?.disruptionResponseDeadline).toBeDefined();

    const freshPending = await Appointment.findById(apptPending._id);
    expect(freshPending?.status).toBe("disruption_triage");
  });

  it("Scenario D: Fetches eligible replacement doctors at the same clinic", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/doctor-overrides/eligible-replacements?clinicId=${clinicId}&doctorId=${doc1Id}&date=${todayStr}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);

    // Dr. Priya Nair (Doc 2) should be present and eligible
    const foundDoc2 = body.data.find((d: any) => d.doctorId === doc2Id);
    expect(foundDoc2).toBeDefined();
    expect(foundDoc2.overrideStatus).toBe("available");
  });

  it("Scenario E: Reassigns / transfers checked-in patient to replacement doctor with Next-Up priority and AuditLog", async () => {
    // 1. Create a pre-existing waiting appointment for Doctor 2 (Doc 2)
    const existingDoc2Appt = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId: doc2Id,
      patientId: patient4._id,
      appointmentTime: new Date(),
      appointmentType: "reception",
      status: "checked-in",
      tokenNumber: 1,
      queuePosition: 1,
    });

    // 2. Transfer apptCheckedIn (transferred from Doc 1) to Doc 2
    const transferRes = await app.inject({
      method: "POST",
      url: "/api/doctor-overrides/triage/transfer",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        appointmentId: apptCheckedIn._id.toString(),
        replacementDoctorId: doc2Id,
        reason: "Primary doctor emergency leave",
      },
    });

    expect(transferRes.statusCode).toBe(200);
    const body = JSON.parse(transferRes.body);
    expect(body.success).toBe(true);

    const transferredAppt = await Appointment.findById(apptCheckedIn._id);
    expect(transferredAppt?.doctorId?.toString()).toBe(doc2Id);
    expect(transferredAppt?.originalDoctorId?.toString()).toBe(doc1Id);
    expect(transferredAppt?.originalTokenNumber).toBe(2);
    expect(transferredAppt?.status).toBe("checked-in"); // restored to active wait!
    expect(transferredAppt?.triageAction).toBe("transferred");
    expect(transferredAppt?.transferredAt).toBeDefined();

    // Priority Check: Transferred patient must have queuePosition: 1 (Next Up!)
    expect(transferredAppt?.queuePosition).toBe(1);

    // Existing Doc 2 waiting patient must be shifted down to queuePosition: 2
    const freshDoc2Appt = await Appointment.findById(existingDoc2Appt._id);
    expect(freshDoc2Appt?.queuePosition).toBe(2);

    // Persistent AuditLog Verification: APPOINTMENT_TRANSFERRED { fromDoctor, toDoctor, reason, staffId }
    const auditTransfer = await AuditLog.findOne({
      action: "APPOINTMENT_TRANSFERRED",
      targetId: apptCheckedIn._id,
    });
    expect(auditTransfer).toBeDefined();
    expect(auditTransfer?.details.fromDoctor).toBe(doc1Id);
    expect(auditTransfer?.details.toDoctor).toBe(doc2Id);
    expect(auditTransfer?.details.reason).toBe("Primary doctor emergency leave");
    expect(auditTransfer?.details.queuePosition).toBe(1);
    expect(auditTransfer?.details.isPriorityNextUp).toBe(true);

    // 3. Verify callNextPatient: Calling next patient for Doc 2 MUST call the transferred patient (Next Up!)
    const callNextRes = await app.inject({
      method: "POST",
      url: "/api/queue/call-next",
      headers: { cookie: adminCookies.join("; ") },
      payload: { clinicId, doctorId: doc2Id },
    });
    expect(callNextRes.statusCode).toBe(200);
    const callBody = JSON.parse(callNextRes.body);
    expect(callBody.data.id || callBody.data._id).toBe(apptCheckedIn._id.toString());
  });

  it("Scenario F: Cancels disrupted appointment, issues full refund, and persists AuditLog", async () => {
    // Mark apptConfirmed as paid with an invoice
    apptConfirmed.paymentStatus = "paid";
    await apptConfirmed.save();

    const invoice = await Invoice.create({
      organizationId: orgId,
      clinicId,
      doctorId: doc1Id,
      patientId: patient3._id,
      appointmentId: apptConfirmed._id,
      invoiceNumber: `INV-${Date.now()}`,
      items: [{ description: "Consultation Fee", quantity: 1, amount: 600 }],
      subtotal: 600,
      totalAmount: 600,
      amountPaid: 600,
      balanceDue: 0,
      paymentMethod: "online",
      payments: [
        {
          amount: 600,
          paymentMethod: "online",
          referenceNumber: `tx_mock_${Date.now()}`,
          paidAt: new Date(),
        },
      ],
      status: "paid",
    });

    const cancelRes = await app.inject({
      method: "POST",
      url: "/api/doctor-overrides/triage/cancel",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        appointmentId: apptConfirmed._id.toString(),
        reason: "Patient requested refund due to disruption",
      },
    });

    expect(cancelRes.statusCode).toBe(200);

    const cancelledAppt = await Appointment.findById(apptConfirmed._id);
    expect(cancelledAppt?.status).toBe("cancelled");
    expect(cancelledAppt?.paymentStatus).toBe("refunded");
    expect(cancelledAppt?.triageAction).toBe("refunded");

    const updatedInvoice = await Invoice.findById(invoice._id);
    expect(updatedInvoice?.status).toBe("refunded");

    // Persistent AuditLog Verification: APPOINTMENT_CANCELLED and APPOINTMENT_REFUNDED
    const auditCancel = await AuditLog.findOne({
      action: "APPOINTMENT_CANCELLED",
      targetId: apptConfirmed._id,
    });
    expect(auditCancel).toBeDefined();
    expect(auditCancel?.details.fromDoctor).toBe(doc1Id);
    expect(auditCancel?.details.refundProcessed).toBe(true);

    const auditRefund = await AuditLog.findOne({
      action: "APPOINTMENT_REFUNDED",
      targetId: invoice._id,
    });
    expect(auditRefund).toBeDefined();
    expect(auditRefund?.details.amount).toBe(600);
  });

  it("Scenario G: Priority reschedules disrupted appointment, carrying over payments and persisting AuditLog", async () => {
    const targetDate = "2026-09-15";
    const rescheduleRes = await app.inject({
      method: "POST",
      url: "/api/doctor-overrides/triage/reschedule",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        appointmentId: apptPending._id.toString(),
        targetDate,
        targetTimeSlot: "11:00",
        reason: "Patient preferred rescheduling to next week",
      },
    });

    expect(rescheduleRes.statusCode).toBe(200);
    const body = JSON.parse(rescheduleRes.body);
    expect(body.success).toBe(true);

    const oldAppt = await Appointment.findById(apptPending._id);
    expect(oldAppt?.status).toBe("cancelled");
    expect(oldAppt?.triageAction).toBe("rescheduled");

    const newApptId = body.data.newAppt?.id || body.data.newAppt?._id;
    const newAppt = await Appointment.findById(newApptId);
    expect(newAppt?.status).toBe("confirmed");
    expect(newAppt?.priorityRescheduledFromId?.toString()).toBe(apptPending._id.toString());
    expect(new Date(newAppt!.appointmentTime).toISOString().slice(0, 10)).toBe(targetDate);

    // Persistent AuditLog Verification: APPOINTMENT_RESCHEDULED
    const auditReschedule = await AuditLog.findOne({
      action: "APPOINTMENT_RESCHEDULED",
      targetId: apptPending._id,
    });
    expect(auditReschedule).toBeDefined();
    expect(auditReschedule?.details.originalAppointmentId).toBe(apptPending._id.toString());
    expect(auditReschedule?.details.targetDate).toBe(targetDate);
  });

  it("Scenario H: Disruption timeout sweeper auto-cancels un-actioned appointments after 60 mins", async () => {
    // Create an un-actioned remote appointment with an expired deadline
    const expiredAppt = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId: doc1Id,
      patientId: patient4._id,
      appointmentTime: new Date(),
      appointmentType: "online",
      status: "disruption_triage",
      triageAction: "pending",
      disruptionResponseDeadline: new Date(Date.now() - 5 * 60 * 1000), // expired 5 min ago
      tokenNumber: 99,
    });

    const sweepResult = await runDisruptionTimeoutSweep();
    expect(sweepResult.autoCancelledCount).toBeGreaterThanOrEqual(1);

    const checkAppt = await Appointment.findById(expiredAppt._id);
    expect(checkAppt?.status).toBe("cancelled");
    expect(checkAppt?.cancellationReason).toContain("expired");
  });

  it("Scenario I: Patient self-service endpoint handles action from live tracker", async () => {
    // Create an appointment currently in disruption triage
    const triageAppt = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId: doc1Id,
      patientId: patient1._id,
      appointmentTime: new Date(),
      appointmentType: "online",
      status: "disruption_triage",
      triageAction: "pending",
      disruptionResponseDeadline: new Date(Date.now() + 30 * 60 * 1000),
      tokenNumber: 50,
    });

    const selfServiceRes = await app.inject({
      method: "POST",
      url: "/api/doctor-overrides/patient-action",
      payload: {
        appointmentId: triageAppt._id.toString(),
        action: "reschedule",
        targetDate: "2026-09-18",
        reason: "Patient clicked reschedule on live tracker",
      },
    });

    expect(selfServiceRes.statusCode).toBe(200);
    const body = JSON.parse(selfServiceRes.body);
    expect(body.success).toBe(true);

    const oldAppt = await Appointment.findById(triageAppt._id);
    expect(oldAppt?.status).toBe("cancelled");
    expect(oldAppt?.triageAction).toBe("rescheduled");
  });
});
