import mongoose from "mongoose";
import { SaaSPlan } from "../models/SaaSPlan.ts";
import { verifyEnv } from "../utilities/config.ts";

verifyEnv();

const defaultPlans = [
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
    limits: {
      maxHospitals: 1,
      maxClinics: 1,
      maxDoctors: 2,
      maxStaff: 5,
      maxPatients: 500,
      maxAppointments: 1000,
      maxStorageMB: 2048,
    },
    features: {
      analytics: true,
      auditLogs: false,
      multiBranch: false,
      dataExport: false,
      apiAccess: false,
      aiFeatures: false,
    },
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
    limits: {
      maxHospitals: 3,
      maxClinics: 5,
      maxDoctors: 15,
      maxStaff: 25,
      maxPatients: 5000,
      maxAppointments: 10000,
      maxStorageMB: 10240,
    },
    features: {
      analytics: true,
      auditLogs: true,
      multiBranch: true,
      dataExport: true,
      apiAccess: false,
      aiFeatures: true,
    },
  },
  {
    name: "Enterprise",
    slug: "enterprise",
    description: "Advanced infrastructure with dedicated AI engines, unlimited branches, and custom SLA for hospitals.",
    monthlyPrice: 14999,
    annualPrice: 149990,
    currency: "INR",
    trialDays: 15,
    status: "active",
    displayOrder: 3,
    isPopular: false,
    limits: {
      maxHospitals: 99,
      maxClinics: 99,
      maxDoctors: 999,
      maxStaff: 999,
      maxPatients: 99999,
      maxAppointments: 999999,
      maxStorageMB: 102400,
    },
    features: {
      analytics: true,
      auditLogs: true,
      multiBranch: true,
      dataExport: true,
      apiAccess: true,
      aiFeatures: true,
    },
  },
];

export async function seedSaaSPlans() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not defined");

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(uri);
  }

  console.log("🌱 Seeding SaaS Commercial Billing Plans...");

  for (const planData of defaultPlans) {
    await SaaSPlan.findOneAndUpdate(
      { slug: planData.slug },
      { $set: planData },
      { upsert: true, returnDocument: "after" }
    );
    console.log(`  ✅ Synced Plan: ${planData.name} (${planData.slug})`);
  }

  console.log("🎉 Commercial SaaS Plans seeded successfully!");
}

if (process.argv[1]?.endsWith("seedSaaSPlans.ts")) {
  seedSaaSPlans()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("❌ Error seeding SaaS Plans:", err);
      process.exit(1);
    });
}
