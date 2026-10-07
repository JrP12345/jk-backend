import { provisioningFixtureHeaders, provisionedAdminCookies } from "./helpers/provisioningFixture.ts";
import { trackerFixtureHeaders } from "./helpers/trackerFixture.ts";
import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Medicine } from "../models/Medicine.ts";
import { Prescription } from "../models/Prescription.ts";
import { Invoice } from "../models/Invoice.ts";

describe("In-House Pharmacy Dispensing & Prescription Fulfillment Loop Test Suite", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let locationId: string;
  let doctorId: string;
  let doctorUserId: string;
  let patient: any;
  let appointmentId: string;
  let medicineId: string;
  let prescriptionId: string;

  beforeAll(async () => {
    // 1. Setup Organization & Super Admin
    const bootstrapRes = await app.inject({ headers: await provisioningFixtureHeaders(),
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Fortis Healthcare Group ${Date.now()}`,
        city: "Gurugram",
        admin_name: "Fortis Super Admin",
        admin_email: `fortis_admin_${Date.now()}@fortis.com`,
        admin_password: "Password123",
        plan: "enterprise",
      },
    });
    expect(bootstrapRes.statusCode).toBe(201);
    adminCookies = (await provisionedAdminCookies(bootstrapRes));
    orgId = JSON.parse(bootstrapRes.body).data.organization.id;

    // 2. Setup Location
    const locationRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/locations",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Fortis Memorial Research Institute",
        city: "Gurugram",
        upiVpa: "fortis.pharmacy@hdfc",
        merchantName: "Fortis Pharmacy Dispensary Ltd",
      },
    });
    expect(locationRes.statusCode).toBe(201);
    locationId = JSON.parse(locationRes.body).data.id;

    // 3. Setup Doctor
    const docRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Sandeep Vaishya",
        email: `dr_sandeep_${Date.now()}@fortis.com`,
        password: "Password123",
        specialization: "General Medicine",
        qualification: "MBBS, MD",
        experience: 16,
        consultationFee: 700,
        contactNumber: "+919811002233",
      },
    });
    expect(docRes.statusCode).toBe(201);
    const docData = JSON.parse(docRes.body).data;
    doctorId = docData.id;
    doctorUserId = docData.userId || docData.id;

    // Assign doctor to location
    await DoctorAssignment.create({
      organizationId: orgId,
      doctorId,
      locationId,
      fees: 700,
      workingHours: "[]",
      isActive: true,
    });

    // 4. Setup Patient
    const patUserRes = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Vikram Malhotra",
        email: `vikram_${Date.now()}@gmail.com`,
        password: "Password123",
        phone: "+919876543210",
        role: "patient",
        locationId,
      },
    });
    expect(patUserRes.statusCode).toBe(201);
    const patUserId = JSON.parse(patUserRes.body).data.user.id;

    patient = await Patient.findOne({ userId: patUserId });
    if (!patient) {
      patient = await Patient.create({
        userId: patUserId,
        gender: "male",
        dob: new Date("1988-06-15"),
        organizationId: orgId,
      });
    }
    expect(patient).toBeDefined();

    // 5. Create In-Stock Medicine in Location Inventory
    const medRes = await app.inject({
      method: "POST",
      url: "/api/medicines",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        locationId,
        name: "Augmentin 625mg",
        genericName: "Amoxicillin and Potassium Clavulanate",
        stockQuantity: 100,
        price: 180,
        costPrice: 120,
        batchNumber: "AUG-2026-X1",
        expiryDate: "2027-12-31",
      },
    });
    expect(medRes.statusCode).toBe(201);
    medicineId = JSON.parse(medRes.body).data.id;

    // 6. Create active Appointment for Consultation
    const appt = await Appointment.create({
      organizationId: orgId,
      locationId,
      doctorId,
      patientId: patient._id,
      appointmentTime: new Date().toISOString(),
      appointmentType: "walk-in",
      status: "in-consultation",
      tokenNumber: 42,
      queuePosition: 1,
      paymentStatus: "unpaid",
      paymentAmount: 700,
      notes: "High fever and persistent sore throat for 3 days",
    });
    appointmentId = appt._id.toString();
  });

  it("1. Doctor completes consultation with prescriptions -> creates Prescription records and broadcasts to pharmacy", async () => {
    const completeRes = await app.inject({
      method: "PUT",
      url: `/api/appointments/${appointmentId}/status`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        status: "completed",
        symptoms: "High fever, acute throat pain, productive cough",
        diagnosis: "Acute Pharyngotonsillitis",
        prescriptions: [
          {
            name: "Augmentin 625mg",
            dosage: "1-0-1 (After Meals)",
            frequency: "1-0-1",
            duration: "5 days",
            instructions: "Complete full 5-day course. Do not skip doses.",
          },
        ],
        followUpRecommended: true,
        followUpTimeline: "1 week",
        followUpNotes: "Review throat examination and WBC count if fever persists.",
      },
    });

    expect(completeRes.statusCode).toBe(200);

    // Verify Prescription created in DB with status: 'active'
    const rxDoc = await Prescription.findOne({
      locationId,
      patientId: patient._id,
      medicineName: "Augmentin 625mg",
    });

    expect(rxDoc).toBeTruthy();
    expect(rxDoc?.status).toBe("active");
    expect(rxDoc?.dosage).toBe("1-0-1 (After Meals)");
    expect(rxDoc?.instructions).toBe("Complete full 5-day course. Do not skip doses.");
    prescriptionId = rxDoc!._id.toString();
  });

  it("2. Patient Live Tracker exposes e-Prescription and pharmacyStatus: 'sent_to_pharmacy'", async () => {
    const trackRes = await app.inject({
      method: "GET",
      url: `/api/public/track/${appointmentId}`,
      headers: await trackerFixtureHeaders(appointmentId),
    });

    expect(trackRes.statusCode).toBe(200);
    const data = JSON.parse(trackRes.body).data;

    expect(data.status).toBe("completed");
    expect(data.pharmacyStatus).toBe("sent_to_pharmacy");
    expect(data.consultationSummary).toBeTruthy();
    expect(data.consultationSummary.prescriptions.length).toBe(1);

    const rx = data.consultationSummary.prescriptions[0];
    expect(rx.medicineName).toBe("Augmentin 625mg");
    expect(rx.dosage).toBe("1-0-1 (After Meals)");
    expect(rx.duration).toBe("5 days");
    expect(rx.status).toBe("active");
  });

  it("3. Pharmacy Desk retrieves pending prescription group for dispensing", async () => {
    const pendingRes = await app.inject({
      method: "GET",
      url: `/api/pharmacy/pending-prescriptions?locationId=${locationId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(pendingRes.statusCode).toBe(200);
    const groups = JSON.parse(pendingRes.body).data;
    expect(groups.length).toBeGreaterThan(0);

    const match = groups.find((g: any) =>
      g.prescriptions.some((p: any) => p.id === prescriptionId)
    );
    expect(match).toBeTruthy();
    expect(match.tokenNumber).toBe(42);
    expect(match.patientId.name).toBe("Vikram Malhotra");
  });

  it("4. Pharmacist dispenses medicines -> updates stock, marks prescription dispensed & appends invoice", async () => {
    const dispenseRes = await app.inject({
      method: "POST",
      url: "/api/pharmacy/dispense",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        patientId: patient._id.toString(),
        locationId,
        doctorId: doctorUserId,
        appointmentId,
        prescriptionIds: [prescriptionId],
        items: [{ medicineId, quantity: 10 }],
      },
    });

    expect(dispenseRes.statusCode).toBe(201);
    const invoiceData = JSON.parse(dispenseRes.body).data;
    expect(invoiceData.items.length).toBeGreaterThan(0);

    // Verify stock deduction in DB (100 - 10 = 90)
    const medDoc = await Medicine.findById(medicineId);
    expect(medDoc?.stockQuantity).toBe(90);

    // Verify Prescription status transitioned to 'dispensed'
    const rxDoc = await Prescription.findById(prescriptionId);
    expect(rxDoc?.status).toBe("dispensed");
  });

  it("5. Patient Live Tracker instantly reflects pharmacyStatus: 'dispensed' and itemized pharmacy charges", async () => {
    const trackRes = await app.inject({
      method: "GET",
      url: `/api/public/track/${appointmentId}`,
      headers: await trackerFixtureHeaders(appointmentId),
    });

    expect(trackRes.statusCode).toBe(200);
    const data = JSON.parse(trackRes.body).data;

    expect(data.pharmacyStatus).toBe("dispensed");
    expect(data.consultationSummary.prescriptions[0].status).toBe("dispensed");

    // Check that billing includes pharmacy charge items
    expect(data.billing).toBeTruthy();
    const hasPharmacyItem = data.billing.items.some((it: any) =>
      it.description.toLowerCase().includes("augmentin") ||
      it.description.toLowerCase().includes("prescription medicine")
    );
    expect(hasPharmacyItem).toBe(true);
  });
});
