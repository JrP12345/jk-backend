import { describe, it, expect } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Appointment } from "../models/Appointment.ts";
import { DoctorDayOverride } from "../models/DoctorDayOverride.ts";

describe("Public Live Queue Tracker & Quick Walk-In Tests", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let doctorUserId: string;
  let appointmentId: string;
  let tokenNum: number;

  it("should setup clinic and doctor with sequential queue mode", async () => {
    // 1. Setup Org & Admin
    const bootstrapRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Tracker Health System ${Date.now()}`,
        city: "Bengaluru",
        admin_name: "Admin Officer",
        admin_email: `admin_tracker_${Date.now()}@tracker.com`,
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
      payload: { name: "Tracker Main Clinic", city: "Bengaluru", address: "100 Feet Road, Indiranagar" },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Setup Doctor
    const docRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Vikram Seth",
        email: `vikram_${Date.now()}@tracker.com`,
        password: "Password123",
        specialization: "Pediatrics",
      },
    });
    expect(docRes.statusCode).toBe(201);
    doctorUserId = JSON.parse(docRes.body).data.id;

    // 4. Assign Doctor with full week working hours
    await DoctorAssignment.create({
      doctorId: doctorUserId,
      clinicId,
      organizationId: orgId,
      fees: 500,
      appointmentDuration: 15,
      bookingMode: "sequential_queue",
      isActive: true,
      workingHours: JSON.stringify({ all: { start: "08:00", end: "23:59" } }),
    });
  });

  it("should create an appointment and retrieve public tracking data without authentication", async () => {
    // Book appointment via staff
    const apptRes = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        doctorId: doctorUserId,
        appointmentTime: new Date().toISOString(),
        appointmentType: "online",
        patientDetails: {
          name: "Sanya Gupta",
          phone: "9876543210",
          gender: "female",
          dob: "1995-05-15",
        },
        notes: "Routine checkup",
      },
    });
    expect(apptRes.statusCode).toBe(201);
    const body = JSON.parse(apptRes.body).data;
    appointmentId = body.id;
    tokenNum = body.tokenNumber;
    expect(tokenNum).toBeGreaterThan(0);

    // Call public tracker GET /api/public/track/:appointmentId without cookies
    const trackRes = await app.inject({
      method: "GET",
      url: `/api/public/track/${appointmentId}`,
    });

    expect(trackRes.statusCode).toBe(200);
    const trackData = JSON.parse(trackRes.body).data;

    expect(trackData.appointmentId).toBe(appointmentId);
    expect(trackData.tokenNumber).toBe(tokenNum);
    expect(trackData.patientName).toBe("Sanya Gupta");
    expect(trackData.doctor.name).toBe("Dr. Vikram Seth");
    expect(trackData.doctor.specialization).toBe("Pediatrics");
    expect(trackData.clinic.name).toBe("Tracker Main Clinic");
    expect(trackData.status).toBe("confirmed");
    expect(trackData.isToday).toBe(true);
    expect(trackData.doctorAvailability.isAvailable).toBe(true);
    expect(typeof trackData.estimatedWaitMinutes).toBe("number");
  });

  it("requires a short-lived check-in capability and rejects replay", async () => {
    const missingCapability = await app.inject({
      method: "POST",
      url: `/api/public/track/${appointmentId}/check-in`,
    });
    expect(missingCapability.statusCode).toBe(401);

    const capabilityRes = await app.inject({
      method: "POST",
      url: `/api/public/track/${appointmentId}/check-in-capability`,
    });
    expect(capabilityRes.statusCode).toBe(200);
    const checkInToken = JSON.parse(capabilityRes.body).data.checkInToken;

    // 1. The capability can transition only its issued appointment.
    const checkInRes = await app.inject({
      method: "POST",
      url: `/api/public/track/${appointmentId}/check-in`,
      payload: { checkInToken },
    });
    expect(checkInRes.statusCode).toBe(200);
    const checkInData = JSON.parse(checkInRes.body).data;
    expect(checkInData.status).toBe("checked-in");
    expect(checkInData.alreadyCheckedIn).toBe(false);

    // 2. A consumed capability cannot be replayed.
    const dupRes = await app.inject({
      method: "POST",
      url: `/api/public/track/${appointmentId}/check-in`,
      payload: { checkInToken },
    });
    expect(dupRes.statusCode).toBe(401);

    // 3. Verify public tracker now reflects checked-in status
    const trackRes = await app.inject({
      method: "GET",
      url: `/api/public/track/${appointmentId}`,
    });
    expect(trackRes.statusCode).toBe(200);
    expect(JSON.parse(trackRes.body).data.status).toBe("checked-in");
  });

  it("should block check-in if doctor has an active unavailable day override", async () => {
    // Create second appointment for testing doctor away
    const appt2Res = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        doctorId: doctorUserId,
        appointmentTime: new Date().toISOString(),
        appointmentType: "online",
        patientDetails: {
          name: "Rohan Varma",
          phone: "9123456780",
          gender: "male",
          dob: "1992-01-01",
        },
      },
    });
    const appt2Id = JSON.parse(appt2Res.body).data.id;

    // Set doctor unavailable day override
    const todayStr = new Date().toISOString().slice(0, 10);
    await DoctorDayOverride.create({
      doctorId: doctorUserId,
      clinicId,
      organizationId: orgId,
      date: todayStr,
      status: "unavailable",
      reason: "Emergency O.T. Duty",
    });

    // Tracking should report doctor availability status: unavailable
    const trackRes = await app.inject({
      method: "GET",
      url: `/api/public/track/${appt2Id}`,
    });
    expect(trackRes.statusCode).toBe(200);
    const trackData = JSON.parse(trackRes.body).data;
    expect(trackData.doctorAvailability.isAvailable).toBe(false);
    expect(trackData.doctorAvailability.reason).toBe("Emergency O.T. Duty");

    const capabilityRes = await app.inject({
      method: "POST",
      url: `/api/public/track/${appt2Id}/check-in-capability`,
    });
    expect(capabilityRes.statusCode).toBe(200);

    // Self check-in should be rejected with clear message even with a valid capability.
    const checkInRes = await app.inject({
      method: "POST",
      url: `/api/public/track/${appt2Id}/check-in`,
      payload: { checkInToken: JSON.parse(capabilityRes.body).data.checkInToken },
    });
    expect(checkInRes.statusCode).toBe(400);
    expect(JSON.parse(checkInRes.body).message).toContain("Doctor is currently unavailable today");

    // Clean up override
    await DoctorDayOverride.deleteMany({ doctorId: doctorUserId, clinicId });
  });

  it("should register a Quick Walk-In with emergency priority and atomic token", async () => {
    const walkInRes = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        doctorId: doctorUserId,
        appointmentTime: new Date().toISOString(),
        appointmentType: "walk-in",
        patientDetails: {
          name: "Deepak Chawla",
          phone: "9898989898",
          gender: "male",
          dob: "2000-01-01",
        },
        forceBooking: true,
        notes: "[EMERGENCY WALK-IN] Priority Triage - Acute chest pain",
      },
    });

    expect(walkInRes.statusCode).toBe(201);
    const walkInBody = JSON.parse(walkInRes.body).data;
    expect(walkInBody.appointmentType).toBe("walk-in");
    expect(walkInBody.tokenNumber).toBeGreaterThan(tokenNum);
    expect(walkInBody.notes).toContain("[EMERGENCY WALK-IN]");

    // Immediate check-in update as done by front-desk
    const checkInRes = await app.inject({
      method: "PUT",
      url: `/api/appointments/${walkInBody.id}/status`,
      headers: { cookie: adminCookies.join("; ") },
      payload: { status: "checked-in" },
    });
    expect(checkInRes.statusCode).toBe(200);

    // Verify it immediately appears in live queue
    const queueRes = await app.inject({
      method: "GET",
      url: `/api/queue?clinicId=${clinicId}&doctorId=${doctorUserId}`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(queueRes.statusCode).toBe(200);
    const queueList = JSON.parse(queueRes.body).data;
    const walkInEntry = queueList.find((a: any) => a._id === walkInBody.id || a.id === walkInBody.id);
    expect(walkInEntry).toBeDefined();
    expect(walkInEntry.status).toBe("checked-in");
  });

  it("should complete consultation, create clinical notes/prescriptions/invoice, and return post-consultation handoff on public tracker", async () => {
    const { Encounter } = await import("../models/Encounter.ts");
    const { ClinicalNote } = await import("../models/ClinicalNote.ts");
    const { Prescription } = await import("../models/Prescription.ts");
    const { Invoice } = await import("../models/Invoice.ts");

    // 1. Mark appointment completed
    const completeRes = await app.inject({
      method: "PUT",
      url: `/api/appointments/${appointmentId}/status`,
      headers: { cookie: adminCookies.join("; ") },
      payload: { status: "completed" },
    });
    expect(completeRes.statusCode).toBe(200);

    const apptDoc = await Appointment.findById(appointmentId);
    expect(apptDoc?.status).toBe("completed");

    // 2. Create linked Encounter
    const encounter = await Encounter.create({
      organizationId: orgId,
      clinicId,
      appointmentId,
      patientId: apptDoc?.patientId,
      doctorId: doctorUserId,
      encounterType: "opd",
      status: "completed",
      startedAt: new Date(Date.now() - 20 * 60 * 1000),
      endedAt: new Date(),
    });

    // 3. Create Prescriptions
    const rx1 = await Prescription.create({
      organizationId: orgId,
      clinicId,
      encounterId: encounter._id,
      patientId: apptDoc?.patientId,
      doctorId: doctorUserId,
      medicineName: "Amoxicillin 500mg",
      dosage: "500mg",
      frequency: "1-0-1",
      duration: "5 days",
      instructions: "Take after meals with water",
      status: "active",
    });

    const rx2 = await Prescription.create({
      organizationId: orgId,
      clinicId,
      encounterId: encounter._id,
      patientId: apptDoc?.patientId,
      doctorId: doctorUserId,
      medicineName: "Paracetamol 650mg",
      dosage: "650mg",
      frequency: "SOS",
      duration: "3 days",
      instructions: "If fever exceeds 100F",
      status: "active",
    });

    // 4. Create Clinical Note
    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);

    await ClinicalNote.create({
      organizationId: orgId,
      clinicId,
      encounterId: encounter._id,
      patientId: apptDoc?.patientId,
      doctorId: doctorUserId,
      subjective: {
        chiefComplaint: "Acute viral fever with sore throat",
      },
      assessment: {
        diagnoses: [
          { code: "J06.9", codingSystem: "ICD-10", description: "Acute upper respiratory infection", status: "active" },
        ],
        severity: "moderate",
      },
      plan: {
        treatmentPlan: "Complete full antibiotic course. Adequate warm fluid intake and throat lozenges as needed.",
        prescriptionIds: [rx1._id, rx2._id],
        followUpDate: nextWeek,
        followUpInstructions: "Return if fever persists beyond 48 hours",
      },
      status: "signed",
      signature: {
        signerName: "Dr. Vikram Seth",
        signedAt: new Date(),
      },
    });

    // 5. Create Linked Invoice
    await Invoice.create({
      invoiceNumber: `INV-TEST-${Date.now()}`,
      organizationId: orgId,
      clinicId,
      patientId: apptDoc?.patientId,
      appointmentId,
      encounterId: encounter._id,
      doctorId: doctorUserId,
      items: [
        { description: "General Consultation Fee", amount: 500, quantity: 1 },
        { description: "Amoxicillin 500mg (10 strips)", amount: 150, quantity: 1 },
      ],
      subtotal: 650,
      tax: 0,
      discount: 0,
      totalAmount: 650,
      amountPaid: 0,
      balanceDue: 650,
      status: "unpaid",
    });

    // 6. Test GET /api/public/track/:appointmentId
    const trackerRes = await app.inject({
      method: "GET",
      url: `/api/public/track/${appointmentId}`,
    });
    expect(trackerRes.statusCode).toBe(200);

    const trackerBody = JSON.parse(trackerRes.body).data;
    expect(trackerBody.status).toBe("completed");
    expect(trackerBody.tokenNumber).toBe(tokenNum);

    // Verify consultationSummary
    expect(trackerBody.consultationSummary).toBeDefined();
    expect(trackerBody.consultationSummary.diagnoses.length).toBe(1);
    expect(trackerBody.consultationSummary.diagnoses[0].code).toBe("J06.9");
    expect(trackerBody.consultationSummary.doctorAdvice).toContain("antibiotic course");
    expect(trackerBody.consultationSummary.followUp).toBeDefined();
    expect(trackerBody.consultationSummary.prescriptions.length).toBe(2);
    expect(trackerBody.consultationSummary.prescriptions[0].medicineName).toBe("Amoxicillin 500mg");
    expect(trackerBody.consultationSummary.prescriptions[0].dosage).toBe("500mg");
    expect(trackerBody.consultationSummary.prescriptions[0].frequency).toBe("1-0-1");

    // Verify billing
    expect(trackerBody.billing).toBeDefined();
    expect(trackerBody.billing.totalAmount).toBe(650);
    expect(trackerBody.billing.balanceDue).toBe(650);
    expect(trackerBody.billing.status).toBe("unpaid");
    expect(trackerBody.billing.items.length).toBe(2);
  });

  it("should generate printable prescription HTML via public print endpoint", async () => {
    const printRes = await app.inject({
      method: "GET",
      url: `/api/public/track/${appointmentId}/prescription/print`,
    });
    expect(printRes.statusCode).toBe(200);
    expect(printRes.headers["content-type"]).toContain("text/html");
    const html = printRes.body;
    expect(html).toContain("Tracker Main Clinic");
    expect(html).toContain("Dr. Vikram Seth");
    expect(html).toContain("Sanya Gupta");
    expect(html).toContain("Amoxicillin 500mg");
    expect(html).toContain("Paracetamol 650mg");
    expect(html).toContain("Acute upper respiratory infection");
    expect(html).toContain("Doctor's Advice & Treatment Plan:");
  });

  it("should process patient bill settlement via public pay endpoint", async () => {
    const payRes = await app.inject({
      method: "POST",
      url: `/api/public/track/${appointmentId}/pay`,
      payload: { paymentMethod: "upi" },
    });
    expect(payRes.statusCode).toBe(200);
    const payBody = JSON.parse(payRes.body).data;
    expect(payBody.status).toBe("paid");
    expect(payBody.balanceDue).toBe(0);

    // Verify public tracker immediately reflects paid status
    const verifiedTracker = await app.inject({
      method: "GET",
      url: `/api/public/track/${appointmentId}`,
    });
    expect(verifiedTracker.statusCode).toBe(200);
    const verifiedBody = JSON.parse(verifiedTracker.body).data;
    expect(verifiedBody.billing.status).toBe("paid");
    expect(verifiedBody.billing.balanceDue).toBe(0);
    expect(verifiedBody.paymentStatus).toBe("paid");
  });
});
