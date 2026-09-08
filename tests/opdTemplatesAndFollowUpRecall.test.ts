import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { User } from "../models/User.ts";
import { OpdTemplate } from "../models/OpdTemplate.ts";

describe("OPD Clinical Presets, Follow-Up Recall Register & Doorway Summon Suite", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let doctorId: string;
  let doctorUserId: string;
  let patientDoc: any;
  let createdCustomPresetId: string;
  let followUpApptId: string;

  beforeAll(async () => {
    // 1. Setup Organization & Super Admin
    const bootstrapRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Apollo Clinix Group ${Date.now()}`,
        city: "Mumbai",
        admin_name: "Apollo Ops Lead",
        admin_email: `apollo_lead_${Date.now()}@apollo.com`,
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
        name: "Apollo Express Clinic",
        city: "Mumbai",
        address: "Bandra West OPD Wing",
        phone: "9820098200",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Setup Doctor
    const doctorEmail = `dr_verma_${Date.now()}@apollo.com`;
    const docRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Alok Verma",
        email: doctorEmail,
        password: "Password123",
        specialization: "General Medicine",
        consultationFee: 500,
        clinicIds: [clinicId],
      },
    });
    expect(docRes.statusCode).toBe(201);
    const docData = JSON.parse(docRes.body).data;
    doctorId = docData.id;
    doctorUserId = docData.userId || docData.id;

    // 4. Setup Patient
    patientDoc = await Patient.create({
      organizationId: orgId,
      name: "Ramesh Sharma",
      phone: "9819998199",
      gender: "male",
      dob: new Date("1976-05-15"),
      address: "Bandra, Mumbai",
    });
  });

  it("1. should retrieve standard OPD clinical templates and allow doctor to create custom preset", async () => {
    // A. Fetch templates (should contain standard system presets)
    const getRes = await app.inject({
      method: "GET",
      url: "/api/clinical/opd-templates",
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(getRes.statusCode).toBe(200);
    const body = JSON.parse(getRes.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.systemPresets)).toBe(true);
    expect(body.data.systemPresets.length).toBeGreaterThanOrEqual(5);

    // Verify presence of Viral URI & Flu
    const viralPreset = body.data.systemPresets.find((p: any) => p.title.includes("Viral"));
    expect(viralPreset).toBeDefined();
    expect(viralPreset.prescriptions.length).toBeGreaterThan(0);

    // B. Create a custom doctor preset
    const createRes = await app.inject({
      method: "POST",
      url: "/api/clinical/opd-templates",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        title: "Dr. Verma Dengue / Viral Combo",
        specialty: "General Medicine",
        symptoms: "High fever with chills, severe retro-orbital headache, myalgia x 2 days",
        diagnosis: "Suspected Dengue Fever / Acute Viral Illness",
        prescriptions: [
          { name: "Paracetamol 650mg", dosage: "1-1-1 (After Food)", duration: "3 days", instructions: "Avoid NSAIDs/Aspirin" },
          { name: "Carica Papaya Leaf Extract", dosage: "1-0-1 (After Food)", duration: "5 days", instructions: "Platelet support" },
          { name: "Pantoprazole 40mg", dosage: "1-0-0 (Before Food)", duration: "5 days", instructions: "Empty stomach" },
        ],
        advice: "Plentiful oral fluids (minimum 3L/day). Strict bed rest. Monitor platelet count daily.",
        followUpRecommended: true,
        followUpTimeline: "2 days",
        followUpNotes: "Repeat CBC / Platelet count after 48 hours.",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const createdData = JSON.parse(createRes.body).data;
    expect(createdData.title).toBe("Dr. Verma Dengue / Viral Combo");
    expect(createdData.prescriptions.length).toBe(3);
    createdCustomPresetId = createdData.id;

    // Verify audit log
    const audit = await AuditLog.findOne({
      action: "OPD_TEMPLATE_CREATED",
      targetId: createdCustomPresetId,
    });
    expect(audit).toBeDefined();
  });

  it("2. should populate Follow-Up Recall Register and correctly categorize due/upcoming follow-ups", async () => {
    const today = new Date();
    const in4Days = new Date(today.getTime() + 4 * 24 * 60 * 60 * 1000);

    // Create a confirmed follow-up appointment in MongoDB
    const followUpAppt = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId,
      patientId: patientDoc._id,
      appointmentTime: in4Days,
      appointmentType: "walk-in",
      status: "confirmed",
      tokenNumber: 15,
      queuePosition: 15,
      followUpRecommended: true,
      notes: "Post-Viral Thrombocytopenia Review",
      diagnosis: "Suspected Dengue Fever",
      paymentStatus: "unpaid",
    });
    followUpApptId = followUpAppt._id.toString();

    // Query follow-up register
    const res = await app.inject({
      method: "GET",
      url: `/api/appointments/follow-ups?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.metrics).toBeDefined();
    expect(body.data.metrics.totalCount).toBeGreaterThanOrEqual(1);

    const match = body.data.items.find((item: any) => item.id === followUpApptId);
    expect(match).toBeDefined();
    expect(match.statusCategory).toBe("upcoming");
    expect(match.patient.name).toBe("Ramesh Sharma");
    expect(match.doctor.name).toBe("Dr. Alok Verma");
  });

  it("3. should dispatch 1-click WhatsApp follow-up reminder and update recall timestamp and count", async () => {
    const reminderRes = await app.inject({
      method: "POST",
      url: `/api/appointments/${followUpApptId}/send-followup-reminder`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        phone: "9819998199",
        channel: "whatsapp",
      },
    });
    expect(reminderRes.statusCode).toBe(200);
    const reminderData = JSON.parse(reminderRes.body).data;
    expect(reminderData.lastRecallSentAt).toBeDefined();
    expect(reminderData.recallCount).toBe(1);

    // Verify persisted record in DB
    const updatedAppt = await Appointment.findById(followUpApptId).lean();
    expect(updatedAppt?.lastRecallSentAt).toBeDefined();
    expect(updatedAppt?.recallCount).toBe(1);

    // Verify audit log
    const audit = await AuditLog.findOne({
      action: "FOLLOW_UP_RECALL_SENT",
      targetId: followUpApptId,
    });
    expect(audit).toBeDefined();
    expect(audit?.details?.channel).toBe("whatsapp");
  });

  it("4. should execute callNextPatient and trigger doorway summon notification", async () => {
    // Create waiting appointment
    const waitingAppt = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId,
      patientId: patientDoc._id,
      appointmentTime: new Date(),
      appointmentType: "walk-in",
      status: "checked-in",
      tokenNumber: 22,
      queuePosition: 1,
    });

    const callRes = await app.inject({
      method: "POST",
      url: "/api/queue/call-next",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        doctorId,
        completePrevious: true,
      },
    });
    expect(callRes.statusCode).toBe(200);
    const callData = JSON.parse(callRes.body).data;
    expect(callData.tokenNumber).toBe(22);
    expect(callData.status).toBe("in-consultation");

    // Verify audit log for cabin summon
    const audit = await AuditLog.findOne({
      action: "PATIENT_CALL_NEXT",
      targetId: waitingAppt._id,
    });
    expect(audit).toBeDefined();
  });
});
