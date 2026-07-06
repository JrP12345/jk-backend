import { describe, it, expect } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { RefreshToken } from "../models/RefreshToken.ts";

describe("Auth API Integration Tests", () => {
  const patientEmail = "testpatient@healthos.com";
  const password = "Password123";

  it("should fail self-registration with missing fields", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "partial@test.com",
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
  });

  it("should successfully register a patient", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "John Doe",
        email: patientEmail,
        password: password,
        phone: "1234567890",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.data.user.email).toBe(patientEmail);
    expect(body.data.user.role).toBe("patient");

    // Check cookies
    const cookies = response.cookies;
    const accessToken = cookies.find((c) => c.name === "access_token");
    const refreshToken = cookies.find((c) => c.name === "refresh_token");
    expect(accessToken).toBeDefined();
    expect(refreshToken).toBeDefined();

    // Verify DB entry
    const user = await User.findOne({ email: patientEmail });
    expect(user).not.toBeNull();
    expect(user!.role).toBe("patient");

    const patient = await Patient.findOne({ userId: user!._id });
    expect(patient).not.toBeNull();
  });

  it("should fail registration with duplicate email", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Another Doe",
        email: patientEmail,
        password: password,
      },
    });

    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
  });

  it("should login registered user successfully", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: patientEmail,
        password: password,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.data.user.role).toBe("patient");

    const accessToken = response.cookies.find((c) => c.name === "access_token");
    expect(accessToken).toBeDefined();
  });

  it("should fail login with wrong credentials", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: patientEmail,
        password: "WrongPassword",
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it("should fetch current user profile via /api/auth/me", async () => {
    // Login to get cookie
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: patientEmail,
        password: password,
      },
    });

    const accessTokenCookie = loginRes.headers["set-cookie"];

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: {
        cookie: Array.isArray(accessTokenCookie) ? accessTokenCookie.join("; ") : accessTokenCookie,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.data.user.email).toBe(patientEmail);
    // Ensure sensitive data is not returned
    expect(body.data.user.password).toBeUndefined();
    expect(body.data.user.privateKey).toBeUndefined();
    expect(body.data.user.publicKey).toBeUndefined();
  });

  it("should refresh the access token", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: patientEmail,
        password: password,
      },
    });

    const setCookies = loginRes.headers["set-cookie"];

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      headers: {
        cookie: Array.isArray(setCookies) ? setCookies.join("; ") : setCookies,
      },
    });

    expect(response.statusCode).toBe(200);
    const cookies = response.cookies;
    const accessToken = cookies.find((c) => c.name === "access_token");
    expect(accessToken).toBeDefined();
  });

  it("should logout successfully", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: patientEmail,
        password: password,
      },
    });

    const setCookies = loginRes.headers["set-cookie"];

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        cookie: Array.isArray(setCookies) ? setCookies.join("; ") : setCookies,
      },
    });

    expect(response.statusCode).toBe(200);

    // Verify all refresh tokens are revoked in database
    const user = await User.findOne({ email: patientEmail });
    const count = await RefreshToken.countDocuments({ userId: user!._id, revoked: false });
    expect(count).toBe(0);
  });
});
