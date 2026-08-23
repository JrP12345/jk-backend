import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import mongoose from "mongoose";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Organization } from "../models/Organization.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Clinic } from "../models/Clinic.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Appointment } from "../models/Appointment.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Medicine } from "../models/Medicine.ts";
import { SaaSConfig } from "../models/SaaSConfig.ts";
import { ModuleRegistry } from "../models/ModuleRegistry.ts";
import { generateAccessToken } from "../utilities/helpers.ts";

describe("Clinic Essentials Hardening & Security Audit Fixes", () => {
  let rootToken: string;
  let orgAId: string;
  let orgBId: string;
  let clinicAId: string;
  let doctorAId: string;
  let patientAUser: any;
  let patientAToken: string;
  let patientAProfile: any;
  let patientBUser: any;
  let patientBToken: string;
  let patientBProfile: any;

  beforeAll(async () => {
    await app.ready();

    // 1. Root Super Admin
    const rootUser = await User.create({
      name: "Root Super Admin",
      email: "root-hardening@test.com",
      role: "root",
      isActive: true,
    });
    rootToken = generateAccessToken({
      id: rootUser.id,
      email: rootUser.email!,
      role: "root",
    });

    // 2. Org A & Clinic A
    const orgA = await Organization.create({
      name: "Hardening Org A",
      city: "Bangalore",
      plan: "pro",
    });
    orgAId = orgA.id;

    const orgB = await Organization.create({
      name: "Hardening Org B",
      city: "Mumbai",
      plan: "pro",
    });
    orgBId = orgB.id;

    // Enable required modules in ModuleRegistry for Org A
    await ModuleRegistry.create([
      { organizationId: orgAId, moduleKey: "audit", enabled: true, priority: "P3", label: "Audit Logs" },
      { organizationId: orgAId, moduleKey: "pharmacy", enabled: true, priority: "P1", label: "Pharmacy Inventory" },
      { organizationId: orgAId, moduleKey: "clinics", enabled: true, priority: "P1", label: "Clinic Branches" },
      { organizationId: orgAId, moduleKey: "appointments", enabled: true, priority: "P1", label: "Appointments" },
      { organizationId: orgAId, moduleKey: "billing", enabled: true, priority: "P1", label: "Patient Billing" },
    ]);

    const clinicA = await Clinic.create({
      organizationId: orgAId,
      name: "Clinic A",
      city: "Bangalore",
      isActive: true,
    });
    clinicAId = clinicA.id;

    // 3. Doctor A
    const docUser = await User.create({
      name: "Dr. Hardening",
      email: "doctor-hardening@test.com",
      role: "doctor",
      isActive: true,
    });
    doctorAId = docUser.id;

    await OrgMember.create({
      userId: doctorAId,
      organizationId: orgAId,
      role: "doctor",
      status: "active",
    });

    await DoctorAssignment.create({
      doctorId: doctorAId,
      clinicId: clinicAId,
      organizationId: orgAId,
      workingHours: "09:00-17:00",
      fees: 500,
      bookingMode: "sequential_queue",
      isActive: true,
    });

    // 4. Patient A & Patient B
    patientAUser = await User.create({
      name: "Patient Alpha",
      email: "patient-alpha@test.com",
      role: "patient",
      isActive: true,
    });
    patientAToken = generateAccessToken({
      id: patientAUser.id,
      email: patientAUser.email,
      role: "patient",
    });
    patientAProfile = await Patient.create({
      userId: patientAUser._id,
      name: "Patient Alpha",
      organizationId: orgAId,
      accountType: "self",
    });

    patientBUser = await User.create({
      name: "Patient Beta",
      email: "patient-beta@test.com",
      role: "patient",
      isActive: true,
    });
    patientBToken = generateAccessToken({
      id: patientBUser.id,
      email: patientBUser.email,
      role: "patient",
    });
    patientBProfile = await Patient.create({
      userId: patientBUser._id,
      name: "Patient Beta",
      organizationId: orgAId,
      accountType: "self",
    });
  });

  it("P0: adminGetRazorpayConfig must never leak plaintext secrets", async () => {
    await SaaSConfig.findOneAndUpdate(
      { key: "platform_config" },
      {
        razorpayKeyId: "rzp_test_12345",
        razorpayKeySecret: "super_secret_key_99999",
        razorpayWebhookSecret: "super_secret_webhook_88888",
        isLiveMode: false,
      },
      { upsert: true }
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/billing/razorpay-config",
      headers: { authorization: `Bearer ${rootToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body).data;
    expect(body.keyId).toBe("rzp_test_12345");
    expect(body.keySecret).not.toContain("super_secret_key_99999");
    expect(body.keySecret).toBe("••••••••••••••••");
    expect(body.webhookSecret).not.toContain("super_secret_webhook_88888");
    expect(body.hasKeySecret).toBe(true);
    expect(body.hasWebhookSecret).toBe(true);
  });

  it("P1: Patient A cannot cancel Patient B's appointment (IDOR Protection)", async () => {
    const apptB = await Appointment.create({
      organizationId: orgAId,
      clinicId: clinicAId,
      doctorId: doctorAId,
      patientId: patientBProfile._id,
      bookedByUserId: patientBUser._id,
      appointmentTime: new Date("2026-09-01T10:00:00Z"),
      appointmentType: "online",
      status: "confirmed",
      tokenNumber: 1,
      queuePosition: 1,
    });

    const res = await app.inject({
      method: "PUT",
      url: `/api/appointments/${apptB.id}/cancel`,
      headers: { authorization: `Bearer ${patientAToken}` },
      payload: { reason: "Malicious cancellation attempt" },
    });

    expect(res.statusCode).toBe(403);
    const apptCheck = await Appointment.findById(apptB.id);
    expect(apptCheck?.status).toBe("confirmed");
  });

  it("P1: Patient A can cancel their own appointment successfully", async () => {
    const apptA = await Appointment.create({
      organizationId: orgAId,
      clinicId: clinicAId,
      doctorId: doctorAId,
      patientId: patientAProfile._id,
      bookedByUserId: patientAUser._id,
      appointmentTime: new Date("2026-09-01T11:00:00Z"),
      appointmentType: "online",
      status: "confirmed",
      tokenNumber: 2,
      queuePosition: 2,
    });

    const res = await app.inject({
      method: "PUT",
      url: `/api/appointments/${apptA.id}/cancel`,
      headers: { authorization: `Bearer ${patientAToken}` },
      payload: { reason: "Need to reschedule" },
    });

    expect(res.statusCode).toBe(200);
    const apptCheck = await Appointment.findById(apptA.id);
    expect(apptCheck?.status).toBe("cancelled");
  });

  it("P1: Token numbers must be generated atomically without collisions", async () => {
    const bookingPromises = [1, 2, 3].map((i) =>
      app.inject({
        method: "POST",
        url: "/api/appointments",
        headers: { authorization: `Bearer ${patientAToken}` },
        payload: {
          clinicId: clinicAId,
          doctorId: doctorAId,
          appointmentTime: "2026-09-05T14:00:00Z",
          appointmentType: "online",
        },
      })
    );

    const results = await Promise.all(bookingPromises);
    const successfulTokens = results
      .filter((r) => r.statusCode === 201)
      .map((r) => JSON.parse(r.body).data.tokenNumber);

    const uniqueTokens = new Set(successfulTokens);
    expect(uniqueTokens.size).toBe(successfulTokens.length);
  });

  it("P1: Audit logs must be properly isolated by organization", async () => {
    const orgAAdmin = await User.create({
      name: "Org A Admin",
      email: "admin-org-a-audit@test.com",
      role: "admin",
      isActive: true,
    });
    const orgAAdminToken = generateAccessToken({
      id: orgAAdmin.id,
      email: orgAAdmin.email!,
      role: "admin",
      organization_id: orgAId,
      permissions: ["VIEW_AUDIT_LOGS"],
    });

    // Create audit log in Org B
    await AuditLog.create({
      userId: new mongoose.Types.ObjectId(),
      organizationId: new mongoose.Types.ObjectId(orgBId),
      action: "SECRET_ORG_B_ACTION",
    });

    // Create audit log in Org A
    await AuditLog.create({
      userId: orgAAdmin._id,
      organizationId: new mongoose.Types.ObjectId(orgAId),
      action: "ORG_A_ACTION",
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/audit-logs",
      headers: { authorization: `Bearer ${orgAAdminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const logs = JSON.parse(res.body).data;
    const actions = logs.map((l: any) => l.action);
    expect(actions).toContain("ORG_A_ACTION");
    expect(actions).not.toContain("SECRET_ORG_B_ACTION");
  });

  it("P1: updateClinic cannot hijack organizationId", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/onboarding/clinics/${clinicAId}`,
      headers: { authorization: `Bearer ${rootToken}` },
      payload: {
        name: "Updated Clinic A Name",
        city: "Bangalore",
        organizationId: "600000000000000000000001",
      },
    });

    const clinicCheck = await Clinic.findById(clinicAId);
    expect(clinicCheck?.organizationId.toString()).toBe(orgAId);
  });

  it("P2: GST Invoice creation correctly computes and enforces taxes", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${rootToken}` },
      payload: {
        patientId: patientAProfile.id,
        clinicId: clinicAId,
        doctorId: doctorAId,
        items: [
          {
            description: "Consultation & Procedure",
            amount: 1000,
            quantity: 1,
            gstRate: 18,
          },
        ],
        tax: 0,
      },
    });

    expect(res.statusCode).toBe(201);
    const invoice = JSON.parse(res.body).data;
    expect(invoice.tax).toBe(180);
    expect(invoice.totalAmount).toBe(1180);
  });

  it("P2: Medicine soft delete marks deletedAt and excludes from getMedicines", async () => {
    const med = await Medicine.create({
      clinicId: clinicAId,
      name: "Paracetamol 500mg SoftDel",
      genericName: "Paracetamol",
      stockQuantity: 100,
      price: 20,
      costPrice: 10,
      expiryDate: new Date("2028-01-01"),
      batchNumber: "B101",
    });

    // Soft delete
    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/medicines/${med.id}`,
      headers: { authorization: `Bearer ${rootToken}` },
    });
    expect(delRes.statusCode).toBe(200);

    // Verify excluded from listing
    const listRes = await app.inject({
      method: "GET",
      url: `/api/medicines?clinicId=${clinicAId}&search=SoftDel`,
      headers: { authorization: `Bearer ${rootToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const meds = JSON.parse(listRes.body).data;
    expect(meds.find((m: any) => m.id === med.id)).toBeUndefined();
  });
});
