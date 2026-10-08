import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { pathToFileURL } from "node:url";

export class StagingProvisioningError extends Error {}

export function stagingRootConfig(env, apply = false) {
  if (env.NODE_ENV !== "production" || env.APP_URL !== "https://dev.ekavyu.com") {
    throw new StagingProvisioningError("Requires production mode and the exact dev.ekavyu.com staging origin.");
  }
  const uri = env.MONGODB_URI || "";
  const database = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)(?:\?|$)/)?.[1];
  if (database !== "ekavyu_dev" || !(uri.startsWith("mongodb+srv://") || uri.includes("replicaSet="))) {
    throw new StagingProvisioningError("Requires an explicit ekavyu_dev replica-set/Atlas database.");
  }
  if (apply && env.STAGING_PROVISION_CONFIRM !== "ekavyu_dev") {
    throw new StagingProvisioningError("Set STAGING_PROVISION_CONFIRM=ekavyu_dev for this one-time write.");
  }
  const email = (env.ROOT_ADMIN_EMAIL || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || (env.ROOT_ADMIN_PASSWORD || "").length < 16) {
    throw new StagingProvisioningError("Provide ROOT_ADMIN_EMAIL and a private password of at least 16 characters.");
  }
  return { uri, email, password: env.ROOT_ADMIN_PASSWORD };
}

export async function provisionStagingRoot(config) {
  await mongoose.connect(config.uri, { autoIndex: false, serverSelectionTimeoutMS: 10000, socketTimeoutMS: 30000 });
  try {
    const db = mongoose.connection.db;
    const hello = await db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== "isdbgrid") {
      throw new StagingProvisioningError("The connected server does not support replica-set/sharded transactions.");
    }
    for (const collection of await db.listCollections({}, { nameOnly: true }).toArray()) {
      if (await db.collection(collection.name).findOne({}, { projection: { _id: 1 } })) {
        throw new StagingProvisioningError("Refusing a nonempty database. Existing accounts/data were not changed.");
      }
    }
    const { User } = await import("../models/User.ts");
    await User.createIndexes();
    await User.create({
      name: "Ekavyu Staging Root", email: config.email,
      password: await bcrypt.hash(config.password, 12),
      role: "root", isActive: true, twoFactorEnabled: false,
    });
    console.log("Staging root created. Enroll encrypted MFA with setupRoot2FA.ts before login or public startup.");
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const apply = process.argv.includes("--apply");
    const config = stagingRootConfig(process.env, apply);
    if (apply) await provisionStagingRoot(config);
    else console.log("Preview passed. No database connection/write. --apply additionally requires exact confirmation and an empty replica-set database.");
  } catch (error) {
    console.error(error instanceof StagingProvisioningError ? error.message : "Staging provisioning failed. Check database access locally; no connection details or secrets are printed.");
    process.exitCode = 1;
  }
}
