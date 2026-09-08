import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { Doctor } from "../models/Doctor.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { LabTest } from "../models/LabTest.ts";
import { LabOrder } from "../models/LabOrder.ts";
import { abdmService } from "../services/AbdmService.ts";
import { whatsAppCloudApiService } from "../services/WhatsAppCloudApiService.ts";
import { evaluatePanicCriticalValue } from "../controllers/laboratory.ts";

describe("ABDM Milestone 3 (M3) FHIR Engine, WhatsApp PDF Dispatch & Lab Panic Recall Suite", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let doctorUserId: string;
  let doctorId: string;
  let patientDoc: any;
  let appointmentDoc: any;
  const testPhone = `9198${Math.floor(10000000 + Math.random() * 90000000)}`;

  beforeAll(async () => {
    // 1. Setup Organization & Super Admin
    const bootstrapRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Max PolyCare Health ${Date.now()}`,
        city: "New Delhi",
        admin_name: "Dr. Polyclinic Operations",
        admin_email: `abdm_m3_${Date.now()}@maxpolycare.org`,
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
        name: "Max Super Specialty Polyclinic",
        city: "New Delhi",
        address: "14 Ring Road, Lajpat Nagar",
        phone: "+911188990011",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Setup Doctor with Cabin 101 & NMC Number
    const docRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Vikram Sethi",
        email: `dr_vikram_${Date.now()}@maxpolycare.org`,
        password: "Password123",
        specialization: "Cardiology",
        registrationNumber: "NMC-DL-2024-99881",
        consultationFee: 700,
        cabinNumber: "Cabin 101",
        clinicIds: [clinicId],
      },
    });
    expect(docRes.statusCode).toBe(201);
    const docData = JSON.parse(docRes.body).data;
    doctorUserId = docData.id;
    const docProfile = await Doctor.findOne({ userId: doctorUserId });
    doctorId = docProfile ? docProfile.id : doctorUserId;

    // 4. Assign Doctor to Clinic
    await DoctorAssignment.create({
      organizationId: orgId,
      clinicId,
      doctorId: doctorUserId,
      fees: 700,
      workingHours: JSON.stringify({ all: [{ start: "00:00", end: "23:59" }] }),
      cabinNumber: "Cabin 101",
      isActive: true,
    });

    // 5. Create Verified ABHA Patient
    patientDoc = await Patient.create({
      name: "Ayushman Kumar",
      phone: testPhone,
      organizationId: orgId,
      abhaNumber: "91-8841-2918-4721",
      abhaAddress: "ayushman.kumar@abdm",
      abhaStatus: "verified",
      dob: new Date("1992-06-15"),
      gender: "male",
      city: "New Delhi",
    });

    // 6. Book OPD Consultation Appointment
    appointmentDoc = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId: doctorUserId,
      patientId: patientDoc._id,
      appointmentTime: new Date(),
      appointmentType: "walk-in",
      status: "in-consultation",
      tokenNumber: 42,
      queuePosition: 1,
      paymentStatus: "paid",
      paymentAmount: 700,
      diagnosis: "Essential Hypertension with Angina Pectoris",
      prescriptions: [
        { name: "Tab Telmisartan 40mg", dosage: "1-0-0", duration: "30 days" },
        { name: "Tab Atorvastatin 20mg", dosage: "0-0-1", duration: "30 days" },
      ],
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. ABDM Milestone 3 (M3) HIP Care-Context Linking
  // ─────────────────────────────────────────────────────────────────────────────
  it("should link an OPD appointment encounter as an official ABDM Care-Context to patient's ABHA account", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/abdm/care-contexts/link",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        patientId: patientDoc._id.toString(),
        appointmentId: appointmentDoc._id.toString(),
        clinicId,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("SUCCESS");
    expect(body.data.patient.careContexts).toHaveLength(1);
    expect(body.data.patient.careContexts[0].referenceNumber).toBe(`OPD-ENC-${appointmentDoc._id}`);
    expect(body.data.hipId).toBe(`IN_HIP_${clinicId.slice(-8).toUpperCase()}`);

    // Verify patient database record
    const updatedPatient: any = await Patient.findById(patientDoc._id).lean();
    expect(updatedPatient.careContexts).toHaveLength(1);
    expect(updatedPatient.careContexts[0].careContextReference).toBe(`OPD-ENC-${appointmentDoc._id}`);
  });

  it("should handle Care-Context linking idempotently without duplicate entries", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/abdm/care-contexts/link",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        patientId: patientDoc._id.toString(),
        appointmentId: appointmentDoc._id.toString(),
        clinicId,
      },
    });

    expect(res.statusCode).toBe(200);
    const updatedPatient: any = await Patient.findById(patientDoc._id).lean();
    expect(updatedPatient.careContexts).toHaveLength(1);
  });

  it("should retrieve all linked care contexts for a patient", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/abdm/care-contexts/${patientDoc._id}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.careContexts).toHaveLength(1);
    expect(body.data.abhaAddress).toBe("ayushman.kumar@abdm");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. HL7 FHIR R4 Bundle Conformance (NRCES Prescription Record)
  // ─────────────────────────────────────────────────────────────────────────────
  it("should generate a compliant HL7 FHIR R4 PrescriptionRecord Bundle", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/abdm/fhir/encounter/${appointmentDoc._id}?type=prescription`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);

    const bundle = body.data;
    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.type).toBe("document");
    expect(bundle.identifier.system).toBe("https://nrces.in/ndhm/fhir/r4");
    expect(bundle.entry.length).toBeGreaterThanOrEqual(5);

    // Composition
    const comp = bundle.entry.find((e: any) => e.resource.resourceType === "Composition")?.resource;
    expect(comp).toBeDefined();
    expect(comp.status).toBe("final");
    expect(comp.meta.profile[0]).toContain("StructureDefinition/PrescriptionRecord");

    // Practitioner
    const pract = bundle.entry.find((e: any) => e.resource.resourceType === "Practitioner")?.resource;
    expect(pract).toBeDefined();
    expect(pract.identifier[0].system).toBe("https://nmc.org.in");

    // Organization (HIP)
    const org = bundle.entry.find((e: any) => e.resource.resourceType === "Organization")?.resource;
    expect(org).toBeDefined();
    expect(org.identifier[0].value).toBe(`IN_HIP_${clinicId.slice(-8).toUpperCase()}`);

    // Patient
    const pat = bundle.entry.find((e: any) => e.resource.resourceType === "Patient")?.resource;
    expect(pat).toBeDefined();
    expect(pat.gender).toBe("male");

    // MedicationRequests
    const meds = bundle.entry.filter((e: any) => e.resource.resourceType === "MedicationRequest");
    expect(meds.length).toBe(2);
    expect(meds[0].resource.medicationCodeableConcept.text).toContain("Telmisartan");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. ABDM Milestone 3 (M3) HIU Consent & External Record Fetching
  // ─────────────────────────────────────────────────────────────────────────────
  it("should create an ABDM HIU Consent Request and fetch external hospital records upon approval", async () => {
    // 1. Create Consent Request
    const createRes = await app.inject({
      method: "POST",
      url: "/api/abdm/hiu/consent-request",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        patientId: patientDoc._id.toString(),
        abhaAddress: "ayushman.kumar@abdm",
        purpose: "CAREMGT",
        hiTypes: ["Prescription", "DiagnosticReport", "DischargeSummary"],
      },
    });

    expect(createRes.statusCode).toBe(201);
    const createBody = JSON.parse(createRes.body);
    expect(createBody.data.consentRequestId).toBeDefined();
    const consentId = createBody.data.consentRequestId;

    // 2. Poll Status (Sandbox auto-grants)
    const statusRes = await app.inject({
      method: "GET",
      url: `/api/abdm/hiu/consent-status/${consentId}`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(statusRes.statusCode).toBe(200);
    expect(JSON.parse(statusRes.body).data.status).toBe("GRANTED");

    // 3. Fetch External Records from AIIMS and Apollo
    const dataRes = await app.inject({
      method: "GET",
      url: `/api/abdm/hiu/health-data/${consentId}`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(dataRes.statusCode).toBe(200);
    const dataBody = JSON.parse(dataRes.body).data;
    expect(dataBody.records.length).toBeGreaterThanOrEqual(2);
    expect(dataBody.records[0].sourceHospital).toContain("AIIMS");
    expect(dataBody.records[1].sourceHospital).toContain("Apollo");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Meta WhatsApp Cloud API Direct PDF Document Dispatch
  // ─────────────────────────────────────────────────────────────────────────────
  it("should dispatch a direct PDF document message via WhatsApp Cloud API client", async () => {
    const docDispatch = await whatsAppCloudApiService.sendDocumentMessage({
      to: testPhone,
      documentUrl: `/api/public/track/${appointmentDoc._id}/prescription/print`,
      filename: `Prescription_Token_${appointmentDoc.tokenNumber}_Dr_Vikram_Sethi.pdf`,
      caption: `Official Digital Prescription from Dr. Vikram Sethi`,
    });

    expect(docDispatch.success).toBe(true);
    expect(docDispatch.providerMessageId).toBeDefined();
    expect(docDispatch.status).toBe("sent");
    expect(docDispatch.rawResponse.documentSent.filename).toBe(`Prescription_Token_${appointmentDoc.tokenNumber}_Dr_Vikram_Sethi.pdf`);
  });

  it("should respond to inbound 'RX' keyword by returning prescription summary and dispatching PDF document", async () => {
    // Mark appointment completed
    appointmentDoc.status = "completed";
    await appointmentDoc.save();

    const webhookRes = await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      payload: {
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                field: "messages",
                value: {
                  messages: [
                    {
                      from: testPhone,
                      id: `wamid.RX.${Date.now()}`,
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: "text",
                      text: { body: "RX" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    });

    expect(webhookRes.statusCode).toBe(200);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. In-Cabin Laboratory Panic Value Detection
  // ─────────────────────────────────────────────────────────────────────────────
  it("should accurately evaluate clinical panic critical values", () => {
    // Troponin positive -> PANIC
    const trop = evaluatePanicCriticalValue("Standard Troponin I", "Positive");
    expect(trop.isPanic).toBe(true);
    expect(trop.reason).toContain("Myocardial Infarction");

    // Potassium 6.9 -> PANIC
    const kHigh = evaluatePanicCriticalValue("Serum Potassium (K+)", "6.9");
    expect(kHigh.isPanic).toBe(true);
    expect(kHigh.reason).toContain("Fatal Arrhythmia");

    // Glucose 450 -> PANIC
    const glu = evaluatePanicCriticalValue("Random Blood Sugar (RBS)", "450");
    expect(glu.isPanic).toBe(true);
    expect(glu.reason).toContain("Hyperglycemic Crisis");

    // Platelets 18,000 -> PANIC
    const plt = evaluatePanicCriticalValue("Platelet Count", "18000");
    expect(plt.isPanic).toBe(true);

    // Normal values -> NO PANIC
    const normalHb = evaluatePanicCriticalValue("Complete Blood Count (Hb)", "14.2");
    expect(normalHb.isPanic).toBe(false);
  });

  it("should flag panic alert on appointment when critical lab result is uploaded", async () => {
    const labTest = await LabTest.create({
      organizationId: orgId,
      clinicId,
      name: "Serum Potassium (K+)",
      code: `K_TEST_${Date.now()}`,
      department: "Biochemistry",
      sampleType: "Serum",
      price: 350,
      normalRange: "3.5 - 5.1 mEq/L",
    });

    const labOrder = await LabOrder.create({
      organizationId: orgId,
      clinicId,
      appointmentId: appointmentDoc._id,
      patientId: patientDoc._id,
      testId: labTest._id,
      priority: "stat",
      status: "sample-collected",
    });

    const uploadRes = await app.inject({
      method: "PUT",
      url: `/api/lab-orders/${labOrder._id}/result`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        resultValue: "6.9",
        notes: "Confirmed on repeated aspiration",
      },
    });

    expect(uploadRes.statusCode).toBe(200);

    // Check appointment updated with panic alert
    const updatedAppt: any = await Appointment.findById(appointmentDoc._id).lean();
    expect(updatedAppt.hasPanicAlert).toBe(true);
    expect(updatedAppt.panicAlertDetails).toContain("Hyperkalemia");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. 1-Click Cabin Recall Handshake
  // ─────────────────────────────────────────────────────────────────────────────
  it("should resume standby patient for report review at queue position 1 and trigger cabin recall", async () => {
    // Put patient on standby
    appointmentDoc.status = "standby";
    appointmentDoc.consultationPhase = "initial_pending_investigation";
    appointmentDoc.parkedAt = new Date();
    await appointmentDoc.save();

    const recallRes = await app.inject({
      method: "POST",
      url: `/api/queue/${appointmentDoc._id}/resume-review`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(recallRes.statusCode).toBe(200);
    const body = JSON.parse(recallRes.body);
    expect(body.success).toBe(true);

    const recalledAppt: any = await Appointment.findById(appointmentDoc._id).lean();
    expect(recalledAppt.status).toBe("checked-in");
    expect(recalledAppt.queuePosition).toBe(1);
    expect(recalledAppt.consultationPhase).toBe("report_review");
    expect(recalledAppt.patientReturned).toBe(true);
  });
});
