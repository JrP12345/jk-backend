import { describe, it, expect } from "vitest";
import { app } from "../index.js";
import { Medicine } from "../models/Medicine.ts";

describe("List Pagination API Integration Tests", () => {
  let adminCookies: string[] = [];
  let clinicId: string;

  it("should setup organization and clinic", async () => {
    // 1. Create org + admin
    const bootstrapRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Surat Pagination Hub ${Date.now()}`,
        city: "Surat",
        admin_name: "Karan Johar",
        admin_email: `karan.pagination_${Date.now()}@test.com`,
        admin_password: "Password123",
        plan: "enterprise",
      },
    });
    expect(bootstrapRes.statusCode).toBe(201);
    adminCookies = (bootstrapRes.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);

    // 2. Create clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: { name: "Pagination Branch", city: "Surat" },
    });
    clinicId = JSON.parse(clinicRes.body).data.id;
  });

  it("should create 5 medicine records for testing pagination", async () => {
    const medNames = ["Paracetamol", "Ibuprofen", "Amoxicillin", "Metformin", "Atorvastatin"];

    for (let i = 0; i < medNames.length; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/medicines",
        headers: { cookie: adminCookies.join("; ") },
        payload: {
          clinicId,
          name: medNames[i],
          genericName: `Generic ${medNames[i]}`,
          stockQuantity: 100,
          price: 10 + i * 2,
          costPrice: 5 + i,
          expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
          batchNumber: `BAT-${100 + i}`,
        },
      });
      expect(res.statusCode).toBe(201);
    }

    const count = await Medicine.countDocuments({ clinicId });
    expect(count).toBe(5);
  });

  it("should paginate medicines list and return correct headers for page 1", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/medicines?clinicId=${clinicId}&limit=2&page=1`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.length).toBe(2);

    // Verify pagination headers
    expect(res.headers["x-total-count"]).toBe("5");
    expect(res.headers["x-total-pages"]).toBe("3");
    expect(res.headers["x-current-page"]).toBe("1");
    expect(res.headers["x-page-size"]).toBe("2");
    expect(res.headers["access-control-expose-headers"]).toContain("X-Total-Count");
  });

  it("should paginate medicines list and return correct headers for page 3", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/medicines?clinicId=${clinicId}&limit=2&page=3`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.length).toBe(1);

    // Verify pagination headers
    expect(res.headers["x-total-count"]).toBe("5");
    expect(res.headers["x-total-pages"]).toBe("3");
    expect(res.headers["x-current-page"]).toBe("3");
    expect(res.headers["x-page-size"]).toBe("2");
  });

  it("should return empty list and correct headers for out of bounds page", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/medicines?clinicId=${clinicId}&limit=2&page=4`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.length).toBe(0);

    // Verify pagination headers
    expect(res.headers["x-total-count"]).toBe("5");
    expect(res.headers["x-total-pages"]).toBe("3");
    expect(res.headers["x-current-page"]).toBe("4");
    expect(res.headers["x-page-size"]).toBe("2");
  });
});
