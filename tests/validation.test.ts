import { describe, it, expect } from "vitest";
import { app } from "../index.js";

describe("Strict Runtime Schema Validation Integration Tests", () => {
  it("should block registration with invalid email format (400 Bad Request)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Test Patient",
        email: "not-a-valid-email",
        password: "Password123"
      }
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain("Validation Error");
    expect(body.message).toContain("email");
  });

  it("should block login with missing password (400 Bad Request)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "patient@test.com"
      }
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain("password");
  });

  it("should block organization creation with missing required admin details (400 Bad Request)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Surat Medical Validation Lab",
        city: "Surat"
        // missing admin name, email, password
      }
    });

    expect(res.statusCode).toBe(400);
  });

  it("should block appointment booking with invalid appointmentType enum (400 Bad Request)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/appointments",
      payload: {
        clinicId: "6a32e2197b789e1d0b9595c2",
        doctorId: "6a32e2197b789e1d0b9595c3",
        appointmentTime: new Date().toISOString(),
        appointmentType: "tele-health" // Invalid: must be walk-in, online, reception, qr
      }
    });

    expect(res.statusCode).toBe(400);
  });

  it("should block invoice creation with empty items list (400 Bad Request)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/invoices",
      payload: {
        patientId: "6a32e2197b789e1d0b9595c2",
        clinicId: "6a32e2197b789e1d0b9595c3",
        doctorId: "6a32e2197b789e1d0b9595c4",
        items: [] // Invalid: must contain at least 1 item
      }
    });

    expect(res.statusCode).toBe(400);
  });
});
