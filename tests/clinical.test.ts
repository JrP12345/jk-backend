import { describe, it, expect } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Bed } from "../models/Bed.ts";
import { Admission } from "../models/Admission.ts";
import { Medicine } from "../models/Medicine.ts";
import { LabTest } from "../models/LabTest.ts";
import { LabOrder } from "../models/LabOrder.ts";

describe("Clinical Modules API Integration Tests (Stays, Pharmacy, Lab)", () => {
  let adminCookies: string[] = [];
  let clinicId: string;
  let patientId: string;
  let bedId: string;
  let admissionId: string;
  let medicineId: string;
  let testId: string;
  let orderId: string;

  it("should setup basic requirements", async () => {
    // 1. Create org + admin
    const bootstrapRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Surat Multispecialty",
        city: "Surat",
        admin_name: "Vinod Khanna",
        admin_email: "vinod@test.com",
        admin_password: "Password123",
      },
    });
    adminCookies = bootstrapRes.headers["set-cookie"] as string[];

    // 2. Create clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: { name: "Admissions & Meds Branch", city: "Surat" },
    });
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Register patient
    const patRes = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Kishore Kumar", email: "kishore@test.com", password: "Password123" },
    });
    const patUser = await User.findOne({ email: "kishore@test.com" });
    const patProfile = await Patient.findOne({ userId: patUser!._id });
    patientId = patProfile!._id.toString();
  });

  // ─── Bed & Admission Module ──────────────────────────────────
  it("should create bed and admit patient successfully", async () => {
    // 1. Create Bed
    const bedRes = await app.inject({
      method: "POST",
      url: "/api/beds",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId: clinicId,
        wardName: "ICU Ward",
        bedNumber: "ICU-01",
        pricePerDay: 1500,
      },
    });
    expect(bedRes.statusCode).toBe(201);
    bedId = JSON.parse(bedRes.body).data.id;

    // 2. Admit patient
    const admitRes = await app.inject({
      method: "POST",
      url: "/api/admissions",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId: clinicId,
        patientId: patientId,
        bedId: bedId,
        doctorInCharge: (await User.findOne({ email: "vinod@test.com" }))!._id.toString(), // Admin acting as doctor in charge for simplicity
        reasonForAdmission: "Suffering from severe respiratory infection",
      },
    });

    expect(admitRes.statusCode).toBe(201);
    const body = JSON.parse(admitRes.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("admitted");
    admissionId = body.data.id;

    // Verify bed is occupied
    const bedObj = await Bed.findById(bedId);
    expect(bedObj!.status).toBe("occupied");
  });

  it("should discharge patient and generate final billing stay info", async () => {
    const dischargeRes = await app.inject({
      method: "PUT",
      url: `/api/admissions/${admissionId}/discharge`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        dischargeSummary: "Fully recovered, discharged under safe condition",
      },
    });

    expect(dischargeRes.statusCode).toBe(200);
    const body = JSON.parse(dischargeRes.body);
    expect(body.success).toBe(true);

    const bedObj = await Bed.findById(bedId);
    expect(bedObj!.status).toBe("available");
  });

  // ─── Pharmacy Module ──────────────────────────────────────────
  it("should add stock and dispense medicines", async () => {
    // 1. Add Medicine
    const medRes = await app.inject({
      method: "POST",
      url: "/api/medicines",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId: clinicId,
        name: "Paracetamol 650mg",
        genericName: "Acetaminophen",
        batchNumber: "P-542",
        expiryDate: "2028-12-31T00:00:00.000Z",
        stockQuantity: 100,
        costPrice: 1,
        price: 5,
        location: "Rack A-3",
      },
    });

    expect(medRes.statusCode).toBe(201);
    medicineId = JSON.parse(medRes.body).data.id;

    // 2. Dispense medicine
    const dispenseRes = await app.inject({
      method: "POST",
      url: "/api/pharmacy/dispense",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId: clinicId,
        patientId: patientId,
        items: [{ medicineId: medicineId, quantity: 10 }],
      },
    });

    expect(dispenseRes.statusCode).toBe(201);
    const body = JSON.parse(dispenseRes.body);
    expect(body.success).toBe(true);

    // Verify stock deduction
    const medObj = await Medicine.findById(medicineId);
    expect(medObj!.stockQuantity).toBe(90);
  });

  // ─── Laboratory Module ────────────────────────────────────────
  it("should manage test catalogs and laboratory assay workflows", async () => {
    // 1. Add diagnostic lab test
    const labTestRes = await app.inject({
      method: "POST",
      url: "/api/lab-tests",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId: clinicId,
        code: "CBC",
        name: "Complete Blood Count",
        department: "Hematology",
        sampleType: "Blood",
        normalRange: "4.5 - 11.0 k/uL",
        price: 150,
      },
    });
    expect(labTestRes.statusCode).toBe(201);
    testId = JSON.parse(labTestRes.body).data.id;

    // 2. Place lab work order
    const docUser = await User.findOne({ email: "vinod@test.com" });
    const orderRes = await app.inject({
      method: "POST",
      url: "/api/lab-orders",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId: clinicId,
        patientId: patientId,
        doctorId: docUser!._id.toString(),
        testId: testId,
      },
    });
    expect(orderRes.statusCode).toBe(201);
    orderId = JSON.parse(orderRes.body).data.id;

    // 3. Draw sample
    const sampleRes = await app.inject({
      method: "PUT",
      url: `/api/lab-orders/${orderId}/sample`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(sampleRes.statusCode).toBe(200);

    // 4. Finalize result
    const resultRes = await app.inject({
      method: "PUT",
      url: `/api/lab-orders/${orderId}/result`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        resultValue: "Normal CBC",
        resultNotes: "WBC count is slightly elevated.",
      },
    });
    expect(resultRes.statusCode).toBe(200);
    const orderObj = await LabOrder.findById(orderId);
    expect(orderObj!.status).toBe("result-uploaded");
  });
});
