import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { app } from "../index.ts";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Organization } from "../models/Organization.ts";
import { RefreshToken } from "../models/RefreshToken.ts";
import { createAuthSession, generateAccessToken, verifyAccessToken } from "../utilities/helpers.ts";
import { resolveSession, revokeUserSessions } from "../utilities/sessionResolver.ts";
import { verifyGoogleIdToken } from "../services/GoogleAuthService.ts";
import { PendingTwoFactorSetup } from '../models/PendingTwoFactorSetup.ts';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Phase 1 authentication authority", () => {
  it('rejects staff phone OTP login and ignores an unverified secondary phone in email OTP login', async () => {
    const staff = await User.create({ name: 'Staff', role: 'root', email: 'staff-phone@example.test', phone: '9991112222' });
    const denied = await app.inject({ method: 'POST', url: '/api/auth/otp/verify', payload: { phone: staff.phone, otp: 'bypass' } });
    expect(denied.statusCode).toBe(403);
    const patient = await User.create({ name: 'Patient', role: 'patient', email: 'patient-phone@example.test', phone: '9991113333' });
    const response = await app.inject({ method: 'POST', url: '/api/auth/otp/verify', payload: { email: 'new-email@example.test', phone: patient.phone, otp: 'bypass', name: 'Email owner' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.user.id).not.toBe(patient.id);
    expect((await User.findById(patient._id))?.email).toBe(patient.email);
  });
  it('prevents guest account management and MFA setup with client-selected or expired secrets', async () => {
    const user = await User.create({ name: 'MFA enrolment', role: 'patient', email: 'mfa-enrol@example.test' });
    const guest = await createAuthSession({ id: user.id, role: 'guest', email: user.email! });
    const call = (path: string, token: string, payload: object = {}) => app.inject({ method: 'POST', url: path, cookies: { access_token: token }, payload });
    expect((await call('/api/onboarding/totp/setup', guest.accessToken)).statusCode).toBe(403);
    const auth = await createAuthSession({ id: user.id, role: 'patient', email: user.email! });
    await PendingTwoFactorSetup.create({ userId: user._id, secret: 'JBSWY3DPEHPK3PXP', expiresAt: new Date(Date.now() - 1000) });
    expect((await call('/api/onboarding/totp/verify', auth.accessToken, { secret: 'JBSWY3DPEHPK3PXP', token: '123456' })).statusCode).toBe(400);
    expect((await User.findById(user._id))?.twoFactorEnabled).toBe(false);
  });
  it("requires local MFA after Google identity proof without creating a login session", async () => {
    const user = await User.create({ name: "Google MFA", email: "phase1-mfa@example.test", role: "root",
      twoFactorEnabled: true, twoFactorSecret: "JBSWY3DPEHPK3PXP" });
    const res = await app.inject({ method: "POST", url: "/api/auth/google",
      payload: { credential: `mock_google_token_${user.email}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.twoFactorRequired).toBe(true);
    expect(res.cookies.find(cookie => cookie.name === "access_token")?.value).toBeFalsy();
    expect(await RefreshToken.countDocuments({ userId: user._id })).toBe(0);
  });

  it("binds new access tokens and rejects user revocation from persisted state", async () => {
    const user = await User.create({ name: "Revocation", email: "phase1-revoke@example.test", role: "patient" });
    const session = await createAuthSession({ id: user.id, email: user.email!, role: "patient" });
    expect(verifyAccessToken(session.accessToken).sessionId).toBe(session.sessionId);
    expect((await resolveSession(session.sessionId)).valid).toBe(true);
    await revokeUserSessions(user.id);
    expect((await resolveSession(session.sessionId)).valid).toBe(false);
    const res = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { access_token: session.accessToken } });
    expect(res.statusCode).toBe(401);
  });

  it("rejects sessionless tokens outside fixture mode", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const token = generateAccessToken({ id: "111111111111111111111111", email: "", role: "root" });
    const res = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { access_token: token } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Session refresh required");
  });

  it("checks Google JWT audience, signature, expiry and verified email with cached certificates", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "phase1-client");
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ keys: [
      { ...publicKey.export({ format: "jwk" }), kid: "testkid", alg: "RS256", use: "sig" },
    ] }), { status: 200, headers: { "cache-control": "max-age=300" } }));
    vi.stubGlobal("fetch", fetch);
    const jwt = await import("jsonwebtoken");
    const sign = (claims: Record<string, unknown> = {}, audience = "phase1-client") => jwt.default.sign({
      sub: "subject", email: "user@gmail.com", email_verified: true, ...claims,
    }, privateKey, { algorithm: "RS256", keyid: "testkid", audience, issuer: "https://accounts.google.com" });
    expect(await verifyGoogleIdToken(sign({ exp: Math.floor(Date.now() / 1000) + 120 })))
      .toMatchObject({ sub: "subject", email: "user@gmail.com" });
    expect(await verifyGoogleIdToken(sign({ exp: Math.floor(Date.now() / 1000) + 120 }, "foreign-client"))).toBeNull();
    expect(await verifyGoogleIdToken(sign({ exp: Math.floor(Date.now() / 1000) - 1 }))).toBeNull();
    expect(await verifyGoogleIdToken(sign({ email_verified: false, exp: Math.floor(Date.now() / 1000) + 120 }))).toBeNull();
    const altered = sign({ exp: Math.floor(Date.now() / 1000) + 120 }).split(".");
    altered[2] = (altered[2][0] === "A" ? "B" : "A") + altered[2].slice(1);
    expect(await verifyGoogleIdToken(altered.join("."))).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("consumes signed SSO assertions once and preserves local MFA", async () => {
    vi.stubEnv("SSO_CALLBACK_SECRET", "phase1-only-signed-bridge-fixture-key");
    vi.stubEnv("SSO_CALLBACK_AUDIENCE", "phase1-app");
    const org = await Organization.create({ name: "SSO fixture", city: "Pune" });
    const user = await User.create({ name: "SSO MFA", email: "phase1-sso@example.test", role: "admin",
      twoFactorEnabled: true, twoFactorSecret: "JBSWY3DPEHPK3PXP" });
    await OrgMember.create({ userId: user._id, organizationId: org._id, role: "admin" });
    const now = Math.floor(Date.now() / 1000);
    const body = { email: user.email, name: user.name, provider: "okta", externalId: "provisioned-subject",
      aud: "phase1-app", iat: now, exp: now + 120, nonce: "phase1-assertion-unique-nonce" };
    const signature = crypto.createHmac("sha256", process.env.SSO_CALLBACK_SECRET!).update(JSON.stringify(body)).digest("hex");
    const send = () => app.inject({ method: "POST", url: "/api/auth/sso/callback", payload: body,
      headers: { "x-sso-signature": signature } });
    const first = await send();
    expect(first.statusCode).toBe(200);
    expect(first.json().data.twoFactorRequired).toBe(true);
    expect(await RefreshToken.countDocuments({ userId: user._id })).toBe(0);
    expect((await send()).statusCode).toBe(401);
  });
});
