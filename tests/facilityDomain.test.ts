import { fixtureAccessToken } from "./helpers/sessionFixture.ts";
import { providerFixtureSlug } from "./helpers/providerFixture.ts";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../index.ts";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { Department } from "../models/Department.ts";
import { Doctor } from "../models/Doctor.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { ModuleRegistry } from "../models/ModuleRegistry.ts";

let root: any, admin: any, foreignAdmin: any, organization: any, foreignOrganization: any, hospital: any, diagnostics: any;
const cookies = async (user: any, org?: string) => ({ access_token: (await fixtureAccessToken({ id: user.id, email: user.email, role: user.role, organization_id: org })) });

beforeAll(async () => {
  await app.ready();
  root = await User.create({ name: "Facility Root", email: "root@facility-domain.test", role: "root" });
  for (const [name, facilityType] of [["Mixed Healthcare", "hospital"], ["Other Healthcare", "diagnostic_center"]]) {
    const response = await app.inject({ method: "POST", url: "/api/onboarding/organization", cookies: (await cookies(root)), payload: {
      org_name: name, city: "Surat", facilityType, plan: "professional", admin_name: "Administrator", admin_email: `${facilityType}@facility-domain.test`, admin_password: "Password123!", sendWelcomeEmail: false,
    } });
    expect(response.statusCode, response.body).toBe(201);
    const org = await Organization.findById(response.json().data.organization.id);
    const user = await User.findById(response.json().data.user.id);
    const location = await Location.findOne({ organizationId: org!._id });
    if (facilityType === "hospital") { organization = org; admin = user; hospital = location; }
    else { foreignOrganization = org; foreignAdmin = user; diagnostics = location; }
  }
});

describe("Organization tenant and physical facility contracts", () => {
  it("uses canonical location labels for module configuration regardless of a stored display label", async () => {
    await ModuleRegistry.updateOne({ organizationId: organization.id, moduleKey: "locations" }, { label: "Clinic Branches" });
    const response = await app.inject({ method: "GET", url: `/api/modules?organizationId=${organization.id}`, cookies: (await cookies(root)) });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.find((row: any) => row.moduleKey === "locations").label).toBe("Locations");
    expect((await ModuleRegistry.findOne({ organizationId: organization.id, moduleKey: "locations" }))!.label).toBe("Clinic Branches");
  });
  it("requires an explicit organization for Root creation instead of selecting the first tenant", async () => {
    const count = await Location.countDocuments();
    const response = await app.inject({ method: "POST", url: "/api/onboarding/locations", cookies: (await cookies(root)), payload: { name: "Unowned location", city: "Surat" } });
    expect(response.statusCode, response.body).toBe(400);
    expect(await Location.countDocuments()).toBe(count);
  });

  it("provisions hospitals and diagnostics as locations and permits mixed facility types in one tenant", async () => {
    expect(hospital.facilityType).toBe("hospital");
    expect(diagnostics.facilityType).toBe("diagnostic_center");
    const response = await app.inject({ method: "POST", url: "/api/onboarding/locations", cookies: (await cookies(root)), payload: { organizationId: organization.id, name: "Neighborhood clinic", city: "Valsad", facilityType: "clinic" } });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().data).toMatchObject({ organizationId: organization.id, facilityType: "clinic" });
    const list = await app.inject({ method: "GET", url: `/api/onboarding/locations?organizationId=${organization.id}`, cookies: (await cookies(root)) });
    expect(list.json().data.map((row: any) => row.facilityType).sort()).toEqual(["clinic", "hospital"]);
  });

  it("keeps existing type on a partial edit and rejects unknown types without modifying it", async () => {
    const response = await app.inject({ method: "PUT", url: `/api/onboarding/locations/${hospital.id}`, cookies: (await cookies(admin, organization.id)), payload: { name: hospital.name, city: hospital.city } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.facilityType).toBe("hospital");
    const invalid = await app.inject({ method: "PUT", url: `/api/onboarding/locations/${hospital.id}`, cookies: (await cookies(root)), payload: { name: hospital.name, city: hospital.city, facilityType: "hospital_group" } });
    expect(invalid.statusCode).toBe(400);
    expect((await Location.findById(hospital.id))!.facilityType).toBe("hospital");
  });

  it("publishes readable links for classified and unclassified locations in public and doctor responses", async () => {
    const unclassified = await Location.create({ organizationId: organization.id, name: "Unclassified location", city: "Surat" });
    const doctor = await User.create({ name: "Location Doctor", email: "locations@facility-domain.test", role: "doctor" });
    await OrgMember.create({ userId: doctor.id, organizationId: organization.id, role: "doctor" });
    await Doctor.create({ userId: doctor.id, organizationId: organization.id });
    for (const location of [hospital, unclassified]) await DoctorAssignment.create({ doctorId: doctor.id, organizationId: organization.id, locationId: location.id, workingHours: "{}", fees: 100 });
    const profile = await app.inject({ method: "GET", url: `/api/public/doctors/${await providerFixtureSlug("doctor", doctor.id)}/profile` });
    expect(profile.statusCode, profile.body).toBe(200);
    expect(profile.json().data.locations.find((row: any) => row.id === hospital.id).facilityType).toBe("hospital");
    expect(profile.json().data.locations.find((row: any) => row.id === unclassified.id).facilityType).toBeNull();
    const detail = await app.inject({ method: "GET", url: `/api/public/locations/${await providerFixtureSlug("location", hospital.id)}` });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().data).toMatchObject({ id: hospital.id, facilityType: "hospital", organizationLocationCount: 3 });
    const slug = await app.inject({ method: "GET", url: `/api/public/locations/${detail.json().data.slug}` });
    expect(slug.json().data.id).toBe(hospital.id);
    const catalog = await app.inject({ method: "GET", url: "/api/public/locations?limit=100" });
    expect(catalog.json().data.find((row: any) => row.id === diagnostics.id).facilityType).toBe("diagnostic_center");
    expect(catalog.json().data.find((row: any) => row.id === unclassified.id).facilityType).toBeNull();
    const directory = await app.inject({ method: "GET", url: `/api/admin/users?locationId=${hospital.id}`, cookies: (await cookies(root)) });
    expect(directory.statusCode, directory.body).toBe(200);
    expect(directory.json().data.users.map((row: any) => row.id || row._id)).toContain(doctor.id);
  });

  it("counts all facility types against the existing location quota", async () => {
    const count = await Location.countDocuments({ organizationId: organization.id, isActive: true });
    await Organization.updateOne({ _id: organization.id }, { maxLocations: count });
    try {
      const response = await app.inject({ method: "POST", url: "/api/onboarding/locations", cookies: (await cookies(admin, organization.id)), payload: { name: "New diagnostics", city: "Surat", facilityType: "diagnostic_center" } });
      expect(response.statusCode, response.body).toBe(403);
      expect(await Location.countDocuments({ organizationId: organization.id, isActive: true })).toBe(count);
    } finally { await Organization.updateOne({ _id: organization.id }, { maxLocations: 20 }); }
  });

  it("rejects foreign locations and department heads before writing a department", async () => {
    const count = await Department.countDocuments();
    for (const foreignReference of [{ locationId: diagnostics.id }, { headDoctorId: foreignAdmin.id }]) {
      const response = await app.inject({ method: "POST", url: "/api/departments", cookies: (await cookies(admin, organization.id)), payload: { name: "Invalid department", code: "INVALID", ...foreignReference } });
      expect(response.statusCode, response.body).toBe(404);
    }
    expect(await Department.countDocuments()).toBe(count);
    const valid = await app.inject({ method: "POST", url: `/api/departments?organizationId=${organization.id}`, cookies: (await cookies(root)), payload: { name: "Central department", code: "CENTRAL", locationId: hospital.id } });
    expect(valid.statusCode, valid.body).toBe(201);
    const mismatch = await app.inject({ method: "GET", url: `/api/departments?organizationId=${foreignOrganization.id}`, cookies: (await cookies(admin, organization.id)) });
    expect(mismatch.statusCode).toBe(403);
  });

  it("honors selected tenant scope for Root mutations and forbids staff cross-tenant access", async () => {
    for (const actor of [(await cookies(root)), (await cookies(admin, organization.id))]) {
      for (const method of ["PUT", "DELETE", "POST"] as const) {
        const url = `/api/onboarding/locations/${diagnostics.id}${method === "POST" ? "/reactivate" : ""}?organizationId=${organization.id}`;
        const response = await app.inject({ method, url, cookies: actor, ...(method === "PUT" ? { payload: { name: "Unauthorized edit", city: "Surat" } } : {}) });
        expect(response.statusCode, response.body).toBe(404);
      }
    }
    expect((await Location.findById(diagnostics.id))!.name).toBe(diagnostics.name);
    expect((await Location.findById(diagnostics.id))!.isActive).toBe(true);
  });

  it("reactivates only assigned active members, preserving disabled profiles and foreign-tenant isolation", async () => {
    const location = await Location.create({ organizationId: organization.id, name: "Archived hospital", city: "Surat", facilityType: "hospital", isActive: false });
    const cases = [{ name: "Active clinician", active: true, identityActive: true, profile: true, member: true }, { name: "Missing-profile clinician", active: true, identityActive: true, profile: false, member: true }, { name: "Disabled clinician", active: false, identityActive: true, profile: true, member: true }, { name: "Removed member", active: true, identityActive: true, profile: true, member: false }, { name: "Disabled identity", active: true, identityActive: false, profile: true, member: true }];
    const assignments: any[] = [];
    for (const item of cases) {
      const user = await User.create({ name: item.name, role: "doctor", isActive: item.identityActive });
      if (item.member) await OrgMember.create({ userId: user.id, organizationId: organization.id, role: "doctor" });
      if (item.profile) await Doctor.create({ userId: user.id, organizationId: organization.id, isActive: item.active });
      assignments.push(await DoctorAssignment.create({ organizationId: organization.id, locationId: location.id, doctorId: user.id, workingHours: "{}", fees: 100, isActive: false }));
    }
    const foreign = await DoctorAssignment.create({ organizationId: foreignOrganization.id, locationId: location.id, doctorId: foreignAdmin.id, workingHours: "{}", fees: 100, isActive: false });
    const response = await app.inject({ method: "POST", url: `/api/onboarding/locations/${location.id}/reactivate?organizationId=${organization.id}`, cookies: (await cookies(root)) });
    expect(response.statusCode, response.body).toBe(200);
    expect((await DoctorAssignment.find({ _id: { $in: assignments.map(row => row.id) } }).sort({ _id: 1 })).map(row => row.isActive)).toEqual([true, true, false, false, false]);
    expect((await DoctorAssignment.findById(foreign.id))!.isActive).toBe(false);
  });
});
