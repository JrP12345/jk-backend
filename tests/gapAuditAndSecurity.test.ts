import { fixtureAccessToken } from "./helpers/sessionFixture.ts";
import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.ts";
import mongoose from "mongoose";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { FamilyRelationship } from "../models/FamilyRelationship.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";

let userAToken: string;
let userBToken: string;
let userAId: string;
let userBId: string;
let patientAId: string;
let patientBId: string;
let doctorId: string;
let locationId: string;
let orgId: string;

beforeAll(async () => {
  const org = await Organization.create({ name: "Patient access fixture", city: "Surat" });
  const location = await Location.create({ organizationId: org._id, name: "Patient access clinic", city: "Surat" });
  const doctor = await User.create({ name: "Patient access doctor", role: "doctor" });
  orgId = org.id;
  locationId = location.id;
  doctorId = doctor.id;
  await DoctorAssignment.create({ doctorId, locationId, organizationId: orgId,
    workingHours: JSON.stringify({ all: { start: "00:00", end: "23:59" } }), bookingMode: "sequential_queue" });

  // Create User A
  const userA = await User.create({
    name: "User Alice",
    phone: "9876543210",
    role: "patient",
    authMethod: "phone_otp",
  });
  userAId = userA.id;
  userAToken = (await fixtureAccessToken({ id: userAId, email: "", role: "patient", organization_id: orgId }));

  const patientA = await Patient.create({
    userId: userA._id,
    name: "User Alice",
    phone: "9876543210",
    accountType: "self",
    organizationId: orgId,
  });
  patientAId = patientA.id;

  await FamilyRelationship.create({
    userId: userA._id,
    patientId: patientA._id,
    relationship: "self",
    status: "active",
  });

  // Create User B
  const userB = await User.create({
    name: "User Bob",
    phone: "9876543211",
    role: "patient",
    authMethod: "phone_otp",
  });
  userBId = userB.id;
  userBToken = (await fixtureAccessToken({ id: userBId, email: "", role: "patient", organization_id: orgId }));

  const patientB = await Patient.create({
    userId: userB._id,
    name: "User Bob",
    phone: "9876543211",
    accountType: "self",
    organizationId: orgId,
  });
  patientBId = patientB.id;

  await FamilyRelationship.create({
    userId: userB._id,
    patientId: patientB._id,
    relationship: "self",
    status: "active",
  });
});

describe("Comprehensive Gap Audit & Security Test Suite", () => {
  it("should prevent User A from accessing or updating User B's patient profile (IDOR)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/patients/${patientBId}`,
      headers: { authorization: `Bearer ${userAToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("should prevent User A from booking an appointment using User B's patient ID (IDOR)", async () => {
    const visitTime = new Date(Date.now() + 3 * 86400000).toISOString();
    const before = await Appointment.countDocuments({ patientId: patientBId });
    const res = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { authorization: `Bearer ${userAToken}` },
      payload: {
        doctorId,
        locationId,
        patientId: patientBId,
        appointmentTime: visitTime,
        appointmentType: "online",
        slotTime: "10:00 AM",
      },
    });
    expect([403, 404]).toContain(res.statusCode);
    expect(await Appointment.countDocuments({ patientId: patientBId })).toBe(before);
  });

  it("should enforce OTP rate limiting after 5 requests", async () => {
    const testPhone = "9999988888";
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: "POST",
        url: "/api/auth/otp/request",
        payload: { phone: testPhone, purpose: "authentication" },
      });
    }

    const rateLimitedRes = await app.inject({
      method: "POST",
      url: "/api/auth/otp/request",
      payload: { phone: testPhone, purpose: "authentication" },
    });

    expect(rateLimitedRes.statusCode).toBe(400);
    const body = JSON.parse(rateLimitedRes.body);
    expect(body.message).toContain("Too many OTP requests");
  });

  it("should prevent OTP purpose mismatch during verification", async () => {
    const testPhone = "9999977777";
    await app.inject({
      method: "POST",
      url: "/api/auth/otp/request",
      payload: { phone: testPhone, purpose: "authentication" },
    });

    const mismatchRes = await app.inject({
      method: "POST",
      url: "/api/auth/otp/verify",
      payload: { phone: testPhone, otp: "123456", purpose: "record_claim" },
    });

    expect(mismatchRes.statusCode).toBe(400);
  });

  it("should prevent claiming an unlinked walk-in record with phone mismatch without OTP", async () => {
    const walkinPatient = await Patient.create({
      name: "Walkin Charlie",
      phone: "9111122222",
      accountType: "walkin",
      organizationId: orgId,
    });

    const claimRes = await app.inject({
      method: "POST",
      url: "/api/family/claim",
      headers: { authorization: `Bearer ${userAToken}` },
      payload: { patientId: walkinPatient.id },
    });

    expect(claimRes.statusCode).toBe(403);
    const body = JSON.parse(claimRes.body);
    expect(body.message).toContain("Phone verification required");
  });

  it("should reject Razorpay payment verification with invalid signature", async () => {
    const appt: any = await Appointment.create({
      patientId: patientAId,
      doctorId,
      locationId,
      organizationId: orgId,
      bookedByUserId: userAId,
      appointmentTime: new Date(),
      appointmentType: "online",
      tokenNumber: 101,
      status: "pending_payment",
      paymentStatus: "pending",
    });

    const verifyRes = await app.inject({
      method: "POST",
      url: "/api/appointment-payments/verify",
      headers: { authorization: `Bearer ${userAToken}` },
      payload: {
        appointmentId: appt._id.toString(),
        razorpayOrderId: "order_fake123",
        razorpayPaymentId: "pay_fake123",
        razorpaySignature: "invalid_tampered_signature",
      },
    });

    expect(verifyRes.statusCode).toBe(400);
  });

  it("should reject pay at location if allowPayAtLocation is set to false", async () => {
    await DoctorAssignment.updateOne({ doctorId, locationId }, {
      $set: { fees: 600, allowPayAtLocation: false, paymentRequired: true },
    });

    const appt: any = await Appointment.create({
      patientId: patientAId,
      doctorId,
      locationId,
      organizationId: orgId,
      bookedByUserId: userAId,
      appointmentTime: new Date(),
      appointmentType: "online",
      tokenNumber: 102,
      status: "pending_payment",
      paymentStatus: "pending",
    });

    const payAtLocationRes = await app.inject({
      method: "POST",
      url: "/api/appointment-payments/pay-at-location",
      headers: { authorization: `Bearer ${userAToken}` },
      payload: { appointmentId: appt._id.toString() },
    });

    expect(payAtLocationRes.statusCode).toBe(400);
    const body = JSON.parse(payAtLocationRes.body);
    expect(body.message).toContain("Pay at location is disabled");
  });
});
