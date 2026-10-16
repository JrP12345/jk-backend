import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import app from "../index.ts";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Receptionist } from "../models/Receptionist.ts";
import { PendingTwoFactorSetup } from "../models/PendingTwoFactorSetup.ts";
import { RefreshToken } from "../models/RefreshToken.ts";
import { resolveStaffLocationGrant } from "../services/LocationAccessService.ts";
import { staffMfaEnrollmentRequired } from "../services/StaffMfaPolicy.ts";
import { productionTransportErrors } from "../utilities/transportConfiguration.ts";
import { safeError } from "../utilities/safeError.ts";
import { fixtureAccessToken } from "./helpers/sessionFixture.ts";
import { createRefreshTokenDetails, generateAccessToken } from "../utilities/helpers.ts";
import speakeasy from "speakeasy";
import { recoverStaffMfa } from "../services/StaffMfaRecovery.ts";
import { encryptBackup, decryptBackup, backupEncryptionKey } from "../utilities/backupArchive.ts";
import zlib from "node:zlib";
import { scrubTelemetry, dispatchOpsAlert } from "../utilities/telemetry.ts";
import { Patient } from "../models/Patient.ts";
import { publicServerFailureMessage } from "../utilities/publicServerError.ts";
import { Types } from "mongoose";

describe("Phase one security closeout", () => {
  let org: any, other: any, branch: any, foreign: any, admin: any, doctor: any, reception: any, nurse: any;
  beforeAll(async () => {
    org = await Organization.create({ name: "Closeout tenant", city: "Surat", plan: "enterprise" });
    other = await Organization.create({ name: "Foreign tenant", city: "Surat", plan: "enterprise" });
    branch = await Location.create({ organizationId: org.id, name: "Owned", city: "Surat" });
    foreign = await Location.create({ organizationId: other.id, name: "Foreign", city: "Surat" });
    admin = await User.create({ name: "Owner", role: "admin" });
    doctor = await User.create({ name: "Doctor", role: "doctor" });
    reception = await User.create({ name: "Reception", role: "receptionist" });
    nurse = await User.create({ name: "Nurse", role: "nurse" });
    await OrgMember.create([admin, doctor, reception, nurse].map(user => ({ userId: user.id, organizationId: org.id, role: user.role })));
    await DoctorAssignment.create({ organizationId: org.id, locationId: branch.id, doctorId: doctor.id, workingHours: "[]" });
    // Corrupt legacy references must never make another tenant's branch visible.
    await DoctorAssignment.create({ organizationId: org.id, locationId: foreign.id, doctorId: doctor.id, workingHours: "[]" });
    await Receptionist.create({ organizationId: org.id, locationId: branch.id, userId: reception.id });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  it("derives only owned legacy grants and denies absent/mismatched membership authority", async () => {
    expect(await resolveStaffLocationGrant(doctor.id, org.id, "doctor")).toEqual([branch.id]);
    expect(await resolveStaffLocationGrant(reception.id, org.id, "receptionist")).toEqual([branch.id]);
    expect(await resolveStaffLocationGrant(nurse.id, org.id, "nurse")).toEqual([]);
    expect(await resolveStaffLocationGrant(nurse.id, org.id, "admin")).toEqual([]);
    expect(await resolveStaffLocationGrant(admin.id, org.id, "admin")).toBeUndefined();
    expect(await resolveStaffLocationGrant(admin.id, other.id, "admin")).toEqual([]);
    await OrgMember.updateOne({ userId: nurse.id, organizationId: org.id }, { $set: { locationAccess: { mode: "selected", locationIds: [branch.id, foreign.id] } } });
    expect(await resolveStaffLocationGrant(nurse.id, org.id, "nurse")).toEqual([branch.id]);
  });
  it("prevents consumer presets and role assignments from becoming staff grants", async () => {
    const cookie = `access_token=${await fixtureAccessToken({ id: admin.id, email: "", role: "admin", organization_id: org.id })}`;
    for (const role of ["patient", "family_member", "root"]) {
      const response = await app.inject({ method: "PUT", url: `/api/users/${nurse.id}/role`, headers: { cookie }, payload: { role } });
      expect(response.statusCode, response.body).toBe(403);
    }
    expect((await app.inject({ method: "PUT", url: "/api/roles/patient", headers: { cookie }, payload: { permissions: ["MANAGE_STAFF"] } })).statusCode).toBe(403);
    expect((await OrgMember.findOne({ userId: nurse.id, organizationId: org.id }))?.role).toBe("nurse");
  });
  it("never serializes raw exception values in ordinary log metadata", () => {
    const error = Object.assign(new Error("Patient confidential@example.test token=secret-value"), { name: "ValidationError", cause: { password: "secret" }, errors: { patient: { value: "Clinical detail" } }, code: 11000 });
    expect(safeError(error)).toEqual({ errorType: "ValidationError", databaseCode: 11000 });
    expect(JSON.stringify(safeError(error))).not.toMatch(/Patient|secret|Clinical|confidential/);
    expect(safeError("arbitrary credential")).toEqual({ errorType: "Error" });
    const guidance = "Registration could not be confirmed. Retry with the same request identifier.";
    expect(publicServerFailureMessage(guidance)).toBe(guidance);
    expect(publicServerFailureMessage(guidance + " Patient secret")).not.toContain("Patient secret");
  });
  it("rejects unsafe production transport configuration without echoing secrets", () => {
    expect(productionTransportErrors({ CORS_ALLOWED_ORIGINS: "https://clinic.example.test", TRUSTED_PROXY_HOPS: "1" })).toEqual([]);
    for (const value of ["http://clinic.example.test", "https://*.example.test", "https://user:private@clinic.example.test", "https://clinic.example.test/path"]) {
      const errors = productionTransportErrors({ CORS_ALLOWED_ORIGINS: value });
      expect(errors.length).toBeGreaterThan(0); expect(errors.join()).not.toContain("private");
    }
    expect(productionTransportErrors({ CORS_ALLOWED_ORIGINS: "https://clinic.example.test", REQUIRE_TRUSTED_PROXY: "true", TRUSTED_PROXY_HOPS: "NaN", COOKIE_SAME_SITE: "invalid" })).toHaveLength(3);
  });
  it("removes free clinical narrative and stack locals from telemetry and operational alerts", async () => {
    const privateText = "Confidential clinical narrative and credential";
    const event: any = scrubTelemetry({ message: privateText, exception: { values: [{ type: "Error", value: privateText,
      stacktrace: { frames: [{ filename: "handler.ts", vars: { note: privateText } }] } }] } });
    expect(JSON.stringify(event)).not.toContain(privateText);
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
    vi.stubEnv("OPS_ALERT_WEBHOOK_URL", "https://ops.example.test/webhook");
    await dispatchOpsAlert("P1_WARNING", "SYNTHETIC_PRIVACY_CHECK", new Error(privateText), { component: "PrivacyTest", note: privateText });
    expect(JSON.stringify(log.mock.calls)).not.toContain(privateText);
    expect(fetchSpy.mock.calls[0][1]?.body).not.toContain(privateText);
  });
  it("supports a dated MFA enrollment rollout without exempting production staff forever", () => {
    expect(staffMfaEnrollmentRequired("nurse", false, { NODE_ENV: "production" })).toBe(true);
    expect(staffMfaEnrollmentRequired("nurse", true, { NODE_ENV: "production" })).toBe(false);
    expect(staffMfaEnrollmentRequired("patient", false, { NODE_ENV: "production" })).toBe(false);
    expect(staffMfaEnrollmentRequired("doctor", false, { NODE_ENV: "production", STAFF_MFA_ENFORCE_AFTER: "2030-01-01T00:00:00Z" }, Date.parse("2026-01-01"))).toBe(false);
  });
  it("keeps handled database exceptions out of production HTTP errors and controller logs", async () => {
    const root = await User.create({ name: "Privacy fixture root", role: "root", twoFactorEnabled: true });
    const cookie = `access_token=${await fixtureAccessToken({ id: root.id, email: "", role: "root", organization_id: org.id })}`;
    const privateText = "Private clinical free text from database exception";
    vi.spyOn(Patient, "findById").mockImplementation(() => { throw new Error(privateText); });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");
    const response = await app.inject({ method: "GET", url: `/api/patients/${branch.id}`, headers: { cookie } });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(privateText);
    expect(JSON.stringify(log.mock.calls)).not.toContain(privateText);
  });
  it("limits unenrolled staff to enrollment, encrypts and binds setup, rotates sessions, and restores operations", async () => {
    vi.stubEnv("STAFF_MFA_REQUIRED", "true");
    const session = await createRefreshTokenDetails(doctor.id, { organizationId: org.id });
    const cookie = `access_token=${generateAccessToken({ id: doctor.id, role: "doctor", email: "", organization_id: org.id, sessionId: session.sessionId, authVersion: session.authVersion })}`;
    expect((await app.inject({ method: "GET", url: "/api/patients", headers: { cookie } })).json().code).toBe("MFA_ENROLLMENT_REQUIRED");
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200); expect(me.json().data.user.mfaEnrollmentRequired).toBe(true);
    const setup = await app.inject({ method: "POST", url: "/api/onboarding/totp/setup", headers: { cookie }, payload: {} });
    expect(setup.statusCode, setup.body).toBe(200);
    const pending = await PendingTwoFactorSetup.collection.findOne({ userId: doctor._id });
    expect(pending?.secret).toMatch(/^enc:v1:/); expect(pending?.sessionId).toBe(session.sessionId);
    const secondCookie = `access_token=${await fixtureAccessToken({ id: doctor.id, email: "", role: "doctor", organization_id: org.id })}`;
    const token = speakeasy.totp({ secret: setup.json().data.secret, encoding: "base32" });
    expect((await app.inject({ method: "POST", url: "/api/onboarding/totp/verify", headers: { cookie: secondCookie }, payload: { token } })).statusCode).toBe(400);
    const verified = await app.inject({ method: "POST", url: "/api/onboarding/totp/verify", headers: { cookie }, payload: { token } });
    expect(verified.statusCode, verified.body).toBe(200);
    expect((await RefreshToken.findById(session.sessionId))?.revoked).toBe(true);
    const newCookie = verified.cookies.map(value => `${value.name}=${value.value}`).join("; ");
    const enabled = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: newCookie } });
    expect(enabled.statusCode, enabled.body).toBe(200); expect(enabled.json().data.user.mfaEnrollmentRequired).toBe(false);
    expect((await app.inject({ method: "GET", url: "/api/clinical/opd-templates", headers: { cookie: newCookie } })).statusCode).toBe(200);
  });

  it("requires an independent root review for MFA recovery and invalidates every old session", async () => {
    const before = await User.findById(doctor.id);
    await expect(recoverStaffMfa(doctor.id, nurse.id, before!.authVersion)).rejects.toMatchObject({ statusCode: 403 });
    const reviewer = await User.create({ name: "Recovery operator", role: "root", twoFactorEnabled: true });
    await recoverStaffMfa(doctor.id, reviewer.id, before!.authVersion);
    expect((await User.findById(doctor.id))?.twoFactorEnabled).toBe(false);
    expect(await RefreshToken.countDocuments({ userId: doctor.id, revoked: false })).toBe(0);
    vi.stubEnv("STAFF_MFA_ENFORCE_AFTER", "2099-01-01T00:00:00Z");
    const cookie = `access_token=${await fixtureAccessToken({ id: doctor.id, role: "doctor", email: "", organization_id: org.id })}`;
    expect((await app.inject({ method: "GET", url: "/api/patients", headers: { cookie } })).json().code).toBe("MFA_ENROLLMENT_REQUIRED");
    await expect(recoverStaffMfa(doctor.id, reviewer.id, before!.authVersion)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("uses the actual bounded archive codec and rejects tampering, oversized output and invalid headers", () => {
    const key = backupEncryptionKey("00".repeat(32));
    const bytes = Buffer.from(JSON.stringify({ patients: [{ name: "Synthetic fixture" }] }));
    const archive = encryptBackup(zlib.gzipSync(bytes), key);
    expect(decryptBackup(archive, key)).toEqual(bytes);
    const tampered = Buffer.from(archive); tampered[tampered.length - 1] ^= 1;
    expect(() => decryptBackup(tampered, key)).toThrow();
    expect(() => decryptBackup(Buffer.from("v1:bad:header:\nbytes"), key)).toThrow("Invalid backup header");
    const bomb = encryptBackup(zlib.gzipSync(Buffer.alloc(10000)), key);
    expect(() => decryptBackup(bomb, key, 512)).toThrow();
    expect(() => backupEncryptionKey("short")).toThrow();
  });
  it("does not turn refresh rotation into recent credential proof for authenticator enrollment", async () => {
    const staff = await User.create({ name: "Recent-login fixture", role: "nurse" });
    await OrgMember.create({ userId: staff.id, organizationId: org.id, role: "nurse", locationAccess: { mode: "all" } });
    const oldProof = new Date(Date.now() - 11 * 60_000);
    const session = await createRefreshTokenDetails(staff.id, { organizationId: org.id, authenticatedAt: oldProof });
    const refreshed = await app.inject({ method: "POST", url: "/api/auth/refresh", cookies: { refresh_token: session.rawToken } });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    const cookie = refreshed.cookies.map(value => `${value.name}=${value.value}`).join("; ");
    expect((await app.inject({ method: "POST", url: "/api/onboarding/totp/setup", headers: { cookie }, payload: {} })).statusCode).toBe(401);
    const rotated = await RefreshToken.findOne({ userId: staff.id, revoked: false });
    expect(rotated?.authenticatedAt?.getTime()).toBe(oldProof.getTime());
  });
  it("denies portal identities access to staff authenticator setup", async () => {
    const patient = await User.create({ name: "Portal enrollment fixture", role: "patient" });
    const cookie = `access_token=${await fixtureAccessToken({ id: patient.id, role: "patient", email: "" })}`;
    expect((await app.inject({ method: "POST", url: "/api/onboarding/totp/setup", headers: { cookie }, payload: {} })).statusCode).toBe(403);
    expect(await PendingTwoFactorSetup.countDocuments({ userId: patient.id })).toBe(0);
  });
  it("requires a fresh login for legacy sessions rather than using refresh creation time", async () => {
    const staff = await User.create({ name: "Legacy proof fixture", role: "nurse" });
    await OrgMember.create({ userId: staff.id, organizationId: org.id, role: "nurse" });
    const session = await createRefreshTokenDetails(staff.id, { organizationId: org.id });
    await RefreshToken.collection.updateOne({ _id: new Types.ObjectId(session.sessionId) }, { $unset: { authenticatedAt: 1 } });
    const refreshed = await app.inject({ method: "POST", url: "/api/auth/refresh", cookies: { refresh_token: session.rawToken } });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    const cookie = refreshed.cookies.map(value => `${value.name}=${value.value}`).join("; ");
    expect((await app.inject({ method: "POST", url: "/api/onboarding/totp/setup", headers: { cookie }, payload: {} })).statusCode).toBe(401);
    expect((await RefreshToken.findOne({ userId: staff.id, revoked: false }))?.authenticatedAt?.getTime()).toBe(0);
  });
  it("does not make workspace selection a substitute for recent primary credentials", async () => {
    const staff = await User.create({ name: "Workspace proof fixture", role: "nurse" });
    await OrgMember.create([org, other].map(organization => ({ userId: staff.id, organizationId: organization.id, role: "nurse", locationAccess: { mode: "all" as const } })));
    const oldProof = new Date(Date.now() - 11 * 60_000);
    const session = await createRefreshTokenDetails(staff.id, { organizationId: org.id, authenticatedAt: oldProof });
    const cookie = `access_token=${generateAccessToken({ id: staff.id, role: "nurse", email: "", organization_id: org.id, sessionId: session.sessionId, authVersion: session.authVersion })}`;
    const switched = await app.inject({ method: "POST", url: "/api/auth/switch-org", headers: { cookie }, payload: { organizationId: other.id } });
    expect(switched.statusCode, switched.body).toBe(200);
    const newCookie = switched.cookies.map(value => `${value.name}=${value.value}`).join("; ");
    expect((await app.inject({ method: "POST", url: "/api/onboarding/totp/setup", headers: { cookie: newCookie }, payload: {} })).statusCode).toBe(401);
    expect((await RefreshToken.findOne({ userId: staff.id, revoked: false }))?.authenticatedAt?.getTime()).toBe(oldProof.getTime());
  });
});
