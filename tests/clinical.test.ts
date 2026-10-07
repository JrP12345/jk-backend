import { provisioningFixtureHeaders, provisionedAdminCookies } from "./helpers/provisioningFixture.ts";
import { reuseOnboardingLocation } from "./helpers/locationEssentialsSetup.ts";
import { describe, it, expect } from "vitest";
import { app } from "../index.ts";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Medicine } from "../models/Medicine.ts";
import { LabTest } from "../models/LabTest.ts";
import { LabOrder } from "../models/LabOrder.ts";

describe("Clinical Modules API Integration Tests (Pharmacy, Lab)", () => {
  let adminCookies: string[] = [];
  let locationId: string;
  let patientId: string;
  let medicineId: string;
  let testId: string;
  let orderId: string;

  it("should setup basic requirements", async () => {
    // 1. Create org + admin
    const bootstrapRes = await app.inject({ headers: await provisioningFixtureHeaders(),
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
    adminCookies = (await provisionedAdminCookies(bootstrapRes));

    // 2. Create location
    const locationRes = await reuseOnboardingLocation(app, {
      headers: { cookie: adminCookies.join("; ") },
      payload: { name: "Pharmacy & Lab Branch", city: "Surat" },
    });
    locationId = JSON.parse(locationRes.body).data.id;

    // 3. Register patient
    const patRes = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { locationId: locationId,  name: "Kishore Kumar", email: "kishore@test.com", password: "Password123" },
    });
    const patUser = await User.findOne({ email: "kishore@test.com" });
    const patProfile = await Patient.findOne({ userId: patUser!._id });
    patientId = patProfile!._id.toString();
  });

  // ─── Pharmacy Module ──────────────────────────────────────────
  it("should add stock and dispense medicines", async () => {
    // 1. Add Medicine
    const medRes = await app.inject({
      method: "POST",
      url: "/api/medicines",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        locationId: locationId,
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
        locationId: locationId,
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
        locationId: locationId,
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
        locationId: locationId,
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
        value: "Normal CBC",
        notes: "WBC count is slightly elevated.",
      },
    });
    expect(resultRes.statusCode).toBe(200);
    const orderObj = await LabOrder.findById(orderId);
    expect(orderObj!.status).toBe("result-uploaded");
  });
});
