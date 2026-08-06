import { describe, it, expect } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Clinic } from "../models/Clinic.ts";
import { Doctor } from "../models/Doctor.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Appointment } from "../models/Appointment.ts";

describe("Appointments & Queue API Integration Tests", () => {
  let adminCookies: string[] = [];
  let patientCookies: string[] = [];
  let clinicId: string;
  let doctorId: string; // Doctor profile ID (from Doctor schema, not User ID)
  let doctorUserId: string;
  let patientId: string; // Patient profile ID
  let appointmentId: string;
  let tomorrowDateStr: string;

  it("should setup organization, clinic, doctor, and patient", async () => {
    // 1. Create org + admin
    const bootstrapRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Apollo Hospitals",
        city: "Surat",
        admin_name: "Amit Mehta",
        admin_email: "amitadmin@test.com",
        admin_password: "Password123",
      },
    });
    adminCookies = bootstrapRes.headers["set-cookie"] as string[];

    // 2. Create clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Apollo Clinic Branch",
        city: "Surat",
      },
    });
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Add Doctor
    const docRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Sandeep Shah",
        email: "sandeep@test.com",
        password: "Password123",
        specialization: "General Physician",
      },
    });
    doctorUserId = JSON.parse(docRes.body).data.id;
    const docProfile = await Doctor.findOne({ userId: doctorUserId });
    doctorId = docProfile!._id.toString();

    // 4. Assign Doctor to Clinic Branch
    const assignRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctors/assignments",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        doctorId: doctorUserId,
        clinicId: clinicId,
        fees: 350,
        appointmentDuration: 15,
        workingHours: JSON.stringify([{ start: "10:00", end: "12:00" }]),
      },
    });
    expect(assignRes.statusCode).toBe(201);

    // 5. Register patient
    const patRes = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Vijay Verma",
        email: "vijay@test.com",
        password: "Password123",
      },
    });
    patientCookies = patRes.headers["set-cookie"] as string[];
    const patUser = await User.findOne({ email: "vijay@test.com" });
    const patProfile = await Patient.findOne({ userId: patUser!._id });
    patientId = patProfile!._id.toString();
  });

  it("should allow patient to book appointment online", async () => {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + 1); // tomorrow
    targetDate.setHours(10, 30, 0, 0);
    tomorrowDateStr = targetDate.toISOString().split("T")[0];

    const response = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: patientCookies.join("; ") },
      payload: {
        clinicId: clinicId,
        doctorId: doctorUserId, // Controller routes expect user ID of doctor
        appointmentTime: targetDate.toISOString(),
        appointmentType: "online",
        notes: "Regular health checkup",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("pending"); // Patient-booked appointments start as pending
    expect(body.data.tokenNumber).toBe(1);
    appointmentId = body.data.id;
  });

  it("should allow staff to book walkthrough walk-in appointment directly", async () => {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + 1); // tomorrow
    targetDate.setHours(10, 45, 0, 0);

    const response = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId: clinicId,
        doctorId: doctorUserId,
        appointmentTime: targetDate.toISOString(),
        appointmentType: "walk-in",
        patientDetails: {
          name: "Suresh Gopi",
          dob: "1980-05-15",
          gender: "male",
          phone: "9988776655",
          email: "suresh.gopi@example.com",
          password: "Password123",
        },
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("confirmed"); // Admin/staff-booked appointments start as confirmed
    expect(body.data.tokenNumber).toBe(2);
  });

  it("should fetch queue list and support reordering overrides", async () => {
    // 1. Get queue for tomorrow
    const queueRes = await app.inject({
      method: "GET",
      url: `/api/queue?clinicId=${clinicId}&doctorId=${doctorUserId}&date=${tomorrowDateStr}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(queueRes.statusCode).toBe(200);
    const qBody = JSON.parse(queueRes.body);
    expect(qBody.success).toBe(true);
    expect(qBody.data.length).toBeGreaterThanOrEqual(2);

    const firstApptId = qBody.data[0].id;
    const secondApptId = qBody.data[1].id;

    // 2. Override reorder queue (swap first and second)
    const reorderRes = await app.inject({
      method: "PUT",
      url: "/api/queue/reorder",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId: clinicId,
        doctorId: doctorUserId,
        date: tomorrowDateStr,
        orderedAppointmentIds: [secondApptId, firstApptId],
      },
    });

    expect(reorderRes.statusCode).toBe(200);
    
    // Check if new queue is stored in DB
    const firstObj = await Appointment.findById(appointmentId);
    expect(firstObj!.queuePosition).toBe(2);
  });

  it("should update patient profile via PATCH /api/patients/:id", async () => {
    const updateRes = await app.inject({
      method: "PATCH",
      url: `/api/patients/${patientId}`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        bloodGroup: "O+",
        allergies: ["Penicillin", "Sulfa"],
        conditions: ["Hypertension"],
        address: "123 Healthcare Blvd, Surat",
      },
    });

    expect(updateRes.statusCode).toBe(200);
    const body = JSON.parse(updateRes.body);
    expect(body.success).toBe(true);
    expect(body.data.bloodGroup).toBe("O+");
    expect(body.data.allergies).toContain("Penicillin");
    expect(body.data.conditions).toContain("Hypertension");
  });
});
