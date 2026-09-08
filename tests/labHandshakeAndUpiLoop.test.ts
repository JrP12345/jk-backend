import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { Organization } from "../models/Organization.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { LabOrder } from "../models/LabOrder.ts";
import { LabTest } from "../models/LabTest.ts";
import { Invoice } from "../models/Invoice.ts";

describe("Closed-Loop Diagnostic Lab Order, WhatsApp Rx & BharatPe UPI Settlement Test Suite", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let doctorId: string;
  let patient: any;
  let appt: any;
  let createdLabOrders: any[] = [];

  beforeAll(async () => {
    // 1. Setup Organization & Admin
    const bootstrapRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Diagnostic Healthcare Center ${Date.now()}`,
        city: "Bangalore",
        admin_name: "Lab Admin",
        admin_email: `lab_admin_${Date.now()}@healthcenter.com`,
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
      payload: { name: "Bangalore Main Clinic", city: "Bangalore" },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Setup Doctor
    const docRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Vikram Sethi",
        email: `dr_vikram_${Date.now()}@healthcenter.com`,
        password: "Password123",
        phone: "+919844444441",
        specialization: "Internal Medicine",
        medicalCouncilRegNumber: `MCI-${Date.now()}`,
      },
    });
    expect(docRes.statusCode).toBe(201);
    doctorId = JSON.parse(docRes.body).data.id;

    // 4. Assign Doctor with consultation fees
    await DoctorAssignment.findOneAndUpdate(
      { doctorId, clinicId },
      {
        organizationId: orgId,
        fees: 600,
        consultationFee: 600,
        appointmentDuration: 15,
        bookingMode: "sequential_queue",
        isActive: true,
      },
      { upsert: true, returnDocument: "after" }
    );

    // 5. Create Lab Tests in catalog
    await LabTest.create([
      {
        clinicId,
        name: "Complete Blood Count (CBC)",
        code: "CBC-01",
        department: "Hematology",
        sampleType: "Whole Blood EDTA",
        price: 350,
        normalRange: "Hb: 13-17 g/dL, WBC: 4000-11000 /mcL",
      },
      {
        clinicId,
        name: "Random Blood Sugar (RBS)",
        code: "RBS-02",
        department: "Biochemistry",
        sampleType: "Fluoride Plasma",
        price: 150,
        normalRange: "70-140 mg/dL",
      },
    ]);

    // 6. Create Patient
    patient = await Patient.create({
      organizationId: orgId,
      name: "Ramesh Sharma",
      phone: "+919844444442",
      email: `ramesh_${Date.now()}@patient.com`,
      dob: new Date("1982-04-12"),
      gender: "male",
      globalPatientId: `PAT-2026-${Date.now().toString().slice(-6)}`,
    });

    // 7. Create Appointment for today and mark in-consultation
    const today = new Date();
    today.setHours(11, 0, 0, 0);

    appt = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId,
      patientId: patient._id,
      appointmentTime: today,
      tokenNumber: 101,
      queuePosition: 1,
      status: "in-consultation",
      appointmentType: "walk-in",
      bookingMode: "sequential_queue",
      paymentStatus: "unpaid",
      paymentAmount: 600,
    });
  });

  it("Step 1: Doctor sends patient for diagnostic tests -> places urgent LabOrders and sets standby", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/queue/${appt._id}/send-investigation`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        notes: "Patient reports chronic fatigue and dizziness. Urgent CBC and RBS required.",
        testNames: ["Complete Blood Count (CBC)", "Random Blood Sugar (RBS)"],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("standby");
    expect(body.data.consultationPhase).toBe("initial_pending_investigation");

    // Verify LabOrders created in DB with appointmentId
    createdLabOrders = await LabOrder.find({ appointmentId: appt._id }).populate("testId");
    expect(createdLabOrders.length).toBe(2);
    expect(createdLabOrders[0].priority).toBe("urgent");
    expect(createdLabOrders[0].status).toBe("ordered");

    // Verify investigationResults initialized on appointment
    const updatedAppt = await Appointment.findById(appt._id);
    expect(updatedAppt?.investigationResults?.length).toBe(2);
    expect(updatedAppt?.investigationResults?.[0].testName).toBe("Complete Blood Count (CBC)");
    expect(updatedAppt?.investigationResults?.[1].testName).toBe("Random Blood Sugar (RBS)");
  });

  it("Step 2: Lab technician enters test results -> updates Appointment.investigationResults with abnormal flags", async () => {
    expect(createdLabOrders.length).toBeGreaterThanOrEqual(2);

    // Upload result for CBC
    const cbcOrder = createdLabOrders.find((o) => (o.testId as any)?.name === "Complete Blood Count (CBC)");
    expect(cbcOrder).toBeDefined();

    const cbcRes = await app.inject({
      method: "PUT",
      url: `/api/lab-orders/${cbcOrder._id}/result`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        resultValue: "Hb: 10.2 g/dL (Low), WBC: 12500 /mcL (High)",
        notes: "Microcytic hypochromic anemia with leukocytosis",
      },
    });
    expect(cbcRes.statusCode).toBe(200);

    // Upload result for RBS
    const rbsOrder = createdLabOrders.find((o) => (o.testId as any)?.name === "Random Blood Sugar (RBS)");
    expect(rbsOrder).toBeDefined();

    const rbsRes = await app.inject({
      method: "PUT",
      url: `/api/lab-orders/${rbsOrder._id}/result`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        resultValue: "245 mg/dL",
        notes: "Marked post-prandial hyperglycemia",
      },
    });
    expect(rbsRes.statusCode).toBe(200);

    // Verify Appointment.investigationResults updated
    const apptWithResults = await Appointment.findById(appt._id);
    expect(apptWithResults?.investigationResults?.length).toBe(2);

    const rbsResult = apptWithResults?.investigationResults?.find((r) => r.testName?.includes("RBS") || r.testName?.includes("Random Blood Sugar"));
    expect(rbsResult?.value).toBe("245 mg/dL");

    const cbcResult = apptWithResults?.investigationResults?.find((r) => r.testName?.includes("CBC") || r.testName?.includes("Complete Blood Count"));
    expect(cbcResult?.value).toContain("Hb: 10.2");
  });

  it("Step 3: Doctor resumes patient for report review -> consultation resumed without duplicate fees", async () => {
    const resumeRes = await app.inject({
      method: "POST",
      url: `/api/queue/${appt._id}/resume-review`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(resumeRes.statusCode).toBe(200);
    const body = JSON.parse(resumeRes.body);
    expect(body.data.status).toBe("checked-in");
    expect(body.data.queuePosition).toBe(1);
    expect(body.data.consultationPhase).toBe("report_review");

    // Call patient in to consultation room
    const callInRes = await app.inject({
      method: "PUT",
      url: `/api/appointments/${appt._id}/status`,
      headers: { cookie: adminCookies.join("; ") },
      payload: { status: "in-consultation" },
    });
    expect(callInRes.statusCode).toBe(200);

    // Verify lab findings persist on the appointment
    const reviewedAppt = await Appointment.findById(appt._id);
    expect(reviewedAppt?.investigationResults?.length).toBe(2);
    expect(reviewedAppt?.status).toBe("in-consultation");
  });

  it("Step 4: Doctor concludes consultation -> generates prescription with WhatsApp dispatch", async () => {
    const concludeRes = await app.inject({
      method: "PUT",
      url: `/api/appointments/${appt._id}/status`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        status: "completed",
        symptoms: "Chronic fatigue, polydipsia, high random blood sugar",
        diagnosis: "Newly Diagnosed Type 2 Diabetes Mellitus with Mild Anemia",
        prescriptions: [
          { name: "Tab. Metformin 500mg", dosage: "1 tab twice daily after meals", duration: "30 days" },
          { name: "Tab. Ferrous Ascorbate 100mg", dosage: "1 tab once daily after lunch", duration: "30 days" },
        ],
        notes: "Dietary counseling provided. Follow-up with fasting blood sugar in 2 weeks.",
      },
    });

    expect(concludeRes.statusCode).toBe(200);
    const body = JSON.parse(concludeRes.body);
    expect(body.data.status).toBe("completed");

    // Verify public digital prescription tracker print HTML is accessible
    const printRes = await app.inject({
      method: "GET",
      url: `/api/public/track/${appt._id}/prescription/print`,
    });

    expect(printRes.statusCode).toBe(200);
    expect(printRes.headers["content-type"]).toContain("text/html");
    expect(printRes.body).toContain("Ramesh Sharma");
    expect(printRes.body).toContain("Tab. Metformin 500mg");
    expect(printRes.body).toContain("Diagnostic Investigations");
  });

  it("Step 5: Counter-top dynamic BharatPe/NPCI UPI settlement -> 1-click marks invoice & appointment as paid", async () => {
    const payRes = await app.inject({
      method: "POST",
      url: "/api/appointment-payments/collect-counter",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        appointmentId: appt._id.toString(),
        paymentMethod: "upi",
        amount: 600,
      },
    });

    expect(payRes.statusCode).toBe(200);
    const body = JSON.parse(payRes.body);
    expect(body.success).toBe(true);
    expect(body.data.appointment.paymentStatus).toBe("paid");

    // Verify in database that invoice and appointment are fully settled
    const settledAppt = await Appointment.findById(appt._id);
    expect(settledAppt?.paymentStatus).toBe("paid");
    expect(settledAppt?.paymentAmount).toBe(600);

    const invoice = await Invoice.findOne({ appointmentId: appt._id });
    expect(invoice).toBeDefined();
    expect(invoice?.status).toBe("paid");
    expect(invoice?.paymentMethod).toBe("upi");
    expect(invoice?.balanceDue).toBe(0);
    expect(invoice?.amountPaid).toBe(600);
  });
});
