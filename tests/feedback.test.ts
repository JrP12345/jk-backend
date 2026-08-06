import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { PatientFeedback } from "../models/PatientFeedback.ts";
import { Appointment } from "../models/Appointment.ts";

describe("Patient Experience (PEC) & NPS Feedback Integration Tests", () => {
  let adminCookies: string[] = [];
  let clinicId: string;
  let patientId: string;
  let doctorUserId: string;
  let appointmentId: string;

  beforeAll(async () => {
    // 1. Create Organization & Admin
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Apollo Patient Care Systems",
        city: "Hyderabad",
        admin_name: "PEC Quality Admin",
        admin_email: `pec_admin_${Date.now()}@apollo.internal`,
        admin_password: "Password123",
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
        name: "Apollo Specialty OPD Center",
        city: "Hyderabad",
        address: "10 Jubilee Hills",
        phone: "9800044400",
        email: "pec@apollo.internal",
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
        name: "Anish Feedback Patient",
        email: `anish_pec_${Date.now()}@patient.com`,
        phone: "9876541100",
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
        name: "Dr. Ramesh Rao",
        email: `dr.ramesh_${Date.now()}@hospital.com`,
        specialization: "Cardiology",
        phone: "9123477889",
        role: "doctor",
        password: "Password123",
      },
    });
    expect(docRes.statusCode).toBe(201);
    doctorUserId = JSON.parse(docRes.body).data.id;

    // 4b. Assign Doctor to Clinic
    const assignRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctors/assignments",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        doctorId: doctorUserId,
        clinicId,
        workingHours: "09:00 - 17:00",
        fees: 500,
        appointmentDuration: 15,
      },
    });
    expect(assignRes.statusCode).toBe(201);

    // 5. Create Appointment
    const apptRes = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        patientId,
        doctorId: doctorUserId,
        appointmentTime: new Date(Date.now() + 86400000).toISOString(),
        appointmentType: "walk-in",
        notes: "Cardiology Routine Checkup",
      },
    });
    expect(apptRes.statusCode).toBe(201);
    appointmentId = JSON.parse(apptRes.body).data.id || JSON.parse(apptRes.body).data._id;
  });

  it("should submit a patient experience feedback survey via POST /api/feedback", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        appointmentId,
        rating: 5,
        npsScore: 10,
        comments: "Outstanding experience! Dr. Ramesh took time to answer all my cardiology questions.",
        aspectRatings: {
          waitTime: 5,
          doctorAttitude: 5,
          cleanliness: 4,
        },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.rating).toBe(5);
    expect(body.data.npsScore).toBe(10);
  });

  it("should reject duplicate feedback submission for the same appointment", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        appointmentId,
        rating: 4,
        npsScore: 8,
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain("already submitted");
  });

  it("should retrieve Net Promoter Score (NPS) and CSAT statistics via GET /api/feedback/stats", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/feedback/stats?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.totalResponses).toBeGreaterThanOrEqual(1);
    expect(body.data.averageCsatRating).toBeDefined();
    expect(body.data.netPromoterScore).toBeGreaterThanOrEqual(0);
    expect(body.data.npsCategory).toBeDefined();
  });
});
