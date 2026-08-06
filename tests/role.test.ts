import { describe, it, expect } from "vitest";
import { app } from "../index.js";
import { Role } from "../models/Role.ts";
import { User } from "../models/User.ts";

describe("Role & Permission Governance API Integration Tests", () => {
  let adminCookies: string[] = [];
  let customRoleName = `custom_auditor_${Date.now()}`;
  let staffUserId: string;

  it("should bootstrap org and admin account", async () => {
    const bootstrapRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Governance Health Org",
        city: "Mumbai",
        admin_name: "Gov Admin",
        admin_email: `gov_admin_${Date.now()}@test.com`,
        admin_password: "Password123",
      },
    });

    expect(bootstrapRes.statusCode).toBe(201);
    adminCookies = bootstrapRes.headers["set-cookie"] as string[];
  });

  it("should fetch system permission catalog via GET /api/permissions", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/permissions",
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.some((p: any) => p.code === "ADMINISTRATIVE_GOVERNANCE")).toBe(true);
  });

  it("should fetch role list and seed default system roles via GET /api/roles", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/roles",
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(8);
    expect(body.data.some((r: any) => r.name === "admin")).toBe(true);
    expect(body.data.some((r: any) => r.name === "doctor")).toBe(true);
  });

  it("should create custom role via POST /api/roles", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: customRoleName,
        description: "Special internal compliance auditor role",
        permissions: ["VIEW_PATIENTS", "VIEW_AUDIT_LOGS"],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.name).toBe(customRoleName);
    expect(body.data.isSystemRole).toBe(false);
  });

  it("should update role permissions via PUT /api/roles/:name", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/roles/${customRoleName}`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        description: "Updated auditor role with extra permissions",
        permissions: ["VIEW_PATIENTS", "VIEW_AUDIT_LOGS", "VIEW_ANALYTICS"],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.permissions).toContain("VIEW_ANALYTICS");
  });

  it("should assign role to staff user via PUT /api/users/:id/role", async () => {
    // Create staff user first
    const staffRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/staff",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Audit Officer",
        email: `auditor_${Date.now()}@test.com`,
        password: "Password123",
        role: "nurse",
      },
    });

    expect(staffRes.statusCode).toBe(201);
    staffUserId = JSON.parse(staffRes.body).data.id;

    // Update user role to customRoleName
    const roleUpdateRes = await app.inject({
      method: "PUT",
      url: `/api/users/${staffUserId}/role`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        role: customRoleName,
      },
    });

    expect(roleUpdateRes.statusCode).toBe(200);
    const body = JSON.parse(roleUpdateRes.body);
    expect(body.success).toBe(true);
    expect(body.data.role).toBe(customRoleName);
  });

  it("should prevent deletion of system roles via DELETE /api/roles/admin", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/roles/admin",
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain("System role 'admin' cannot be deleted");
  });

  it("should delete custom role via DELETE /api/roles/:name", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/roles/${customRoleName}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
  });
});
