import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import app from "../index.js";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { RefreshToken } from "../models/RefreshToken.ts";
import { SiteVisit } from "../models/SiteVisit.ts";

describe("Root Single-Session Security, Session Supervision & Traffic Analytics", () => {
  let rootUser: any;
  let rootPassword = "Password123!";
  let rootCookie1: string;
  let rootCookie2: string;
  let regularDoctorUser: any;
  let doctorPassword = "Password123!";
  let testOrg: any;
  let testClinic: any;

  beforeAll(async () => {
    // 1. Create Root Admin User
    rootUser = await (User as any).create({
      name: "Root Supervision Master",
      email: `root_supervise_${Date.now()}@platform.internal`,
      password: await bcrypt.hash(rootPassword, 10),
      role: "root",
      isActive: true,
    });

    // 2. Create Tenant Organization and Clinic
    testOrg = await (Organization as any).create({
      name: "Supervision General Hospital",
      city: "Surat",
      email: `sgh_${Date.now()}@hospital.org`,
      plan: "pro",
      isActive: true,
    });

    testClinic = await (Clinic as any).create({
      organizationId: testOrg._id,
      name: "City OPD Branch",
      city: "Surat",
      isActive: true,
    });

    // 3. Create Regular Doctor User
    regularDoctorUser = await (User as any).create({
      name: "Dr. Traffic Tester",
      email: `traffic_tester_${Date.now()}@hospital.org`,
      password: await bcrypt.hash(doctorPassword, 10),
      role: "doctor",
      organization_id: testOrg._id,
      isActive: true,
    });
  });

  afterAll(async () => {
    // Cleanup created test records
    await User.deleteMany({ _id: { $in: [rootUser._id, regularDoctorUser._id] } });
    await Organization.deleteOne({ _id: testOrg._id });
    await Clinic.deleteOne({ _id: testClinic._id });
    await RefreshToken.deleteMany({ userId: { $in: [rootUser._id, regularDoctorUser._id] } });
    await SiteVisit.deleteMany({ clinicId: testClinic._id });
  });

  // ─── 1. Root Single-Session Enforcement ─────────────────────────────
  it("enforces that Root can only be logged in 1 time; new root login revokes earlier root session", async () => {
    // Login Root Session 1
    const login1 = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: rootUser.email, password: rootPassword },
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0" },
    });
    expect(login1.statusCode).toBe(200);
    const cookies1 = login1.headers["set-cookie"];
    expect(cookies1).toBeDefined();
    const cookieArray1 = Array.isArray(cookies1) ? cookies1 : [cookies1 as string];
    const refreshCookie1 = cookieArray1.find((c) => c.startsWith("refresh_token="));
    expect(refreshCookie1).toBeDefined();

    // Verify 1 active session in DB for root
    let rootSessions = await RefreshToken.find({ userId: rootUser._id, revoked: false });
    expect(rootSessions.length).toBe(1);

    // Login Root Session 2 (e.g. from mobile or another browser)
    const login2 = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: rootUser.email, password: rootPassword },
      headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15" },
    });
    expect(login2.statusCode).toBe(200);
    const cookies2 = login2.headers["set-cookie"];
    const cookieArray2 = Array.isArray(cookies2) ? cookies2 : [cookies2 as string];
    const refreshCookie2 = cookieArray2.find((c) => c.startsWith("refresh_token="));
    expect(refreshCookie2).toBeDefined();

    // Verify Session 1 is NOW revoked and only Session 2 remains active
    rootSessions = await RefreshToken.find({ userId: rootUser._id, revoked: false });
    expect(rootSessions.length).toBe(1);

    // Attempt to refresh with Session 1's refresh token -> MUST be rejected (401)
    const refreshAttempt1 = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      headers: { cookie: refreshCookie1 },
    });
    expect(refreshAttempt1.statusCode).toBe(401);

    // Attempt to refresh with Session 2's refresh token -> MUST succeed
    const refreshAttempt2 = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      headers: { cookie: refreshCookie2 },
    });
    expect(refreshAttempt2.statusCode).toBe(200);

    // Keep active root cookies for subsequent admin tests
    const newCookies = refreshAttempt2.headers["set-cookie"] || cookies2;
    const newCookieArray = Array.isArray(newCookies) ? newCookies : [newCookies as string];
    rootCookie2 = newCookieArray.map((c) => c.split(";")[0]).join("; ");
  });

  // ─── 2. Root Admin Sessions Supervision Endpoint ────────────────────
  it("allows Root Superadmin to query all active platform user sessions with device telemetry", async () => {
    // Log in the regular doctor to create an active doctor session
    const docLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: regularDoctorUser.email, password: doctorPassword },
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15" },
    });
    expect(docLogin.statusCode).toBe(200);

    // Query active sessions as Root
    const sessionsRes = await app.inject({
      method: "GET",
      url: "/api/auth/admin/sessions",
      headers: { cookie: rootCookie2 },
    });
    expect(sessionsRes.statusCode).toBe(200);
    const body = JSON.parse(sessionsRes.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);

    // Verify both root and doctor sessions appear with rich client metadata
    const rootSession = body.data.find((s: any) => s.userId === rootUser._id.toString());
    expect(rootSession).toBeDefined();
    expect(rootSession.userRole).toBe("root");

    const docSession = body.data.find((s: any) => s.userId === regularDoctorUser._id.toString());
    expect(docSession).toBeDefined();
    expect(docSession.userName).toBe("Dr. Traffic Tester");
    expect(docSession.deviceType).toBe("Desktop");
    expect(docSession.browser).toBe("Safari");
    expect(docSession.os).toBe("macOS");
  });

  // ─── 3. Terminate Session & Force Logout ────────────────────────────
  it("allows Root Superadmin to force-logout an active user session", async () => {
    // Find doctor's active session
    const docActiveSession = await RefreshToken.findOne({ userId: regularDoctorUser._id, revoked: false });
    expect(docActiveSession).toBeDefined();
    const sessionId = docActiveSession!._id.toString();

    // Terminate the session
    const terminateRes = await app.inject({
      method: "DELETE",
      url: `/api/auth/admin/sessions/${sessionId}`,
      headers: { cookie: rootCookie2 },
    });
    expect(terminateRes.statusCode).toBe(200);

    // Verify session is marked revoked in DB
    const updated = await RefreshToken.findById(sessionId);
    expect(updated?.revoked).toBe(true);
  });

  // ─── 4. Organization Logo & Multi-Images ────────────────────────────
  it("updates and persists organization brand logo_url and multi-image facility gallery", async () => {
    const logoUrl = "https://cdn.example.com/organizations/sgh-logo.png";
    const images = [
      "https://cdn.example.com/organizations/reception.jpg",
      "https://cdn.example.com/organizations/icu-ward.jpg",
      "https://cdn.example.com/organizations/operation-theater.jpg",
    ];

    const updateRes = await app.inject({
      method: "PUT",
      url: `/api/organizations/${testOrg._id}`,
      payload: {
        logo_url: logoUrl,
        images,
        description: "Premier multi-specialty healthcare facility",
      },
      headers: { cookie: rootCookie2 },
    });
    expect(updateRes.statusCode).toBe(200);

    // Verify persistence in DB
    const org = await Organization.findById(testOrg._id);
    expect(org?.logo_url).toBe(logoUrl);
    expect(org?.images?.length).toBe(3);
    expect(org?.images?.[0]).toBe(images[0]);

    // Verify public endpoint returns logo_url and images
    const publicRes = await app.inject({
      method: "GET",
      url: `/api/public/organizations/${testOrg._id}`,
    });
    expect(publicRes.statusCode).toBe(200);
    const pubData = JSON.parse(publicRes.body).data;
    expect(pubData.logo_url).toBe(logoUrl);
    expect(pubData.images).toEqual(images);
  });

  // ─── 5. Website Traffic & Clinic Attribution Telemetry ──────────────
  it("records site visits and computes clinic traffic attribution analytics", async () => {
    // 1. Post visits via public tracking endpoint
    const visitPayloads = [
      {
        path: "/clinics/city-opd",
        clinicId: testClinic._id.toString(),
        organizationId: testOrg._id.toString(),
        visitorId: "vis_101",
        referrer: "https://google.com",
      },
      {
        path: "/clinics/city-opd/book",
        clinicId: testClinic._id.toString(),
        organizationId: testOrg._id.toString(),
        visitorId: "vis_102",
        referrer: "https://facebook.com",
      },
      {
        path: "/dashboard",
        visitorId: "vis_103",
        referrer: "",
      },
    ];

    for (const p of visitPayloads) {
      const trackRes = await app.inject({
        method: "POST",
        url: "/api/public/track-visit",
        payload: p,
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0" },
      });
      expect(trackRes.statusCode).toBe(200);
    }

    // 2. Query traffic analytics as Root Superadmin
    const trafficRes = await app.inject({
      method: "GET",
      url: "/api/admin/analytics/traffic?days=14",
      headers: { cookie: rootCookie2 },
    });
    expect(trafficRes.statusCode).toBe(200);
    const analytics = JSON.parse(trafficRes.body).data;

    // Verify summary metrics
    expect(analytics.summary.todayVisits).toBeGreaterThanOrEqual(3);
    expect(analytics.summary.todayVisitors).toBeGreaterThanOrEqual(3);

    // Verify clinic attribution breakdown ("whose clinic and all")
    const clinicShare = analytics.clinicAttribution.find(
      (c: any) => c.clinicId === testClinic._id.toString()
    );
    expect(clinicShare).toBeDefined();
    expect(clinicShare.clinicName).toBe("City OPD Branch");
    expect(clinicShare.organizationName).toBe("Supervision General Hospital");
    expect(clinicShare.visits).toBeGreaterThanOrEqual(2);
    expect(clinicShare.percentShare).toBeGreaterThan(0);

    // Verify device distribution
    expect(analytics.devices.length).toBeGreaterThan(0);
    expect(analytics.devices.some((d: any) => d.name === "Desktop")).toBe(true);
  });
});
