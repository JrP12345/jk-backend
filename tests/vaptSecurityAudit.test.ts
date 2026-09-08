import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Role } from "../models/Role.ts";
import { RefreshToken } from "../models/RefreshToken.ts";
import { generateAccessToken, createRefreshToken } from "../utilities/helpers.ts";
import { resolveWebSocketAuth } from "../notifications/websocket.ts";

describe("VAPT Security & Penetration Testing Audit Suite", () => {
  let orgA: any;
  let orgB: any;
  let clinicA: any;
  let clinicB: any;
  let userA: any;
  let userB: any;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    // Seed default role if needed
    await Role.findOneAndUpdate(
      { name: "admin" },
      { name: "admin", permissions: ["VIEW_CLINICS", "MANAGE_CLINICS", "VIEW_PATIENTS", "MANAGE_ORGANIZATION"] },
      { upsert: true }
    );
    await Role.findOneAndUpdate(
      { name: "patient" },
      { name: "patient", permissions: ["VIEW_APPOINTMENTS", "MANAGE_APPOINTMENTS"] },
      { upsert: true }
    );

    // Setup Tenant A
    orgA = await Organization.create({
      name: "Hospital Alpha",
      city: "New York",
      isActive: true,
      status: "active",
    });

    clinicA = await Clinic.create({
      name: "Alpha Downtown Clinic",
      organizationId: orgA._id,
      city: "New York",
      isActive: true,
    });

    userA = await User.create({
      name: "Admin Alpha",
      email: "admin@alpha.health",
      role: "admin",
      isActive: true,
    });

    await OrgMember.create({
      userId: userA._id,
      organizationId: orgA._id,
      role: "admin",
    });

    tokenA = generateAccessToken({
      id: userA._id.toString(),
      email: userA.email,
      role: userA.role,
      organization_id: orgA._id.toString(),
    });

    // Setup Tenant B
    orgB = await Organization.create({
      name: "Hospital Beta",
      city: "Boston",
      isActive: true,
      status: "active",
    });

    clinicB = await Clinic.create({
      name: "Beta Metro Clinic",
      organizationId: orgB._id,
      city: "Boston",
      isActive: true,
    });

    userB = await User.create({
      name: "Admin Beta",
      email: "admin@beta.health",
      role: "admin",
      isActive: true,
    });

    await OrgMember.create({
      userId: userB._id,
      organizationId: orgB._id,
      role: "admin",
    });

    tokenB = generateAccessToken({
      id: userB._id.toString(),
      email: userB.email,
      role: userB.role,
      organization_id: orgB._id.toString(),
    });
  });

  // ─── 1. VAPT Enterprise Security Headers ───────────────────────────
  describe("1. Security Headers Audit", () => {
    it("should respond with all OWASP standard security headers", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/health",
      });

      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["x-xss-protection"]).toBe("1; mode=block");
      expect(res.headers["strict-transport-security"]).toContain("max-age=31536000");
      expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(res.headers["permissions-policy"]).toContain("geolocation=()");
      expect(res.headers["content-security-policy"]).toBeDefined();
    });
  });

  // ─── 2. NoSQL & Parameter Injection Defense ─────────────────────────
  describe("2. NoSQL & Query Injection Defenses", () => {
    it("should prevent login bypass using NoSQL $gt operator injection", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: {
          email: "admin@alpha.health",
          password: { $gt: "" }, // NoSQL operator attempt
        },
      });

      // Should be rejected by validation or sanitizer with 400
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it("should sanitize query parameters containing mongo operator keys", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/onboarding/clinics",
        headers: {
          authorization: `Bearer ${tokenA}`,
        },
        query: {
          name: { $ne: "none" } as any,
        },
      });

      expect([200, 400]).toContain(res.statusCode);
      // Sanitizer neutralizes operator keys without crashing server
    });
  });

  // ─── 3. IDOR & Tenant Scoping Isolation ─────────────────────────────
  describe("3. Multi-Tenant IDOR & Access Control Audit", () => {
    it("should block User A from modifying or accessing Clinic B from Tenant B", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/onboarding/clinics/${clinicB._id}`,
        headers: {
          authorization: `Bearer ${tokenA}`,
          "x-organization-id": orgA._id.toString(),
        },
        payload: {
          name: "Hijacked Clinic Name",
          city: "Boston",
        },
      });

      expect([403, 404]).toContain(res.statusCode);
      const updatedClinic = await Clinic.findById(clinicB._id);
      expect(updatedClinic?.name).toBe("Beta Metro Clinic"); // Remains unaltered
    });

    it("should prevent cross-tenant OPD queue access", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/queue",
        headers: {
          authorization: `Bearer ${tokenA}`,
        },
        query: {
          clinicId: clinicB._id.toString(),
          doctorId: userB._id.toString(),
        },
      });

      expect([403, 404]).toContain(res.statusCode);
    });
  });

  // ─── 4. CSRF Protection Guard ───────────────────────────────────────
  describe("4. CSRF Defense Audit", () => {
    it("should block cookie-authenticated state mutations from unauthorized origins", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/onboarding/clinics",
        cookies: {
          access_token: tokenA,
        },
        headers: {
          origin: "http://malicious-attacker-site.com",
        },
        payload: {
          name: "Attacker Clinic",
          city: "New York",
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error || body.message).toContain("CSRF");
    });
  });

  // ─── 5. Refresh Token Reuse & Breach Invalidation ───────────────────
  describe("5. Refresh Token Security & Rotation Audit", () => {
    it("should invalidate all sessions if an already-revoked refresh token is replayed", async () => {
      const rawToken1 = await createRefreshToken(userA._id.toString());
      const rawToken2 = await createRefreshToken(userA._id.toString());

      // Consume and rotate rawToken1 once
      const refreshRes = await app.inject({
        method: "POST",
        url: "/api/auth/refresh",
        cookies: {
          refresh_token: rawToken1,
        },
      });
      expect(refreshRes.statusCode).toBe(200);

      // Malicious re-play of the now-revoked rawToken1
      const replayRes = await app.inject({
        method: "POST",
        url: "/api/auth/refresh",
        cookies: {
          refresh_token: rawToken1,
        },
      });

      expect(replayRes.statusCode).toBe(401);
      const replayBody = JSON.parse(replayRes.body);
      expect(replayBody.message).toContain("Revoked session token reuse detected");

      // Verify other active sessions were also revoked in response to breach
      const activeSessions = await RefreshToken.find({
        userId: userA._id,
        revoked: false,
      });
      expect(activeSessions.length).toBe(0);
    });
  });

  // ─── 6. Google OAuth Authentication ────────────────────────────────
  describe("6. Google OAuth Sign-In & Verification", () => {
    it("should authenticate and provision new patient via verified Google token", async () => {
      const testEmail = "google.patient@test.com";
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/google",
        payload: {
          credential: `mock_google_token_${testEmail}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.user.email).toBe(testEmail);
      expect(body.data.user.role).toBe("patient");
      expect(body.data.patient).toBeDefined();

      // Verify cookies set
      const cookies = res.cookies;
      expect(cookies.find((c) => c.name === "access_token")).toBeDefined();
      expect(cookies.find((c) => c.name === "refresh_token")).toBeDefined();
    });

    it("should reject malformed or empty Google credentials", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/google",
        payload: {
          credential: "",
        },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ─── 7. WebSocket Authentication & Validation ───────────────────────
  describe("7. WebSocket Transport & Authorization", () => {
    it("should successfully resolve user from valid WebSocket token parameter", () => {
      const mockReq: any = {
        query: { token: tokenA },
        cookies: {},
        headers: {},
      };

      const resolved = resolveWebSocketAuth(mockReq);
      expect(resolved).not.toBeNull();
      expect(resolved?.id).toBe(userA._id.toString());
      expect(resolved?.role).toBe("admin");
    });

    it("should return null for forged or expired WebSocket token parameter", () => {
      const mockReq: any = {
        query: { token: "forged.fake.token" },
        cookies: {},
        headers: {},
      };

      const resolved = resolveWebSocketAuth(mockReq);
      expect(resolved).toBeNull();
    });
  });
});
