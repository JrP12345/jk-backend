import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import app from "../index.js";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { RefreshToken } from "../models/RefreshToken.ts";
import { OrgInvite } from "../models/OrgInvite.ts";
import { Role } from "../models/Role.ts";
import bcrypt from "bcryptjs";

describe("Milestone 2: Identity & Authorization Hardening Tests", () => {
  it("should lockout account after 5 consecutive failed login attempts", async () => {
    const email = "lockout_test@ananta.internal";
    const password = "Password123!";
    const hashedPassword = await bcrypt.hash(password, 10);

    await User.create({
      name: "Lockout Test User",
      email,
      password: hashedPassword,
      role: "doctor",
    });

    // Make 4 failed attempts from distinct simulated IPs
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: `10.0.0.${i + 1}`,
        payload: { email, password: "WrongPassword!" },
      });
      expect(res.statusCode).toBe(401);
    }

    // 5th failed attempt triggers 15-minute lockout
    const res5 = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "10.0.0.5",
      payload: { email, password: "WrongPassword!" },
    });
    expect(res5.statusCode).toBe(401);

    // 6th attempt (even with correct password) must be rejected with 429 Account Locked
    const res6 = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "10.0.0.6",
      payload: { email, password },
    });
    expect(res6.statusCode).toBe(429);
    expect(JSON.parse(res6.body).message).toContain("Account locked");
  });

  it("should enforce maximum 5 active sessions per user", async () => {
    const email = "session_limit@ananta.internal";
    const password = "Password123!";
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      name: "Session Limit User",
      email,
      password: hashedPassword,
      role: "doctor",
    });

    // Perform 6 logins with different IPs to bypass IP rate-limiter
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: `10.1.0.${i + 1}`,
        payload: { email, password },
      });
      expect(res.statusCode).toBe(200);
    }

    // Check RefreshToken count for this user
    const activeTokens = await RefreshToken.find({ userId: user._id, revoked: false });
    expect(activeTokens.length).toBeLessThanOrEqual(5);
  });

  it("should generate password reset link and reset password cleanly", async () => {
    const email = "reset_test@ananta.internal";
    const oldPassword = "Password123!";
    const newPassword = "NewSecurePassword123!";
    const hashedPassword = await bcrypt.hash(oldPassword, 10);

    const user = await User.create({
      name: "Reset Password User",
      email,
      password: hashedPassword,
      role: "patient",
    });

    // 1. Request forgot password
    const forgotRes = await app.inject({
      method: "POST",
      url: "/api/auth/forgot-password",
      remoteAddress: "10.2.0.1",
      payload: { email },
    });
    expect(forgotRes.statusCode).toBe(200);

    const updatedUser = await User.findById(user._id);
    expect(updatedUser?.passwordResetToken).toBeDefined();

    const token = updatedUser!.passwordResetToken!;

    // 2. Reset password
    const resetRes = await app.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      remoteAddress: "10.2.0.2",
      payload: { token, newPassword },
    });
    expect(resetRes.statusCode).toBe(200);

    // 3. Verify login with new password
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "10.2.0.3",
      payload: { email, password: newPassword },
    });
    expect(loginRes.statusCode).toBe(200);
  });

  it("should allow admin to invite staff and allow staff to accept invitation", async () => {
    const org = await Organization.create({
      name: "Invite Test Clinic",
      city: "Bangalore",
    });

    const adminUser = await User.create({
      name: "Admin Host",
      email: "admin_host@ananta.internal",
      password: await bcrypt.hash("Password123!", 10),
      role: "admin",
    });

    await OrgMember.create({
      userId: adminUser._id,
      organizationId: org._id,
      role: "admin",
    });

    // 1. Admin dispatches invitation
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "10.3.0.1",
      payload: { email: "admin_host@ananta.internal", password: "Password123!" },
    });
    const cookies = loginRes.cookies;
    const accessToken = cookies.find((c) => c.name === "access_token")?.value || "";

    const inviteRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/invitations",
      remoteAddress: "10.3.0.2",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { email: "invited_nurse@ananta.internal", role: "nurse" },
    });
    expect(inviteRes.statusCode).toBe(201);

    const inviteRecord = await OrgInvite.findOne({ email: "invited_nurse@ananta.internal" });
    expect(inviteRecord).toBeDefined();

    // 2. Accept invitation
    const rawToken = "dummy_test_token";
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    inviteRecord!.set("tokenHash", tokenHash);
    await inviteRecord!.save();

    const acceptRes = await app.inject({
      method: "POST",
      url: "/api/auth/accept-invitation",
      remoteAddress: "10.3.0.3",
      payload: {
        token: rawToken,
        name: "Nurse Betty",
        password: "NewNursePassword123!",
      },
    });
    expect(acceptRes.statusCode).toBe(201);
  });
});
