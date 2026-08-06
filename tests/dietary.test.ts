import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../index.js";
import { DietOrder } from "../models/DietOrder.ts";

describe("Dietary & Clinical Nutrition Service Integration Tests", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let dietOrderId: string;

  beforeAll(async () => {
    // 1. Create Organization
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Nutrition & Metabolic Hospital",
        subdomain: `dietary-${Date.now()}`,
        admin_email: `admin_dietary_${Date.now()}@ananta.internal`,
        admin_password: "Password123!",
        admin_name: "Head Dietitian",
        city: "Mumbai",
      },
    });
    expect(orgRes.statusCode).toBe(201);
    const orgBody = JSON.parse(orgRes.body);
    orgId = orgBody.data.organization._id || orgBody.data.organization.id;
    adminCookies = orgRes.headers["set-cookie"] as string[];

    // 2. Create Clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Central Clinical Kitchen & Inpatient Wards",
        code: `KITCHEN-${Date.now()}`,
        city: "Mumbai",
        address: "50 Nutrition Boulevard",
        phone: "9100077000",
        email: "kitchen@hospital.com",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;
  });

  afterAll(async () => {
    if (DietOrder) {
      await DietOrder.deleteMany({ clinicId });
    }
  });

  it("should create a therapeutic diet order with allergy alerts & caloric target", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/dietary",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        patientName: "Patient Robert Vance",
        bedNumber: "Bed 302",
        ward: "ICU Ward B",
        dietType: "diabetic_low_carb",
        caloricTarget: 1800,
        allergies: ["Peanuts", "Lactose"],
        specialInstructions: "Carbohydrate limit <= 45g per meal. Serve warm.",
        mealTime: "lunch",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.patientName).toBe("Patient Robert Vance");
    expect(body.data.dietType).toBe("diabetic_low_carb");
    expect(body.data.allergies).toContain("Peanuts");

    dietOrderId = body.data.id;
  });

  it("should fetch diet orders with KPI summary metrics", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/dietary?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.orders.length).toBeGreaterThanOrEqual(1);
    expect(body.data.metrics.totalOrders).toBeGreaterThanOrEqual(1);
    expect(body.data.metrics.allergyCount).toBeGreaterThanOrEqual(1);
  });

  it("should update meal delivery status to delivered & intake percentage", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/dietary/${dietOrderId}/status`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        deliveryStatus: "delivered",
        intakePercentage: 85,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.deliveryStatus).toBe("delivered");
    expect(body.data.intakePercentage).toBe(85);
    expect(body.data.deliveredAt).toBeDefined();
  });
});
