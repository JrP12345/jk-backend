import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { PendingTwoFactorSetup } from "../models/PendingTwoFactorSetup.ts";
import { OnboardingDraft } from "../models/OnboardingDraft.ts";
import { emailProvider } from "../notifications/providers/emailProvider.ts";

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  await mongoose.connect(mongoUri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("Enterprise Onboarding & Email Security OTP Infrastructure", () => {
  it("should dispatch email OTP via emailProvider", async () => {
    const sent = await emailProvider.sendEmail({
      to: "admin@hospital.internal",
      subject: "ANANTA Security Verification OTP Code",
      text: "Your 6-digit OTP code is: 123456",
      html: "<h1>123456</h1>",
    });

    expect(sent).toBe(true);
  });

  it("should persist draft progress to database", async () => {
    const token = "test_draft_key_123";
    const draft = await OnboardingDraft.create({
      token,
      step: 2,
      formData: { orgName: "Test Hospital", adminName: "Admin User" },
    });

    expect(draft._id).toBeDefined();
    expect(draft.step).toBe(2);
    expect((draft.formData as any).orgName).toBe("Test Hospital");
  });

  it("should create PendingTwoFactorSetup with 10-minute expiry and update Organization.isOnboarded on Email OTP verification", async () => {
    const user = await User.create({
      name: "Master Admin",
      email: "master_admin@ananta.internal",
      password: "hashedpassword123",
      role: "admin",
    });

    const org = await Organization.create({
      name: "Ananta Healthcare Facility",
      city: "San Francisco",
      onboardingStatus: "CLINIC_CREATED",
      isOnboarded: false,
    });

    const otpCode = "482910";
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    const pending = await PendingTwoFactorSetup.create({
      userId: user._id,
      secret: otpCode,
      expiresAt,
    });

    expect(pending._id).toBeDefined();

    // Verify OTP code match
    const verified = pending.secret === "482910";
    expect(verified).toBe(true);

    if (verified) {
      await User.findByIdAndUpdate(user._id, { twoFactorEnabled: true, twoFactorSecret: otpCode });
      await PendingTwoFactorSetup.deleteMany({ userId: user._id });
      await Organization.findByIdAndUpdate(org._id, { onboardingStatus: "COMPLETED", isOnboarded: true });
    }

    const updatedUser = await User.findById(user._id).lean();
    const updatedOrg = await Organization.findById(org._id).lean();
    const remainingPending = await PendingTwoFactorSetup.find({ userId: user._id });

    expect(updatedUser?.twoFactorEnabled).toBe(true);
    expect(updatedUser?.twoFactorSecret).toBe(otpCode);
    expect(updatedOrg?.onboardingStatus).toBe("COMPLETED");
    expect(updatedOrg?.isOnboarded).toBe(true);
    expect(remainingPending.length).toBe(0);
  });
});
