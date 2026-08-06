import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { SurgicalBooking } from "../models/SurgicalBooking.ts";

describe("Operation Theatre (OT) & Surgical Case Integration Tests", () => {
  let adminCookies: string[] = [];
  let clinicId: string;
  let patientId: string;
  let surgeonUserId: string;
  let anesthesiologistUserId: string;

  beforeAll(async () => {
    // 1. Create Organization & Admin
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Metropolitan Surgical Hospital",
        city: "Bengaluru",
        admin_name: "Surgical Admin",
        admin_email: `ot_admin_${Date.now()}@surgical.internal`,
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
        name: "Main Operation Theatre Complex",
        city: "Bengaluru",
        address: "500 Surgical Specialty Way",
        phone: "9800077700",
        email: "ot-desk@surgical.internal",
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
        name: "Surgical Patient Suresh",
        email: `suresh_ot_${Date.now()}@patient.com`,
        phone: "9876543210",
        password: "Password123",
        role: "patient",
      },
    });
    expect(patientRes.statusCode).toBe(201);
    const patientUserId = JSON.parse(patientRes.body).data.user.id;
    const { Patient: PatientModel } = await import("../models/Patient.ts");
    const patientDoc = await PatientModel.findOne({ userId: patientUserId });
    patientId = patientDoc!._id.toString();

    // 4. Register Lead Surgeon & Anesthesiologist
    const doc1Res = await app.inject({
      method: "POST",
      url: "/api/onboarding/staff",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Rajesh Varma",
        email: `dr.rajesh_${Date.now()}@hospital.com`,
        specialization: "Orthopedic Surgery",
        phone: "9988776655",
        role: "doctor",
        password: "Password123",
      },
    });
    expect(doc1Res.statusCode).toBe(201);
    surgeonUserId = JSON.parse(doc1Res.body).data.id;

    const doc2Res = await app.inject({
      method: "POST",
      url: "/api/onboarding/staff",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Ananya Sen",
        email: `dr.ananya_${Date.now()}@hospital.com`,
        specialization: "Anesthesiology",
        phone: "9988776644",
        role: "doctor",
        password: "Password123",
      },
    });
    expect(doc2Res.statusCode).toBe(201);
    anesthesiologistUserId = JSON.parse(doc2Res.body).data.id;
  });

  it("should book a new surgical case in OT via POST /api/ot/bookings", async () => {
    const startTime = new Date(Date.now() + 86400000).toISOString(); // Tomorrow
    const endTime = new Date(Date.now() + 86400000 + 10800000).toISOString(); // +3 hours

    const res = await app.inject({
      method: "POST",
      url: "/api/ot/bookings",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        patientId,
        theatreName: "OT Room 1 — Orthopedics",
        procedureName: "Total Knee Replacement Right",
        leadSurgeonId: surgeonUserId,
        anesthesiologistId: anesthesiologistUserId,
        scrubNurseName: "Sister Mary",
        scheduledStartTime: startTime,
        scheduledEndTime: endTime,
        notes: "Pre-op antibiotic prophylaxis required.",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.theatreName).toBe("OT Room 1 — Orthopedics");
    expect(body.data.procedureName).toBe("Total Knee Replacement Right");
    expect(body.data.status).toBe("scheduled");
  });

  it("should retrieve list of OT surgical bookings via GET /api/ot/bookings", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/ot/bookings?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].procedureName).toContain("Total Knee Replacement");
  });

  it("should update surgical booking status and WHO safety checklist completion via PUT /api/ot/bookings/:id/status", async () => {
    const listRes = await app.inject({
      method: "GET",
      url: `/api/ot/bookings?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });
    const bookingItem = JSON.parse(listRes.body).data[0];
    const bookingId = bookingItem._id || bookingItem.id;

    const updateRes = await app.inject({
      method: "PUT",
      url: `/api/ot/bookings/${bookingId}/status`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        status: "in_progress",
        safetyChecklistComplete: true,
      },
    });

    expect(updateRes.statusCode).toBe(200);
    const updated = JSON.parse(updateRes.body).data;
    expect(updated.status).toBe("in_progress");
    expect(updated.safetyChecklistComplete).toBe(true);
  });
});
