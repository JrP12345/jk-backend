import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { TeleconsultationSession } from "../models/TeleconsultationSession.ts";

describe("Teleconsultation & Virtual Care Integration Tests", () => {
  let adminCookies: string[] = [];
  let clinicId: string;
  let patientId: string;
  let doctorUserId: string;
  let appointmentId: string;
  let sessionId: string;

  beforeAll(async () => {
    process.env.TELECONSULTATION_BASE_URL = "https://telehealth.test";
    // 1. Create Organization & Admin
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Telehealth HealthOS Systems",
        city: "Bengaluru",
        admin_name: "Telehealth Admin",
        admin_email: `tele_admin_${Date.now()}@healthos.internal`,
        admin_password: "Password123",
        plan: "enterprise",
      },
    });
    expect(orgRes.statusCode).toBe(201);
    adminCookies = orgRes.headers["set-cookie"] as string[];

    // 2. Create Clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Virtual Teleconsultation Care Desk",
        city: "Bengaluru",
        address: "100 Cloud Health Way",
        phone: "9400033300",
        email: "virtual-care@healthos.internal",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Register Patient
    const patientRes = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Remote Patient Sneha",
        email: `sneha_tele_${Date.now()}@patient.com`,
        phone: "9876500998",
        password: "Password123",
        role: "patient",
      },
    });
    expect(patientRes.statusCode).toBe(201);
    const patientUserId = JSON.parse(patientRes.body).data.user.id;
    const { Patient: PatientModel } = await import("../models/Patient.ts");
    const patientDoc = await PatientModel.findOne({ userId: patientUserId });
    patientId = patientDoc!._id.toString();

    // 4. Register Doctor
    const docRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/staff",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Meera Iyer",
        email: `dr.meera_${Date.now()}@hospital.com`,
        specialization: "Tele-Dermatology",
        phone: "9112233440",
        role: "doctor",
        password: "Password123",
      },
    });
    expect(docRes.statusCode).toBe(201);
    doctorUserId = JSON.parse(docRes.body).data.id;

    // Assign Doctor to Clinic
    const assignRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctors/assignments",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        doctorId: doctorUserId,
        clinicId,
        workingHours: "00:00 - 23:59",
        fees: 500,
      },
    });
    expect(assignRes.statusCode).toBe(201);

    // 5. Create Virtual Appointment
    const apptRes = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        patientId,
        doctorId: doctorUserId,
        appointmentTime: new Date().toISOString(),
        appointmentType: "online",
        status: "confirmed",
        forceBooking: true,
        notes: "Virtual skin consultation",
      },
    });
    expect(apptRes.statusCode).toBe(201);
    appointmentId = JSON.parse(apptRes.body).data.id;
  });

  it("should create a new teleconsultation video room session via POST /api/teleconsultation/session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/teleconsultation/session",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        appointmentId,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.sessionRoomId).toMatch(/^TELE-\d+-\d+$/);
    expect(body.data.meetingUrl).toContain("https://telehealth.test/");
    expect(body.data.status).toBe("scheduled");
    sessionId = body.data._id || body.data.id;
  });

  it("should retrieve teleconsultation session details via GET /api/teleconsultation/session/:appointmentId", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/teleconsultation/session/${appointmentId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.sessionRoomId).toBeDefined();
  });

  it("should start session via PUT /api/teleconsultation/session/:id/start", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/teleconsultation/session/${sessionId}/start`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("active");
    expect(body.data.startedAt).toBeDefined();
  });

  it("should update clinical notes and vitals via PUT /api/teleconsultation/session/:id/notes", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/teleconsultation/session/${sessionId}/notes`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicalNotes: "Patient reports skin rash improved. Continue topical application.",
        vitalsRecorded: { bp: "120/80", pulse: "72", temp: "98.6", spo2: "99" },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.clinicalNotes).toContain("skin rash");
    expect(body.data.vitalsRecorded.bp).toBe("120/80");
  });

  it("should end teleconsultation session and calculate duration via PUT /api/teleconsultation/session/:id/end", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/teleconsultation/session/${sessionId}/end`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("ended");
    expect(body.data.durationMinutes).toBeGreaterThanOrEqual(1);
    expect(body.data.endedAt).toBeDefined();
  });
});
