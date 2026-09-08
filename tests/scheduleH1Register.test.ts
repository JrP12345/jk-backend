import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { Medicine } from "../models/Medicine.ts";
import { ScheduleH1Register } from "../models/ScheduleH1Register.ts";
import { addBatchToMedicine, dispenseMedicineFEFO } from "../services/PharmacyInventoryService.ts";

describe("Statutory Schedule H1 / Schedule X Pharmacy Register Test Suite", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let generalMedicineId: string;
  let scheduleH1MedicineId: string;

  beforeAll(async () => {
    // 1. Setup Organization & Super Admin
    const bootstrapRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Apollo Pharmacy Network ${Date.now()}`,
        city: "Hyderabad",
        admin_name: "Apollo Pharmacy Admin",
        admin_email: `apollo_pharm_${Date.now()}@test.org`,
        admin_password: "Password123!",
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
        name: "Apollo Jubilee Hills Dispensary",
        city: "Hyderabad",
        upiVpa: "apollo.dispensary@icici",
        merchantName: "Apollo Dispensaries Ltd",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Create General OTC Medicine (Paracetamol)
    const genMed = await Medicine.create({
      clinicId,
      name: "Dolo 650",
      genericName: "Paracetamol",
      scheduleType: "general",
      price: 30,
      costPrice: 18,
      stockQuantity: 0,
    });
    generalMedicineId = genMed._id.toString();

    // 4. Create Schedule H1 Medicine (Alprazolam)
    const h1Med = await Medicine.create({
      clinicId,
      name: "Alprax 0.5mg",
      genericName: "Alprazolam",
      scheduleType: "schedule_h1",
      price: 65,
      costPrice: 40,
      stockQuantity: 0,
    });
    scheduleH1MedicineId = h1Med._id.toString();

    // Add Batches
    await addBatchToMedicine({
      medicineId: generalMedicineId,
      clinicId,
      batchNumber: "DOLO-BATCH-01",
      expiryDate: new Date(Date.now() + 180 * 24 * 3600 * 1000),
      quantity: 100,
      purchaseCost: 18,
      sellingPrice: 30,
    });

    await addBatchToMedicine({
      medicineId: scheduleH1MedicineId,
      clinicId,
      batchNumber: "ALPX-BATCH-99",
      expiryDate: new Date(Date.now() + 180 * 24 * 3600 * 1000),
      quantity: 50,
      purchaseCost: 40,
      sellingPrice: 65,
    });
  });

  it("should NOT create a ScheduleH1Register entry when dispensing general medication", async () => {
    const initialCount = await ScheduleH1Register.countDocuments({ clinicId });

    await dispenseMedicineFEFO(generalMedicineId, clinicId, 10, null, {
      organizationId: orgId,
      patientName: "John Doe",
      patientAddress: "123 Road, Hyderabad",
    });

    const afterCount = await ScheduleH1Register.countDocuments({ clinicId });
    expect(afterCount).toBe(initialCount);
  });

  it("should automatically record a statutory ScheduleH1Register entry when dispensing Schedule H1 medicine", async () => {
    const initialCount = await ScheduleH1Register.countDocuments({ clinicId });

    await dispenseMedicineFEFO(scheduleH1MedicineId, clinicId, 5, null, {
      organizationId: orgId,
      patientName: "Ramesh Sharma",
      patientAddress: "Plot 42, Jubilee Hills, Hyderabad",
      patientPhone: "9876543210",
      doctorName: "Dr. Arvind Rao",
      doctorRegNumber: "TSMC/2012/84729",
      dispensedByName: "Pharmacist Priya",
    });

    const afterCount = await ScheduleH1Register.countDocuments({ clinicId });
    expect(afterCount).toBe(initialCount + 1);

    const record = await ScheduleH1Register.findOne({
      clinicId,
      medicineId: scheduleH1MedicineId,
    });

    expect(record).toBeDefined();
    expect(record?.medicineName).toBe("Alprax 0.5mg");
    expect(record?.scheduleType).toBe("schedule_h1");
    expect(record?.batchNumber).toBe("ALPX-BATCH-99");
    expect(record?.quantityDispensed).toBe(5);
    expect(record?.patientName).toBe("Ramesh Sharma");
    expect(record?.patientAddress).toBe("Plot 42, Jubilee Hills, Hyderabad");
    expect(record?.doctorName).toBe("Dr. Arvind Rao");
    expect(record?.doctorRegNumber).toBe("TSMC/2012/84729");
  });

  it("should return paginated statutory records via GET /api/pharmacy/schedule-h1-register", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/pharmacy/schedule-h1-register?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toBeDefined();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0].scheduleType).toBe("schedule_h1");
    expect(body.pagination.total).toBeGreaterThanOrEqual(1);
  });

  it("should generate statutory compliance export via GET /api/pharmacy/schedule-h1-register/export", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/pharmacy/schedule-h1-register/export?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.statutoryAct).toMatch(/Drugs and Cosmetics Rules/i);
    expect(body.data.totalRecords).toBeGreaterThanOrEqual(1);
    expect(body.data.records[0].patientAddress).toBe("Plot 42, Jubilee Hills, Hyderabad");
  });
});
