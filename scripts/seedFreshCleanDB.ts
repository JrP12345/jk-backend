import mongoose from "mongoose";
import bcrypt from "bcryptjs";

// Import Models
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Clinic } from "../models/Clinic.ts";
import { Department } from "../models/Department.ts";
import { Doctor } from "../models/Doctor.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Receptionist } from "../models/Receptionist.ts";
import { Patient } from "../models/Patient.ts";
import { Encounter } from "../models/Encounter.ts";
import { Appointment } from "../models/Appointment.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { Prescription } from "../models/Prescription.ts";
import { Medicine } from "../models/Medicine.ts";
import { LabTest } from "../models/LabTest.ts";
import { LabOrder } from "../models/LabOrder.ts";
import { Observation } from "../models/Observation.ts";
import { ObservationScore } from "../models/ObservationScore.ts";
import { ObservationAlert } from "../models/ObservationAlert.ts";
import { CDSEvaluation } from "../models/CDSEvaluation.ts";
import { Invoice } from "../models/Invoice.ts";
import { TaskModel } from "../models/Task.ts";
import { Notification } from "../models/Notification.ts";
import { NotificationDelivery } from "../models/NotificationDelivery.ts";
import { NotificationPreference } from "../models/NotificationPreference.ts";
import { NotificationTemplate } from "../models/NotificationTemplate.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Counter } from "../models/Counter.ts";
import { Role } from "../models/Role.ts";
import { Permission } from "../models/Permission.ts";
import { PendingTwoFactorSetup } from "../models/PendingTwoFactorSetup.ts";
import { OnboardingDraft } from "../models/OnboardingDraft.ts";
import { RefreshToken } from "../models/RefreshToken.ts";
import { ModuleRegistry } from "../models/ModuleRegistry.ts";
import { SaaSPlan } from "../models/SaaSPlan.ts";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/ananta_health";

async function runPureRootOnlySeed() {
  if (process.env.NODE_ENV === "production") {
    console.error("FATAL: Destructive database seed scripts cannot be executed in production!");
    process.exit(1);
  }

  console.log("=======================================================================");
  console.log("🧹 [ANANTA HEALTHCARE SYSTEM] PURE ROOT-ONLY FRESH SETUP");
  console.log("=======================================================================");

  try {
    await mongoose.connect(MONGODB_URI);
    console.log("✓ Connected to MongoDB Atlas cluster.");

    // -------------------------------------------------------------------------
    // 1. WIPE 100% OF ALL EXISTING DATABASE COLLECTIONS
    // -------------------------------------------------------------------------
    console.log("\n🧹 Purging all 38 database collections...");
    await Promise.all([
      User.deleteMany({}),
      Organization.deleteMany({}),
      OrgMember.deleteMany({}),
      Clinic.deleteMany({}),
      Department.deleteMany({}),
      Doctor.deleteMany({}),
      DoctorAssignment.deleteMany({}),
      Receptionist.deleteMany({}),
      Patient.deleteMany({}),
      Encounter.deleteMany({}),
      Appointment.deleteMany({}),
      ClinicalNote.deleteMany({}),
      Prescription.deleteMany({}),
      Medicine.deleteMany({}),
      LabTest.deleteMany({}),
      LabOrder.deleteMany({}),
      Observation.deleteMany({}),
      ObservationScore.deleteMany({}),
      ObservationAlert.deleteMany({}),
      CDSEvaluation.deleteMany({}),
      Invoice.deleteMany({}),
      TaskModel.deleteMany({}),
      Notification.deleteMany({}),
      NotificationDelivery.deleteMany({}),
      NotificationPreference.deleteMany({}),
      NotificationTemplate.deleteMany({}),
      AuditLog.deleteMany({}),
      Counter.deleteMany({}),
      Role.deleteMany({}),
      Permission.deleteMany({}),
      PendingTwoFactorSetup.deleteMany({}),
      OnboardingDraft.deleteMany({}),
      RefreshToken.deleteMany({}),
      ModuleRegistry.deleteMany({}),
      SaaSPlan.deleteMany({}),
    ]);
    console.log("✓ All collections purged successfully.");

    // -------------------------------------------------------------------------
    // 2. SEED COMMERCIAL SAAS PLANS (Required for Onboarding Flow)
    // -------------------------------------------------------------------------
    console.log("\n💳 Seeding SaaS Commercial Plans...");
    await SaaSPlan.create([
      {
        name: "Starter",
        slug: "starter",
        description: "Essential healthcare tools for individual practitioners and small single-branch clinics.",
        monthlyPrice: 1999,
        annualPrice: 19990,
        currency: "INR",
        trialDays: 15,
        status: "active",
        displayOrder: 1,
        isPopular: false,
        limits: { maxClinics: 1, maxDoctors: 2, maxStaff: 5, maxPatients: 500, maxAppointments: 1000, maxStorageMB: 2048 },
        features: { analytics: true, auditLogs: false, multiBranch: false, dataExport: false, apiAccess: false, aiFeatures: false }
      },
      {
        name: "Professional",
        slug: "professional",
        description: "Complete management suite for growing multi-doctor clinics and diagnostic centers.",
        monthlyPrice: 4999,
        annualPrice: 49990,
        currency: "INR",
        trialDays: 15,
        status: "active",
        displayOrder: 2,
        isPopular: true,
        limits: { maxClinics: 5, maxDoctors: 15, maxStaff: 25, maxPatients: 5000, maxAppointments: 10000, maxStorageMB: 10240 },
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
        limits: { maxClinics: 99, maxDoctors: 999, maxStaff: 999, maxPatients: 99999, maxAppointments: 999999, maxStorageMB: 102400 },
        features: { analytics: true, auditLogs: true, multiBranch: true, dataExport: true, apiAccess: true, aiFeatures: true }
      }
    ]);
    console.log("✓ SaaS Commercial Plans seeded.");

    // -------------------------------------------------------------------------
    // 3. SEED PLATFORM ROOT SUPER ADMIN ONLY
    // -------------------------------------------------------------------------
    console.log("\n👑 Seeding Platform Root Admin Account ONLY...");
    const hashedPassword = await bcrypt.hash("Password123!", 10);
    const rootAdmin = await User.create({
      name: "Jay (Root Admin)",
      email: "21amtics177@gmail.com",
      password: hashedPassword,
      phone: "+1 234 567 8900",
      role: "root",
      // Provision an individual secret after seeding; a checked-in secret is
      // not a valid or safe root MFA credential.
      twoFactorEnabled: false,
      isActive: true,
    });
    console.log("✓ Root Admin account created:", rootAdmin.email);

    console.log("\n=======================================================================");
    console.log("🎉 PURE ROOT-ONLY DATABASE SETUP COMPLETED!");
    console.log("=======================================================================");
    console.log("Organizations  : 0 (Pure Clean)");
    console.log("Clinics        : 0 (Pure Clean)");
    console.log("Patients       : 0 (Pure Clean)");
    console.log("Appointments   : 0 (Pure Clean)");
    console.log("Users / Staff  : 1 (ONLY Root Admin)");
    console.log("Invoices/Notes : 0 (Pure Clean)");
    console.log("-----------------------------------------------------------------------");
    console.log("🔑 PLATFORM ROOT ADMIN CREDENTIALS:");
    console.log("Email    : 21amtics177@gmail.com");
    console.log("Password : Password123!");
    console.log("Role     : root (Platform Super Admin)");
    console.log("=======================================================================\n");

  } catch (err) {
    console.error("❌ Pure root seed failed:", err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

runPureRootOnlySeed();
