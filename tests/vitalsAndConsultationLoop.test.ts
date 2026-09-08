import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { Appointment } from "../models/Appointment.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Observation } from "../models/Observation.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { Prescription } from "../models/Prescription.ts";
import { Invoice } from "../models/Invoice.ts";
import { User } from "../models/User.ts";
import { appointmentService } from "../services/AppointmentService.ts";

describe("Pre-Consultation Vitals, Clinical SOAP Handshake, Pharmacy Queue, STAT Emergency & 7-Day Courtesy", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let adminUserId: string;
  let clinicId: string;
  let doctorId: string;
  let patient1: any;
  let patient2: any;
  let appt1: any;
  let appt2: any;

  beforeAll(async () => {
    // 1. Setup Organization & Admin
    const bootstrapRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Apollo Super Care ${Date.now()}`,
        city: "Bangalore",
        admin_name: "Triage Admin",
        admin_email: `triage_admin_${Date.now()}@apollocare.com`,
        admin_password: "Password123",
        plan: "enterprise",
      },
    });
    expect(bootstrapRes.statusCode).toBe(201);
    adminCookies = (bootstrapRes.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);
    const bootstrapData = JSON.parse(bootstrapRes.body).data;
    orgId = bootstrapData.organization.id;
    adminUserId = bootstrapData.user.id || bootstrapData.user._id;

    // 2. Setup Clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: { name: "Bangalore Central OPD", city: "Bangalore" },
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
        email: `vikram_${Date.now()}@apollocare.com`,
        password: "Password123",
        phone: "+919844444441",
        specialization: "Internal Medicine",
        medicalCouncilRegNumber: `KMC-${Date.now()}`,
      },
    });
    expect(docRes.statusCode).toBe(201);
    doctorId = JSON.parse(docRes.body).data.id;

    // 4. Assign Doctor with standard fee
    await DoctorAssignment.findOneAndUpdate(
      { doctorId, clinicId },
      {
        organizationId: orgId,
        doctorId,
        clinicId,
        fees: 800,
        consultationFee: 800,
        appointmentDuration: 15,
        bookingMode: "sequential_queue",
        workingHours: JSON.stringify({
          mon: [{ start: "09:00", end: "18:00" }],
          tue: [{ start: "09:00", end: "18:00" }],
          wed: [{ start: "09:00", end: "18:00" }],
          thu: [{ start: "09:00", end: "18:00" }],
          fri: [{ start: "09:00", end: "18:00" }],
          sat: [{ start: "09:00", end: "18:00" }],
          sun: [{ start: "09:00", end: "18:00" }],
        }),
        isActive: true,
      },
      { upsert: true, returnDocument: "after" }
    );

    // 5. Create Patient 1 and Patient 2 via Quick Walk-in or direct model
    const { Patient } = await import("../models/Patient.ts");
    patient1 = await Patient.create({
      organizationId: orgId,
      name: "Ramesh Sharma",
      phone: "+919877777771",
      email: `ramesh_${Date.now()}@patient.com`,
      dob: new Date("1982-04-12"),
      gender: "male",
      globalPatientId: `UPI-2026-${Date.now().toString().slice(-7)}`,
    });

    patient2 = await Patient.create({
      organizationId: orgId,
      name: "Sunita Verma",
      phone: "+919877777772",
      email: `sunita_${Date.now()}@patient.com`,
      dob: new Date("1975-09-24"),
      gender: "female",
      globalPatientId: `UPI-2026-${(Date.now() + 1).toString().slice(-7)}`,
    });

    // 6. Create active appointments
    const today = new Date();
    today.setHours(10, 0, 0, 0);

    appt1 = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId,
      patientId: patient1._id,
      appointmentTime: today,
      tokenNumber: 1,
      queuePosition: 1,
      status: "checked-in",
      appointmentType: "walk-in",
    });

    appt2 = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId,
      patientId: patient2._id,
      appointmentTime: today,
      tokenNumber: 2,
      queuePosition: 2,
      status: "checked-in",
      appointmentType: "walk-in",
    });
  });

  it("Step 1: Pre-Consultation Nurse Triage & Vitals Recording creates Observation records & calculates BMI", async () => {
    const vitalsPayload = {
      bpSystolic: 145,
      bpDiastolic: 92,
      pulse: 78,
      temperature: 99.2,
      temperatureUnit: "F",
      spO2: 97,
      weight: 74,
      height: 172,
      bloodSugar: 135,
      bloodSugarType: "random",
      allergies: ["Penicillin", "Sulfa"],
      triageNotes: "Patient reports slight headache and neck stiffness",
    };

    const res = await app.inject({
      method: "POST",
      url: `/api/queue/${appt1._id}/vitals`,
      headers: { cookie: adminCookies.join("; ") },
      payload: vitalsPayload,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.vitals).toBeDefined();
    expect(body.data.vitals.bpSystolic).toBe(145);
    expect(body.data.vitals.bpDiastolic).toBe(92);
    expect(body.data.vitals.pulse).toBe(78);
    expect(body.data.vitals.spO2).toBe(97);
    expect(body.data.vitals.bmi).toBeCloseTo(25.0, 1);
    expect(body.data.vitals.allergies).toContain("Penicillin");

    // Verify Observation documents created in MongoDB
    const observations = await Observation.find({ patientId: patient1._id });
    expect(observations.length).toBeGreaterThanOrEqual(4);
    const bpObs = observations.find((o) => o.code === "BP");
    expect(bpObs).toBeDefined();
    expect(bpObs?.value).toBe("145/92");

    const spo2Obs = observations.find((o) => o.code === "SPO2");
    expect(spo2Obs).toBeDefined();
    expect(spo2Obs?.value).toBe("97");
  });

  it("Step 2: Consultation Conclude automatically writes ClinicalNote (SOAP) and Prescription records", async () => {
    // Doctor calls in patient
    const callInRes = await app.inject({
      method: "PUT",
      url: `/api/appointments/${appt1._id}/status`,
      headers: { cookie: adminCookies.join("; ") },
      payload: { status: "in-consultation" },
    });
    expect(callInRes.statusCode).toBe(200);

    // Doctor completes consultation with medical record
    const completeRes = await app.inject({
      method: "PUT",
      url: `/api/appointments/${appt1._id}/status`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        status: "completed",
        symptoms: "Throbbing headache and persistent elevated BP",
        diagnosis: "Essential Hypertension Stage 1",
        prescriptions: [
          { name: "Amlodipine 5mg", dosage: "1-0-0", duration: "30 days", frequency: "Morning after breakfast", instructions: "Take with water" },
          { name: "Telmisartan 40mg", dosage: "0-0-1", duration: "30 days", frequency: "Night after dinner", instructions: "Avoid dehydration" },
        ],
        followUpRecommended: true,
        followUpTimeline: "7 days",
        followUpNotes: "Repeat BP check and review serum creatinine",
      },
    });

    expect(completeRes.statusCode).toBe(200);
    const updatedAppt = await Appointment.findById(appt1._id);
    expect(updatedAppt?.status).toBe("completed");
    expect(updatedAppt?.diagnosis).toBe("Essential Hypertension Stage 1");

    // Verify ClinicalNote was generated and signed
    const note = await ClinicalNote.findOne({ patientId: patient1._id, isLatest: true });
    expect(note).toBeDefined();
    expect(note?.status).toBe("signed");
    expect(note?.subjective?.chiefComplaint).toBe("Throbbing headache and persistent elevated BP");
    expect(note?.assessment?.diagnoses[0]?.description).toBe("Essential Hypertension Stage 1");
    expect(note?.plan?.prescriptionIds.length).toBe(2);
    expect(note?.signature?.signerName).toContain("Dr. Vikram Seth");

    // Verify Prescription records created in MongoDB
    const rxList = await Prescription.find({ patientId: patient1._id, status: "active" });
    expect(rxList.length).toBe(2);
    const amlo = rxList.find((r) => r.medicineName.includes("Amlodipine"));
    expect(amlo).toBeDefined();
    expect(amlo?.dosage).toBe("1-0-0");
    expect(amlo?.duration).toBe("30 days");
  });

  it("Step 3: In-Clinic Pharmacy Pending Queue immediately receives active prescriptions", async () => {
    const pharmacyRes = await app.inject({
      method: "GET",
      url: `/api/pharmacy/prescriptions/pending?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(pharmacyRes.statusCode).toBe(200);
    const pharmacyData = JSON.parse(pharmacyRes.body);
    expect(pharmacyData.success).toBe(true);

    const pendingOrders = pharmacyData.data || [];
    const patientOrder = pendingOrders.find((p: any) =>
      p.patientId?.name === "Ramesh Sharma" || p.patientId?.id === patient1._id.toString()
    );
    expect(patientOrder).toBeDefined();
    expect(patientOrder.prescriptions.some((m: any) => m.name.includes("Amlodipine"))).toBe(true);
  });

  it("Step 4: STAT Emergency Priority Interruption Protocol moves patient to Position 0", async () => {
    // Patient 2 experiences acute crisis in waiting lounge
    const statRes = await app.inject({
      method: "POST",
      url: `/api/queue/${appt2._id}/stat-emergency`,
      headers: { cookie: adminCookies.join("; ") },
      payload: { reason: "Severe chest pain radiating to left arm, diaphoresis" },
    });

    expect(statRes.statusCode).toBe(200);
    const body = JSON.parse(statRes.body);
    expect(body.success).toBe(true);

    const emergencyAppt = await Appointment.findById(appt2._id);
    expect(emergencyAppt?.isEmergency).toBe(true);
    expect(emergencyAppt?.queuePosition).toBe(0);
    expect(emergencyAppt?.emergencyTriagedAt).toBeDefined();

    // Verify Public Tracker shows STAT Emergency and Vitals payload
    const trackerRes = await app.inject({
      method: "GET",
      url: `/api/public/appointments/${appt2._id}/tracker`,
    });
    expect(trackerRes.statusCode).toBe(200);
    const trackerData = JSON.parse(trackerRes.body).data;
    expect(trackerData.isEmergency).toBe(true);

    // Verify Public TV Queue display puts emergency patient at top of line
    const tvRes = await app.inject({
      method: "GET",
      url: `/api/public/queue/tv?clinicId=${clinicId}`,
    });
    expect(tvRes.statusCode).toBe(200);
    const tvData = JSON.parse(tvRes.body).data;
    const tvTopPatient = tvData.waitingQueue[0];
    expect(tvTopPatient.tokenNumber).toBe(appt2.tokenNumber);
    expect(tvTopPatient.isEmergency).toBe(true);
    expect(tvTopPatient.queuePosition).toBe(0);
  });

  it("Step 5: 7-Day Follow-Up Courtesy Rule waives consultation fee to ₹0", async () => {
    // Schedule a follow-up appointment within 7 days of appt1
    const followUpDate = new Date();
    followUpDate.setDate(followUpDate.getDate() + 5);

    const followUpAppt = await appointmentService.book(
      {
        id: adminUserId,
        role: "admin",
        organizationId: orgId,
      },
      {
        clinicId,
        doctorId,
        patientId: patient1._id.toString(),
        appointmentTime: followUpDate.toISOString(),
        appointmentType: "walk-in",
        reasonForVisit: "follow_up",
        followUpForAppointmentId: appt1._id.toString(),
      },
      orgId
    );

    expect(followUpAppt).toBeDefined();
    expect(followUpAppt.paymentStatus).toBe("not_required");

    // Check generated invoice for ₹0 waiver
    const invoice = await Invoice.findOne({ appointmentId: followUpAppt.id });
    expect(invoice).toBeDefined();
    expect(invoice?.totalAmount).toBe(0);
    expect(invoice?.status).toBe("paid");
    expect(invoice?.paymentMethod).toBe("courtesy_waiver");
    expect(invoice?.items[0]?.description.toLowerCase()).toContain("7-day follow-up courtesy");
  });
});
