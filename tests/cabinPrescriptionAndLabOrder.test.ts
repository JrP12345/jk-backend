import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { User } from "../models/User.ts";
import { LabOrder } from "../models/LabOrder.ts";

describe("In-Cabin Diagnostic Lab Ordering & Digital Rx WhatsApp Suite", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let doctorId: string;
  let doctorUserId: string;
  let patientDoc: any;

  beforeAll(async () => {
    // 1. Setup Organization & Super Admin
    const bootstrapRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Max Healthcare Group ${Date.now()}`,
        city: "Delhi",
        admin_name: "Max Ops Admin",
        admin_email: `max_ops_${Date.now()}@maxhealth.com`,
        admin_password: "Password123",
        plan: "enterprise",
      },
    });
    expect(bootstrapRes.statusCode).toBe(201);
    adminCookies = (bootstrapRes.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);
    orgId = JSON.parse(bootstrapRes.body).data.organization.id;

    // Enable WhatsApp in test org
    await Organization.updateOne(
      { _id: orgId },
      {
        $set: {
          whatsappConfig: {
            mode: "mock",
            creditsBalance: 500,
            creditsUsedThisMonth: 0,
            notifications: {
              sendConsultationComplete: true,
              sendTurnApproaching: true,
              sendBookingConfirmation: true,
            },
          },
        },
      }
    );

    // 2. Setup Clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Max Saket OPD Cabin",
        city: "Delhi",
        upiVpa: "maxsaket@icici",
        merchantName: "Max Healthcare",
      },
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
        email: `dr.vikram_${Date.now()}@maxhealth.com`,
        password: "Password123",
        specialization: "Internal Medicine",
        consultationFee: 800,
        clinicIds: [clinicId],
      },
    });
    expect(docRes.statusCode).toBe(201);
    const docData = JSON.parse(docRes.body).data;
    doctorId = docData.id;
    doctorUserId = docData.userId || docData.id;

    // Ensure DoctorAssignment active
    await DoctorAssignment.updateOne(
      { doctorId: doctorUserId, clinicId },
      { $set: { isActive: true } },
      { upsert: true }
    );

    // 4. Create Patient
    patientDoc = await Patient.create({
      organizationId: orgId,
      name: "Rohit Sharma",
      phone: "+919876543210",
      gender: "male",
      dob: new Date("1987-04-30"),
    });
  });

  it("should order diagnostic lab tests from cabin and move patient to standby with LabOrders", async () => {
    // Create an in-consultation appointment
    const appt = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId: doctorUserId,
      patientId: patientDoc._id,
      appointmentTime: new Date(),
      appointmentType: "walk-in",
      status: "in-consultation",
      tokenNumber: 101,
      queuePosition: 1,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/queue/${appt._id}/order-investigations`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        testNames: ["Complete Blood Count (CBC)", "Serum Creatinine"],
        notes: "Investigate elevated serum creatinine and persistent fever",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);

    // Verify appointment updated to Standby and initial_pending_investigation
    const updatedAppt = await Appointment.findById(appt._id);
    expect(updatedAppt?.status).toBe("standby");
    expect(updatedAppt?.consultationPhase).toBe("initial_pending_investigation");
    expect(updatedAppt?.investigationNotes).toContain("Investigate elevated");
    expect(updatedAppt?.investigationResults?.length).toBe(2);

    // Verify LabOrders created in DB
    const labOrders = await LabOrder.find({ appointmentId: appt._id });
    expect(labOrders.length).toBe(2);
    expect(labOrders[0].status).toBe("ordered");
  });

  it("should complete consultation with digital prescription and dispatch WhatsApp notification", async () => {
    const appt = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId: doctorUserId,
      patientId: patientDoc._id,
      appointmentTime: new Date(),
      appointmentType: "walk-in",
      status: "in-consultation",
      tokenNumber: 102,
      queuePosition: 1,
    });

    const res = await app.inject({
      method: "PUT",
      url: `/api/appointments/${appt._id}/status`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        status: "completed",
        symptoms: "Fever, chills, dry cough for 3 days",
        diagnosis: "Acute Bronchitis",
        prescriptions: [
          { name: "Amoxicillin-Clav 625mg", dosage: "1-0-1", duration: "5 days" },
          { name: "Paracetamol 650mg", dosage: "1-0-1", duration: "3 days" },
        ],
        followUpRecommended: true,
        followUpTimeline: "1 week",
        followUpNotes: "Review if fever persists past 3 days",
        dispatchWhatsAppRx: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const updatedAppt = await Appointment.findById(appt._id);
    expect(updatedAppt?.status).toBe("completed");
    expect(updatedAppt?.rxDispatchedAt).not.toBeNull();
    expect(updatedAppt?.prescriptions?.length).toBe(2);
  });

  it("should support 1-click re-dispatch of digital e-Prescription to custom phone via WhatsApp", async () => {
    const appt = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId: doctorUserId,
      patientId: patientDoc._id,
      appointmentTime: new Date(),
      appointmentType: "walk-in",
      status: "completed",
      tokenNumber: 103,
      queuePosition: 1,
      diagnosis: "Gastroenteritis",
      prescriptions: [
        { name: "ORS Sachet", dosage: "1 sachet in 1L water", duration: "2 days" },
      ],
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/appointments/${appt._id}/resend-rx`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        phone: "+919988776655",
        channel: "whatsapp",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.channel).toBe("whatsapp");

    // Verify audit log
    const audit = await AuditLog.findOne({
      action: "PRESCRIPTION_NOTIFICATION_RESENT",
      targetId: appt._id,
    });
    expect(audit).not.toBeNull();
    expect(audit?.details?.phone).toBe("+919988776655");
  });
});
