import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { app } from "../index.ts";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Receptionist } from "../models/Receptionist.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { createAuthSession } from "../utilities/helpers.ts";
import { checkLocationAccess, getRequestLocationIds } from "../utilities/tenant.ts";
import { resolveStaffLocationGrant } from "../services/LocationAccessService.ts";
import { BUILTIN_ROLE_PERMISSIONS, getEffectivePermissions } from "../utilities/permissions.ts";
import { SYSTEM_PERMISSIONS_CATALOG } from "../controllers/role.ts";
import { Role } from "../models/Role.ts";

async function fixture(role = "nurse") {
  const user = await User.create({ name: "Branch staff", email: `${crypto.randomUUID()}@example.test`, role });
  const org = await Organization.create({ name: "Branch clinic", city: "Pune" });
  const other = await Organization.create({ name: "Other clinic", city: "Pune" });
  const a = await Location.create({ name: "Branch A", city: "Pune", organizationId: org._id });
  const b = await Location.create({ name: "Branch B", city: "Pune", organizationId: org._id });
  const foreign = await Location.create({ name: "Other branch", city: "Pune", organizationId: other._id });
  const member = await OrgMember.create({ userId: user._id, organizationId: org._id, role });
  const req = { user: { id: user.id, email: user.email!, role, organization_id: org.id } } as FastifyRequest;
  return { user, org, other, a, b, foreign, member, req };
}

describe("CRM branch and permission authority", () => {
  it('offers minimal reviewed association branches without facility or CRM dashboard permission', async () => {
    const f = await fixture('patient_registrar');
    await Role.create({ organizationId: f.org.id, name: 'patient_registrar', permissions: ['MANAGE_PATIENTS', 'REVIEW_PATIENT_IDENTITY'] });
    await OrgMember.updateOne({ _id: f.member.id }, { locationAccess: { mode: 'selected', locationIds: [f.a.id] } });
    const session = await createAuthSession(f.req.user!, { organizationId: f.org.id, workspaceRole: 'patient_registrar' });
    const cookies = { access_token: session.accessToken };
    const response = await app.inject({ method: 'GET', url: '/api/patients/association-locations', cookies });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual([{ id: f.a.id, name: f.a.name, effectiveTimezone: 'Asia/Kolkata' }]);
    expect((await app.inject({ method: 'GET', url: '/api/onboarding/locations', cookies })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/crm/locations', cookies })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/patients/association-locations?limit=201', cookies })).statusCode).toBe(400);
  });
  it('provides only reviewed branch labels to a CRM role without facility administration grants', async () => {
    const f = await fixture('crm_reader');
    await Role.create({ organizationId: f.org.id, name: 'crm_reader', permissions: ['VIEW_CRM'] });
    await OrgMember.updateOne({ _id: f.member._id }, { locationAccess: { mode: 'selected', locationIds: [f.a.id] } });
    await Organization.updateOne({ _id: f.org.id }, { timezone: 'Europe/London' });
    await Location.updateOne({ _id: f.a.id }, { timezone: null, phone: 'private', upiVpa: 'private@upi' });
    const session = await createAuthSession(f.req.user!);
    const cookies = { access_token: session.accessToken };
    expect((await app.inject({ method: 'GET', url: '/api/onboarding/locations', cookies })).statusCode).toBe(403);
    const result = await app.inject({ method: 'GET', url: '/api/crm/locations?limit=1', cookies });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().data).toEqual([{ id: f.a.id, name: 'Branch A', effectiveTimezone: 'Europe/London' }]);
    expect(result.headers['x-total-count']).toBe('1');
    expect((await app.inject({ method: 'GET', url: '/api/crm/locations?page=invalid', cookies })).statusCode).toBe(400);
    await Role.updateOne({ organizationId: f.org.id, name: 'crm_reader' }, { permissions: [] });
    expect((await app.inject({ method: 'GET', url: '/api/crm/locations', cookies })).statusCode).toBe(403);
  });
  it("fails closed for an unreviewed staff grant while preserving legacy module behavior", async () => {
    const f = await fixture();
    expect(await resolveStaffLocationGrant(f.user.id, f.org.id, "nurse", true)).toEqual([]);
    expect(await getRequestLocationIds(f.req, { requireExplicitScope: true })).toEqual([]);
    expect((await checkLocationAccess(f.req, f.a.id, { requireExplicitScope: true })).allowed).toBe(false);
    expect((await checkLocationAccess(f.req, f.a.id)).allowed).toBe(true);
  });
  it("honors reviewed selected and empty grants in both CRM and existing location helpers", async () => {
    const f = await fixture();
    await OrgMember.updateOne({ _id: f.member._id }, { locationAccess: { mode: "selected", locationIds: [f.a._id] } });
    expect((await checkLocationAccess(f.req, f.a.id)).allowed).toBe(true);
    expect((await checkLocationAccess(f.req, f.b.id)).allowed).toBe(false);
    expect((await checkLocationAccess(f.req, f.foreign.id)).allowed).toBe(false);
    expect((await getRequestLocationIds(f.req))!.map(String)).toEqual([f.a.id]);
    await OrgMember.updateOne({ _id: f.member._id }, { locationAccess: { mode: "selected", locationIds: [] } });
    expect(await getRequestLocationIds(f.req)).toEqual([]);
  });
  it("uses only active doctor assignments and the receptionist's verified branch as initial CRM scope", async () => {
    const doctor = await fixture("doctor");
    await DoctorAssignment.create([{ doctorId: doctor.user._id, locationId: doctor.a._id, organizationId: doctor.org._id, workingHours: "{}" },
      { doctorId: doctor.user._id, locationId: doctor.b._id, organizationId: doctor.org._id, workingHours: "{}", isActive: false }]);
    expect((await getRequestLocationIds(doctor.req, { requireExplicitScope: true }))!.map(String)).toEqual([doctor.a.id]);
    const desk = await fixture("receptionist");
    await Receptionist.create({ userId: desk.user._id, organizationId: desk.org._id, locationId: desk.b._id });
    expect((await getRequestLocationIds(desk.req, { requireExplicitScope: true }))!.map(String)).toEqual([desk.b.id]);
  });
  it("never interprets reviewed all-location access as all organizations or inactive locations", async () => {
    const f = await fixture();
    await OrgMember.updateOne({ _id: f.member._id }, { locationAccess: { mode: "all", locationIds: [] } });
    await Location.updateOne({ _id: f.b._id }, { isActive: false });
    expect((await getRequestLocationIds(f.req, { requireExplicitScope: true }))!.map(String)).toEqual([f.a.id]);
    expect((await checkLocationAccess(f.req, f.foreign.id, { requireExplicitScope: true })).allowed).toBe(false);
  });
  it("changes access with revision checks, audit and immediate session revocation without revoking other organizations", async () => {
    const f = await fixture();
    const admin = await User.create({ name: "Clinic admin", email: `${crypto.randomUUID()}@example.test`, role: "admin" });
    await OrgMember.create([{ userId: admin._id, organizationId: f.org._id, role: "admin" },
      { userId: f.user._id, organizationId: f.other._id, role: "nurse" }]);
    const authority = await createAuthSession({ id: admin.id, email: admin.email!, role: "admin", organization_id: f.org.id });
    const before = await createAuthSession(f.req.user!);
    const other = await createAuthSession({ ...f.req.user!, organization_id: f.other.id });
    const path = `/api/organizations/${f.org.id}/members/${f.user.id}/location-access`;
    const response = await app.inject({ method: "PATCH", url: path, cookies: { access_token: authority.accessToken },
      payload: { mode: "selected", locationIds: [f.a.id], expectedRevision: 0 } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.accessRevision).toBe(1);
    expect(await AuditLog.exists({ action: "MEMBER_LOCATION_ACCESS_CHANGED", targetId: f.member._id })).toBeTruthy();
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: { access_token: before.accessToken } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: { access_token: other.accessToken } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: path, cookies: { access_token: authority.accessToken },
      payload: { mode: "all", locationIds: [], expectedRevision: 0 } })).statusCode).toBe(409);
    const current = await createAuthSession(f.req.user!);
    const list = await app.inject({ method: "GET", url: "/api/onboarding/locations", cookies: { access_token: current.accessToken } });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.map((location: { id: string }) => location.id)).toEqual([f.a.id]);
  });
  it("rejects foreign locations, self changes and unauthorized members", async () => {
    const f = await fixture("admin");
    const staff = await User.create({ name: "Desk", email: `${crypto.randomUUID()}@example.test`, role: "receptionist" });
    await OrgMember.create({ userId: staff._id, organizationId: f.org._id, role: "receptionist" });
    const session = await createAuthSession(f.req.user!);
    const edit = (userId: string, ids: string[]) => app.inject({ method: "PATCH", url: `/api/organizations/${f.org.id}/members/${userId}/location-access`,
      cookies: { access_token: session.accessToken }, payload: { mode: "selected", locationIds: ids, expectedRevision: 0 } });
    expect((await edit(staff.id, [f.foreign.id])).statusCode).toBe(400);
    expect((await edit(f.user.id, [f.a.id])).statusCode).toBe(403);
    const outsider = await User.create({ name: "Outsider", role: "nurse", email: `${crypto.randomUUID()}@example.test` });
    expect((await edit(outsider.id, [f.a.id])).statusCode).toBe(404);
  });
  it("keeps every fallback grant in the catalog and never defaults export or duplicate-resolution grants", async () => {
    const codes = new Set(SYSTEM_PERMISSIONS_CATALOG.map(permission => permission.code));
    for (const permissions of Object.values(BUILTIN_ROLE_PERMISSIONS)) for (const permission of permissions) expect(codes.has(permission)).toBe(true);
    expect(BUILTIN_ROLE_PERMISSIONS.receptionist).toContain("VIEW_CRM");
    expect(BUILTIN_ROLE_PERMISSIONS.admin).not.toContain("EXPORT_CRM");
    expect(BUILTIN_ROLE_PERMISSIONS.admin).not.toContain("RESOLVE_PATIENT_DUPLICATES");
    const org = await Organization.create({ name: "Denied roles", city: "Pune" });
    await Role.create({ name: "receptionist", organizationId: org._id, permissions: [] });
    expect(await getEffectivePermissions("receptionist", org.id)).toEqual(new Set());
  });
});
