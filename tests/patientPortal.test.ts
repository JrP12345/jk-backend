import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import mongoose from "mongoose";
import app from "../index.js";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { Patient } from "../models/Patient.ts";
import { Prescription } from "../models/Prescription.ts";
import { RefillRequest } from "../models/RefillRequest.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import bcrypt from "bcryptjs";

describe("Milestone 3: Patient Portal Integration Tests", () => {
  it("should fetch and update current patient profile, emergency contacts, and insurance", async () => {
    const email = "patient_portal_user@ananta.internal";
    const password = "Password123!";
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      name: "Patient Portal Test",
      email,
      password: hashedPassword,
      role: "patient",
    });

    const patient = await Patient.create({
      userId: user._id,
      bloodGroup: "O+",
      address: "123 Health Way",
    });

    // 1. Login to retrieve access token
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "10.4.0.1",
      payload: { email, password },
    });
    expect(loginRes.statusCode).toBe(200);

    const cookies = loginRes.cookies;
    const accessToken = cookies.find((c) => c.name === "access_token")?.value || "";

    // 2. GET /api/patient/me
    const getRes = await app.inject({
      method: "GET",
      url: "/api/patient/me",
      remoteAddress: "10.4.0.2",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(getRes.statusCode).toBe(200);
    const body = JSON.parse(getRes.body);
    expect(body.data.patient).toBeDefined();

    // 3. PUT /api/patient/me (update emergency contacts & insurance)
    const updateRes = await app.inject({
      method: "PUT",
      url: "/api/patient/me",
      remoteAddress: "10.4.0.3",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        bloodGroup: "AB+",
        address: "456 Wellness Blvd, Tech City",
        emergencyContacts: [
          { name: "Jane Doe", relationship: "Spouse", phone: "+19998887777" },
        ],
        insurancePolicies: [
          { providerName: "Star Health", policyNumber: "SH-990011", coverageAmount: 500000 },
        ],
      },
    });
    expect(updateRes.statusCode).toBe(200);

    const updatedPatient = await Patient.findById(patient._id);
    expect(updatedPatient?.bloodGroup).toBe("AB+");
    expect(updatedPatient?.emergencyContacts.length).toBe(1);
    expect(updatedPatient?.emergencyContacts[0].name).toBe("Jane Doe");
    expect(updatedPatient?.insurancePolicies.length).toBe(1);
    expect(updatedPatient?.insurancePolicies[0].providerName).toBe("Star Health");
  });

  it("should handle self-service appointment booking and prescription refill workflow", async () => {
    // Setup Organization, Clinic, Doctor, Patient, and Active Prescription
    const org = await Organization.create({ name: "Patient Portal Test Org", city: "Mumbai" });
    const clinic = await Clinic.create({
      organizationId: org._id,
      name: "Portal Clinic",
      city: "Mumbai",
      address: "100 Medical Square",
    });

    const doctorUser = await User.create({
      name: "Dr. Portal Specialist",
      email: "doctor_portal@ananta.internal",
      password: await bcrypt.hash("Password123!", 10),
      role: "doctor",
    });

    await DoctorAssignment.create({
      doctorId: doctorUser._id,
      clinicId: clinic._id,
      organizationId: org._id,
      workingHours: JSON.stringify({ Monday: [{ start: "09:00", end: "17:00" }] }),
      fees: 500,
    });

    const patientUser = await User.create({
      name: "Refill Patient",
      email: "refill_patient@ananta.internal",
      password: await bcrypt.hash("Password123!", 10),
      role: "patient",
    });

    const patient = await Patient.create({
      userId: patientUser._id,
      organizationId: org._id,
    });

    const prescription = await Prescription.create({
      organizationId: org._id,
      clinicId: clinic._id,
      encounterId: new mongoose.Types.ObjectId(),
      patientId: patient._id,
      doctorId: doctorUser._id,
      medicineName: "Amoxicillin 500mg",
      dosage: "500mg",
      frequency: "1-0-1",
      duration: "7 days",
      status: "active",
    });

    // 1. Patient Log in
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "10.5.0.1",
      payload: { email: "refill_patient@ananta.internal", password: "Password123!" },
    });
    expect(loginRes.statusCode).toBe(200);

    const accessToken = loginRes.cookies.find((c) => c.name === "access_token")?.value || "";

    // 2. Patient submits Prescription Refill Request
    const refillRes = await app.inject({
      method: "POST",
      url: `/api/prescriptions/${prescription._id}/refill`,
      remoteAddress: "10.5.0.2",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { reason: "Finished 7-day course, symptoms returning mild." },
    });
    expect(refillRes.statusCode).toBe(201);

    const refillData = JSON.parse(refillRes.body).data;
    expect(refillData.status).toBe("pending");

    // 3. Duplicate Refill Request should be rejected (409 Conflict)
    const dupRes = await app.inject({
      method: "POST",
      url: `/api/prescriptions/${prescription._id}/refill`,
      remoteAddress: "10.5.0.3",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { reason: "Duplicate attempt" },
    });
    expect(dupRes.statusCode).toBe(409);

    // 4. Fetch Refill Requests for Patient
    const listRes = await app.inject({
      method: "GET",
      url: "/api/prescriptions/refills",
      remoteAddress: "10.5.0.4",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const refills = JSON.parse(listRes.body).data;
    expect(refills.length).toBe(1);
    expect(refills[0].reason).toContain("Finished 7-day course");

    // 5. Doctor logs in and Approves Refill Request
    const docLoginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "10.5.0.5",
      payload: { email: "doctor_portal@ananta.internal", password: "Password123!" },
    });
    const docToken = docLoginRes.cookies.find((c) => c.name === "access_token")?.value || "";

    const approveRes = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/refills/${refillData.id}`,
      remoteAddress: "10.5.0.6",
      cookies: { access_token: docToken },
      headers: { authorization: `Bearer ${docToken}` },
      payload: { status: "approved", decisionNotes: "Approved for additional 7 days after review." },
    });
    expect(approveRes.statusCode).toBe(200);

    const updatedRefill = await RefillRequest.findById(refillData.id);
    expect(updatedRefill?.status).toBe("approved");
    expect(updatedRefill?.decisionNotes).toBe("Approved for additional 7 days after review.");
  });
});
