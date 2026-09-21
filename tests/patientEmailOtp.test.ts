import { describe, it, expect, vi } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { emailProvider } from "../notifications/providers/emailProvider.ts";

describe("Patient Email OTP Sign-In & Registration Tests", () => {
  const patientEmail = `patient_otp_${Date.now()}@example.com`;
  const staffEmail = `doctor_otp_${Date.now()}@ananta.internal`;

  it("should request an email OTP and dispatch via emailProvider", async () => {
    const sendEmailSpy = vi.spyOn(emailProvider, "sendEmail").mockResolvedValue(true);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/otp/request",
      payload: {
        email: patientEmail,
        purpose: "authentication",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.email).toBe(patientEmail);
    expect(body.data.devOtp).toBe("123456"); // test environment fixed dev OTP
    expect(sendEmailSpy).toHaveBeenCalled();
  });

  it("should reject invalid OTP when verifying email OTP", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/otp/verify",
      payload: {
        email: patientEmail,
        otp: "999999",
        purpose: "authentication",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.message).toMatch(/Invalid OTP/);
  });

  it("should successfully verify email OTP and create patient user account", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/otp/verify",
      payload: {
        email: patientEmail,
        otp: "123456",
        name: "Devi Patel",
        purpose: "authentication",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.user.email).toBe(patientEmail);
    expect(body.data.user.name).toBe("Devi Patel");
    expect(body.data.user.role).toBe("patient");
    expect(body.data.patient).toBeDefined();

    // Check cookies issued
    const cookies = res.headers["set-cookie"] as string[];
    expect(cookies).toBeDefined();
    expect(cookies.some((c) => c.includes("access_token="))).toBe(true);

    // Verify DB user record
    const dbUser = await User.findOne({ email: patientEmail });
    expect(dbUser).toBeDefined();
    expect(dbUser?.authMethod).toBe("email_otp");
    expect(dbUser?.isEmailVerified).toBe(true);
  });

  it("should log in existing patient seamlessly via email OTP", async () => {
    // Request new OTP
    await app.inject({
      method: "POST",
      url: "/api/auth/otp/request",
      payload: {
        email: patientEmail,
        purpose: "authentication",
      },
    });

    // Verify OTP
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/otp/verify",
      payload: {
        email: patientEmail,
        otp: "123456",
        purpose: "authentication",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.isNewUser).toBe(false);
    expect(body.data.user.email).toBe(patientEmail);
    expect(body.data.user.role).toBe("patient");
  });

  it("should reject staff account attempting to use passwordless email OTP", async () => {
    // Create a doctor staff user
    await User.create({
      name: "Dr. Staff Member",
      email: staffEmail,
      password: "HashedPassword123!",
      role: "doctor",
      authMethod: "email_password",
      isEmailVerified: true,
    });

    // Attempt to request OTP for doctor email
    const reqRes = await app.inject({
      method: "POST",
      url: "/api/auth/otp/request",
      payload: {
        email: staffEmail,
        purpose: "authentication",
      },
    });

    expect(reqRes.statusCode).toBe(400);
    const reqBody = JSON.parse(reqRes.body);
    expect(reqBody.message).toContain("Staff members must sign in using the Staff Email & Password tab");

    // Attempt to verify directly
    const verifyRes = await app.inject({
      method: "POST",
      url: "/api/auth/otp/verify",
      payload: {
        email: staffEmail,
        otp: "123456",
        purpose: "authentication",
      },
    });

    // Rejected as invalid OTP / expired or staff guard
    expect([400, 403]).toContain(verifyRes.statusCode);
  });
});
