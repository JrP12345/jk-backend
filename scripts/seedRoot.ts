import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { User } from "../models/User.ts";
import { SaaSPlan } from "../models/SaaSPlan.ts";
import { developmentDatabaseName, assertDevelopmentDatabaseEmpty } from "./developmentDatabase.ts";

async function seedRoot() {
  const uri = process.env.MONGODB_URI || "";
  developmentDatabaseName(uri, process.argv.slice(2), process.env.NODE_ENV);
  const email = process.env.ROOT_ADMIN_EMAIL;
  const password = process.env.ROOT_ADMIN_PASSWORD;
  if (!email || !password || password.length < 12) throw new Error("ROOT_ADMIN_EMAIL and ROOT_ADMIN_PASSWORD (at least 12 characters) are required");
  try {
    await mongoose.connect(uri);
    await assertDevelopmentDatabaseEmpty(mongoose.connection);
    await SaaSPlan.create([
      {
        name: "Starter",
        slug: "starter",
        description: "Essential healthcare tools for individual practitioners and small single-branch locations.",
        monthlyPrice: 1999,
        annualPrice: 19990,
        currency: "INR",
        trialDays: 15,
        status: "active",
        displayOrder: 1,
        isPopular: false,
        limits: { maxLocations: 1, maxDoctors: 2, maxStaff: 5, maxPatients: 500, maxAppointments: 1000, maxStorageMB: 2048 },
        features: { analytics: true, auditLogs: false, multiBranch: false, dataExport: false, apiAccess: false, aiFeatures: false }
      },
      {
        name: "Professional",
        slug: "professional",
        description: "Complete management suite for growing multi-doctor locations and diagnostic centers.",
        monthlyPrice: 4999,
        annualPrice: 49990,
        currency: "INR",
        trialDays: 15,
        status: "active",
        displayOrder: 2,
        isPopular: true,
        limits: { maxLocations: 5, maxDoctors: 15, maxStaff: 25, maxPatients: 5000, maxAppointments: 10000, maxStorageMB: 10240 },
        features: { analytics: true, auditLogs: true, multiBranch: true, dataExport: true, apiAccess: false, aiFeatures: true }
      },
      {
        name: "Enterprise",
        slug: "enterprise",
        description: "Advanced infrastructure with dedicated AI engines, unlimited branches, and custom SLA for large healthcare organizations.",
        monthlyPrice: 14999,
        annualPrice: 149990,
        currency: "INR",
        trialDays: 15,
        status: "active",
        displayOrder: 3,
        isPopular: false,
        limits: { maxLocations: 99, maxDoctors: 999, maxStaff: 999, maxPatients: 99999, maxAppointments: 999999, maxStorageMB: 102400 },
        features: { analytics: true, auditLogs: true, multiBranch: true, dataExport: true, apiAccess: true, aiFeatures: true }
      }
    ]);
    await User.create({ name: "Ekavyu Root", email, password: await bcrypt.hash(password, 12), role: "root", twoFactorEnabled: false, isActive: true });
    console.log("Current plans and root account created. Enroll root MFA before signing in.");
  } finally { await mongoose.disconnect(); }
}
seedRoot().catch(error => { console.error(error.message); process.exitCode = 1; });
