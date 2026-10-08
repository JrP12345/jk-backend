import { fixtureAccessToken } from "./helpers/sessionFixture.ts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { app } from "../index.ts";
import { Organization } from "../models/Organization.ts";
import { OrganizationBrandingAsset } from "../models/OrganizationBrandingAsset.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { User } from "../models/User.ts";
import { Role } from "../models/Role.ts";
import { Location } from "../models/Location.ts";
import { Doctor } from "../models/Doctor.ts";
import { OrgInvite } from "../models/OrgInvite.ts";
import { cleanupBrandingAssets } from "../services/OrganizationBranding.ts";
import { uploadOrganizationImage } from "../utilities/r2.ts";
import { emailProvider } from "../notifications/providers/emailProvider.ts";
import { encryptField } from "../utilities/cryptoEnvelope.ts";

const storage = vi.hoisted(() => new Map<string, Buffer>());
vi.mock("../utilities/r2.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../utilities/r2.ts")>(),
  uploadOrganizationImage: vi.fn(async (buffer: Buffer, _type: string, owner: string) => { const key = `organization-branding/${owner}/${storage.size + 1}.png`; storage.set(key, buffer); return key; }),
  getObjectBuffer: vi.fn(async (key: string) => { if (!storage.has(key)) throw new Error("Object not found"); return storage.get(key)!; }),
  deleteObjectFromStorage: vi.fn(async (key: string) => { storage.delete(key); }),
}));
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
let root: any, admin: any, orgA: any, orgB: any;
const cookie = async (user: any, org?: string) => ({ access_token: (await fixtureAccessToken({ id: user.id, email: user.email, role: user.role, organization_id: org })) });
const base = (name: string) => ({ org_name: name, city: "Mumbai", admin_name: "Primary Admin", admin_email: `${name.replaceAll(" ", "-")}@org.test`, admin_password: "Password123!", sendWelcomeEmail: false });
const upload = async (user: any, organizationId?: string) => app.inject({ method: "POST", url: `/api/organizations/branding/uploads${organizationId ? `?organizationId=${organizationId}` : ""}`, cookies: (await cookie(user, user === admin ? orgA.id : undefined)), payload: { contentType: "image/png", base64Data: png, forCreation: !organizationId } });

beforeAll(async () => {
  await app.ready();
  root = await User.create({ name: "Root", email: "root@org-management.test", role: "root" });
  orgA = await Organization.create({ name: "Managed A", city: "Mumbai", image_url: "https://images.example/cover.png", maxStaff: 20 });
  orgB = await Organization.create({ name: "Managed B", city: "Delhi" });
  admin = await User.create({ name: "Admin A", email: "admin@org-management.test", role: "admin" });
  await OrgMember.create({ userId: admin._id, organizationId: orgA._id, role: "admin" });
});

describe("organization branding persistence", () => {
  it("creates without an image and keeps the generated administrator and primary location", async () => {
    const res = await app.inject({ method: "POST", url: "/api/onboarding/organization", cookies: (await cookie(root)), payload: base("Without Image") });
    expect(res.statusCode).toBe(201);
    const id = res.json().data.organization.id;
    expect((await Organization.findById(id))!.logo_url).toBeNull();
    expect(await Location.exists({ organizationId: id })).toBeTruthy();
    expect(await OrgMember.exists({ organizationId: id, role: "admin" })).toBeTruthy();
    expect(res.cookies.some((c) => c.name === "access_token")).toBe(false);
  });

  it("creates with uploaded branding, serves bytes after a fresh fetch, replaces and removes it", async () => {
    const uploaded = await upload(root);
    expect(uploaded.statusCode).toBe(201);
    const ref = uploaded.json().data.reference;
    expect((await app.inject({ method: "GET", url: ref })).statusCode).toBe(404);
    const created = await app.inject({ method: "POST", url: "/api/onboarding/organization", cookies: (await cookie(root)), payload: { ...base("With Image"), logo_url: ref, image_url: ref, trialDays: 23 } });
    expect(created.statusCode).toBe(201);
    const id = created.json().data.organization.id;
    const fresh = await app.inject({ method: "GET", url: `/api/onboarding/organization/me?organizationId=${id}`, cookies: (await cookie(root)) });
    expect(fresh.json().data.logo_url).toBe(ref);
    const rendered = await app.inject({ method: "GET", url: fresh.json().data.logo_url });
    expect(rendered.statusCode).toBe(200);
    expect(rendered.headers["content-type"]).toBe("image/png");
    expect(rendered.rawPayload).toEqual(Buffer.from(png, "base64"));
    const replacement = await upload(root, id);
    const newRef = replacement.json().data.reference;
    const edit = await app.inject({ method: "PUT", url: `/api/organizations/${id}`, cookies: (await cookie(root)), payload: { name: "Renamed Organization", logo_url: newRef } });
    expect(edit.statusCode).toBe(200);
    expect((await Organization.findById(id))!.image_url).toBe(ref); // omitted cover retained
    await cleanupBrandingAssets();
    expect((await app.inject({ method: "GET", url: ref })).statusCode).toBe(200); // cover still uses it
    const remove = await app.inject({ method: "PUT", url: `/api/onboarding/organization/me?organizationId=${id}`, cookies: (await cookie(root)), payload: { logo_url: null, image_url: null } });
    expect(remove.statusCode).toBe(200);
    await cleanupBrandingAssets();
    expect((await Organization.findById(id))!.logo_url).toBeNull();
    expect((await app.inject({ method: "GET", url: ref })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: newRef })).statusCode).toBe(404);
    expect(await OrganizationBrandingAsset.countDocuments({ organizationId: id })).toBe(0);
  });

  it("rejects unsafe files and does not save metadata when storage fails", async () => {
    const invalid = await app.inject({ method: "POST", url: "/api/organizations/branding/uploads", cookies: (await cookie(root)), payload: { contentType: "image/png", base64Data: Buffer.from("<script>alert(1)</script>").toString("base64") } });
    expect(invalid.statusCode).toBe(400);
    const count = await OrganizationBrandingAsset.countDocuments();
    vi.mocked(uploadOrganizationImage).mockRejectedValueOnce(new Error("Storage offline"));
    expect((await upload(root)).statusCode).toBe(503);
    expect(await OrganizationBrandingAsset.countDocuments()).toBe(count);
  });

  it("reuses the branding lifecycle for locations, rejects foreign and private images, and retains archived images", async () => {
    const uploaded = await upload(root, orgA.id);
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const reference = uploaded.json().data.reference;
    const create = await app.inject({ method: "POST", url: `/api/onboarding/locations?organizationId=${orgA.id}`, cookies: await cookie(root), payload: { name: "Branded Branch", city: "Mumbai", image_url: reference } });
    expect(create.statusCode, create.body).toBe(201);
    const location = create.json().data;
    expect(location.logo).toBe(reference);
    expect((await app.inject({ method: "GET", url: reference })).statusCode).toBe(200);
    const foreign = await upload(root, orgB.id);
    const denied = await app.inject({ method: "PUT", url: `/api/onboarding/locations/${location.id}?organizationId=${orgA.id}`, cookies: await cookie(root), payload: { name: location.name, city: "Mumbai", logo: foreign.json().data.reference } });
    expect(denied.statusCode, denied.body).toBe(400);
    const privateImage = await app.inject({ method: "PUT", url: `/api/onboarding/locations/${location.id}?organizationId=${orgA.id}`, cookies: await cookie(root), payload: { name: location.name, city: "Mumbai", logo: "tenants/private/patient-avatar.png" } });
    expect(privateImage.statusCode).toBe(400);
    await Location.updateOne({ _id: location.id }, { isPublished: false });
    expect((await app.inject({ method: "GET", url: reference })).statusCode).toBe(404);
    await cleanupBrandingAssets(new Date(Date.now() + 25 * 60 * 60_000));
    expect(await OrganizationBrandingAsset.findById(uploaded.json().data.id)).toBeTruthy();
    await Location.updateOne({ _id: location.id }, { isPublished: true });
    expect((await app.inject({ method: "GET", url: reference })).statusCode).toBe(200);
    const clear = await app.inject({ method: "PUT", url: `/api/onboarding/locations/${location.id}?organizationId=${orgA.id}`, cookies: await cookie(root), payload: { name: location.name, city: "Mumbai", logo: "" } });
    expect(clear.statusCode, clear.body).toBe(200);
    await cleanupBrandingAssets();
    expect(await OrganizationBrandingAsset.findById(uploaded.json().data.id)).toBeNull();
  });

  it("rejects another tenant's asset and private-vault references; sweeps abandoned uploads", async () => {
    expect((await upload(admin, orgB.id)).statusCode).toBe(403);
    const own = await upload(admin, orgA.id);
    expect(own.statusCode).toBe(201);
    const ref = own.json().data.reference;
    const attachOther = await app.inject({ method: "PUT", url: `/api/organizations/${orgB.id}`, cookies: (await cookie(root)), payload: { logo_url: ref } });
    expect(attachOther.statusCode).toBe(400);
    const privateRef = await app.inject({ method: "PUT", url: `/api/organizations/${orgA.id}`, cookies: (await cookie(admin, orgA.id)), payload: { logo_url: `tenants/${orgB.id}/private-patient-image.png` } });
    expect(privateRef.statusCode).toBe(400);
    await cleanupBrandingAssets(new Date(Date.now() + 25 * 60 * 60_000));
    expect(await OrganizationBrandingAsset.findById(own.json().data.id)).toBeNull();
  });
});

describe("organization ownership and members", () => {
  it("tests the selected organization's SMTP gateway and rejects tenant overrides", async () => {
    await Organization.updateOne({ _id: orgA.id }, { $set: { "smtp.host": "smtp.organization.test", "smtp.user": "mailer", "smtp.pass": encryptField("smtp-test-password") } });
    const dispatch = vi.spyOn(emailProvider, "sendEmail").mockResolvedValue(true);
    try {
      const response = await app.inject({ method: "POST", url: `/api/notifications/test-email?organizationId=${orgA.id}`, cookies: (await cookie(root)), payload: { targetEmail: admin.email } });
      expect(response.statusCode).toBe(200);
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ to: admin.email }), expect.objectContaining({ host: "smtp.organization.test", pass: "smtp-test-password" }));
      dispatch.mockClear();
      expect((await app.inject({ method: "POST", url: `/api/notifications/test-email?organizationId=${orgB.id}`, cookies: (await cookie(admin, orgA.id)), payload: { targetEmail: admin.email } })).statusCode).toBe(403);
      expect(dispatch).not.toHaveBeenCalled();
    } finally { dispatch.mockRestore(); }
  });

  it("accepts a clinical invitation once, creates one scoped profile and enforces quotas", async () => {
    const token = crypto.randomBytes(32).toString("hex");
    const organization = await Organization.create({ name: "Invited Clinical Team", city: "Mumbai", maxDoctors: 1 });
    const createInvite = async (value: string, email: string) => OrgInvite.create({ organizationId: organization.id, email, role: "doctor", invitedBy: root.id, tokenHash: crypto.createHash("sha256").update(value).digest("hex"), expiresAt: new Date(Date.now() + 60_000) });
    await createInvite(token, "invited-doctor@management.test");
    const payload = { token, name: "Invited Doctor", password: "Password123!" };
    const accepted = await app.inject({ method: "POST", url: "/api/auth/accept-invitation", payload });
    expect(accepted.statusCode).toBe(201);
    const userId = accepted.json().data.user.id;
    expect(await Doctor.countDocuments({ userId, organizationId: organization.id })).toBe(1);
    expect(await OrgMember.exists({ userId, organizationId: organization.id, role: "doctor" })).toBeTruthy();
    const edit = await app.inject({ method: "PUT", url: `/api/onboarding/doctor/${userId}?organizationId=${organization.id}`, cookies: (await cookie(root)), payload: { name: "Invited Doctor", email: "invited-doctor@management.test", specialization: "Cardiology" } });
    expect(edit.statusCode).toBe(200);
    expect((await Doctor.findOne({ userId }))!.specialization).toBe("Cardiology");
    expect((await app.inject({ method: "POST", url: "/api/auth/accept-invitation", payload })).statusCode).toBe(400);
    await createInvite("quota-token", "quota-doctor@management.test");
    expect((await app.inject({ method: "POST", url: "/api/auth/accept-invitation", payload: { ...payload, token: "quota-token" } })).statusCode).toBe(403);
    expect(await User.exists({ email: "quota-doctor@management.test" })).toBeNull();
  });

  it("Root disables a global identity across memberships without deleting them", async () => {
    const user = await User.create({ name: "Global Status", email: "global-status@management.test", role: "nurse" });
    await OrgMember.create([{ userId: user.id, organizationId: orgA.id, role: "nurse" }, { userId: user.id, organizationId: orgB.id, role: "nurse" }]);
    const before = (await User.findById(user.id))!.authVersion;
    const response = await app.inject({ method: "PUT", url: `/api/admin/users/${user.id}/status`, cookies: (await cookie(root)), payload: { isActive: false } });
    expect(response.statusCode).toBe(200);
    expect((await User.findById(user.id))!.isActive).toBe(false);
    expect((await User.findById(user.id))!.authVersion).toBeGreaterThan(before!);
    expect(await OrgMember.countDocuments({ userId: user.id })).toBe(2);
    expect((await app.inject({ method: "PUT", url: `/api/admin/users/${user.id}/status`, cookies: (await cookie(root)), payload: { isActive: true } })).statusCode).toBe(200);
    expect((await User.findById(user.id))!.isActive).toBe(true);
  });

  it("allows own details while retaining omitted images; forbids cross-tenant/status/quota/global operations", async () => {
    const own = await app.inject({ method: "PUT", url: `/api/organizations/${orgA.id}`, cookies: (await cookie(admin, orgA.id)), payload: { name: "Updated A", city: "Mumbai" } });
    expect(own.statusCode).toBe(200);
    expect((await Organization.findById(orgA.id))!.image_url).toBe("https://images.example/cover.png");
    for (const payload of [{ status: "inactive" }, { maxStaff: 500 }]) expect((await app.inject({ method: "PUT", url: `/api/organizations/${orgA.id}`, cookies: (await cookie(admin, orgA.id)), payload })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: `/api/organizations/${orgB.id}`, cookies: (await cookie(admin, orgA.id)), payload: { name: "Attack" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/api/organizations/${orgA.id}`, cookies: (await cookie(admin, orgA.id)) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/admin/users", cookies: (await cookie(admin, orgA.id)) })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: `/api/admin/users/${root.id}/status`, cookies: (await cookie(admin, orgA.id)), payload: { isActive: false } })).statusCode).toBe(403);
    const list = await app.inject({ method: "GET", url: "/api/organizations", cookies: (await cookie(admin, orgA.id)) });
    expect(list.json().data.map((org: any) => org.id)).toEqual([orgA.id]);
  });

  it("Root configures selected organizations without switching the session; invites cannot cross tenants", async () => {
    expect((await app.inject({ method: "PUT", url: `/api/organizations/${orgA.id}`, cookies: (await cookie(root)), payload: { maxStaff: 25 } })).statusCode).toBe(200);
    expect((await Organization.findById(orgA.id))!.maxStaff).toBe(25);
    const created = await app.inject({ method: "POST", url: `/api/onboarding/staff?organizationId=${orgA.id}`, cookies: (await cookie(root)), payload: { name: "New Nurse", email: "new-nurse@management.test", password: "Password123!", role: "nurse" } });
    expect(created.statusCode).toBe(201);
    expect(await OrgMember.exists({ userId: created.json().data.id, organizationId: orgA.id })).toBeTruthy();
    const invited = await app.inject({ method: "POST", url: `/api/onboarding/invitations?organizationId=${orgA.id}`, cookies: (await cookie(root)), payload: { email: "invite@management.test", role: "nurse" } });
    expect(invited.statusCode).toBe(201);
    expect(await OrgInvite.exists({ email: "invite@management.test", organizationId: orgA.id })).toBeTruthy();
    expect((await app.inject({ method: "POST", url: `/api/onboarding/invitations?organizationId=${orgB.id}`, cookies: (await cookie(admin, orgA.id)), payload: { email: "cross@management.test", role: "nurse" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/onboarding/invitations?organizationId=${orgA.id}`, cookies: (await cookie(admin, orgA.id)), payload: { email: "root-invite@management.test", role: "root" } })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await app.inject({ method: "GET", url: `/api/onboarding/locations?organizationId=${orgA.id}`, cookies: (await cookie(root)) })).json().data.every((c: any) => c.organizationId === orgA.id)).toBe(true);
    expect((await app.inject({ method: "POST", url: "/api/onboarding/locations", cookies: (await cookie(admin, orgA.id)), payload: { organizationId: orgB.id, name: "Wrong Tenant", city: "Delhi" } })).statusCode).toBe(403);
  });

  it("preserves membership role over clinical profile and blocks global role changes for shared identities", async () => {
    await Doctor.create({ userId: admin._id, organizationId: orgA._id, specialization: "General medicine" });
    const res = await app.inject({ method: "GET", url: `/api/onboarding/organizations/${orgA.id}/members`, cookies: (await cookie(root)) });
    expect(res.json().data.members.find((m: any) => m.id === admin.id).role).toBe("admin");
    const shared = await User.create({ name: "Shared Nurse", email: "shared@management.test", role: "nurse" });
    await OrgMember.create([{ userId: shared._id, organizationId: orgA._id, role: "nurse" }, { userId: shared._id, organizationId: orgB._id, role: "nurse" }]);
    expect((await app.inject({ method: "PUT", url: `/api/users/${shared.id}/role?organizationId=${orgA.id}`, cookies: (await cookie(root)), payload: { role: "cashier" } })).statusCode).toBe(409);
    const global = await app.inject({ method: "GET", url: `/api/admin/users?q=shared`, cookies: (await cookie(root)) });
    expect(global.json().data.users[0].memberships).toHaveLength(2);
    expect((await app.inject({ method: "DELETE", url: `/api/organizations/${orgA.id}/members/${shared.id}`, cookies: (await cookie(admin, orgA.id)) })).statusCode).toBe(200);
    expect((await User.findById(shared.id))!.isActive).toBe(true);
    expect(await OrgMember.exists({ userId: shared.id, organizationId: orgB.id })).toBeTruthy();
  });

  it("scopes Root role overrides to the selected tenant and protects the last administrator", async () => {
    const updated = await app.inject({ method: "PUT", url: `/api/roles/nurse?organizationId=${orgB.id}`, cookies: (await cookie(root)), payload: { permissions: ["VIEW_PATIENTS"] } });
    expect(updated.statusCode).toBe(200);
    expect(await Role.exists({ name: "nurse", organizationId: orgB.id })).toBeTruthy();
    const otherRoot = await User.create({ name: "Root two", email: "root-two@management.test", role: "root" });
    expect((await app.inject({ method: "DELETE", url: `/api/organizations/${orgA.id}/members/${admin.id}`, cookies: (await cookie(otherRoot)) })).statusCode).toBe(409);
    expect((await app.inject({ method: "PUT", url: `/api/users/${admin.id}/role?organizationId=${orgA.id}`, cookies: (await cookie(otherRoot)), payload: { role: "nurse" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: `/api/organizations/${orgA.id}/members/${admin.id}`, cookies: (await cookie(admin, orgA.id)) })).statusCode).toBe(400);
  });
});
