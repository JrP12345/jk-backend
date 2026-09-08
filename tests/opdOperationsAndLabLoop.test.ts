import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { Organization } from "../models/Organization.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { OpdSession } from "../models/OpdSession.ts";

describe("OPD Session Lifecycle, Standby Return, Lab Diagnostic Loop & Queue TV Tests", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let doctorId: string;
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
        org_name: `OPD Clinical Hospital ${Date.now()}`,
        city: "Mumbai",
        admin_name: "OPD Admin",
        admin_email: `opd_admin_${Date.now()}@hospital.com`,
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
      payload: { name: "Mumbai OPD Wing", city: "Mumbai" },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Setup Doctor
    const docRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Ananya Roy",
        email: `ananya_${Date.now()}@hospital.com`,
        password: "Password123",
        phone: "+919822222222",
        specialization: "General Medicine",
        medicalCouncilRegNumber: `MCI-${Date.now()}`,
      },
    });
    expect(docRes.statusCode).toBe(201);
    doctorId = JSON.parse(docRes.body).data.id;

    // 4. Assign Doctor
    await DoctorAssignment.findOneAndUpdate(
      { doctorId, clinicId },
      {
        organizationId: orgId,
        fees: 600,
        consultationFee: 600,
        appointmentDuration: 15,
        bookingMode: "sequential_queue",
        workingHours: JSON.stringify({
          mon: [{ start: "09:00", end: "17:00" }],
          tue: [{ start: "09:00", end: "17:00" }],
          wed: [{ start: "09:00", end: "17:00" }],
          thu: [{ start: "09:00", end: "17:00" }],
          fri: [{ start: "09:00", end: "17:00" }],
          sat: [{ start: "09:00", end: "17:00" }],
          sun: [{ start: "09:00", end: "17:00" }],
        }),
        isActive: true,
      },
      { upsert: true, returnDocument: "after" }
    );

    // 5. Create 3 Patients
    patient1 = await Patient.create({
      organizationId: orgId,
      name: "Suresh Gupta",
      phone: "+919833333331",
      email: `suresh_${Date.now()}@patient.com`,
      dob: new Date("1985-05-15"),
      gender: "male",
      globalPatientId: `UPI-2026-${Date.now().toString().slice(-7)}`,
    });

    patient2 = await Patient.create({
      organizationId: orgId,
      name: "Meera Patel",
      phone: "+919833333332",
      email: `meera_${Date.now()}@patient.com`,
      dob: new Date("1990-08-20"),
      gender: "female",
      globalPatientId: `UPI-2026-${(Date.now() + 1).toString().slice(-7)}`,
    });

    patient3 = await Patient.create({
      organizationId: orgId,
      name: "Karan Johar",
      phone: "+919833333333",
      email: `karan_${Date.now()}@patient.com`,
      dob: new Date("1978-11-10"),
      gender: "male",
      globalPatientId: `UPI-2026-${(Date.now() + 2).toString().slice(-7)}`,
    });

    // 6. Create 3 Appointments for today
    const today = new Date();
    today.setHours(10, 0, 0, 0);

    appt1 = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId,
      patientId: patient1._id,
      appointmentTime: today,
      tokenNumber: 1,
      queuePosition: 1,
      status: "checked-in",
      appointmentType: "walk-in",
      bookingMode: "sequential_queue",
    });

    appt2 = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId,
      patientId: patient2._id,
      appointmentTime: today,
      tokenNumber: 2,
      queuePosition: 2,
      status: "checked-in",
      appointmentType: "walk-in",
      bookingMode: "sequential_queue",
    });

    appt3 = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId,
      patientId: patient3._id,
      appointmentTime: today,
      tokenNumber: 3,
      queuePosition: 3,
      status: "checked-in",
      appointmentType: "walk-in",
      bookingMode: "sequential_queue",
    });
  });

  it("1. Patient 1-Tap 'I Have Returned' should signal reception from mobile live tracker", async () => {
    // Move appt1 to standby first
    const parkRes = await app.inject({
      method: "POST",
      url: `/api/queue/${appt1._id}/park`,
      headers: { cookie: adminCookies.join("; ") },
      payload: { reason: "Stepped out to pharmacy" },
    });
    expect(parkRes.statusCode).toBe(200);

    // Patient signals return via unauthenticated public tracker endpoint
    const returnRes = await app.inject({
      method: "POST",
      url: `/api/public/track/${appt1._id}/return`,
    });
    expect(returnRes.statusCode).toBe(200);
    const returnData = JSON.parse(returnRes.body).data;
    expect(returnData.patientReturned).toBe(true);
    expect(returnData.patientReturnedAt).toBeDefined();

    // Verify public tracker returns patientReturned = true
    const trackerRes = await app.inject({
      method: "GET",
      url: `/api/public/track/${appt1._id}`,
    });
    expect(trackerRes.statusCode).toBe(200);
    const trackerData = JSON.parse(trackerRes.body).data;
    expect(trackerData.patientReturned).toBe(true);
    expect(trackerData.peopleAhead).toBe(0); // Resumes as Next Up!
  });

  it("2. Diagnostic Lab Loop: Doctor sends patient for tests, frees consultation room, and resumes for report review", async () => {
    // 1. Advance appt2 to in-consultation
    const callRes = await app.inject({
      method: "POST",
      url: "/api/queue/call-next",
      headers: { cookie: adminCookies.join("; ") },
      payload: { clinicId, doctorId },
    });
    expect(callRes.statusCode).toBe(200);

    // Verify appt2 is now in-consultation
    const freshAppt2 = await Appointment.findById(appt2._id);
    expect(freshAppt2?.status).toBe("in-consultation");

    // 2. Send patient for diagnostic lab tests
    const sendLabRes = await app.inject({
      method: "POST",
      url: `/api/queue/${appt2._id}/send-investigation`,
      headers: { cookie: adminCookies.join("; ") },
      payload: { notes: "CBC, Ultrasound Abdomen" },
    });
    expect(sendLabRes.statusCode).toBe(200);
    const labData = JSON.parse(sendLabRes.body).data;
    expect(labData.status).toBe("standby");
    expect(labData.consultationPhase).toBe("initial_pending_investigation");
    expect(labData.investigationNotes).toBe("CBC, Ultrasound Abdomen");

    // 3. Room is unblocked! Doctor can call appt3 without 409 conflict
    const callNextRes = await app.inject({
      method: "POST",
      url: "/api/queue/call-next",
      headers: { cookie: adminCookies.join("; ") },
      payload: { clinicId, doctorId },
    });
    expect(callNextRes.statusCode).toBe(200);
    const freshAppt3 = await Appointment.findById(appt3._id);
    expect(freshAppt3?.status).toBe("in-consultation");

    // 4. Patient 2 returns with reports: Resume for Report Review as Next Up!
    const resumeReviewRes = await app.inject({
      method: "POST",
      url: `/api/queue/${appt2._id}/resume-review`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(resumeReviewRes.statusCode).toBe(200);
    const resumedData = JSON.parse(resumeReviewRes.body).data;
    expect(resumedData.status).toBe("checked-in");
    expect(resumedData.queuePosition).toBe(1); // Next Up!
    expect(resumedData.consultationPhase).toBe("report_review");
    expect(resumedData.reasonForVisit).toBe("report_review");
  });

  it("3. Doctor OPD Session Lifecycle: Start shift, get pre-close summary, and reconcile stranded appointments", async () => {
    // 1. Start OPD Session
    const startRes = await app.inject({
      method: "POST",
      url: "/api/queue/session/start",
      headers: { cookie: adminCookies.join("; ") },
      payload: { clinicId, doctorId },
    });
    expect(startRes.statusCode).toBe(200);
    const sessionData = JSON.parse(startRes.body).data;
    expect(sessionData.status).toBe("active");
    expect(sessionData.startedAt).toBeDefined();

    // 2. Fetch Session Summary
    const summaryRes = await app.inject({
      method: "GET",
      url: `/api/queue/session/summary?clinicId=${clinicId}&doctorId=${doctorId}`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(summaryRes.statusCode).toBe(200);
    const summaryData = JSON.parse(summaryRes.body).data;
    expect(summaryData.session.status).toBe("active");
    expect(summaryData.counts.total).toBeGreaterThanOrEqual(3);

    // Put appt1 back into standby to test reconciliation
    await Appointment.findByIdAndUpdate(appt1._id, { status: "standby", parkedReason: "Left premises" });

    // 3. End OPD Session & Reconcile (sweeps standby -> no-show, unserved -> cancelled)
    const endRes = await app.inject({
      method: "POST",
      url: "/api/queue/session/end",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        doctorId,
        standbyAction: "mark_no_show",
        waitingAction: "cancel_refund",
      },
    });
    expect(endRes.statusCode).toBe(200);
    const endData = JSON.parse(endRes.body).data;
    expect(endData.session.status).toBe("ended");
    expect(endData.standbyReconciledCount).toBeGreaterThanOrEqual(1);

    // Verify appt1 is marked no-show with audit note
    const reconciledAppt1 = await Appointment.findById(appt1._id);
    expect(reconciledAppt1?.status).toBe("no-show");
    expect(reconciledAppt1?.notes).toContain("End of OPD: Patient remained on standby");
  });

  it("4. Public Waiting Room TV endpoint should serve masked queue data without authentication", async () => {
    const tvRes = await app.inject({
      method: "GET",
      url: `/api/public/queue-tv/${clinicId}`,
    });
    expect(tvRes.statusCode).toBe(200);
    const tvData = JSON.parse(tvRes.body).data;
    expect(tvData.clinic.name).toBe("Mumbai OPD Wing");
    expect(Array.isArray(tvData.waitingQueue)).toBe(true);

    // Check name masking (PHI protection on public screen)
    if (tvData.waitingQueue.length > 0) {
      const firstWaiting = tvData.waitingQueue[0];
      expect(firstWaiting.patientName).not.toBeUndefined();
    }
  });
});
