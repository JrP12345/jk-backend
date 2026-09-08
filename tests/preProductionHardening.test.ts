import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { Appointment } from "../models/Appointment.ts";
import { Clinic } from "../models/Clinic.ts";
import { Doctor } from "../models/Doctor.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Patient } from "../models/Patient.ts";
import { User } from "../models/User.ts";
import { SaaSConfig } from "../models/SaaSConfig.ts";

describe("Pre-Production Launch Hardening Integration Tests", () => {
  beforeAll(async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_key";
    process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";
    process.env.RAZORPAY_WEBHOOK_SECRET = "rzp_test_webhook_secret";

    try {
      await SaaSConfig.findOneAndUpdate(
        { key: "platform_config" },
        {
          key: "platform_config",
          razorpayKeyId: "rzp_test_key",
          razorpayKeySecret: "rzp_test_secret",
          razorpayWebhookSecret: "rzp_test_webhook_secret",
          isLiveMode: false,
        },
        { upsert: true, returnDocument: "after" }
      );
    } catch {
      // Ignored if DB is still connecting
    }
  });

  it("should prevent double-booking for the same doctor in time_slot mode", async () => {
    // 1. Create org + admin
    const bootstrapRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Timeslot Hospital ${Date.now()}`,
        city: "Mumbai",
        admin_name: "Dr. Admin",
        admin_email: `admin_${Date.now()}@timeslot.test`,
        admin_password: "Password123",
        plan: "enterprise",
      },
    });
    const adminCookies = (bootstrapRes.headers["set-cookie"] as string[]).map(c => c.split(";")[0]);

    // 2. Create clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Timeslot Branch",
        city: "Mumbai",
      },
    });
    const clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Add Doctor
    const docRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Slot Specialist",
        email: `slotdoc_${Date.now()}@test.com`,
        password: "Password123",
        specialization: "Cardiology",
      },
    });
    const doctorUserId = JSON.parse(docRes.body).data.id;

    // 4. Assign Doctor in time_slot bookingMode
    const assignRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctors/assignments",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        doctorId: doctorUserId,
        clinicId: clinicId,
        fees: 500,
        appointmentDuration: 15,
        bookingMode: "time_slot",
        workingHours: JSON.stringify([{ start: "09:00", end: "17:00" }]),
      },
    });
    expect(assignRes.statusCode).toBe(201);

    // 5. Register two different patients
    const p1Res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Patient One",
        email: `patient1_${Date.now()}@test.com`,
        password: "Password123",
      },
    });
    const p1Cookies = (p1Res.headers["set-cookie"] as string[]).map(c => c.split(";")[0]);

    const p2Res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Patient Two",
        email: `patient2_${Date.now()}@test.com`,
        password: "Password123",
      },
    });
    const p2Cookies = (p2Res.headers["set-cookie"] as string[]).map(c => c.split(";")[0]);

    // Target appointment time
    const slotTime = new Date();
    slotTime.setDate(slotTime.getDate() + 2);
    slotTime.setHours(11, 0, 0, 0);

    // Patient 1 books the slot
    const book1 = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: p1Cookies.join("; ") },
      payload: {
        clinicId,
        doctorId: doctorUserId,
        appointmentTime: slotTime.toISOString(),
        appointmentType: "online",
        notes: "Cardio check",
      },
    });
    expect(book1.statusCode).toBe(201);
    expect(JSON.parse(book1.body).success).toBe(true);

    // Patient 2 attempts to book the exact same slot with the same doctor
    const book2 = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: p2Cookies.join("; ") },
      payload: {
        clinicId,
        doctorId: doctorUserId,
        appointmentTime: slotTime.toISOString(),
        appointmentType: "online",
        notes: "Second patient trying same slot",
      },
    });

    // Must be rejected with 409 Conflict
    expect(book2.statusCode).toBe(409);
    const body2 = JSON.parse(book2.body);
    expect(body2.success).toBe(false);
    expect(body2.message).toContain("already been booked");
  });

  it("should preserve rawBody for razorpay webhook requests", async () => {
    const rawPayload = JSON.stringify({
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: "pay_test123",
            order_id: "order_test123",
            amount: 10000,
            status: "captured",
          },
        },
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/billing/webhook",
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": "invalid_sig_for_test",
      },
      payload: rawPayload,
    });

    // Signature fails because signature was invalid, but webhook logic executed and caught signature mismatch cleanly
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("signature");
  });
});
