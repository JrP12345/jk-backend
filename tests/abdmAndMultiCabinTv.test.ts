import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { Doctor } from "../models/Doctor.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { NotificationLog } from "../models/NotificationLog.ts";

describe("ABDM / ABHA Foundation, Multi-Cabin Polyclinic TV, & WhatsApp Conversational Booking Suite", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let doctor1Id: string;
  let doctor2Id: string;
  const whatsAppPatientPhone = `9199${Math.floor(10000000 + Math.random() * 90000000)}`;

  beforeAll(async () => {
    // 1. Setup Organization & Super Admin
    const bootstrapRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Apollo PolyCare ${Date.now()}`,
        city: "New Delhi",
        admin_name: "Dr. Polyclinic Admin",
        admin_email: `abdm_admin_${Date.now()}@polycare.org`,
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
        name: "Apollo Multi-Specialty PolyCare Centre",
        city: "New Delhi",
        address: "South Extension Part II",
        phone: "+911144556677",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Setup Doctor 1 (Cabin 101 - Cardiology)
    const doc1Res = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Vikram Sethi",
        email: `dr_vikram_${Date.now()}@polycare.org`,
        password: "Password123",
        specialization: "Cardiology",
        qualification: "MBBS, MD, DM (Cardiology)",
        registrationNumber: "MCI-55441/2010",
        clinicIds: [clinicId],
        consultationFee: 800,
      },
    });
    expect(doc1Res.statusCode).toBe(201);
    doctor1Id = JSON.parse(doc1Res.body).data.id;

    // 4. Setup Doctor 2 (Cabin 102 - Orthopaedics)
    const doc2Res = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Sunita Rao",
        email: `dr_sunita_${Date.now()}@polycare.org`,
        password: "Password123",
        specialization: "Orthopaedics",
        qualification: "MBBS, MS (Ortho)",
        registrationNumber: "DMC-88192/2014",
        clinicIds: [clinicId],
        consultationFee: 700,
      },
    });
    expect(doc2Res.statusCode).toBe(201);
    doctor2Id = JSON.parse(doc2Res.body).data.id;

    const workingHours = JSON.stringify({
      all: [{ start: "00:00", end: "23:59" }],
    });

    // Create assignments with cabin numbers
    await DoctorAssignment.create({
      doctorId: doctor1Id,
      clinicId,
      organizationId: orgId,
      workingHours,
      fees: 800,
      cabinNumber: "Cabin 101",
      isActive: true,
    });

    await DoctorAssignment.create({
      doctorId: doctor2Id,
      clinicId,
      organizationId: orgId,
      workingHours,
      fees: 700,
      cabinNumber: "Cabin 102",
      isActive: true,
    });

    await Doctor.updateMany({ userId: doctor1Id }, { cabinNumber: "Cabin 101" });
    await Doctor.updateMany({ userId: doctor2Id }, { cabinNumber: "Cabin 102" });

    // Create WhatsApp patient linked to this organization
    await Patient.create({
      name: "WhatsApp Test Patient",
      phone: whatsAppPatientPhone,
      organizationId: orgId,
      gender: "male",
      dob: new Date("1990-01-01"),
    });
  });

  describe("Pillar 1: ABDM (Ayushman Bharat) / ABHA M1 & M2 Foundation + Counter Scan & Share", () => {
    let aadhaarTxnId: string;
    let abhaNumber: string;
    let abhaAddress: string;

    it("should generate Aadhaar OTP session for 12-digit Aadhaar", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/abdm/generate-otp",
        headers: { cookie: adminCookies.join("; ") },
        payload: {
          aadhaarNumber: "555544443333",
          phone: "9876543210",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.txnId).toBeDefined();
      expect(body.message).toContain("OTP");
      aadhaarTxnId = body.data.txnId;
    });

    it("should verify Aadhaar OTP and generate 14-digit ABHA ID and ABHA Address", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/abdm/verify-otp",
        headers: { cookie: adminCookies.join("; ") },
        payload: {
          txnId: aadhaarTxnId,
          otp: "123456",
          preferredAbhaAddress: "rajesh.sharma",
          name: "Rajesh Kumar Sharma",
          gender: "male",
          dob: "1988-06-15",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.abhaNumber).toMatch(/^\d{2}-\d{4}-\d{4}-\d{4}$/);
      expect(body.data.abhaAddress).toMatch(/@abdm$/);
      expect(body.data.status).toBe("verified");

      abhaNumber = body.data.abhaNumber;
      abhaAddress = body.data.abhaAddress;
    });

    it("should search/verify existing ABHA profile by 14-digit ABHA number", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/abdm/search?query=${encodeURIComponent(abhaNumber)}`,
        headers: { cookie: adminCookies.join("; ") },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.abhaNumber).toBe(abhaNumber);
    });

    it("should complete 3-Second Counter Scan & Share check-in and issue instant queue token", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/abdm/scan-share",
        payload: {
          clinicId,
          doctorId: doctor1Id,
          abhaProfile: {
            abhaNumber,
            abhaAddress,
            name: "Rajesh Kumar Sharma",
            gender: "male",
            dob: "1988-06-15",
            phone: "9876543210",
            address: "H-42 South Extension Part 2",
            city: "New Delhi",
            state: "Delhi",
            pincode: "110049",
          },
        },
      });

      if (res.statusCode !== 201) {
        console.error("DEBUG SCAN-SHARE ERROR:", res.body);
      }

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.tokenNumber).toBeGreaterThanOrEqual(1);
      expect(body.data.appointmentId).toBeDefined();

      // Verify Patient record in database was updated with ABHA credentials
      const updatedPatient = await Patient.findById(body.data.patientId);
      expect(updatedPatient?.abhaNumber).toBe(abhaNumber);
      expect(updatedPatient?.abhaAddress).toBe(abhaAddress);
      expect(updatedPatient?.abhaStatus).toBe("verified");
    });
  });

  describe("Pillar 3: Multi-Cabin Polyclinic TV Waiting Lounge Matrix & Cabin Audio Calling", () => {
    it("should return multi-cabin matrix with cabin numbers, doctor specialties, and queue status", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/public/queue-tv/${clinicId}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      const data = body.data;
      expect(data.clinic).toBeDefined();
      expect(data.cabins).toBeDefined();
      expect(Array.isArray(data.cabins)).toBe(true);
      expect(data.cabins.length).toBeGreaterThanOrEqual(2);

      const cabin1 = data.cabins.find((c: any) => c.doctorId === doctor1Id);
      expect(cabin1).toBeDefined();
      expect(cabin1.doctorName).toContain("Dr. Vikram Sethi");
      expect(cabin1.specialty).toBe("Cardiology");
      expect(cabin1.cabinNumber).toBe("Cabin 101");
      expect(cabin1.upcomingQueue).toBeDefined();

      const cabin2 = data.cabins.find((c: any) => c.doctorId === doctor2Id);
      expect(cabin2).toBeDefined();
      expect(cabin2.doctorName).toContain("Dr. Sunita Rao");
      expect(cabin2.specialty).toBe("Orthopaedics");
      expect(cabin2.cabinNumber).toBe("Cabin 102");
    });
  });

  describe("Pillar 2: 24/7 WhatsApp Conversational Appointment Booking State Machine", () => {
    const makeInbound = (text: string) => ({
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
                    from: whatsAppPatientPhone,
                    id: `wamid_inbound_${Date.now()}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    text: { body: text },
                    type: "text",
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    it("Step 1: Patient triggers booking via WhatsApp with 'BOOK'", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/webhooks/whatsapp",
        payload: makeInbound("BOOK"),
      });

      expect(res.statusCode).toBe(200);

      const log = await NotificationLog.findOne({
        recipientPhone: whatsAppPatientPhone,
        templateId: "TWO_WAY_ASSISTANT",
      }).sort({ createdAt: -1 });

      expect(log).toBeDefined();
      expect(log?.messageContent).toContain("Schedule an OPD Appointment");
      expect(log?.messageContent).toContain("Dr. Vikram Sethi");
      expect(log?.messageContent).toContain("Dr. Sunita Rao");
    });

    it("Step 2: Patient selects Doctor 1", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/webhooks/whatsapp",
        payload: makeInbound("1"),
      });

      expect(res.statusCode).toBe(200);

      const log = await NotificationLog.findOne({
        recipientPhone: whatsAppPatientPhone,
        templateId: "TWO_WAY_ASSISTANT",
      }).sort({ createdAt: -1 });

      expect(log).toBeDefined();
      expect(log?.messageContent).toContain("Select Consultation Date");
      expect(log?.messageContent).toContain("Today");
      expect(log?.messageContent).toContain("Tomorrow");
    });

    it("Step 3: Patient selects date '1' (Today) and completes confirmation", async () => {
      // Step 3a: Select date 1
      await app.inject({
        method: "POST",
        url: "/api/webhooks/whatsapp",
        payload: makeInbound("1"),
      });

      const confirmPrompt = await NotificationLog.findOne({
        recipientPhone: whatsAppPatientPhone,
        templateId: "TWO_WAY_ASSISTANT",
      }).sort({ createdAt: -1 });

      expect(confirmPrompt?.messageContent).toContain("Confirm Your OPD Appointment");

      // Step 3b: Send "YES" to confirm
      const confirmRes = await app.inject({
        method: "POST",
        url: "/api/webhooks/whatsapp",
        payload: makeInbound("YES"),
      });

      expect(confirmRes.statusCode).toBe(200);

      const bookedLog = await NotificationLog.findOne({
        recipientPhone: whatsAppPatientPhone,
        templateId: "TWO_WAY_ASSISTANT",
      }).sort({ createdAt: -1 });

      expect(bookedLog?.messageContent).toContain("Appointment Confirmed!");
      expect(bookedLog?.messageContent).toContain("Your Token: *#");
      expect(bookedLog?.messageContent).toContain("track/");

      // Verify Appointment in MongoDB
      const createdAppt = await Appointment.findOne({
        notes: { $regex: /WhatsApp 24\/7 Self-Service Desk/ },
      }).sort({ createdAt: -1 });

      expect(createdAppt).toBeDefined();
      expect(createdAppt?.tokenNumber).toBeGreaterThanOrEqual(1);
    });

    it("should allow patient to reset or cancel booking session at any time", async () => {
      // Start session
      await app.inject({
        method: "POST",
        url: "/api/webhooks/whatsapp",
        payload: makeInbound("4"),
      });

      // Cancel session
      const cancelRes = await app.inject({
        method: "POST",
        url: "/api/webhooks/whatsapp",
        payload: makeInbound("CANCEL"),
      });

      expect(cancelRes.statusCode).toBe(200);

      const cancelLog = await NotificationLog.findOne({
        recipientPhone: whatsAppPatientPhone,
        templateId: "TWO_WAY_ASSISTANT",
      }).sort({ createdAt: -1 });

      expect(cancelLog?.messageContent).toContain("Booking session cancelled");
    });
  });
});
