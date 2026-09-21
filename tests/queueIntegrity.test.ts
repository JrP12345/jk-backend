import { describe, it, expect, beforeAll } from "vitest";
import mongoose from "mongoose";
import { app } from "../index.js";
import { Organization } from "../models/Organization.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { Encounter } from "../models/Encounter.ts";
import { AuditLog } from "../models/AuditLog.ts";

describe("Queue State Integrity & Single-Consultation Guard Tests", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let doctorId: string;
  let patient1: any;
  let patient2: any;
  let appt1: any;
  let appt2: any;

  beforeAll(async () => {
    // 1. Setup Org, Clinic & Doctor
    const boot = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Integrity Hospital ${Date.now()}`,
        city: "Pune",
        admin_name: "Admin Integrity",
        admin_email: `integrity_${Date.now()}@hospital.com`,
        admin_password: "Password123",
        plan: "enterprise",
      },
    });
    expect(boot.statusCode).toBe(201);
    adminCookies = (boot.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);
    orgId = JSON.parse(boot.body).data.organization.id;

    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: { name: "Pune Central Clinic", city: "Pune" },
    });
    clinicId = JSON.parse(clinicRes.body).data.id;

    const docRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Vikram Joshi",
        email: `vikram_${Date.now()}@hospital.com`,
        password: "Password123",
        phone: "+919876543333",
        specialization: "General Physician",
      },
    });
    doctorId = JSON.parse(docRes.body).data.id;

    // 2. Setup 2 Waiting Patients
    patient1 = await Patient.create({
      organizationId: orgId,
      name: "Suresh Kumar",
      phone: "+919811111111",
      gender: "male",
    });

    patient2 = await Patient.create({
      organizationId: orgId,
      name: "Meena Sharma",
      phone: "+919822222222",
      gender: "female",
    });

    const now = new Date();

    appt1 = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId,
      patientId: patient1._id,
      appointmentTime: now,
      appointmentType: "online",
      status: "checked-in",
      tokenNumber: 1,
      queuePosition: 1,
    });

    appt2 = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId,
      patientId: patient2._id,
      appointmentTime: now,
      appointmentType: "online",
      status: "checked-in",
      tokenNumber: 2,
      queuePosition: 2,
    });
  });

  it("enforces one active consultation per doctor/day even when two different appointments transition concurrently", async () => {
    const raceDoctorId = new mongoose.Types.ObjectId();
    const now = new Date();
    const [raceAppointmentA, raceAppointmentB] = await Appointment.create([
      {
        organizationId: orgId,
        clinicId,
        doctorId: raceDoctorId,
        patientId: patient1._id,
        appointmentTime: now,
        appointmentType: "online",
        status: "checked-in",
        tokenNumber: 91,
      },
      {
        organizationId: orgId,
        clinicId,
        doctorId: raceDoctorId,
        patientId: patient2._id,
        appointmentTime: now,
        appointmentType: "online",
        status: "checked-in",
        tokenNumber: 92,
      },
    ]);

    // Production deploys create this index through the migration. Ensure the
    // isolated in-memory database has the same database constraint before the
    // concurrent write assertion.
    await Appointment.createIndexes();

    const results = await Promise.allSettled([
      Appointment.findOneAndUpdate(
        { _id: raceAppointmentA._id, status: "checked-in" },
        { $set: { status: "in-consultation" } },
        { returnDocument: "after" },
      ),
      Appointment.findOneAndUpdate(
        { _id: raceAppointmentB._id, status: "checked-in" },
        { $set: { status: "in-consultation" } },
        { returnDocument: "after" },
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const activeCount = await Appointment.countDocuments({
      doctorId: raceDoctorId,
      status: "in-consultation",
    });
    expect(activeCount).toBe(1);
  });

  it("Step 1: First call transitions Patient 1 to in-consultation and creates active Encounter", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/queue/call-next",
      headers: { cookie: adminCookies.join("; ") },
      payload: { clinicId, doctorId },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.id).toBe(appt1._id.toString());
    expect(body.data.status).toBe("in-consultation");
    expect(body.data.activeConsultationDoctorDayKey).toContain(`doctor:${doctorId}:day:`);

    const enc1 = await Encounter.findOne({ appointmentId: appt1._id });
    expect(enc1).toBeDefined();
    expect(enc1?.status).toBe("in_progress");
  });

  it("Step 2: Calling next while Patient 1 is in-consultation is BLOCKED with 409 Conflict", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/queue/call-next",
      headers: { cookie: adminCookies.join("; ") },
      payload: { clinicId, doctorId },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.message).toContain("Doctor already has an active consultation");

    // Verify Patient 2 is STILL checked-in and not corrupted
    const freshAppt2 = await Appointment.findById(appt2._id);
    expect(freshAppt2?.status).toBe("checked-in");
  });

  it("Step 3: Calling next with completePrevious: true auto-completes Patient 1 and safely calls Patient 2", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/queue/call-next",
      headers: { cookie: adminCookies.join("; ") },
      payload: { clinicId, doctorId, completePrevious: true },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.id).toBe(appt2._id.toString());
    expect(body.data.status).toBe("in-consultation");

    // Verify Patient 1 was cleanly completed
    const completedAppt1 = await Appointment.findById(appt1._id);
    expect(completedAppt1?.status).toBe("completed");
    expect(completedAppt1?.activeConsultationDoctorDayKey).toBeUndefined();

    const enc1 = await Encounter.findOne({ appointmentId: appt1._id });
    expect(enc1?.status).toBe("completed");

    // Verify audit record was created for the completion
    const audit = await AuditLog.findOne({
      action: "CONSULTATION_AUTO_COMPLETED_ON_NEXT",
      targetId: appt1._id,
    });
    expect(audit).toBeDefined();
  });
});
