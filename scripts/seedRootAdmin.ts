import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Clinic } from "../models/Clinic.ts";
import { PendingTwoFactorSetup } from "../models/PendingTwoFactorSetup.ts";
import { OnboardingDraft } from "../models/OnboardingDraft.ts";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/ananta_health";

async function seedDatabase() {
  console.log("==========================================================");
  console.log("[ANANTA DB SEED] Cleaning MongoDB and seeding Root Admin...");
  console.log("==========================================================");

  try {
    await mongoose.connect(MONGODB_URI);
    console.log("✓ Connected to MongoDB Atlas Cluster.");

    // 1. Clean existing collections
    await User.deleteMany({});
    await Organization.deleteMany({});
    await OrgMember.deleteMany({});
    await Clinic.deleteMany({});
    await PendingTwoFactorSetup.deleteMany({});
    await OnboardingDraft.deleteMany({});
    console.log("✓ Cleared all existing users, organizations, clinics, and drafts.");

    // 2. Create Root Admin account
    const hashedPassword = await bcrypt.hash("Password123!", 10);
    const rootAdmin = await User.create({
      name: "Jay (Root Admin)",
      email: "21amtics177@gmail.com",
      password: hashedPassword,
      phone: "+1 234 567 8900",
      role: "root",
      twoFactorEnabled: true,
      isActive: true,
    });
    console.log("✓ Created Platform Root Admin:", rootAdmin.email);

    // 3. Create Seed Organization & Clinic
    const seedOrg = await Organization.create({
      name: "ANANTA Healthcare System",
      city: "San Francisco",
      address: "100 Medical Center Drive",
      phone: "+1 415 555 0199",
      email: "contact@ananta.health",
      onboardingStatus: "COMPLETED",
      isOnboarded: true,
      isActive: true,
    });

    const seedClinic = await Clinic.create({
      organizationId: seedOrg._id,
      name: "ANANTA Central Hospital",
      city: "San Francisco",
      address: "100 Medical Center Drive, Suite 100",
      phone: "+1 415 555 0199",
      email: "central@ananta.health",
    });

    await OrgMember.create({
      userId: rootAdmin._id,
      organizationId: seedOrg._id,
      role: "admin",
    });

    console.log("✓ Seed Organization created:", seedOrg.name);
    console.log("✓ Seed Primary Clinic created:", seedClinic.name);

    console.log("\n==========================================================");
    console.log("🎉 DATABASE SEEDED SUCCESSFULLY!");
    console.log("----------------------------------------------------------");
    console.log("Root Admin Email   : 21amtics177@gmail.com");
    console.log("Root Admin Password: Password123!");
    console.log("Role               : root (Platform Super Admin)");
    console.log("==========================================================\n");
  } catch (err) {
    console.error("❌ Seed database failed:", err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

seedDatabase();
