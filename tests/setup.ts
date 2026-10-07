import { MongoMemoryServer, MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import { beforeAll, beforeEach, afterAll, expect } from "vitest";

import "../models/User.ts";
import "../models/Organization.ts";
import "../models/OrgMember.ts";
import "../models/RefreshToken.ts";
import "../models/AuditLog.ts";
import "../models/Location.ts";
import "../models/Doctor.ts";
import "../models/Receptionist.ts";
import "../models/DoctorAssignment.ts";
import "../models/Patient.ts";
import "../models/Appointment.ts";
import "../models/Invoice.ts";
import "../models/Medicine.ts";
import "../models/LabTest.ts";
import "../models/LabOrder.ts";
import "../models/Notification.ts";
import "../models/NotificationPreference.ts";
import "../models/NotificationDelivery.ts";
import "../models/OutboundMessage.ts";
import "../models/WorkerLease.ts";
import "../services/ai/AIService.ts";

process.env.NODE_ENV = "test";

let mongoServer: MongoMemoryServer | MongoMemoryReplSet;

beforeAll(async () => {
  mongoServer = (process.env.TEST_MONGO_REPLICA_SET === "true" || expect.getState().testPath?.endsWith("architectureIntegrity.test.ts"))
    ? await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } })
    : await MongoMemoryServer.create();
  const uri = mongoServer.getUri();

  // Set environment variables for test DB and Cloudflare R2
  process.env.MONGODB_URI = uri;
  process.env.NODE_ENV = "test";
  // Test-only dummy key — NOT a real secret (zero-entropy 64-hex-char to prevent scanner false positives)
  process.env.DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY || "00".repeat(32);
  process.env.CLOUDFLARE_ACCOUNT_ID = "test-only-fake-account";
  process.env.R2_ACCESS_KEY_ID = "test-only-fake-access-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-only-fake-secret-key";
  process.env.R2_BUCKET_NAME = "test-only-fake-bucket";

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  await mongoose.connect(uri);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongoServer) {
    await mongoServer.stop();
  }
});
