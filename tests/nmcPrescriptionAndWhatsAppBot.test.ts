import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { Doctor } from "../models/Doctor.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { NotificationLog } from "../models/NotificationLog.ts";

describe("NMC Doctor Credentials & Two-Way Interactive WhatsApp Bot Suite", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let doctorId: string;
  let doctorUserId: string;
  let patient: any;
  let appointment: any;
  const patientPhone = "919876599999";

  beforeAll(async () => {
    // 1. Setup Organization & Super Admin
    const bootstrapRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `NMC Care System ${Date.now()}`,
        city: "New Delhi",
        admin_name: "Dr. Admin",
        admin_email: `nmc_admin_${Date.now()}@care.org`,
        admin_password: "Password123",
        plan: "enterprise",
      },
    });
    expect(bootstrapRes.statusCode).toBe(201);
    adminCookies = (bootstrapRes.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);
    orgId = JSON.parse(bootstrapRes.body).data.organization.id;

    // 2. Setup Clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "NMC Care OPD Centre",
        city: "New Delhi",
        address: "Ring Road, Lajpat Nagar",
        phone: "+911122334455",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Setup Doctor with NMC Registration and Qualifications
    const docRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Rajeshwar Sharma",
        email: `dr_rajeshwar_${Date.now()}@care.org`,
        password: "Password123",
        specialization: "General Medicine",
        qualification: "MBBS, MD (Internal Medicine)",
        registrationNumber: "MCI-48291/2012",
        clinicIds: [clinicId],
        consultationFee: 600,
      },
    });
    expect(docRes.statusCode).toBe(201);
    const docData = JSON.parse(docRes.body).data;
    doctorId = docData.id;
    doctorUserId = docData.userId || docData.id;

    // Verify Doctor record in database has registration number and default letterhead mode
    const docRecord = await Doctor.findOne({ organizationId: orgId });
    expect(docRecord).toBeDefined();
    expect(docRecord?.registrationNumber).toBe("MCI-48291/2012");
    expect(docRecord?.letterheadDefaultMode).toBe("plain_a4");

    // 4. Create Patient
    patient = await Patient.create({
      organizationId: orgId,
      name: "Suresh Gupta",
      phone: patientPhone,
      gender: "male",
      dob: new Date("1985-05-12"),
      address: "Lajpat Nagar, New Delhi",
    });

    // 5. Create Active Checked-In Appointment for Today
    appointment = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId,
      patientId: patient._id,
      tokenNumber: 22,
      queuePosition: 3,
      appointmentTime: new Date(),
      appointmentType: "walk-in",
      status: "checked-in",
      paymentStatus: "paid",
      paymentAmount: 600,
      diagnosis: "Acute Bronchial Spasm",
      prescriptions: [
        { name: "Salbutamol 4mg", dosage: "1-0-1", duration: "5 days" },
        { name: "Pantoprazole 40mg", dosage: "1-0-0", duration: "7 days" },
      ],
    });
  });

  // ─── Test 1: Inbound Webhook: STATUS / TOKEN Query ────────────────────────
  it("should respond to inbound WhatsApp 'STATUS' message with live queue token, doctor, and wait details", async () => {
    const inboundPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA_ID_TEST",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "15550234567", phone_number_id: "PHONE_ID" },
                messages: [
                  {
                    from: patientPhone,
                    id: `wamid_inbound_${Date.now()}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    text: { body: "STATUS" },
                    type: "text",
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      payload: inboundPayload,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);

    // Verify NotificationLog logged conversational assistant reply
    const assistantLog = await NotificationLog.findOne({
      recipientPhone: patientPhone,
      templateId: "TWO_WAY_ASSISTANT",
    }).sort({ createdAt: -1 });

    expect(assistantLog).toBeDefined();
    expect(assistantLog?.messageContent).toContain("Live OPD Queue Status");
    expect(assistantLog?.messageContent).toContain("Token: *#22*");
    expect(assistantLog?.messageContent).toContain("Suresh Gupta");
  });

  // ─── Test 2: Inbound Webhook: DELAY / LATE Postponement ────────────────────
  it("should respond to inbound WhatsApp 'DELAY' message by bumping queue position by 2", async () => {
    const inboundPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA_ID_TEST",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                messages: [
                  {
                    from: patientPhone,
                    id: `wamid_inbound_delay_${Date.now()}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    text: { body: "DELAY" },
                    type: "text",
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      payload: inboundPayload,
    });

    expect(res.statusCode).toBe(200);

    // Verify appointment was bumped back by 2 positions
    const updatedAppt = await Appointment.findById(appointment._id);
    expect(updatedAppt?.queuePosition).toBe(5); // 3 + 2 = 5
    expect(updatedAppt?.parkedReason).toContain("WhatsApp self-service");

    // Verify confirmation message was logged
    const delayLog = await NotificationLog.findOne({
      recipientPhone: patientPhone,
      templateId: "TWO_WAY_ASSISTANT",
      messageContent: /Token Postponed Successfully/,
    });

    expect(delayLog).toBeDefined();
    expect(delayLog?.messageContent).toContain("Position #5");
  });

  // ─── Test 3: Inbound Webhook: RX Query ────────────────────────────────────
  it("should respond to inbound WhatsApp 'RX' message with prescribed medicines summary", async () => {
    // Mark appointment completed
    await Appointment.findByIdAndUpdate(appointment._id, {
      status: "completed",
      followUpNotes: "Review in 1 week if wheezing persists.",
    });

    const inboundPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA_ID_TEST",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                messages: [
                  {
                    from: patientPhone,
                    id: `wamid_inbound_rx_${Date.now()}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    text: { body: "RX" },
                    type: "text",
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      payload: inboundPayload,
    });

    expect(res.statusCode).toBe(200);

    const rxLog = await NotificationLog.findOne({
      recipientPhone: patientPhone,
      templateId: "TWO_WAY_ASSISTANT",
      messageContent: /Digital Prescription \(Rx\)/,
    });

    expect(rxLog).toBeDefined();
    expect(rxLog?.messageContent).toContain("Salbutamol 4mg");
    expect(rxLog?.messageContent).toContain("Pantoprazole 40mg");
  });
});
