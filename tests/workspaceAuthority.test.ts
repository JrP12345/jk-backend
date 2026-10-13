import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import speakeasy from "speakeasy";
import { describe, expect, it } from "vitest";
import { app } from "../index.ts";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { RefreshToken } from "../models/RefreshToken.ts";
import { PasskeyChallenge } from "../models/PasskeyChallenge.ts";
import { encryptField } from "../utilities/cryptoEnvelope.ts";
import { createAuthSession, verifyAccessToken } from "../utilities/helpers.ts";

const password = "Workspace123!";
async function fixture(mfa = false) {
  const nonce = crypto.randomUUID();
  const user = await User.create({ name: "Multi-workspace doctor", email: `${nonce}@example.test`,
    password: await bcrypt.hash(password, 4), role: "doctor", twoFactorEnabled: mfa,
    ...(mfa ? { twoFactorSecret: encryptField("JBSWY3DPEHPK3PXP") } : {}) });
  const a = await Organization.create({ name: `Clinic A ${nonce}`, city: "Pune" });
  const b = await Organization.create({ name: `Clinic B ${nonce}`, city: "Pune" });
  await OrgMember.create([{ userId: user._id, organizationId: a._id, role: "doctor" },
    { userId: user._id, organizationId: b._id, role: "receptionist" }]);
  return { user, a, b };
}
const signIn = (email: string) => app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
const select = (workspaceToken: string, organizationId: string) => app.inject({ method: "POST", url: "/api/auth/login/workspace", payload: { workspaceToken, organizationId } });

describe("Explicit staff workspace authority", () => {
  it("requires a workspace after credentials, issues no session, and rejects the challenge as API authority", async () => {
    const { user, a, b } = await fixture();
    const login = await signIn(user.email!);
    expect(login.statusCode).toBe(200);
    expect(login.json().data).toMatchObject({ workspaceRequired: true,
      workspaces: [{ organizationId: a.id, role: "doctor" }, { organizationId: b.id, role: "receptionist" }] });
    expect(login.json().data.user).toBeUndefined();
    expect(await RefreshToken.countDocuments({ userId: user._id })).toBe(0);
    const denied = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${login.json().data.workspaceToken}` } });
    expect(denied.statusCode).toBe(401);
  });

  it("uses the selected membership role for login, me, refresh and workspace listing", async () => {
    const { user, b } = await fixture();
    const login = await signIn(user.email!);
    const selected = await select(login.json().data.workspaceToken, b.id);
    expect(selected.statusCode).toBe(200);
    expect(selected.json().data.user).toMatchObject({ organization_id: b.id, role: "receptionist" });
    const access = selected.cookies.find(cookie => cookie.name === "access_token")!.value;
    const refresh = selected.cookies.find(cookie => cookie.name === "refresh_token")!.value;
    const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { access_token: access } });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.user).toMatchObject({ organization_id: b.id, role: "receptionist" });
    expect((await app.inject({ method: "GET", url: "/api/auth/workspaces", cookies: { access_token: access } })).json().data).toHaveLength(2);
    const rotated = await app.inject({ method: "POST", url: "/api/auth/refresh", cookies: { refresh_token: refresh } });
    expect(rotated.statusCode).toBe(200);
    const payload = verifyAccessToken(rotated.cookies.find(cookie => cookie.name === "access_token")!.value);
    expect(payload).toMatchObject({ organization_id: b.id, role: "receptionist" });
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: { access_token: rotated.cookies.find(cookie => cookie.name === "access_token")!.value } })).statusCode).toBe(200);
  });

  it("rejects unrelated workspace selection without consuming the valid challenge, then prevents replay", async () => {
    const { user, a } = await fixture();
    const unrelated = await Organization.create({ name: "Other clinic", city: "Pune" });
    const token = (await signIn(user.email!)).json().data.workspaceToken;
    expect((await select(token, unrelated.id)).statusCode).toBe(403);
    expect((await select(token, a.id)).statusCode).toBe(200);
    expect((await select(token, a.id)).statusCode).toBe(401);
    expect(await RefreshToken.countDocuments({ userId: user._id })).toBe(1);
  });

  it("consumes concurrent workspace selections once", async () => {
    const { user, a, b } = await fixture();
    const token = (await signIn(user.email!)).json().data.workspaceToken;
    const responses = await Promise.all([select(token, a.id), select(token, b.id)]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 401]);
    expect(await RefreshToken.countDocuments({ userId: user._id })).toBe(1);
  });

  it("performs MFA before workspace selection and never uses its challenge as session authority", async () => {
    const { user, a } = await fixture(true);
    const login = await signIn(user.email!);
    expect(login.json().data.twoFactorRequired).toBe(true);
    expect(login.json().data.workspaceToken).toBeUndefined();
    expect(await RefreshToken.countDocuments({ userId: user._id })).toBe(0);
    const verified = await app.inject({ method: "POST", url: "/api/auth/login/verify-2fa", payload: {
      twoFactorToken: login.json().data.twoFactorToken,
      otp: speakeasy.totp({ secret: "JBSWY3DPEHPK3PXP", encoding: "base32" }),
    } });
    expect(verified.json().data.workspaceRequired).toBe(true);
    expect(await RefreshToken.countDocuments({ userId: user._id })).toBe(0);
    expect((await select(verified.json().data.workspaceToken, a.id)).statusCode).toBe(200);
  });

  it("rejects expired challenges and changed account or MFA state", async () => {
    const { user, a } = await fixture();
    let token = (await signIn(user.email!)).json().data.workspaceToken;
    await PasskeyChallenge.updateMany({ userId: user._id, kind: "workspace" }, { expiresAt: new Date(0) });
    expect((await select(token, a.id)).statusCode).toBe(401);
    token = (await signIn(user.email!)).json().data.workspaceToken;
    await User.updateOne({ _id: user._id }, { $inc: { authVersion: 1 } });
    expect((await select(token, a.id)).statusCode).toBe(401);
    token = (await signIn(user.email!)).json().data.workspaceToken;
    await User.updateOne({ _id: user._id }, { twoFactorEnabled: true });
    expect((await select(token, a.id)).statusCode).toBe(401);
  });

  it("requires new credential proof after account revocation during MFA", async () => {
    const { user } = await fixture(true);
    const login = await signIn(user.email!);
    await User.updateOne({ _id: user._id }, { $inc: { authVersion: 1 } });
    const verified = await app.inject({ method: "POST", url: "/api/auth/login/verify-2fa", payload: {
      twoFactorToken: login.json().data.twoFactorToken,
      otp: speakeasy.totp({ secret: "JBSWY3DPEHPK3PXP", encoding: "base32" }),
    } });
    expect(verified.statusCode).toBe(401);
    expect(await RefreshToken.countDocuments({ userId: user._id })).toBe(0);
    expect(await PasskeyChallenge.countDocuments({ userId: user._id, kind: "workspace" })).toBe(0);
  });

  it("rejects access and refresh when a branch grant revision changes", async () => {
    const { user, a } = await fixture();
    const selected = await select((await signIn(user.email!)).json().data.workspaceToken, a.id);
    const access = selected.cookies.find(cookie => cookie.name === "access_token")!.value;
    const refresh = selected.cookies.find(cookie => cookie.name === "refresh_token")!.value;
    await OrgMember.updateOne({ userId: user._id, organizationId: a._id }, { $inc: { accessRevision: 1 } });
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: { access_token: access } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/refresh", cookies: { refresh_token: refresh } })).statusCode).toBe(401);
  });

  it("revokes access when the selected membership changes or is removed", async () => {
    const { user, a } = await fixture();
    const selected = await select((await signIn(user.email!)).json().data.workspaceToken, a.id);
    const access = selected.cookies.find(cookie => cookie.name === "access_token")!.value;
    const refresh = selected.cookies.find(cookie => cookie.name === "refresh_token")!.value;
    await OrgMember.updateOne({ userId: user._id, organizationId: a._id }, { role: "admin" });
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: { access_token: access } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/refresh", cookies: { refresh_token: refresh } })).statusCode).toBe(401);
    await OrgMember.deleteOne({ userId: user._id, organizationId: a._id });
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: { access_token: access } })).statusCode).toBe(401);
  });

  it("switches only to a live membership, revokes the old session and keeps the new role", async () => {
    const { user, a, b } = await fixture();
    const selected = await select((await signIn(user.email!)).json().data.workspaceToken, a.id);
    const access = selected.cookies.find(cookie => cookie.name === "access_token")!.value;
    const switched = await app.inject({ method: "POST", url: "/api/auth/switch-org", cookies: { access_token: access }, payload: { organizationId: b.id } });
    expect(switched.statusCode).toBe(200);
    const next = switched.cookies.find(cookie => cookie.name === "access_token")!.value;
    expect(verifyAccessToken(next)).toMatchObject({ organization_id: b.id, role: "receptionist" });
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: { access_token: access } })).statusCode).toBe(401);
    await Organization.updateOne({ _id: a._id }, { isActive: false });
    expect((await app.inject({ method: "POST", url: "/api/auth/switch-org", cookies: { access_token: next }, payload: { organizationId: a.id } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: { access_token: next } })).statusCode).toBe(200);
  });

  it("requires explicit organization for multi-workspace impersonation and uses its membership role", async () => {
    const { user, b } = await fixture();
    const root = await User.create({ name: "Operator", email: `${crypto.randomUUID()}@example.test`, role: "root" });
    const session = await createAuthSession({ id: root.id, role: "root", email: root.email! });
    expect((await app.inject({ method: "POST", url: "/api/auth/impersonate", cookies: { access_token: session.accessToken }, payload: { userId: user.id } })).statusCode).toBe(409);
    const impersonated = await app.inject({ method: "POST", url: "/api/auth/impersonate", cookies: { access_token: session.accessToken }, payload: { userId: user.id, organizationId: b.id } });
    expect(impersonated.statusCode).toBe(200);
    expect(impersonated.json().data.user.role).toBe("receptionist");
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: { access_token: impersonated.cookies.find(cookie => cookie.name === "access_token")!.value } })).statusCode).toBe(200);
  });
});
