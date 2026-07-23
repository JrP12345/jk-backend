import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { beforeAll, beforeEach, afterAll } from "vitest";

import "../models/User.ts";
import "../models/Organization.ts";
import "../models/OrgMember.ts";
import "../models/RefreshToken.ts";
import "../models/AuditLog.ts";
import "../models/Clinic.ts";
import "../models/Doctor.ts";
import "../models/Receptionist.ts";
import "../models/DoctorAssignment.ts";
import "../models/Patient.ts";
import "../models/Appointment.ts";
import "../models/Invoice.ts";
import "../models/Bed.ts";
import "../models/Admission.ts";
import "../models/Medicine.ts";
import "../models/LabTest.ts";
import "../models/LabOrder.ts";

process.env.NODE_ENV = "test";

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  
  // Set environment variables for test DB and Cloudflare R2
  process.env.MONGODB_URI = uri;
  process.env.NODE_ENV = "test";
  process.env.CLOUDFLARE_ACCOUNT_ID = "testaccount";
  process.env.R2_ACCESS_KEY_ID = "testaccess";
  process.env.R2_SECRET_ACCESS_KEY = "testsecret";
  process.env.R2_BUCKET_NAME = "testbucket";

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
