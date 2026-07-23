import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { Role } from "../models/Role.ts";

/**
 * RBAC Integration Test Suite
 *
 * Validates that the dynamic RBAC authorization system correctly:
 *  1. Seeds an "admin" Role document during organization creation.
 *  2. Grants admin users access to permission-gated routes via their Role document
 *     (without any hardcoded bypass — the admin role is evaluated exactly like every
 *     other role against the Role.permissions[] array).
 *  3. Blocks non-admin roles that do NOT have the required permission.
 *  4. Allows a non-admin role WITH the required permission to pass the check.
 */
describe("Dynamic RBAC Authorization", () => {
  let adminCookies: string[] = [];
  let doctorCookies: string[] = [];
  let clinicId: string;

  // ─── Seed: org + admin + doctor via the real API ─────────────────────────
  beforeAll(async () => {
    // 1. Create a fresh organization (this upserts the admin Role document)
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "RBAC Test Hospital",
        city: "Bangalore",
        admin_name: "RBAC Admin",
        admin_email: "rbac-admin@test.com",
        admin_password: "Password123",
      },
    });
    expect(orgRes.statusCode).toBe(201);
    adminCookies = orgRes.headers["set-cookie"] as string[];

    // 2. Admin creates a clinic — capture the clinicId for later payloads.
    //    addReceptionistSchema requires clinicId as a valid ObjectId, so all
    //    receptionist creation calls must include it.
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "RBAC Clinic",
        city: "Bangalore",
        address: "1 Test Street",
        phone: "9000000001",
        email: "clinic@rbactest.com",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Admin registers a doctor (the "doctor" role has no Role document yet)
    const doctorRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. RBAC Tester",
        email: "rbac-doctor@test.com",
        password: "Password123",
        specialization: "General",
      },
    });
    expect(doctorRes.statusCode).toBe(201);

    // 4. Login as the doctor
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "rbac-doctor@test.com",
        password: "Password123",
      },
    });
    expect(loginRes.statusCode).toBe(200);
    doctorCookies = loginRes.headers["set-cookie"] as string[];
  });

  // ─── Test 1: Admin Role document is seeded ───────────────────────────────
  it("should seed an admin Role document with all permissions on org creation", async () => {
    const adminRole = await Role.findOne({ name: "admin" }).lean() as any;

    expect(adminRole).not.toBeNull();
    expect(adminRole.isSystemRole).toBe(true);
    expect(Array.isArray(adminRole.permissions)).toBe(true);

    // Must contain all core RBAC permission codes
    const requiredPermissions = [
      "MANAGE_STAFF", "VIEW_STAFF",
      "MANAGE_CLINICS", "VIEW_CLINICS",
      "MANAGE_ORGANIZATION",
      "MANAGE_BEDS", "MANAGE_ADMISSIONS", "VIEW_ADMISSIONS",
      "MANAGE_MEDICINES", "MANAGE_LAB_TESTS",
      "MANAGE_BILLING", "VIEW_BILLING",
      "MANAGE_APPOINTMENTS", "VIEW_APPOINTMENTS",
      "VIEW_ANALYTICS", "MANAGE_QUEUE",
    ];

    for (const perm of requiredPermissions) {
      expect(adminRole.permissions).toContain(perm);
    }
  });

  // ─── Test 2: Admin accesses permission-gated route via Role table ─────────
  it("should allow admin to access MANAGE_STAFF route via Role document (no bypass)", async () => {
    // POST /api/onboarding/receptionist is gated by checkPermission("MANAGE_STAFF").
    // clinicId is required by addReceptionistSchema (ObjectId pattern) — must be supplied
    // so that Fastify schema validation passes and the RBAC preHandler actually runs.
    // This confirms admin Role.permissions[] contains MANAGE_STAFF end-to-end.
    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding/receptionist",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "RBAC Receptionist",
        email: "rbac-rec@test.com",
        password: "Password123",
        clinicId,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.data.role).toBe("receptionist");
  });

  // ─── Test 3: Non-admin without required permission is blocked ────────────
  it("should block a doctor (no VIEW_STAFF permission) from accessing VIEW_STAFF route with 403", async () => {
    // GET /api/onboarding/staff is gated by checkPermission("VIEW_STAFF") with no
    // body schema, so Fastify schema validation never fires and the 403 comes
    // purely from the RBAC permission table lookup. The "doctor" role has no Role
    // document yet, so Role.findOne({ name: "doctor" }) returns null → 403.
    const response = await app.inject({
      method: "GET",
      url: "/api/onboarding/staff",
      headers: { cookie: doctorCookies.join("; ") },
    });

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/Forbidden/i);
  });

  // ─── Test 4: Non-admin WITH the required permission passes the check ──────
  it("should allow a doctor with VIEW_STAFF permission to access the staff list", async () => {
    // Directly upsert a "doctor" Role document with VIEW_STAFF.
    // This simulates an operator granting elevated permissions to a doctor role
    // and confirms the RBAC table is the true authority for all roles.
    await Role.findOneAndUpdate(
      { name: "doctor" },
      {
        $set: {
          name: "doctor",
          description: "Physician with elevated test permissions",
          isSystemRole: false,
          permissions: ["VIEW_STAFF"],
        },
      },
      { upsert: true }
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/onboarding/staff",
      headers: { cookie: doctorCookies.join("; ") },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });
});
