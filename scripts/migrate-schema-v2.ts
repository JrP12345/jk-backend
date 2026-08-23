import fs from "node:fs";
import path from "node:path";

if (!process.env.MONGODB_URI) {
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, "utf-8");
      for (const line of envContent.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
          const [key, ...vals] = trimmed.split("=");
          process.env[key.trim()] = vals.join("=").trim();
        }
      }
    }
  } catch (e) {}
}

export async function runSchemaMigrationV2() {
  console.log("=== Starting Schema & Index Migration V2 ===");
  await import("../db.ts");
  const mongoose = (await import("mongoose")).default;
  const { User } = await import("../models/User.ts");
  const { Patient } = await import("../models/Patient.ts");
  const { FamilyRelationship } = await import("../models/FamilyRelationship.ts");

  try {
    const db = mongoose.connection.db;
    if (!db) {
      console.error("Database connection not ready");
      return;
    }

    // 1. Inspect & Migrate User Indexes
    const userColl = db.collection("users");
    const userIndexes = await userColl.indexes();
    console.log("Existing User Indexes:", userIndexes.map((idx) => idx.name));

    for (const idx of userIndexes) {
      if (idx.key && idx.key.email === 1 && idx.unique && !idx.sparse && idx.name) {
        console.log(`Dropping non-sparse unique index '${idx.name}' on users.email...`);
        await userColl.dropIndex(idx.name);
      }
    }
    await User.syncIndexes();
    console.log("User indexes synchronized successfully.");

    // 2. Inspect & Migrate Patient Indexes
    const patientColl = db.collection("patients");
    const patientIndexes = await patientColl.indexes();
    console.log("Existing Patient Indexes:", patientIndexes.map((idx) => idx.name));

    for (const idx of patientIndexes) {
      if (idx.key && idx.key.userId === 1 && idx.unique && !idx.sparse && idx.name) {
        console.log(`Dropping non-sparse unique index '${idx.name}' on patients.userId...`);
        await patientColl.dropIndex(idx.name);
      }
    }
    await Patient.syncIndexes();
    console.log("Patient indexes synchronized successfully.");

    // 3. Backfill Patient Demographic Fields & Self Family Relationships
    const patients = await Patient.find({}).populate("userId");
    let backfilledCount = 0;
    let familyRelCount = 0;

    for (const p of patients) {
      const user = p.userId as any;
      let updated = false;

      if (user) {
        if (!p.name && user.name) {
          p.name = user.name;
          updated = true;
        }
        if (!p.phone && user.phone) {
          p.phone = user.phone;
          updated = true;
        }
        if (!p.email && user.email) {
          p.email = user.email;
          updated = true;
        }

        // Ensure FamilyRelationship exists for self
        const existingRel = await FamilyRelationship.findOne({
          userId: user._id,
          patientId: p._id,
        });

        if (!existingRel) {
          await FamilyRelationship.create({
            userId: user._id,
            patientId: p._id,
            relationship: "self",
            status: "active",
          });
          familyRelCount++;
        }
      }

      if (!p.accountType) {
        p.accountType = p.userId ? "self" : "walkin";
        updated = true;
      }

      if (updated) {
        await p.save();
        backfilledCount++;
      }
    }

    console.log(`Backfilled ${backfilledCount} patient records with demographics.`);
    console.log(`Created ${familyRelCount} self FamilyRelationship records.`);
    console.log("=== Schema & Index Migration V2 Complete ===");
  } catch (err) {
    console.error("Error during Schema Migration V2:", err);
  }
}

if (process.argv[1]?.endsWith("migrate-schema-v2.ts")) {
  runSchemaMigrationV2().then(async () => {
    const mongoose = (await import("mongoose")).default;
    await mongoose.disconnect();
  });
}
