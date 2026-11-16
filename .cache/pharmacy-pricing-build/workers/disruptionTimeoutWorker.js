var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// utilities/safeError.ts
function safeError(error) {
  const knownNames = /* @__PURE__ */ new Set(["Error", "TypeError", "RangeError", "ValidationError", "CastError", "MongoServerError", "MongoNetworkError", "MongoBulkWriteError", "AbortError", "TimeoutError", "CommandError", "WorkspaceError"]);
  if (!error || typeof error !== "object") return { errorType: "Error" };
  const value = error;
  return {
    errorType: typeof value.name === "string" && knownNames.has(value.name) ? value.name : "Error",
    ...typeof value.statusCode === "number" && Number.isInteger(value.statusCode) && value.statusCode >= 400 && value.statusCode <= 599 ? { statusCode: value.statusCode } : {},
    ...typeof value.code === "number" && [11e3, 112, 50, 91, 251].includes(value.code) ? { databaseCode: value.code } : {}
  };
}
var init_safeError = __esm({
  "utilities/safeError.ts"() {
    "use strict";
  }
});

// utilities/redisConfiguration.ts
function getRedisConfiguration() {
  const isProduction = process.env.NODE_ENV === "production";
  const required = isProduction && process.env.ALLOW_SINGLE_NODE_IN_PRODUCTION !== "true";
  const url = process.env.REDIS_URL?.trim() || void 0;
  const host = process.env.REDIS_HOST?.trim() || void 0;
  const settings = { url, host, required };
  let hostname = host;
  if (url) {
    try {
      const parsed = new URL(url);
      if (!["redis:", "rediss:"].includes(parsed.protocol) || !parsed.hostname) {
        return { ...settings, error: "REDIS_URL must be a redis:// or rediss:// connection URL" };
      }
      hostname = parsed.hostname;
    } catch {
      return { ...settings, error: "REDIS_URL must be a valid redis:// or rediss:// connection URL" };
    }
  }
  if (!hostname) {
    return { ...settings, error: "REDIS_URL or REDIS_HOST is not configured" };
  }
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const isLoopback = normalized === "localhost" || normalized.endsWith(".localhost") || /^127(?:\.\d{1,3}){3}$/.test(normalized) || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1" || normalized === "0.0.0.0" || normalized === "::";
  if (isProduction && isLoopback) {
    return { ...settings, error: "Production Redis must use a remote hostname; localhost/loopback settings are development-only" };
  }
  return settings;
}
var init_redisConfiguration = __esm({
  "utilities/redisConfiguration.ts"() {
    "use strict";
  }
});

// utilities/redis.ts
import { Redis } from "ioredis";
function createRedisClient() {
  const { url: redisUrl, host: redisHost, error } = getRedisConfiguration();
  if (error) {
    console.log(`[Redis] ${error}. Using in-memory fallback store.`);
    return null;
  }
  try {
    const client = redisUrl ? new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: true,
      retryStrategy: (times) => Math.min(times * 100, 2e3)
    }) : new Redis({
      host: redisHost,
      port: parseInt(process.env.REDIS_PORT || "6379", 10),
      password: process.env.REDIS_PASSWORD || void 0,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: true,
      retryStrategy: (times) => Math.min(times * 100, 2e3)
    });
    client.on("error", (err) => {
      console.warn("[Redis Warning] Connection error:", safeError(err));
    });
    client.on("connect", () => {
      console.log("[Redis] Connected successfully to centralized Redis backing store.");
    });
    return client;
  } catch (err) {
    console.warn("[Redis Error] Failed to initialize Redis client:", safeError(err));
    return null;
  }
}
function createRedisSubscriber() {
  return createRedisClient();
}
async function publishRedisEvent(channel, payload) {
  if (!redisClient) return 0;
  try {
    return await redisClient.publish(channel, typeof payload === "string" ? payload : JSON.stringify(payload));
  } catch (err) {
    console.warn(`[Redis PubSub] Failed to publish on channel '${channel}':`, safeError(err));
    return 0;
  }
}
var redisClient;
var init_redis = __esm({
  "utilities/redis.ts"() {
    "use strict";
    init_safeError();
    init_redisConfiguration();
    redisClient = createRedisClient();
  }
});

// utilities/transportConfiguration.ts
import { isIP } from "node:net";
function productionTransportErrors(env) {
  const errors = [];
  const origins = (env.CORS_ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
  const isHttpsOrigin = (value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash && !url.hostname.includes("*") && !["localhost", "127.0.0.1"].includes(url.hostname);
    } catch {
      return false;
    }
  };
  if (!origins.length || origins.some((value) => !isHttpsOrigin(value))) errors.push("CORS_ALLOWED_ORIGINS must contain explicit HTTPS origins without credentials, paths or wildcards");
  for (const key of ["APP_URL", "FRONTEND_URL", "WEBAUTHN_ORIGIN"]) {
    if (env[key] && !isHttpsOrigin(env[key])) errors.push(`${key} must be an explicit HTTPS origin`);
  }
  if (env.COOKIE_SAME_SITE && !["lax", "strict", "none"].includes(env.COOKIE_SAME_SITE)) errors.push("COOKIE_SAME_SITE must be lax, strict or none");
  if (env.COOKIE_DOMAIN && !/^\.?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(env.COOKIE_DOMAIN)) errors.push("COOKIE_DOMAIN must be a hostname without a scheme, port or path");
  if (env.TRUSTED_PROXY_HOPS && (!/^\d+$/.test(env.TRUSTED_PROXY_HOPS) || Number(env.TRUSTED_PROXY_HOPS) < 1 || Number(env.TRUSTED_PROXY_HOPS) > 5)) errors.push("TRUSTED_PROXY_HOPS must be an integer from 1 to 5");
  if (env.TRUSTED_PROXY_HOPS && env.TRUSTED_PROXY_CIDRS) errors.push("Configure one trusted proxy strategy, not both hops and CIDRs");
  if (env.TRUSTED_PROXY_CIDRS && !env.TRUSTED_PROXY_CIDRS.split(",").every((value) => {
    const [address, prefix, extra] = value.trim().split("/");
    const family = isIP(address);
    return !!family && !extra && (prefix === void 0 || /^\d+$/.test(prefix) && Number(prefix) > 0 && Number(prefix) <= (family === 4 ? 32 : 128));
  })) errors.push("TRUSTED_PROXY_CIDRS must contain explicit IPs or non-universal CIDRs");
  if (env.REQUIRE_TRUSTED_PROXY === "true" && !env.ORIGIN_VERIFY_TOKEN) errors.push("ORIGIN_VERIFY_TOKEN is required when REQUIRE_TRUSTED_PROXY is enabled");
  if (env.ORIGIN_VERIFY_TOKEN && env.ORIGIN_VERIFY_TOKEN.length < 32) errors.push("ORIGIN_VERIFY_TOKEN must contain at least 32 characters");
  if (env.STAFF_MFA_ENFORCE_AFTER && !Number.isFinite(Date.parse(env.STAFF_MFA_ENFORCE_AFTER))) errors.push("STAFF_MFA_ENFORCE_AFTER must be a valid ISO date");
  return errors;
}
var init_transportConfiguration = __esm({
  "utilities/transportConfiguration.ts"() {
    "use strict";
  }
});

// utilities/config.ts
import fs from "node:fs";
import path from "node:path";
function getFrontendBaseUrl() {
  if (process.env.APP_URL) {
    return process.env.APP_URL.trim().replace(/\/+$/, "");
  }
  if (process.env.FRONTEND_URL) {
    return process.env.FRONTEND_URL.trim().replace(/\/+$/, "");
  }
  if (process.env.CORS_ALLOWED_ORIGINS) {
    const firstOrigin = process.env.CORS_ALLOWED_ORIGINS.split(",")[0].trim().replace(/\/+$/, "");
    if (firstOrigin) return firstOrigin;
  }
  return "http://localhost:3000";
}
function validateConfig() {
  if (process.env.NODE_ENV === "test") {
    return { valid: true, errors: [] };
  }
  const isProd = process.env.NODE_ENV === "production";
  const checkList = isProd ? productionRequiredEnv : baseRequiredEnv;
  const missing = [];
  for (const envName of checkList) {
    if (!process.env[envName]) {
      missing.push(envName);
    }
  }
  if (isProd) {
    missing.push(...productionTransportErrors(process.env));
    const hasBase64Keys = !!(process.env.JWT_PRIVATE_KEY_BASE64 && process.env.JWT_PUBLIC_KEY_BASE64);
    const hasPemKeys = !!(process.env.JWT_PRIVATE_KEY && process.env.JWT_PUBLIC_KEY);
    const keysDir = path.join(process.cwd(), "keys");
    const privatePath = process.env.JWT_PRIVATE_KEY_PATH || path.join(keysDir, "private.pem");
    const publicPath = process.env.JWT_PUBLIC_KEY_PATH || path.join(keysDir, "public.pem");
    const hasKeyFiles = fs.existsSync(privatePath) && fs.existsSync(publicPath);
    const workerPublicKey = process.env.WORKLOAD_ROLE === "worker" && !!(process.env.JWT_PUBLIC_KEY_BASE64 || process.env.JWT_PUBLIC_KEY || fs.existsSync(publicPath));
    if (!hasBase64Keys && !hasPemKeys && !hasKeyFiles && !workerPublicKey) {
      missing.push("JWT_PRIVATE_KEY_BASE64 & JWT_PUBLIC_KEY_BASE64 (or JWT_PRIVATE_KEY & JWT_PUBLIC_KEY) - run 'npm run generate:keys'");
    }
    const redis = getRedisConfiguration();
    if (redis.required && redis.error) {
      missing.push(`${redis.error}. Set REDIS_URL or REDIS_HOST to your Redis service, or set ALLOW_SINGLE_NODE_IN_PRODUCTION=true only for a single-instance deployment without Redis`);
    }
    const mongoUri = process.env.MONGODB_URI || "";
    const isReplicaSetUri = mongoUri.startsWith("mongodb+srv://") || mongoUri.includes("replicaSet=") || mongoUri.startsWith("mongodb://") && mongoUri.split("?")[0].includes(",");
    if (!isReplicaSetUri && process.env.ALLOW_STANDALONE_IN_PRODUCTION !== "true") {
      missing.push(
        "MONGODB_URI must specify a Replica Set (mongodb+srv:// or ?replicaSet=... or multiple comma-separated seed hosts) in production mode to ensure multi-document ACID transactions. Set ALLOW_STANDALONE_IN_PRODUCTION=true to explicitly override for testing."
      );
    }
    if (!process.env.UPI_WEBHOOK_SECRET && !process.env.RAZORPAY_WEBHOOK_SECRET) {
      missing.push(
        "UPI_WEBHOOK_SECRET or RAZORPAY_WEBHOOK_SECRET (Required in production to verify payment callbacks)"
      );
    }
    const prescriptionKey = process.env.PRESCRIPTION_SIGNING_KEY;
    if (process.env.WORKLOAD_ROLE !== "worker" && (!prescriptionKey || prescriptionKey.length < 32 || ["healthos-prescription-sealing-key", "ekavyu-development-prescription-key"].includes(prescriptionKey))) {
      missing.push("PRESCRIPTION_SIGNING_KEY must be a persistent secret of at least 32 characters for prescription integrity");
    }
  }
  const encryptionKey = process.env.DATA_ENCRYPTION_KEY;
  if (!encryptionKey) {
    if (isProd) {
      missing.push("DATA_ENCRYPTION_KEY (Required in production for field-level encryption of PHI and secrets)");
    }
  } else if (encryptionKey.length !== 64 && encryptionKey.length < 32) {
    if (isProd) {
      missing.push("DATA_ENCRYPTION_KEY must be at least 32 characters (or a 64-char hex string)");
    }
  }
  return { valid: missing.length === 0, errors: missing };
}
function verifyEnv() {
  const result = validateConfig();
  if (!result.valid) {
    console.error("\u274C Fatal Configuration Error: Missing required environment variables:");
    for (const name of result.errors) {
      console.error(`   - ${name}`);
    }
    process.exit(1);
  }
  if (process.env.NODE_ENV === "production") {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
      console.warn("\u26A0\uFE0F [Config Warning] Outbound SMTP credentials are not fully configured in backend .env. Emails will rely on per-organization SMTP settings.");
    }
  }
}
var baseRequiredEnv, productionRequiredEnv;
var init_config = __esm({
  "utilities/config.ts"() {
    "use strict";
    init_redisConfiguration();
    init_transportConfiguration();
    baseRequiredEnv = [
      "MONGODB_URI"
    ];
    productionRequiredEnv = [
      "MONGODB_URI",
      "CORS_ALLOWED_ORIGINS"
    ];
  }
});

// utilities/consultationLock.ts
function getActiveConsultationDoctorDayKey(doctorId, appointmentTime) {
  const date = new Date(appointmentTime);
  if (Number.isNaN(date.getTime())) {
    throw new Error("A valid appointment time is required for an active consultation lock");
  }
  const day = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
  return `doctor:${String(doctorId)}:day:${day}`;
}
function isActiveConsultationLockConflict(error) {
  const mongoError = error;
  return mongoError?.code === 11e3 && (Boolean(mongoError.keyPattern?.activeConsultationDoctorDayKey) || String(mongoError.message || "").includes("activeConsultationDoctorDayKey"));
}
var init_consultationLock = __esm({
  "utilities/consultationLock.ts"() {
    "use strict";
  }
});

// utilities/cryptoEnvelope.ts
import crypto from "node:crypto";
function resolveEncryptionSecret() {
  const secret = process.env.DATA_ENCRYPTION_KEY;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("DATA_ENCRYPTION_KEY is strictly required in production mode");
    }
    console.warn("\u26A0\uFE0F [FLE Warning] No DATA_ENCRYPTION_KEY configured. Using local dev fallback key.");
    return "dev-local-data-encryption-key-32b-secure";
  }
  return secret;
}
function isEncrypted(val) {
  return typeof val === "string" && val.startsWith("enc:v1:");
}
function encryptField(plaintext) {
  if (plaintext === null || plaintext === void 0) {
    return plaintext;
  }
  const str = String(plaintext);
  if (!str.trim() || isEncrypted(str)) {
    return str;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", MASTER_KEY, iv);
  let encrypted = cipher.update(str, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `enc:v1:${iv.toString("hex")}:${authTag}:${encrypted}`;
}
function decryptField(ciphertext) {
  if (ciphertext === null || ciphertext === void 0) return ciphertext;
  const str = String(ciphertext);
  if (!isEncrypted(str)) return str;
  const parts2 = str.split(":");
  if (parts2.length === 5) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", MASTER_KEY, Buffer.from(parts2[2], "hex"));
      decipher.setAuthTag(Buffer.from(parts2[3], "hex"));
      return decipher.update(parts2[4], "hex", "utf8") + decipher.final("utf8");
    } catch {
    }
  }
  console.error("[FLE] Decryption or authentication tag verification failed");
  return "[DECRYPTION_FAILED]";
}
function computeBlindIndex(value) {
  if (!value) return "";
  const normalized = String(value).trim().toLowerCase();
  return crypto.createHmac("sha256", BLIND_INDEX_KEY).update(normalized).digest("hex");
}
var ENCRYPTION_SECRET, MASTER_KEY, BLIND_INDEX_KEY;
var init_cryptoEnvelope = __esm({
  "utilities/cryptoEnvelope.ts"() {
    "use strict";
    ENCRYPTION_SECRET = resolveEncryptionSecret();
    MASTER_KEY = crypto.scryptSync(ENCRYPTION_SECRET, "healthos-fle-salt-2026", 32);
    BLIND_INDEX_KEY = crypto.scryptSync(ENCRYPTION_SECRET, "healthos-blind-index-salt-2026", 32);
  }
});

// models/Appointment.ts
var Appointment_exports = {};
__export(Appointment_exports, {
  Appointment: () => Appointment
});
import mongoose2, { Schema } from "mongoose";
var AppointmentSchema, Appointment;
var init_Appointment = __esm({
  "models/Appointment.ts"() {
    "use strict";
    init_consultationLock();
    init_cryptoEnvelope();
    AppointmentSchema = new Schema({
      organizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
      feedbackRevision: { type: Number, default: 0 },
      locationId: { type: Schema.Types.ObjectId, ref: "Location", required: true, index: true },
      doctorId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
      patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
      bookedByUserId: { type: Schema.Types.ObjectId, ref: "User", index: true },
      trackerTokenHash: { type: String, select: false, index: true },
      trackerTokenCiphertext: { type: String, select: false, set: encryptField },
      trackerTokenExpiresAt: { type: Date, index: true },
      // A tracker link is a read capability. Self check-in requires this separate,
      // short-lived, single-use capability so an appointment identifier or an old
      // tracker link cannot be replayed at a kiosk.
      checkInTokenHash: { type: String, select: false, index: true },
      checkInTokenExpiresAt: { type: Date, index: true },
      checkInTokenUsedAt: { type: Date },
      appointmentTime: {
        type: Date,
        required: true,
        index: true,
        validate: {
          validator: (v) => v instanceof Date && !isNaN(v.getTime()),
          message: "appointmentTime must be a valid date"
        }
      },
      appointmentType: { type: String, enum: ["walk-in", "online", "reception", "qr"], required: true },
      status: {
        type: String,
        enum: ["pending_payment", "pending", "confirmed", "checked-in", "in-consultation", "completed", "cancelled", "no-show", "disruption_triage", "standby"],
        default: "pending",
        index: true
      },
      paymentStatus: {
        type: String,
        enum: ["not_required", "pending", "paid", "pay_at_location", "failed", "refund_pending", "refunded", "unpaid", "partially_paid"],
        default: "pending",
        index: true
      },
      paymentAmount: { type: Number, default: 500 },
      feeType: {
        type: String,
        enum: ["fixed", "post_consultation", "free"],
        default: "fixed",
        index: true
      },
      customConsultationFee: { type: Number },
      invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", index: true },
      bookingSource: {
        type: String,
        enum: ["patient_portal", "guest", "staff", "reception"],
        default: "patient_portal"
      },
      tokenNumber: { type: Number, required: true },
      queuePosition: { type: Number, index: true },
      // Present only while this appointment holds the doctor's consultation slot.
      // The sparse unique index below makes this an atomic, database-enforced lock.
      activeConsultationDoctorDayKey: { type: String, sparse: true },
      bookingMode: { type: String, enum: ["time_slot", "sequential_queue"], default: "sequential_queue" },
      duration: { type: Number, default: 15 },
      reasonForVisit: {
        type: String,
        enum: ["new_consultation", "follow_up", "routine_checkup", "second_opinion", "report_review"],
        default: "new_consultation"
      },
      notes: { type: String },
      followUpRecommended: { type: Boolean, default: false },
      followUpTimeline: { type: String },
      followUpNotes: { type: String },
      followUpForAppointmentId: { type: Schema.Types.ObjectId, ref: "Appointment", index: true },
      followUpAppointmentId: { type: Schema.Types.ObjectId, ref: "Appointment", index: true },
      followUpTaskId: { type: Schema.Types.ObjectId, ref: "Task" },
      followUpDueAt: Date,
      followUpWorkflow: { type: String, enum: ["recommended", "review_required", "booked", "declined"] },
      followUpConfirmationEvidence: { type: String, enum: ["explicit_booking", "legacy_reviewed"] },
      symptoms: { type: String },
      diagnosis: { type: String },
      prescriptions: [{
        name: { type: String, required: true },
        dosage: { type: String, required: true },
        duration: { type: String, required: true }
      }],
      // Doctor Availability Disruption & Patient Triage fields
      disruptionId: { type: Schema.Types.ObjectId, ref: "DoctorDayOverride", index: true },
      // Missing on legacy records: attendance must be reviewed, never inferred from notes.
      disruptionOriginalStatus: { type: String, enum: ["checked-in", "confirmed", "pending", "pending_payment"] },
      originalDoctorId: { type: Schema.Types.ObjectId, ref: "User", index: true },
      originalTokenNumber: { type: Number },
      transferredAt: { type: Date },
      transferredBy: { type: Schema.Types.ObjectId, ref: "User" },
      disruptedAt: { type: Date },
      disruptionNotifiedAt: { type: Date },
      disruptionReviewDueAt: Date,
      disruptionReviewRequiredAt: Date,
      disruptionResponseDeadline: { type: Date, index: true },
      // A bounded claim prevents two timeout workers from refunding/cancelling the
      // same disruption appointment if leadership changes during a sweep.
      disruptionTimeoutClaimedAt: { type: Date, index: true },
      disruptionTimeoutClaimToken: { type: String, index: true },
      cancellationReason: { type: String },
      priorityRescheduledFromId: { type: Schema.Types.ObjectId, ref: "Appointment", index: true },
      triageAction: {
        type: String,
        enum: ["pending", "timeout_processing", "transferred", "cancelled", "rescheduled", "refunded"],
        default: "pending"
      },
      // Parked / Standby Queue Fields
      parkedAt: { type: Date },
      parkedReason: { type: String },
      patientReturned: { type: Boolean, default: false },
      patientReturnedAt: { type: Date },
      // Diagnostic Investigation & 2-Phase Consultation Fields
      consultationPhase: {
        type: String,
        enum: ["single", "initial_pending_investigation", "report_review"],
        default: "single"
      },
      investigationSentAt: { type: Date },
      investigationNotes: { type: String },
      // Queue Overrun & Delay Notification Fields
      delayNotifiedAt: { type: Date },
      lastNotifiedDelayMinutes: { type: Number },
      // Financial Disruption Reconciliation Fields
      feeVariance: { type: Number, default: 0 },
      feeResolution: {
        type: String,
        enum: ["waived_courtesy", "paid_difference", "partial_refund", "exact_match"]
      },
      // Pre-Consultation Nurse Triage & Vitals Fields
      vitals: {
        bpSystolic: { type: Number },
        bpDiastolic: { type: Number },
        pulse: { type: Number },
        temperature: { type: Number },
        temperatureUnit: { type: String, enum: ["F", "C"], default: "F" },
        spO2: { type: Number },
        weight: { type: Number },
        height: { type: Number },
        bmi: { type: Number },
        bloodSugar: { type: Number },
        bloodSugarType: { type: String, enum: ["random", "fasting", "post_prandial"], default: "random" },
        allergies: [{ type: String }],
        triageNotes: { type: String },
        recordedAt: { type: Date },
        recordedBy: { type: Schema.Types.ObjectId, ref: "User" },
        recordedByName: { type: String }
      },
      // Emergency / STAT Protocol Fields
      isEmergency: { type: Boolean, default: false, index: true },
      emergencyTriagedAt: { type: Date },
      // Diagnostic Investigation Results from Lab
      investigationResults: [
        {
          testId: { type: Schema.Types.ObjectId, ref: "LabTest" },
          testName: { type: String },
          value: { type: String },
          unit: { type: String },
          referenceRange: { type: String },
          isAbnormal: { type: Boolean, default: false },
          resultNotes: { type: String },
          attachmentUrl: { type: String, default: "" },
          resultedAt: { type: Date, default: Date.now },
          labOrderId: { type: Schema.Types.ObjectId, ref: "LabOrder" }
        }
      ],
      // Autonomous Queue Pacing Alert (P2)
      turnApproachingNotifiedAt: { type: Date, default: null },
      // Digital e-Prescription Dispatch Tracking
      rxDispatchedAt: { type: Date, default: null },
      rxQueuedAt: { type: Date, default: null },
      communicationRevision: { type: Number, default: 0 },
      rxDispatchPhone: { type: String, default: null },
      // Follow-Up Care-Gap & Patient Recall Tracking
      lastRecallSentAt: { type: Date, default: null },
      recallCount: { type: Number, default: 0 },
      // Laboratory Panic Alert Fields
      hasPanicAlert: { type: Boolean, default: false, index: true },
      panicAlertDetails: { type: String, default: null },
      // ABDM Milestone 3 Care-Context Tracking
      abdmCareContextLinked: { type: Boolean, default: false, index: true },
      abdmCareContextRef: { type: String, default: null },
      createdAt: { type: Date, default: Date.now }
    }, { timestamps: true });
    AppointmentSchema.index(
      { locationId: 1, doctorId: 1, appointmentTime: 1 },
      {
        name: "uniq_timeslot_appointment",
        unique: true,
        partialFilterExpression: {
          bookingMode: "time_slot",
          status: { $in: ["confirmed", "pending", "pending_payment", "checked-in", "in-consultation"] }
        }
      }
    );
    AppointmentSchema.index({ organizationId: 1, appointmentTime: -1 });
    AppointmentSchema.index({ locationId: 1, status: 1, appointmentTime: -1 });
    AppointmentSchema.index({ locationId: 1, status: 1, appointmentTime: 1 });
    AppointmentSchema.index({ organizationId: 1, locationId: 1, status: 1, appointmentTime: 1 });
    AppointmentSchema.index({ locationId: 1, doctorId: 1, appointmentTime: 1, queuePosition: 1 });
    AppointmentSchema.index({ patientId: 1, organizationId: 1, createdAt: -1 });
    AppointmentSchema.index({ status: 1, disruptionResponseDeadline: 1 });
    AppointmentSchema.index(
      { activeConsultationDoctorDayKey: 1 },
      { name: "uniq_active_consultation_per_doctor_day", unique: true, sparse: true }
    );
    AppointmentSchema.pre("save", function() {
      const appointment = this;
      if (appointment.status === "in-consultation") {
        appointment.activeConsultationDoctorDayKey = getActiveConsultationDoctorDayKey(
          appointment.doctorId,
          appointment.appointmentTime
        );
      } else if (appointment.activeConsultationDoctorDayKey) {
        appointment.activeConsultationDoctorDayKey = void 0;
      }
    });
    AppointmentSchema.pre(["findOneAndUpdate", "updateOne"], async function() {
      const operation = this;
      const update = operation.getUpdate() || {};
      const nextStatus = update?.$set?.status ?? update?.status;
      if (nextStatus === "in-consultation") {
        if (!(update.$set?.activeConsultationDoctorDayKey || update.activeConsultationDoctorDayKey)) {
          const appointment = await operation.model.findOne(operation.getQuery()).select("doctorId appointmentTime").lean();
          if (appointment) {
            update.$set = {
              ...update.$set || {},
              activeConsultationDoctorDayKey: getActiveConsultationDoctorDayKey(
                appointment.doctorId,
                appointment.appointmentTime
              )
            };
          }
        }
      } else if (nextStatus && nextStatus !== "in-consultation") {
        update.$unset = { ...update.$unset || {}, activeConsultationDoctorDayKey: 1 };
      }
      operation.setUpdate(update);
    });
    AppointmentSchema.virtual("id").get(function() {
      return this._id.toHexString();
    });
    AppointmentSchema.set("toJSON", {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        delete ret.trackerTokenHash;
        delete ret.trackerTokenCiphertext;
        delete ret.checkInTokenHash;
        if (ret.appointmentTime) {
          const d = new Date(ret.appointmentTime);
          ret.appointmentTime = !isNaN(d.getTime()) ? d.toISOString() : null;
        }
        return ret;
      }
    });
    Appointment = mongoose2.model("Appointment", AppointmentSchema);
  }
});

// utilities/scalability.ts
function positiveInt(envName, fallback) {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[ScalabilityConfig] Invalid value for ${envName}="${raw}", using fallback ${fallback}`);
    return fallback;
  }
  return parsed;
}
var MAX_REQUEST_BODY_BYTES, MAX_UPLOAD_BYTES, MAX_MULTIPART_BYTES, MAX_PAGINATION_LIMIT, DEFAULT_PAGINATION_LIMIT, MAX_REPORT_RANGE_DAYS, MAX_REPORT_ROWS, MAX_AI_CONTEXT_TURNS, MAX_AI_SESSION_MESSAGES, MAX_AI_CONCURRENT_PER_TENANT, MAX_EVENT_RETRY_COUNT, MAX_OUTBOUND_RETRY_COUNT, DB_POOL_SIZE, DB_SOCKET_TIMEOUT_MS, DB_SERVER_SELECTION_TIMEOUT_MS, MAX_PROVIDER_CONCURRENCY, MAX_WHATSAPP_CONCURRENCY, GLOBAL_RATE_LIMIT_PER_MINUTE, TENANT_RATE_LIMIT_PER_MINUTE, AUTH_RATE_LIMIT_PER_MINUTE, DOMAIN_EVENT_WORKER_BATCH_SIZE, DOMAIN_EVENT_WORKER_POLL_MS, OUTBOUND_MESSAGE_WORKER_BATCH_SIZE, OUTBOUND_MESSAGE_WORKER_POLL_MS, WS_PUBSUB_PREFIX, SHUTDOWN_DRAIN_MS, WORKER_BACKPRESSURE_QUEUE_AGE_SEC, WORKER_BACKPRESSURE_PENDING_LIMIT, WORKER_BACKPRESSURE_POLL_MULTIPLIER;
var init_scalability = __esm({
  "utilities/scalability.ts"() {
    "use strict";
    MAX_REQUEST_BODY_BYTES = positiveInt("MAX_REQUEST_BODY_BYTES", 10 * 1024 * 1024);
    MAX_UPLOAD_BYTES = positiveInt("MAX_UPLOAD_BYTES", 25 * 1024 * 1024);
    MAX_MULTIPART_BYTES = positiveInt("MAX_MULTIPART_BYTES", 50 * 1024 * 1024);
    MAX_PAGINATION_LIMIT = positiveInt("MAX_PAGINATION_LIMIT", 100);
    DEFAULT_PAGINATION_LIMIT = positiveInt("DEFAULT_PAGINATION_LIMIT", 20);
    MAX_REPORT_RANGE_DAYS = positiveInt("MAX_REPORT_RANGE_DAYS", 365);
    MAX_REPORT_ROWS = positiveInt("MAX_REPORT_ROWS", 1e4);
    MAX_AI_CONTEXT_TURNS = positiveInt("MAX_AI_CONTEXT_TURNS", 8);
    MAX_AI_SESSION_MESSAGES = positiveInt("MAX_AI_SESSION_MESSAGES", 500);
    MAX_AI_CONCURRENT_PER_TENANT = positiveInt("MAX_AI_CONCURRENT_PER_TENANT", 5);
    MAX_EVENT_RETRY_COUNT = positiveInt("MAX_EVENT_RETRY_COUNT", 5);
    MAX_OUTBOUND_RETRY_COUNT = positiveInt("MAX_OUTBOUND_RETRY_COUNT", 5);
    DB_POOL_SIZE = positiveInt(
      "DB_POOL_SIZE",
      process.env.NODE_ENV === "production" ? 30 : 10
    );
    DB_SOCKET_TIMEOUT_MS = positiveInt("DB_SOCKET_TIMEOUT_MS", 3e4);
    DB_SERVER_SELECTION_TIMEOUT_MS = positiveInt("DB_SERVER_SELECTION_TIMEOUT_MS", 15e3);
    MAX_PROVIDER_CONCURRENCY = positiveInt("MAX_PROVIDER_CONCURRENCY", 5);
    MAX_WHATSAPP_CONCURRENCY = positiveInt("MAX_WHATSAPP_CONCURRENCY", 3);
    GLOBAL_RATE_LIMIT_PER_MINUTE = positiveInt(
      "GLOBAL_RATE_LIMIT_PER_MINUTE",
      process.env.NODE_ENV === "production" ? 500 : 1e4
    );
    TENANT_RATE_LIMIT_PER_MINUTE = positiveInt("TENANT_RATE_LIMIT_PER_MINUTE", 2e3);
    AUTH_RATE_LIMIT_PER_MINUTE = positiveInt("AUTH_RATE_LIMIT_PER_MINUTE", 20);
    DOMAIN_EVENT_WORKER_BATCH_SIZE = positiveInt("DOMAIN_EVENT_WORKER_BATCH_SIZE", 10);
    DOMAIN_EVENT_WORKER_POLL_MS = positiveInt("DOMAIN_EVENT_WORKER_POLL_MS", 500);
    OUTBOUND_MESSAGE_WORKER_BATCH_SIZE = positiveInt("OUTBOUND_MESSAGE_WORKER_BATCH_SIZE", 5);
    OUTBOUND_MESSAGE_WORKER_POLL_MS = positiveInt("OUTBOUND_MESSAGE_WORKER_POLL_MS", 1e3);
    WS_PUBSUB_PREFIX = process.env.WS_PUBSUB_PREFIX || "ws";
    SHUTDOWN_DRAIN_MS = process.env.NODE_ENV === "test" ? 0 : positiveInt("SHUTDOWN_DRAIN_MS", 2e3);
    WORKER_BACKPRESSURE_QUEUE_AGE_SEC = positiveInt("WORKER_BACKPRESSURE_QUEUE_AGE_SEC", 300);
    WORKER_BACKPRESSURE_PENDING_LIMIT = positiveInt("WORKER_BACKPRESSURE_PENDING_LIMIT", 500);
    WORKER_BACKPRESSURE_POLL_MULTIPLIER = positiveInt("WORKER_BACKPRESSURE_POLL_MULTIPLIER", 2);
  }
});

// models/DomainEventOutbox.ts
import mongoose3, { Schema as Schema2 } from "mongoose";
var DomainEventOutboxSchema, DomainEventOutbox;
var init_DomainEventOutbox = __esm({
  "models/DomainEventOutbox.ts"() {
    "use strict";
    init_scalability();
    DomainEventOutboxSchema = new Schema2(
      {
        idempotencyKey: { type: String, required: true, unique: true },
        eventType: { type: String, required: true, index: true },
        eventVersion: { type: Number, default: 1 },
        organizationId: { type: Schema2.Types.ObjectId, ref: "Organization", index: true },
        payloadCiphertext: { type: String, required: true, select: false },
        status: {
          type: String,
          enum: ["pending", "processing", "retrying", "sent", "failed", "dead_letter"],
          default: "pending",
          index: true
        },
        attempts: { type: Number, default: 0 },
        maxAttempts: { type: Number, default: MAX_EVENT_RETRY_COUNT },
        nextAttemptAt: { type: Date, default: Date.now, index: true },
        lockedAt: { type: Date },
        lockedUntil: { type: Date, index: true },
        lockedBy: { type: String, index: true },
        error: { type: String },
        sentAt: { type: Date },
        replayCount: { type: Number, default: 0 },
        lastReplayedAt: { type: Date },
        lastReplayedBy: { type: Schema2.Types.ObjectId, ref: "User" }
      },
      { timestamps: true }
    );
    DomainEventOutboxSchema.index({ status: 1, nextAttemptAt: 1, lockedUntil: 1 });
    DomainEventOutbox = mongoose3.models.DomainEventOutbox || mongoose3.model("DomainEventOutbox", DomainEventOutboxSchema);
  }
});

// services/DomainEventOutboxService.ts
import crypto2 from "node:crypto";
import mongoose4 from "mongoose";
function getDomainEventIdempotencyKey(options) {
  if (options.idempotencyKey) return options.idempotencyKey;
  if (options.payload?.eventId) return options.payload.eventId;
  return `domain:${options.eventType}:${crypto2.randomUUID()}`;
}
async function enqueueDomainEvent(options, session) {
  const idempotencyKey = getDomainEventIdempotencyKey(options);
  const orgId = options.organizationId ? typeof options.organizationId === "string" ? mongoose4.Types.ObjectId.isValid(options.organizationId) ? new mongoose4.Types.ObjectId(options.organizationId) : void 0 : options.organizationId : void 0;
  try {
    const doc = await DomainEventOutbox.findOneAndUpdate(
      { idempotencyKey },
      {
        $setOnInsert: {
          idempotencyKey,
          eventType: options.eventType,
          eventVersion: options.eventVersion || 1,
          organizationId: orgId,
          payloadCiphertext: encryptField(JSON.stringify(options.payload)),
          status: "pending",
          attempts: 0,
          maxAttempts: 5,
          nextAttemptAt: /* @__PURE__ */ new Date()
        }
      },
      {
        upsert: true,
        returnDocument: "after",
        setDefaultsOnInsert: true,
        // An explicit undefined session suppresses Mongoose's transaction
        // context. Omit the option so nested business writes share that session.
        ...session !== void 0 ? { session } : {}
      }
    );
    return doc;
  } catch (error) {
    if (error?.code === 11e3) {
      const query = DomainEventOutbox.findOne({ idempotencyKey });
      const existing = await (session !== void 0 ? query.session(session) : query);
      if (existing) return existing;
    }
    throw error;
  }
}
var init_DomainEventOutboxService = __esm({
  "services/DomainEventOutboxService.ts"() {
    "use strict";
    init_cryptoEnvelope();
    init_DomainEventOutbox();
  }
});

// platform/events/DomainEvent.ts
import crypto3 from "node:crypto";
function createDomainEvent(eventType, payload, version = 1) {
  return {
    eventId: typeof payload?.eventId === "string" ? payload.eventId : crypto3.randomUUID(),
    eventType,
    eventVersion: version,
    occurredAt: /* @__PURE__ */ new Date(),
    payload
  };
}
var init_DomainEvent = __esm({
  "platform/events/DomainEvent.ts"() {
    "use strict";
  }
});

// platform/events/DomainEventBus.ts
var DomainEventBus, domainEventBus;
var init_DomainEventBus = __esm({
  "platform/events/DomainEventBus.ts"() {
    "use strict";
    init_safeError();
    init_DomainEvent();
    DomainEventBus = class {
      subscribers = /* @__PURE__ */ new Map();
      /**
       * Subscribe a handler to a specific event type.
       * Returns an unsubscribe function.
       */
      subscribe(eventType, subscriber) {
        if (!this.subscribers.has(eventType)) {
          this.subscribers.set(eventType, /* @__PURE__ */ new Set());
        }
        const set = this.subscribers.get(eventType);
        set.add(subscriber);
        return () => {
          set.delete(subscriber);
          if (set.size === 0) {
            this.subscribers.delete(eventType);
          }
        };
      }
      /**
       * Publish a domain event to all registered subscribers.
       * Subscribers run in isolated try-catch blocks so errors in one handler
       * do not interrupt execution of other handlers or throw back to the publisher.
       */
      async publish(event, strict = false) {
        const handlers = this.subscribers.get(event.eventType);
        if (!handlers || handlers.size === 0) return;
        const failures = [];
        for (const handler of Array.from(handlers)) {
          try {
            await handler(event);
          } catch (err) {
            failures.push(err);
            console.error(`[DomainEventBus] Error executing subscriber for '${event.eventType}' (eventId: ${event.eventId}):`, safeError(err));
          }
        }
        if (strict && failures.length) throw failures[0];
      }
      /**
       * Convenient helper: constructs a DomainEvent envelope and publishes it.
       */
      async publishEvent(eventType, payload, version = 1, strict = false) {
        const event = createDomainEvent(eventType, payload, version);
        await this.publish(event, strict);
      }
      /**
       * Get total subscriber count for an event type (useful for testing).
       */
      getSubscriberCount(eventType) {
        return this.subscribers.get(eventType)?.size || 0;
      }
      /**
       * Resets all subscribers (for test isolation).
       */
      clear() {
        this.subscribers.clear();
      }
    };
    domainEventBus = new DomainEventBus();
  }
});

// events/eventBus.ts
var eventBus_exports = {};
__export(eventBus_exports, {
  eventBus: () => eventBus
});
import { EventEmitter } from "events";
import crypto4 from "node:crypto";
var TypedEventBus, eventBus;
var init_eventBus = __esm({
  "events/eventBus.ts"() {
    "use strict";
    init_DomainEventOutboxService();
    init_DomainEventBus();
    TypedEventBus = class extends EventEmitter {
      constructor() {
        super();
        this.setMaxListeners(50);
      }
      /**
       * Persist event to the durable outbox before any subscriber runs.
       * Can accept a database transaction session to guarantee atomic persistence with business entities.
       */
      async publishDurable(event, session) {
        const idempotencyKey = event.eventId || `domain:${event.eventType}:${crypto4.randomUUID()}`;
        await enqueueDomainEvent(
          {
            idempotencyKey,
            eventType: event.eventType,
            eventVersion: 1,
            organizationId: event.organizationId || event.tenantId,
            payload: { ...event, eventId: idempotencyKey }
          },
          session
        );
      }
      /** Await every subscriber before the durable worker acknowledges the event. */
      async dispatch(event) {
        const handlers = [...this.rawListeners("notification_event"), ...this.rawListeners(event.eventType)];
        const results = await Promise.allSettled(handlers.map((handler) => Promise.resolve().then(() => handler.call(this, event))));
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        await domainEventBus.publishEvent(event.eventType, event, 1, true);
      }
      subscribe(eventType, handler) {
        this.on(eventType, handler);
      }
      subscribeAll(handler) {
        this.on("notification_event", handler);
      }
    };
    eventBus = new TypedEventBus();
  }
});

// utilities/facility.ts
var FACILITY_TYPES;
var init_facility = __esm({
  "utilities/facility.ts"() {
    "use strict";
    FACILITY_TYPES = ["clinic", "hospital", "diagnostic_center", "medical_center", "specialty_center", "pharmacy", "other"];
  }
});

// utilities/googleMapsEmbed.ts
function isGoogleMapsEmbedUrl(value) {
  if (typeof value !== "string" || value.length > 12e3) return false;
  try {
    const url = new URL(value);
    return value === url.href && url.protocol === "https:" && url.hostname === "www.google.com" && !url.port && !url.username && !url.password && !url.hash && url.pathname === "/maps/embed" && Boolean(url.searchParams.get("pb")) && [...url.searchParams.keys()].every((key) => key === "pb" || key === "hl");
  } catch {
    return false;
  }
}
var init_googleMapsEmbed = __esm({
  "utilities/googleMapsEmbed.ts"() {
    "use strict";
  }
});

// models/Location.ts
import mongoose5, { Schema as Schema3 } from "mongoose";
var LocationSchema, Location;
var init_Location = __esm({
  "models/Location.ts"() {
    "use strict";
    init_facility();
    init_googleMapsEmbed();
    LocationSchema = new Schema3({
      organizationId: { type: Schema3.Types.ObjectId, ref: "Organization", required: true, index: true },
      name: { type: String, required: true },
      // Held until an authenticated, reconciled release; expiry never clears ownership.
      pharmacyOfflineOwner: { type: String, default: void 0 },
      facilityType: { type: String, enum: [...FACILITY_TYPES], default: null },
      publicPharmacy: { type: new Schema3({ catalogueEnabled: { type: Boolean, default: false }, pickupEnabled: { type: Boolean, default: false }, revision: { type: Number, required: true, min: 0, validate: Number.isSafeInteger } }, { _id: false }), default: void 0 },
      pharmacyCapability: { type: new Schema3({
        enabled: { type: Boolean, required: true },
        revision: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
        inventoryMode: { type: String, enum: ["tracked", "billing_only"], default: "tracked", required: true },
        reviewReference: String,
        confirmedBy: { type: Schema3.Types.ObjectId, ref: "User" },
        confirmedAt: Date
      }, { _id: false }), default: void 0 },
      logo: { type: String },
      images: [{ type: String }],
      description: { type: String },
      brandColor: { type: String, enum: ["#0F6F66", "#1D4ED8", "#6D28D9", "#9A3412"], default: "#0F6F66" },
      phone: { type: String },
      email: { type: String },
      address: { type: String },
      city: { type: String, required: true },
      timezone: { type: String },
      // Optional branch override; otherwise use organization timezone.
      latitude: { type: Number },
      longitude: { type: Number },
      googleMapsEmbedUrl: { type: String, default: null, validate: { validator: (value) => value == null || value === "" || isGoogleMapsEmbedUrl(value), message: "Use a Google Maps embed URL" } },
      timings: { type: String },
      // JSON schedule string
      amenities: [{ type: String }],
      onlineBookingSafetyBuffer: { type: Number, default: 30 },
      // Default safety buffer in minutes for online bookings
      upiVpa: { type: String, trim: true, default: "" },
      // Direct NPCI/BharatPe UPI VPA for countertop QR
      merchantName: { type: String, trim: true, default: "" },
      // Official registered merchant business name
      isActive: { type: Boolean, default: true },
      // Publishing is independent of operational activation and subscription access.
      isPublished: { type: Boolean, default: true },
      createdAt: { type: Date, default: Date.now }
    });
    LocationSchema.virtual("id").get(function() {
      return this._id.toHexString();
    });
    LocationSchema.set("toJSON", {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString();
        if (ret.pharmacyCapability) ret.pharmacyCapability = { enabled: ret.pharmacyCapability.enabled, revision: ret.pharmacyCapability.revision, inventoryMode: ret.pharmacyCapability.inventoryMode };
        delete ret._id;
        delete ret.__v;
        delete ret.pharmacyOfflineOwner;
        return ret;
      }
    });
    Location = mongoose5.model("Location", LocationSchema);
  }
});

// models/User.ts
var User_exports = {};
__export(User_exports, {
  AUTH_METHOD_OPTIONS: () => AUTH_METHOD_OPTIONS,
  User: () => User
});
import mongoose6, { Schema as Schema4 } from "mongoose";
var AUTH_METHOD_OPTIONS, UserSchema, User;
var init_User = __esm({
  "models/User.ts"() {
    "use strict";
    AUTH_METHOD_OPTIONS = ["email_password", "phone_otp", "email_otp", "both"];
    UserSchema = new Schema4({
      name: { type: String, required: true },
      email: { type: String, unique: true, sparse: true, index: true },
      googleSubject: { type: String, unique: true, sparse: true, index: true },
      password: { type: String },
      phone: { type: String, index: true },
      authMethod: { type: String, enum: AUTH_METHOD_OPTIONS, default: AUTH_METHOD_OPTIONS[0] },
      role: { type: String, required: true, index: true },
      // "root" | "admin" | "doctor" | "receptionist" | "nurse" | "lab_tech" | "pharmacist" | "cashier" | "patient" | "family_member"
      twoFactorEnabled: { type: Boolean, default: false },
      twoFactorEnrollmentRequired: { type: Boolean, default: false },
      twoFactorSecret: { type: String },
      isEmailVerified: { type: Boolean, default: true },
      // Defaults to true for admin/staff created by org; patient self-reg sets false
      emailVerificationToken: { type: String, sparse: true, index: true },
      emailVerificationExpires: { type: Date },
      passwordResetToken: { type: String, sparse: true, index: true },
      passwordResetExpires: { type: Date },
      failedLoginAttempts: { type: Number, default: 0 },
      lockoutUntil: { type: Date, default: null },
      image_url: { type: String, default: null },
      isActive: { type: Boolean, default: true },
      authVersion: { type: Number, default: 1 },
      adminSessionLimit: { type: Number, default: null, min: 1, max: 1e3 }
    }, { timestamps: true });
    UserSchema.virtual("id").get(function() {
      return this._id.toHexString();
    });
    UserSchema.set("toJSON", {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        for (const field of [
          "password",
          "twoFactorSecret",
          "passwordResetToken",
          "passwordResetExpires",
          "emailVerificationToken",
          "emailVerificationExpires",
          "googleSubject"
        ]) delete ret[field];
        return ret;
      }
    });
    User = mongoose6.model("User", UserSchema);
  }
});

// utilities/documentBudget.ts
import mongoose7 from "mongoose";
function documentBudget(schema11, limits) {
  schema11.pre("validate", function() {
    for (const [path3, limit] of Object.entries(limits)) {
      if ((this.get(path3)?.length || 0) > limit) throw Object.assign(new Error(`Embedded ${path3} limit reached; retain history and use a new record`), { statusCode: 409 });
    }
    if (mongoose7.mongo.BSON.calculateObjectSize(this.toObject({ virtuals: false, getters: false })) > 8 * 1024 * 1024) throw Object.assign(new Error("Document growth budget exceeded"), { statusCode: 409 });
  });
  for (const method of ["updateOne", "updateMany", "findOneAndUpdate"]) {
    schema11.pre(method, function() {
      const update = this.getUpdate();
      if (!update || Array.isArray(update)) return;
      for (const [path3, limit] of Object.entries(limits)) {
        const replacement = update.$set?.[path3] ?? update[path3];
        if (Array.isArray(replacement) && replacement.length > limit) throw Object.assign(new Error(`Embedded ${path3} limit reached`), { statusCode: 409 });
        const append = update.$push?.[path3] ?? update.$addToSet?.[path3];
        if (append !== void 0) {
          const size = append?.$each ? append.$each.length : 1;
          this.setQuery({ $and: [this.getFilter(), { $expr: { $lte: [{ $size: { $ifNull: [`$${path3}`, []] } }, limit - size] } }] });
        }
      }
    });
  }
}
var init_documentBudget = __esm({
  "utilities/documentBudget.ts"() {
    "use strict";
  }
});

// models/Counter.ts
var Counter_exports = {};
__export(Counter_exports, {
  Counter: () => Counter,
  getNextAtomicSequence: () => getNextAtomicSequence
});
import mongoose8, { Schema as Schema6 } from "mongoose";
async function getNextAtomicSequence(counterId, session) {
  const result = await Counter.findOneAndUpdate(
    { id: counterId },
    { $inc: { seq: 1 } },
    { returnDocument: "after", upsert: true, ...session ? { session } : {} }
  );
  return result.seq;
}
var CounterSchema, Counter;
var init_Counter = __esm({
  "models/Counter.ts"() {
    "use strict";
    CounterSchema = new Schema6(
      {
        id: { type: String, required: true, unique: true },
        seq: { type: Number, default: 0 }
      },
      { timestamps: true }
    );
    Counter = mongoose8.models.Counter || mongoose8.model("Counter", CounterSchema);
  }
});

// utilities/context.ts
import { AsyncLocalStorage } from "node:async_hooks";
var requestContextStore;
var init_context = __esm({
  "utilities/context.ts"() {
    "use strict";
    requestContextStore = new AsyncLocalStorage();
  }
});

// utilities/tenantPlugin.ts
import mongoose9, { Schema as Schema7 } from "mongoose";
function tenantPlugin(schema11, options = {}) {
  const tenantField = options.tenantField || "organizationId";
  if (!schema11.path(tenantField)) {
    schema11.add({
      [tenantField]: {
        type: Schema7.Types.ObjectId,
        ref: "Organization",
        index: true,
        default: null
      }
    });
  }
  function shouldApplyTenantFilter(query) {
    if (query.getOptions?.()?.bypassTenantFilter) {
      return { apply: false };
    }
    const context = requestContextStore.getStore();
    if (!context || !context.organizationId || context.isRoot) {
      return { apply: false };
    }
    if (!mongoose9.Types.ObjectId.isValid(context.organizationId)) {
      return { apply: false };
    }
    return {
      apply: true,
      orgId: new mongoose9.Types.ObjectId(context.organizationId)
    };
  }
  const queryMethods = [
    "find",
    "findOne",
    "findOneAndUpdate",
    "findOneAndDelete",
    "findOneAndReplace",
    "countDocuments",
    "deleteMany",
    "deleteOne",
    "updateMany",
    "updateOne"
  ];
  for (const method of queryMethods) {
    schema11.pre(method, function() {
      const { apply, orgId } = shouldApplyTenantFilter(this);
      if (!apply || !orgId) return;
      const currentFilter = this.getFilter() || {};
      if (currentFilter[tenantField] !== void 0) {
        if (String(currentFilter[tenantField]) !== String(orgId)) {
          this.where({ [tenantField]: orgId });
        }
      } else {
        this.where({ [tenantField]: orgId });
      }
    });
  }
  schema11.pre("save", function() {
    const context = requestContextStore.getStore();
    if (context?.organizationId && !context.isRoot) {
      if (this.get(tenantField) && String(this.get(tenantField)) !== context.organizationId) throw new Error("Tenant ownership mismatch");
      if (!this.get(tenantField)) {
        this.set(tenantField, new mongoose9.Types.ObjectId(context.organizationId));
      }
    }
  });
  for (const method of ["updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace"]) {
    schema11.pre(method, function() {
      const context = requestContextStore.getStore();
      if (!context?.organizationId || context.isRoot || this.getOptions()?.bypassTenantFilter) return;
      const update = this.getUpdate();
      if (Array.isArray(update)) throw new Error("Tenant update pipelines require a scoped repository");
      if (update?.$unset?.[tenantField] !== void 0 || update?.$rename?.[tenantField] !== void 0) throw new Error("Tenant ownership cannot be removed");
      for (const candidate of [update?.[tenantField], update?.$set?.[tenantField], update?.$setOnInsert?.[tenantField]]) {
        if (candidate !== void 0 && String(candidate) !== context.organizationId) throw new Error("Tenant ownership mismatch");
      }
    });
  }
}
var init_tenantPlugin = __esm({
  "utilities/tenantPlugin.ts"() {
    "use strict";
    init_context();
  }
});

// models/Patient.ts
var Patient_exports = {};
__export(Patient_exports, {
  Patient: () => Patient
});
import mongoose10, { Schema as Schema8 } from "mongoose";
var PatientSchema, Patient;
var init_Patient = __esm({
  "models/Patient.ts"() {
    "use strict";
    init_documentBudget();
    init_Counter();
    init_tenantPlugin();
    init_cryptoEnvelope();
    PatientSchema = new Schema8({
      userId: { type: Schema8.Types.ObjectId, ref: "User", unique: true, sparse: true, index: true },
      name: { type: String, trim: true, index: true },
      phone: { type: String, trim: true, index: true },
      email: { type: String, trim: true, index: true },
      accountType: { type: String, enum: ["self", "dependent", "walkin"], default: "self" },
      createdBy: { type: Schema8.Types.ObjectId, ref: "User" },
      organizationId: { type: Schema8.Types.ObjectId, ref: "Organization", index: true },
      personalVaultId: { type: String, unique: true, sparse: true, index: true },
      abdmHealthId: { type: String, sparse: true },
      abhaNumber: { type: String, sparse: true, index: true },
      abhaAddress: { type: String, sparse: true, index: true },
      abhaStatus: { type: String, enum: ["unverified", "verified", "active", "deactivated"], default: "unverified" },
      abhaLinkedAt: { type: Date },
      abhaVerificationMethod: { type: String, enum: ["aadhaar_otp", "mobile_otp", "scan_and_share", "manual"] },
      dob: { type: Date },
      gender: { type: String, enum: ["male", "female", "other"] },
      bloodGroup: { type: String, enum: ["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"] },
      address: { type: String },
      city: { type: String, trim: true, index: true },
      state: { type: String, trim: true },
      pincode: { type: String, trim: true },
      nationality: { type: String, trim: true, default: "Indian" },
      allergies: [{ type: String }],
      conditions: [{ type: String }],
      medicalNotes: {
        type: String,
        get: decryptField,
        set: encryptField
      },
      emergencyContacts: [
        {
          name: { type: String, required: true },
          relationship: { type: String, required: true },
          phone: { type: String, required: true }
        }
      ],
      insurancePolicies: [
        {
          providerName: { type: String, required: true },
          policyNumber: { type: String, required: true },
          coverageAmount: { type: Number },
          validUntil: { type: Date }
        }
      ],
      mrn: { type: String, unique: true, sparse: true, index: true },
      globalPatientId: { type: String, unique: true, sparse: true, index: true },
      optOutWhatsApp: { type: Boolean, default: false, index: true },
      // ABDM Milestone 3 (M3) HIP Care Contexts & HIU Consent
      careContexts: [
        {
          careContextReference: { type: String, required: true },
          display: { type: String, required: true },
          appointmentId: { type: Schema8.Types.ObjectId, ref: "Appointment" },
          hipId: { type: String },
          linkedAt: { type: Date, default: Date.now }
        }
      ],
      abdmConsentRequests: [
        {
          consentRequestId: { type: String, required: true },
          status: { type: String, enum: ["REQUESTED", "GRANTED", "DENIED", "EXPIRED"], default: "REQUESTED" },
          purpose: { type: String, default: "CAREMGT" },
          hiTypes: [{ type: String }],
          dateFrom: { type: Date },
          dateTo: { type: Date },
          requestedAt: { type: Date, default: Date.now },
          grantedAt: { type: Date }
        }
      ],
      // DPDP 2023 Compliance & NMC Legal Retention Fields
      dpdpStatus: {
        type: String,
        enum: ["ACTIVE", "ERASURE_REQUESTED", "ANONYMIZED"],
        default: "ACTIVE",
        index: true
      },
      anonymizedAt: { type: Date },
      legalRetentionHoldUntil: { type: Date, index: true },
      erasureRequestedAt: { type: Date },
      erasureReason: { type: String }
    }, { timestamps: true });
    PatientSchema.index({ organizationId: 1, createdAt: -1 });
    PatientSchema.index({ organizationId: 1, phone: 1 });
    PatientSchema.pre("save", async function() {
      if (!this.globalPatientId) {
        const year = (/* @__PURE__ */ new Date()).getFullYear();
        const seq = await getNextAtomicSequence(`gpid_${year}`);
        this.globalPatientId = `UPI-${year}-${String(seq).padStart(7, "0")}`;
      }
      if (!this.mrn) {
        const year = (/* @__PURE__ */ new Date()).getFullYear();
        const orgPart = this.organizationId ? this.organizationId.toString() : "GLOBAL";
        const seq = await getNextAtomicSequence(`mrn_${orgPart}_${year}`);
        const orgSuffix = this.organizationId ? this.organizationId.toString().toUpperCase() : "GEN";
        this.mrn = `MRN-${year}-${orgSuffix}-${String(seq).padStart(6, "0")}`;
      }
    });
    PatientSchema.plugin(tenantPlugin);
    PatientSchema.plugin(documentBudget, { allergies: 100, conditions: 100, emergencyContacts: 20, insurancePolicies: 50, careContexts: 2e3, abdmConsentRequests: 2e3 });
    PatientSchema.virtual("id").get(function() {
      return this._id.toHexString();
    });
    PatientSchema.set("toJSON", {
      virtuals: true,
      getters: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    });
    PatientSchema.set("toObject", {
      virtuals: true,
      getters: true
    });
    Patient = mongoose10.models.Patient || mongoose10.model("Patient", PatientSchema);
  }
});

// models/Organization.ts
import mongoose11, { Schema as Schema9 } from "mongoose";
var OrganizationSchema, Organization;
var init_Organization = __esm({
  "models/Organization.ts"() {
    "use strict";
    OrganizationSchema = new Schema9({
      name: { type: String, required: true },
      workspaceProfile: { type: String, enum: ["clinic", "pharmacy"], default: "clinic" },
      staffMfaRequired: { type: Boolean, default: false },
      address: { type: String },
      city: { type: String, required: true },
      phone: { type: String },
      email: { type: String },
      description: { type: String },
      image_url: { type: String },
      logo_url: { type: String },
      images: [{ type: String }],
      timings: { type: String },
      // JSON string of schedule
      working_days: { type: String },
      // JSON string
      plan: { type: String, enum: ["starter", "professional", "enterprise"], default: "starter" },
      maxLocations: { type: Number, default: 1 },
      maxDoctors: { type: Number, default: 2 },
      maxStaff: { type: Number, default: 2 },
      taxId: { type: String },
      // GSTIN / EIN
      billingDetails: {
        gstin: { type: String, default: null },
        email: { type: String, default: null },
        address: { type: String, default: null }
      },
      licenseNumber: { type: String },
      // Operating License No.
      countryCode: { type: String, enum: ["IN", "US", "CA", "GB", "AE"] },
      currency: { type: String, enum: ["INR", "USD", "CAD", "EUR", "GBP", "AED"], default: "INR" },
      timezone: { type: String, default: "Asia/Kolkata" },
      workflowPreferences: {
        registration: { type: String, enum: ["full", "essential"], default: "full" },
        consultation: { type: String, enum: ["full", "focused"], default: "full" },
        queueChime: { type: String, enum: ["bell", "ding-dong", "synth", "elevator", "gong", "beep", "marimba", "mute"], default: "bell" },
        queueVoiceLanguage: { type: String, enum: ["off", "en", "hi", "both"], default: "en" }
      },
      crmSettings: {
        automationEnabled: { type: Boolean, default: false },
        defaultInquiryHours: { type: Number, min: 1, max: 168, default: 1 },
        defaultTaskHours: { type: Number, min: 1, max: 168, default: 24 },
        reminderStartHour: { type: Number, min: 0, max: 23, default: 8 },
        reminderEndHour: { type: Number, min: 1, max: 24, default: 20 },
        feedbackRecoveryRating: { type: Number, min: 1, max: 3, default: 2 },
        campaignsEnabled: { type: Boolean, default: false, immutable: true },
        revision: { type: Number, default: 0 }
      },
      onboardingStatus: {
        type: String,
        enum: ["NOT_STARTED", "ORGANIZATION_CREATED", "ADMIN_CREATED", "LOCATION_CREATED", "TWO_FACTOR_PENDING", "COMPLETED"],
        default: "NOT_STARTED"
      },
      isOnboarded: { type: Boolean, default: false },
      isActive: { type: Boolean, default: true },
      status: { type: String, enum: ["active", "inactive"], default: "active" },
      authVersion: { type: Number, default: 1 },
      billingInitializationToken: { type: String, default: null, select: false },
      billingInitializationAt: { type: Date, default: null, select: false },
      // ─── SMTP / Outbound Email Gateway Configuration ───────────────────────
      // If set, overrides backend .env SMTP credentials for this organization.
      smtp: {
        host: { type: String, default: null },
        port: { type: Number, default: 587 },
        secure: { type: Boolean, default: false },
        user: { type: String, default: null },
        pass: { type: String, default: null, select: false },
        // stored encrypted/internal, never selected by default
        fromEmail: { type: String, default: null },
        fromName: { type: String, default: null }
      },
      // ─── Meta WhatsApp Business Gateway & Credits Configuration ────────────
      whatsappConfig: {
        mode: { type: String, enum: ["disabled", "shared", "dedicated"], default: "shared" },
        wabaId: { type: String, default: null },
        phoneNumberId: { type: String, default: null },
        accessToken: { type: String, default: null, select: false },
        // encrypted by configuration controller
        appSecret: { type: String, default: null, select: false },
        verifyToken: { type: String, default: null, select: false },
        connectionStatus: { type: String, enum: ["disconnected", "pending", "connected", "error"], default: "disconnected" },
        verifiedAt: Date,
        lastError: String,
        phoneDisplay: String,
        monthlyQuota: { type: Number, default: 500 },
        creditsBalance: { type: Number, default: 500 },
        creditsUsedThisMonth: { type: Number, default: 0 },
        prepaidCredits: { type: Number, default: 0 },
        quotaResetMonth: { type: String, default: "" },
        lowBalanceThreshold: { type: Number, default: 50 },
        autoRechargeEnabled: { type: Boolean, default: false },
        autoRechargePack: { type: String, enum: ["bronze", "silver", "gold"], default: "bronze" },
        notifications: {
          sendBookingConfirmation: { type: Boolean, default: true },
          sendConsultationComplete: { type: Boolean, default: true },
          sendAppointmentCancellation: { type: Boolean, default: true },
          sendTurnApproaching: { type: Boolean, default: false },
          sendQueueDelayAlert: { type: Boolean, default: true },
          sendDisruptionAlert: { type: Boolean, default: true }
        }
      },
      createdAt: { type: Date, default: Date.now }
    });
    OrganizationSchema.virtual("id").get(function() {
      return this._id.toHexString();
    });
    OrganizationSchema.set("toJSON", {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        if (ret.smtp && "pass" in ret.smtp) {
          delete ret.smtp.pass;
        }
        if (ret.whatsappConfig && "accessToken" in ret.whatsappConfig) {
          delete ret.whatsappConfig.accessToken;
        }
        if (ret.whatsappConfig) {
          delete ret.whatsappConfig.appSecret;
          delete ret.whatsappConfig.verifyToken;
        }
        return ret;
      }
    });
    OrganizationSchema.index({ "whatsappConfig.wabaId": 1 }, { unique: true, partialFilterExpression: { "whatsappConfig.wabaId": { $type: "string" } } });
    Organization = mongoose11.model("Organization", OrganizationSchema);
  }
});

// models/PatientRelationship.ts
import mongoose12, { Schema as Schema10 } from "mongoose";
var schema, PatientRelationship;
var init_PatientRelationship = __esm({
  "models/PatientRelationship.ts"() {
    "use strict";
    init_tenantPlugin();
    schema = new Schema10({
      organizationId: { type: Schema10.Types.ObjectId, ref: "Organization", required: true },
      patientId: { type: Schema10.Types.ObjectId, ref: "Patient", required: true },
      locationId: { type: Schema10.Types.ObjectId, ref: "Location" },
      ownerId: { type: Schema10.Types.ObjectId, ref: "User" },
      revision: { type: Number, default: 0 },
      status: { type: String, enum: ["active", "archived"], default: "active" },
      contact: {
        phone: { type: String, trim: true },
        email: { type: String, trim: true, lowercase: true },
        availability: { type: String, enum: ["unknown", "reachable", "unreachable", "invalid"], default: "unknown" },
        recipientType: { type: String, enum: ["patient", "family"], default: "patient" },
        familyRelationshipId: { type: Schema10.Types.ObjectId, ref: "FamilyRelationship" },
        correctedAt: Date,
        correctedBy: { type: Schema10.Types.ObjectId, ref: "User" }
      },
      preferences: {
        language: { type: String, maxlength: 40 },
        preferredChannel: { type: String, enum: ["phone", "whatsapp", "email", "none"] },
        doNotContact: { type: Boolean, default: false }
      },
      privacyRequest: {
        status: { type: String, enum: ["requested", "under_review", "retained", "fulfilled", "rejected"] },
        requestedAt: Date,
        reviewedAt: Date,
        reviewedBy: { type: Schema10.Types.ObjectId, ref: "User" },
        retentionBasis: { type: String, maxlength: 200 }
      }
    }, { timestamps: true });
    schema.index({ organizationId: 1, patientId: 1 }, { unique: true });
    schema.index({ organizationId: 1, locationId: 1, ownerId: 1, updatedAt: -1, _id: -1 });
    schema.plugin(tenantPlugin);
    PatientRelationship = mongoose12.models.PatientRelationship || mongoose12.model("PatientRelationship", schema);
  }
});

// models/OutboundMessage.ts
import mongoose13, { Schema as Schema11 } from "mongoose";
var OutboundMessageSchema, OutboundMessage;
var init_OutboundMessage = __esm({
  "models/OutboundMessage.ts"() {
    "use strict";
    init_scalability();
    OutboundMessageSchema = new Schema11(
      {
        kind: {
          type: String,
          enum: ["payment_receipt", "communication_template", "whatsapp_document", "whatsapp_freeform", "transactional_email"],
          required: true,
          index: true
        },
        idempotencyKey: { type: String, required: true, unique: true },
        payload: { type: Schema11.Types.Mixed, required: true },
        sensitivePayloadCiphertext: { type: String, select: false },
        status: {
          type: String,
          enum: ["pending", "processing", "retrying", "accepted", "sent", "delivered", "read", "suppressed", "failed"],
          default: "pending",
          index: true
        },
        attempts: { type: Number, default: 0 },
        maxAttempts: { type: Number, default: MAX_OUTBOUND_RETRY_COUNT },
        nextAttemptAt: { type: Date, default: Date.now, index: true },
        lockedAt: { type: Date },
        lockedUntil: { type: Date, index: true },
        lockedBy: { type: String, index: true },
        error: { type: String },
        sentAt: { type: Date },
        acceptedAt: { type: Date },
        deliveredAt: { type: Date },
        readAt: { type: Date },
        emailAttemptedAt: { type: Date },
        replayCount: { type: Number, default: 0 },
        lastReplayedAt: { type: Date },
        lastReplayedBy: { type: Schema11.Types.ObjectId, ref: "User" }
      },
      { timestamps: true }
    );
    OutboundMessageSchema.index({ status: 1, nextAttemptAt: 1, lockedUntil: 1 });
    OutboundMessageSchema.index({ "payload.organizationId": 1, "payload.locationId": 1, "payload.patientId": 1, _id: -1 });
    OutboundMessage = mongoose13.models.OutboundMessage || mongoose13.model(
      "OutboundMessage",
      OutboundMessageSchema
    );
  }
});

// models/Task.ts
import mongoose14, { Schema as Schema12 } from "mongoose";
var TaskSchema, TaskModel;
var init_Task = __esm({
  "models/Task.ts"() {
    "use strict";
    TaskSchema = new Schema12({
      organizationId: { type: Schema12.Types.ObjectId, ref: "Organization", index: true },
      title: { type: String, required: true },
      description: { type: String },
      status: {
        type: String,
        enum: ["todo", "in_progress", "review", "completed"],
        default: "todo",
        index: true
      },
      priority: {
        type: String,
        enum: ["low", "medium", "high", "urgent"],
        default: "medium"
      },
      dueDate: { type: Date, index: true },
      assignedTo: { type: Schema12.Types.ObjectId, ref: "User", index: true },
      kind: { type: String, default: "general", index: true },
      patientId: { type: Schema12.Types.ObjectId, ref: "Patient" },
      locationId: { type: Schema12.Types.ObjectId, ref: "Location" },
      revision: { type: Number, default: 0 },
      dedupeKey: String,
      inquiryId: { type: Schema12.Types.ObjectId, ref: "Inquiry" },
      appointmentId: { type: Schema12.Types.ObjectId, ref: "Appointment" },
      orderId: { type: Schema12.Types.ObjectId, ref: "LabOrder" },
      sourceRevision: Number,
      snoozedUntil: Date,
      completedAt: Date,
      outcome: { type: String, maxlength: 60 },
      needsAssignment: { type: Boolean, default: false },
      resultAppointmentId: { type: Schema12.Types.ObjectId, ref: "Appointment" },
      followUpReview: { type: String, enum: ["ambiguous", "legacy"] },
      createdBy: { type: Schema12.Types.ObjectId, ref: "User", required: function() {
        return !String(this.kind || "general").startsWith("crm_");
      } },
      createdAt: { type: Date, default: Date.now },
      updatedAt: { type: Date, default: Date.now }
    }, { timestamps: true });
    TaskSchema.index({ organizationId: 1, status: 1 });
    TaskSchema.index({ organizationId: 1, locationId: 1, assignedTo: 1, status: 1, dueDate: 1, _id: 1 });
    TaskSchema.index({ organizationId: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } });
    TaskSchema.virtual("id").get(function() {
      return this._id.toHexString();
    });
    TaskSchema.set("toJSON", {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    });
    TaskModel = mongoose14.model("Task", TaskSchema);
  }
});

// models/OrgMember.ts
import mongoose15, { Schema as Schema13 } from "mongoose";
var OrgMemberSchema, OrgMember;
var init_OrgMember = __esm({
  "models/OrgMember.ts"() {
    "use strict";
    OrgMemberSchema = new Schema13({
      userId: { type: Schema13.Types.ObjectId, ref: "User", required: true, index: true },
      organizationId: { type: Schema13.Types.ObjectId, ref: "Organization", required: true, index: true },
      role: { type: String, required: true },
      locationAccess: { type: new Schema13({
        mode: { type: String, enum: ["all", "selected"], required: true },
        locationIds: [{ type: Schema13.Types.ObjectId, ref: "Location" }]
      }, { _id: false }), default: void 0 },
      accessRevision: { type: Number, default: 0, min: 0 },
      joinedAt: { type: Date, default: Date.now }
    });
    OrgMemberSchema.index({ userId: 1, organizationId: 1 }, { unique: true });
    OrgMemberSchema.virtual("id").get(function() {
      return this._id.toHexString();
    });
    OrgMemberSchema.set("toJSON", {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    });
    OrgMember = mongoose15.model("OrgMember", OrgMemberSchema);
  }
});

// models/PatientRecordAccess.ts
import mongoose16, { Schema as Schema14 } from "mongoose";
var schema2, PatientRecordAccess;
var init_PatientRecordAccess = __esm({
  "models/PatientRecordAccess.ts"() {
    "use strict";
    schema2 = new Schema14({
      tokenHash: { type: String, required: true, unique: true },
      patientId: { type: Schema14.Types.ObjectId, ref: "Patient", required: true },
      userId: { type: Schema14.Types.ObjectId, ref: "User", required: true },
      organizationId: { type: Schema14.Types.ObjectId, ref: "Organization", required: true },
      sessionId: { type: String, required: true },
      expiresAt: { type: Date, required: true }
    }, { timestamps: true });
    schema2.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    PatientRecordAccess = mongoose16.models.PatientRecordAccess || mongoose16.model("PatientRecordAccess", schema2);
  }
});

// services/PatientRecordAccessService.ts
var PatientRecordAccessService_exports = {};
__export(PatientRecordAccessService_exports, {
  getOrganizationPatient: () => getOrganizationPatient,
  hasPatientRecordAccess: () => hasPatientRecordAccess,
  recordTokenHash: () => recordTokenHash
});
import crypto5 from "node:crypto";
async function getOrganizationPatient(patientId, organizationId) {
  const patient = await Patient.findById(patientId).setOptions({ bypassTenantFilter: true }).populate("userId", "name phone email");
  if (!patient) return null;
  const userId = patient.userId?._id || patient.userId;
  if (patient.organizationId?.toString() === organizationId) return patient;
  const related = await Appointment.exists({ patientId, organizationId }).setOptions({ bypassTenantFilter: true }) || await PatientRelationship.exists({ patientId, organizationId, status: "active" }).setOptions({ bypassTenantFilter: true });
  if (related || userId && await OrgMember.exists({ userId, organizationId })) return patient;
  return null;
}
async function hasPatientRecordAccess(token, patientId, userId, organizationId, sessionId) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token) || !userId || !sessionId) return false;
  return Boolean(await PatientRecordAccess.exists({ tokenHash: recordTokenHash(token), patientId, userId, organizationId, sessionId, expiresAt: { $gt: /* @__PURE__ */ new Date() } }));
}
var recordTokenHash;
var init_PatientRecordAccessService = __esm({
  "services/PatientRecordAccessService.ts"() {
    "use strict";
    init_Patient();
    init_Appointment();
    init_OrgMember();
    init_PatientRecordAccess();
    init_PatientRelationship();
    recordTokenHash = (token) => crypto5.createHash("sha256").update(token).digest("hex");
  }
});

// models/DPDPConsent.ts
import mongoose17, { Schema as Schema15 } from "mongoose";
var DPDP_PURPOSES, DPDPConsentSchema, DPDPConsent;
var init_DPDPConsent = __esm({
  "models/DPDPConsent.ts"() {
    "use strict";
    DPDP_PURPOSES = [
      "COMMUNICATION_WHATSAPP",
      "AI_CLINICAL_ASSISTANCE",
      "PREVENTIVE_HEALTH_RECALLS",
      "FEEDBACK_AND_SURVEYS",
      "COMMUNICATION_EMAIL",
      "COMMUNICATION_PHONE"
    ];
    DPDPConsentSchema = new Schema15(
      {
        patientId: { type: Schema15.Types.ObjectId, ref: "Patient", required: true, index: true },
        userId: { type: Schema15.Types.ObjectId, ref: "User", index: true },
        organizationId: { type: Schema15.Types.ObjectId, ref: "Organization", required: true, index: true },
        revision: { type: Number, default: 0 },
        purposes: [
          {
            purpose: {
              type: String,
              enum: DPDP_PURPOSES,
              required: true
            },
            status: {
              type: String,
              enum: ["UNKNOWN", "GRANTED", "WITHDRAWN"],
              default: "UNKNOWN",
              required: true
            },
            updatedAt: { type: Date, default: Date.now },
            evidence: {
              noticeVersion: String,
              method: { type: String, enum: ["portal_confirmation", "in_person_confirmation", "written_consent", "verified_patient_request"] },
              recordedBy: { type: Schema15.Types.ObjectId, ref: "User" },
              recordedAt: Date,
              activityId: { type: Schema15.Types.ObjectId, ref: "CrmActivity" },
              recipientHash: String,
              familyRelationshipId: { type: Schema15.Types.ObjectId, ref: "FamilyRelationship" },
              familyAuthorityRevision: Number
            }
          }
        ],
        history: [
          {
            purpose: { type: String, enum: DPDP_PURPOSES, required: true },
            action: { type: String, enum: ["GRANTED", "WITHDRAWN"], required: true },
            timestamp: { type: Date, default: Date.now },
            actorId: { type: Schema15.Types.ObjectId, ref: "User" },
            ipAddress: { type: String },
            userAgent: { type: String },
            source: {
              type: String,
              enum: ["PATIENT_PORTAL", "LOCATION_DESK", "API", "CONSENT_WITHDRAWAL_REQUEST"]
            }
          }
        ]
      },
      { timestamps: true }
    );
    DPDPConsentSchema.index({ patientId: 1, organizationId: 1 }, { unique: true });
    DPDPConsentSchema.virtual("id").get(function() {
      return this._id.toHexString();
    });
    DPDPConsentSchema.set("toJSON", {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    });
    DPDPConsent = mongoose17.model("DPDPConsent", DPDPConsentSchema);
  }
});

// models/CrmActivity.ts
import mongoose18, { Schema as Schema16 } from "mongoose";
var schema3, CrmActivity;
var init_CrmActivity = __esm({
  "models/CrmActivity.ts"() {
    "use strict";
    init_tenantPlugin();
    init_cryptoEnvelope();
    schema3 = new Schema16({
      organizationId: { type: Schema16.Types.ObjectId, ref: "Organization", required: true },
      locationId: { type: Schema16.Types.ObjectId, ref: "Location" },
      patientId: { type: Schema16.Types.ObjectId, ref: "Patient" },
      inquiryId: { type: Schema16.Types.ObjectId, ref: "Inquiry" },
      appointmentId: { type: Schema16.Types.ObjectId, ref: "Appointment" },
      taskId: { type: Schema16.Types.ObjectId, ref: "Task" },
      actorId: { type: Schema16.Types.ObjectId, ref: "User" },
      kind: { type: String, required: true, maxlength: 60 },
      visibility: { type: String, enum: ["administrative", "consent", "privacy"], default: "administrative" },
      outcome: { type: String, maxlength: 60 },
      communication: {
        channel: { type: String, enum: ["phone", "whatsapp", "email"] },
        direction: { type: String, enum: ["inbound", "outbound"] },
        source: { type: String, enum: ["staff_reported", "provider_event"] },
        occurredAt: Date
      },
      note: {
        type: String,
        set: encryptField,
        get: decryptField,
        select: false,
        validate: { validator: (value) => !value || decryptField(value).length <= 2e3, message: "Note must be at most 2000 characters" }
      },
      consentChanges: [{ purpose: { type: String, maxlength: 60 }, status: { type: String, enum: ["GRANTED", "WITHDRAWN"] } }],
      revision: Number,
      eventKey: { type: String, maxlength: 200 }
    }, { timestamps: { createdAt: true, updatedAt: false }, toJSON: { getters: true } });
    schema3.index({ organizationId: 1, patientId: 1, createdAt: -1, _id: -1 });
    schema3.index({ organizationId: 1, inquiryId: 1, createdAt: -1, _id: -1 });
    schema3.index({ organizationId: 1, eventKey: 1 }, { unique: true, partialFilterExpression: { eventKey: { $type: "string" } } });
    schema3.plugin(tenantPlugin);
    CrmActivity = mongoose18.models.CrmActivity || mongoose18.model("CrmActivity", schema3);
  }
});

// utilities/auditRedaction.ts
function isIdentifier(value) {
  return value?._bsontype === "ObjectId" || value?.constructor?.name === "ObjectId";
}
function redactAuditDetails(value, depth = 0) {
  if (value === null || value === void 0 || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return REDACTED;
  if (isIdentifier(value)) return String(value);
  if (depth >= MAX_DEPTH) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    return value.map((item) => redactAuditDetails(item, depth + 1));
  }
  if (typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.replace(/([a-z])([A-Z])/g, "$1_$2");
      result[key] = sensitiveKey.test(normalizedKey) ? REDACTED : redactAuditDetails(child, depth + 1);
    }
    return result;
  }
  return String(value);
}
var REDACTED, MAX_DEPTH, sensitiveKey;
var init_auditRedaction = __esm({
  "utilities/auditRedaction.ts"() {
    "use strict";
    REDACTED = "[REDACTED]";
    MAX_DEPTH = 12;
    sensitiveKey = /(^|_)(password|secret|authorization|cookie|email|phone|mobile|address|name|dob|birth|gender|photo|image|signature|token(hash|expiresat|usedat)?|tracker|checkin|meetingurl|url|notes?|symptoms?|diagnosis|prescriptions?|allergies|conditions?|vitals?|medical|clinical|medication|investigation|report|attachment|message|content|description|reason|rawresponse)(_|$)/i;
  }
});

// models/AuditCheckpoint.ts
import mongoose19, { Schema as Schema17 } from "mongoose";
var AuditCheckpointSchema, AuditCheckpoint;
var init_AuditCheckpoint = __esm({
  "models/AuditCheckpoint.ts"() {
    "use strict";
    AuditCheckpointSchema = new Schema17({
      organizationId: { type: Schema17.Types.ObjectId, ref: "Organization", index: true, default: null },
      archivedUpToSequence: { type: Number, required: true },
      archivedUpToHash: { type: String, required: true },
      archivedCount: { type: Number, required: true },
      archiveFilePath: { type: String },
      archiveFileChecksum: { type: String },
      cutoffDate: { type: Date, required: true },
      previousCheckpointHash: { type: String, default: null },
      checkpointHash: { type: String, required: true },
      signature: { type: String, required: true },
      externalAnchor: { type: String, default: null },
      createdAt: { type: Date, default: Date.now, index: true }
    });
    AuditCheckpointSchema.index({ organizationId: 1, archivedUpToSequence: -1 });
    AuditCheckpointSchema.virtual("id").get(function() {
      return this._id.toHexString();
    });
    AuditCheckpointSchema.set("toJSON", {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    });
    AuditCheckpoint = mongoose19.models.AuditCheckpoint || mongoose19.model("AuditCheckpoint", AuditCheckpointSchema);
  }
});

// models/AuditChainHead.ts
import mongoose20, { Schema as Schema18 } from "mongoose";
var schema4, AuditChainHead;
var init_AuditChainHead = __esm({
  "models/AuditChainHead.ts"() {
    "use strict";
    schema4 = new Schema18({
      _id: { type: String },
      sequence: { type: Number, required: true },
      hash: { type: String, required: true }
    }, { versionKey: false });
    AuditChainHead = mongoose20.models.AuditChainHead || mongoose20.model("AuditChainHead", schema4);
  }
});

// utilities/transaction.ts
var transaction_exports = {};
__export(transaction_exports, {
  createWithSession: () => createWithSession,
  withClinicalTransaction: () => withClinicalTransaction,
  withTransaction: () => withTransaction
});
import mongoose21 from "mongoose";
async function withClinicalTransaction(fn) {
  const inherited = mongoose21.transactionAsyncLocalStorage?.getStore()?.session;
  if (inherited?.inTransaction()) return fn();
  const topology = mongoose21.connection?.client?.topology?.description?.type;
  if (topology === "Single" || topology === "Unknown") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Clinical finalization requires a transaction-capable MongoDB replica set");
    }
    return fn();
  }
  return mongoose21.connection.transaction(fn);
}
async function withTransaction(fn, options) {
  const inherited = mongoose21.transactionAsyncLocalStorage?.getStore()?.session;
  if (inherited?.inTransaction()) return fn(inherited);
  const topologyType = mongoose21.connection?.client?.topology?.description?.type;
  const isStandalone = topologyType === "Single" || topologyType === "Unknown";
  if (isStandalone) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Multi-document ACID transactions require a MongoDB Replica Set in production");
    }
    return fn(null);
  }
  return mongoose21.connection.transaction(async (session) => fn(session), options);
}
async function createWithSession(model, docData, session) {
  if (session) {
    const [created] = await model.create([docData], { session });
    return created;
  }
  return model.create(docData);
}
var init_transaction = __esm({
  "utilities/transaction.ts"() {
    "use strict";
    mongoose21.set("transactionAsyncLocalStorage", true);
  }
});

// utilities/auditCrypto.ts
import crypto6 from "node:crypto";
function canonicalize(obj) {
  if (obj === null || obj === void 0) return obj;
  if (typeof obj !== "object") return obj;
  if (obj instanceof Date) return obj.toISOString();
  if (Array.isArray(obj)) return obj.map(canonicalize);
  const sortedKeys = Object.keys(obj).sort();
  const result = {};
  for (const key of sortedKeys) {
    result[key] = canonicalize(obj[key]);
  }
  return result;
}
function computeAuditHash(data) {
  const canonicalDetails = data.details !== void 0 && data.details !== null ? JSON.stringify(canonicalize(data.details)) : "";
  let createdAtIso;
  if (data.createdAt instanceof Date) {
    createdAtIso = data.createdAt.toISOString();
  } else if (typeof data.createdAt === "string") {
    createdAtIso = new Date(data.createdAt).toISOString();
  } else {
    createdAtIso = (/* @__PURE__ */ new Date()).toISOString();
  }
  const payload = [
    String(data.sequence),
    data.prevHash || GENESIS_HASH,
    data.organizationId ? String(data.organizationId) : "GLOBAL",
    data.userId ? String(data.userId) : "SYSTEM",
    data.action,
    data.category || "CLINICAL_WRITE",
    data.targetId ? String(data.targetId) : "NONE",
    data.targetModel || "NONE",
    canonicalDetails,
    createdAtIso
  ].join("|");
  return crypto6.createHash("sha256").update(payload, "utf8").digest("hex");
}
var GENESIS_HASH;
var init_auditCrypto = __esm({
  "utilities/auditCrypto.ts"() {
    "use strict";
    GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";
  }
});

// models/RefreshToken.ts
import mongoose22, { Schema as Schema19 } from "mongoose";
var ImpersonationSchema, RefreshTokenSchema, RefreshToken;
var init_RefreshToken = __esm({
  "models/RefreshToken.ts"() {
    "use strict";
    ImpersonationSchema = new Schema19({
      id: { type: Schema19.Types.ObjectId, ref: "User", required: true },
      email: { type: String },
      name: { type: String },
      originalRole: { type: String, default: "root" }
    }, { _id: false });
    RefreshTokenSchema = new Schema19({
      userId: { type: Schema19.Types.ObjectId, ref: "User", required: true },
      organizationId: { type: Schema19.Types.ObjectId, ref: "Organization", index: true },
      workspaceRole: { type: String },
      workspaceAccessRevision: { type: Number },
      familyId: { type: String, required: true, index: true },
      generation: { type: Number, default: 1 },
      authVersion: { type: Number, default: 1 },
      tokenHash: { type: String, required: true, unique: true },
      expiresAt: { type: Date, required: true },
      revoked: { type: Boolean, default: false, index: true },
      revocationReason: { type: String, enum: ["rotated", "displaced", "terminated", "logout", "reuse_detected"], default: "rotated" },
      replacedByTokenHash: { type: String, default: null },
      graceExpiresAt: { type: Date, default: null },
      ipAddress: { type: String, default: "" },
      userAgent: { type: String, default: "" },
      deviceName: { type: String, default: "Browser Session" },
      isGuest: { type: Boolean, default: false },
      bookingPatientId: { type: Schema19.Types.ObjectId, ref: "Patient" },
      impersonatedBy: { type: ImpersonationSchema, default: void 0, required: false },
      lastActiveAt: { type: Date, default: Date.now },
      // Only the credential issuer sets this. Hydrating a legacy session must not
      // manufacture fresh authentication proof through a schema default.
      authenticatedAt: { type: Date },
      createdAt: { type: Date, default: Date.now }
    }, { timestamps: true });
    RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    RefreshTokenSchema.index({ userId: 1, revoked: 1, createdAt: -1 });
    RefreshTokenSchema.virtual("id").get(function() {
      return this._id.toHexString();
    });
    RefreshTokenSchema.set("toJSON", {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    });
    RefreshToken = mongoose22.model("RefreshToken", RefreshTokenSchema);
  }
});

// utilities/keys.ts
import crypto7 from "node:crypto";
import fs2 from "node:fs";
import path2 from "node:path";
function getPrivateKeyPath() {
  return process.env.JWT_PRIVATE_KEY_PATH || path2.join(process.cwd(), "keys", "private.pem");
}
function getPublicKeyPath() {
  return process.env.JWT_PUBLIC_KEY_PATH || path2.join(process.cwd(), "keys", "public.pem");
}
function initKeys(forceReload = false) {
  if (process.env.WORKLOAD_ROLE === "worker") {
    const encoded = process.env.JWT_PUBLIC_KEY_BASE64;
    const raw = process.env.JWT_PUBLIC_KEY;
    SERVICE_PUBLIC_KEY = encoded ? Buffer.from(encoded.trim(), "base64").toString("utf8") : raw ? raw.replace(/\\n/g, "\n").trim() : fs2.existsSync(getPublicKeyPath()) ? fs2.readFileSync(getPublicKeyPath(), "utf8").trim() : "";
    SERVICE_PRIVATE_KEY = "";
    if (!SERVICE_PUBLIC_KEY) throw new Error("Workers require the public verification key");
    return { privateKey: "", publicKey: SERVICE_PUBLIC_KEY };
  }
  if (!forceReload && SERVICE_PRIVATE_KEY && SERVICE_PUBLIC_KEY) {
    return { privateKey: SERVICE_PRIVATE_KEY, publicKey: SERVICE_PUBLIC_KEY };
  }
  if (process.env.JWT_PRIVATE_KEY_BASE64 && process.env.JWT_PUBLIC_KEY_BASE64) {
    try {
      SERVICE_PRIVATE_KEY = Buffer.from(process.env.JWT_PRIVATE_KEY_BASE64.trim(), "base64").toString("utf8");
      SERVICE_PUBLIC_KEY = Buffer.from(process.env.JWT_PUBLIC_KEY_BASE64.trim(), "base64").toString("utf8");
      return { privateKey: SERVICE_PRIVATE_KEY, publicKey: SERVICE_PUBLIC_KEY };
    } catch (err) {
      throw new Error(`Failed to decode JWT_*_BASE64 environment variables: ${err?.message || err}`);
    }
  }
  if (process.env.JWT_PRIVATE_KEY && process.env.JWT_PUBLIC_KEY) {
    SERVICE_PRIVATE_KEY = process.env.JWT_PRIVATE_KEY.replace(/\\n/g, "\n").trim();
    SERVICE_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY.replace(/\\n/g, "\n").trim();
    return { privateKey: SERVICE_PRIVATE_KEY, publicKey: SERVICE_PUBLIC_KEY };
  }
  const privPath = getPrivateKeyPath();
  const pubPath = getPublicKeyPath();
  if (fs2.existsSync(privPath) && fs2.existsSync(pubPath)) {
    SERVICE_PRIVATE_KEY = fs2.readFileSync(privPath, "utf8").trim();
    SERVICE_PUBLIC_KEY = fs2.readFileSync(pubPath, "utf8").trim();
    return { privateKey: SERVICE_PRIVATE_KEY, publicKey: SERVICE_PUBLIC_KEY };
  }
  const isProd = process.env.NODE_ENV === "production";
  if (isProd) {
    throw new Error(
      `\u274C [FATAL SECURITY CONFIGURATION ERROR]
RS256 JWT keypair is not configured in production mode.
Generating ephemeral keys on boot breaks horizontal scaling (Pod A cannot verify Pod B's tokens)
and will log out all active users whenever a container restarts or rolls out.

Fix: Generate a persistent keypair once using \`npm run generate:keys\` and inject into your cluster:
  - JWT_PRIVATE_KEY_BASE64 & JWT_PUBLIC_KEY_BASE64 (recommended for K8s Secret / AWS Secrets Manager / Doppler)
  - OR JWT_PRIVATE_KEY & JWT_PUBLIC_KEY
  - OR mount keys at ${privPath} and ${pubPath}
`
    );
  }
  const keysDir = path2.dirname(privPath);
  if (!fs2.existsSync(keysDir)) {
    try {
      fs2.mkdirSync(keysDir, { recursive: true });
    } catch {
    }
  }
  const { publicKey: publicKey2, privateKey } = crypto7.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  try {
    fs2.writeFileSync(privPath, privateKey, "utf8");
    fs2.writeFileSync(pubPath, publicKey2, "utf8");
  } catch {
  }
  SERVICE_PRIVATE_KEY = privateKey;
  SERVICE_PUBLIC_KEY = publicKey2;
  return { privateKey: SERVICE_PRIVATE_KEY, publicKey: SERVICE_PUBLIC_KEY };
}
var SERVICE_PRIVATE_KEY, SERVICE_PUBLIC_KEY;
var init_keys = __esm({
  "utilities/keys.ts"() {
    "use strict";
    SERVICE_PRIVATE_KEY = "";
    SERVICE_PUBLIC_KEY = "";
    initKeys();
  }
});

// services/StaffMfaPolicy.ts
var init_StaffMfaPolicy = __esm({
  "services/StaffMfaPolicy.ts"() {
    "use strict";
  }
});

// utilities/logger.ts
import crypto8 from "node:crypto";
var Logger, logger;
var init_logger = __esm({
  "utilities/logger.ts"() {
    "use strict";
    Logger = class {
      serviceName;
      constructor(serviceName = "ekavyu-backend") {
        this.serviceName = serviceName;
      }
      formatMessage(level, message, context = {}, extra = {}) {
        return JSON.stringify({
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          level,
          service: context.service || this.serviceName,
          traceId: context.traceId || crypto8.randomUUID(),
          spanId: context.spanId || crypto8.randomUUID().substring(0, 16),
          correlationId: context.correlationId || context.traceId,
          tenantId: context.tenantId || null,
          userId: context.userId || null,
          message,
          extra: Object.keys(extra).length > 0 ? extra : void 0
        });
      }
      info(message, context, extra) {
        console.log(this.formatMessage("INFO", message, context, extra));
      }
      warn(message, context, extra) {
        console.warn(this.formatMessage("WARN", message, context, extra));
      }
      error(message, context, extra) {
        console.error(this.formatMessage("ERROR", message, context, extra));
      }
      debug(message, context, extra) {
        console.debug(this.formatMessage("DEBUG", message, context, extra));
      }
    };
    logger = new Logger();
  }
});

// utilities/sessionResolver.ts
import mongoose23 from "mongoose";
var sessionSubClient;
var init_sessionResolver = __esm({
  "utilities/sessionResolver.ts"() {
    "use strict";
    init_safeError();
    init_StaffMfaPolicy();
    init_RefreshToken();
    init_User();
    init_Organization();
    init_OrgMember();
    init_redis();
    init_websocket();
    init_logger();
    sessionSubClient = createRedisSubscriber();
    if (sessionSubClient) {
      sessionSubClient.subscribe("session:events", (err) => {
        if (err) {
          console.warn("[SessionResolver] Failed to subscribe to session:events:", safeError(err));
        }
      });
      sessionSubClient.on("message", (channel, message) => {
        if (channel === "session:events") {
          try {
            const event = JSON.parse(message);
            if (event.type === "REVOKE_SESSION" && event.sessionId) {
              if (event.userId) {
                disconnectUserWebSockets(event.userId, 4001, "Session revoked across cluster");
              }
            } else if (event.type === "REVOKE_USER" && event.userId) {
              disconnectUserWebSockets(event.userId, 4001, "All user sessions terminated");
            } else if (event.type === "REVOKE_FAMILY" && event.familyId) {
              if (event.userId) {
                disconnectUserWebSockets(event.userId, 4003, `Token family revoked: ${event.reason || "reuse_detected"}`);
              }
            }
          } catch {
          }
        }
      });
    }
  }
});

// utilities/helpers.ts
import jwt from "jsonwebtoken";
function successResponse(data, message = "Success") {
  return { success: true, message, data };
}
function errorResponse(message, details) {
  return { success: false, message, ...details ? { details } : {} };
}
function getPaginationParams(query) {
  const page = Math.max(1, parseInt(String(query.page || 1), 10));
  const limit = Math.max(1, Math.min(100, parseInt(String(query.limit || 50), 10)));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}
function setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize }) {
  reply.header("X-Total-Count", totalCount.toString());
  reply.header("X-Total-Pages", totalPages.toString());
  reply.header("X-Current-Page", currentPage.toString());
  reply.header("X-Page-Size", pageSize.toString());
  reply.header("Access-Control-Expose-Headers", "X-Total-Count, X-Total-Pages, X-Current-Page, X-Page-Size");
}
var init_helpers = __esm({
  "utilities/helpers.ts"() {
    "use strict";
    init_RefreshToken();
    init_keys();
    init_User();
    init_OrgMember();
    init_sessionResolver();
  }
});

// models/Role.ts
import mongoose24, { Schema as Schema20 } from "mongoose";
var RoleSchema, Role;
var init_Role = __esm({
  "models/Role.ts"() {
    "use strict";
    RoleSchema = new Schema20({
      name: { type: String, required: true, index: true },
      organizationId: { type: Schema20.Types.ObjectId, ref: "Organization", default: null, index: true },
      description: { type: String },
      permissions: [{ type: String }],
      // List of permission codes
      isSystemRole: { type: Boolean, default: false },
      version: { type: Number, default: 1 },
      assignmentRevision: { type: Number, default: 0 }
    });
    RoleSchema.index({ name: 1, organizationId: 1 }, { unique: true });
    RoleSchema.set("toJSON", {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    });
    RoleSchema.post(["save", "findOneAndUpdate", "updateOne", "deleteOne"], async function() {
      await globalThis.__invalidateRoleCache?.();
    });
    Role = mongoose24.model("Role", RoleSchema);
  }
});

// utilities/crmPermissions.ts
var CRM_PERMISSION_CATALOG, ownWork, CRM_ROLE_PERMISSIONS;
var init_crmPermissions = __esm({
  "utilities/crmPermissions.ts"() {
    "use strict";
    CRM_PERMISSION_CATALOG = [
      { code: "VIEW_CRM", name: "View patient relationships", description: "Read authorized administrative CRM context" },
      { code: "MANAGE_CRM_INQUIRIES", name: "Manage inquiries", description: "Capture and progress authorized inquiries" },
      { code: "MANAGE_CRM_TASKS", name: "Manage CRM tasks", description: "Work on owned or explicitly authorized tasks" },
      { code: "ASSIGN_CRM_TASKS", name: "Assign CRM tasks", description: "Assign and reassign work in the permitted scope" },
      { code: "COMMUNICATE_PATIENTS", name: "Communicate with patients", description: "Request communications subject to consent and recipient policy" },
      { code: "RECORD_COMMUNICATION_CONSENT", name: "Record communication choices", description: "Record attributable patient instructions and evidence" },
      { code: "VIEW_CRM_ANALYTICS", name: "View CRM analytics", description: "Read permitted operational aggregates" },
      { code: "EXPORT_CRM", name: "Export CRM data", description: "Export authorized administrative information" },
      { code: "MANAGE_CRM_SETTINGS", name: "Manage CRM settings", description: "Configure permitted workflow defaults" },
      { code: "REVIEW_PATIENT_IDENTITY", name: "Review patient identity", description: "Review identity conflicts without automatically merging records" },
      { code: "RESOLVE_PATIENT_DUPLICATES", name: "Resolve patient duplicates", description: "Reserved for reviewed duplicate resolution; does not grant clinical access" }
    ].map((permission) => ({ ...permission, category: "Patient relationships & CRM" }));
    ownWork = ["VIEW_CRM", "MANAGE_CRM_TASKS", "COMMUNICATE_PATIENTS", "RECORD_COMMUNICATION_CONSENT"];
    CRM_ROLE_PERMISSIONS = {
      admin: [...ownWork, "MANAGE_CRM_INQUIRIES", "ASSIGN_CRM_TASKS", "VIEW_CRM_ANALYTICS", "MANAGE_CRM_SETTINGS", "REVIEW_PATIENT_IDENTITY"],
      location_manager: [...ownWork, "MANAGE_CRM_INQUIRIES", "ASSIGN_CRM_TASKS", "VIEW_CRM_ANALYTICS"],
      receptionist: [...ownWork, "MANAGE_CRM_INQUIRIES"],
      doctor: [...ownWork, "VIEW_CRM_ANALYTICS"],
      nurse: [...ownWork]
    };
  }
});

// utilities/permissions.ts
import mongoose25 from "mongoose";
function isPlatformRoot(role) {
  return role === "root";
}
async function invalidateRoleCache(roleName, organizationId) {
  if (roleName) {
    for (const key of rolePermissionsCache.keys()) {
      if (key.includes(`:${roleName}:`)) {
        rolePermissionsCache.delete(key);
      }
    }
  } else {
    rolePermissionsCache.clear();
  }
  try {
    if (redisClient) {
      await redisClient.incr(`auth:role:generation:${roleName || "all"}`);
    }
    await publishRedisEvent("auth:role:invalidate", { roleName, organizationId });
  } catch (err) {
    console.warn("[RoleCache] Failed to publish Redis cache invalidation:", safeError(err));
  }
}
async function getEffectivePermissions(role, organizationId, authVersion = 1, requireLive = false) {
  if (!role) return /* @__PURE__ */ new Set();
  if (requireLive) return readLiveRolePermissions(role, organizationId);
  let generation = "local";
  let cacheAvailable = true;
  if (redisClient) {
    try {
      const versions = await redisClient.mget("auth:role:generation:all", `auth:role:generation:${role}`);
      generation = `${versions[0] || "0"}.${versions[1] || "0"}`;
    } catch {
      cacheAvailable = false;
    }
  }
  const cacheKey = `perm:${organizationId || "global"}:${role}:${authVersion}:${generation}`;
  const now = Date.now();
  const cached = rolePermissionsCache.get(cacheKey);
  if (cacheAvailable && cached && cached.expiresAt > now) {
    return new Set(cached.permissions);
  }
  if (redisClient && cacheAvailable) {
    try {
      const redisVal = await redisClient.get(`auth:role:${cacheKey}`);
      if (redisVal) {
        const perms = JSON.parse(redisVal);
        rolePermissionsCache.set(cacheKey, { permissions: perms, expiresAt: now + ROLE_CACHE_TTL_MS });
        return new Set(perms);
      }
    } catch {
    }
  }
  const effectivePermissions = [...await readLiveRolePermissions(role, organizationId)];
  rolePermissionsCache.set(cacheKey, {
    permissions: effectivePermissions,
    expiresAt: now + ROLE_CACHE_TTL_MS
  });
  if (redisClient && cacheAvailable) {
    try {
      await redisClient.set(`auth:role:${cacheKey}`, JSON.stringify(effectivePermissions), "EX", REDIS_PERM_TTL_SECONDS);
    } catch {
    }
  }
  return new Set(effectivePermissions);
}
async function readLiveRolePermissions(role, organizationId) {
  const orgFilter = organizationId && mongoose25.Types.ObjectId.isValid(organizationId) ? [{ organizationId: new mongoose25.Types.ObjectId(organizationId) }, { organizationId: null }] : [{ organizationId: null }];
  const roleConfig = await Role.findOne({
    name: role,
    $or: orgFilter
  }).sort({ organizationId: -1 }).lean();
  let effectivePermissions = [];
  if (roleConfig) {
    effectivePermissions = Array.isArray(roleConfig.permissions) ? roleConfig.permissions : [];
  } else {
    effectivePermissions = BUILTIN_ROLE_PERMISSIONS[role] || [];
  }
  return new Set(effectivePermissions);
}
async function requestHasAnyPermission(req, ...requiredPermissions) {
  const role = req.user?.role;
  if (!role) return false;
  if (isPlatformRoot(role)) return true;
  const all = await getEffectivePermissions(role, req.user?.organization_id, req.user?.authVersion);
  return requiredPermissions.some((perm) => all.has(perm));
}
var ADMIN_PERMISSIONS, DOCTOR_PERMISSIONS, RECEPTIONIST_PERMISSIONS, NURSE_PERMISSIONS, LAB_TECH_PERMISSIONS, PHARMACIST_PERMISSIONS, CASHIER_PERMISSIONS, LOCATION_MANAGER_PERMISSIONS, PATIENT_PERMISSIONS, FAMILY_MEMBER_PERMISSIONS, BUILTIN_ROLE_PERMISSIONS, rolePermissionsCache, ROLE_CACHE_TTL_MS, REDIS_PERM_TTL_SECONDS, roleSubClient;
var init_permissions = __esm({
  "utilities/permissions.ts"() {
    "use strict";
    init_safeError();
    init_Role();
    init_redis();
    init_crmPermissions();
    ADMIN_PERMISSIONS = [
      "MANAGE_STAFF",
      "VIEW_STAFF",
      "MANAGE_LOCATIONS",
      "VIEW_LOCATIONS",
      "MANAGE_ORGANIZATION",
      "MANAGE_BEDS",
      "MANAGE_ADMISSIONS",
      "VIEW_ADMISSIONS",
      "MANAGE_MEDICINES",
      "MANAGE_LAB_TESTS",
      "MANAGE_BILLING",
      "VIEW_BILLING",
      "MANAGE_APPOINTMENTS",
      "VIEW_APPOINTMENTS",
      "VIEW_ANALYTICS",
      "MANAGE_QUEUE",
      "VIEW_EHR",
      "MANAGE_EHR",
      "MANAGE_CLINICAL_NOTES",
      "ADMINISTER_MEDICATION",
      "MANAGE_ORDERS",
      "MANAGE_DISCHARGE_SUMMARY",
      "ADMINISTRATIVE_GOVERNANCE",
      "VIEW_AUDIT_LOGS",
      "VIEW_PATIENTS",
      "MANAGE_PATIENTS"
    ];
    DOCTOR_PERMISSIONS = [
      "VIEW_LOCATIONS",
      "VIEW_PATIENTS",
      "VIEW_APPOINTMENTS",
      "MANAGE_APPOINTMENTS",
      "MANAGE_QUEUE",
      "VIEW_EHR",
      "MANAGE_EHR",
      "MANAGE_CLINICAL_NOTES",
      "ADMINISTER_MEDICATION",
      "MANAGE_ORDERS",
      "MANAGE_DISCHARGE_SUMMARY",
      "VIEW_ADMISSIONS",
      "MANAGE_ADMISSIONS",
      "VIEW_ANALYTICS"
    ];
    RECEPTIONIST_PERMISSIONS = [
      "VIEW_STAFF",
      "VIEW_LOCATIONS",
      "VIEW_PATIENTS",
      "MANAGE_PATIENTS",
      "MANAGE_APPOINTMENTS",
      "VIEW_APPOINTMENTS",
      "MANAGE_QUEUE",
      "VIEW_BILLING",
      "MANAGE_BILLING",
      "VIEW_ADMISSIONS",
      "MANAGE_ADMISSIONS",
      "MANAGE_BEDS",
      "MANAGE_ORDERS"
    ];
    NURSE_PERMISSIONS = [
      "VIEW_STAFF",
      "VIEW_LOCATIONS",
      "VIEW_APPOINTMENTS",
      "MANAGE_QUEUE",
      "VIEW_EHR",
      "MANAGE_EHR",
      "ADMINISTER_MEDICATION",
      "VIEW_ADMISSIONS",
      "MANAGE_BEDS"
    ];
    LAB_TECH_PERMISSIONS = [
      "VIEW_STAFF",
      "VIEW_LOCATIONS",
      "VIEW_EHR",
      "MANAGE_LAB_TESTS",
      "MANAGE_ORDERS"
    ];
    PHARMACIST_PERMISSIONS = [
      "VIEW_STAFF",
      "VIEW_LOCATIONS",
      "VIEW_PATIENTS",
      "VIEW_EHR",
      "MANAGE_MEDICINES"
    ];
    CASHIER_PERMISSIONS = [
      "VIEW_STAFF",
      "VIEW_LOCATIONS",
      "VIEW_PATIENTS",
      "VIEW_BILLING",
      "MANAGE_BILLING"
    ];
    LOCATION_MANAGER_PERMISSIONS = [
      "VIEW_PATIENTS",
      "MANAGE_PATIENTS",
      "VIEW_APPOINTMENTS",
      "MANAGE_APPOINTMENTS",
      "MANAGE_QUEUE",
      "VIEW_LOCATIONS",
      "VIEW_BILLING",
      "MANAGE_BILLING",
      "MANAGE_MEDICINES",
      "VIEW_EHR",
      "MANAGE_ORDERS"
    ];
    PATIENT_PERMISSIONS = [
      "VIEW_APPOINTMENTS",
      "VIEW_EHR",
      "VIEW_BILLING"
    ];
    FAMILY_MEMBER_PERMISSIONS = [
      "VIEW_APPOINTMENTS",
      "VIEW_EHR",
      "VIEW_BILLING"
    ];
    BUILTIN_ROLE_PERMISSIONS = {
      admin: ADMIN_PERMISSIONS,
      doctor: DOCTOR_PERMISSIONS,
      receptionist: RECEPTIONIST_PERMISSIONS,
      nurse: NURSE_PERMISSIONS,
      lab_tech: LAB_TECH_PERMISSIONS,
      pharmacist: PHARMACIST_PERMISSIONS,
      cashier: CASHIER_PERMISSIONS,
      location_manager: LOCATION_MANAGER_PERMISSIONS,
      patient: PATIENT_PERMISSIONS,
      family_member: FAMILY_MEMBER_PERMISSIONS
    };
    for (const [role, permissions] of Object.entries(CRM_ROLE_PERMISSIONS)) {
      BUILTIN_ROLE_PERMISSIONS[role] = [.../* @__PURE__ */ new Set([...BUILTIN_ROLE_PERMISSIONS[role] || [], ...permissions])];
    }
    rolePermissionsCache = /* @__PURE__ */ new Map();
    ROLE_CACHE_TTL_MS = process.env.NODE_ENV === "test" ? 0 : 300 * 1e3;
    REDIS_PERM_TTL_SECONDS = 300;
    roleSubClient = createRedisSubscriber();
    if (roleSubClient) {
      roleSubClient.subscribe("auth:role:invalidate", (err) => {
        if (err) {
          console.warn("[RoleCache] Failed to subscribe to auth:role:invalidate channel:", safeError(err));
        }
      });
      roleSubClient.on("message", (channel, message) => {
        if (channel === "auth:role:invalidate") {
          try {
            const payload = JSON.parse(message);
            if (payload?.roleName) {
              for (const key of rolePermissionsCache.keys()) {
                if (key.includes(`:${payload.roleName}:`)) {
                  rolePermissionsCache.delete(key);
                }
              }
            } else {
              rolePermissionsCache.clear();
            }
          } catch {
            rolePermissionsCache.clear();
          }
        }
      });
    }
    globalThis.__invalidateRoleCache = invalidateRoleCache;
  }
});

// middleware/csrf.ts
var init_csrf = __esm({
  "middleware/csrf.ts"() {
    "use strict";
  }
});

// notifications/websocket.ts
import crypto9 from "node:crypto";
function safeSocketSend(socket, data) {
  if (socket.bufferedAmount > MAX_CONNECTION_BUFFER) {
    socket.close(1013, "Slow consumer");
    return;
  }
  if (socket.readyState === 1) socket.send(data);
}
function safeSseWrite(reply, data) {
  if (reply.raw.writableLength > MAX_CONNECTION_BUFFER) {
    reply.raw.destroy();
    return;
  }
  if (!reply.raw.writableEnded) reply.raw.write(data);
}
function sendPrivate(connection, send) {
  const guard = privateGuards.get(connection);
  if (!guard) return;
  void guard().then((valid) => {
    if (valid && privateGuards.has(connection)) send();
  }).catch(() => {
  });
}
function disconnectUserWebSockets(userId, code = 4001, reason = "Session revoked") {
  for (const close of privateClosers.get(userId) || []) {
    try {
      close();
    } catch {
    }
  }
  privateClosers.delete(userId);
  for (const stream of sseStreamsMap.get(userId) || []) stream.raw.end();
  sseStreamsMap.delete(userId);
  const sockets = userWebSocketsMap.get(userId);
  if (sockets) {
    for (const ws of sockets) {
      try {
        ws.close(code, reason);
      } catch {
      }
    }
    userWebSocketsMap.delete(userId);
  }
}
async function bufferCriticalAlert(channelKey, payload) {
  if (!redisClient || !ALERT_TIER_TYPES.has(payload.type)) return;
  try {
    const key = `ekavyu:alert_buffer:${channelKey}`;
    await redisClient.rpush(key, JSON.stringify(payload));
    await redisClient.ltrim(key, -MAX_BUFFERED_ALERTS, -1);
    await redisClient.expire(key, ALERT_BUFFER_TTL_SECONDS);
  } catch (err) {
    console.warn("[Redis Alert Buffer Warning] Failed to buffer critical alert:", safeError(err));
  }
}
function sendToUserLocally(userId, payload) {
  const sseStreams = sseStreamsMap.get(userId);
  if (sseStreams && sseStreams.size > 0) {
    const dataString = `data: ${JSON.stringify(payload)}

`;
    sseStreams.forEach((reply) => {
      try {
        if (!reply.raw.writableEnded) {
          sendPrivate(reply, () => {
            if (!reply.raw.writableEnded) safeSseWrite(reply, dataString);
          });
        }
      } catch (err) {
        console.error(`[SSE Stream Error] Failed writing to user ${userId} stream:`, safeError(err));
      }
    });
  }
  const webSockets = userWebSocketsMap.get(userId);
  if (webSockets && webSockets.size > 0) {
    const wsString = JSON.stringify(payload);
    webSockets.forEach((socket) => {
      try {
        if (socket.readyState === 1) {
          sendPrivate(socket, () => {
            if (socket.readyState === 1) safeSocketSend(socket, wsString);
          });
        }
      } catch (err) {
        console.error(`[WebSocket Error] Failed writing to user ${userId} websocket:`, safeError(err));
      }
    });
  }
}
function sanitizePublicQueueMessage(payload) {
  const allowedTypes = /* @__PURE__ */ new Set([
    "QUEUE_UPDATED",
    "QUEUE_CALL_NEXT",
    "PATIENT_RECALLED_TO_CABIN",
    "QUEUE_POSITION_CHANGED",
    "QUEUE_DELAY_ALERT",
    "DOCTOR_STATUS_CHANGED",
    "QUEUE_EMERGENCY_STAT",
    "PATIENT_RETURNED"
  ]);
  if (!allowedTypes.has(payload.type)) return null;
  const data = payload.data || {};
  return {
    type: payload.type,
    timestamp: payload.timestamp,
    data: {
      tokenNumber: data.tokenNumber,
      currentToken: data.currentToken ?? data.tokenNumber,
      queueLength: data.queueLength,
      queuePosition: data.queuePosition,
      estimatedWaitTime: data.estimatedWaitTime,
      estimatedWaitMinutes: data.estimatedWaitMinutes ?? data.estimatedWaitTime,
      status: data.status,
      doctorStatus: data.doctorStatus,
      doctorName: data.doctorName,
      roomNumber: data.roomNumber
    }
  };
}
function sendToLocationQueueLocally(locationId, payload) {
  const publicPayload = sanitizePublicQueueMessage(payload);
  if (!publicPayload) return;
  const webSockets = locationQueueWebSocketsMap.get(locationId);
  if (webSockets && webSockets.size > 0) {
    const wsString = JSON.stringify(publicPayload);
    webSockets.forEach((socket) => {
      try {
        if (socket.readyState === 1) {
          safeSocketSend(socket, wsString);
        }
      } catch (err) {
        console.error(`[Queue WebSocket Error] Failed writing to location ${locationId} queue websocket:`, safeError(err));
      }
    });
  }
}
function sendToLocationClinicalLocally(locationId, payload) {
  if (locationId === CANARY_LOCATION_ID && payload.data?.isCanary === true) {
    for (const listener of syntheticClinicalObservers) listener(payload);
  }
  const webSockets = locationClinicalWebSocketsMap.get(locationId);
  if (webSockets && webSockets.size > 0) {
    const wsString = JSON.stringify(payload);
    webSockets.forEach((socket) => {
      try {
        if (socket.readyState === 1) {
          sendPrivate(socket, () => {
            if (socket.readyState === 1) safeSocketSend(socket, wsString);
          });
        }
      } catch (err) {
        console.error(`[Clinical WebSocket Error] Failed writing to location ${locationId} clinical websocket:`, safeError(err));
      }
    });
  }
}
function initRedisSubscriber() {
  if (!redisClient) return null;
  try {
    if (redisSubscriber) return redisSubscriber;
    redisSubscriber = redisClient.duplicate();
    redisSubscriber.on("error", (err) => {
      console.warn("[Redis Subscriber Warning] Redis subscriber error:", safeError(err));
    });
    const subscribeChannels = () => {
      redisSubscriber.psubscribe("user_notifications:*", "location_queue:*", "location_clinical:*", (err) => {
        if (err) {
          console.warn("[Redis Subscriber Warning] Failed psubscribe:", safeError(err));
        } else {
          console.log("[Redis Cluster Listener] Subscribed to multi-instance notification, queue, clinical & broadcast channels.");
        }
      });
    };
    redisSubscriber.on("ready", subscribeChannels);
    subscribeChannels();
    redisSubscriber.on("pmessage", (_pattern, channel, message) => {
      try {
        let envelope;
        try {
          envelope = JSON.parse(message);
        } catch {
          return;
        }
        if (envelope.originNodeId && envelope.originNodeId === NODE_ID) {
          return;
        }
        const payload = envelope.payload || envelope;
        if (channel.startsWith("user_notifications:")) {
          const userId = channel.replace("user_notifications:", "");
          sendToUserLocally(userId, payload);
        } else if (channel.startsWith("location_queue:")) {
          const locationId = channel.replace("location_queue:", "");
          sendToLocationQueueLocally(locationId, payload);
        } else if (channel.startsWith("location_clinical:")) {
          const locationId = channel.replace("location_clinical:", "");
          sendToLocationClinicalLocally(locationId, payload);
        }
      } catch (err) {
        console.error("[Redis Cluster Listener Error] Failed parsing PubSub message:", safeError(err));
      }
    });
    return redisSubscriber;
  } catch (err) {
    console.warn("[Redis Subscriber Error] Failed to initialize subscriber:", safeError(err));
    return null;
  }
}
function sanitizeLobbyQueueMessage(payload) {
  if (payload.type === "CLINICAL_PANIC_ALERT" || payload.type === "LAB_RESULTS_READY") {
    const canaryData = payload.data?.isCanary ? { isCanary: true, canaryToken: payload.data?.canaryToken } : {};
    return {
      type: "QUEUE_UPDATED",
      data: {
        appointmentId: payload.data?.appointmentId,
        tokenNumber: payload.data?.tokenNumber,
        status: "QUEUE_UPDATED",
        ...canaryData
      },
      message: payload.data?.tokenNumber ? `Status updated for Token #${payload.data.tokenNumber}` : "Queue updated",
      timestamp: payload.timestamp || (/* @__PURE__ */ new Date()).toISOString(),
      topic: payload.topic,
      transport: payload.transport
    };
  }
  if (payload.data && typeof payload.data === "object") {
    const { testName, resultValue, panicReason, referenceRange, isAbnormal, isPanic, ...safeData } = payload.data;
    return {
      ...payload,
      data: safeData
    };
  }
  return payload;
}
function broadcastQueueUpdate(locationId, rawPayload) {
  const payload = sanitizeLobbyQueueMessage(rawPayload);
  sendToLocationQueueLocally(locationId, payload);
  broadcastClinicalRealtime(locationId, payload);
  bufferCriticalAlert(`location:${locationId}`, payload);
  if (redisClient) {
    const envelope = {
      originNodeId: NODE_ID,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      payload
    };
    redisClient.publish(`location_queue:${locationId}`, JSON.stringify(envelope)).catch((err) => {
      console.warn("[Redis PubSub Warning] Failed to publish queue event to Redis:", safeError(err));
    });
  }
}
function broadcastClinicalRealtime(locationId, payload) {
  sendToLocationClinicalLocally(locationId, payload);
  bufferCriticalAlert(`location_clinical:${locationId}`, payload);
  if (redisClient) {
    const envelope = {
      originNodeId: NODE_ID,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      payload
    };
    redisClient.publish(`location_clinical:${locationId}`, JSON.stringify(envelope)).catch((err) => {
      console.warn("[Redis PubSub Warning] Failed to publish clinical broadcast to Redis:", safeError(err));
    });
  }
}
var NODE_ID, MAX_CONNECTION_BUFFER, sseStreamsMap, userWebSocketsMap, locationQueueWebSocketsMap, privateGuards, privateClosers, locationClinicalWebSocketsMap, CANARY_LOCATION_ID, syntheticClinicalObservers, ALERT_TIER_TYPES, ALERT_BUFFER_TTL_SECONDS, MAX_BUFFERED_ALERTS, redisSubscriber;
var init_websocket = __esm({
  "notifications/websocket.ts"() {
    "use strict";
    init_safeError();
    init_redis();
    init_helpers();
    init_Location();
    init_sessionResolver();
    init_permissions();
    init_csrf();
    NODE_ID = process.env.POD_NAME || process.env.HOSTNAME || `node-${crypto9.randomUUID()}`;
    MAX_CONNECTION_BUFFER = 256 * 1024;
    sseStreamsMap = /* @__PURE__ */ new Map();
    userWebSocketsMap = /* @__PURE__ */ new Map();
    locationQueueWebSocketsMap = /* @__PURE__ */ new Map();
    privateGuards = /* @__PURE__ */ new WeakMap();
    privateClosers = /* @__PURE__ */ new Map();
    locationClinicalWebSocketsMap = /* @__PURE__ */ new Map();
    CANARY_LOCATION_ID = "00000000000000000000canary";
    syntheticClinicalObservers = /* @__PURE__ */ new Set();
    ALERT_TIER_TYPES = /* @__PURE__ */ new Set([
      "CLINICAL_PANIC_ALERT",
      "QUEUE_EMERGENCY_STAT",
      "DISRUPTION_TRIAGE_REQUIRED",
      "PATIENT_RECALLED_TO_CABIN"
    ]);
    ALERT_BUFFER_TTL_SECONDS = 7200;
    MAX_BUFFERED_ALERTS = 25;
    redisSubscriber = null;
    initRedisSubscriber();
  }
});

// utilities/telemetry.ts
import * as Sentry from "@sentry/node";
function scrubTelemetry(event) {
  event.request = void 0;
  event.user = void 0;
  event.breadcrumbs = void 0;
  event.extra = void 0;
  event.contexts = void 0;
  event.logentry = void 0;
  if (event.message) event.message = "Operation failed";
  if (event.transaction) event.transaction = event.transaction.split(/[?#]/, 1)[0].replace(/\b[a-f\d]{24}\b/gi, ":id");
  for (const span of event.spans || []) {
    span.description = span.op || "operation";
    span.data = {};
  }
  for (const ex of event.exception?.values || []) {
    ex.type = safeError({ name: ex.type }).errorType;
    ex.value = "Operation failed";
    ex.stacktrace = void 0;
    ex.mechanism = void 0;
  }
  event.tags = { nodeId: NODE_ID, service: "ekavyu-backend" };
  return event;
}
async function dispatchOpsAlert(severity, title, error, context = {}) {
  const webhookUrl = process.env.OPS_ALERT_WEBHOOK_URL;
  const sanitizedMsg = safeError(error).errorType;
  const safeContext = Object.fromEntries(Object.entries(context).filter(([key, value]) => ["component", "action"].includes(key) && typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,80}$/.test(value)));
  const dedupeKey = `${severity}:${title}:${sanitizedMsg}`;
  const now = Date.now();
  const lastSent = recentAlertTimestamps.get(dedupeKey) || 0;
  if (now - lastSent < DEDUPE_WINDOW_MS) {
    return;
  }
  for (const [key, timestamp] of recentAlertTimestamps) {
    if (now - timestamp >= DEDUPE_WINDOW_MS) recentAlertTimestamps.delete(key);
  }
  if (recentAlertTimestamps.size >= 1e3) recentAlertTimestamps.delete(recentAlertTimestamps.keys().next().value);
  recentAlertTimestamps.set(dedupeKey, now);
  const payload = {
    severity,
    title,
    message: sanitizedMsg,
    nodeId: NODE_ID,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    environment: process.env.NODE_ENV || "development",
    context: safeContext
  };
  if (severity === "P0_CRITICAL") {
    console.error(`\u{1F6A8} [${severity}] ${title}: ${sanitizedMsg}`);
  } else {
    console.warn(`\u26A0\uFE0F [${severity}] ${title}: ${sanitizedMsg}`);
  }
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5e3)
      });
    } catch (err) {
      console.warn("[Telemetry Warning] Failed to dispatch ops alert webhook:", safeError(err));
    }
  }
  if (sentryDsn && typeof error !== "string") {
    Sentry.withScope((scope) => {
      scope.setLevel(severity === "P0_CRITICAL" ? "fatal" : "warning");
      scope.setTags({ severity, ...safeContext });
      Sentry.captureException(error);
    });
  }
}
async function reportCriticalError(title, error, context) {
  await dispatchOpsAlert("P0_CRITICAL", title, error, context);
}
var sentryDsn, recentAlertTimestamps, DEDUPE_WINDOW_MS;
var init_telemetry = __esm({
  "utilities/telemetry.ts"() {
    "use strict";
    init_safeError();
    init_websocket();
    sentryDsn = process.env.SENTRY_DSN;
    if (sentryDsn) {
      Sentry.init({
        dsn: sentryDsn,
        environment: process.env.NODE_ENV || "development",
        tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1,
        // Preserve beforeSendTransaction so every transaction reaches the
        // healthcare data minimizer instead of using v11's streamed-span default.
        traceLifecycle: "static",
        // Sentry v11 collects broader request data by default. Keep the former
        // sendDefaultPii: false posture explicitly for healthcare telemetry.
        dataCollection: {
          userInfo: false,
          cookies: false,
          httpHeaders: false,
          httpBodies: [],
          urlQueryParams: false,
          genAI: { inputs: false, outputs: false },
          databaseQueryData: false,
          queues: false,
          graphQL: { document: false, variables: false }
        },
        beforeSend: scrubTelemetry,
        beforeSendTransaction: scrubTelemetry
      });
      console.log("[Telemetry] Sentry initialized with minimized request/span data.");
    } else {
      console.log("[Telemetry] SENTRY_DSN not configured. Local telemetry fallback active.");
    }
    recentAlertTimestamps = /* @__PURE__ */ new Map();
    DEDUPE_WINDOW_MS = 6e4;
  }
});

// utilities/auditLock.ts
import { AsyncLocalStorage as AsyncLocalStorage2 } from "node:async_hooks";
async function withInMemoryQueue(key, operation) {
  while (inMemoryChainLocks.has(key)) {
    try {
      await inMemoryChainLocks.get(key);
    } catch {
    }
  }
  let release;
  const lockPromise = new Promise((resolve) => {
    release = resolve;
  });
  inMemoryChainLocks.set(key, lockPromise);
  try {
    return await operation();
  } finally {
    inMemoryChainLocks.delete(key);
    release();
  }
}
async function withChainLock(key, operation) {
  const heldLocks = activeLocks.getStore();
  if (heldLocks && heldLocks.has(key)) {
    return await operation();
  }
  const runWithContext = async () => {
    const nextLocks = new Set(heldLocks || []);
    nextLocks.add(key);
    return await activeLocks.run(nextLocks, operation);
  };
  const isRedisReady = redisClient && redisClient.status === "ready";
  const lockKey = `lock:audit_chain:${key}`;
  const lockToken = `tok_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  const LOCK_TTL_SECONDS = 10;
  if (isRedisReady && redisClient) {
    let acquired = false;
    const maxWaitMs = 6e3;
    const startTime = Date.now();
    while (!acquired && Date.now() - startTime < maxWaitMs) {
      try {
        const res = await redisClient.set(lockKey, lockToken, "EX", LOCK_TTL_SECONDS, "NX");
        if (res === "OK") {
          acquired = true;
          break;
        }
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
    }
    if (acquired) {
      try {
        return await withInMemoryQueue(key, runWithContext);
      } finally {
        const unlockScript = `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
          else
            return 0
          end
        `;
        try {
          await redisClient?.eval(unlockScript, 1, lockKey, lockToken);
        } catch {
        }
      }
    }
  }
  return withInMemoryQueue(key, runWithContext);
}
var activeLocks, inMemoryChainLocks;
var init_auditLock = __esm({
  "utilities/auditLock.ts"() {
    "use strict";
    init_redis();
    activeLocks = new AsyncLocalStorage2();
    inMemoryChainLocks = /* @__PURE__ */ new Map();
  }
});

// services/AuditTrailService.ts
var AuditTrailService_exports = {};
__export(AuditTrailService_exports, {
  recordAuditLog: () => recordAuditLog,
  verifyAuditChainIntegrity: () => verifyAuditChainIntegrity,
  withChainLock: () => withChainLock
});
import mongoose26 from "mongoose";
import crypto10 from "node:crypto";
async function recordAuditLog(input, options) {
  if (input.organizationId === void 0 && requestContextStore.getStore()?.organizationId) input = { ...input, organizationId: requestContextStore.getStore().organizationId };
  const orgKey = input.organizationId ? String(input.organizationId) : "GLOBAL";
  const inherited = options?.session || mongoose26.transactionAsyncLocalStorage?.getStore()?.session;
  const append = async (session) => {
    const opts = session ? { session } : {};
    const orgFilter = input.organizationId ? new mongoose26.Types.ObjectId(String(input.organizationId)) : null;
    let head = await AuditChainHead.findById(orgKey, null, opts);
    if (!head) {
      const last = await AuditLog.findOne({ organizationId: orgFilter }, null, opts).sort({ sequence: -1 }).select("sequence hash").lean();
      try {
        head = await new AuditChainHead({ _id: orgKey, sequence: last?.sequence || 0, hash: last?.hash || GENESIS_HASH }).save(opts);
      } catch (error) {
        if (session && error.code === 11e3) error.addErrorLabel?.("TransientTransactionError");
        throw error;
      }
    }
    const sequence = head.sequence + 1;
    const createdAt = input.createdAt || /* @__PURE__ */ new Date();
    const details = redactAuditDetails(input.details);
    const category = input.category || "CLINICAL_WRITE";
    const hash = computeAuditHash({ ...input, organizationId: orgFilter, sequence, prevHash: head.hash, createdAt, details, category });
    const advanced = await AuditChainHead.updateOne({ _id: orgKey, sequence: head.sequence, hash: head.hash }, { $set: { sequence, hash } }, opts);
    if (!advanced.modifiedCount) throw Object.assign(new Error("Audit chain conflict"), { errorLabels: ["TransientTransactionError"], hasErrorLabel: (label) => label === "TransientTransactionError" });
    return new AuditLog({ ...input, organizationId: orgFilter, sequence, prevHash: head.hash, hash, createdAt, details, category }).save(opts);
  };
  if (inherited) return append(inherited);
  const topology = mongoose26.connection.client?.topology?.description?.type;
  if (topology === "Single" || topology === "Unknown") {
    if (process.env.NODE_ENV === "production") throw new Error("Audit append requires a transaction-capable MongoDB deployment");
    return withChainLock(orgKey, () => append(null));
  }
  return withTransaction(append);
}
async function verifyAuditChainIntegrity(organizationId) {
  const orgFilter = organizationId ? { organizationId: new mongoose26.Types.ObjectId(organizationId) } : { organizationId: null };
  const logs = await AuditLog.find(orgFilter).sort({ sequence: 1 }).lean();
  if (logs.length === 0) {
    return {
      intact: true,
      verifiedCount: 0,
      message: "No audit records found for verification"
    };
  }
  let expectedSeq = 1;
  let expectedPrevHash = GENESIS_HASH;
  if (logs[0].sequence && logs[0].sequence > 1) {
    const checkpointOrgFilter = organizationId ? { organizationId: new mongoose26.Types.ObjectId(organizationId) } : { organizationId: null };
    const checkpoint = await AuditCheckpoint.findOne(checkpointOrgFilter).sort({ archivedUpToSequence: -1 }).lean();
    if (checkpoint) {
      if (checkpoint.signature && checkpoint.checkpointHash) {
        const secretKey = process.env.ENCRYPTION_SECRET || process.env.JWT_SECRET || "ekavyu-audit-anchor-secret";
        const expectedSig = crypto10.createHmac("sha256", secretKey).update(checkpoint.checkpointHash).digest("hex");
        if (expectedSig !== checkpoint.signature) {
          await reportCriticalError(
            "AUDIT_CHECKPOINT_TAMPERED",
            `Audit checkpoint signature mismatch for org ${organizationId || "system"}!`,
            { component: "AuditTrailService", checkpointId: String(checkpoint._id) }
          );
        }
      }
      expectedSeq = checkpoint.archivedUpToSequence + 1;
      expectedPrevHash = checkpoint.archivedUpToHash;
    }
  }
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    if (log.sequence !== expectedSeq) {
      const failure = {
        intact: false,
        reason: "SEQUENCE_GAP",
        failedAtSequence: log.sequence ?? -1,
        logId: String(log._id),
        expected: expectedSeq,
        actual: log.sequence,
        verifiedCount: i
      };
      await reportCriticalError(
        "AUDIT_CHAIN_INTEGRITY_BREACH",
        `Audit trail gap detected! Expected sequence #${expectedSeq} but found #${log.sequence}`,
        { component: "AuditTrailService", logId: String(log._id) }
      );
      return failure;
    }
    if (log.prevHash !== expectedPrevHash) {
      const failure = {
        intact: false,
        reason: "PREV_HASH_MISMATCH",
        failedAtSequence: log.sequence,
        logId: String(log._id),
        expected: expectedPrevHash,
        actual: log.prevHash,
        verifiedCount: i
      };
      await reportCriticalError(
        "AUDIT_CHAIN_INTEGRITY_BREACH",
        `Audit trail previous hash mismatch at sequence #${log.sequence}! Expected ${expectedPrevHash.slice(0, 12)}... but found ${String(log.prevHash).slice(0, 12)}...`,
        { component: "AuditTrailService", logId: String(log._id) }
      );
      return failure;
    }
    const computedHash = computeAuditHash({
      sequence: log.sequence,
      prevHash: log.prevHash,
      organizationId: log.organizationId,
      userId: log.userId,
      action: log.action,
      category: log.category,
      targetId: log.targetId,
      targetModel: log.targetModel,
      details: log.details,
      createdAt: log.createdAt
    });
    if (log.hash !== computedHash) {
      const failure = {
        intact: false,
        reason: "HASH_TAMPERED",
        failedAtSequence: log.sequence,
        logId: String(log._id),
        expected: computedHash,
        actual: log.hash,
        verifiedCount: i
      };
      await reportCriticalError(
        "AUDIT_CHAIN_INTEGRITY_BREACH",
        `Audit trail record #${log.sequence} has been altered! Computed hash does not match stored hash.`,
        { component: "AuditTrailService", logId: String(log._id) }
      );
      return failure;
    }
    expectedPrevHash = log.hash;
    expectedSeq = log.sequence + 1;
  }
  return {
    intact: true,
    verifiedCount: logs.length,
    firstSequence: logs[0].sequence,
    lastSequence: logs[logs.length - 1].sequence,
    lastHash: logs[logs.length - 1].hash
  };
}
var init_AuditTrailService = __esm({
  "services/AuditTrailService.ts"() {
    "use strict";
    init_AuditLog();
    init_AuditCheckpoint();
    init_AuditChainHead();
    init_transaction();
    init_auditCrypto();
    init_auditRedaction();
    init_context();
    init_telemetry();
    init_auditLock();
  }
});

// models/AuditLog.ts
import mongoose27, { Schema as Schema21 } from "mongoose";
var AuditLogSchema, AuditLog;
var init_AuditLog = __esm({
  "models/AuditLog.ts"() {
    "use strict";
    init_auditRedaction();
    AuditLogSchema = new Schema21({
      userId: { type: Schema21.Types.ObjectId, ref: "User", index: true },
      organizationId: { type: Schema21.Types.ObjectId, ref: "Organization", default: null },
      action: { type: String, required: true, index: true },
      // e.g. "APPOINTMENT_CREATE", "VIP_OVERRIDE", "PHI_READ_ACCESS", "DPDP_PII_ANONYMIZED"
      targetId: { type: Schema21.Types.ObjectId },
      targetModel: { type: String },
      // "Appointment", "ClinicalNote", "Patient", "DataBreachIncident"
      category: {
        type: String,
        enum: ["AUTH", "CLINICAL_READ", "CLINICAL_WRITE", "BILLING", "ADMIN", "COMPLIANCE_DPDP"],
        default: "CLINICAL_WRITE",
        index: true
      },
      ipAddress: { type: String, trim: true },
      userAgent: { type: String, trim: true },
      details: { type: Schema21.Types.Mixed },
      sequence: { type: Number, index: true },
      prevHash: { type: String, index: true },
      hash: { type: String, index: true },
      createdAt: { type: Date, default: Date.now }
    });
    AuditLogSchema.index({ organizationId: 1, createdAt: -1 });
    AuditLogSchema.index({ organizationId: 1, sequence: 1 }, { unique: true });
    AuditLogSchema.index({ category: 1, createdAt: -1 });
    AuditLogSchema.index({ organizationId: 1, category: 1, createdAt: -1 });
    AuditLogSchema.pre("validate", function() {
      this.details = redactAuditDetails(this.details);
    });
    AuditLogSchema.pre("save", async function() {
      if (this.isNew && (!this.sequence || !this.hash)) throw new Error("Use AuditLog.create or recordAuditLog to append an audit entry");
    });
    AuditLogSchema.virtual("id").get(function() {
      return this._id.toHexString();
    });
    AuditLogSchema.set("toJSON", {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString();
        ret.details = redactAuditDetails(ret.details);
        if (ret.userId && typeof ret.userId === "object") {
          ret.userId = {
            id: String(ret.userId._id || ret.userId.id),
            role: ret.userId.role
          };
        }
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    });
    AuditLog = mongoose27.models.AuditLog || mongoose27.model("AuditLog", AuditLogSchema);
    AuditLog.create = async function(documents, options) {
      const { recordAuditLog: recordAuditLog2 } = await Promise.resolve().then(() => (init_AuditTrailService(), AuditTrailService_exports));
      if (Array.isArray(documents)) {
        const results = [];
        for (const document of documents) results.push(await recordAuditLog2(document, options));
        return results;
      }
      return recordAuditLog2(documents, options);
    };
  }
});

// models/FamilyRelationship.ts
var FamilyRelationship_exports = {};
__export(FamilyRelationship_exports, {
  FamilyRelationship: () => FamilyRelationship
});
import mongoose28, { Schema as Schema22 } from "mongoose";
var FamilyRelationshipSchema, FamilyRelationship;
var init_FamilyRelationship = __esm({
  "models/FamilyRelationship.ts"() {
    "use strict";
    FamilyRelationshipSchema = new Schema22(
      {
        userId: { type: Schema22.Types.ObjectId, ref: "User", required: true, index: true },
        patientId: { type: Schema22.Types.ObjectId, ref: "Patient", required: true, index: true },
        relationship: {
          type: String,
          enum: ["self", "mother", "father", "son", "daughter", "spouse", "guardian", "other"],
          required: true
        },
        status: { type: String, enum: ["active", "pending", "revoked"], default: "active" },
        identityClaim: { type: Boolean, default: false },
        reviewedBy: { type: Schema22.Types.ObjectId, ref: "User" },
        reviewedAt: Date,
        reviewReason: { type: String, maxlength: 500 },
        // Booking relationships alone do not authorize consent or data-rights actions.
        consentAuthority: { type: Boolean, default: false },
        dataRightsAuthority: { type: Boolean, default: false },
        authorityRevision: { type: Number, default: 0 },
        authorityUseRevision: { type: Number, default: 0 },
        // Separate, attributable authority for one organization. Legacy global flags
        // are retained for compatibility but never authorize the new privacy policy.
        organizationAuthorizations: [{
          _id: false,
          organizationId: { type: Schema22.Types.ObjectId, ref: "Organization", required: true },
          communication: { type: Boolean, default: false },
          consent: { type: Boolean, default: false },
          dataRights: { type: Boolean, default: false },
          revision: { type: Number, default: 0 },
          reviewedBy: { type: Schema22.Types.ObjectId, ref: "User", required: true },
          reviewedAt: { type: Date, required: true }
        }]
      },
      { timestamps: true }
    );
    FamilyRelationshipSchema.index({ userId: 1, patientId: 1 }, { unique: true });
    FamilyRelationship = mongoose28.models.FamilyRelationship || mongoose28.model("FamilyRelationship", FamilyRelationshipSchema);
  }
});

// models/OperationReceipt.ts
import mongoose29, { Schema as Schema23 } from "mongoose";
var schema5, OperationReceipt;
var init_OperationReceipt = __esm({
  "models/OperationReceipt.ts"() {
    "use strict";
    init_cryptoEnvelope();
    schema5 = new Schema23({
      scope: { type: String, required: true },
      key: { type: String, required: true },
      requestHash: { type: String, required: true },
      resultId: { type: Schema23.Types.ObjectId },
      responseCiphertext: { type: String, select: false, set: encryptField },
      createdAt: { type: Date, default: Date.now }
    });
    schema5.index({ scope: 1, key: 1 }, { unique: true });
    OperationReceipt = mongoose29.models.OperationReceipt || mongoose29.model("OperationReceipt", schema5);
  }
});

// services/CommandReceiptService.ts
import crypto11 from "node:crypto";
import mongoose30 from "mongoose";
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function commandHash(payload) {
  return crypto11.createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
}
async function executeRecordedCommand(scope, key, payload, write, transactionOptions) {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(400, "A valid request identifier is required");
  const requestHash = commandHash(payload);
  for (let attempt = 0; attempt < 3; attempt++) {
    const prior = await OperationReceipt.findOne({ scope, key }).lean();
    if (prior) {
      if (prior.requestHash !== requestHash) throw new CommandError(409, "This request identifier was used with different details. Start a new command.");
      if (!prior.resultId) throw new CommandError(409, "The command is still being processed. Retry the same request.");
      return { resultId: String(prior.resultId), replayed: true };
    }
    const topology = mongoose30.connection?.client?.topology?.description?.type;
    if (topology === "Single" || topology === "Unknown") throw new CommandError(503, "This workflow requires a transaction-capable MongoDB replica set");
    try {
      const resultId = await withTransaction(async () => {
        await OperationReceipt.create({ scope, key, requestHash });
        const id = await write();
        await OperationReceipt.updateOne({ scope, key, requestHash }, { $set: { resultId: id } });
        return id;
      }, transactionOptions);
      return { resultId, replayed: false };
    } catch (error) {
      if (error?.code === 11e3 && attempt < 2) continue;
      throw error;
    }
  }
  throw new CommandError(409, "Concurrent command conflict. Retry the same request.");
}
var CommandError;
var init_CommandReceiptService = __esm({
  "services/CommandReceiptService.ts"() {
    "use strict";
    init_OperationReceipt();
    init_transaction();
    CommandError = class extends Error {
      statusCode;
      details;
      constructor(statusCode, message, details) {
        super(message);
        this.statusCode = statusCode;
        this.details = details;
      }
    };
  }
});

// services/FamilyAuthorityService.ts
function familyAuthorization(relationship, organizationId) {
  return relationship?.organizationAuthorizations?.find((row) => String(row.organizationId) === organizationId);
}
async function authorizedFamilyRelationship(patientId, organizationId, purpose, filter = {}) {
  const relationship = await FamilyRelationship.findOne({ ...filter, patientId, status: "active", organizationAuthorizations: { $elemMatch: { organizationId, [purpose]: true, reviewedBy: { $type: "objectId" }, reviewedAt: { $type: "date" } } } }).lean();
  if (!relationship || !await User.exists({ _id: relationship.userId, isActive: true, role: { $in: ["patient", "family_member"] } })) return null;
  return relationship;
}
async function organizationCommunicationRecipient(patientId, organizationId) {
  const patient = await getOrganizationPatient(patientId, organizationId);
  if (!patient) throw new CommandError(404, "Patient not found in this organization");
  const relationship = await PatientRelationship.findOne({ patientId, organizationId, status: "active" }).lean();
  if (relationship?.contact?.recipientType === "family") {
    const family = relationship.contact.familyRelationshipId && await authorizedFamilyRelationship(patientId, organizationId, "communication", { _id: relationship.contact.familyRelationshipId });
    if (!family) return { phone: "", email: "", recipientType: "family", available: false, doNotContact: true, familyRelationshipId: String(relationship.contact.familyRelationshipId || "") };
    const user = await User.findById(family.userId).select("phone email name").lean();
    return { phone: user?.phone || "", email: user?.email || "", userId: String(family.userId), recipientType: "family", familyRelationshipId: String(family._id), familyAuthorityRevision: familyAuthorization(family, organizationId).revision, available: !["unreachable", "invalid"].includes(relationship.contact.availability), doNotContact: relationship.preferences?.doNotContact === true };
  }
  return { phone: relationship?.contact?.phone ?? patient.phone ?? patient.userId?.phone ?? "", email: relationship?.contact?.email ?? patient.email ?? patient.userId?.email ?? "", userId: patient.userId?._id?.toString(), recipientType: "patient", available: !["unreachable", "invalid"].includes(relationship?.contact?.availability), doNotContact: relationship?.preferences?.doNotContact === true };
}
var init_FamilyAuthorityService = __esm({
  "services/FamilyAuthorityService.ts"() {
    "use strict";
    init_FamilyRelationship();
    init_User();
    init_PatientRelationship();
    init_PatientRecordAccessService();
    init_CommandReceiptService();
  }
});

// services/PatientConsentService.ts
async function consentRecipientHash(patientId, organizationId, purpose) {
  const patient = await getOrganizationPatient(patientId, organizationId);
  if (!patient) throw new CommandError(404, "Patient not found in this organization");
  const selected = await organizationCommunicationRecipient(patientId, organizationId);
  const phone = selected.phone, email = selected.email;
  const recipient = purpose === "COMMUNICATION_EMAIL" ? email : purpose === "AI_CLINICAL_ASSISTANCE" ? patientId : phone;
  const familyBinding = purpose !== "AI_CLINICAL_ASSISTANCE" && selected.recipientType === "family" ? `:family:${selected.familyRelationshipId}:${selected.familyAuthorityRevision}` : "";
  return recipient ? computeBlindIndex(`${organizationId}:${patientId}:${purpose}:${recipient}${familyBinding}`) : "";
}
async function getPatientConsents(patientId, organizationId) {
  const doc = await DPDPConsent.findOne({ patientId, organizationId }).lean();
  const purposes = await Promise.all(DPDP_PURPOSES.map(async (purpose) => {
    const row = doc?.purposes.find((entry) => entry.purpose === purpose);
    const evidence = row?.evidence;
    const recipientHash = await consentRecipientHash(patientId, organizationId, purpose);
    const delegation = evidence?.familyRelationshipId ? await authorizedFamilyRelationship(patientId, organizationId, "consent", { _id: evidence.familyRelationshipId, userId: evidence.recordedBy }) : null;
    const delegationValid = !evidence?.familyRelationshipId || !!delegation && familyAuthorization(delegation, organizationId).revision === evidence.familyAuthorityRevision;
    const activityValid = !!evidence?.activityId && !!await CrmActivity.exists({ _id: evidence.activityId, organizationId, patientId, visibility: "consent", actorId: evidence.recordedBy });
    const evidenced = !!(evidence?.noticeVersion === CONSENT_NOTICE_VERSION && evidence?.method && evidence?.recordedBy && evidence?.recordedAt && activityValid && delegationValid);
    const validRecipient = !!recipientHash && evidence?.recipientHash === recipientHash;
    const status = row?.status === "WITHDRAWN" ? "WITHDRAWN" : row?.status === "GRANTED" && evidenced && validRecipient ? "GRANTED" : "UNKNOWN";
    return { purpose, status, updatedAt: row?.updatedAt, reviewRequired: row?.status === "GRANTED" && status === "UNKNOWN" };
  }));
  return { patientId, organizationId, revision: doc?.revision || 0, noticeVersion: CONSENT_NOTICE_VERSION, purposes };
}
var CONSENT_NOTICE_VERSION;
var init_PatientConsentService = __esm({
  "services/PatientConsentService.ts"() {
    "use strict";
    init_DPDPConsent();
    init_CrmActivity();
    init_AuditLog();
    init_FamilyAuthorityService();
    init_PatientRecordAccessService();
    init_cryptoEnvelope();
    init_CommandReceiptService();
    CONSENT_NOTICE_VERSION = "communication-choices-2026-10-v1";
  }
});

// models/DoctorAssignment.ts
import mongoose31, { Schema as Schema24 } from "mongoose";
var DoctorAssignmentSchema, DoctorAssignment;
var init_DoctorAssignment = __esm({
  "models/DoctorAssignment.ts"() {
    "use strict";
    DoctorAssignmentSchema = new Schema24({
      doctorId: { type: Schema24.Types.ObjectId, ref: "User", required: true, index: true },
      locationId: { type: Schema24.Types.ObjectId, ref: "Location", required: true, index: true },
      organizationId: { type: Schema24.Types.ObjectId, ref: "Organization", required: true, index: true },
      workingHours: { type: String, required: true },
      // JSON schedule slots string
      fees: { type: Number, default: 0 },
      feeType: { type: String, enum: ["fixed", "post_consultation", "free"], default: "fixed" },
      appointmentDuration: { type: Number, default: 15 },
      // minutes
      bookingMode: { type: String, enum: ["time_slot", "sequential_queue"], default: "sequential_queue" },
      maxDailyTokens: { type: Number, default: null },
      paymentRequired: { type: Boolean, default: false },
      allowPayAtLocation: { type: Boolean, default: true },
      onlineBookingSafetyBuffer: { type: Number, default: 30 },
      // Minutes before shift end when online same-day booking closes
      cabinNumber: { type: String, default: "Cabin 1" },
      isActive: { type: Boolean, default: true },
      assignmentRevision: { type: Number, default: 0 },
      recoveryScanRevision: { type: Number, default: 0 },
      createdAt: { type: Date, default: Date.now }
    });
    DoctorAssignmentSchema.index({ doctorId: 1, locationId: 1 }, { unique: true });
    DoctorAssignmentSchema.virtual("id").get(function() {
      return this._id.toHexString();
    });
    DoctorAssignmentSchema.set("toJSON", {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    });
    DoctorAssignment = mongoose31.model("DoctorAssignment", DoctorAssignmentSchema);
  }
});

// models/Receptionist.ts
import mongoose32, { Schema as Schema25 } from "mongoose";
var ReceptionistSchema, Receptionist;
var init_Receptionist = __esm({
  "models/Receptionist.ts"() {
    "use strict";
    ReceptionistSchema = new Schema25({
      userId: { type: Schema25.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
      organizationId: { type: Schema25.Types.ObjectId, ref: "Organization", required: true, index: true },
      locationId: { type: Schema25.Types.ObjectId, ref: "Location", index: true },
      shift: { type: String }
    });
    ReceptionistSchema.virtual("id").get(function() {
      return this._id.toHexString();
    });
    ReceptionistSchema.set("toJSON", {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    });
    Receptionist = mongoose32.model("Receptionist", ReceptionistSchema);
  }
});

// services/LocationAccessService.ts
async function resolveStaffLocationGrant(userId, organizationId, role, strict = false) {
  const member = await OrgMember.findOne({ userId, organizationId }).select("role locationAccess").lean();
  if (member && member.role !== role) return [];
  if (strict && !member) return [];
  const ownedLocations = async (ids) => (await Location.find({
    _id: { $in: ids },
    organizationId,
    isActive: { $ne: false }
  }).select("_id").lean()).map((location2) => String(location2._id));
  if (member?.locationAccess) {
    if (member.locationAccess.mode === "all") return void 0;
    return ownedLocations([...new Set((member.locationAccess.locationIds || []).map(String))]);
  }
  if (member && role === "admin") return void 0;
  if (role === "doctor") {
    const assignments = await DoctorAssignment.find({ doctorId: userId, organizationId, isActive: true }).select("locationId").lean();
    return ownedLocations([...new Set(assignments.map((assignment) => String(assignment.locationId)))]);
  }
  if (role === "receptionist") {
    const profile = await Receptionist.findOne({ userId, organizationId }).select("locationId").lean();
    return profile?.locationId ? ownedLocations([String(profile.locationId)]) : [];
  }
  return [];
}
var init_LocationAccessService = __esm({
  "services/LocationAccessService.ts"() {
    "use strict";
    init_OrgMember();
    init_DoctorAssignment();
    init_Receptionist();
    init_Location();
  }
});

// models/WhatsAppRecipient.ts
import mongoose33, { Schema as Schema26 } from "mongoose";
var schema6, WhatsAppRecipient;
var init_WhatsAppRecipient = __esm({
  "models/WhatsAppRecipient.ts"() {
    "use strict";
    schema6 = new Schema26({
      scope: { type: String, required: true },
      phoneHash: { type: String, required: true },
      optedOut: { type: Boolean, default: false },
      lastInboundAt: Date,
      lastPreferenceAt: Date
    }, { timestamps: true });
    schema6.index({ scope: 1, phoneHash: 1 }, { unique: true });
    WhatsAppRecipient = mongoose33.model("WhatsAppRecipient", schema6);
  }
});

// models/WhatsAppTemplate.ts
import mongoose34, { Schema as Schema27 } from "mongoose";
var schema7, WhatsAppTemplate;
var init_WhatsAppTemplate = __esm({
  "models/WhatsAppTemplate.ts"() {
    "use strict";
    schema7 = new Schema27({
      scope: { type: String, required: true },
      metaId: String,
      name: { type: String, required: true },
      language: { type: String, required: true },
      status: String,
      category: String,
      components: Schema27.Types.Mixed,
      lastMetaEventAt: Date
    }, { timestamps: true });
    schema7.index({ scope: 1, name: 1, language: 1 }, { unique: true });
    WhatsAppTemplate = mongoose34.model("WhatsAppTemplate", schema7);
  }
});

// utilities/concurrencyBudget.ts
import crypto12 from "node:crypto";
async function withConcurrencyBudget(scope, limit, work) {
  const key = `budget:${scope}`;
  const token = crypto12.randomUUID();
  const shared = redisClient?.status === "ready";
  if (!shared && process.env.NODE_ENV === "production") throw Object.assign(new Error("Concurrency coordination unavailable"), { statusCode: 503 });
  const count = local.get(key) || 0;
  const admitted = shared ? await redisClient.eval(acquire, 1, key, Date.now(), Date.now() + leaseMs, Math.max(1, limit), token) : count < limit ? 1 : 0;
  if (!admitted) throw Object.assign(new Error("Operation capacity reached; retry shortly"), { statusCode: 429 });
  if (!shared) local.set(key, count + 1);
  const heartbeat = shared ? setInterval(() => {
    void redisClient.eval("if redis.call('ZSCORE', KEYS[1], ARGV[1]) then redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1]); redis.call('PEXPIRE', KEYS[1], 120000); end", 1, key, token, Date.now() + leaseMs).catch(() => console.error("Concurrency lease renewal failed"));
  }, 15e3) : void 0;
  heartbeat?.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(heartbeat);
    if (shared) await redisClient.zrem(key, token).catch(() => {
    });
    else {
      const remaining = (local.get(key) || 1) - 1;
      if (remaining) local.set(key, remaining);
      else local.delete(key);
    }
  }
}
var local, leaseMs, acquire;
var init_concurrencyBudget = __esm({
  "utilities/concurrencyBudget.ts"() {
    "use strict";
    init_redis();
    local = /* @__PURE__ */ new Map();
    leaseMs = 6e4;
    acquire = `redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1]); if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end; redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4]); redis.call('PEXPIRE', KEYS[1], 120000); return 1`;
  }
});

// models/WhatsAppAccount.ts
import mongoose35, { Schema as Schema28 } from "mongoose";
var schema8, WhatsAppAccount;
var init_WhatsAppAccount = __esm({
  "models/WhatsAppAccount.ts"() {
    "use strict";
    schema8 = new Schema28({
      key: { type: String, unique: true, default: "platform" },
      enabled: { type: Boolean, default: false },
      wabaId: String,
      phoneNumberId: String,
      accessToken: { type: String, select: false },
      appSecret: { type: String, select: false },
      verifyToken: { type: String, select: false },
      connectionStatus: { type: String, default: "disconnected" },
      verifiedAt: Date,
      lastError: String,
      phoneDisplay: String
    }, { timestamps: true });
    WhatsAppAccount = mongoose35.model("WhatsAppAccount", schema8);
  }
});

// services/WhatsAppAccountService.ts
async function getPlatformAccount() {
  const saved = await WhatsAppAccount.findOne({ key: "platform" }).select("+accessToken +appSecret +verifyToken");
  if (saved) return { ...saved.toObject(), accessToken: decryptField(saved.accessToken), appSecret: decryptField(saved.appSecret), verifyToken: decryptField(saved.verifyToken) };
  const accessToken = process.env.META_WHATSAPP_ACCESS_TOKEN;
  return {
    enabled: !!accessToken,
    wabaId: process.env.META_WHATSAPP_WABA_ID,
    phoneNumberId: process.env.META_WHATSAPP_PHONE_NUMBER_ID,
    accessToken,
    appSecret: process.env.META_WHATSAPP_APP_SECRET,
    verifyToken: process.env.META_WHATSAPP_VERIFY_TOKEN,
    connectionStatus: "disconnected"
  };
}
async function resolveWhatsAppAccount(organizationId) {
  const org = organizationId ? await Organization.findById(organizationId).select(secretProjection) : null;
  if (organizationId && !org) throw new Error("ORGANIZATION_NOT_FOUND");
  if (org?.whatsappConfig?.mode === "disabled") throw new Error("WHATSAPP_DISABLED_FOR_ORGANIZATION");
  if (org?.whatsappConfig?.mode === "dedicated") {
    const config = org.whatsappConfig;
    return { ...org.toObject().whatsappConfig, scope: organizationId, organizationId, accessToken: decryptField(config.accessToken), appSecret: decryptField(config.appSecret), verifyToken: decryptField(config.verifyToken) };
  }
  return { ...await getPlatformAccount(), scope: "platform", organizationId };
}
async function recordWhatsAppCredentialError(account, errorCode) {
  if (errorCode !== 190) return;
  const fields = { connectionStatus: "error", lastError: "META_ERROR_190: Reconnect with a valid system-user token" };
  if (account.scope === "platform") await WhatsAppAccount.updateOne({ key: "platform" }, { $set: fields });
  else await Organization.updateOne({ _id: account.scope }, { $set: { "whatsappConfig.connectionStatus": fields.connectionStatus, "whatsappConfig.lastError": fields.lastError } });
}
var secretProjection;
var init_WhatsAppAccountService = __esm({
  "services/WhatsAppAccountService.ts"() {
    "use strict";
    init_Organization();
    init_WhatsAppAccount();
    init_cryptoEnvelope();
    secretProjection = "+whatsappConfig.accessToken +whatsappConfig.appSecret +whatsappConfig.verifyToken";
  }
});

// services/WhatsAppCloudApiService.ts
import crypto13 from "node:crypto";
var WhatsAppCloudApiService, whatsAppCloudApiService;
var init_WhatsAppCloudApiService = __esm({
  "services/WhatsAppCloudApiService.ts"() {
    "use strict";
    init_concurrencyBudget();
    init_scalability();
    init_WhatsAppAccountService();
    WhatsAppCloudApiService = class {
      formatPhoneNumber(phone) {
        let digits = String(phone || "").replace(/\D/g, "");
        if (digits.length === 10 && !String(phone || "").trim().startsWith("+")) digits = `91${digits}`;
        return digits;
      }
      async request(path3, credentials, method = "GET", body) {
        return withConcurrencyBudget("whatsapp-provider", MAX_WHATSAPP_CONCURRENCY, () => this.requestBounded(path3, credentials, method, body));
      }
      async requestBounded(path3, credentials, method = "GET", body) {
        if (!/^[A-Za-z0-9_/?=&%,.-]+$/.test(path3) || path3.includes("..")) throw new Error("INVALID_GRAPH_PATH");
        const version = process.env.WHATSAPP_API_VERSION || "v25.0";
        if (!/^v\d+\.\d+$/.test(version)) throw new Error("INVALID_GRAPH_VERSION");
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15e3);
        try {
          const response = await fetch(`https://graph.facebook.com/${version}/${path3}`, {
            method,
            headers: { Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": "application/json" },
            body: body === void 0 ? void 0 : JSON.stringify(body),
            signal: controller.signal
          });
          const data = await response.json();
          if (!response.ok) {
            const error = new Error(`META_ERROR_${data?.error?.code || response.status}`);
            error.code = data?.error?.code || response.status;
            throw error;
          }
          return data;
        } finally {
          clearTimeout(timeout);
        }
      }
      async send(to, content, credentials) {
        const phone = this.formatPhoneNumber(to);
        if (!/^[1-9]\d{7,14}$/.test(phone)) return { success: false, status: "failed", errorReason: "INVALID_PHONE" };
        const account = credentials || await getPlatformAccount();
        if (process.env.NODE_ENV === "test" || process.env.WHATSAPP_SANDBOX_MODE === "true" && process.env.NODE_ENV !== "production") {
          return { success: true, status: "accepted", providerMessageId: `wamid.sandbox.${crypto13.randomUUID()}`, rawResponse: { mode: "sandbox" } };
        }
        if (account.enabled === false || !account.phoneNumberId || !account.accessToken || !account.appSecret || account.accessToken === "[DECRYPTION_FAILED]" || account.appSecret === "[DECRYPTION_FAILED]") {
          return { success: false, status: "failed", errorReason: "WHATSAPP_NOT_CONFIGURED" };
        }
        try {
          const data = await this.request(`${account.phoneNumberId}/messages`, account, "POST", {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: phone,
            ...content
          });
          if (!data?.messages?.[0]?.id) return { success: false, status: "failed", errorReason: "AMBIGUOUS_NETWORK" };
          return { success: true, status: "accepted", providerMessageId: data.messages[0].id };
        } catch (error) {
          return {
            success: false,
            status: "failed",
            errorCode: error.code,
            errorReason: error.code === 131026 ? "RECIPIENT_NOT_ON_WHATSAPP" : error.code ? `META_ERROR_${error.code}` : "AMBIGUOUS_NETWORK"
          };
        }
      }
      sendTemplateMessage(payload) {
        const components = [];
        if (payload.parameters.length) components.push({ type: "body", parameters: payload.parameters.map((text) => ({ type: "text", text: String(text ?? "").slice(0, 1024) })) });
        if (payload.buttonUrlParam) components.push({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: payload.buttonUrlParam }] });
        return this.send(payload.to, { type: "template", template: { name: payload.templateName, language: { code: payload.languageCode || process.env.META_WHATSAPP_LANG || "en" }, components } }, payload.credentials);
      }
      sendFreeformTextMessage(params) {
        return this.send(params.to, { type: "text", text: { preview_url: true, body: params.text.slice(0, 4096) } }, params.credentials);
      }
      async sendDocumentMessage(payload) {
        if (!/^https:\/\//i.test(payload.documentUrl) && process.env.NODE_ENV !== "test") {
          return { success: false, status: "failed", errorReason: "DOCUMENT_REQUIRES_PUBLIC_HTTPS" };
        }
        if (process.env.NODE_ENV === "test" || process.env.WHATSAPP_SANDBOX_MODE === "true" && process.env.NODE_ENV !== "production") {
          return this.send(payload.to, { type: "document", document: { link: payload.documentUrl, filename: payload.filename, caption: payload.caption } }, payload.credentials);
        }
        const account = payload.credentials || await getPlatformAccount();
        if (!account.phoneNumberId || !account.accessToken || !account.appSecret) return { success: false, status: "failed", errorReason: "WHATSAPP_NOT_CONFIGURED" };
        try {
          const documentUrl = new URL(payload.documentUrl);
          const allowedOrigins = [process.env.PUBLIC_API_BASE_URL, process.env.API_BASE_URL, process.env.R2_CUSTOM_DOMAIN].filter(Boolean).map((value) => new URL(value).origin);
          if (!allowedOrigins.includes(documentUrl.origin)) throw new Error("UNTRUSTED_DOCUMENT_ORIGIN");
          const file = await fetch(documentUrl, { redirect: "error", signal: AbortSignal.timeout(15e3) });
          if (!file.ok || !file.headers.get("content-type")?.includes("application/pdf") || !file.body) throw new Error("INVALID_PDF_RESPONSE");
          const reader = file.body.getReader();
          const chunks = [];
          let size = 0;
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 10 * 1024 * 1024) {
              await reader.cancel();
              throw new Error("PDF_TOO_LARGE");
            }
            chunks.push(value);
          }
          const buffer = Buffer.concat(chunks);
          if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("INVALID_PDF");
          const form = new FormData();
          form.append("messaging_product", "whatsapp");
          form.append("file", new Blob([buffer], { type: "application/pdf" }), payload.filename);
          const version = process.env.WHATSAPP_API_VERSION || "v25.0";
          const uploaded = await fetch(`https://graph.facebook.com/${version}/${account.phoneNumberId}/media`, { method: "POST", headers: { Authorization: `Bearer ${account.accessToken}` }, body: form, signal: AbortSignal.timeout(15e3) });
          const media = await uploaded.json();
          if (!uploaded.ok || !media.id) throw new Error("MEDIA_UPLOAD_FAILED");
          return this.send(payload.to, { type: "document", document: { id: media.id, filename: payload.filename, caption: payload.caption } }, account);
        } catch {
          return { success: false, status: "failed", errorReason: "MEDIA_UPLOAD_FAILED" };
        }
      }
    };
    whatsAppCloudApiService = new WhatsAppCloudApiService();
  }
});

// services/WhatsAppSendPolicy.ts
function phoneHash(phone) {
  return computeBlindIndex(whatsAppCloudApiService.formatPhoneNumber(phone));
}
async function assertWhatsAppConsent(account, phone) {
  const digits = whatsAppCloudApiService.formatPhoneNumber(phone);
  if (!/^[1-9]\d{7,14}$/.test(digits)) throw new Error("INVALID_PHONE");
  const recipient = await WhatsAppRecipient.findOne({ scope: account.scope, phoneHash: phoneHash(phone) });
  if (recipient?.optedOut) throw new Error("PATIENT_OPTED_OUT_WHATSAPP");
  const patient = await Patient.findOne({
    ...account.organizationId ? { organizationId: account.organizationId } : {},
    phone: { $in: [digits, `+${digits}`, digits.startsWith("91") ? digits.slice(2) : digits] },
    optOutWhatsApp: true
  });
  if (patient) throw new Error("PATIENT_OPTED_OUT_WHATSAPP");
  return !!recipient?.lastInboundAt && Date.now() - recipient.lastInboundAt.getTime() < 864e5;
}
async function assertApprovedTemplate(account, name, language, parameterCount) {
  if (process.env.NODE_ENV === "test" || process.env.WHATSAPP_SANDBOX_MODE === "true" && process.env.NODE_ENV !== "production") return;
  const template = await WhatsAppTemplate.findOne({ scope: account.scope, name, language, status: "APPROVED" });
  if (!template) throw new Error("TEMPLATES_NOT_READY");
  const body = template.components?.find((component) => component.type === "BODY");
  if (body?.text && parameterCount !== void 0) {
    const variables = new Set(body.text.match(/\{\{\d+\}\}/g) || []);
    if (variables.size !== parameterCount) throw new Error("TEMPLATE_PARAMETER_MISMATCH");
  }
}
function isPermanentWhatsAppFailure(reason) {
  return !!reason && (["AMBIGUOUS_NETWORK", "INVALID_PHONE", "WHATSAPP_NOT_CONFIGURED", "ORGANIZATION_NOT_FOUND", "PATIENT_OPTED_OUT_WHATSAPP", "WHATSAPP_DISABLED_FOR_ORGANIZATION", "TEMPLATES_NOT_READY", "TEMPLATE_PARAMETER_MISMATCH", "SESSION_WINDOW_CLOSED", "DOCUMENT_REQUIRES_PUBLIC_HTTPS", "RECIPIENT_NOT_ON_WHATSAPP"].includes(reason) || reason.startsWith("META_ERROR_") && !/^META_ERROR_(429|5\d\d|130429|131000|131056|80007)$/.test(reason));
}
var init_WhatsAppSendPolicy = __esm({
  "services/WhatsAppSendPolicy.ts"() {
    "use strict";
    init_Patient();
    init_WhatsAppRecipient();
    init_WhatsAppTemplate();
    init_cryptoEnvelope();
    init_WhatsAppCloudApiService();
  }
});

// models/commercialQuoteSchema.ts
import { Schema as Schema29 } from "mongoose";
var quantity, rates, commercialPricingSchema, location, commercialQuoteSchema;
var init_commercialQuoteSchema = __esm({
  "models/commercialQuoteSchema.ts"() {
    "use strict";
    quantity = { type: Number, min: 0, required: true, validate: Number.isSafeInteger };
    rates = new Schema29({
      clinicPaise: quantity,
      pharmacyPaise: quantity,
      pharmacyAddonPaise: quantity,
      extraDoctorPaise: quantity,
      additionalPharmacyPaise: { type: Number, min: 0, validate: Number.isSafeInteger }
    }, { _id: false });
    commercialPricingSchema = new Schema29({
      revision: { ...quantity, min: 1 },
      monthly: { type: rates, required: true },
      annual: { type: rates, default: void 0 },
      taxMode: { type: String, enum: ["inclusive", "exclusive"], required: true },
      taxRateBps: { ...quantity, max: 1e4 },
      includedDoctors: quantity,
      doctorsPerAdditionalClinic: quantity
    }, { _id: false });
    location = new Schema29({ locationId: { type: String, required: true }, clinic: { type: Boolean, required: true }, pharmacy: { type: Boolean, required: true }, capabilityRevision: quantity }, { _id: false });
    commercialQuoteSchema = new Schema29({
      version: { type: Number, enum: [1], required: true },
      organizationId: { type: String, required: true },
      planId: { type: String, required: true },
      priceRevision: quantity,
      commercialFamily: { type: String, enum: ["pharmacy", "clinic", "mixed"], required: true },
      legacyTier: { type: String, enum: ["starter", "professional", "enterprise"], required: true },
      billingCycle: { type: String, enum: ["monthly", "annual"], required: true },
      currency: { type: String, enum: ["INR"], required: true },
      taxMode: { type: String, enum: ["inclusive", "exclusive"], required: true },
      taxRateBps: quantity,
      periodStart: { type: String, required: true },
      periodEnd: { type: String, required: true },
      expiresAt: { type: String, required: true },
      lines: { type: [new Schema29({
        id: { type: String, required: true },
        kind: { type: String, enum: ["clinic", "pharmacy", "pharmacy_addon", "extra_doctor"], required: true },
        locationId: String,
        quantity,
        unitPricePaise: quantity,
        amountPaise: quantity
      }, { _id: false })], required: true },
      subtotalPaise: quantity,
      taxPaise: quantity,
      totalPaise: quantity,
      entitlements: { maxLocations: quantity, maxDoctors: quantity, maxStaff: quantity, locations: { type: [location], required: true } },
      fingerprint: { type: String, required: true, match: /^[a-f\d]{64}$/ }
    }, { _id: false });
  }
});

// models/Subscription.ts
import mongoose36, { Schema as Schema30 } from "mongoose";
var SubscriptionSchema, Subscription;
var init_Subscription = __esm({
  "models/Subscription.ts"() {
    "use strict";
    init_commercialQuoteSchema();
    SubscriptionSchema = new Schema30({
      organizationId: { type: Schema30.Types.ObjectId, ref: "Organization", required: true, index: true },
      planId: { type: Schema30.Types.ObjectId, ref: "SaaSPlan", required: true, index: true },
      commercialQuote: { type: commercialQuoteSchema, default: void 0 },
      status: {
        type: String,
        enum: ["trialing", "active", "payment_pending", "payment_failed", "cancelled", "expired"],
        default: "trialing",
        index: true
      },
      billingCycle: { type: String, enum: ["monthly", "annual"], default: "monthly" },
      entitlementSource: { type: String, enum: ["trial", "free", "paid", "manual"], default: null },
      manualGrantReason: { type: String, default: null },
      manualGrantedBy: { type: Schema30.Types.ObjectId, ref: "User", default: null },
      manualGrantedAt: { type: Date, default: null },
      trialStartedAt: { type: Date, default: Date.now },
      trialEndsAt: { type: Date, required: true },
      currentPeriodStart: { type: Date, default: Date.now },
      currentPeriodEnd: { type: Date, required: true },
      lastBillingChangeAt: { type: Date, default: null },
      cancelledAt: { type: Date, default: null },
      razorpaySubscriptionId: { type: String, default: null, index: true },
      razorpayCustomerId: { type: String, default: null },
      pendingCheckout: {
        paymentId: { type: Schema30.Types.ObjectId, ref: "SubscriptionPayment", default: null },
        claimedAt: { type: Date, default: null }
      },
      createdAt: { type: Date, default: Date.now },
      updatedAt: { type: Date, default: Date.now }
    }, { timestamps: true });
    SubscriptionSchema.index({ organizationId: 1, status: 1 });
    SubscriptionSchema.virtual("id").get(function() {
      return this._id.toHexString();
    });
    SubscriptionSchema.set("toJSON", {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    });
    Subscription = mongoose36.model("Subscription", SubscriptionSchema);
  }
});

// services/CrmEntitlementService.ts
async function crmEntitlementActive(organizationId, now = /* @__PURE__ */ new Date()) {
  const [org, subscription] = await Promise.all([
    Organization.findOne({ _id: organizationId, isActive: true, status: "active" }).select("_id").lean(),
    Subscription.findOne({ organizationId }).sort({ createdAt: 1, _id: 1 }).select("status trialEndsAt currentPeriodEnd").lean()
  ]);
  return !!org && !!subscription && (subscription.status === "active" && subscription.currentPeriodEnd > now || subscription.status === "trialing" && subscription.trialEndsAt > now);
}
var init_CrmEntitlementService = __esm({
  "services/CrmEntitlementService.ts"() {
    "use strict";
    init_Organization();
    init_Subscription();
  }
});

// utilities/auditPlugin.ts
function auditPlugin(schema11) {
  schema11.post("save", async function(doc) {
    if (!doc.constructor?.modelName || ["AuditLog", "AuditChainHead", "OperationReceipt"].includes(doc.constructor.modelName)) return;
    const context = requestContextStore.getStore();
    const userId = context?.userId;
    if (!userId) return;
    try {
      await AuditLog.create({
        userId,
        organizationId: context?.organizationId || void 0,
        action: `${doc.constructor.modelName.toUpperCase()}_SAVE`,
        targetId: doc._id,
        targetModel: doc.constructor.modelName,
        ipAddress: context?.ipAddress,
        userAgent: context?.userAgent,
        category: "CLINICAL_WRITE",
        details: doc.toJSON()
      }, { session: doc.$session?.() || void 0 });
    } catch (err) {
      throw err;
    }
  });
  schema11.post("findOneAndUpdate", async function(res) {
    if (!res || !this.model || ["AuditLog", "AuditChainHead", "OperationReceipt"].includes(this.model.modelName)) return;
    const context = requestContextStore.getStore();
    const userId = context?.userId;
    if (!userId) return;
    try {
      await AuditLog.create({
        userId,
        organizationId: context?.organizationId || void 0,
        action: `${this.model.modelName.toUpperCase()}_UPDATE`,
        targetId: res._id,
        targetModel: this.model.modelName,
        ipAddress: context?.ipAddress,
        userAgent: context?.userAgent,
        category: "CLINICAL_WRITE",
        details: typeof res.toJSON === "function" ? res.toJSON() : res
      }, { session: this.getOptions?.().session });
    } catch (err) {
      throw err;
    }
  });
  schema11.post("findOneAndDelete", async function(res) {
    if (!res || !this.model || ["AuditLog", "AuditChainHead", "OperationReceipt"].includes(this.model.modelName)) return;
    const context = requestContextStore.getStore();
    const userId = context?.userId;
    if (!userId) return;
    try {
      await AuditLog.create({
        userId,
        organizationId: context?.organizationId || void 0,
        action: `${this.model.modelName.toUpperCase()}_DELETE`,
        targetId: res._id,
        targetModel: this.model.modelName,
        ipAddress: context?.ipAddress,
        userAgent: context?.userAgent,
        category: "CLINICAL_WRITE",
        details: { id: res._id.toString() }
      }, { session: this.getOptions?.().session });
    } catch (err) {
      throw err;
    }
  });
}
var init_auditPlugin = __esm({
  "utilities/auditPlugin.ts"() {
    "use strict";
    init_context();
    init_AuditLog();
  }
});

// models/pharmacyDocumentSchema.ts
import { Schema as Schema31 } from "mongoose";
var pharmacyDocumentSchema, pharmacyTaxAmounts;
var init_pharmacyDocumentSchema = __esm({
  "models/pharmacyDocumentSchema.ts"() {
    "use strict";
    pharmacyDocumentSchema = new Schema31({
      version: { type: Number, required: true },
      kind: { type: String, enum: ["tax_invoice", "bill_of_supply", "invoice_cum_bill_of_supply", "ordinary_bill"], required: true },
      pricingPolicy: { type: String, required: true },
      supplyMode: { type: String, required: true },
      signatureMode: { type: String, required: true },
      issuer: { legalName: String, address: String, stateCode: String, gstin: String, registration: String, drugLicenceNumbers: [String], authorisedSignatory: String },
      recipient: { name: String, address: String, stateCode: String, deliveryAddress: String },
      placeOfSupply: String,
      reverseCharge: Boolean,
      profileRevision: Number,
      reviewReference: String,
      issuedBy: { type: Schema31.Types.ObjectId, ref: "User" },
      issuedAt: Date,
      notice: String
    }, { _id: false });
    pharmacyTaxAmounts = {
      baseAmountPaise: { type: Number, min: 0, validate: Number.isSafeInteger },
      cgstPaise: { type: Number, min: 0, validate: Number.isSafeInteger },
      sgstPaise: { type: Number, min: 0, validate: Number.isSafeInteger },
      grossAmountPaise: { type: Number, min: 0, validate: Number.isSafeInteger }
    };
  }
});

// utilities/pharmacyCalculation.ts
var PHARMACY_CALCULATION_POLICY;
var init_pharmacyCalculation = __esm({
  "utilities/pharmacyCalculation.ts"() {
    "use strict";
    PHARMACY_CALCULATION_POLICY = "pharmacy-paise-v2";
  }
});

// utilities/pharmacyCalculationVersion.ts
var init_pharmacyCalculationVersion = __esm({
  "utilities/pharmacyCalculationVersion.ts"() {
    "use strict";
  }
});

// services/InvoiceCalculationService.ts
var init_InvoiceCalculationService = __esm({
  "services/InvoiceCalculationService.ts"() {
    "use strict";
    init_CommandReceiptService();
    init_pharmacyCalculation();
    init_pharmacyCalculation();
    init_pharmacyCalculationVersion();
  }
});

// models/pharmacyCalculationSchema.ts
import { Schema as Schema32 } from "mongoose";
var paise, amounts, line, pharmacyCalculationSchema;
var init_pharmacyCalculationSchema = __esm({
  "models/pharmacyCalculationSchema.ts"() {
    "use strict";
    init_InvoiceCalculationService();
    paise = { type: Number, required: true, min: 0, validate: Number.isSafeInteger };
    amounts = {
      amountBeforeDiscountPaise: paise,
      lineDiscountPaise: paise,
      invoiceDiscountPaise: paise,
      baseAmountPaise: paise,
      cgstPaise: paise,
      sgstPaise: paise,
      utgstPaise: paise,
      igstPaise: paise,
      unallocatedTaxPaise: paise,
      grossAmountPaise: paise
    };
    line = new Schema32({
      lineId: { type: String, required: true },
      quantity: { ...paise, min: 1 },
      gstRateBps: { ...paise, max: 1e4 },
      ...amounts
    }, { _id: false });
    pharmacyCalculationSchema = new Schema32({
      policy: { type: String, enum: [PHARMACY_CALCULATION_POLICY], required: true },
      currency: { type: String, enum: ["INR"], required: true },
      priceMode: { type: String, enum: ["inclusive", "exclusive"], required: true },
      taxMode: { type: String, enum: ["sgst", "utgst", "igst", "unallocated", "none"], required: true },
      lines: { type: [line], required: true },
      totals: { type: new Schema32({ ...amounts, roundOffPaise: { type: Number, required: true, min: -99, max: 99, validate: Number.isSafeInteger }, payablePaise: paise }, { _id: false }), required: true }
    }, { _id: false });
  }
});

// utilities/pharmacyTax.ts
function toPaise(value) {
  const scaled = value * 100;
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(scaled)) || Math.abs(scaled - Math.round(scaled)) > 1e-6) {
    throw new CommandError(409, "Pharmacy prices must be nonnegative, bounded amounts with at most two decimal places");
  }
  return Math.round(scaled);
}
var init_pharmacyTax = __esm({
  "utilities/pharmacyTax.ts"() {
    "use strict";
    init_CommandReceiptService();
    init_InvoiceCalculationService();
  }
});

// utilities/indiaFinancialYear.ts
function indiaFinancialYear(at = /* @__PURE__ */ new Date()) {
  if (!Number.isFinite(at.getTime())) throw new CommandError(409, "Invalid invoice issue date");
  const parts2 = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "numeric" }).formatToParts(at);
  const year = Number(parts2.find((part) => part.type === "year").value), month = Number(parts2.find((part) => part.type === "month").value);
  const start = month >= 4 ? year : year - 1;
  if (start < 2e3 || start > 2098) throw new CommandError(409, "Invoice financial year needs a reviewed numbering version");
  return { start, label: `${start}-${String(start + 1).slice(-2)}`, code: `${String(start).slice(-2)}${String(start + 1).slice(-2)}` };
}
var init_indiaFinancialYear = __esm({
  "utilities/indiaFinancialYear.ts"() {
    "use strict";
    init_CommandReceiptService();
  }
});

// utilities/pharmacyInvoiceNumberFormat.ts
function pharmacyNumberPrefix(format, financialYear) {
  if (!format || typeof format.prefixTemplate !== "string" || !Number.isSafeInteger(format.digits) || format.digits < 1 || format.digits > 9 || !["continuous", "financial_year"].includes(format.resetPolicy) || !/^20\d{2}-\d{2}$/.test(financialYear) || Number(financialYear.slice(0, 4)) > 2098 || String(Number(financialYear.slice(0, 4)) + 1).slice(-2) !== financialYear.slice(-2)) throw new CommandError(409, "Review the invoice prefix, digits and financial-year policy");
  const tokens = format.prefixTemplate.match(/\{FY\}/g)?.length ?? 0;
  if (format.resetPolicy === "financial_year" ? tokens !== 1 : tokens !== 0) throw new CommandError(409, "Use exactly one {FY} in a yearly prefix, or no {FY} for a continuous sequence");
  const prefix = format.prefixTemplate.replace("{FY}", financialYear.slice(2));
  if (!/^[A-Z0-9][A-Z0-9/-]*[/-]$/.test(prefix) || prefix.length + format.digits > 16 || /^[ICO][A-Z0-9]{4}[0-9]{4}\/$/.test(prefix))
    throw new CommandError(409, "Use an uppercase branch prefix ending in / or -, with at most 16 characters including the number. Internal document prefixes are reserved.");
  return prefix;
}
function validPharmacyInvoiceNumber(invoice) {
  if (!invoice) return false;
  if (invoice.numberingVersion === 2) return !invoice.numberingSnapshot && /^I[A-Z0-9]{4}[0-9]{4}\/[0-9]{6}$/.test(invoice.invoiceNumber ?? "") && invoice.invoiceSeries === invoice.invoiceNumber.slice(1, 5);
  if (invoice.numberingVersion !== 3 || !invoice.issuedAt || !invoice.financialYear) return false;
  try {
    const snapshot = invoice.numberingSnapshot;
    if (!snapshot || snapshot.version !== 1 || !Number.isSafeInteger(snapshot.configurationRevision) || snapshot.configurationRevision < 1 || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 1 || snapshot.sequence >= 10 ** snapshot.digits || indiaFinancialYear(invoice.issuedAt).label !== invoice.financialYear) return false;
    const prefix = pharmacyNumberPrefix(snapshot, invoice.financialYear);
    return snapshot.prefix === prefix && invoice.invoiceSeries === prefix && invoice.invoiceNumber === `${prefix}${String(snapshot.sequence).padStart(snapshot.digits, "0")}`;
  } catch {
    return false;
  }
}
var init_pharmacyInvoiceNumberFormat = __esm({
  "utilities/pharmacyInvoiceNumberFormat.ts"() {
    "use strict";
    init_CommandReceiptService();
    init_indiaFinancialYear();
  }
});

// utilities/pharmacyInvoice.ts
function validateRetailInvoice(invoice) {
  const fail = () => {
    throw new CommandError(409, "Retail invoice does not reconcile with its captured sources and calculation");
  };
  if (invoice.kind !== "pharmacy") {
    if ([2, 3].includes(invoice.documentVersion)) fail();
    return;
  }
  const calc = invoice.calculation, doc = invoice.taxDocument, customer = invoice.customerSnapshot;
  if (invoice.documentVersion === 3) {
    const amount = toPaise(invoice.totalAmount), paid2 = toPaise(invoice.amountPaid ?? 0), opening = invoice.openingBalanceSnapshot;
    if (!amount || opening?.amountPaise !== amount || !invoice.openingBalanceId || !opening?.sourceDate || !opening.sourceReference || !opening.reviewReference || !opening.issuer?.legalName || !opening.issuer.address || !invoice.organizationId || !invoice.createdBy || !invoice.issuedAt || !/^O[0-9A-Z]{4}[0-9]{4}\/[0-9]{6}$/.test(invoice.invoiceNumber) || invoice.numberingVersion !== 1 || !invoice.financialYear || invoice.invoiceSeries !== invoice.invoiceNumber.slice(1, 5) || invoice.currency !== "INR" || !customer || customer.anonymous !== false || !customer.partyId || !customer.name || !Number.isSafeInteger(customer.revision) || invoice.patientId || invoice.doctorId || invoice.encounterId || invoice.appointmentId || invoice.items.length || calc || doc || invoice.subtotal !== invoice.totalAmount || invoice.tax !== 0 || invoice.taxableAmount !== 0 || invoice.discount !== 0 || invoice.cgstTotal !== 0 || invoice.sgstTotal !== 0 || invoice.igstTotal !== 0 || (invoice.creditedPaise ?? 0) !== 0 || (invoice.refundedPaise ?? 0) !== 0 || (invoice.returnRevision ?? 0) !== 0 || paid2 > amount || toPaise(invoice.balanceDue) !== amount - paid2) fail();
    return;
  }
  if (invoice.openingBalanceId || invoice.openingBalanceSnapshot) fail();
  if (invoice.documentVersion !== 2 || !invoice.createdBy || !invoice.organizationId || !customer || typeof customer.anonymous !== "boolean" || !customer.anonymous && (!customer.partyId || !customer.name || !Number.isSafeInteger(customer.revision)) || customer.anonymous && customer.partyId || invoice.patientId || invoice.doctorId || invoice.encounterId || invoice.appointmentId || invoice.supplementForInvoiceId || !calc || calc.policy !== "pharmacy-paise-v2" || calc.currency !== "INR" || calc.priceMode !== "inclusive" || !["sgst", "none"].includes(calc.taxMode) || !doc || doc.version !== 2 || doc.pricingPolicy !== calc.policy || !["tax_invoice", "bill_of_supply", "invoice_cum_bill_of_supply", "ordinary_bill"].includes(doc.kind) || !doc.issuer?.legalName || !doc.issuer.address || !doc.issuer.authorisedSignatory || !doc.issuer.drugLicenceNumbers?.length || !doc.recipient?.name || String(doc.issuedBy) !== String(invoice.createdBy) || doc.signatureMode !== "manual_on_print" || doc.supplyMode !== "counter_pickup" || !invoice.issuedAt || doc.issuedAt?.getTime() !== invoice.issuedAt.getTime() || invoice.currency !== "INR" || !validPharmacyInvoiceNumber(invoice) || !invoice.financialYear || !invoice.items.length || calc.lines.length !== invoice.items.length || !calc.totals || invoice.isInterstate || invoice.invoiceType !== "B2C") fail();
  const totals = calc.totals, fields = ["amountBeforeDiscountPaise", "lineDiscountPaise", "invoiceDiscountPaise", "baseAmountPaise", "cgstPaise", "sgstPaise", "grossAmountPaise"];
  const paid = toPaise(invoice.amountPaid ?? 0), credited = invoice.creditedPaise ?? 0;
  const refunded = invoice.refundedPaise ?? 0;
  if (paid > totals.payablePaise || !Number.isSafeInteger(credited) || credited < 0 || credited > totals.payablePaise || !Number.isSafeInteger(refunded) || refunded < 0 || refunded > Math.max(0, paid + credited - totals.payablePaise) || !Number.isSafeInteger(invoice.returnRevision ?? 0) || (invoice.returnRevision ?? 0) < 0 || invoice.balanceDue !== void 0 && toPaise(invoice.balanceDue) !== Math.max(0, totals.payablePaise - paid - credited)) fail();
  const safe = (value) => Number.isSafeInteger(value) && value >= 0;
  const ids = /* @__PURE__ */ new Set();
  for (const item of invoice.items) {
    const line2 = calc.lines.find((row) => row.lineId === item.calculationLineId);
    if (!line2 || ids.has(line2.lineId) || !item.pharmacyDispenseId || !item.pharmacyDispenseLineId || line2.quantity !== item.quantity || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || !/^\d{4}(\d{2})?(\d{2})?$/.test(item.hsnSacCode) || !/^[A-Z]{3}$/.test(item.unitCode || "") || fields.some((field) => !safe(line2[field])) || ["baseAmountPaise", "cgstPaise", "sgstPaise", "grossAmountPaise"].some((field) => item[field] !== line2[field]) || line2.baseAmountPaise + line2.cgstPaise + line2.sgstPaise !== line2.grossAmountPaise || line2.grossAmountPaise !== line2.amountBeforeDiscountPaise - line2.lineDiscountPaise - line2.invoiceDiscountPaise || line2.utgstPaise !== 0 || line2.igstPaise !== 0 || line2.unallocatedTaxPaise !== 0 || line2.gstRateBps !== Math.round(item.gstRate * 100) || Math.abs(item.amount * item.quantity - item.baseAmountPaise / 100) > 1e-6 || item.totalItemAmount !== item.grossAmountPaise / 100) fail();
    ids.add(line2.lineId);
  }
  if (fields.some((field) => !safe(totals[field]) || BigInt(totals[field]) !== calc.lines.reduce((sum, line2) => sum + BigInt(line2[field]), 0n)) || !Number.isSafeInteger(totals.roundOffPaise) || Math.abs(totals.roundOffPaise) > 99 || !safe(totals.payablePaise) || totals.utgstPaise !== 0 || totals.igstPaise !== 0 || totals.unallocatedTaxPaise !== 0 || totals.payablePaise !== totals.grossAmountPaise + totals.roundOffPaise || invoice.subtotal !== totals.baseAmountPaise / 100 || invoice.tax !== (totals.cgstPaise + totals.sgstPaise) / 100 || invoice.cgstTotal !== totals.cgstPaise / 100 || invoice.sgstTotal !== totals.sgstPaise / 100 || invoice.igstTotal !== 0 || invoice.totalAmount !== totals.payablePaise / 100 || invoice.discount !== (totals.lineDiscountPaise + totals.invoiceDiscountPaise) / 100 || (doc.issuer.registration !== "regular" || !["tax_invoice", "invoice_cum_bill_of_supply"].includes(doc.kind)) && invoice.tax !== 0) fail();
}
var init_pharmacyInvoice = __esm({
  "utilities/pharmacyInvoice.ts"() {
    "use strict";
    init_CommandReceiptService();
    init_pharmacyTax();
    init_pharmacyInvoiceNumberFormat();
  }
});

// models/Invoice.ts
var Invoice_exports = {};
__export(Invoice_exports, {
  Invoice: () => Invoice
});
import mongoose37, { Schema as Schema33 } from "mongoose";
var InvoiceItemSchema, InvoiceSchema, protectedIssuePaths, Invoice;
var init_Invoice = __esm({
  "models/Invoice.ts"() {
    "use strict";
    init_documentBudget();
    init_auditPlugin();
    init_tenantPlugin();
    init_Organization();
    init_Location();
    init_pharmacyDocumentSchema();
    init_CommandReceiptService();
    init_pharmacyCalculationSchema();
    init_pharmacyInvoice();
    init_pharmacyInvoiceNumberFormat();
    InvoiceItemSchema = new Schema33({
      ...pharmacyTaxAmounts,
      taxTreatment: String,
      unitCode: String,
      pharmacyDispenseId: { type: Schema33.Types.ObjectId, ref: "PharmacyDispense" },
      pharmacyDispenseLineId: { type: Schema33.Types.ObjectId },
      calculationLineId: String,
      serviceCatalogId: { type: Schema33.Types.ObjectId, ref: "ServiceCatalog" },
      description: { type: String, required: true },
      amount: { type: Number, required: true },
      // Base unit price
      quantity: { type: Number, required: true, default: 1 },
      hsnSacCode: { type: String, default: "999312" },
      gstRate: { type: Number, default: 0 },
      cgstAmount: { type: Number, default: 0 },
      sgstAmount: { type: Number, default: 0 },
      igstAmount: { type: Number, default: 0 },
      totalItemAmount: { type: Number }
    });
    InvoiceSchema = new Schema33({
      kind: { type: String, enum: ["clinical", "pharmacy"], default: "clinical", required: true },
      createdBy: { type: Schema33.Types.ObjectId, ref: "User" },
      customerSnapshot: { type: new Schema33({ anonymous: { type: Boolean, required: true }, partyId: Schema33.Types.ObjectId, revision: Number, name: String, address: String, phone: String }, { _id: false }), default: void 0 },
      openingBalanceId: { type: Schema33.Types.ObjectId },
      openingBalanceSnapshot: { type: new Schema33({
        amountPaise: { type: Number, min: 1, required: true, validate: Number.isSafeInteger },
        sourceDate: { type: String, required: true },
        sourceReference: { type: String, required: true },
        reviewReference: { type: String, required: true },
        issuer: { legalName: { type: String, required: true }, address: { type: String, required: true }, drugLicenceNumbers: [String] }
      }, { _id: false }), default: void 0 },
      calculation: { type: pharmacyCalculationSchema },
      invoiceNumber: { type: String, required: true },
      generationKey: { type: String },
      clinicalChargeVersion: { type: Number },
      supplementForInvoiceId: { type: Schema33.Types.ObjectId, ref: "Invoice" },
      issuedAt: { type: Date },
      documentVersion: { type: Number },
      numberingVersion: { type: Number },
      financialYear: { type: String },
      invoiceSeries: { type: String },
      numberingSnapshot: { type: new Schema33({
        version: { type: Number, enum: [1], required: true },
        prefixTemplate: { type: String, required: true },
        prefix: { type: String, required: true },
        digits: { type: Number, required: true },
        sequence: { type: Number, required: true },
        resetPolicy: { type: String, enum: ["continuous", "financial_year"], required: true },
        configurationRevision: { type: Number, required: true }
      }, { _id: false }), default: void 0 },
      taxDocument: { type: pharmacyDocumentSchema },
      organizationId: { type: Schema33.Types.ObjectId, ref: "Organization" },
      currency: { type: String, enum: ["INR", "USD", "CAD", "GBP", "AED", "EUR"] },
      patientId: { type: Schema33.Types.ObjectId, ref: "Patient", required: function() {
        return this.kind !== "pharmacy";
      }, index: true },
      appointmentId: { type: Schema33.Types.ObjectId, ref: "Appointment", index: true },
      encounterId: { type: Schema33.Types.ObjectId, ref: "Encounter", index: true },
      locationId: { type: Schema33.Types.ObjectId, ref: "Location", required: true },
      doctorId: { type: Schema33.Types.ObjectId, ref: "User", required: function() {
        return this.kind !== "pharmacy";
      }, index: true },
      items: [InvoiceItemSchema],
      pharmacyDispenseLineIds: { type: [Schema33.Types.ObjectId], default: void 0 },
      subtotal: { type: Number, required: true },
      taxableAmount: { type: Number, default: 0 },
      tax: { type: Number, default: 0 },
      // Combined tax total
      discount: { type: Number, default: 0 },
      totalAmount: { type: Number, required: true },
      // GST Compliance Fields
      supplierGstin: { type: String, trim: true },
      customerGstin: { type: String, trim: true },
      invoiceType: {
        type: String,
        enum: ["B2C", "B2B", "SEZ", "EXPORT"],
        default: "B2C"
      },
      placeOfSupply: { type: String, trim: true },
      isInterstate: { type: Boolean, default: false },
      cgstTotal: { type: Number, default: 0 },
      sgstTotal: { type: Number, default: 0 },
      igstTotal: { type: Number, default: 0 },
      // Phase 3 e-Invoice hook fields
      eInvoiceIrn: { type: String, trim: true },
      eInvoiceQrCode: { type: String, trim: true },
      status: {
        type: String,
        enum: ["unpaid", "partially_paid", "paid", "refunded", "cancelled"],
        default: "unpaid",
        index: true
      },
      amountPaid: { type: Number, default: 0 },
      balanceDue: { type: Number },
      paymentRevision: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
      creditedPaise: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
      refundedPaise: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
      returnRevision: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
      payments: [
        {
          amount: { type: Number, required: true },
          operationKey: { type: String },
          receiptId: { type: Schema33.Types.ObjectId },
          componentId: String,
          actorId: { type: Schema33.Types.ObjectId, ref: "User" },
          shiftId: { type: Schema33.Types.ObjectId, ref: "CashierShift" },
          paymentMethod: { type: String, required: true },
          referenceNumber: { type: String, trim: true },
          paidAt: { type: Date, default: Date.now },
          notes: { type: String, trim: true }
        }
      ],
      dueDate: { type: Date, index: true },
      paymentMethod: {
        type: String,
        enum: ["cash", "card", "upi", "net-banking", "insurance", "online", "courtesy_waiver", "other"]
      },
      paymentDate: { type: Date },
      notes: { type: String, trim: true },
      deletedAt: { type: Date, default: null, index: true },
      createdAt: { type: Date, default: Date.now }
    }, { timestamps: true });
    InvoiceSchema.index({ locationId: 1, status: 1 });
    InvoiceSchema.index({ organizationId: 1, invoiceNumber: 1 }, { unique: true, name: "invoice_organization_number_v1" });
    InvoiceSchema.index({ pharmacyDispenseLineIds: 1 }, {
      unique: true,
      partialFilterExpression: { pharmacyDispenseLineIds: { $type: "objectId" } }
    });
    InvoiceSchema.index({ generationKey: 1 }, { unique: true, partialFilterExpression: { generationKey: { $type: "string" } } });
    InvoiceSchema.index({ organizationId: 1, createdAt: -1 });
    InvoiceSchema.index({ organizationId: 1, patientId: 1, createdAt: -1 });
    InvoiceSchema.index({ organizationId: 1, locationId: 1, kind: 1, "customerSnapshot.partyId": 1, _id: -1 });
    InvoiceSchema.index({ organizationId: 1, locationId: 1, kind: 1, issuedAt: -1, _id: -1 });
    InvoiceSchema.pre("validate", function() {
      validateRetailInvoice(this);
      const lines = this.items.filter((item) => item.pharmacyDispenseLineId);
      const ids = lines.map((item) => item.pharmacyDispenseLineId);
      if (this.items.some((item) => Boolean(item.pharmacyDispenseId) !== Boolean(item.pharmacyDispenseLineId)) || new Set(ids.map(String)).size !== ids.length) throw new Error("Invoice pharmacy source references must be complete and unique");
      if (JSON.stringify((this.pharmacyDispenseLineIds || []).map(String)) !== JSON.stringify(ids.map(String))) {
        this.pharmacyDispenseLineIds = ids.length ? ids : void 0;
      }
      if (this.documentVersion === 1) {
        const document = this.taxDocument;
        const validNumber = validPharmacyInvoiceNumber(this);
        const sum = (key) => this.items.reduce((total, item) => total + (item[key] ?? NaN), 0);
        if (!this.issuedAt || !document || document.version !== 1 || !validNumber || this.currency !== "INR" || !document.issuer?.legalName || !document.issuer.address || !document.issuer.stateCode || !document.issuer.authorisedSignatory || !document.issuer.drugLicenceNumbers?.length || !document.recipient?.name || !document.issuedBy || document.signatureMode !== "manual_on_print" || document.issuedAt?.getTime() !== this.issuedAt.getTime() || !this.financialYear || !this.invoiceSeries || !this.items.length || this.items.some((item) => !/^\d{4}(\d{2})?(\d{2})?$/.test(item.hsnSacCode) || !/^[A-Z]{3}$/.test(item.unitCode || "") || ![item.baseAmountPaise, item.cgstPaise, item.sgstPaise, item.grossAmountPaise].every((value) => Number.isSafeInteger(value) && value >= 0) || item.baseAmountPaise + item.cgstPaise + item.sgstPaise !== item.grossAmountPaise || Math.abs(item.amount * item.quantity - item.baseAmountPaise / 100) > 1e-6 || item.totalItemAmount !== item.grossAmountPaise / 100) || this.subtotal !== sum("baseAmountPaise") / 100 || this.totalAmount !== sum("grossAmountPaise") / 100 || this.tax !== (sum("cgstPaise") + sum("sgstPaise")) / 100 || this.cgstTotal !== sum("cgstPaise") / 100 || this.sgstTotal !== sum("sgstPaise") / 100 || this.igstTotal !== 0 || this.discount !== 0 || !["tax_invoice", "invoice_cum_bill_of_supply"].includes(document.kind) && this.tax !== 0) {
          throw new CommandError(409, "Issued pharmacy document does not reconcile with its captured tax lines");
        }
      }
    });
    protectedIssuePaths = ["openingBalanceId", "openingBalanceSnapshot", "kind", "createdBy", "customerSnapshot", "calculation", "items", "pharmacyDispenseLineIds", "invoiceNumber", "documentVersion", "numberingVersion", "numberingSnapshot", "financialYear", "invoiceSeries", "taxDocument", "issuedAt", "currency", "organizationId", "locationId", "patientId", "doctorId", "encounterId", "appointmentId", "supplementForInvoiceId", "subtotal", "taxableAmount", "tax", "discount", "totalAmount", "cgstTotal", "sgstTotal", "igstTotal", "supplierGstin", "customerGstin", "invoiceType", "placeOfSupply", "isInterstate", "deletedAt"];
    InvoiceSchema.pre("save", async function() {
      if (this.isNew) return;
      const issued = await Invoice.findOne({ _id: this._id, documentVersion: { $in: [1, 2, 3] }, issuedAt: { $ne: null } }).select("_id").lean();
      if (issued && (protectedIssuePaths.some((path3) => this.isModified(path3)) || this.isModified("status") && ["cancelled", "refunded"].includes(this.status))) {
        throw new CommandError(409, "Issued pharmacy documents are immutable; use a linked supplement or reviewed credit workflow");
      }
    });
    for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"]) {
      InvoiceSchema.pre(operation, async function() {
        const update = this.getUpdate?.();
        const paths = update ? Object.entries(update).flatMap(([key, value]) => key.startsWith("$") && value && typeof value === "object" ? [...Object.keys(value), ...key === "$rename" ? Object.values(value) : []] : [key]) : [];
        const destructive = operation.includes("delete") || operation.includes("Delete") || operation.includes("replace") || operation.includes("Replace");
        if ((destructive || Array.isArray(update) || paths.some((path3) => protectedIssuePaths.includes(path3.split(".")[0])) || ["cancelled", "refunded"].includes(update?.$set?.status || update?.status)) && await this.model.exists({ $and: [this.getFilter(), { documentVersion: { $in: [1, 2, 3] }, issuedAt: { $ne: null } }] })) {
          throw new CommandError(409, "Issued pharmacy document fields cannot be rewritten or deleted");
        }
      });
    }
    InvoiceSchema.pre("bulkWrite", function() {
      throw new CommandError(409, "Use guarded invoice mutations; bulk writes bypass issued-document validation");
    });
    InvoiceSchema.pre("deleteOne", { document: true, query: false }, function() {
      if ([1, 2, 3].includes(this.documentVersion) && this.issuedAt) throw new CommandError(409, "Issued pharmacy documents cannot be deleted");
    });
    InvoiceSchema.pre("validate", async function() {
      if (!this.isNew || this.currency) return;
      let organizationId = this.organizationId;
      if (!organizationId && this.locationId) {
        const location2 = await Location.findById(this.locationId).select("organizationId").lean();
        organizationId = location2?.organizationId;
      }
      if (organizationId) {
        const organization = await Organization.findById(organizationId).select("currency").lean();
        this.currency = organization?.currency || "INR";
      } else {
        this.currency = "INR";
      }
    });
    InvoiceSchema.virtual("id").get(function() {
      return this._id.toHexString();
    });
    InvoiceSchema.set("toJSON", {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    });
    InvoiceSchema.plugin(auditPlugin);
    InvoiceSchema.plugin(tenantPlugin);
    InvoiceSchema.plugin(documentBudget, { payments: 500, items: 1e3 });
    Invoice = mongoose37.models.Invoice || mongoose37.model("Invoice", InvoiceSchema);
  }
});

// utilities/locationTime.ts
function parts(date, timezone) {
  const values = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const number = (type) => Number(values.find((value) => value.type === type)?.value);
  return { year: number("year"), month: number("month"), day: number("day"), hour: number("hour"), minute: number("minute") };
}
function locationDateKey(date, timezone) {
  const { year, month, day } = parts(date, timezone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function locationClockMinutes(date, timezone) {
  const { hour, minute } = parts(date, timezone);
  return hour * 60 + minute;
}
function locationLocalTimeToDate(dateKey, time, timezone) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  if (![year, month, day, hour, minute].every(Number.isInteger)) throw new Error("Invalid location time");
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !/^\d{2}:\d{2}(?::00)?$/.test(time) || calendarDate.toISOString().slice(0, 10) !== dateKey || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error("Invalid location time");
  }
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wanted;
  for (let attempt = 0; attempt < 4; attempt++) {
    const found = parts(new Date(instant), timezone);
    const observed = Date.UTC(found.year, found.month - 1, found.day, found.hour, found.minute);
    if (observed === wanted) return new Date(instant);
    instant += wanted - observed;
  }
  throw new Error("Location time does not exist due to a timezone change");
}
function locationDayRange(dateKey, timezone) {
  const next = /* @__PURE__ */ new Date(`${dateKey}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextKey = next.toISOString().slice(0, 10);
  return {
    start: locationLocalTimeToDate(dateKey, "00:00", timezone),
    end: new Date(locationLocalTimeToDate(nextKey, "00:00", timezone).getTime() - 1)
  };
}
async function getLocationTimezone(locationId) {
  const location2 = await Location.findById(locationId).select("timezone organizationId").lean();
  if (location2?.timezone) return location2.timezone;
  const organization = location2?.organizationId ? await Organization.findById(location2.organizationId).select("timezone").lean() : null;
  return organization?.timezone || "Asia/Kolkata";
}
var init_locationTime = __esm({
  "utilities/locationTime.ts"() {
    "use strict";
    init_Location();
    init_Organization();
  }
});

// services/PatientCommunicationPolicy.ts
function normalizedCommunicationRecipient(value, channel) {
  if (channel === "email") return value.trim().toLowerCase();
  const digits = value.replace(/\D/g, "");
  return digits.length === 10 ? `91${digits}` : digits;
}
async function patientCommunicationPolicy(context, channel, intendedRecipient) {
  if (context.communicationAction === "queue_tracker" && (context.automated !== false || !context.actorId)) deny("COMMUNICATION_CONTEXT_REQUIRED");
  let { organizationId, locationId, patientId } = context;
  let appointmentStatus;
  let appointmentTime, appointmentDoctorId, communicationRevision;
  if (context.invoiceId) {
    const invoice = await Invoice.findOne({ _id: context.invoiceId, organizationId, appointmentId: context.appointmentId, patientId, locationId, deletedAt: null }).select("status currency payments").lean();
    const entry = invoice?.payments.find((row) => row.referenceNumber === context.paymentReference || row.operationKey === context.paymentReference);
    if (!context.paymentReference || !Number.isFinite(context.paymentAmount) || Number(context.paymentAmount) <= 0 || !invoice || !["paid", "partially_paid"].includes(invoice.status) || !entry || entry.amount !== context.paymentAmount || entry.paymentMethod !== context.paymentMethod || (invoice.currency || "INR") !== context.paymentCurrency) deny("COMMUNICATION_PAYMENT_SOURCE_CHANGED");
  }
  if (context.appointmentId) {
    const appointment = await Appointment.findOne({ _id: context.appointmentId, organizationId }).select("patientId locationId status appointmentTime doctorId communicationRevision paymentStatus");
    if (!appointment) deny("COMMUNICATION_SUBJECT_UNAVAILABLE");
    if (patientId && patientId !== String(appointment.patientId)) deny("COMMUNICATION_SUBJECT_MISMATCH");
    if (locationId && locationId !== String(appointment.locationId)) deny("COMMUNICATION_BRANCH_CHANGED");
    if (context.appointmentStatus && context.appointmentStatus !== appointment.status) deny("COMMUNICATION_SOURCE_CHANGED");
    if (context.communicationAction === "refund" && appointment.paymentStatus !== "refunded") deny("COMMUNICATION_SOURCE_CHANGED");
    appointmentTime = appointment.appointmentTime.toISOString();
    appointmentDoctorId = String(appointment.doctorId);
    communicationRevision = appointment.communicationRevision || 0;
    if (context.appointmentTime && context.appointmentTime !== appointmentTime || context.appointmentDoctorId && context.appointmentDoctorId !== appointmentDoctorId || context.communicationRevision !== void 0 && context.communicationRevision !== communicationRevision) deny("COMMUNICATION_SOURCE_CHANGED");
    appointmentStatus = appointment.status;
    patientId = String(appointment.patientId);
    locationId = String(appointment.locationId);
    if (["turn_approaching", "queue_delay", "queue_tracker"].includes(context.communicationAction || "")) {
      const zone = await getLocationTimezone(locationId);
      if (!["pending", "confirmed", "checked-in"].includes(appointmentStatus) || locationDateKey(appointment.appointmentTime, zone) !== locationDateKey(/* @__PURE__ */ new Date(), zone)) deny("COMMUNICATION_SOURCE_CHANGED");
    }
  }
  if (!patientId || !locationId) deny("COMMUNICATION_CONTEXT_REQUIRED");
  const [org, branch, patient, relationship] = await Promise.all([
    Organization.findById(organizationId).select("isActive status whatsappConfig.mode whatsappConfig.notifications").lean(),
    Location.findOne({ _id: locationId, organizationId }).select("isActive").lean(),
    getOrganizationPatient(patientId, organizationId),
    PatientRelationship.findOne({ patientId, organizationId }).lean()
  ]);
  if (!org || org.isActive === false || org.status === "inactive" || !branch || branch.isActive === false) deny("COMMUNICATION_WORKSPACE_INACTIVE");
  if (context.automated && !await crmEntitlementActive(organizationId)) deny("COMMUNICATION_ENTITLEMENT_INACTIVE");
  if (!patient || relationship?.status === "archived") deny("COMMUNICATION_SUBJECT_UNAVAILABLE");
  if (!context.appointmentId && String(relationship?.locationId || "") !== locationId) deny("COMMUNICATION_BRANCH_CHANGED");
  if (String(relationship?.locationId || "") !== locationId && !await Appointment.exists({ organizationId, locationId, patientId })) deny("COMMUNICATION_SUBJECT_UNAVAILABLE");
  if (relationship?.preferences?.doNotContact || relationship?.preferences?.preferredChannel === "none") deny("COMMUNICATION_DO_NOT_CONTACT");
  const selectedRecipient = await organizationCommunicationRecipient(patientId, organizationId);
  if (selectedRecipient.recipientType === "family" && (!selectedRecipient.available || selectedRecipient.familyAuthorityRevision === void 0)) deny("COMMUNICATION_FAMILY_REVIEW_REQUIRED");
  if (selectedRecipient.recipientType === "family" && (context.communicationAction || context.invoiceId)) deny("COMMUNICATION_FAMILY_CLINICAL_REVIEW_REQUIRED");
  if (context.familyRelationshipId && (context.familyRelationshipId !== selectedRecipient.familyRelationshipId || context.familyAuthorityRevision !== selectedRecipient.familyAuthorityRevision)) deny("COMMUNICATION_FAMILY_AUTHORITY_CHANGED");
  if (["unreachable", "invalid"].includes(relationship?.contact?.availability || "")) deny("COMMUNICATION_CONTACT_UNAVAILABLE");
  if (channel === "whatsapp" && patient.optOutWhatsApp) deny("PATIENT_OPTED_OUT_WHATSAPP");
  if (context.taskId) {
    const task = await TaskModel.findOne({ _id: context.taskId, organizationId, locationId, patientId }).select("status revision");
    if (!task || task.status === "completed") deny("COMMUNICATION_TASK_NO_LONGER_ACTIVE");
  }
  if (context.actorId) {
    const [member, actor] = await Promise.all([OrgMember.findOne({ userId: context.actorId, organizationId }).select("role").lean(), User.findById(context.actorId).select("isActive").lean()]);
    if (!member || !actor || actor.isActive === false) deny("COMMUNICATION_ACTOR_REVOKED");
    const permissions = await getEffectivePermissions(member.role, organizationId, 1, true);
    if (!permissions.has("COMMUNICATE_PATIENTS")) deny("COMMUNICATION_ACTOR_REVOKED");
    const grant = await resolveStaffLocationGrant(context.actorId, organizationId, member.role, true);
    if (grant && !grant.includes(locationId)) deny("COMMUNICATION_ACTOR_REVOKED");
  }
  const recipient = channel === "email" ? selectedRecipient.email : selectedRecipient.phone;
  if (!recipient) deny("COMMUNICATION_RECIPIENT_REQUIRED");
  const normalized = normalizedCommunicationRecipient(recipient, channel);
  if (channel === "email" ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) : !/^[1-9]\d{7,14}$/.test(normalized)) deny("COMMUNICATION_INVALID_RECIPIENT");
  if (intendedRecipient && normalized !== normalizedCommunicationRecipient(intendedRecipient, channel)) deny("COMMUNICATION_RECIPIENT_CHANGED");
  const familyBinding = selectedRecipient.recipientType === "family" ? `:family:${selectedRecipient.familyRelationshipId}:${selectedRecipient.familyAuthorityRevision}` : "";
  const recipientHash = computeBlindIndex(`${organizationId}:${patientId}:${channel}:${normalized}${familyBinding}`);
  if (context.recipientHash && context.recipientHash !== recipientHash) deny("COMMUNICATION_RECIPIENT_CHANGED");
  if (channel === "whatsapp") {
    if (org?.whatsappConfig?.mode === "disabled") deny("WHATSAPP_DISABLED_FOR_ORGANIZATION");
    const toggles = { booked: "sendBookingConfirmation", rescheduled: "sendBookingConfirmation", cancelled: "sendAppointmentCancellation", prescription: "sendConsultationComplete", disruption: "sendDisruptionAlert", refund: "sendDisruptionAlert", turn_approaching: "sendTurnApproaching", queue_delay: "sendQueueDelayAlert", queue_tracker: void 0 };
    const toggle = context.communicationAction ? toggles[context.communicationAction] : void 0;
    if (toggle && org?.whatsappConfig?.notifications?.[toggle] === false) deny("COMMUNICATION_CHANNEL_DISABLED");
    const senderScope = org?.whatsappConfig?.mode === "dedicated" ? organizationId : "platform";
    if (await WhatsAppRecipient.exists({ scope: senderScope, phoneHash: phoneHash(normalized), optedOut: true })) deny("PATIENT_OPTED_OUT_WHATSAPP");
  }
  const consent = await getPatientConsents(patientId, organizationId);
  const purposes = [channel === "email" ? "COMMUNICATION_EMAIL" : channel === "phone" ? "COMMUNICATION_PHONE" : "COMMUNICATION_WHATSAPP", ...context.purpose === "care_followup" ? ["PREVENTIVE_HEALTH_RECALLS"] : context.purpose === "feedback" ? ["FEEDBACK_AND_SURVEYS"] : []];
  if (purposes.some((purpose) => consent.purposes.find((row) => row.purpose === purpose)?.status !== "GRANTED")) deny("COMMUNICATION_CONSENT_REQUIRED");
  const evidence = await DPDPConsent.findOne({ patientId, organizationId, revision: consent.revision }).select("purposes.purpose purposes.evidence.activityId").lean();
  if (!evidence) deny("COMMUNICATION_CONSENT_CHANGED");
  const consentEvidenceHash = computeBlindIndex(JSON.stringify(purposes.map((purpose) => [purpose, evidence.purposes.find((row) => row.purpose === purpose)?.evidence?.activityId?.toString()])));
  if (context.consentEvidenceHash && context.consentEvidenceHash !== consentEvidenceHash) deny("COMMUNICATION_CONSENT_CHANGED");
  return { recipient: normalized, patient, context: {
    ...context,
    patientId,
    locationId,
    familyRelationshipId: selectedRecipient.familyRelationshipId,
    familyAuthorityRevision: selectedRecipient.familyAuthorityRevision,
    appointmentStatus: context.invoiceId ? void 0 : appointmentStatus,
    appointmentTime: context.invoiceId ? void 0 : appointmentTime,
    appointmentDoctorId: context.invoiceId ? void 0 : appointmentDoctorId,
    communicationRevision: context.invoiceId ? void 0 : communicationRevision,
    purpose: context.purpose || "care_operations",
    recipientHash,
    consentRevision: consent.revision,
    consentEvidenceHash
  } };
}
var CommunicationPolicyError, deny;
var init_PatientCommunicationPolicy = __esm({
  "services/PatientCommunicationPolicy.ts"() {
    "use strict";
    init_Appointment();
    init_PatientRelationship();
    init_Task();
    init_Organization();
    init_Location();
    init_PatientRecordAccessService();
    init_PatientConsentService();
    init_FamilyAuthorityService();
    init_cryptoEnvelope();
    init_OrgMember();
    init_User();
    init_LocationAccessService();
    init_permissions();
    init_WhatsAppRecipient();
    init_WhatsAppSendPolicy();
    init_DPDPConsent();
    init_CrmEntitlementService();
    init_Invoice();
    init_locationTime();
    CommunicationPolicyError = class extends Error {
      reason;
      constructor(reason) {
        super(reason);
        this.reason = reason;
        this.name = "CommunicationPolicyError";
      }
    };
    deny = (reason) => {
      throw new CommunicationPolicyError(reason);
    };
  }
});

// services/CrmAssignmentService.ts
async function validateCrmAssignee(userId, organizationId, locationId, permission = "VIEW_CRM") {
  const member = await OrgMember.findOne({ userId, organizationId }).lean();
  if (!member || ["patient", "family_member", "guest", "root"].includes(member.role) || !await User.exists({ _id: userId, isActive: true })) throw new CommandError(400, "Choose an active staff member in this workspace");
  const grant = await resolveStaffLocationGrant(userId, organizationId, member.role, true);
  if (grant !== void 0 && !grant.includes(locationId)) throw new CommandError(400, "The assignee does not have access to this branch");
  const permissions = await getEffectivePermissions(member.role, organizationId, 1, true);
  if (!permissions.has("VIEW_CRM") || !permissions.has(permission)) throw new CommandError(400, "The assignee does not have permission to work on this CRM item");
  return member;
}
var init_CrmAssignmentService = __esm({
  "services/CrmAssignmentService.ts"() {
    "use strict";
    init_OrgMember();
    init_User();
    init_LocationAccessService();
    init_CommandReceiptService();
    init_permissions();
  }
});

// services/CrmTaskService.ts
async function publishCrmTaskEvent(task, actorId) {
  await eventBus.publishDurable({
    eventId: `crm:task:${task.id}:${task.revision || 0}`,
    eventType: "crm.task.changed",
    category: "task",
    organizationId: String(task.organizationId),
    createdBy: actorId,
    targetUserId: task.assignedTo?.toString(),
    title: "Patient relationship task updated",
    message: "Review the current task in your authorized workspace.",
    actionUrl: `/dashboard/crm/tasks?taskId=${task.id}`,
    channels: { email: false, sms: false, push: false, inApp: true },
    metadata: { taskId: task.id, taskRevision: task.revision || 0, locationId: String(task.locationId) }
  });
}
async function createCrmTask(input) {
  let ownerId = input.assignedTo;
  if (ownerId) {
    try {
      await validateCrmAssignee(ownerId, input.organizationId, input.locationId, "MANAGE_CRM_TASKS");
    } catch (error) {
      if (error.statusCode !== 400) throw error;
      ownerId = void 0;
    }
  }
  const task = await TaskModel.findOneAndUpdate({ organizationId: input.organizationId, dedupeKey: input.dedupeKey }, { $setOnInsert: {
    organizationId: input.organizationId,
    locationId: input.locationId,
    patientId: input.patientId,
    inquiryId: input.inquiryId,
    appointmentId: input.appointmentId,
    orderId: input.orderId,
    createdBy: input.actorId,
    kind: input.kind,
    title: input.title,
    dueDate: input.dueDate,
    assignedTo: ownerId,
    needsAssignment: !ownerId,
    dedupeKey: input.dedupeKey,
    revision: 0,
    followUpReview: input.followUpReview
  } }, { upsert: true, returnDocument: "after", runValidators: true });
  await CrmActivity.updateOne({ organizationId: input.organizationId, eventKey: `task-created:${task.id}` }, { $setOnInsert: {
    organizationId: input.organizationId,
    locationId: input.locationId,
    patientId: input.patientId,
    inquiryId: input.inquiryId,
    appointmentId: input.appointmentId,
    taskId: task._id,
    actorId: input.actorId,
    kind: "task_created",
    eventKey: `task-created:${task.id}`
  } }, { upsert: true, runValidators: true });
  await publishCrmTaskEvent(task, input.actorId);
  return task;
}
var init_CrmTaskService = __esm({
  "services/CrmTaskService.ts"() {
    "use strict";
    init_Task();
    init_CrmActivity();
    init_eventBus();
    init_CrmAssignmentService();
  }
});

// services/CommunicationOutbox.ts
var CommunicationOutbox_exports = {};
__export(CommunicationOutbox_exports, {
  enqueueCommunicationTemplate: () => enqueueCommunicationTemplate,
  enqueueTransactionalEmail: () => enqueueTransactionalEmail,
  enqueueWhatsAppDocument: () => enqueueWhatsAppDocument,
  enqueueWhatsAppFreeform: () => enqueueWhatsAppFreeform,
  readCommunicationTemplate: () => readCommunicationTemplate,
  readEncryptedOutboundPayload: () => readEncryptedOutboundPayload
});
import crypto14 from "node:crypto";
function getCommunicationIdempotencyKey(options) {
  if (options.idempotencyKey) return options.idempotencyKey;
  const channel = options.channel || "whatsapp";
  if (options.appointmentId) return `${channel}_${options.appointmentId}_${options.templateId}`;
  const stablePayload = JSON.stringify({
    channel,
    phone: options.phone.trim(),
    templateId: options.templateId,
    patientName: options.patientName || "",
    variables: Object.entries(options.variables).sort(([a], [b]) => a.localeCompare(b))
  });
  return `communication:${crypto14.createHash("sha256").update(stablePayload).digest("hex")}`;
}
async function enqueueCommunicationTemplate(options) {
  if (options.templateId !== "OTP_VERIFICATION") {
    if (options.channel === "sms") throw new CommunicationPolicyError("COMMUNICATION_SMS_UNSUPPORTED");
    const context = options.communicationContext || (options.organizationId && options.appointmentId ? { organizationId: options.organizationId, appointmentId: options.appointmentId } : void 0);
    if (!context) throw new CommunicationPolicyError("COMMUNICATION_CONTEXT_REQUIRED");
    const decision = await patientCommunicationPolicy(context, "whatsapp", options.phone);
    if (decision.context.familyRelationshipId && !["CRM_CONTACT_REQUEST", "CRM_CARE_FOLLOWUP", "CRM_FEEDBACK_REQUEST"].includes(options.templateId)) throw new CommunicationPolicyError("COMMUNICATION_FAMILY_CLINICAL_REVIEW_REQUIRED");
    options = { ...options, organizationId: decision.context.organizationId, communicationContext: decision.context, phone: decision.recipient };
  }
  const idempotencyKey = getCommunicationIdempotencyKey(options);
  const normalized = {
    ...options,
    phone: options.phone.trim(),
    channel: options.channel || "whatsapp",
    idempotencyKey
  };
  try {
    return await OutboundMessage.findOneAndUpdate(
      { idempotencyKey },
      {
        $setOnInsert: {
          kind: "communication_template",
          idempotencyKey,
          // Retain only safe routing metadata in the normally selected field.
          payload: {
            channel: normalized.channel,
            templateId: normalized.templateId,
            appointmentId: normalized.appointmentId || null,
            organizationId: normalized.organizationId || null,
            ...normalized.communicationContext || {}
          },
          sensitivePayloadCiphertext: encryptField(JSON.stringify(normalized)),
          status: "pending",
          attempts: 0,
          maxAttempts: 5,
          nextAttemptAt: /* @__PURE__ */ new Date()
        }
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    );
  } catch (error) {
    if (error?.code === 11e3) {
      const existing = await OutboundMessage.findOne({ idempotencyKey });
      if (existing) return existing;
    }
    throw error;
  }
}
async function enqueueEncryptedOutbound(kind, idempotencyKey, payload, safeMetadata, session) {
  try {
    return await OutboundMessage.findOneAndUpdate(
      { idempotencyKey },
      {
        $setOnInsert: {
          kind,
          idempotencyKey,
          payload: safeMetadata,
          sensitivePayloadCiphertext: encryptField(JSON.stringify(payload)),
          status: "pending",
          attempts: 0,
          maxAttempts: 5,
          nextAttemptAt: /* @__PURE__ */ new Date()
        }
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, ...session ? { session } : {} }
    );
  } catch (error) {
    if (error?.code === 11e3) {
      const query = OutboundMessage.findOne({ idempotencyKey });
      const existing = await (session ? query.session(session) : query);
      if (existing) return existing;
    }
    throw error;
  }
}
async function enqueueWhatsAppDocument(options) {
  if (!options.communicationContext) throw new CommunicationPolicyError("COMMUNICATION_CONTEXT_REQUIRED");
  const decision = await patientCommunicationPolicy(options.communicationContext, "whatsapp", options.to);
  if (decision.context.familyRelationshipId) throw new CommunicationPolicyError("COMMUNICATION_FAMILY_CLINICAL_REVIEW_REQUIRED");
  options = { ...options, organizationId: decision.context.organizationId, communicationContext: decision.context, to: decision.recipient };
  const idempotencyKey = options.idempotencyKey || `whatsapp-document:${crypto14.createHash("sha256").update(JSON.stringify([options.to, options.documentUrl, options.filename, options.caption || ""])).digest("hex")}`;
  return enqueueEncryptedOutbound(
    "whatsapp_document",
    idempotencyKey,
    { ...options, to: options.to.trim(), idempotencyKey },
    { deliveryType: "document", ...decision.context }
  );
}
async function enqueueWhatsAppFreeform(options) {
  if (!options.communicationContext) throw new CommunicationPolicyError("COMMUNICATION_CONTEXT_REQUIRED");
  const decision = await patientCommunicationPolicy(options.communicationContext, "whatsapp", options.to);
  if (decision.context.familyRelationshipId) throw new CommunicationPolicyError("COMMUNICATION_FAMILY_CLINICAL_REVIEW_REQUIRED");
  options = { ...options, organizationId: decision.context.organizationId, communicationContext: decision.context, to: decision.recipient };
  const idempotencyKey = options.idempotencyKey || `whatsapp-freeform:${crypto14.createHash("sha256").update(JSON.stringify([options.to, options.text])).digest("hex")}`;
  return enqueueEncryptedOutbound(
    "whatsapp_freeform",
    idempotencyKey,
    { ...options, to: options.to.trim(), idempotencyKey },
    { deliveryType: "freeform", ...decision.context }
  );
}
async function enqueueTransactionalEmail(options) {
  if (options.communicationContext) {
    const decision = await patientCommunicationPolicy(options.communicationContext, "email", options.to);
    options = { ...options, communicationContext: decision.context, to: decision.recipient };
  }
  const { session, ...email } = options;
  const normalized = { ...email, to: email.to.trim() };
  const idempotencyKey = options.idempotencyKey || `transactional-email:${crypto14.createHash("sha256").update(JSON.stringify([normalized.to.toLowerCase(), normalized.subject, normalized.text || "", normalized.html, normalized.from || ""])).digest("hex")}`;
  return enqueueEncryptedOutbound(
    "transactional_email",
    idempotencyKey,
    { ...normalized, idempotencyKey },
    { deliveryType: "transactional_email", ...options.communicationContext || {} },
    session
  );
}
function readEncryptedOutboundPayload(message) {
  if (!message.sensitivePayloadCiphertext) {
    throw new Error("Outbound message payload is missing or was not selected");
  }
  return JSON.parse(decryptField(message.sensitivePayloadCiphertext));
}
function readCommunicationTemplate(message) {
  const parsed = readEncryptedOutboundPayload(message);
  if (!parsed?.phone || !parsed?.templateId || !parsed?.variables) {
    throw new Error("Communication outbox payload is invalid");
  }
  return parsed;
}
var init_CommunicationOutbox = __esm({
  "services/CommunicationOutbox.ts"() {
    "use strict";
    init_cryptoEnvelope();
    init_OutboundMessage();
    init_PatientCommunicationPolicy();
  }
});

// utilities/publicTracker.ts
import crypto15 from "node:crypto";
function createTrackerCapability() {
  const token = crypto15.randomBytes(32).toString("base64url");
  return { token, hash: hashTrackerCapability(token) };
}
async function issueAppointmentTrackerLink(appointment, options = {}) {
  const ttlDays = options.ttlDays ?? 30;
  if (!Number.isFinite(ttlDays) || ttlDays <= 0 || ttlDays > 90) throw new Error("Invalid tracker lifetime");
  const pathPrefix = options.pathPrefix || "/track";
  if (Appointment.db.readyState === 1) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await Appointment.findById(appointment._id).select("+trackerTokenHash +trackerTokenCiphertext trackerTokenExpiresAt");
      if (!current) break;
      if (!options.rotate && current.trackerTokenCiphertext && current.trackerTokenExpiresAt && current.trackerTokenExpiresAt > /* @__PURE__ */ new Date()) {
        const token = decryptField(current.trackerTokenCiphertext);
        if (hashTrackerCapability(token) !== current.trackerTokenHash) throw new Error("Tracker capability requires review");
        appointment.trackerTokenHash = current.trackerTokenHash;
        appointment.trackerTokenExpiresAt = current.trackerTokenExpiresAt;
        return { token, url: `${pathPrefix}/${appointment._id}#t=${encodeURIComponent(token)}` };
      }
      const next = createTrackerCapability(), expiresAt = new Date(Date.now() + ttlDays * 864e5);
      const changed = await Appointment.findOneAndUpdate(
        { _id: current._id, trackerTokenHash: current.trackerTokenHash || null, trackerTokenCiphertext: current.trackerTokenCiphertext || null },
        { $set: { trackerTokenHash: next.hash, trackerTokenCiphertext: next.token, trackerTokenExpiresAt: expiresAt } },
        { returnDocument: "after" }
      );
      if (!changed) continue;
      appointment.trackerTokenHash = next.hash;
      appointment.trackerTokenExpiresAt = expiresAt;
      return { token: next.token, url: `${pathPrefix}/${appointment._id}#t=${encodeURIComponent(next.token)}` };
    }
    throw new Error("Tracker source changed or is unavailable; reload before issuing a link");
  }
  const capability = createTrackerCapability();
  appointment.trackerTokenHash = capability.hash;
  appointment.trackerTokenExpiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1e3);
  if (typeof appointment.save === "function") {
    await appointment.save();
  }
  const url = `${pathPrefix}/${appointment._id}#t=${encodeURIComponent(capability.token)}`;
  return { token: capability.token, url };
}
function appendTrackerCapability(url, token) {
  const isApi = url.includes("/api/");
  if (isApi) {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}trackerToken=${encodeURIComponent(token)}`;
  }
  return `${url}#t=${encodeURIComponent(token)}`;
}
function hashTrackerCapability(token) {
  return crypto15.createHash("sha256").update(token).digest("hex");
}
var init_publicTracker = __esm({
  "utilities/publicTracker.ts"() {
    "use strict";
    init_Appointment();
    init_cryptoEnvelope();
  }
});

// services/PrescriptionCommunicationService.ts
async function queuePrescriptionCommunication(input) {
  const result = await executeRecordedCommand(`prescription-communication:${input.organizationId}:${input.actorId}`, input.clientRequestId, input, async () => {
    const appointment = await Appointment.findOne({ _id: input.appointmentId, organizationId: input.organizationId });
    if (!appointment || appointment.status !== "completed") throw new CommandError(409, "Only a completed visit can queue its existing prescription");
    const decision = await patientCommunicationPolicy({ ...input.communicationContext, organizationId: input.organizationId, appointmentId: input.appointmentId, actorId: input.actorId, purpose: "care_operations", communicationAction: "prescription" }, "whatsapp", input.phone);
    const capability = await issueAppointmentTrackerLink(appointment);
    const queued2 = await enqueueWhatsAppDocument({ to: decision.recipient, organizationId: input.organizationId, communicationContext: decision.context, documentUrl: appendTrackerCapability(`/api/public/track/${appointment.id}/prescription/print`, capability.token), filename: "Prescription.pdf", caption: "Your clinic document is ready.", idempotencyKey: `rx:${input.organizationId}:${input.appointmentId}:${input.actorId}:${input.clientRequestId}` });
    if (!queued2) throw new Error("Prescription queue persistence failed");
    await AuditLog.create({ organizationId: input.organizationId, userId: input.actorId, category: "CLINICAL_WRITE", action: "PRESCRIPTION_NOTIFICATION_QUEUED", targetId: appointment._id, targetModel: "Appointment", details: { outboxId: queued2.id, channel: "whatsapp" } });
    return queued2.id;
  });
  const queued = await OutboundMessage.findOne({ _id: result.resultId, "payload.organizationId": input.organizationId });
  if (!queued) throw new CommandError(404, "Prescription message is no longer available");
  return { appointmentId: input.appointmentId, outboxId: queued.id, channel: "whatsapp", status: queued.status, replayed: result.replayed };
}
var init_PrescriptionCommunicationService = __esm({
  "services/PrescriptionCommunicationService.ts"() {
    "use strict";
    init_Appointment();
    init_OutboundMessage();
    init_AuditLog();
    init_CommandReceiptService();
    init_PatientCommunicationPolicy();
    init_CommunicationOutbox();
    init_publicTracker();
  }
});

// utilities/manualNotificationContent.ts
function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
var init_manualNotificationContent = __esm({
  "utilities/manualNotificationContent.ts"() {
    "use strict";
  }
});

// services/AppointmentCommunicationEvents.ts
async function review(context, key) {
  if (!await Location.exists({ _id: context.locationId, organizationId: context.organizationId, isActive: true })) return;
  const relationship = await PatientRelationship.findOne({ organizationId: context.organizationId, patientId: context.patientId, locationId: context.locationId, status: "active" }).select("ownerId").lean();
  await createCrmTask({ organizationId: context.organizationId, locationId: context.locationId, patientId: context.patientId, appointmentId: context.appointmentId, actorId: context.actorId, kind: "crm_review", title: "Review unavailable appointment communication", dueDate: /* @__PURE__ */ new Date(), assignedTo: relationship?.ownerId?.toString(), dedupeKey: `communication-event-review:${key}` });
}
async function publishAppointmentCommunication(appointment, input, session) {
  const organizationId = ref(appointment.organizationId), appointmentId = ref(appointment._id);
  const source = await Appointment.findOneAndUpdate({ _id: appointmentId, organizationId }, { $inc: { communicationRevision: 1 } }, { returnDocument: "after", ...session ? { session } : {} });
  if (!source) throw new Error("Appointment communication source missing");
  appointment.communicationRevision = source.communicationRevision;
  const context = { organizationId, appointmentId, patientId: ref(source.patientId), locationId: ref(source.locationId), actorId: input.actorId, purpose: "care_operations", communicationAction: input.action, automated: true };
  const channels = [];
  for (const channel of input.action === "prescription" ? ["whatsapp"] : ["whatsapp", "email"]) {
    try {
      channels.push({ channel, context: (await patientCommunicationPolicy(context, channel, channel === "whatsapp" ? input.intendedPhone : void 0)).context });
    } catch (error) {
      if (!(error instanceof CommunicationPolicyError)) throw error;
    }
  }
  const key = `crm:appointment:${appointmentId}:${source.communicationRevision}:${input.action}`;
  if (!channels.length) await review(context, key);
  const patient = await Patient.findById(source.patientId).select("userId").setOptions({ bypassTenantFilter: true }).lean();
  if (patient?.userId) await eventBus.publishDurable({
    eventId: `${key}:inApp`,
    eventType: "crm.appointment.inbox",
    category: "patient",
    organizationId,
    createdBy: input.actorId,
    targetUserId: String(patient.userId),
    title: "Visit update",
    message: "Open your appointments to review the current visit.",
    channels: { inApp: true, email: false, sms: false, push: false },
    metadata: { appointmentId, patientId: String(source.patientId), context: { communicationRevision: source.communicationRevision } }
  }, session);
  await eventBus.publishDurable({ eventId: key, eventType: "crm.appointment.communication", category: "patient", organizationId, createdBy: input.actorId, metadata: { action: input.action, context, channels } }, session);
}
async function handleAppointmentCommunication(event) {
  const metadata = event.metadata;
  if (!event.eventId || !event.organizationId || !metadata?.context || metadata.context.organizationId !== event.organizationId || !Array.isArray(metadata.channels)) throw new Error("Invalid appointment communication event");
  for (const entry of metadata.channels) await withTransaction(async () => {
    if (!["whatsapp", "email"].includes(entry.channel) || entry.context?.organizationId !== event.organizationId || entry.context?.appointmentId !== metadata.context.appointmentId || !entry.context?.recipientHash || !entry.context?.consentEvidenceHash) throw new Error("Invalid pinned communication context");
    const key = `${event.eventId}:${entry.channel}`;
    if (await OutboundMessage.exists({ idempotencyKey: key, "payload.organizationId": event.organizationId })) return;
    try {
      const decision = await patientCommunicationPolicy(entry.context, entry.channel);
      const appointment = await Appointment.findOne({ _id: decision.context.appointmentId, organizationId: event.organizationId });
      if (!appointment) throw new CommunicationPolicyError("COMMUNICATION_SOURCE_CHANGED");
      const queueAction = ["turn_approaching", "queue_delay"].includes(metadata.action);
      const zone = await getLocationTimezone(String(appointment.locationId));
      if (queueAction && (!["pending", "confirmed", "checked-in"].includes(appointment.status) || locationDateKey(appointment.appointmentTime, zone) !== locationDateKey(/* @__PURE__ */ new Date(), zone))) throw new CommunicationPolicyError("COMMUNICATION_SOURCE_CHANGED");
      if (metadata.action === "prescription") {
        if (!decision.context.actorId) throw new CommunicationPolicyError("COMMUNICATION_ACTOR_REVOKED");
        const result = await queuePrescriptionCommunication({ appointmentId: appointment.id, organizationId: event.organizationId, actorId: decision.context.actorId, clientRequestId: `completion_${appointment.id}`, communicationContext: entry.context });
        if (["pending", "processing", "retrying", "accepted"].includes(result.status)) await Appointment.updateOne({ _id: appointment._id, organizationId: event.organizationId }, { $set: { rxQueuedAt: /* @__PURE__ */ new Date() } });
        return;
      }
      const [location2, doctor, org] = await Promise.all([Location.findOne({ _id: appointment.locationId, organizationId: event.organizationId }).select("name").lean(), User.findById(appointment.doctorId).select("name").lean(), Organization.findById(event.organizationId).select("whatsappConfig.notifications").lean()]);
      const time = appointment.appointmentTime.toLocaleString("en-US", { timeZone: await getLocationTimezone(String(appointment.locationId)), dateStyle: "medium", timeStyle: "short" });
      const state = appointment.status === "pending_payment" ? "awaiting payment" : appointment.status === "pending" ? "requested" : appointment.status === "disruption_triage" ? "requires staff assistance" : appointment.status;
      const text = `Your appointment at ${location2?.name || "your clinic"} ${metadata.action === "rescheduled" ? "was rescheduled and " : ""}is ${state}. Scheduled time: ${time}.${metadata.action === "refund" ? " Its refund has been recorded as processed." : ""} Contact reception for assistance.`;
      if (entry.channel === "email") {
        const html = `<p>${escapeHtml(text)}</p>`;
        await enqueueTransactionalEmail({ to: decision.recipient, subject: `Appointment ${state}`, text, html, idempotencyKey: key, communicationContext: decision.context });
      } else {
        const toggle = queueAction ? metadata.action === "queue_delay" ? "sendQueueDelayAlert" : "sendTurnApproaching" : metadata.action === "cancelled" ? "sendAppointmentCancellation" : ["disruption", "refund"].includes(metadata.action) ? "sendDisruptionAlert" : "sendBookingConfirmation";
        if (org?.whatsappConfig?.notifications?.[toggle] === false) return;
        const templateId = queueAction ? metadata.action === "queue_delay" ? "QUEUE_DELAY_ALERT" : "QUEUE_UPDATE" : metadata.action === "cancelled" ? "APPOINTMENT_CANCELLED" : appointment.status === "confirmed" ? "BOOKING_CONFIRMATION" : "CRM_CONTACT_REQUEST";
        const queueVariables = {};
        if (queueAction) {
          const range = locationDayRange(locationDateKey(/* @__PURE__ */ new Date(), zone), zone);
          const ahead = await Appointment.countDocuments({ organizationId: event.organizationId, locationId: appointment.locationId, doctorId: appointment.doctorId, appointmentTime: { $gte: range.start, $lt: range.end }, status: { $in: ["checked-in", "confirmed"] }, queuePosition: { $lt: appointment.queuePosition ?? appointment.tokenNumber }, _id: { $ne: appointment._id } });
          queueVariables.peopleAhead = String(ahead);
          if (metadata.action === "queue_delay") {
            if (!appointment.lastNotifiedDelayMinutes || appointment.lastNotifiedDelayMinutes <= 0) throw new CommunicationPolicyError("COMMUNICATION_SOURCE_CHANGED");
            queueVariables.delayMinutes = String(appointment.lastNotifiedDelayMinutes);
          }
          queueVariables.trackingUrl = (await issueAppointmentTrackerLink(appointment)).url;
        }
        await enqueueCommunicationTemplate({ organizationId: event.organizationId, appointmentId: appointment.id, communicationContext: decision.context, phone: decision.recipient, channel: "whatsapp", templateId, patientName: decision.patient?.name || "Patient", variables: { patientName: decision.patient?.name || "Patient", locationName: location2?.name || "Your clinic", doctorName: doctor?.name || "Doctor", appointmentTime: time, tokenNumber: String(appointment.tokenNumber), ...queueVariables }, idempotencyKey: key });
      }
    } catch (error) {
      if (!(error instanceof CommunicationPolicyError)) throw error;
      await review(entry.context, key);
    }
  });
}
var ref;
var init_AppointmentCommunicationEvents = __esm({
  "services/AppointmentCommunicationEvents.ts"() {
    "use strict";
    init_eventBus();
    init_Appointment();
    init_Location();
    init_User();
    init_Patient();
    init_Organization();
    init_PatientRelationship();
    init_OutboundMessage();
    init_PatientCommunicationPolicy();
    init_CrmTaskService();
    init_CommunicationOutbox();
    init_PrescriptionCommunicationService();
    init_transaction();
    init_locationTime();
    init_manualNotificationContent();
    init_publicTracker();
    init_locationTime();
    ref = (value) => String(value?._id || value);
    eventBus.subscribe("crm.appointment.communication", handleAppointmentCommunication);
  }
});

// models/Doctor.ts
var Doctor_exports = {};
__export(Doctor_exports, {
  Doctor: () => Doctor
});
import mongoose40, { Schema as Schema36 } from "mongoose";
var DoctorSchema, Doctor;
var init_Doctor = __esm({
  "models/Doctor.ts"() {
    "use strict";
    DoctorSchema = new Schema36({
      userId: { type: Schema36.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
      organizationId: { type: Schema36.Types.ObjectId, ref: "Organization", required: true, index: true },
      specialization: { type: String },
      qualification: { type: String },
      experience_years: { type: Number },
      fees: { type: Number, default: 0 },
      feeType: { type: String, enum: ["fixed", "post_consultation", "free"], default: "fixed" },
      timings: { type: String },
      // JSON string of schedule
      working_days: { type: String },
      // JSON string
      description: { type: String },
      image_url: { type: String },
      rating: { type: Number, default: 5 },
      reviewsCount: { type: Number, default: 0 },
      registrationNumber: { type: String, trim: true },
      digitalSignatureUrl: { type: String, trim: true },
      letterheadDefaultMode: { type: String, enum: ["plain_a4", "preprinted_stationery"], default: "plain_a4" },
      cabinNumber: { type: String, default: "Cabin 1" },
      isActive: { type: Boolean, default: true, index: true },
      languages: [{ type: String, default: "English" }]
    });
    DoctorSchema.virtual("id").get(function() {
      return this._id.toHexString();
    });
    DoctorSchema.set("toJSON", {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    });
    Doctor = mongoose40.model("Doctor", DoctorSchema);
  }
});

// models/UsageRecord.ts
import mongoose47, { Schema as Schema43 } from "mongoose";
var UsageRecordSchema, UsageRecord;
var init_UsageRecord = __esm({
  "models/UsageRecord.ts"() {
    "use strict";
    UsageRecordSchema = new Schema43({
      organizationId: { type: Schema43.Types.ObjectId, ref: "Organization", required: true, unique: true, index: true },
      locationsCount: { type: Number, default: 0 },
      doctorsCount: { type: Number, default: 0 },
      staffCount: { type: Number, default: 0 },
      patientsCount: { type: Number, default: 0 },
      appointmentsCount: { type: Number, default: 0 },
      storageUsedBytes: { type: Number, default: 0 },
      whatsappSentCount: { type: Number, default: 0 },
      whatsappDeliveredCount: { type: Number, default: 0 },
      whatsappFailedCount: { type: Number, default: 0 },
      lastCalculatedAt: { type: Date, default: Date.now }
    }, { timestamps: true });
    UsageRecordSchema.virtual("id").get(function() {
      return this._id.toHexString();
    });
    UsageRecordSchema.set("toJSON", {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    });
    UsageRecord = mongoose47.model("UsageRecord", UsageRecordSchema);
  }
});

// events/types.ts
var types_exports = {};
__export(types_exports, {
  EVENT_TYPES: () => EVENT_TYPES
});
var EVENT_TYPES;
var init_types = __esm({
  "events/types.ts"() {
    "use strict";
    EVENT_TYPES = {
      // Ekavyu Architecture Domain Events
      PATIENT_REGISTERED: "ekavyu.patient.registered",
      CONSENT_GRANTED: "ekavyu.consent.granted",
      CONSENT_REVOKED: "ekavyu.consent.revoked",
      CLINICAL_ENCOUNTER_STARTED: "ekavyu.clinical.encounter.started",
      CLINICAL_ENCOUNTER_COMPLETED: "ekavyu.clinical.encounter.completed",
      CLINICAL_NOTE_SIGNED: "ekavyu.clinical.note.signed",
      CLINICAL_PRESCRIPTION_SIGNED: "ekavyu.clinical.prescription.signed",
      DOCUMENT_UPLOADED: "ekavyu.document.uploaded",
      DOCUMENT_OCR_COMPLETED: "ekavyu.document.ocr_completed",
      LAB_RESULT_VERIFIED: "ekavyu.lab.result_verified",
      // Auth
      AUTH_LOGIN_NEW_DEVICE: "AUTH_LOGIN_NEW_DEVICE",
      AUTH_PASSWORD_CHANGED: "AUTH_PASSWORD_CHANGED",
      AUTH_EMAIL_VERIFIED: "AUTH_EMAIL_VERIFIED",
      // Organization
      ORG_CREATED: "ORG_CREATED",
      ORG_MEMBER_INVITED: "ORG_MEMBER_INVITED",
      ORG_INVITE_ACCEPTED: "ORG_INVITE_ACCEPTED",
      ORG_MEMBER_REMOVED: "ORG_MEMBER_REMOVED",
      ORG_ROLE_CHANGED: "ORG_ROLE_CHANGED",
      // Tasks
      TASK_ASSIGNED: "TASK_ASSIGNED",
      TASK_MENTIONED: "TASK_MENTIONED",
      TASK_DUE_TODAY: "TASK_DUE_TODAY",
      TASK_OVERDUE: "TASK_OVERDUE",
      TASK_STATUS_CHANGED: "TASK_STATUS_CHANGED",
      // Healthcare / Patient
      PATIENT_APPOINTMENT_BOOKED: "PATIENT_APPOINTMENT_BOOKED",
      PATIENT_APPOINTMENT_CHECKED_IN: "PATIENT_APPOINTMENT_CHECKED_IN",
      PATIENT_APPOINTMENT_CANCELLED: "PATIENT_APPOINTMENT_CANCELLED",
      PATIENT_CALL_NEXT: "PATIENT_CALL_NEXT",
      PATIENT_LAB_RESULT_READY: "PATIENT_LAB_RESULT_READY",
      PATIENT_CRITICAL_ALERT: "PATIENT_CRITICAL_ALERT",
      DOCTOR_DISRUPTION_OCCURRED: "doctor.disruption.occurred",
      PATIENT_DISRUPTION_NOTIFIED: "patient.disruption.notified",
      PATIENT_DISRUPTION_TRIAGED: "patient.disruption.triaged",
      PATIENT_TRANSFERRED_DOCTOR: "patient.transferred.doctor",
      PATIENT_DISRUPTION_CANCELLED: "patient.disruption.cancelled",
      PATIENT_PRIORITY_RESCHEDULED: "patient.disruption.rescheduled",
      PATIENT_DISRUPTION_REFUNDED: "patient.disruption.refunded",
      // Billing
      BILLING_TRIAL_ENDING: "BILLING_TRIAL_ENDING",
      BILLING_PAYMENT_FAILED: "BILLING_PAYMENT_FAILED",
      BILLING_INVOICE_GENERATED: "BILLING_INVOICE_GENERATED",
      // Security
      SECURITY_SUSPICIOUS_LOGIN: "SECURITY_SUSPICIOUS_LOGIN",
      SECURITY_MFA_TOGGLED: "SECURITY_MFA_TOGGLED",
      // System
      SYSTEM_ALERT: "SYSTEM_ALERT",
      SYSTEM_MAINTENANCE: "SYSTEM_MAINTENANCE"
    };
  }
});

// models/LabOrder.ts
var LabOrder_exports = {};
__export(LabOrder_exports, {
  LabOrder: () => LabOrder
});
import mongoose52, { Schema as Schema45 } from "mongoose";
var LabOrderSchema, LabOrder;
var init_LabOrder = __esm({
  "models/LabOrder.ts"() {
    "use strict";
    init_tenantPlugin();
    LabOrderSchema = new Schema45({
      // ─── Multi-Tenant Isolation ────────────────────────────────────
      organizationId: { type: Schema45.Types.ObjectId, ref: "Organization" },
      locationId: { type: Schema45.Types.ObjectId, ref: "Location", required: true, index: true },
      // ─── Encounter Aggregate Root Linkage ──────────────────────────
      // Optional for standalone laboratory orders
      encounterId: { type: Schema45.Types.ObjectId, ref: "Encounter", index: true, default: null },
      appointmentId: { type: Schema45.Types.ObjectId, ref: "Appointment", default: null },
      // ─── Clinical Context ──────────────────────────────────────────
      patientId: { type: Schema45.Types.ObjectId, ref: "Patient", required: true, index: true },
      testId: { type: Schema45.Types.ObjectId, ref: "LabTest", required: true, index: true },
      priority: { type: String, enum: ["routine", "urgent", "stat"], default: "routine" },
      clinicalReason: { type: String, default: "" },
      // Why the test was ordered
      // ─── Accountability (distinct roles) ───────────────────────────
      orderedBy: { type: Schema45.Types.ObjectId, ref: "User", index: true, default: null },
      collectedBy: { type: Schema45.Types.ObjectId, ref: "User", default: null },
      resultedBy: { type: Schema45.Types.ObjectId, ref: "User", default: null },
      // Primary Ordering Physician reference
      doctorId: { type: Schema45.Types.ObjectId, ref: "User", index: true },
      // ─── Lifecycle Status ──────────────────────────────────────────
      status: {
        type: String,
        enum: ["ordered", "sample-collected", "processing", "result-uploaded", "cancelled"],
        default: "ordered",
        index: true
      },
      // ─── Lifecycle Timestamps ──────────────────────────────────────
      orderDate: { type: Date, default: Date.now },
      sampleCollectedAt: { type: Date, default: null },
      processingStartedAt: { type: Date, default: null },
      resultedAt: { type: Date, default: null },
      // Structured diagnostic result
      result: {
        value: { type: String, default: "" },
        unit: { type: String, default: "" },
        // e.g. "mmol/L", "g/dL"
        referenceRange: { type: String, default: "" },
        // e.g. "3.5–5.0"
        interpretation: {
          type: String,
          enum: ["normal", "low", "high", "critical", "indeterminate", ""],
          default: ""
        },
        isAbnormal: { type: Boolean, default: false },
        // true if outside reference range
        notes: { type: String, default: "" },
        attachmentUrl: { type: String, default: "" }
      },
      // ─── Cancellation Accountability ───────────────────────────────
      cancellationReason: { type: String, default: "" },
      // required when status = "cancelled"
      deletedAt: { type: Date, default: null, index: true },
      createdAt: { type: Date, default: Date.now }
    }, { timestamps: true });
    LabOrderSchema.index({ appointmentId: 1, status: 1 });
    LabOrderSchema.index({ organizationId: 1, patientId: 1, createdAt: -1 });
    LabOrderSchema.index({ organizationId: 1, locationId: 1, status: 1, createdAt: -1 });
    LabOrderSchema.plugin(tenantPlugin);
    LabOrderSchema.virtual("id").get(function() {
      return this._id.toHexString();
    });
    LabOrderSchema.set("toJSON", {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    });
    LabOrder = mongoose52.models.LabOrder || mongoose52.model("LabOrder", LabOrderSchema);
  }
});

// models/Encounter.ts
var Encounter_exports = {};
__export(Encounter_exports, {
  Encounter: () => Encounter
});
import mongoose53, { Schema as Schema46 } from "mongoose";
var EncounterSchema, Encounter;
var init_Encounter = __esm({
  "models/Encounter.ts"() {
    "use strict";
    EncounterSchema = new Schema46({
      organizationId: { type: Schema46.Types.ObjectId, ref: "Organization", required: true },
      locationId: { type: Schema46.Types.ObjectId, ref: "Location", required: true, index: true },
      appointmentId: { type: Schema46.Types.ObjectId, ref: "Appointment", index: true },
      patientId: { type: Schema46.Types.ObjectId, ref: "Patient", required: true },
      doctorId: { type: Schema46.Types.ObjectId, ref: "User", required: true, index: true },
      encounterType: { type: String, enum: ["opd", "ipd", "emergency", "telehealth"], default: "opd" },
      status: { type: String, enum: ["scheduled", "in_progress", "completed", "cancelled", "closed"], default: "in_progress", index: true },
      startedAt: { type: Date, default: Date.now },
      endedAt: { type: Date },
      deletedAt: { type: Date, default: null, index: true },
      createdAt: { type: Date, default: Date.now }
    }, { timestamps: true });
    EncounterSchema.index({ organizationId: 1, appointmentId: 1, status: 1 });
    EncounterSchema.index({ locationId: 1, status: 1 });
    EncounterSchema.index({ patientId: 1, createdAt: -1 });
    EncounterSchema.index({ organizationId: 1, locationId: 1, status: 1, createdAt: -1 });
    EncounterSchema.virtual("id").get(function() {
      return this._id.toHexString();
    });
    EncounterSchema.set("toJSON", {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    });
    Encounter = mongoose53.model("Encounter", EncounterSchema);
  }
});

// services/DiagnosticHandoffService.ts
async function syncDiagnosticHandoff(orderId, actorId) {
  const order = await LabOrder.findById(orderId).select("organizationId locationId patientId appointmentId encounterId status deletedAt").lean();
  if (!order || order.deletedAt) throw new Error("Diagnostic source unavailable");
  const branch = await Location.findById(order.locationId).select("organizationId").lean();
  if (!branch || order.organizationId && String(order.organizationId) !== String(branch.organizationId)) throw new Error("Diagnostic source organization mismatch");
  const organizationId = String(branch.organizationId), locationId = String(order.locationId), patientId = String(order.patientId);
  const patient = await getOrganizationPatient(patientId, organizationId);
  if (!patient) throw new Error("Diagnostic patient organization mismatch");
  let appointmentId = order.appointmentId?.toString();
  if (order.encounterId) {
    const encounter = await Encounter.findOne({ _id: order.encounterId, organizationId, locationId, patientId }).select("appointmentId").lean();
    if (!encounter || appointmentId && encounter.appointmentId && appointmentId !== String(encounter.appointmentId)) throw new Error("Diagnostic encounter mismatch");
    appointmentId ||= encounter.appointmentId?.toString();
  }
  if (appointmentId && !await Appointment.exists({ _id: appointmentId, organizationId, locationId, patientId })) throw new Error("Diagnostic visit mismatch");
  const relationship = await PatientRelationship.findOne({ organizationId, patientId, locationId, status: "active" }).select("ownerId").lean();
  const terminal = ["result-uploaded", "cancelled"].includes(order.status);
  const waitingKey = `diagnostic:${orderId}:waiting`;
  if (terminal) {
    const task = await TaskModel.findOneAndUpdate({ organizationId, dedupeKey: waitingKey, status: { $ne: "completed" } }, { $set: { status: "completed", completedAt: /* @__PURE__ */ new Date(), outcome: order.status === "cancelled" ? "source_cancelled" : "source_result_ready" }, $inc: { revision: 1 }, $unset: { snoozedUntil: 1 } }, { returnDocument: "after" });
    if (task) await publishCrmTaskEvent(task, actorId);
  } else {
    await createCrmTask({ organizationId, locationId, patientId, appointmentId, orderId, actorId, kind: "crm_diagnostic", title: "Coordinate diagnostic order handoff", dueDate: /* @__PURE__ */ new Date(), assignedTo: relationship?.ownerId?.toString(), dedupeKey: waitingKey });
  }
  if (order.status === "result-uploaded") await createCrmTask({ organizationId, locationId, patientId, appointmentId, orderId, actorId, kind: "crm_diagnostic", title: "Coordinate diagnostic follow-through with clinical staff", dueDate: /* @__PURE__ */ new Date(), assignedTo: relationship?.ownerId?.toString(), dedupeKey: `diagnostic:${orderId}:ready` });
  const eventKey = `diagnostic:${orderId}:${order.status}`;
  await CrmActivity.updateOne({ organizationId, eventKey }, { $setOnInsert: { organizationId, locationId, patientId, appointmentId, actorId, kind: "diagnostic_handoff", outcome: order.status, eventKey } }, { upsert: true });
  if (patient.userId) await eventBus.publishDurable({
    eventId: `${eventKey}:inApp`,
    eventType: "crm.diagnostic.inbox",
    organizationId,
    category: "labs",
    targetUserId: String(patient.userId._id || patient.userId),
    createdBy: actorId,
    title: "Diagnostic order update",
    message: "Open your diagnostic orders to review their current state.",
    channels: { inApp: true, email: false, sms: false, push: false },
    metadata: { orderId, patientId, locationId, context: { orderStatus: order.status } }
  });
}
var init_DiagnosticHandoffService = __esm({
  "services/DiagnosticHandoffService.ts"() {
    "use strict";
    init_LabOrder();
    init_Location();
    init_PatientRecordAccessService();
    init_PatientRelationship();
    init_Encounter();
    init_Appointment();
    init_Task();
    init_CrmActivity();
    init_CrmTaskService();
    init_eventBus();
  }
});

// utilities/tenant.ts
var tenant_exports = {};
__export(tenant_exports, {
  checkLocationAccess: () => checkLocationAccess,
  checkOperationalRecordAccess: () => checkOperationalRecordAccess,
  checkPatientAccess: () => checkPatientAccess,
  getRequestLocationIds: () => getRequestLocationIds,
  getRequestOrganizationId: () => getRequestOrganizationId,
  isRootRequest: () => isRootRequest,
  resolveAuthorizedOrganizationScope: () => resolveAuthorizedOrganizationScope,
  resolveTargetOrganizationId: () => resolveTargetOrganizationId
});
import mongoose54 from "mongoose";
function getRequestOrganizationId(req) {
  const organizationId = req.user?.organization_id;
  return organizationId && mongoose54.Types.ObjectId.isValid(organizationId) ? organizationId : void 0;
}
function isRootRequest(req) {
  return req.user?.role === "root";
}
async function resolveTargetOrganizationId(req) {
  const scope = resolveAuthorizedOrganizationScope(req);
  if (scope.allowed && scope.organizationId) return scope.organizationId;
  if (isRootRequest(req)) {
    const locationId = req.query?.locationId || req.query?.location_id || req.body?.locationId || req.body?.location_id;
    if (locationId && mongoose54.Types.ObjectId.isValid(locationId)) {
      const location2 = await Location.findById(locationId).select("organizationId").lean();
      if (location2?.organizationId) return location2.organizationId.toString();
    }
  }
  return void 0;
}
function resolveAuthorizedOrganizationScope(req) {
  const requestedOrganizationId = req.body?.organizationId || req.body?.organization_id || req.query?.organizationId || req.query?.organization_id;
  const requested = typeof requestedOrganizationId === "string" ? requestedOrganizationId : void 0;
  if (requested && !mongoose54.Types.ObjectId.isValid(requested)) {
    return { allowed: false, statusCode: 400, message: "Invalid organization ID" };
  }
  const authenticatedOrganizationId = getRequestOrganizationId(req);
  if (isRootRequest(req)) {
    return { allowed: true, organizationId: requested || authenticatedOrganizationId };
  }
  if (!authenticatedOrganizationId) {
    return { allowed: false, statusCode: 403, message: "Organization context is required" };
  }
  if (requested && requested !== authenticatedOrganizationId) {
    return { allowed: false, statusCode: 403, message: "Cross-tenant organization selection is not allowed" };
  }
  return { allowed: true, organizationId: authenticatedOrganizationId };
}
async function checkLocationAccess(req, locationId, options = {}) {
  const normalizedLocationId = typeof locationId === "string" ? locationId : locationId instanceof mongoose54.Types.ObjectId ? locationId.toString() : typeof locationId === "object" && locationId !== null && "_id" in locationId ? String(locationId._id) : "";
  if (!mongoose54.Types.ObjectId.isValid(normalizedLocationId)) {
    return { allowed: false, statusCode: 400, message: "Invalid location ID" };
  }
  const organizationId = getRequestOrganizationId(req);
  const location2 = await Location.findOne({
    _id: normalizedLocationId,
    isActive: { $ne: false }
  }).select("organizationId").lean();
  if (!location2) {
    return { allowed: false, statusCode: 404, message: "Location not found" };
  }
  if (isRootRequest(req)) {
    return { allowed: true, organizationId: location2.organizationId.toString() };
  }
  if (req.user?.role === "patient" || req.user?.role === "family_member" || req.user?.role === "guest") {
    return { allowed: true, organizationId: location2.organizationId.toString() };
  }
  if (!organizationId) {
    return { allowed: false, statusCode: 403, message: "Organization context is required" };
  }
  if (location2.organizationId.toString() !== organizationId) {
    return { allowed: false, statusCode: 404, message: "Location not found" };
  }
  const grant = await resolveStaffLocationGrant(req.user.id, organizationId, req.user.role, options.requireExplicitScope);
  if (grant && !grant.includes(normalizedLocationId)) {
    return { allowed: false, statusCode: 404, message: "Location not found" };
  }
  return { allowed: true, organizationId };
}
async function getRequestLocationIds(req, options = {}) {
  if (isRootRequest(req)) return void 0;
  const organizationId = getRequestOrganizationId(req);
  if (!organizationId) return [];
  const grant = await resolveStaffLocationGrant(req.user.id, organizationId, req.user.role, options.requireExplicitScope);
  const locations = await Location.find({
    organizationId,
    isActive: { $ne: false },
    ...grant ? { _id: { $in: grant } } : {}
  }).select("_id").lean();
  return locations.map((location2) => location2._id);
}
async function checkPatientAccess(req, patientId) {
  if (typeof patientId !== "string" || !mongoose54.Types.ObjectId.isValid(patientId)) {
    return { allowed: false, statusCode: 400, message: "Invalid patient ID" };
  }
  if (isRootRequest(req)) {
    return { allowed: true, organizationId: getRequestOrganizationId(req) };
  }
  if (req.user?.role === "patient" || req.user?.role === "family_member") {
    const patient2 = await Patient.findById(patientId).select("userId organizationId").lean();
    if (patient2) {
      if (patient2.userId?.toString() === req.user.id) {
        return { allowed: true, organizationId: patient2.organizationId?.toString() };
      }
      const { FamilyRelationship: FamilyRelationship2 } = await Promise.resolve().then(() => (init_FamilyRelationship(), FamilyRelationship_exports));
      const isFamily = await FamilyRelationship2.exists({
        userId: req.user.id,
        patientId,
        status: "active"
      });
      if (isFamily) {
        return { allowed: true, organizationId: patient2.organizationId?.toString() };
      }
    }
    return { allowed: false, statusCode: 404, message: "Patient not found" };
  }
  const organizationId = getRequestOrganizationId(req);
  if (!organizationId) {
    return { allowed: false, statusCode: 403, message: "Organization context is required" };
  }
  const patient = await Patient.exists({ _id: patientId, organizationId });
  if (!patient) {
    return { allowed: false, statusCode: 404, message: "Patient not found" };
  }
  return { allowed: true, organizationId };
}
async function checkOperationalRecordAccess(req, record) {
  const locationCheck = await checkLocationAccess(req, record.locationId);
  if (!locationCheck.allowed) return locationCheck;
  if (!isRootRequest(req) && record.organizationId && locationCheck.organizationId) {
    if (String(record.organizationId) !== locationCheck.organizationId) {
      return { allowed: false, statusCode: 404, message: "Record not found" };
    }
  }
  return locationCheck;
}
var init_tenant = __esm({
  "utilities/tenant.ts"() {
    "use strict";
    init_Location();
    init_Patient();
    init_LocationAccessService();
  }
});

// utilities/cursorPagination.ts
import mongoose55 from "mongoose";
function getCursorPaginationParams(query, defaultLimit = DEFAULT_PAGINATION_LIMIT, maxLimit = MAX_PAGINATION_LIMIT) {
  const parsedLimit = Number(query?.limit);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(Math.floor(parsedLimit), maxLimit) : defaultLimit;
  return {
    cursor: typeof query?.cursor === "string" && query.cursor.trim() !== "" ? query.cursor.trim() : void 0,
    limit
  };
}
function encodeCursor(data) {
  const payload = {
    id: data.id.toString(),
    t: data.timestamp instanceof Date ? data.timestamp.getTime() : data.timestamp
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}
function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.id !== "string") return null;
    return {
      id: parsed.id,
      timestamp: typeof parsed.t === "number" ? parsed.t : void 0
    };
  } catch {
    return null;
  }
}
function buildCursorFilter(decoded, options = {}) {
  if (!decoded) return {};
  const timeField = options.timeField || "createdAt";
  const isDesc = options.sortDirection !== "asc";
  const op = isDesc ? "$lt" : "$gt";
  const targetId = mongoose55.Types.ObjectId.isValid(decoded.id) ? new mongoose55.Types.ObjectId(decoded.id) : decoded.id;
  if (decoded.timestamp !== void 0) {
    const targetDate = new Date(decoded.timestamp);
    return {
      $or: [
        { [timeField]: { [op]: targetDate } },
        { [timeField]: targetDate, _id: { [op]: targetId } }
      ]
    };
  }
  return {
    _id: { [op]: targetId }
  };
}
function formatCursorResult(items, limit, timeField = "createdAt") {
  const hasNextPage = items.length > limit;
  const resultItems = hasNextPage ? items.slice(0, limit) : items;
  let nextCursor = null;
  if (hasNextPage && resultItems.length > 0) {
    const lastItem = resultItems[resultItems.length - 1];
    const ts = lastItem[timeField] ? new Date(lastItem[timeField]).getTime() : void 0;
    nextCursor = encodeCursor({
      id: lastItem._id,
      timestamp: ts
    });
  }
  return {
    items: resultItems,
    nextCursor,
    hasNextPage,
    limit
  };
}
var init_cursorPagination = __esm({
  "utilities/cursorPagination.ts"() {
    "use strict";
    init_scalability();
  }
});

// models/OpdSession.ts
var OpdSession_exports = {};
__export(OpdSession_exports, {
  OpdSession: () => OpdSession
});
import mongoose56, { Schema as Schema47 } from "mongoose";
var OpdSessionSchema, OpdSession;
var init_OpdSession = __esm({
  "models/OpdSession.ts"() {
    "use strict";
    OpdSessionSchema = new Schema47(
      {
        locationId: { type: Schema47.Types.ObjectId, ref: "Location", required: true, index: true },
        doctorId: { type: Schema47.Types.ObjectId, ref: "User", required: true, index: true },
        organizationId: { type: Schema47.Types.ObjectId, ref: "Organization", required: true, index: true },
        date: { type: String, required: true },
        // "YYYY-MM-DD"
        status: { type: String, enum: ["active", "ended"], default: "active", index: true },
        startedAt: { type: Date, default: Date.now },
        endedAt: { type: Date },
        startedBy: { type: Schema47.Types.ObjectId, ref: "User" },
        endedBy: { type: Schema47.Types.ObjectId, ref: "User" },
        isOnBreak: { type: Boolean, default: false, index: true },
        breakReason: { type: String, default: "" },
        breakStartedAt: { type: Date, default: null },
        breakExpectedMinutes: { type: Number, default: 15 },
        reconciliationSummary: {
          standbyCount: { type: Number, default: 0 },
          waitingCount: { type: Number, default: 0 },
          completedCount: { type: Number, default: 0 },
          standbyAction: { type: String },
          waitingAction: { type: String },
          reconciledAt: { type: Date }
        }
      },
      { timestamps: true }
    );
    OpdSessionSchema.index({ locationId: 1, doctorId: 1, date: 1 }, { unique: true });
    OpdSessionSchema.virtual("id").get(function() {
      return this._id.toHexString();
    });
    OpdSessionSchema.set("toJSON", {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    });
    OpdSession = mongoose56.model("OpdSession", OpdSessionSchema);
  }
});

// models/NotificationLog.ts
import mongoose57, { Schema as Schema48 } from "mongoose";
var notificationLogSchema, NotificationLog;
var init_NotificationLog = __esm({
  "models/NotificationLog.ts"() {
    "use strict";
    init_auditPlugin();
    init_cryptoEnvelope();
    notificationLogSchema = new Schema48(
      {
        organizationId: {
          type: Schema48.Types.ObjectId,
          ref: "Organization",
          index: true
        },
        recipientPhone: {
          type: String,
          required: true,
          index: true
        },
        recipientName: {
          type: String,
          trim: true
        },
        channel: {
          type: String,
          enum: ["sms", "whatsapp", "email"],
          default: "whatsapp",
          index: true
        },
        templateId: {
          type: String,
          required: true,
          index: true
        },
        messageContent: {
          type: String,
          required: true,
          set: encryptField,
          get: decryptField
        },
        status: {
          type: String,
          enum: ["queued", "sending", "accepted", "sent", "delivered", "read", "failed"],
          default: "queued",
          index: true
        },
        providerMessageId: {
          type: String,
          index: true
        },
        metaMessageId: {
          type: String,
          sparse: true,
          index: true
        },
        idempotencyKey: {
          type: String,
          unique: true,
          sparse: true,
          index: true
        },
        creditsDeducted: {
          type: Number,
          default: 0
        },
        rawResponse: {
          type: Schema48.Types.Mixed
        },
        errorReason: {
          type: String
        },
        sentAt: Date,
        deliveredAt: Date,
        readAt: Date,
        failedAt: Date,
        pricing: Schema48.Types.Mixed
      },
      { timestamps: true }
    );
    notificationLogSchema.plugin(auditPlugin);
    notificationLogSchema.index({ metaMessageId: 1 }, { unique: true, name: "whatsapp_wamid_unique", partialFilterExpression: { metaMessageId: { $type: "string" } } });
    notificationLogSchema.set("toJSON", { transform: (_doc, value) => {
      value.recipientPhone = `\u2022\u2022\u2022\u2022${String(value.recipientPhone || "").slice(-4)}`;
      delete value.recipientName;
      delete value.messageContent;
      delete value.rawResponse;
      return value;
    } });
    NotificationLog = mongoose57.model("NotificationLog", notificationLogSchema);
  }
});

// services/WhatsAppLedger.ts
async function claimWhatsAppIntent(key, fields) {
  let existing;
  try {
    existing = await NotificationLog.findOneAndUpdate({ idempotencyKey: key }, { $setOnInsert: { ...fields, idempotencyKey: key, status: "sending" } }, { upsert: true, returnDocument: "before" });
  } catch (error) {
    if (error.code !== 11e3) throw error;
    existing = await NotificationLog.findOne({ idempotencyKey: key });
  }
  if (!existing) return { claimed: true, log: await NotificationLog.findOne({ idempotencyKey: key }) };
  if (["accepted", "sent", "delivered", "read"].includes(existing.status)) return { claimed: false, log: existing };
  if (existing.status === "sending") throw new Error("AMBIGUOUS_NETWORK");
  if (isPermanentWhatsAppFailure(existing.errorReason) || existing.errorReason === "INSUFFICIENT_CREDITS") throw new Error(existing.errorReason);
  const log = await NotificationLog.findOneAndUpdate({ _id: existing._id, status: "failed", errorReason: existing.errorReason }, { $set: { ...fields, status: "sending" }, $unset: { errorReason: 1 } }, { returnDocument: "after" });
  if (!log) throw new Error("AMBIGUOUS_NETWORK");
  return { claimed: true, log };
}
var init_WhatsAppLedger = __esm({
  "services/WhatsAppLedger.ts"() {
    "use strict";
    init_NotificationLog();
    init_WhatsAppSendPolicy();
  }
});

// services/SmsWhatsAppService.ts
var SmsWhatsAppService_exports = {};
__export(SmsWhatsAppService_exports, {
  SmsWhatsAppService: () => SmsWhatsAppService,
  buildMetaTemplateParams: () => buildMetaTemplateParams,
  dispatchSmsWhatsAppNotification: () => dispatchSmsWhatsAppNotification,
  sendSmsWhatsAppNotification: () => sendSmsWhatsAppNotification
});
import crypto19 from "node:crypto";
async function sendSmsWhatsAppNotification(options) {
  if (options.templateId === "OTP_VERIFICATION") {
    return dispatchSmsWhatsAppNotification(options);
  }
  const queued = await enqueueCommunicationTemplate(options);
  const record = queued.toObject ? queued.toObject() : queued;
  return {
    ...record,
    isDuplicate: record.status !== "pending",
    creditsDeducted: 0
  };
}
async function dispatchSmsWhatsAppNotification(options) {
  if (options.channel === "sms" && process.env.SMS_PROVIDER === "msg91") {
    return withConcurrencyBudget("provider:sms", 5, () => dispatchBounded(options));
  }
  return dispatchBounded(options);
}
async function dispatchBounded(options) {
  const channel = options.channel || "whatsapp";
  const phone = options.phone.trim();
  const appointmentId = options.appointmentId;
  const templateId = options.templateId;
  if (templateId !== "OTP_VERIFICATION") {
    if (channel !== "whatsapp") throw new CommunicationPolicyError("COMMUNICATION_SMS_UNSUPPORTED");
    const context = options.communicationContext || (options.organizationId && appointmentId ? { organizationId: options.organizationId, appointmentId } : void 0);
    if (!context) throw new CommunicationPolicyError("COMMUNICATION_CONTEXT_REQUIRED");
    await patientCommunicationPolicy(context, "whatsapp", phone);
  }
  if (channel === "whatsapp") {
    const key = options.idempotencyKey || (appointmentId ? `whatsapp_${appointmentId}_${templateId}` : `immediate:${crypto19.randomUUID()}`);
    const existing = await NotificationLog.findOne({ idempotencyKey: key });
    if (existing && ["accepted", "sent", "delivered", "read"].includes(existing.status)) return { ...existing.toObject(), isDuplicate: true, creditsDeducted: 0 };
    if (existing?.status === "sending" || existing?.errorReason === "AMBIGUOUS_NETWORK") throw new Error("AMBIGUOUS_NETWORK");
    const fields = {
      organizationId: options.organizationId,
      recipientPhone: phone,
      recipientName: options.patientName,
      channel: "whatsapp",
      templateId,
      messageContent: "[WhatsApp notification]"
    };
    const suppress = (reason) => NotificationLog.findOneAndUpdate(
      { idempotencyKey: key },
      { $set: { ...fields, status: "failed", errorReason: reason } },
      { upsert: true, returnDocument: "after" }
    );
    const org = options.organizationId ? await Organization.findById(options.organizationId) : null;
    if (org?.whatsappConfig?.mode === "disabled") return suppress("WHATSAPP_DISABLED_FOR_ORGANIZATION");
    const toggles = {
      BOOKING_CONFIRMATION: "sendBookingConfirmation",
      CONSULTATION_COMPLETED: "sendConsultationComplete",
      APPOINTMENT_CANCELLED: "sendAppointmentCancellation",
      QUEUE_UPDATE: "sendTurnApproaching",
      QUEUE_DELAY_ALERT: "sendQueueDelayAlert",
      DOCTOR_DISRUPTION: "sendDisruptionAlert",
      DISRUPTION_TRANSFER: "sendDisruptionAlert",
      DISRUPTION_REFUND_CONFIRMATION: "sendDisruptionAlert"
    };
    const manualTracker = options.communicationContext?.communicationAction === "queue_tracker" && options.communicationContext.automated === false && !!options.communicationContext.actorId;
    if (!manualTracker && toggles[templateId] && org?.whatsappConfig?.notifications?.[toggles[templateId]] === false) throw new CommunicationPolicyError("COMMUNICATION_CHANNEL_DISABLED");
    let account;
    let windowOpen;
    const { templateName, parameters, messageContent: messageContent2 } = buildMetaTemplateParams(options);
    const language = process.env.META_WHATSAPP_LANG || "en";
    try {
      account = await resolveWhatsAppAccount(options.organizationId);
      windowOpen = await assertWhatsAppConsent(account, phone);
      if (!windowOpen || templateId === "OTP_VERIFICATION") await assertApprovedTemplate(account, templateName, language, parameters.length);
    } catch (error) {
      return suppress(error.message);
    }
    const claim = await claimWhatsAppIntent(key, fields);
    if (!claim.claimed) return { ...claim.log.toObject(), isDuplicate: true, creditsDeducted: 0 };
    const intent = claim.log;
    let charged = false;
    if (org?.whatsappConfig?.mode === "shared") {
      const reserved = await Organization.updateOne(
        { _id: org._id, "whatsappConfig.creditsBalance": { $gte: 1 } },
        { $inc: { "whatsappConfig.creditsBalance": -1, "whatsappConfig.creditsUsedThisMonth": 1 } }
      );
      if (!reserved.modifiedCount) return suppress("INSUFFICIENT_CREDITS");
      charged = true;
    }
    const sendTemplate = () => whatsAppCloudApiService.sendTemplateMessage({
      to: phone,
      templateName,
      parameters,
      languageCode: language,
      credentials: account,
      ...templateId === "OTP_VERIFICATION" ? { buttonUrlParam: options.variables.otpCode } : {}
    });
    let response = windowOpen && templateId !== "OTP_VERIFICATION" ? await whatsAppCloudApiService.sendFreeformTextMessage({ to: phone, text: messageContent2, credentials: account }) : await sendTemplate();
    if (!response.success && [131047, 131051].includes(response.errorCode || 0)) {
      try {
        await assertApprovedTemplate(account, templateName, language, parameters.length);
        response = await sendTemplate();
      } catch {
        response = { success: false, status: "failed", errorReason: "TEMPLATES_NOT_READY" };
      }
    }
    await recordWhatsAppCredentialError(account, response.errorCode);
    const log = await NotificationLog.findByIdAndUpdate(intent._id, { $set: {
      status: response.status,
      providerMessageId: response.providerMessageId,
      metaMessageId: response.providerMessageId,
      errorReason: response.errorReason,
      creditsDeducted: charged && (response.success || response.errorReason === "AMBIGUOUS_NETWORK") ? 1 : 0
    } }, { returnDocument: "after" });
    if (!response.success && response.errorReason !== "AMBIGUOUS_NETWORK" && charged) {
      await Organization.updateOne({ _id: org._id }, { $inc: { "whatsappConfig.creditsBalance": 1, "whatsappConfig.creditsUsedThisMonth": -1 } });
    }
    if (options.organizationId) await UsageRecord.findOneAndUpdate(
      { organizationId: options.organizationId },
      { $inc: { [response.success ? "whatsappSentCount" : "whatsappFailedCount"]: 1 } },
      { upsert: true }
    );
    return log;
  }
  const messageContent = buildPlainMessageContent(options);
  const smsProvider = process.env.SMS_PROVIDER || "console";
  const msg91AuthKey = process.env.MSG91_AUTH_KEY || process.env.SMS_PROVIDER_API_KEY;
  const msg91TemplateId = process.env.MSG91_OTP_TEMPLATE_ID || process.env.SMS_TEMPLATE_ID;
  if (smsProvider === "msg91" && msg91AuthKey) {
    try {
      const recipientMobile = whatsAppCloudApiService.formatPhoneNumber(phone);
      const res = await fetch("https://control.msg91.com/api/v5/otp", {
        signal: AbortSignal.timeout(8e3),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "authkey": msg91AuthKey
        },
        body: JSON.stringify({
          template_id: msg91TemplateId || void 0,
          mobile: recipientMobile,
          otp: options.variables.otpCode
        })
      });
      const responseData = await res.json();
      const isSuccess = res.ok && responseData.type === "success";
      return await NotificationLog.create({
        organizationId: options.organizationId,
        recipientPhone: phone,
        recipientName: options.patientName || options.variables.patientName,
        channel: "sms",
        templateId,
        messageContent,
        status: isSuccess ? "sent" : "failed",
        errorReason: isSuccess ? void 0 : "SMS_PROVIDER_DECLINED"
      });
    } catch (err) {
      console.error("[MSG91 SMS Error]:", safeError(err));
      return await NotificationLog.create({
        organizationId: options.organizationId,
        recipientPhone: phone,
        recipientName: options.patientName || options.variables.patientName,
        channel: "sms",
        templateId,
        messageContent,
        status: "failed",
        errorReason: err.message || "MSG91 HTTP dispatch error"
      });
    }
  }
  return await NotificationLog.create({
    organizationId: options.organizationId,
    recipientPhone: phone,
    recipientName: options.patientName || options.variables.patientName,
    channel: "sms",
    templateId,
    messageContent,
    status: "failed",
    errorReason: "SMS provider is not configured"
  });
}
async function issueTrackerUrlForAppointment(appointmentId) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) return "";
  const { url } = await issueAppointmentTrackerLink(appointment);
  return url;
}
function buildMetaTemplateParams(options) {
  const v = options.variables;
  const patientName = options.patientName || v.patientName || "Patient";
  switch (options.templateId) {
    case "CRM_CONTACT_REQUEST":
    case "CRM_CARE_FOLLOWUP":
    case "CRM_FEEDBACK_REQUEST": {
      const label = options.templateId === "CRM_CARE_FOLLOWUP" ? "care follow-up" : options.templateId === "CRM_FEEDBACK_REQUEST" ? "feedback" : "contact request";
      return { templateName: options.templateId.toLowerCase(), parameters: [v.locationName || "Your clinic"], messageContent: `Please contact ${v.locationName || "your clinic"} about your ${label}. Reply STOP to stop WhatsApp messages.` };
    }
    case "OTP_VERIFICATION":
      return { templateName: process.env.META_WHATSAPP_OTP_TEMPLATE || "otp_verification", parameters: [v.otpCode || ""], messageContent: "Your verification code is " + (v.otpCode || "") };
    case "LAB_RESULTS_READY":
      return { templateName: process.env.META_WHATSAPP_LAB_TEMPLATE || "lab_results_ready", parameters: [patientName, v.testName || "Lab test", v.trackingUrl || ""], messageContent: `Your ${v.testName || "lab"} results are ready. ${v.trackingUrl || ""}` };
    case "BILLING_RECEIPT":
      return { templateName: process.env.META_WHATSAPP_RECEIPT_TEMPLATE || "billing_receipt", parameters: [patientName, v.invoiceNumber || "", v.amount || "0", v.trackingUrl || ""], messageContent: `Payment received for invoice ${v.invoiceNumber}. Amount: ${v.amount}. ${v.trackingUrl || ""}` };
    case "QUEUE_DELAY_ALERT":
      return { templateName: process.env.META_WHATSAPP_DELAY_TEMPLATE || "queue_delay_alert", parameters: [patientName, v.doctorName || "Doctor", v.delayMinutes || "15", v.trackingUrl || v.trackerUrl || ""], messageContent: `Your visit with Dr. ${v.doctorName} is delayed by approximately ${v.delayMinutes || "15"} minutes. ${v.trackingUrl || v.trackerUrl || ""}` };
    case "BOOKING_CONFIRMATION":
      return {
        templateName: process.env.META_WHATSAPP_BOOKING_TEMPLATE || "appointment_booking_confirmation",
        parameters: [
          patientName,
          v.doctorName || "Doctor",
          v.locationName || "Location",
          v.appointmentTime || "Today",
          v.tokenNumber || "1",
          v.trackingUrl || ""
        ],
        messageContent: `Appointment confirmed with Dr. ${v.doctorName} at ${v.locationName} for ${v.appointmentTime}. Token #${v.tokenNumber}. Track live: ${v.trackingUrl}`
      };
    case "CONSULTATION_COMPLETED":
      return {
        templateName: process.env.META_WHATSAPP_COMPLETED_TEMPLATE || "consultation_completed",
        parameters: [
          patientName,
          v.doctorName || "Doctor",
          v.locationName || "Location",
          v.tokenNumber || "1",
          v.trackingUrl || ""
        ],
        messageContent: `Your consultation with Dr. ${v.doctorName} is complete. Your prescription and bill are ready at: ${v.trackingUrl}`
      };
    case "QUEUE_UPDATE":
      return {
        templateName: process.env.META_WHATSAPP_QUEUE_TEMPLATE || "queue_turn_approaching",
        parameters: [
          patientName,
          v.tokenNumber || "1",
          v.peopleAhead || "1",
          v.doctorName || "Doctor",
          v.trackingUrl || ""
        ],
        messageContent: `Token #${v.tokenNumber}: Only ${v.peopleAhead} patient(s) ahead of you for Dr. ${v.doctorName}. Live tracker: ${v.trackingUrl}`
      };
    case "APPOINTMENT_CANCELLED":
      return {
        templateName: process.env.META_WHATSAPP_CANCELLED_TEMPLATE || "appointment_cancelled",
        parameters: [
          patientName,
          v.doctorName || "Doctor",
          v.locationName || "Location",
          v.appointmentTime || "Today"
        ],
        messageContent: `Appointment for ${patientName} with Dr. ${v.doctorName} at ${v.locationName} scheduled for ${v.appointmentTime} has been cancelled.`
      };
    case "APPOINTMENT_REMINDER":
      return {
        templateName: process.env.META_WHATSAPP_REMINDER_TEMPLATE || "appointment_reminder",
        parameters: [
          patientName,
          v.doctorName || "Doctor",
          v.locationName || "Location",
          v.appointmentTime || "Tomorrow"
        ],
        messageContent: `Reminder: Appointment with Dr. ${v.doctorName} at ${v.locationName} tomorrow at ${v.appointmentTime}.`
      };
    case "DOCTOR_DISRUPTION":
      return {
        templateName: process.env.META_WHATSAPP_DISRUPTION_TEMPLATE || "doctor_disruption_alert",
        parameters: [
          patientName,
          v.doctorName || "Doctor",
          v.locationName || "Location",
          v.appointmentTime || "Today",
          v.rescheduleUrl || "",
          v.cancelUrl || ""
        ],
        messageContent: `Important: Dr. ${v.doctorName} at ${v.locationName} is unavailable on ${v.appointmentTime}. Choose: Reschedule: ${v.rescheduleUrl} | Cancel & Refund: ${v.cancelUrl}`
      };
    case "DISRUPTION_TRANSFER":
      return {
        templateName: process.env.META_WHATSAPP_TRANSFER_TEMPLATE || "appointment_transfer_alert",
        parameters: [
          patientName,
          v.originalDoctorName || "Original Doctor",
          v.newDoctorName || "Doctor",
          v.locationName || "Location",
          v.tokenNumber || "1",
          v.trackingUrl || ""
        ],
        messageContent: `Appointment update: Transferred from Dr. ${v.originalDoctorName} to Dr. ${v.newDoctorName} at ${v.locationName}. Token #${v.tokenNumber}. Track live: ${v.trackingUrl}`
      };
    case "DISRUPTION_REFUND_CONFIRMATION":
      return {
        templateName: process.env.META_WHATSAPP_REFUND_TEMPLATE || "appointment_refund_confirmation",
        parameters: [
          patientName,
          v.doctorName || "Doctor",
          v.locationName || "Location",
          v.refundAmount || "0",
          v.refundId || ""
        ],
        messageContent: `Refund confirmed: \u20B9${v.refundAmount} initiated for cancelled appointment with Dr. ${v.doctorName} at ${v.locationName} (Ref: ${v.refundId}).`
      };
    default:
      return {
        templateName: "general_notification",
        parameters: [patientName, JSON.stringify(v)],
        messageContent: `Notification for ${patientName}: ${JSON.stringify(v)}`
      };
  }
}
function buildPlainMessageContent(options) {
  const v = options.variables;
  switch (options.templateId) {
    case "OTP_VERIFICATION":
      return v.purpose === "record_access" ? `Your Ekavyu approval code is ${v.otpCode}. Share it with your clinician only if you agree to let them view your medical history from other organizations for 10 minutes. This code expires in 5 minutes.` : `Your Ekavyu verification code is ${v.otpCode}. Valid for 5 minutes.`;
    case "BOOKING_CONFIRMATION":
      return `Appointment with Dr. ${v.doctorName} at ${v.locationName} confirmed for ${v.appointmentTime}. Token #${v.tokenNumber}.`;
    case "APPOINTMENT_REMINDER":
      return `Reminder: Appointment with Dr. ${v.doctorName} at ${v.locationName} on ${v.appointmentTime}.`;
    case "DOCTOR_DISRUPTION":
      return `Important: Dr. ${v.doctorName} is unavailable on ${v.appointmentTime}. Reschedule: ${v.rescheduleUrl} | Cancel & Refund: ${v.cancelUrl}`;
    case "DISRUPTION_TRANSFER":
      return `Appointment at ${v.locationName} transferred to Dr. ${v.newDoctorName}. Token #${v.tokenNumber}. Track: ${v.trackingUrl}`;
    case "DISRUPTION_REFUND_CONFIRMATION":
      return `Refund of \u20B9${v.refundAmount} initiated for cancelled appointment with Dr. ${v.doctorName}. Ref: ${v.refundId}`;
    case "LAB_RESULTS_READY":
      return `Lab test results for ${v.testName} are now ready on your patient portal.`;
    case "BILLING_RECEIPT":
      return `Invoice #${v.invoiceNumber} for \u20B9${v.amount} processed successfully.`;
    default:
      return `Notification: ${JSON.stringify(v)}`;
  }
}
var SmsWhatsAppService;
var init_SmsWhatsAppService = __esm({
  "services/SmsWhatsAppService.ts"() {
    "use strict";
    init_safeError();
    init_NotificationLog();
    init_Organization();
    init_UsageRecord();
    init_Appointment();
    init_publicTracker();
    init_WhatsAppCloudApiService();
    init_CommunicationOutbox();
    init_WhatsAppAccountService();
    init_WhatsAppSendPolicy();
    init_WhatsAppLedger();
    init_concurrencyBudget();
    init_PatientCommunicationPolicy();
    SmsWhatsAppService = {
      sendSmsWhatsAppNotification,
      dispatchSmsWhatsAppNotification,
      async sendBookingConfirmation(appointmentId, organizationId, phone, params) {
        const trackingUrl = params.trackingUrl || await issueTrackerUrlForAppointment(appointmentId);
        const log = await sendSmsWhatsAppNotification({
          organizationId,
          appointmentId,
          phone,
          patientName: params.patientName,
          channel: "whatsapp",
          templateId: "BOOKING_CONFIRMATION",
          variables: {
            patientName: params.patientName || "Patient",
            tokenNumber: String(params.tokenNumber),
            doctorName: params.doctorName,
            locationName: params.locationName || "Location",
            appointmentTime: params.appointmentTime || `${params.date || ""} ${params.time || ""}`.trim() || "Today",
            trackingUrl
          }
        });
        const isSuccess = log?.status === "pending" || log?.status === "processing" || log?.status === "retrying" || log?.status === "accepted" || log?.status === "sent" || log?.status === "delivered" || log?.status === "queued";
        return {
          success: isSuccess,
          log,
          creditsDeducted: log?.isDuplicate ? 0 : log?.creditsDeducted ?? 0,
          isDuplicate: !!log?.isDuplicate,
          errorReason: log?.errorReason,
          status: log?.status
        };
      },
      async sendConsultationCompleted(appointmentId, organizationId, phone, params) {
        const trackerUrl = await issueTrackerUrlForAppointment(appointmentId);
        const prescriptionUrl = params.prescriptionUrl || trackerUrl;
        const paymentUrl = params.paymentUrl || trackerUrl;
        const log = await sendSmsWhatsAppNotification({
          organizationId,
          appointmentId,
          phone,
          patientName: params.patientName,
          channel: "whatsapp",
          templateId: "CONSULTATION_COMPLETED",
          variables: {
            patientName: params.patientName || "Patient",
            doctorName: params.doctorName,
            prescriptionUrl,
            invoiceAmount: String(params.invoiceAmount || "0"),
            paymentStatus: params.paymentStatus || "Paid",
            paymentUrl
          }
        });
        const isSuccess = log?.status === "pending" || log?.status === "processing" || log?.status === "retrying" || log?.status === "accepted" || log?.status === "sent" || log?.status === "delivered" || log?.status === "queued";
        return {
          success: isSuccess,
          log,
          creditsDeducted: log?.isDuplicate ? 0 : log?.creditsDeducted ?? 0,
          isDuplicate: !!log?.isDuplicate,
          errorReason: log?.errorReason,
          status: log?.status
        };
      },
      async sendDisruptionAlert(appointmentId, organizationId, phone, params) {
        const trackingUrl = params.trackingUrl || await issueTrackerUrlForAppointment(appointmentId);
        const log = await sendSmsWhatsAppNotification({
          organizationId,
          appointmentId,
          phone,
          patientName: params.patientName,
          channel: "whatsapp",
          templateId: "DOCTOR_DISRUPTION",
          variables: {
            patientName: params.patientName || "Patient",
            doctorName: params.doctorName,
            locationName: params.locationName || "Location",
            appointmentTime: params.appointmentTime || "Today",
            rescheduleUrl: params.rescheduleUrl,
            cancelUrl: params.cancelUrl,
            actionDeadlineMinutes: String(params.actionDeadlineMinutes || 60)
          }
        });
        const isSuccess = log?.status === "pending" || log?.status === "processing" || log?.status === "retrying" || log?.status === "accepted" || log?.status === "sent" || log?.status === "delivered" || log?.status === "queued";
        return {
          success: isSuccess,
          log,
          creditsDeducted: log?.isDuplicate ? 0 : log?.creditsDeducted ?? 0,
          isDuplicate: !!log?.isDuplicate,
          errorReason: log?.errorReason,
          status: log?.status
        };
      },
      async sendDisruptionTransferAlert(appointmentId, organizationId, phone, params) {
        const trackingUrl = params.trackingUrl || await issueTrackerUrlForAppointment(appointmentId);
        const log = await sendSmsWhatsAppNotification({
          organizationId,
          appointmentId,
          phone,
          patientName: params.patientName,
          channel: "whatsapp",
          templateId: "DISRUPTION_TRANSFER",
          variables: {
            patientName: params.patientName || "Patient",
            originalDoctorName: params.originalDoctorName,
            newDoctorName: params.newDoctorName,
            locationName: params.locationName || "Location",
            tokenNumber: String(params.tokenNumber),
            trackingUrl
          }
        });
        const isSuccess = log?.status === "pending" || log?.status === "processing" || log?.status === "retrying" || log?.status === "accepted" || log?.status === "sent" || log?.status === "delivered" || log?.status === "queued";
        return {
          success: isSuccess,
          log,
          creditsDeducted: log?.isDuplicate ? 0 : log?.creditsDeducted ?? 0,
          isDuplicate: !!log?.isDuplicate,
          errorReason: log?.errorReason,
          status: log?.status
        };
      },
      async sendDisruptionRefundAlert(appointmentId, organizationId, phone, params) {
        const log = await sendSmsWhatsAppNotification({
          organizationId,
          appointmentId,
          phone,
          patientName: params.patientName,
          channel: "whatsapp",
          templateId: "DISRUPTION_REFUND_CONFIRMATION",
          variables: {
            patientName: params.patientName || "Patient",
            doctorName: params.doctorName,
            locationName: params.locationName || "Location",
            refundAmount: String(params.refundAmount),
            refundId: params.refundId
          }
        });
        const isSuccess = log?.status === "pending" || log?.status === "processing" || log?.status === "retrying" || log?.status === "accepted" || log?.status === "sent" || log?.status === "delivered" || log?.status === "queued";
        return {
          success: isSuccess,
          log,
          creditsDeducted: log?.isDuplicate ? 0 : log?.creditsDeducted ?? 0,
          isDuplicate: !!log?.isDuplicate,
          errorReason: log?.errorReason,
          status: log?.status
        };
      },
      async sendQueueDelayAlert(appointmentId, organizationId, phone, params) {
        const log = await sendSmsWhatsAppNotification({
          organizationId,
          appointmentId,
          phone,
          patientName: params.patientName,
          channel: "whatsapp",
          templateId: "QUEUE_DELAY_ALERT",
          variables: {
            patientName: params.patientName || "Patient",
            doctorName: params.doctorName,
            locationName: params.locationName || "Location",
            delayMinutes: String(params.delayMinutes),
            revisedArrivalTime: params.revisedArrivalTime,
            trackerUrl: params.trackerUrl
          }
        });
        const isSuccess = log?.status === "pending" || log?.status === "processing" || log?.status === "retrying" || log?.status === "accepted" || log?.status === "sent" || log?.status === "delivered" || log?.status === "queued";
        return {
          success: isSuccess,
          log,
          creditsDeducted: log?.isDuplicate ? 0 : log?.creditsDeducted ?? 0,
          isDuplicate: !!log?.isDuplicate,
          errorReason: log?.errorReason,
          status: log?.status
        };
      }
    };
  }
});

// utilities/notifications.ts
var notifications_exports = {};
__export(notifications_exports, {
  sendBookingNotification: () => sendBookingNotification,
  sendConsultationCompletedNotification: () => sendConsultationCompletedNotification,
  sendDoorwaySummonNotification: () => sendDoorwaySummonNotification,
  sendFollowUpRecallNotification: () => sendFollowUpRecallNotification,
  sendPaymentReceiptNotification: () => sendPaymentReceiptNotification,
  sendTurnApproachingNotification: () => sendTurnApproachingNotification
});
async function organizationContact(appt) {
  const patientId = String(appt.patientId?._id || appt.patientId), organizationId = String(appt.organizationId || appt.locationId?.organizationId);
  const recipient = await organizationCommunicationRecipient(patientId, organizationId);
  return { phone: recipient.available ? recipient.phone : void 0, email: recipient.available ? recipient.email : void 0 };
}
async function sendBookingNotification(appointmentId, actionType, trackerToken) {
  try {
    const appt = await Appointment.findById(appointmentId).populate("locationId", "name email phone city organizationId").populate("doctorId", "name email").populate({
      path: "patientId",
      populate: { path: "userId", select: "name email phone" }
    });
    if (!appt) {
      console.warn(`[Notification Warning] Appointment ${appointmentId} not found`);
      return;
    }
    const targetUserId = appt.patientId?.userId?._id?.toString() || appt.patientId?.userId?.id;
    const patientName = appt.patientId?.name || appt.patientId?.userId?.name || "Patient";
    const { email: patientEmail, phone: patientPhone } = await organizationContact(appt);
    const doctorName = appt.doctorId?.name || "Doctor";
    const locationName = appt.locationId?.name || "Location";
    const token = appt.tokenNumber;
    const bookingState = appt.status === "pending_payment" ? "awaiting payment" : appt.status === "pending" ? "requested" : "confirmed";
    const bookingTitle = appt.status === "pending_payment" ? "Booking awaiting payment" : appt.status === "pending" ? "Booking requested" : "Appointment confirmed";
    const cancelled = actionType === "cancelled";
    const title = cancelled ? "Appointment cancelled" : actionType === "rescheduled" ? `Appointment rescheduled \u2014 ${bookingState}` : bookingTitle;
    const time = new Date(appt.appointmentTime).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short"
    });
    let trackingUrl = `/track/${appt._id}`;
    let capability = trackerToken;
    if (capability && actionType !== "cancelled") {
      appt.trackerTokenHash = hashTrackerCapability(capability);
      appt.trackerTokenExpiresAt = new Date(Date.now() + 1e3 * 60 * 60 * 24 * 30);
      await appt.save();
      trackingUrl = `/track/${appt._id}#t=${encodeURIComponent(capability)}`;
    } else if (actionType !== "cancelled") {
      const issued = await issueAppointmentTrackerLink(appt);
      capability = issued.token;
      trackingUrl = issued.url;
    }
    if (targetUserId) {
      await eventBus.publishDurable({
        eventType: cancelled ? EVENT_TYPES.PATIENT_APPOINTMENT_CANCELLED : EVENT_TYPES.PATIENT_APPOINTMENT_BOOKED,
        category: "patient",
        targetUserId: targetUserId.toString(),
        title: cancelled ? title : `${title} (#${token})`,
        message: !cancelled ? `Appointment for ${patientName} with Dr. ${doctorName} at ${locationName} is ${bookingState} for ${time}. Token: #${token}. Booking details: ${trackingUrl}` : `Appointment for ${patientName} with Dr. ${doctorName} at ${locationName} scheduled for ${time} has been cancelled.`,
        severity: cancelled || appt.status !== "confirmed" ? "warning" : "success",
        actionUrl: cancelled ? "/dashboard/appointments" : trackingUrl,
        organizationId: appt.organizationId?.toString(),
        metadata: { appointmentId, locationName, doctorName, token, time, trackingUrl }
      });
    }
    if (patientEmail) {
      const subject = !cancelled ? `${title} - Token #${token} at ${locationName}` : `Appointment Cancelled - ${locationName}`;
      const body = !cancelled ? `Hello ${patientName},

Your appointment booking with Dr. ${doctorName} at ${locationName} is ${bookingState} for ${time}.

Your assigned token is #${token}.

Review booking details here:
${trackingUrl}

${appt.status === "pending_payment" ? "Payment is still required before confirmation." : "Contact reception if you need assistance."}

Best regards,
Ekavyu Health Desk` : `Hello ${patientName},

This is to inform you that your appointment with Dr. ${doctorName} at ${locationName} scheduled for ${time} has been cancelled.

If you believe this is an error, please contact reception.

Best regards,
Ekavyu Health Desk`;
      await enqueueTransactionalEmail({
        to: patientEmail,
        subject,
        text: body,
        html: `<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">${body.replace(/\n/g, "<br/>")}</div>`,
        idempotencyKey: `transactional-email:booking:${appt._id}:${actionType}:${new Date(appt.appointmentTime).toISOString()}`,
        communicationContext: { organizationId: String(appt.organizationId), appointmentId: String(appt._id), purpose: "care_operations" }
      });
    }
    if (patientPhone && (cancelled || appt.status === "confirmed")) {
      const { sendSmsWhatsAppNotification: sendSmsWhatsAppNotification2 } = await Promise.resolve().then(() => (init_SmsWhatsAppService(), SmsWhatsAppService_exports));
      sendSmsWhatsAppNotification2({
        organizationId: appt.locationId?.organizationId?.toString() || appt.organizationId?.toString(),
        appointmentId: appt._id?.toString() || appointmentId?.toString(),
        phone: patientPhone,
        patientName,
        channel: "whatsapp",
        templateId: actionType === "booked" ? "BOOKING_CONFIRMATION" : actionType === "cancelled" ? "APPOINTMENT_CANCELLED" : "APPOINTMENT_REMINDER",
        variables: {
          patientName,
          doctorName,
          locationName,
          appointmentTime: time,
          tokenNumber: String(token),
          trackingUrl
        }
      }).catch((err) => console.error("SMS/WhatsApp dispatch failed:", safeError(err)));
    }
  } catch (err) {
    console.error("sendBookingNotification error:", safeError(err));
  }
}
async function sendTurnApproachingNotification(appointmentId, peopleAhead) {
  try {
    const appt = await Appointment.findById(appointmentId).populate("locationId", "name phone organizationId").populate("doctorId", "name").populate({
      path: "patientId",
      populate: { path: "userId", select: "name email phone" }
    });
    if (!appt) throw new Error("Queue notification appointment not found");
    const targetUserId = appt.patientId?.userId?._id?.toString() || appt.patientId?.userId?.id || appt.patientId?.userId;
    const patientName = appt.patientId?.name || appt.patientId?.userId?.name || "Patient";
    const doctorName = appt.doctorId?.name || "Doctor";
    const token = appt.tokenNumber;
    const { url: trackingUrl } = await issueAppointmentTrackerLink(appt);
    if (targetUserId) {
      await eventBus.publishDurable({
        eventId: `turn-approaching:${appt._id}`,
        organizationId: appt.organizationId?.toString() || appt.locationId?.organizationId?.toString(),
        eventType: EVENT_TYPES.PATIENT_CALL_NEXT,
        category: "patient",
        targetUserId: targetUserId.toString(),
        title: `Your Turn is Approaching! (#${token}) \u{1FA7A}`,
        message: `${peopleAhead <= 1 ? "You are next in line!" : `Only ${peopleAhead} patients ahead.`} Please stay near Dr. ${doctorName}'s room.`,
        severity: "info",
        actionUrl: trackingUrl,
        metadata: { appointmentId, token, peopleAhead, trackingUrl }
      });
    }
    const { phone: patientPhone } = await organizationContact(appt);
    if (patientPhone) {
      const { sendSmsWhatsAppNotification: sendSmsWhatsAppNotification2 } = await Promise.resolve().then(() => (init_SmsWhatsAppService(), SmsWhatsAppService_exports));
      await sendSmsWhatsAppNotification2({
        organizationId: appt.locationId?.organizationId?.toString() || appt.organizationId?.toString(),
        appointmentId: appt._id?.toString() || appointmentId?.toString(),
        phone: patientPhone,
        patientName,
        channel: "whatsapp",
        templateId: "QUEUE_UPDATE",
        variables: {
          patientName,
          tokenNumber: String(token),
          peopleAhead: String(peopleAhead),
          doctorName,
          trackingUrl
        }
      });
    }
  } catch (err) {
    console.error("sendTurnApproachingNotification error:", safeError(err));
    throw err;
  }
}
async function sendConsultationCompletedNotification(appointmentId, options) {
  try {
    const appt = await Appointment.findById(appointmentId).populate("locationId", "name email phone organizationId").populate("doctorId", "name").populate({
      path: "patientId",
      populate: { path: "userId", select: "name email phone" }
    });
    if (!appt) return;
    const targetUserId = appt.patientId?.userId?._id?.toString() || appt.patientId?.userId?.id || appt.patientId?.userId;
    const patientName = appt.patientId?.name || appt.patientId?.userId?.name || "Patient";
    const { email: patientEmail, phone: defaultPatientPhone } = await organizationContact(appt);
    const targetPhone = options?.phone || defaultPatientPhone;
    const channel = options?.channel || "whatsapp";
    const doctorName = appt.doctorId?.name || "Doctor";
    const locationName = appt.locationId?.name || "Location";
    const token = appt.tokenNumber;
    const { token: trackerToken, url: trackingUrl } = await issueAppointmentTrackerLink(appt);
    const prescriptionUrl = appendTrackerCapability(`/api/public/track/${appt._id}/prescription/print`, trackerToken);
    const rxSummaryList = Array.isArray(appt.prescriptions) && appt.prescriptions.length > 0 ? appt.prescriptions.map((p) => `\u2022 ${p.name || p.medicineName} (${p.dosage || "As directed"}, ${p.duration || ""})`).join("\n") : "Prescription attached";
    if (targetUserId) {
      await eventBus.publishDurable({
        eventType: EVENT_TYPES.CLINICAL_ENCOUNTER_COMPLETED,
        category: "clinical",
        targetUserId: targetUserId.toString(),
        title: "Consultation Completed \u2705 \u2014 Prescription & Bill Ready",
        message: `Your consultation with Dr. ${doctorName} is complete. Your digital prescription and invoice are now available.`,
        severity: "success",
        actionUrl: trackingUrl,
        metadata: { appointmentId, token, locationName, doctorName, trackingUrl }
      });
    }
    if (patientEmail) {
      const subject = `Consultation Completed - Prescription & Bill for Token #${token}`;
      const body = `Hello ${patientName},

Your consultation with Dr. ${doctorName} at ${locationName} has been completed.

Your digital prescription, prescribed medicines, doctor's advice, and invoice are now available to view and download:
${trackingUrl}

Thank you for choosing ${locationName}.

Best regards,
Ekavyu Health Desk`;
      await enqueueTransactionalEmail({
        to: patientEmail,
        subject,
        text: body,
        html: `<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">${body.replace(/\n/g, "<br/>")}</div>`,
        idempotencyKey: `transactional-email:consultation-completed:${appt._id}`,
        communicationContext: { organizationId: String(appt.organizationId), appointmentId: String(appt._id), purpose: "care_operations" }
      });
    }
    if (targetPhone) {
      const { sendSmsWhatsAppNotification: sendSmsWhatsAppNotification2 } = await Promise.resolve().then(() => (init_SmsWhatsAppService(), SmsWhatsAppService_exports));
      await sendSmsWhatsAppNotification2({
        organizationId: appt.locationId?.organizationId?.toString() || appt.organizationId?.toString(),
        appointmentId: appt._id?.toString() || appointmentId?.toString(),
        phone: targetPhone,
        patientName,
        channel,
        templateId: "CONSULTATION_COMPLETED",
        variables: {
          patientName,
          doctorName,
          locationName,
          tokenNumber: String(token),
          trackingUrl,
          prescriptionUrl,
          medicinesSummary: rxSummaryList,
          diagnosis: appt.diagnosis || "Consultation Completed"
        }
      }).catch((err) => console.error("SMS/WhatsApp consultation completion dispatch failed:", safeError(err)));
      const { enqueueWhatsAppDocument: enqueueWhatsAppDocument2 } = await Promise.resolve().then(() => (init_CommunicationOutbox(), CommunicationOutbox_exports));
      const cleanDocName = (doctorName || "Doctor").replace(/[^a-zA-Z0-9]/g, "_");
      const pdfFilename = `Prescription_Token_${token}_${cleanDocName}.pdf`;
      const documentUrl = prescriptionUrl;
      if (channel === "whatsapp") await enqueueWhatsAppDocument2({
        communicationContext: { organizationId: String(appt.organizationId), appointmentId: String(appt._id), purpose: "care_operations" },
        to: targetPhone,
        organizationId: appt.organizationId?.toString(),
        documentUrl,
        filename: pdfFilename,
        idempotencyKey: `whatsapp-document:consultation-complete:${appt._id}`,
        caption: `\u{1F4C4} Official Digital Prescription & Care Advice from Dr. ${doctorName} (Token #${token})`
      });
    }
  } catch (err) {
    console.error("sendConsultationCompletedNotification error:", safeError(err));
  }
}
async function sendPaymentReceiptNotification(params) {
  try {
    const { Appointment: Appointment2 } = await Promise.resolve().then(() => (init_Appointment(), Appointment_exports));
    const { Invoice: Invoice2 } = await Promise.resolve().then(() => (init_Invoice(), Invoice_exports));
    const appt = await Appointment2.findById(params.appointmentId).populate("locationId", "name phone organizationId").populate("doctorId", "name").populate({
      path: "patientId",
      populate: { path: "userId", select: "name email phone" }
    });
    if (!appt) return;
    let invoice = null;
    if (params.invoiceId) {
      invoice = await Invoice2.findById(params.invoiceId);
    } else {
      invoice = await Invoice2.findOne({ appointmentId: appt._id });
    }
    const patientName = appt.patientId?.name || appt.patientId?.userId?.name || "Patient";
    const { phone: patientPhone, email: patientEmail } = await organizationContact(appt);
    const doctorName = appt.doctorId?.name || "Doctor";
    const locationName = appt.locationId?.name || "Ekavyu Healthcare";
    const token = appt.tokenNumber || "OPD";
    const invoiceNum = invoice?.invoiceNumber || "INV-REC";
    const amountStr = `\u20B9${Number(params.amount).toFixed(2)}`;
    const { url: trackingUrl } = await issueAppointmentTrackerLink(appt, { pathPrefix: `${getFrontendBaseUrl()}/track` });
    const receiptUrl = trackingUrl;
    if (patientPhone) {
      const { sendSmsWhatsAppNotification: sendSmsWhatsAppNotification2 } = await Promise.resolve().then(() => (init_SmsWhatsAppService(), SmsWhatsAppService_exports));
      await sendSmsWhatsAppNotification2({
        organizationId: appt.locationId?.organizationId?.toString() || appt.organizationId?.toString(),
        appointmentId: appt._id?.toString(),
        phone: patientPhone,
        patientName,
        channel: "whatsapp",
        templateId: "BILLING_RECEIPT",
        variables: {
          patientName,
          doctorName,
          locationName,
          tokenNumber: String(token),
          amount: amountStr,
          paymentMethod: params.paymentMethod.toUpperCase(),
          invoiceNumber: invoiceNum,
          receiptUrl,
          trackingUrl
        }
      }).catch((err) => console.error("SMS/WhatsApp payment receipt dispatch notice:", safeError(err)));
    }
    if (patientEmail) {
      const subject = `Payment Confirmed - Invoice #${invoiceNum} (${amountStr})`;
      const body = `Hello ${patientName},

We have received your payment of ${amountStr} via ${params.paymentMethod.toUpperCase()} for Token #${token} (Dr. ${doctorName} at ${locationName}).

Your payment details are available here:
${receiptUrl}

View your live visit tracker:
${trackingUrl}

Thank you for choosing ${locationName}.

Best regards,
Ekavyu Health Billing Team`;
      await enqueueTransactionalEmail({
        to: patientEmail,
        subject,
        text: body,
        html: `<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">${body.replace(/\n/g, "<br/>")}</div>`,
        idempotencyKey: `transactional-email:payment-receipt:${invoice?._id || params.invoiceId || appt._id}:${params.paymentMethod}:${params.amount}`,
        communicationContext: { organizationId: String(appt.organizationId), appointmentId: String(appt._id), purpose: "care_operations" }
      }).catch((err) => console.error("Email payment receipt outbox enqueue failed:", safeError(err)));
    }
  } catch (err) {
    console.error("sendPaymentReceiptNotification error:", safeError(err));
  }
}
async function sendFollowUpRecallNotification(params) {
  try {
    const { Appointment: Appointment2 } = await Promise.resolve().then(() => (init_Appointment(), Appointment_exports));
    const appt = await Appointment2.findById(params.appointmentId).populate("locationId", "name phone organizationId").populate("doctorId", "name").populate({
      path: "patientId",
      populate: { path: "userId", select: "name email phone" }
    });
    if (!appt) return;
    const patientName = appt.patientId?.name || appt.patientId?.userId?.name || "Patient";
    const contact = await organizationContact(appt);
    const targetPhone = params.phone || contact.phone;
    if (!targetPhone) return;
    const doctorName = appt.doctorId?.name || "Doctor";
    const locationName = appt.locationId?.name || "Location";
    const token = appt.tokenNumber || "OPD";
    const apptTime = new Date(appt.appointmentTime).toLocaleDateString("en-IN", {
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric"
    });
    const { url: trackingUrl } = await issueAppointmentTrackerLink(appt);
    const { sendSmsWhatsAppNotification: sendSmsWhatsAppNotification2 } = await Promise.resolve().then(() => (init_SmsWhatsAppService(), SmsWhatsAppService_exports));
    await sendSmsWhatsAppNotification2({
      organizationId: appt.locationId?.organizationId?.toString() || appt.organizationId?.toString(),
      appointmentId: appt._id?.toString(),
      communicationContext: { organizationId: String(appt.organizationId), appointmentId: String(appt._id), purpose: "care_followup" },
      phone: targetPhone,
      patientName,
      channel: params.channel || "whatsapp",
      templateId: "APPOINTMENT_REMINDER",
      variables: {
        patientName,
        doctorName,
        locationName,
        appointmentTime: apptTime,
        tokenNumber: String(token),
        trackingUrl
      }
    }).catch((err) => console.error("Follow-up recall SMS/WhatsApp notice:", safeError(err)));
  } catch (err) {
    console.error("sendFollowUpRecallNotification error:", safeError(err));
  }
}
async function sendDoorwaySummonNotification(params) {
  try {
    const { Appointment: Appointment2 } = await Promise.resolve().then(() => (init_Appointment(), Appointment_exports));
    const appt = await Appointment2.findById(params.appointmentId).populate("locationId", "name phone organizationId").populate("doctorId", "name").populate({
      path: "patientId",
      populate: { path: "userId", select: "name email phone" }
    });
    if (!appt) return;
    const patientName = appt.patientId?.name || appt.patientId?.userId?.name || "Patient";
    const contact = await organizationContact(appt);
    const targetPhone = params.phone || contact.phone;
    if (!targetPhone) return;
    const doctorName = appt.doctorId?.name || "Doctor";
    const locationName = appt.locationId?.name || "Location";
    const token = appt.tokenNumber || "OPD";
    const { url: trackingUrl } = await issueAppointmentTrackerLink(appt);
    const { sendSmsWhatsAppNotification: sendSmsWhatsAppNotification2 } = await Promise.resolve().then(() => (init_SmsWhatsAppService(), SmsWhatsAppService_exports));
    await sendSmsWhatsAppNotification2({
      organizationId: appt.locationId?.organizationId?.toString() || appt.organizationId?.toString(),
      appointmentId: appt._id?.toString(),
      phone: targetPhone,
      patientName,
      channel: "whatsapp",
      templateId: "QUEUE_UPDATE",
      variables: {
        patientName,
        doctorName,
        locationName,
        tokenNumber: String(token),
        peopleAhead: "0 (CALLED IN NOW)",
        estimatedWaitTime: "0 mins - Please proceed inside to the Doctor Cabin",
        trackingUrl
      }
    }).catch((err) => console.error("Doorway summon SMS/WhatsApp notice:", safeError(err)));
  } catch (err) {
    console.error("sendDoorwaySummonNotification error:", safeError(err));
  }
}
var init_notifications = __esm({
  "utilities/notifications.ts"() {
    "use strict";
    init_safeError();
    init_config();
    init_Appointment();
    init_eventBus();
    init_types();
    init_CommunicationOutbox();
    init_FamilyAuthorityService();
    init_publicTracker();
  }
});

// models/LabTest.ts
var LabTest_exports = {};
__export(LabTest_exports, {
  LabTest: () => LabTest
});
import mongoose58, { Schema as Schema49 } from "mongoose";
var LabTestSchema, LabTest;
var init_LabTest = __esm({
  "models/LabTest.ts"() {
    "use strict";
    LabTestSchema = new Schema49({
      organizationId: { type: Schema49.Types.ObjectId, ref: "Organization", index: true },
      locationId: { type: Schema49.Types.ObjectId, ref: "Location", required: true, index: true },
      name: { type: String, required: true, index: true },
      code: { type: String, required: true, trim: true },
      department: { type: String, required: true },
      sampleType: { type: String, required: true },
      price: { type: Number, required: true },
      normalRange: { type: String, required: true },
      createdAt: { type: Date, default: Date.now }
    });
    LabTestSchema.index({ locationId: 1, code: 1 }, { unique: true });
    LabTestSchema.index({ organizationId: 1, code: 1 });
    LabTestSchema.virtual("id").get(function() {
      return this._id.toHexString();
    });
    LabTestSchema.set("toJSON", {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    });
    LabTest = mongoose58.model("LabTest", LabTestSchema);
  }
});

// models/Observation.ts
var Observation_exports = {};
__export(Observation_exports, {
  Observation: () => Observation
});
import mongoose59, { Schema as Schema50 } from "mongoose";
var ObservationSchema, Observation;
var init_Observation = __esm({
  "models/Observation.ts"() {
    "use strict";
    ObservationSchema = new Schema50({
      organizationId: { type: Schema50.Types.ObjectId, ref: "Organization", required: true, index: true },
      locationId: { type: Schema50.Types.ObjectId, ref: "Location", required: true, index: true },
      encounterId: { type: Schema50.Types.ObjectId, ref: "Encounter", required: true, index: true },
      patientId: { type: Schema50.Types.ObjectId, ref: "Patient", required: true, index: true },
      recordedBy: { type: Schema50.Types.ObjectId, ref: "User", required: true },
      code: { type: String, required: true, index: true },
      // e.g. "BP", "HR", "TEMP", "SPO2", "RR", "WEIGHT", "PAIN"
      name: { type: String, required: true },
      // e.g. "Blood Pressure", "Heart Rate"
      value: { type: String, required: true },
      // e.g. "120/80", "72", "98.4"
      unit: { type: String, default: "" },
      // e.g. "mmHg", "bpm", "°F", "%"
      referenceRange: { type: String, default: "" },
      // e.g. "< 120/80"
      recordedAt: { type: Date, default: Date.now, index: true },
      deletedAt: { type: Date, default: null, index: true }
    }, { timestamps: true });
    ObservationSchema.virtual("id").get(function() {
      return this._id.toHexString();
    });
    ObservationSchema.set("toJSON", {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    });
    Observation = mongoose59.model("Observation", ObservationSchema);
  }
});

// controllers/queue.ts
var queue_exports = {};
__export(queue_exports, {
  bumpQueuePatient: () => bumpQueuePatient,
  callNextPatient: () => callNextPatient,
  checkInAppointment: () => checkInAppointment,
  endOpdSessionAndReconcile: () => endOpdSessionAndReconcile,
  getAdaptiveConsultationDuration: () => getAdaptiveConsultationDuration,
  getAuditLogs: () => getAuditLogs,
  getOpdSessionSummary: () => getOpdSessionSummary,
  getQueue: () => getQueue,
  getQueueDelayStatus: () => getQueueDelayStatus,
  getQueueStatus: () => getQueueStatus,
  parkQueuePatient: () => parkQueuePatient,
  recordPatientVitals: () => recordPatientVitals,
  reorderQueue: () => reorderQueue,
  resendQueueTrackerNotification: () => resendQueueTrackerNotification,
  resumeForReportReview: () => resumeForReportReview,
  resumeQueuePatient: () => resumeQueuePatient,
  sendPatientForInvestigation: () => sendPatientForInvestigation,
  startOpdSession: () => startOpdSession,
  toggleDoctorBreak: () => toggleDoctorBreak,
  triggerQueueDelayAlerts: () => triggerQueueDelayAlerts,
  triggerStatEmergency: () => triggerStatEmergency,
  triggerTurnApproachingPacing: () => triggerTurnApproachingPacing,
  verifyAuditLogsIntegrity: () => verifyAuditLogsIntegrity
});
import crypto20 from "node:crypto";
import mongoose60 from "mongoose";
async function getAdaptiveConsultationDuration(locationId, doctorId, startOfDay, endOfDay, fallbackDuration) {
  try {
    const { Encounter: Encounter2 } = await Promise.resolve().then(() => (init_Encounter(), Encounter_exports));
    const completed = await Encounter2.find({
      locationId,
      doctorId,
      status: "completed",
      startedAt: { $exists: true, $ne: null },
      endedAt: { $exists: true, $ne: null },
      createdAt: { $gte: startOfDay, $lte: endOfDay }
    }).select("startedAt endedAt").lean();
    if (completed.length >= 2) {
      let totalMinutes = 0;
      let validCount = 0;
      for (const enc of completed) {
        if (enc.startedAt && enc.endedAt) {
          const diffMs = new Date(enc.endedAt).getTime() - new Date(enc.startedAt).getTime();
          const diffMinutes = Math.round(diffMs / (60 * 1e3));
          if (diffMinutes >= 2 && diffMinutes <= 120) {
            totalMinutes += diffMinutes;
            validCount++;
          }
        }
      }
      if (validCount >= 2) {
        const todayAvg = totalMinutes / validCount;
        const rawHybrid = 0.6 * fallbackDuration + 0.4 * todayAvg;
        const minBound = Math.max(3, Math.round(0.75 * fallbackDuration));
        const maxBound = Math.round(1.5 * fallbackDuration);
        const boundedHybrid = Math.max(minBound, Math.min(maxBound, Math.round(rawHybrid)));
        return { duration: boundedHybrid, isAdaptive: true, sampleCount: validCount };
      }
    }
  } catch (err) {
    console.error("getAdaptiveConsultationDuration error (fallback used):", safeError(err));
  }
  return { duration: fallbackDuration, isAdaptive: false, sampleCount: 0 };
}
async function getQueue(req, reply) {
  try {
    const { locationId, doctorId, date } = req.query;
    if (!locationId || !doctorId) {
      return reply.code(400).send(errorResponse("locationId and doctorId are required"));
    }
    const locationCheck = await checkLocationAccess(req, locationId);
    if (!locationCheck.allowed) {
      return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
    }
    const timezone = await getLocationTimezone(locationId);
    const dateStr = date ? date.slice(0, 10) : locationDateKey(/* @__PURE__ */ new Date(), timezone);
    const { start: startOfDay, end: endOfDay } = locationDayRange(dateStr, timezone);
    const assignment = await DoctorAssignment.findOne({ doctorId, locationId, isActive: true });
    const defaultDuration = assignment?.appointmentDuration || 15;
    const { duration, isAdaptive, sampleCount } = await getAdaptiveConsultationDuration(
      locationId,
      doctorId,
      startOfDay,
      endOfDay,
      defaultDuration
    );
    const appointments = await Appointment.find({
      locationId,
      doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay }
    }).populate({
      path: "patientId",
      populate: { path: "userId", select: "name email phone" }
    }).sort({ queuePosition: 1, tokenNumber: 1 });
    const inConsultationAppt = appointments.find((a) => a.status === "in-consultation");
    let inConsultationRemainingMinutes = 0;
    if (inConsultationAppt) {
      const { Encounter: Encounter2 } = await Promise.resolve().then(() => (init_Encounter(), Encounter_exports));
      const activeEncounter = await Encounter2.findOne({ appointmentId: inConsultationAppt._id, status: "in_progress" }).lean();
      if (activeEncounter?.startedAt) {
        const elapsedMinutes = Math.floor((Date.now() - new Date(activeEncounter.startedAt).getTime()) / (60 * 1e3));
        inConsultationRemainingMinutes = Math.max(1, duration - elapsedMinutes);
      } else {
        inConsultationRemainingMinutes = duration;
      }
    }
    let waitingAheadCount = 0;
    const queueList = appointments.map((appt) => {
      let estimatedWaitTime = 0;
      if (appt.status === "pending" || appt.status === "confirmed" || appt.status === "checked-in") {
        estimatedWaitTime = inConsultationRemainingMinutes + waitingAheadCount * duration;
        waitingAheadCount++;
      }
      return {
        ...appt.toJSON(),
        estimatedWaitTime,
        isAdaptiveDuration: isAdaptive
      };
    });
    return reply.code(200).send(successResponse(queueList));
  } catch (err) {
    console.error("getQueue error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
async function getQueueStatus(req, reply) {
  try {
    const { locationId, doctorId, date } = req.query;
    if (!locationId || !doctorId) {
      return reply.code(400).send(errorResponse("locationId and doctorId are required"));
    }
    const locationCheck = await checkLocationAccess(req, locationId);
    if (!locationCheck.allowed) {
      return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
    }
    const assignment = await DoctorAssignment.findOne({ doctorId, locationId, isActive: true });
    const defaultDuration = assignment?.appointmentDuration || 15;
    const bookingMode = assignment?.bookingMode || "sequential_queue";
    const maxDailyTokens = assignment?.maxDailyTokens || null;
    const timezone = await getLocationTimezone(locationId);
    const sessionDateStr = date ? date.slice(0, 10) : locationDateKey(/* @__PURE__ */ new Date(), timezone);
    const { start: startOfDay, end: endOfDay } = locationDayRange(sessionDateStr, timezone);
    const { duration, isAdaptive, sampleCount } = await getAdaptiveConsultationDuration(
      locationId,
      doctorId,
      startOfDay,
      endOfDay,
      defaultDuration
    );
    const appointments = await Appointment.find({
      locationId,
      doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      status: { $nin: ["cancelled", "disruption_triage"] }
    }).sort({ queuePosition: 1, tokenNumber: 1 });
    const totalBooked = appointments.length;
    const nextToken = totalBooked + 1;
    const inConsultationAppt = appointments.find((a) => a.status === "in-consultation");
    const currentlyServing = inConsultationAppt ? inConsultationAppt.tokenNumber : null;
    let inConsultationRemainingMinutes = 0;
    if (inConsultationAppt) {
      const { Encounter: Encounter2 } = await Promise.resolve().then(() => (init_Encounter(), Encounter_exports));
      const activeEncounter = await Encounter2.findOne({ appointmentId: inConsultationAppt._id, status: "in_progress" }).lean();
      if (activeEncounter?.startedAt) {
        const elapsedMinutes = Math.floor((Date.now() - new Date(activeEncounter.startedAt).getTime()) / (60 * 1e3));
        inConsultationRemainingMinutes = Math.max(1, duration - elapsedMinutes);
      } else {
        inConsultationRemainingMinutes = duration;
      }
    }
    let myToken = null;
    let myStatus = null;
    let peopleAhead = 0;
    let estimatedWaitMinutes = 0;
    if (req.user?.role === "patient" && req.user?.id) {
      const { Patient: Patient2 } = await Promise.resolve().then(() => (init_Patient(), Patient_exports));
      const patient = await Patient2.findOne({ userId: req.user.id });
      if (patient) {
        const myAppt = appointments.find((a) => a.patientId.toString() === patient._id.toString());
        if (myAppt) {
          myToken = myAppt.tokenNumber;
          myStatus = myAppt.status;
          const waitingStatuses = ["pending", "confirmed", "checked-in"];
          if (waitingStatuses.includes(myAppt.status)) {
            peopleAhead = appointments.filter((a) => {
              const isAhead = (a.queuePosition ?? a.tokenNumber) < (myAppt.queuePosition ?? myAppt.tokenNumber);
              const isWaitingOrInConsultation = [...waitingStatuses, "in-consultation"].includes(a.status);
              return isAhead && isWaitingOrInConsultation;
            }).length;
            estimatedWaitMinutes = inConsultationRemainingMinutes + peopleAhead * duration;
          }
        }
      }
    }
    const { OpdSession: OpdSession2 } = await Promise.resolve().then(() => (init_OpdSession(), OpdSession_exports));
    const opdSession = await OpdSession2.findOne({
      locationId,
      doctorId,
      date: sessionDateStr
    }).lean();
    return reply.code(200).send(
      successResponse({
        locationId,
        doctorId,
        date: sessionDateStr,
        bookingMode,
        currentlyServing,
        totalBooked,
        nextToken,
        averageDuration: duration,
        isAdaptiveDuration: isAdaptive,
        adaptiveSampleCount: sampleCount,
        maxDailyTokens,
        myToken,
        myStatus,
        peopleAhead,
        estimatedWaitMinutes,
        opdSession: opdSession || { status: "not_started", date: sessionDateStr }
      })
    );
  } catch (err) {
    console.error("getQueueStatus error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
async function reorderQueue(req, reply) {
  try {
    const { locationId, doctorId, date, orderedAppointmentIds } = req.body;
    if (!locationId || !doctorId || !date || !orderedAppointmentIds || !Array.isArray(orderedAppointmentIds)) {
      return reply.code(400).send(errorResponse("locationId, doctorId, date, and orderedAppointmentIds array are required"));
    }
    const locationCheck = await checkLocationAccess(req, locationId);
    if (!locationCheck.allowed) {
      return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
    }
    if (!mongoose60.Types.ObjectId.isValid(doctorId) || orderedAppointmentIds.some((id) => !mongoose60.Types.ObjectId.isValid(id))) {
      return reply.code(400).send(errorResponse("Invalid doctor or appointment ID"));
    }
    const targetDate = new Date(date);
    if (Number.isNaN(targetDate.getTime())) {
      return reply.code(400).send(errorResponse("Valid date is required"));
    }
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);
    const uniqueAppointmentIds = new Set(orderedAppointmentIds);
    if (uniqueAppointmentIds.size !== orderedAppointmentIds.length) {
      return reply.code(400).send(errorResponse("orderedAppointmentIds must not contain duplicates"));
    }
    const scopedAppointmentCount = await Appointment.countDocuments({
      _id: { $in: orderedAppointmentIds },
      locationId,
      doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay }
    });
    if (scopedAppointmentCount !== orderedAppointmentIds.length) {
      return reply.code(403).send(errorResponse("One or more appointments are outside the selected location, doctor, or date"));
    }
    const { withTransaction: withTransaction2 } = await Promise.resolve().then(() => (init_transaction(), transaction_exports));
    return await withTransaction2(async (session) => {
      const bulkOps = orderedAppointmentIds.map((id, index) => ({
        updateOne: {
          filter: { _id: id, locationId, doctorId, appointmentTime: { $gte: startOfDay, $lte: endOfDay } },
          update: { queuePosition: index + 1 }
        }
      }));
      if (bulkOps.length > 0) {
        await Appointment.bulkWrite(bulkOps, { session: session || void 0 });
      }
      await AuditLog.create([
        {
          userId: req.user.id,
          action: "VIP_OVERRIDE",
          targetId: new mongoose60.Types.ObjectId(locationId),
          targetModel: "Location",
          details: { doctorId, date, orderedAppointmentIds }
        }
      ], { session });
      broadcastQueueUpdate(locationId, {
        type: "QUEUE_UPDATED",
        data: { locationId, doctorId, date, action: "REORDERED" },
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      });
      return reply.code(200).send(successResponse(null, "Queue reordered successfully"));
    });
  } catch (err) {
    console.error("reorderQueue error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
async function getAuditLogs(req, reply) {
  try {
    const filter = {};
    const query = req.query;
    if (req.user?.role !== "root") {
      const orgId = getRequestOrganizationId(req);
      if (!orgId) return reply.code(403).send(errorResponse("Organization context is required"));
      filter.organizationId = orgId;
    } else {
      if (query.locationId && mongoose60.Types.ObjectId.isValid(String(query.locationId))) {
        const location2 = await Location.findById(String(query.locationId)).select("organizationId").lean();
        if (location2?.organizationId) {
          filter.organizationId = location2.organizationId;
        }
      } else if (query.organizationId && mongoose60.Types.ObjectId.isValid(String(query.organizationId))) {
        filter.organizationId = String(query.organizationId);
      }
    }
    if (query.doctorId && mongoose60.Types.ObjectId.isValid(String(query.doctorId))) {
      filter.userId = new mongoose60.Types.ObjectId(String(query.doctorId));
    }
    if (query.category && typeof query.category === "string") {
      filter.category = query.category;
    }
    if (query.action && typeof query.action === "string") {
      filter.action = query.action;
    }
    if (query.startDate || query.endDate) {
      filter.createdAt = {};
      if (query.startDate) {
        const start = new Date(String(query.startDate));
        if (!isNaN(start.getTime())) filter.createdAt.$gte = start;
      }
      if (query.endDate) {
        const end = new Date(String(query.endDate));
        if (!isNaN(end.getTime())) {
          end.setHours(23, 59, 59, 999);
          filter.createdAt.$lte = end;
        }
      }
      if (Object.keys(filter.createdAt).length === 0) delete filter.createdAt;
    }
    const { page, limit, cursor, format } = query;
    if (cursor || format === "paginated") {
      const pagination = getCursorPaginationParams({ cursor, limit }, 20, 100);
      const decoded = decodeCursor(pagination.cursor);
      const cursorFilter = buildCursorFilter(decoded, { timeField: "createdAt", sortDirection: "desc" });
      const cursorQueryFilter = { ...filter, ...cursorFilter };
      const rawLogs = await AuditLog.find(cursorQueryFilter).populate("userId", "name email role").sort({ createdAt: -1, _id: -1 }).limit(pagination.limit + 1).lean();
      const result = formatCursorResult(rawLogs, pagination.limit, "createdAt");
      reply.header("X-Next-Cursor", result.nextCursor || "");
      reply.header("X-Has-Next-Page", String(result.hasNextPage));
      reply.header("X-Page-Limit", String(result.limit));
      reply.header("Access-Control-Expose-Headers", "X-Next-Cursor, X-Has-Next-Page, X-Page-Limit");
      return reply.code(200).send(successResponse(result));
    }
    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });
    const totalCount = await AuditLog.countDocuments(filter);
    const totalPages = Math.ceil(totalCount / pageSize);
    const logs = await AuditLog.find(filter).populate("userId", "name email role").sort({ createdAt: -1, _id: -1 }).skip(skip).limit(pageSize);
    setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });
    return reply.code(200).send(successResponse(logs));
  } catch (err) {
    console.error("getAuditLogs error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
async function verifyAuditLogsIntegrity(req, reply) {
  try {
    let orgId = null;
    if (req.user?.role !== "root") {
      const tenantOrgId = getRequestOrganizationId(req);
      if (!tenantOrgId) return reply.code(403).send(errorResponse("Organization context is required"));
      orgId = tenantOrgId.toString();
    } else {
      const queryOrgId = req.query?.organizationId;
      if (queryOrgId) orgId = String(queryOrgId);
    }
    const verification = await verifyAuditChainIntegrity(orgId);
    return reply.code(200).send(successResponse(verification));
  } catch (err) {
    console.error("verifyAuditLogsIntegrity error:", safeError(err));
    return reply.code(500).send(errorResponse(err?.message || "Internal server error"));
  }
}
async function checkInAppointment(req, reply) {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;
    if (!mongoose60.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }
    let appointment = await Appointment.findById(id).populate({
      path: "patientId",
      populate: { path: "userId", select: "name email phone" }
    });
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }
    const locationCheck = await checkLocationAccess(req, appointment.locationId);
    if (!locationCheck.allowed) {
      return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
    }
    const patientUserId = appointment.patientId?.userId?._id?.toString() || appointment.patientId?.userId?.id?.toString() || appointment.patientId?.userId?.toString();
    if (["patient", "family_member", "guest"].includes(userRole)) {
      const isBookingOwner = String(appointment.bookedByUserId || "") === String(userId);
      const ownsPatient = await Patient.exists({ _id: appointment.patientId?._id || appointment.patientId, userId });
      const hasFamilyRelationship = await FamilyRelationship.exists({
        userId,
        patientId: appointment.patientId?._id || appointment.patientId,
        status: "active"
      });
      if (!isBookingOwner && !ownsPatient && !hasFamilyRelationship) {
        return reply.code(403).send(errorResponse("Forbidden: You can only check in for your own or linked family appointment"));
      }
    }
    if (["completed", "cancelled", "no-show"].includes(appointment.status)) {
      return reply.code(409).send(errorResponse(`Cannot check in for an appointment that is already ${appointment.status}`));
    }
    if (appointment.status === "checked-in" || appointment.status === "in-consultation") {
      return reply.code(200).send(successResponse(appointment, `Patient is already ${appointment.status}`));
    }
    const checkedInAppointment = await Appointment.findOneAndUpdate(
      { _id: appointment._id, status: { $in: ["pending", "confirmed"] } },
      { $set: { status: "checked-in" } },
      { returnDocument: "after" }
    );
    if (!checkedInAppointment) {
      const latestAppointment = await Appointment.findById(appointment._id);
      if (latestAppointment && ["checked-in", "in-consultation"].includes(latestAppointment.status)) {
        return reply.code(200).send(successResponse(latestAppointment, `Patient is already ${latestAppointment.status}`));
      }
      return reply.code(409).send(errorResponse("Appointment was changed by another request. Refresh and try again."));
    }
    appointment = checkedInAppointment;
    const { eventBus: eventBus2 } = await Promise.resolve().then(() => (init_eventBus(), eventBus_exports));
    const { EVENT_TYPES: EVENT_TYPES2 } = await Promise.resolve().then(() => (init_types(), types_exports));
    if (patientUserId) {
      await eventBus2.publishDurable({
        eventType: EVENT_TYPES2.PATIENT_APPOINTMENT_CHECKED_IN,
        category: "patient",
        targetUserId: patientUserId,
        title: "Checked In Successfully \u2705",
        message: `You are checked in for your appointment. Token #${appointment.tokenNumber}`,
        severity: "success",
        organizationId: locationCheck.organizationId || void 0,
        actionUrl: "/dashboard/appointments"
      });
    }
    await AuditLog.create({
      userId,
      action: "PATIENT_CHECK_IN",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: { tokenNumber: appointment.tokenNumber, locationId: appointment.locationId }
    });
    broadcastQueueUpdate(appointment.locationId.toString(), {
      type: "QUEUE_UPDATED",
      data: {
        appointmentId: appointment._id.toString(),
        tokenNumber: appointment.tokenNumber,
        status: "checked-in",
        locationId: appointment.locationId.toString()
      },
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
    return reply.code(200).send(successResponse(appointment, `Checked in successfully! Token #${appointment.tokenNumber}`));
  } catch (err) {
    console.error("checkInAppointment error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
async function triggerTurnApproachingPacing(locationId, doctorId) {
  try {
    if (!locationId || !doctorId) return;
    const timezone = await getLocationTimezone(locationId);
    const { start: startOfDay, end: endOfDay } = locationDayRange(locationDateKey(/* @__PURE__ */ new Date(), timezone), timezone);
    const waitingAppts = await Appointment.find({
      locationId,
      doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      status: { $in: ["checked-in", "confirmed"] }
    });
    if (!waitingAppts || waitingAppts.length === 0) return;
    const getStatusPriority = (s) => {
      if (s === "checked-in") return 1;
      if (s === "confirmed") return 2;
      return 3;
    };
    waitingAppts.sort((a, b) => {
      const pA = getStatusPriority(a.status);
      const pB = getStatusPriority(b.status);
      if (pA !== pB) return pA - pB;
      const qA = a.queuePosition ?? a.tokenNumber ?? 999;
      const qB = b.queuePosition ?? b.tokenNumber ?? 999;
      if (qA !== qB) return qA - qB;
      return (a.tokenNumber || 0) - (b.tokenNumber || 0);
    });
    for (const [index, appointment] of waitingAppts.slice(0, 2).entries()) {
      await withClinicalTransaction(async () => {
        const claimed = await Appointment.updateOne(
          {
            _id: appointment._id,
            locationId,
            doctorId,
            status: { $in: ["checked-in", "confirmed"] },
            turnApproachingNotifiedAt: null
          },
          { $set: { turnApproachingNotifiedAt: /* @__PURE__ */ new Date() } }
        );
        if (claimed.modifiedCount) await publishAppointmentCommunication(appointment, { action: "turn_approaching" });
      });
    }
  } catch (err) {
    console.error("triggerTurnApproachingPacing error:", safeError(err));
  }
}
async function callNextPatient(req, reply) {
  try {
    const userRole = req.user.role;
    const userId = req.user.id;
    const { locationId, doctorId, completePrevious = false, requireArrivalConfirmation = false, confirmedAppointmentId } = req.body || {};
    const targetDoctorId = doctorId || (userRole === "doctor" ? userId : null);
    if (!targetDoctorId) {
      return reply.code(400).send(errorResponse("doctorId is required"));
    }
    if (locationId) {
      const locationCheck = await checkLocationAccess(req, locationId);
      if (!locationCheck.allowed) {
        return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
      }
    } else if (userRole !== "root") {
      return reply.code(400).send(errorResponse("locationId is required"));
    }
    if (!mongoose60.Types.ObjectId.isValid(targetDoctorId)) {
      return reply.code(400).send(errorResponse("Invalid doctor ID"));
    }
    const now = /* @__PURE__ */ new Date();
    const timezone = locationId ? await getLocationTimezone(locationId) : void 0;
    const { start: startOfDay, end: endOfDay } = timezone ? locationDayRange(locationDateKey(now, timezone), timezone) : { start: new Date(now.getFullYear(), now.getMonth(), now.getDate()), end: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999) };
    const activeConsultation = await Appointment.findOne({
      doctorId: targetDoctorId,
      status: "in-consultation",
      appointmentTime: { $gte: startOfDay, $lte: endOfDay }
    }).populate({
      path: "patientId",
      select: "name"
    });
    if (activeConsultation) {
      if (completePrevious) {
        const access = await checkLocationAccess(req, activeConsultation.locationId.toString());
        if (!access.allowed) return reply.code(403).send(errorResponse("You cannot close the active consultation at another location"));
      }
      if (!completePrevious) {
        return reply.code(409).send(
          errorResponse(
            `Doctor already has an active consultation with ${activeConsultation.patientId?.name || "a patient"} (Token #${activeConsultation.tokenNumber}). Complete the current consultation first, or pass completePrevious: true.`,
            "ACTIVE_CONSULTATION_IN_PROGRESS"
          )
        );
      }
    }
    const query = {
      doctorId: targetDoctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      status: { $in: ["checked-in", "confirmed", "pending"] }
    };
    if (locationId) query.locationId = locationId;
    else if (req.user?.organization_id) {
      const { getRequestLocationIds: getRequestLocationIds2 } = await Promise.resolve().then(() => (init_tenant(), tenant_exports));
      query.locationId = { $in: await getRequestLocationIds2(req) };
    }
    const waitingAppts = await Appointment.find(query).populate({
      path: "patientId",
      populate: { path: "userId", select: "name email phone" }
    }).populate("locationId", "name city");
    if (waitingAppts.length === 0) {
      return reply.code(200).send(successResponse(null, "No waiting patients in queue for today"));
    }
    const getStatusPriority = (s) => {
      if (s === "checked-in") return 1;
      if (s === "confirmed") return 2;
      return 3;
    };
    waitingAppts.sort((a, b) => {
      const pA = getStatusPriority(a.status);
      const pB = getStatusPriority(b.status);
      if (pA !== pB) return pA - pB;
      const qA = a.queuePosition ?? a.tokenNumber ?? 999;
      const qB = b.queuePosition ?? b.tokenNumber ?? 999;
      if (qA !== qB) return qA - qB;
      return (a.tokenNumber || 0) - (b.tokenNumber || 0);
    });
    const nextCandidate = waitingAppts[0];
    if (requireArrivalConfirmation && nextCandidate.status !== "checked-in" && confirmedAppointmentId !== nextCandidate._id.toString()) {
      return reply.code(409).send({ ...errorResponse("The next booked patient has not checked in. Confirm that you want to call this patient.", "ARRIVAL_CONFIRMATION_REQUIRED"), data: { id: nextCandidate._id.toString(), tokenNumber: nextCandidate.tokenNumber } });
    }
    let nextAppt;
    await withClinicalTransaction(async () => {
      if (activeConsultation) {
        await Appointment.updateOne(
          { _id: activeConsultation._id, status: "in-consultation" },
          {
            $set: { status: "completed" },
            $unset: { activeConsultationDoctorDayKey: 1 }
          }
        );
        const { Encounter: Encounter3 } = await Promise.resolve().then(() => (init_Encounter(), Encounter_exports));
        const previousEncounter = await Encounter3.findOne({ appointmentId: activeConsultation._id });
        if (previousEncounter && ["cancelled", "closed"].includes(previousEncounter.status)) {
          throw Object.assign(new Error("The previous encounter needs review before this visit can be closed"), { statusCode: 409 });
        }
        if (previousEncounter) {
          previousEncounter.status = "completed";
          previousEncounter.endedAt = /* @__PURE__ */ new Date();
          await previousEncounter.save();
        } else {
          const owner = await Location.findById(activeConsultation.locationId).select("organizationId").lean();
          await Encounter3.create({
            organizationId: activeConsultation.organizationId || owner?.organizationId,
            locationId: activeConsultation.locationId,
            appointmentId: activeConsultation._id,
            patientId: activeConsultation.patientId,
            doctorId: activeConsultation.doctorId,
            status: "completed",
            endedAt: /* @__PURE__ */ new Date()
          });
        }
        await AuditLog.create({
          userId,
          action: "CONSULTATION_AUTO_COMPLETED_ON_NEXT",
          targetId: activeConsultation._id,
          targetModel: "Appointment",
          category: "ADMIN",
          details: {
            tokenNumber: activeConsultation.tokenNumber,
            doctorId: targetDoctorId,
            clinicalFinalization: "not_requested"
          }
        });
      }
      const claimed = await Appointment.findOneAndUpdate(
        {
          _id: nextCandidate._id,
          status: { $in: ["checked-in", "confirmed", "pending"] }
        },
        {
          $set: {
            status: "in-consultation",
            queuePosition: 0,
            activeConsultationDoctorDayKey: getActiveConsultationDoctorDayKey(targetDoctorId, nextCandidate.appointmentTime)
          }
        },
        { returnDocument: "after" }
      ).populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" }
      }).populate("locationId", "name city");
      if (!claimed) throw Object.assign(new Error("Patient was already called or modified. Refresh the queue."), { statusCode: 409 });
      nextAppt = claimed;
      const { Encounter: Encounter2 } = await Promise.resolve().then(() => (init_Encounter(), Encounter_exports));
      const existingEncounter = await Encounter2.findOne({ appointmentId: nextAppt._id });
      if (!existingEncounter) {
        await Encounter2.create({
          organizationId: nextAppt.organizationId || nextAppt.locationId?.organizationId,
          locationId: nextAppt.locationId?._id || nextAppt.locationId,
          appointmentId: nextAppt._id,
          patientId: nextAppt.patientId?._id || nextAppt.patientId,
          doctorId: nextAppt.doctorId,
          encounterType: nextAppt.appointmentType === "online" ? "telehealth" : "opd",
          status: "in_progress",
          startedAt: /* @__PURE__ */ new Date()
        });
      }
      await AuditLog.create({
        userId,
        action: "PATIENT_CALL_NEXT",
        targetId: nextAppt._id,
        targetModel: "Appointment",
        details: { tokenNumber: nextAppt.tokenNumber, status: "in-consultation" }
      });
    });
    nextAppt.$session(null);
    const { eventBus: eventBus2 } = await Promise.resolve().then(() => (init_eventBus(), eventBus_exports));
    const { EVENT_TYPES: EVENT_TYPES2 } = await Promise.resolve().then(() => (init_types(), types_exports));
    const patientUserId = nextAppt.patientId?.userId?._id?.toString() || nextAppt.patientId?.userId?.toString();
    if (patientUserId) {
      await eventBus2.publishDurable({
        eventType: EVENT_TYPES2.PATIENT_CALL_NEXT,
        category: "patient",
        targetUserId: patientUserId,
        title: "Called for Consultation \u{1FA7A}",
        message: `Please proceed to consultation room. Token #${nextAppt.tokenNumber}`,
        severity: "info",
        actionUrl: "/dashboard/appointments"
      }).catch((err) => req.log.error(safeError(err), "Queue advance committed; notification delivery failed"));
    }
    const patientPhone = nextAppt.patientId?.phone || nextAppt.patientId?.userId?.phone;
    if (patientPhone) {
      try {
        const { sendDoorwaySummonNotification: sendDoorwaySummonNotification2 } = await Promise.resolve().then(() => (init_notifications(), notifications_exports));
        await sendDoorwaySummonNotification2({
          appointmentId: nextAppt._id.toString(),
          phone: patientPhone
        });
      } catch (waErr) {
      }
    }
    const targetLocationId = nextAppt.locationId?._id?.toString() || nextAppt.locationId?.toString();
    if (targetLocationId) {
      broadcastQueueUpdate(targetLocationId, {
        type: "QUEUE_CALL_NEXT",
        data: {
          appointmentId: nextAppt._id.toString(),
          tokenNumber: nextAppt.tokenNumber,
          doctorId: targetDoctorId,
          locationId: targetLocationId
        },
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
    triggerTurnApproachingPacing(nextAppt.locationId, targetDoctorId).catch(
      (err) => console.error("Background turn approaching pacing error on call next:", safeError(err))
    );
    return reply.code(200).send(successResponse(nextAppt, `Calling Token #${nextAppt.tokenNumber}`));
  } catch (err) {
    console.error("callNextPatient error:", safeError(err));
    if (err?.statusCode === 409) return reply.code(409).send(errorResponse(err.message, "CONCURRENT_QUEUE_CALL"));
    if (isActiveConsultationLockConflict(err)) {
      return reply.code(409).send(errorResponse("Doctor already has an active consultation. Refresh the queue before calling the next patient.", "ACTIVE_CONSULTATION_IN_PROGRESS"));
    }
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
async function bumpQueuePatient(req, reply) {
  try {
    const { id } = req.params;
    const { bumpPositions = 2 } = req.body || {};
    if (!mongoose60.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }
    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }
    const locationCheck = await checkLocationAccess(req, appointment.locationId.toString());
    if (!locationCheck.allowed) {
      return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
    }
    const targetDate = new Date(appointment.appointmentTime);
    const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0, 0);
    const endOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 23, 59, 59, 999);
    const activeWaiting = await Appointment.find({
      locationId: appointment.locationId,
      doctorId: appointment.doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      status: { $in: ["checked-in", "confirmed", "pending"] }
    }).sort({ queuePosition: 1, tokenNumber: 1 });
    const currentIndex = activeWaiting.findIndex((a) => a._id.toString() === appointment._id.toString());
    if (currentIndex === -1) {
      return reply.code(400).send(errorResponse("Patient is not in an active waiting state"));
    }
    const targetIndex = Math.min(activeWaiting.length - 1, currentIndex + bumpPositions);
    if (targetIndex !== currentIndex) {
      const [movedItem] = activeWaiting.splice(currentIndex, 1);
      activeWaiting.splice(targetIndex, 0, movedItem);
      for (let i = 0; i < activeWaiting.length; i++) {
        activeWaiting[i].queuePosition = i + 1;
        await activeWaiting[i].save();
      }
    }
    appointment.notes = appointment.notes ? `${appointment.notes} | [Late arrival: bumped back ${bumpPositions} positions]` : `[Late arrival: bumped back ${bumpPositions} positions]`;
    await appointment.save();
    await AuditLog.create({
      userId: req.user.id,
      action: "QUEUE_PATIENT_BUMP_BACK",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: { previousIndex: currentIndex, newIndex: targetIndex, bumpPositions }
    });
    broadcastQueueUpdate(appointment.locationId.toString(), {
      type: "QUEUE_UPDATED",
      data: {
        locationId: appointment.locationId.toString(),
        doctorId: appointment.doctorId.toString(),
        bumpedAppointmentId: appointment._id.toString()
      },
      message: `Patient Token #${appointment.tokenNumber} bumped back due to late arrival`,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
    triggerTurnApproachingPacing(appointment.locationId, appointment.doctorId).catch(
      (err) => console.error("Background turn approaching pacing error on bump:", safeError(err))
    );
    return reply.code(200).send(
      successResponse(
        { appointment, newPosition: targetIndex + 1 },
        `Patient moved ${bumpPositions} positions back in queue`
      )
    );
  } catch (err) {
    console.error("bumpQueuePatient error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
async function parkQueuePatient(req, reply) {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    if (!mongoose60.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }
    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }
    const locationCheck = await checkLocationAccess(req, appointment.locationId.toString());
    if (!locationCheck.allowed) {
      return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
    }
    if (appointment.status === "in-consultation") {
      return reply.code(400).send(errorResponse("Cannot park a patient currently in active consultation"));
    }
    if (appointment.status !== "checked-in" && appointment.status !== "confirmed" && appointment.status !== "pending") {
      return reply.code(400).send(errorResponse("Only waiting or checked-in patients can be placed in standby"));
    }
    const targetDate = new Date(appointment.appointmentTime);
    const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0, 0);
    const endOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 23, 59, 59, 999);
    const oldPosition = appointment.queuePosition;
    appointment.status = "standby";
    appointment.parkedAt = /* @__PURE__ */ new Date();
    appointment.parkedReason = reason || "Stepped out / did not respond to summon";
    appointment.queuePosition = void 0;
    appointment.notes = appointment.notes ? `${appointment.notes} | [Standby: ${appointment.parkedReason}]` : `[Standby: ${appointment.parkedReason}]`;
    await appointment.save();
    const remainingWaiting = await Appointment.find({
      locationId: appointment.locationId,
      doctorId: appointment.doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      status: { $in: ["checked-in", "confirmed", "pending"] }
    }).sort({ queuePosition: 1, tokenNumber: 1 });
    for (let i = 0; i < remainingWaiting.length; i++) {
      remainingWaiting[i].queuePosition = i + 1;
      await remainingWaiting[i].save();
    }
    await AuditLog.create({
      userId: req.user.id,
      organizationId: appointment.organizationId,
      action: "QUEUE_PATIENT_PARKED",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: {
        tokenNumber: appointment.tokenNumber,
        previousPosition: oldPosition,
        parkedReason: appointment.parkedReason,
        reason: appointment.parkedReason,
        locationId: appointment.locationId,
        doctorId: appointment.doctorId
      }
    });
    const locationIdStr = appointment.locationId.toString();
    broadcastQueueUpdate(locationIdStr, {
      type: "QUEUE_UPDATED",
      data: {
        locationId: locationIdStr,
        doctorId: appointment.doctorId.toString(),
        parkedAppointmentId: appointment._id.toString()
      },
      message: `Token #${appointment.tokenNumber} moved to standby (${appointment.parkedReason})`,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
    triggerTurnApproachingPacing(appointment.locationId, appointment.doctorId).catch(
      (err) => console.error("Background turn approaching pacing error on park:", safeError(err))
    );
    return reply.code(200).send(successResponse(appointment, `Patient Token #${appointment.tokenNumber} moved to standby`));
  } catch (err) {
    console.error("parkQueuePatient error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
async function resumeQueuePatient(req, reply) {
  try {
    const { id } = req.params;
    if (!mongoose60.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }
    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }
    const locationCheck = await checkLocationAccess(req, appointment.locationId.toString());
    if (!locationCheck.allowed) {
      return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
    }
    if (appointment.status !== "standby") {
      return reply.code(400).send(errorResponse("Only patients in standby can be resumed to queue"));
    }
    const targetDate = new Date(appointment.appointmentTime);
    const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0, 0);
    const endOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 23, 59, 59, 999);
    const existingWaiting = await Appointment.find({
      locationId: appointment.locationId,
      doctorId: appointment.doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      status: { $in: ["checked-in", "confirmed", "pending"] },
      _id: { $ne: appointment._id }
    }).sort({ queuePosition: 1, tokenNumber: 1 });
    for (let i = 0; i < existingWaiting.length; i++) {
      existingWaiting[i].queuePosition = i + 2;
      await existingWaiting[i].save();
    }
    appointment.status = "checked-in";
    appointment.queuePosition = 1;
    appointment.notes = appointment.notes ? `${appointment.notes} | [Resumed from Standby - Next Up]` : `[Resumed from Standby - Next Up]`;
    await appointment.save();
    await AuditLog.create({
      userId: req.user.id,
      organizationId: appointment.organizationId,
      action: "QUEUE_PATIENT_RESUMED",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: {
        tokenNumber: appointment.tokenNumber,
        assignedPosition: 1,
        restoredPosition: 1,
        isPriorityNextUp: true,
        locationId: appointment.locationId,
        doctorId: appointment.doctorId
      }
    });
    const locationIdStr = appointment.locationId.toString();
    broadcastQueueUpdate(locationIdStr, {
      type: "QUEUE_UPDATED",
      data: {
        locationId: locationIdStr,
        doctorId: appointment.doctorId.toString(),
        resumedAppointmentId: appointment._id.toString()
      },
      message: `Token #${appointment.tokenNumber} resumed from standby as Next Up!`,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
    triggerTurnApproachingPacing(appointment.locationId, appointment.doctorId).catch(
      (err) => console.error("Background turn approaching pacing error on resume:", safeError(err))
    );
    return reply.code(200).send(successResponse(appointment, `Patient Token #${appointment.tokenNumber} resumed as Next Up`));
  } catch (err) {
    console.error("resumeQueuePatient error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
async function getQueueDelayStatus(req, reply) {
  try {
    const { locationId, doctorId, date } = req.query;
    if (!locationId || !doctorId) {
      return reply.code(400).send(errorResponse("locationId and doctorId are required"));
    }
    const locationCheck = await checkLocationAccess(req, locationId);
    if (!locationCheck.allowed) {
      return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
    }
    const targetDate = date ? new Date(date) : /* @__PURE__ */ new Date();
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);
    const assignment = await DoctorAssignment.findOne({ doctorId, locationId, isActive: true });
    const defaultDuration = assignment?.appointmentDuration || 15;
    const { duration } = await getAdaptiveConsultationDuration(
      locationId,
      doctorId,
      startOfDay,
      endOfDay,
      defaultDuration
    );
    const appointments = await Appointment.find({
      locationId,
      doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay }
    }).select("patientId status tokenNumber queuePosition appointmentTime delayNotifiedAt lastNotifiedDelayMinutes").sort({ queuePosition: 1, tokenNumber: 1 }).lean();
    const inConsultationAppt = appointments.find((a) => a.status === "in-consultation");
    let inConsultationRemainingMinutes = 0;
    if (inConsultationAppt) {
      const { Encounter: Encounter2 } = await Promise.resolve().then(() => (init_Encounter(), Encounter_exports));
      const activeEncounter = await Encounter2.findOne({ appointmentId: inConsultationAppt._id, status: "in_progress" }).lean();
      if (activeEncounter?.startedAt) {
        const elapsedMinutes = Math.floor((Date.now() - new Date(activeEncounter.startedAt).getTime()) / (60 * 1e3));
        inConsultationRemainingMinutes = Math.max(1, duration - elapsedMinutes);
      } else {
        inConsultationRemainingMinutes = duration;
      }
    }
    let waitingAheadCount = 0;
    const now = /* @__PURE__ */ new Date();
    const delayedCandidates = [];
    for (const appt of appointments) {
      if (appt.status === "pending" || appt.status === "confirmed" || appt.status === "checked-in") {
        const estimatedWaitMinutes = inConsultationRemainingMinutes + waitingAheadCount * duration;
        const projectedStartTime = new Date(now.getTime() + estimatedWaitMinutes * 60 * 1e3);
        const scheduledTime = new Date(appt.appointmentTime);
        const delayMinutes = Math.round((projectedStartTime.getTime() - scheduledTime.getTime()) / (60 * 1e3));
        if ((appt.status === "pending" || appt.status === "confirmed") && delayMinutes >= 20) {
          delayedCandidates.push({ ...appt, projectedStartTime, delayMinutes });
        }
        waitingAheadCount++;
      }
    }
    const populatedCandidates = delayedCandidates.length ? await Appointment.populate(delayedCandidates, {
      path: "patientId",
      select: "name phone userId",
      populate: { path: "userId", select: "name phone" }
    }) : [];
    const delayedPatients = populatedCandidates.map((appt) => ({
      appointmentId: appt._id.toString(),
      tokenNumber: appt.tokenNumber,
      patientName: appt.patientId?.userId?.name || appt.patientId?.name || "Patient",
      phone: appt.patientId?.userId?.phone || appt.patientId?.phone,
      scheduledTime: new Date(appt.appointmentTime).toISOString(),
      projectedStartTime: appt.projectedStartTime.toISOString(),
      delayMinutes: appt.delayMinutes,
      revisedArrivalTime: appt.projectedStartTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      delayNotifiedAt: appt.delayNotifiedAt,
      lastNotifiedDelayMinutes: appt.lastNotifiedDelayMinutes
    }));
    const maxDelayMinutes = delayedPatients.length > 0 ? Math.max(...delayedPatients.map((p) => p.delayMinutes)) : 0;
    return reply.code(200).send(successResponse({
      isDelayed: delayedPatients.length > 0,
      maxDelayMinutes,
      affectedCount: delayedPatients.length,
      delayedPatients
    }));
  } catch (err) {
    console.error("getQueueDelayStatus error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
async function triggerQueueDelayAlerts(req, reply) {
  try {
    const { locationId, doctorId, date, delayThresholdMinutes = 20 } = req.body || {};
    if (!locationId || !doctorId) {
      return reply.code(400).send(errorResponse("locationId and doctorId are required"));
    }
    const locationCheck = await checkLocationAccess(req, locationId);
    if (!locationCheck.allowed) {
      return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
    }
    const targetDate = date ? new Date(date) : /* @__PURE__ */ new Date();
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);
    const [assignment, location2, doctor] = await Promise.all([
      DoctorAssignment.findOne({ doctorId, locationId, isActive: true }),
      Location.findById(locationId).select("name organizationId"),
      User.findById(doctorId).select("name")
    ]);
    const defaultDuration = assignment?.appointmentDuration || 15;
    const { duration } = await getAdaptiveConsultationDuration(locationId, doctorId, startOfDay, endOfDay, defaultDuration);
    const appointments = await Appointment.find({
      locationId,
      doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay }
    }).populate({
      path: "patientId",
      populate: { path: "userId", select: "name email phone" }
    }).sort({ queuePosition: 1, tokenNumber: 1 });
    const inConsultationAppt = appointments.find((a) => a.status === "in-consultation");
    let inConsultationRemainingMinutes = 0;
    if (inConsultationAppt) {
      const { Encounter: Encounter2 } = await Promise.resolve().then(() => (init_Encounter(), Encounter_exports));
      const activeEncounter = await Encounter2.findOne({ appointmentId: inConsultationAppt._id, status: "in_progress" }).lean();
      if (activeEncounter?.startedAt) {
        const elapsedMinutes = Math.floor((Date.now() - new Date(activeEncounter.startedAt).getTime()) / (60 * 1e3));
        inConsultationRemainingMinutes = Math.max(1, duration - elapsedMinutes);
      } else {
        inConsultationRemainingMinutes = duration;
      }
    }
    let waitingAheadCount = 0;
    const now = /* @__PURE__ */ new Date();
    let notifiedCount = 0;
    const debounceMs = 45 * 60 * 1e3;
    for (const appt of appointments) {
      if (appt.status === "pending" || appt.status === "confirmed" || appt.status === "checked-in") {
        const estimatedWaitMinutes = inConsultationRemainingMinutes + waitingAheadCount * duration;
        const projectedStartTime = new Date(now.getTime() + estimatedWaitMinutes * 60 * 1e3);
        const scheduledTime = new Date(appt.appointmentTime);
        const delayMinutes = Math.round((projectedStartTime.getTime() - scheduledTime.getTime()) / (60 * 1e3));
        if ((appt.status === "pending" || appt.status === "confirmed") && delayMinutes >= delayThresholdMinutes) {
          const patientUser = appt.patientId?.userId;
          const phone = patientUser?.phone || appt.patientId?.phone;
          const patientName = patientUser?.name || appt.patientId?.name || "Patient";
          const isDebounced = appt.delayNotifiedAt && now.getTime() - new Date(appt.delayNotifiedAt).getTime() < debounceMs;
          if (phone && !isDebounced) {
            try {
              const prepared = await withClinicalTransaction(async () => {
                const claimed = await Appointment.findOneAndUpdate({ _id: appt._id, organizationId: appt.organizationId, locationId: appt.locationId, status: { $in: ["pending", "confirmed"] }, $or: [{ delayNotifiedAt: null }, { delayNotifiedAt: { $lte: new Date(now.getTime() - debounceMs) } }] }, { $set: { delayNotifiedAt: now, lastNotifiedDelayMinutes: delayMinutes } }, { returnDocument: "after" });
                if (!claimed) return false;
                await publishAppointmentCommunication(claimed, { action: "queue_delay", actorId: req.user.id });
                return true;
              });
              if (prepared) notifiedCount++;
            } catch (notifyErr) {
              console.error(`[QueueDelay] Failed to notify appointment ${appt._id}:`, safeError(notifyErr));
            }
          }
        }
        waitingAheadCount++;
      }
    }
    return reply.code(200).send(successResponse({ notifiedCount, queuedCount: notifiedCount }, `Prepared queue updates for ${notifiedCount} patient(s); delivery remains subject to current consent`));
  } catch (err) {
    console.error("triggerQueueDelayAlerts error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
async function sendPatientForInvestigation(req, reply) {
  try {
    const { id } = req.params;
    const { notes, testIds, testNames } = req.body || {};
    if (!mongoose60.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }
    let appointment = await Appointment.findById(id);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }
    const locationCheck = await checkLocationAccess(req, appointment.locationId.toString());
    if (!locationCheck.allowed) {
      return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
    }
    if (!["in-consultation", "checked-in"].includes(appointment.status)) {
      return reply.code(400).send(errorResponse(`Cannot send for investigation: status is '${appointment.status}', expected 'in-consultation' or 'checked-in'`));
    }
    const user = req.user;
    const orgId = appointment.organizationId || await getRequestOrganizationId(req);
    const { Encounter: Encounter2 } = await Promise.resolve().then(() => (init_Encounter(), Encounter_exports));
    const { LabOrder: LabOrder2 } = await Promise.resolve().then(() => (init_LabOrder(), LabOrder_exports));
    const { LabTest: LabTest2 } = await Promise.resolve().then(() => (init_LabTest(), LabTest_exports));
    const { resolvedTestDocs, createdOrders } = await withClinicalTransaction(async () => {
      appointment = await Appointment.findOne({ _id: id, organizationId: orgId, status: { $in: ["in-consultation", "checked-in"] } });
      if (!appointment) throw new Error("The visit changed; refresh before ordering diagnostics");
      let encounter = await Encounter2.findOne({ appointmentId: appointment._id, status: { $ne: "cancelled" } });
      if (!encounter) {
        encounter = await Encounter2.create({
          organizationId: orgId,
          locationId: appointment.locationId,
          appointmentId: appointment._id,
          patientId: appointment.patientId,
          doctorId: appointment.doctorId,
          encounterType: appointment.appointmentType === "online" ? "telehealth" : "opd",
          status: "in_progress",
          startedAt: appointment.appointmentTime || /* @__PURE__ */ new Date()
        });
      }
      const resolvedTestDocs2 = [];
      if (Array.isArray(testIds) && testIds.length > 0) {
        for (const tId of testIds) {
          if (mongoose60.Types.ObjectId.isValid(tId)) {
            const tDoc = await LabTest2.findById(tId);
            if (tDoc && String(tDoc.locationId) === String(appointment.locationId)) resolvedTestDocs2.push(tDoc);
            else throw new Error("Diagnostic catalog reference is outside the visit branch");
          }
        }
      }
      const namesToResolve = Array.isArray(testNames) && testNames.length > 0 ? testNames : notes ? notes.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean) : [];
      for (const rawName of namesToResolve) {
        if (resolvedTestDocs2.some((d) => d.name.toLowerCase() === rawName.toLowerCase())) continue;
        let found = await LabTest2.findOne({
          locationId: appointment.locationId,
          name: { $regex: new RegExp(`^${rawName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") }
        });
        if (!found) {
          const testCode = rawName.toUpperCase().replace(/[^A-Z0-9]/g, "_").slice(0, 10) || "LAB";
          found = await LabTest2.create({
            locationId: appointment.locationId,
            organizationId: orgId,
            name: rawName,
            code: `${testCode}_${Math.floor(Math.random() * 1e3)}`,
            department: "Biochemistry",
            sampleType: "Blood",
            price: 150,
            normalRange: "Standard Diagnostic Reference Range"
          });
        }
        resolvedTestDocs2.push(found);
      }
      if (resolvedTestDocs2.length === 0) {
        let defaultTest = await LabTest2.findOne({ locationId: appointment.locationId, name: "General Diagnostic Panel" });
        if (!defaultTest) {
          defaultTest = await LabTest2.create({
            locationId: appointment.locationId,
            organizationId: orgId,
            name: "General Diagnostic Panel",
            code: "GEN_DIAG",
            department: "General Pathology",
            sampleType: "Blood/Urine",
            price: 250,
            normalRange: "Normal"
          });
        }
        resolvedTestDocs2.push(defaultTest);
      }
      const createdOrders2 = [];
      const orderedByUserId = user?._id || user?.id || appointment.doctorId;
      for (const t of resolvedTestDocs2) {
        const order = await LabOrder2.create({
          organizationId: orgId,
          locationId: appointment.locationId,
          encounterId: encounter._id,
          appointmentId: appointment._id,
          patientId: appointment.patientId,
          testId: t._id,
          orderedBy: orderedByUserId,
          doctorId: appointment.doctorId,
          priority: "urgent",
          clinicalReason: notes || `OPD Diagnostic: ${t.name}`,
          status: "ordered"
        });
        await syncDiagnosticHandoff(order.id, String(orderedByUserId));
        createdOrders2.push(order);
      }
      appointment.status = "standby";
      appointment.parkedAt = /* @__PURE__ */ new Date();
      appointment.parkedReason = "Diagnostic Lab / Investigation";
      appointment.consultationPhase = "initial_pending_investigation";
      appointment.investigationSentAt = /* @__PURE__ */ new Date();
      if (notes) {
        appointment.investigationNotes = notes;
      }
      appointment.patientReturned = false;
      appointment.patientReturnedAt = void 0;
      appointment.investigationResults = resolvedTestDocs2.map((t, idx) => ({
        testId: t._id,
        testName: t.name,
        value: "Pending Sample / Analysis",
        unit: "",
        referenceRange: t.normalRange || "Standard Reference",
        isAbnormal: false,
        resultNotes: "Ordered during OPD consultation",
        resultedAt: /* @__PURE__ */ new Date(),
        labOrderId: createdOrders2[idx]?._id
      }));
      await appointment.save();
      await AuditLog.create({
        organizationId: orgId,
        userId: user?._id || user?.id,
        category: "CLINICAL_WRITE",
        action: "QUEUE_PATIENT_SENT_FOR_INVESTIGATION",
        targetId: appointment._id,
        targetModel: "Appointment",
        details: {
          tokenNumber: appointment.tokenNumber,
          locationId: appointment.locationId,
          doctorId: appointment.doctorId,
          orderCount: createdOrders2.length,
          testNames: resolvedTestDocs2.map((t) => t.name),
          investigationNotes: notes || "Diagnostic tests ordered"
        }
      });
      return { resolvedTestDocs: resolvedTestDocs2, createdOrders: createdOrders2 };
    });
    const locationIdStr = appointment.locationId.toString();
    broadcastQueueUpdate(locationIdStr, {
      type: "QUEUE_UPDATED",
      data: {
        locationId: locationIdStr,
        doctorId: appointment.doctorId.toString(),
        appointmentId: appointment._id.toString(),
        status: "standby",
        consultationPhase: "initial_pending_investigation"
      },
      message: `Token #${appointment.tokenNumber} sent for diagnostic lab tests. Room available for next patient.`,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
    broadcastClinicalRealtime(locationIdStr, {
      type: "LAB_ORDER_PLACED",
      data: {
        locationId: locationIdStr,
        appointmentId: appointment._id.toString(),
        tokenNumber: appointment.tokenNumber,
        orderCount: createdOrders.length,
        testNames: resolvedTestDocs.map((t) => t.name)
      },
      message: `${createdOrders.length} diagnostic test order(s) placed for Token #${appointment.tokenNumber}`,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
    return reply.code(200).send(
      successResponse(appointment, `Patient Token #${appointment.tokenNumber} sent for diagnostic tests (${createdOrders.length} orders created). Room unblocked.`)
    );
  } catch (err) {
    console.error("sendPatientForInvestigation error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
async function resumeForReportReview(req, reply) {
  try {
    const { id } = req.params;
    if (!mongoose60.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }
    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }
    const locationCheck = await checkLocationAccess(req, appointment.locationId.toString());
    if (!locationCheck.allowed) {
      return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
    }
    if (appointment.status !== "standby") {
      return reply.code(400).send(errorResponse(`Cannot resume for report review: status is '${appointment.status}', expected 'standby'`));
    }
    const today = new Date(appointment.appointmentTime);
    const startOfDay = new Date(today);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(today);
    endOfDay.setHours(23, 59, 59, 999);
    await Appointment.updateMany(
      {
        locationId: appointment.locationId,
        doctorId: appointment.doctorId,
        appointmentTime: { $gte: startOfDay, $lte: endOfDay },
        _id: { $ne: appointment._id },
        status: { $in: ["checked-in", "confirmed", "pending"] }
      },
      { $inc: { queuePosition: 1 } }
    );
    appointment.status = "checked-in";
    appointment.queuePosition = 1;
    appointment.consultationPhase = "report_review";
    appointment.reasonForVisit = "report_review";
    appointment.parkedAt = void 0;
    appointment.parkedReason = void 0;
    appointment.patientReturned = true;
    appointment.patientReturnedAt = /* @__PURE__ */ new Date();
    await appointment.save();
    const user = req.user;
    await AuditLog.create({
      organizationId: appointment.organizationId || await getRequestOrganizationId(req),
      userId: user?._id || user?.id,
      category: "CLINICAL_WRITE",
      action: "QUEUE_PATIENT_RESUMED_FOR_REPORT_REVIEW",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: {
        tokenNumber: appointment.tokenNumber,
        assignedPosition: 1,
        consultationPhase: "report_review",
        locationId: appointment.locationId,
        doctorId: appointment.doctorId
      }
    });
    const locationIdStr = appointment.locationId.toString();
    const { Doctor: Doctor2 } = await Promise.resolve().then(() => (init_Doctor(), Doctor_exports));
    const { User: User2 } = await Promise.resolve().then(() => (init_User(), User_exports));
    const docUser = await User2.findById(appointment.doctorId).select("name").lean();
    const docProfile = await Doctor2.findOne({ userId: appointment.doctorId }).select("cabinNumber specialization").lean();
    const cabinNum = docProfile?.cabinNumber || "Doctor's Cabin";
    const docName = docUser?.name ? docUser.name.startsWith("Dr.") ? docUser.name : `Dr. ${docUser.name}` : "Doctor";
    broadcastQueueUpdate(locationIdStr, {
      type: "PATIENT_RECALLED_TO_CABIN",
      data: {
        locationId: locationIdStr,
        doctorId: appointment.doctorId.toString(),
        doctorName: docName,
        cabinNumber: cabinNum,
        appointmentId: appointment._id.toString(),
        tokenNumber: appointment.tokenNumber,
        consultationPhase: "report_review",
        audioAnnouncement: {
          en: `Token number ${appointment.tokenNumber}, please proceed to ${cabinNum}, ${docName} for report review.`,
          hi: `\u091F\u094B\u0915\u0928 \u0928\u0902\u092C\u0930 ${appointment.tokenNumber}, \u0915\u0943\u092A\u092F\u093E \u0930\u093F\u092A\u094B\u0930\u094D\u091F \u0938\u092E\u0940\u0915\u094D\u0937\u093E \u0915\u0947 \u0932\u093F\u090F ${cabinNum}, ${docName} \u0915\u0947 \u092A\u093E\u0938 \u091C\u093E\u090F\u0902\u0964`
        }
      },
      message: `Token #${appointment.tokenNumber} recalled to ${cabinNum} for Report Review!`,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
    broadcastQueueUpdate(locationIdStr, {
      type: "QUEUE_UPDATED",
      data: {
        locationId: locationIdStr,
        doctorId: appointment.doctorId.toString(),
        resumedAppointmentId: appointment._id.toString(),
        consultationPhase: "report_review"
      },
      message: `Token #${appointment.tokenNumber} resumed for Report Review as Next Up!`,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
    return reply.code(200).send(
      successResponse(appointment, `Patient Token #${appointment.tokenNumber} recalled to ${cabinNum} for Report Review as Next Up`)
    );
  } catch (err) {
    console.error("resumeForReportReview error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
async function startOpdSession(req, reply) {
  try {
    const { locationId, doctorId, date } = req.body || {};
    if (!locationId || !doctorId) {
      return reply.code(400).send(errorResponse("locationId and doctorId are required"));
    }
    const locationCheck = await checkLocationAccess(req, locationId);
    if (!locationCheck.allowed) {
      return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
    }
    const { OpdSession: OpdSession2 } = await Promise.resolve().then(() => (init_OpdSession(), OpdSession_exports));
    const user = req.user;
    const orgId = await getRequestOrganizationId(req);
    const now = /* @__PURE__ */ new Date();
    const dateStr = date ? date.slice(0, 10) : now.toISOString().slice(0, 10);
    const session = await OpdSession2.findOneAndUpdate(
      { locationId, doctorId, date: dateStr },
      {
        $set: {
          organizationId: orgId,
          status: "active",
          startedAt: now,
          startedBy: user?._id || user?.id
        },
        $unset: { endedAt: 1, endedBy: 1 }
      },
      { upsert: true, returnDocument: "after" }
    );
    await AuditLog.create({
      organizationId: orgId,
      userId: user?._id || user?.id,
      category: "ADMIN",
      action: "OPD_SESSION_STARTED",
      targetId: session._id,
      targetModel: "OpdSession",
      details: { locationId, doctorId, date: dateStr, startedAt: now }
    });
    broadcastQueueUpdate(locationId.toString(), {
      type: "QUEUE_UPDATED",
      data: { locationId, doctorId, opdSession: session },
      message: `Doctor OPD session started for today.`,
      timestamp: now.toISOString()
    });
    return reply.code(200).send(successResponse(session, "OPD session started successfully"));
  } catch (err) {
    console.error("startOpdSession error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
async function toggleDoctorBreak(req, reply) {
  try {
    const { locationId, doctorId, isOnBreak, breakReason, breakExpectedMinutes, date } = req.body || {};
    if (!locationId || !doctorId) {
      return reply.code(400).send(errorResponse("locationId and doctorId are required"));
    }
    const locationCheck = await checkLocationAccess(req, locationId);
    if (!locationCheck.allowed) {
      return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
    }
    const { OpdSession: OpdSession2 } = await Promise.resolve().then(() => (init_OpdSession(), OpdSession_exports));
    const user = req.user;
    const orgId = await getRequestOrganizationId(req);
    const now = /* @__PURE__ */ new Date();
    const dateStr = date ? date.slice(0, 10) : now.toISOString().slice(0, 10);
    const updateFields = {
      organizationId: orgId,
      isOnBreak: Boolean(isOnBreak)
    };
    if (isOnBreak) {
      updateFields.status = "active";
      updateFields.breakReason = breakReason?.trim() || "Short Intermission";
      updateFields.breakStartedAt = now;
      updateFields.breakExpectedMinutes = Number(breakExpectedMinutes) || 15;
    } else {
      updateFields.breakReason = "";
      updateFields.breakStartedAt = null;
    }
    const session = await OpdSession2.findOneAndUpdate(
      { locationId, doctorId, date: dateStr },
      { $set: updateFields },
      { upsert: true, returnDocument: "after" }
    );
    await AuditLog.create({
      organizationId: orgId,
      userId: user?._id || user?.id,
      category: "ADMIN",
      action: isOnBreak ? "DOCTOR_BREAK_STARTED" : "DOCTOR_BREAK_ENDED",
      targetId: session._id,
      targetModel: "OpdSession",
      details: {
        locationId,
        doctorId,
        date: dateStr,
        isOnBreak: session.isOnBreak,
        breakReason: session.breakReason,
        breakExpectedMinutes: session.breakExpectedMinutes
      }
    });
    broadcastQueueUpdate(locationId.toString(), {
      type: "QUEUE_UPDATED",
      data: {
        locationId,
        doctorId,
        opdSession: session,
        doctorBreak: {
          isOnBreak: session.isOnBreak,
          breakReason: session.breakReason,
          breakStartedAt: session.breakStartedAt,
          breakExpectedMinutes: session.breakExpectedMinutes
        }
      },
      message: isOnBreak ? `Doctor is on a short break (${session.breakReason || "Intermission"}).` : `Doctor has resumed OPD consultations.`,
      timestamp: now.toISOString()
    });
    return reply.code(200).send(
      successResponse(session, isOnBreak ? "Doctor break started successfully" : "Doctor break ended successfully")
    );
  } catch (err) {
    console.error("toggleDoctorBreak error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
async function getOpdSessionSummary(req, reply) {
  try {
    const { locationId, doctorId, date } = req.query;
    if (!locationId || !doctorId) {
      return reply.code(400).send(errorResponse("locationId and doctorId are required"));
    }
    const locationCheck = await checkLocationAccess(req, locationId);
    if (!locationCheck.allowed) {
      return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
    }
    const timezone = await getLocationTimezone(locationId);
    const dateStr = date ? date.slice(0, 10) : locationDateKey(/* @__PURE__ */ new Date(), timezone);
    const { start: startOfDay, end: endOfDay } = locationDayRange(dateStr, timezone);
    const { OpdSession: OpdSession2 } = await Promise.resolve().then(() => (init_OpdSession(), OpdSession_exports));
    const session = await OpdSession2.findOne({ locationId, doctorId, date: dateStr }).lean();
    const appointments = await Appointment.find({
      locationId,
      doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay }
    }).populate({
      path: "patientId",
      populate: { path: "userId", select: "name phone" }
    }).lean();
    const completed = appointments.filter((a) => a.status === "completed");
    const inConsultation = appointments.filter((a) => a.status === "in-consultation");
    const standbyPatients = appointments.filter((a) => a.status === "standby");
    const waitingPatients = appointments.filter((a) => ["checked-in", "confirmed", "pending"].includes(a.status));
    const noShowPatients = appointments.filter((a) => a.status === "no-show");
    const cancelledPatients = appointments.filter((a) => a.status === "cancelled");
    return reply.code(200).send(
      successResponse({
        session: session || { status: "not_started", date: dateStr },
        counts: {
          total: appointments.length,
          completed: completed.length,
          inConsultation: inConsultation.length,
          standby: standbyPatients.length,
          waiting: waitingPatients.length,
          noShow: noShowPatients.length,
          cancelled: cancelledPatients.length
        },
        standbyList: standbyPatients.map((p) => ({
          id: p._id,
          tokenNumber: p.tokenNumber,
          patientName: p.patientId?.name || p.patientId?.userId?.name || "Patient",
          phone: p.patientId?.userId?.phone || p.patientId?.phone,
          parkedReason: p.parkedReason,
          parkedAt: p.parkedAt,
          patientReturned: p.patientReturned || false
        })),
        waitingList: waitingPatients.map((p) => ({
          id: p._id,
          tokenNumber: p.tokenNumber,
          status: p.status,
          patientName: p.patientId?.name || p.patientId?.userId?.name || "Patient",
          phone: p.patientId?.userId?.phone || p.patientId?.phone,
          appointmentTime: p.appointmentTime
        }))
      })
    );
  } catch (err) {
    console.error("getOpdSessionSummary error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
async function endOpdSessionAndReconcile(req, reply) {
  try {
    const {
      locationId,
      doctorId,
      date,
      standbyAction = "keep_unresolved",
      waitingAction = "keep_unresolved"
    } = req.body || {};
    if (!locationId || !doctorId) {
      return reply.code(400).send(errorResponse("locationId and doctorId are required"));
    }
    const locationCheck = await checkLocationAccess(req, locationId);
    if (!locationCheck.allowed) {
      return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
    }
    if (!["keep_unresolved", "cancel"].includes(standbyAction) || !["keep_unresolved", "cancel"].includes(waitingAction)) {
      return reply.code(400).send(errorResponse("Invalid reconciliation action"));
    }
    const now = /* @__PURE__ */ new Date();
    const timezone = await getLocationTimezone(locationId);
    const dateStr = date ? date.slice(0, 10) : locationDateKey(now, timezone);
    const { start: startOfDay, end: endOfDay } = locationDayRange(dateStr, timezone);
    const { OpdSession: OpdSession2 } = await Promise.resolve().then(() => (init_OpdSession(), OpdSession_exports));
    const user = req.user;
    const orgId = await getRequestOrganizationId(req);
    const standbyAppointments = await Appointment.find({
      locationId,
      doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      status: "standby"
    });
    let standbyReconciledCount = 0;
    for (const appt of standbyAppointments) {
      if (standbyAction === "cancel") {
        appt.status = "cancelled";
        appt.cancellationReason = "End of OPD shift \u2014 unresumed standby";
        await appt.save();
        standbyReconciledCount++;
      }
    }
    const waitingAppointments = await Appointment.find({
      locationId,
      doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      status: { $in: ["checked-in", "confirmed", "pending"] }
    });
    let waitingReconciledCount = 0;
    if (waitingAction === "cancel") {
      for (const appt of waitingAppointments) {
        appt.status = "cancelled";
        appt.cancellationReason = "End of OPD shift \u2014 patient not called before session close";
        await appt.save();
        waitingReconciledCount++;
      }
    }
    const inConsultationCount = await Appointment.countDocuments({
      locationId,
      doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      status: "in-consultation"
    });
    const session = await OpdSession2.findOneAndUpdate(
      { locationId, doctorId, date: dateStr },
      {
        $set: {
          organizationId: orgId,
          status: "ended",
          endedAt: now,
          endedBy: user?._id || user?.id,
          reconciliationSummary: {
            standbyCount: standbyAppointments.length,
            standbyAction,
            waitingCount: waitingAppointments.length,
            waitingAction,
            reconciledAt: now
          }
        }
      },
      { upsert: true, returnDocument: "after" }
    );
    await AuditLog.create({
      organizationId: orgId,
      userId: user?._id || user?.id,
      category: "ADMIN",
      action: "OPD_SESSION_CLOSED_AND_RECONCILED",
      targetId: session._id,
      targetModel: "OpdSession",
      details: {
        locationId,
        doctorId,
        date: dateStr,
        standbyReconciledCount,
        waitingReconciledCount,
        inConsultationCount,
        unresolvedCount: standbyAppointments.length - standbyReconciledCount + waitingAppointments.length - waitingReconciledCount + inConsultationCount,
        closedAt: now
      }
    });
    broadcastQueueUpdate(locationId.toString(), {
      type: "QUEUE_UPDATED",
      data: { locationId, doctorId, opdSession: session },
      message: `Doctor OPD session ended and reconciled.`,
      timestamp: now.toISOString()
    });
    return reply.code(200).send(
      successResponse(
        {
          session,
          standbyReconciledCount,
          waitingReconciledCount,
          inConsultationCount,
          unresolvedCount: standbyAppointments.length - standbyReconciledCount + waitingAppointments.length - waitingReconciledCount + inConsultationCount
        },
        "OPD session ended. Unresolved appointments remain available for staff review."
      )
    );
  } catch (err) {
    console.error("endOpdSessionAndReconcile error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
async function recordPatientVitals(req, reply) {
  try {
    const { id } = req.params;
    if (!mongoose60.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }
    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }
    const locationCheck = await checkLocationAccess(req, appointment.locationId);
    if (!locationCheck.allowed) {
      return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
    }
    const body = req.body || {};
    let bmi;
    if (body.weight && body.height && body.height > 0) {
      const heightM = body.height / 100;
      bmi = Number((body.weight / (heightM * heightM)).toFixed(1));
    }
    const user = req.user;
    const now = /* @__PURE__ */ new Date();
    const parsedAllergies = Array.isArray(body.allergies) ? body.allergies.map((a) => String(a).trim()).filter(Boolean) : typeof body.allergies === "string" && body.allergies.trim() ? body.allergies.split(",").map((a) => a.trim()).filter(Boolean) : void 0;
    const vitalsData = {
      bpSystolic: body.bpSystolic ? Number(body.bpSystolic) : void 0,
      bpDiastolic: body.bpDiastolic ? Number(body.bpDiastolic) : void 0,
      pulse: body.pulse ? Number(body.pulse) : void 0,
      temperature: body.temperature ? Number(body.temperature) : void 0,
      temperatureUnit: body.temperatureUnit || "F",
      spO2: body.spO2 ? Number(body.spO2) : void 0,
      weight: body.weight ? Number(body.weight) : void 0,
      height: body.height ? Number(body.height) : void 0,
      bmi,
      bloodSugar: body.bloodSugar ? Number(body.bloodSugar) : void 0,
      bloodSugarType: body.bloodSugarType || "random",
      allergies: parsedAllergies,
      triageNotes: typeof body.triageNotes === "string" ? body.triageNotes.trim() : void 0,
      recordedAt: now,
      recordedBy: user?._id || user?.id,
      recordedByName: user?.name || "Triage Staff"
    };
    appointment.vitals = vitalsData;
    await appointment.save();
    try {
      const { Encounter: Encounter2 } = await Promise.resolve().then(() => (init_Encounter(), Encounter_exports));
      let encounter = await Encounter2.findOne({ appointmentId: appointment._id });
      if (!encounter) {
        encounter = await Encounter2.create({
          organizationId: appointment.organizationId || void 0,
          locationId: appointment.locationId,
          appointmentId: appointment._id,
          patientId: appointment.patientId,
          doctorId: appointment.doctorId,
          encounterType: "opd",
          status: "in_progress",
          startedAt: now
        });
      }
      const { Observation: Observation2 } = await Promise.resolve().then(() => (init_Observation(), Observation_exports));
      const observationsToCreate = [];
      if (vitalsData.bpSystolic && vitalsData.bpDiastolic) {
        observationsToCreate.push({
          organizationId: appointment.organizationId,
          locationId: appointment.locationId,
          encounterId: encounter._id,
          patientId: appointment.patientId,
          recordedBy: user?._id || user?.id,
          code: "BP",
          name: "Blood Pressure",
          value: `${vitalsData.bpSystolic}/${vitalsData.bpDiastolic}`,
          unit: "mmHg",
          referenceRange: "< 120/80",
          recordedAt: now
        });
      }
      if (vitalsData.pulse) {
        observationsToCreate.push({
          organizationId: appointment.organizationId,
          locationId: appointment.locationId,
          encounterId: encounter._id,
          patientId: appointment.patientId,
          recordedBy: user?._id || user?.id,
          code: "HR",
          name: "Heart Rate",
          value: String(vitalsData.pulse),
          unit: "bpm",
          referenceRange: "60-100",
          recordedAt: now
        });
      }
      if (vitalsData.spO2) {
        observationsToCreate.push({
          organizationId: appointment.organizationId,
          locationId: appointment.locationId,
          encounterId: encounter._id,
          patientId: appointment.patientId,
          recordedBy: user?._id || user?.id,
          code: "SPO2",
          name: "Oxygen Saturation",
          value: String(vitalsData.spO2),
          unit: "%",
          referenceRange: ">= 95%",
          recordedAt: now
        });
      }
      if (vitalsData.temperature) {
        observationsToCreate.push({
          organizationId: appointment.organizationId,
          locationId: appointment.locationId,
          encounterId: encounter._id,
          patientId: appointment.patientId,
          recordedBy: user?._id || user?.id,
          code: "TEMP",
          name: "Body Temperature",
          value: String(vitalsData.temperature),
          unit: `\xB0${vitalsData.temperatureUnit}`,
          referenceRange: "97.8 - 99.1 \xB0F",
          recordedAt: now
        });
      }
      if (vitalsData.weight) {
        observationsToCreate.push({
          organizationId: appointment.organizationId,
          locationId: appointment.locationId,
          encounterId: encounter._id,
          patientId: appointment.patientId,
          recordedBy: user?._id || user?.id,
          code: "WEIGHT",
          name: "Body Weight",
          value: String(vitalsData.weight),
          unit: "kg",
          recordedAt: now
        });
      }
      if (vitalsData.bmi) {
        observationsToCreate.push({
          organizationId: appointment.organizationId,
          locationId: appointment.locationId,
          encounterId: encounter._id,
          patientId: appointment.patientId,
          recordedBy: user?._id || user?.id,
          code: "BMI",
          name: "Body Mass Index",
          value: String(vitalsData.bmi),
          unit: "kg/m\xB2",
          referenceRange: "18.5 - 24.9",
          recordedAt: now
        });
      }
      if (vitalsData.bloodSugar) {
        observationsToCreate.push({
          organizationId: appointment.organizationId,
          locationId: appointment.locationId,
          encounterId: encounter._id,
          patientId: appointment.patientId,
          recordedBy: user?._id || user?.id,
          code: "GLUCOSE",
          name: `Blood Glucose (${vitalsData.bloodSugarType})`,
          value: String(vitalsData.bloodSugar),
          unit: "mg/dL",
          referenceRange: vitalsData.bloodSugarType === "fasting" ? "70 - 99" : "< 140",
          recordedAt: now
        });
      }
      if (observationsToCreate.length > 0) {
        await Observation2.insertMany(observationsToCreate);
      }
    } catch (obsErr) {
      console.warn("Observation persistence notice:", safeError(obsErr));
    }
    await AuditLog.create({
      organizationId: appointment.organizationId,
      userId: user?._id || user?.id,
      category: "CLINICAL_WRITE",
      action: "NURSE_VITALS_RECORDED",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: {
        tokenNumber: appointment.tokenNumber,
        vitals: vitalsData
      }
    });
    const locationIdStr = appointment.locationId.toString();
    broadcastQueueUpdate(locationIdStr, {
      type: "QUEUE_UPDATED",
      data: {
        locationId: locationIdStr,
        doctorId: appointment.doctorId.toString(),
        appointmentId: appointment._id.toString(),
        tokenNumber: appointment.tokenNumber,
        vitalsUpdated: true
      },
      message: `Vitals recorded for Token #${appointment.tokenNumber}`,
      timestamp: now.toISOString()
    });
    return reply.code(200).send(
      successResponse(appointment, `Vitals recorded successfully for Token #${appointment.tokenNumber}`)
    );
  } catch (err) {
    console.error("recordPatientVitals error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
async function triggerStatEmergency(req, reply) {
  try {
    const { id } = req.params;
    if (!mongoose60.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }
    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }
    const locationCheck = await checkLocationAccess(req, appointment.locationId);
    if (!locationCheck.allowed) {
      return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
    }
    const { reason } = req.body || {};
    const user = req.user;
    const now = /* @__PURE__ */ new Date();
    const apptDate = new Date(appointment.appointmentTime);
    const startOfDay = new Date(apptDate.getFullYear(), apptDate.getMonth(), apptDate.getDate(), 0, 0, 0, 0);
    const endOfDay = new Date(apptDate.getFullYear(), apptDate.getMonth(), apptDate.getDate(), 23, 59, 59, 999);
    await Appointment.updateMany(
      {
        locationId: appointment.locationId,
        doctorId: appointment.doctorId,
        appointmentTime: { $gte: startOfDay, $lte: endOfDay },
        _id: { $ne: appointment._id },
        status: { $in: ["checked-in", "confirmed", "pending", "standby"] }
      },
      { $inc: { queuePosition: 1 } }
    );
    appointment.queuePosition = 0;
    appointment.isEmergency = true;
    appointment.emergencyTriagedAt = now;
    appointment.status = "checked-in";
    if (reason) {
      appointment.notes = appointment.notes ? `${appointment.notes} | \u{1F6A8} [EMERGENCY STAT: ${reason}]` : `\u{1F6A8} [EMERGENCY STAT: ${reason}]`;
    }
    await appointment.save();
    await AuditLog.create({
      organizationId: appointment.organizationId,
      userId: user?._id || user?.id,
      category: "CLINICAL_WRITE",
      action: "EMERGENCY_STAT_PRIORITY_TRIGGERED",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: {
        tokenNumber: appointment.tokenNumber,
        assignedPosition: 0,
        reason: reason || "Acute medical distress in waiting lounge"
      }
    });
    const locationIdStr = appointment.locationId.toString();
    const doctorIdStr = appointment.doctorId.toString();
    broadcastQueueUpdate(locationIdStr, {
      type: "QUEUE_EMERGENCY_STAT",
      data: {
        locationId: locationIdStr,
        doctorId: doctorIdStr,
        appointmentId: appointment._id.toString(),
        tokenNumber: appointment.tokenNumber,
        queuePosition: 0,
        reason: reason || "Acute emergency triage"
      },
      message: `\u{1F6A8} STAT EMERGENCY: Token #${appointment.tokenNumber} prioritized for immediate attention!`,
      timestamp: now.toISOString()
    });
    return reply.code(200).send(
      successResponse(appointment, `Token #${appointment.tokenNumber} marked as STAT Emergency and placed at top of line`)
    );
  } catch (err) {
    console.error("triggerStatEmergency error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
async function resendQueueTrackerNotification(req, reply) {
  try {
    const { id } = req.params;
    const { phone, channel = "whatsapp", clientRequestId = crypto20.randomUUID() } = req.body || {};
    if (phone !== void 0 && (typeof phone !== "string" || phone.length > 40) || typeof clientRequestId !== "string") return reply.code(400).send(errorResponse("Invalid tracker request details"));
    if (!mongoose60.Types.ObjectId.isValid(id)) return reply.code(400).send(errorResponse("Invalid appointment ID"));
    if (channel !== "whatsapp") return reply.code(422).send(errorResponse("Tracker messaging currently supports reviewed WhatsApp recipients"));
    if (!await requestHasAnyPermission(req, "COMMUNICATE_PATIENTS")) return reply.code(403).send(errorResponse("Patient communication authority is required"));
    const appointment = await Appointment.findById(id);
    if (!appointment) return reply.code(404).send(errorResponse("Appointment not found"));
    const access = await checkLocationAccess(req, appointment.locationId, { requireExplicitScope: true });
    if (!access.allowed) return reply.code(access.statusCode).send(errorResponse(access.message));
    if (access.organizationId !== String(appointment.organizationId)) return reply.code(409).send(errorResponse("Canonical visit branch requires review"));
    const organizationId = String(appointment.organizationId);
    const result = await executeRecordedCommand("queue-tracker:" + organizationId + ":" + id, clientRequestId, { appointmentId: id, phone: phone?.trim() || null, channel }, async () => {
      const decision = await patientCommunicationPolicy({ organizationId, appointmentId: id, actorId: req.user.id, purpose: "care_operations", communicationAction: "queue_tracker", automated: false }, "whatsapp", phone?.trim() || void 0);
      const current = await Appointment.findOne({ _id: id, organizationId });
      if (!current) throw new CommandError(409, "Visit changed; reload before sending");
      const { url: trackingUrl } = await issueAppointmentTrackerLink(current);
      const range = locationDayRange(locationDateKey(current.appointmentTime, await getLocationTimezone(String(current.locationId))), await getLocationTimezone(String(current.locationId)));
      const peopleAhead = await Appointment.countDocuments({ organizationId, locationId: current.locationId, doctorId: current.doctorId, appointmentTime: { $gte: range.start, $lt: range.end }, status: { $in: ["checked-in", "confirmed"] }, queuePosition: { $lt: current.queuePosition ?? current.tokenNumber }, _id: { $ne: current._id } });
      const doctor = await User.findById(current.doctorId).select("name");
      const { sendSmsWhatsAppNotification: sendSmsWhatsAppNotification2 } = await Promise.resolve().then(() => (init_SmsWhatsAppService(), SmsWhatsAppService_exports));
      const queued = await sendSmsWhatsAppNotification2({
        organizationId,
        appointmentId: id,
        phone: decision.recipient,
        patientName: decision.patient?.name || "Patient",
        channel: "whatsapp",
        templateId: "QUEUE_UPDATE",
        communicationContext: decision.context,
        variables: { patientName: decision.patient?.name || "Patient", tokenNumber: String(current.tokenNumber), peopleAhead: String(peopleAhead), doctorName: doctor?.name || "Doctor", trackingUrl },
        idempotencyKey: "queue-tracker:" + id + ":" + clientRequestId
      });
      await AuditLog.create({ userId: req.user.id, organizationId, category: "ADMIN", action: "QUEUE_TRACKER_RESENT", targetId: current._id, targetModel: "Appointment", details: { outboxId: String(queued._id), recipientHash: decision.context.recipientHash, channel: "whatsapp" } });
      return String(queued._id);
    });
    const outbox = await OutboundMessage.findOne({ _id: result.resultId, "payload.organizationId": organizationId }).select("status");
    if (!outbox) throw new CommandError(404, "Recorded message is unavailable");
    return reply.send(successResponse({ appointmentId: id, tokenNumber: appointment.tokenNumber, channel: "whatsapp", outboxId: outbox.id, status: outbox.status, replayed: result.replayed }, "Tracker message " + outbox.status + "; delivery is reported separately"));
  } catch (error) {
    if (error instanceof CommunicationPolicyError) return reply.code(409).send(errorResponse("Message blocked: " + error.reason + ". Review current consent and recipient."));
    if (error instanceof CommandError) return reply.code(error.statusCode).send(errorResponse(error.message));
    req.log.error(safeError(error), "Tracker queue preparation failed");
    return reply.code(503).send(errorResponse("Tracker result could not be confirmed. Retry the same request."));
  }
}
var init_queue = __esm({
  "controllers/queue.ts"() {
    "use strict";
    init_safeError();
    init_CommandReceiptService();
    init_OutboundMessage();
    init_permissions();
    init_AppointmentCommunicationEvents();
    init_PatientCommunicationPolicy();
    init_DiagnosticHandoffService();
    init_transaction();
    init_Appointment();
    init_consultationLock();
    init_Patient();
    init_FamilyRelationship();
    init_DoctorAssignment();
    init_AuditLog();
    init_helpers();
    init_tenant();
    init_websocket();
    init_Location();
    init_User();
    init_AuditTrailService();
    init_publicTracker();
    init_locationTime();
    init_cursorPagination();
  }
});

// utilities/latencyHistogram.ts
var LatencyHistogram, databaseLatency, databasePoolMetrics;
var init_latencyHistogram = __esm({
  "utilities/latencyHistogram.ts"() {
    "use strict";
    LatencyHistogram = class {
      bounds = [5, 10, 25, 50, 100, 250, 500, 1e3, 2500, 5e3, 1e4, Infinity];
      counts = this.bounds.map(() => 0);
      total = 0;
      observe(ms) {
        if (!Number.isFinite(ms) || ms < 0) return;
        this.counts[this.bounds.findIndex((bound) => ms <= bound)]++;
        this.total++;
      }
      snapshot() {
        const percentile = (fraction) => {
          if (!this.total) return null;
          let count = 0;
          for (let i = 0; i < this.counts.length; i++) {
            count += this.counts[i];
            if (count >= Math.ceil(this.total * fraction)) return Number.isFinite(this.bounds[i]) ? this.bounds[i] : null;
          }
          return null;
        };
        return { count: this.total, buckets: this.bounds.map((upperMs, i) => ({ upperMs: Number.isFinite(upperMs) ? upperMs : null, count: this.counts[i] })), p95UpperMs: percentile(0.95), p99UpperMs: percentile(0.99) };
      }
    };
    databaseLatency = new LatencyHistogram();
    databasePoolMetrics = { checkedOut: 0, checkoutFailures: 0 };
  }
});

// db.ts
var db_exports = {};
__export(db_exports, {
  connectDB: () => connectDB,
  default: () => db_default
});
import mongoose64 from "mongoose";
var MONGODB_URI, connectDB, db_default;
var init_db = __esm({
  async "db.ts"() {
    "use strict";
    init_safeError();
    init_latencyHistogram();
    init_auditPlugin();
    init_scalability();
    mongoose64.plugin(auditPlugin);
    MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/ekavyu_dev";
    connectDB = async () => {
      try {
        const maxPoolSize = Number(process.env.MONGODB_MAX_POOL_SIZE) || DB_POOL_SIZE;
        const configuredMin = Number(process.env.MONGODB_MIN_POOL_SIZE ?? 2);
        const minPoolSize = Number.isInteger(configuredMin) && configuredMin >= 0 ? configuredMin : 2;
        await mongoose64.connect(MONGODB_URI, {
          maxPoolSize,
          minPoolSize,
          serverSelectionTimeoutMS: DB_SERVER_SELECTION_TIMEOUT_MS,
          socketTimeoutMS: DB_SOCKET_TIMEOUT_MS,
          waitQueueTimeoutMS: 5e3,
          maxIdleTimeMS: 6e4,
          monitorCommands: true
        });
        const client = mongoose64.connection.getClient();
        client.on("commandSucceeded", (event) => databaseLatency.observe(event.duration));
        client.on("commandFailed", (event) => databaseLatency.observe(event.duration));
        client.on("connectionCheckedOut", () => databasePoolMetrics.checkedOut++);
        client.on("connectionCheckedIn", () => {
          databasePoolMetrics.checkedOut = Math.max(0, databasePoolMetrics.checkedOut - 1);
        });
        client.on("connectionCheckOutFailed", () => databasePoolMetrics.checkoutFailures++);
        console.log(`Connected to MongoDB with connection pool (min: ${minPoolSize}, max: ${maxPoolSize})`);
      } catch (err) {
        console.error("MongoDB connection error:", safeError(err));
        throw err;
      }
    };
    if (process.env.NODE_ENV !== "test") {
      await connectDB();
    }
    db_default = mongoose64;
  }
});

// utilities/workerHealthServer.ts
init_safeError();
import http from "node:http";

// utilities/readiness.ts
init_redis();
init_config();
init_redisConfiguration();
import mongoose from "mongoose";
var shuttingDown = false;
async function pingWithTimeout(ping, dependency) {
  let timer;
  try {
    return await Promise.race([
      ping,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${dependency} ping timed out (1500ms)`)), 1500);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function markShuttingDown() {
  shuttingDown = true;
}
async function checkDatabaseReadiness() {
  const readyState = mongoose.connection.readyState;
  if (readyState !== 1) {
    const states = ["disconnected", "connected", "connecting", "disconnecting"];
    return {
      ready: false,
      status: states[readyState] || "unknown",
      error: `MongoDB connection not open (readyState=${readyState})`
    };
  }
  const start = Date.now();
  try {
    if (mongoose.connection.db) {
      await pingWithTimeout(mongoose.connection.db.admin().ping(), "Database");
      return { ready: true, status: "connected", latencyMs: Date.now() - start };
    }
    return { ready: true, status: "connected" };
  } catch (err) {
    return {
      ready: false,
      status: "unreachable",
      error: err?.message || "Failed to ping database",
      latencyMs: Date.now() - start
    };
  }
}
async function checkRedisReadiness() {
  const isDegradedAllowed = process.env.ALLOW_SINGLE_NODE_IN_PRODUCTION === "true";
  const configuration = getRedisConfiguration();
  const isRequired = configuration.required;
  if (!redisClient) {
    return {
      ready: !isRequired,
      required: isRequired,
      status: isDegradedAllowed ? "single_node_override" : "not_configured",
      error: isRequired ? `${configuration.error || "Redis client could not be initialized"}. Configure a Redis service or explicitly enable ALLOW_SINGLE_NODE_IN_PRODUCTION=true for a single instance` : void 0
    };
  }
  if (redisClient.status !== "ready") {
    return {
      ready: !isRequired,
      required: isRequired,
      status: redisClient.status,
      error: `Redis status is '${redisClient.status}'`
    };
  }
  const start = Date.now();
  try {
    const pingResult = await pingWithTimeout(redisClient.ping(), "Redis");
    const isPong = pingResult === "PONG";
    return {
      ready: isPong || !isRequired,
      required: isRequired,
      status: isPong ? "ready" : "unexpected_ping_response",
      latencyMs: Date.now() - start
    };
  } catch (err) {
    return {
      ready: !isRequired,
      required: isRequired,
      status: "unreachable",
      error: err?.message || "Redis ping failed",
      latencyMs: Date.now() - start
    };
  }
}
async function checkWorkerReadiness(workerName) {
  const configCheck = validateConfig();
  const [dbReport, redisReport] = await Promise.all([checkDatabaseReadiness(), checkRedisReadiness()]);
  const isReady = !shuttingDown && configCheck.valid && dbReport.ready && redisReport.ready;
  return {
    ready: isReady,
    statusCode: isReady ? 200 : 503,
    data: {
      worker: workerName,
      status: isReady ? "ready" : shuttingDown ? "shutting_down" : "unhealthy",
      database: dbReport,
      redis: redisReport,
      configuration: { valid: configCheck.valid },
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    }
  };
}

// utilities/workerHealthServer.ts
function startWorkerHealthServer(options) {
  const envPort = options.envPortVar ? process.env[options.envPortVar] : process.env.WORKER_HEALTH_PORT;
  const port = envPort ? Number(envPort) : options.defaultPort;
  if (!port) {
    return {
      server: null,
      stop: async () => {
      }
    };
  }
  const server = http.createServer(async (req, res) => {
    const url = req.url?.split("?")[0] || "/";
    if (url === "/health" || url === "/api/health/liveness") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          worker: options.workerName,
          process: {
            pid: process.pid,
            uptime: Math.floor(process.uptime()),
            memoryUsageMb: Math.round(process.memoryUsage().rss / 1024 / 1024)
          },
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        })
      );
      return;
    }
    if (url === "/ready" || url === "/api/health/readiness") {
      const report = await checkWorkerReadiness(options.workerName);
      const progress = options.onProgress?.();
      if (progress) {
        report.data.progress = progress;
        if ((Array.isArray(progress) ? progress : [progress]).some((item) => !item.running || Date.now() - item.lastCompletedAt > Math.max(12e4, item.idleMs * 4))) {
          report.statusCode = 503;
          report.ready = false;
          report.data.status = "consumer_stalled";
        }
      }
      res.writeHead(report.statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(report.data));
      return;
    }
    if (url === "/metrics" && options.onMetrics) {
      try {
        const metrics = await options.onMetrics();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", worker: options.workerName, metrics }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", error: err?.message || "Failed to fetch metrics" }));
      }
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
  server.listen(port, () => {
    console.log(`[${options.workerName}] Health and readiness server listening on port ${port}`);
  });
  server.on("error", (err) => {
    console.warn(`[${options.workerName}] Health server error:`, safeError(err));
  });
  const stop = async () => {
    markShuttingDown();
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  };
  return { server, stop };
}

// workers/disruptionTimeoutWorker.ts
init_config();

// jobs/disruptionTimeoutJob.ts
init_safeError();
import crypto21 from "node:crypto";

// services/disruptionService.ts
init_safeError();
init_Appointment();
init_AppointmentCommunicationEvents();
init_CrmTaskService();
init_Location();
init_PatientRelationship();
import mongoose62 from "mongoose";

// models/DoctorDayOverride.ts
import mongoose38, { Schema as Schema34 } from "mongoose";
var DoctorDayOverrideSchema = new Schema34(
  {
    doctorId: { type: Schema34.Types.ObjectId, ref: "User", required: true, index: true },
    locationId: { type: Schema34.Types.ObjectId, ref: "Location", required: true, index: true },
    organizationId: { type: Schema34.Types.ObjectId, ref: "Organization", index: true },
    date: { type: String, required: true, index: true },
    // Format: "YYYY-MM-DD"
    status: {
      type: String,
      enum: ["available", "unavailable", "delayed", "extended"],
      default: "unavailable",
      required: true
    },
    effectiveStartTime: { type: String },
    // e.g. "10:30"
    effectiveEndTime: { type: String },
    // e.g. "15:00"
    reason: { type: String },
    createdBy: { type: Schema34.Types.ObjectId, ref: "User" }
  },
  { timestamps: true }
);
DoctorDayOverrideSchema.index({ locationId: 1, doctorId: 1, date: 1 }, { unique: true });
DoctorDayOverrideSchema.virtual("id").get(function() {
  return this._id.toHexString();
});
DoctorDayOverrideSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});
var DoctorDayOverride = mongoose38.model("DoctorDayOverride", DoctorDayOverrideSchema);

// services/disruptionService.ts
init_DoctorAssignment();
init_Invoice();

// services/AppointmentRefundService.ts
init_Appointment();

// models/AppointmentPayment.ts
import mongoose39, { Schema as Schema35 } from "mongoose";
var AppointmentPaymentSchema = new Schema35(
  {
    appointmentId: { type: Schema35.Types.ObjectId, ref: "Appointment", required: true, index: true },
    invoiceId: { type: Schema35.Types.ObjectId, ref: "Invoice", index: true },
    patientId: { type: Schema35.Types.ObjectId, ref: "Patient", required: true, index: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    paymentMethod: {
      type: String,
      enum: ["razorpay", "pay_at_location", "cash", "upi", "card"],
      required: true
    },
    razorpayOrderId: { type: String, index: true },
    // The gateway transaction ID is globally unique. A sparse unique index
    // makes a duplicate provider callback impossible to apply to a second
    // payment record.
    razorpayPaymentId: { type: String, unique: true, sparse: true, index: true },
    razorpaySignature: { type: String },
    status: {
      type: String,
      enum: ["creating", "ambiguous", "created", "authorized", "captured", "failed", "pay_at_location"],
      default: "created"
    },
    orderReceipt: { type: String, index: true },
    idempotencyKey: { type: String, unique: true, sparse: true }
  },
  { timestamps: true }
);
AppointmentPaymentSchema.index({ appointmentId: 1, status: 1 });
var AppointmentPayment = mongoose39.models.AppointmentPayment || mongoose39.model("AppointmentPayment", AppointmentPaymentSchema);

// services/AppointmentRefundService.ts
init_Invoice();
init_AuditLog();
init_Patient();

// services/AppointmentService.ts
init_safeError();
init_Appointment();
init_Patient();
init_User();
init_Doctor();
init_DoctorAssignment();
init_FamilyRelationship();
init_AuditLog();
init_Invoice();
init_OrgMember();
init_Organization();
init_Counter();
init_AppointmentCommunicationEvents();
init_transaction();
import mongoose61 from "mongoose";

// services/SlotLockService.ts
init_redis();
var LOCK_PREFIX = "slot_lock";
var memoryLocks = /* @__PURE__ */ new Map();
function buildLockKey(locationId, doctorId, slotTime) {
  const date = new Date(slotTime);
  if (isNaN(date.getTime())) {
    throw new Error("Invalid slot time format");
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${LOCK_PREFIX}:${locationId}:${doctorId}:${year}-${month}-${day}T${hours}:${minutes}`;
}
function distributedLockUnavailable() {
  return process.env.NODE_ENV === "production" && (!redisClient || redisClient.status !== "ready");
}
function cleanMemoryLocks() {
  const now = Date.now();
  for (const [key, lock] of memoryLocks.entries()) {
    if (lock.expiresAt <= now) {
      memoryLocks.delete(key);
    }
  }
}
async function checkSlotLock(locationId, doctorId, slotTime) {
  const lockKey = buildLockKey(locationId, doctorId, slotTime);
  if (distributedLockUnavailable()) {
    return { isLocked: true, lockKey, ttlSeconds: 0 };
  }
  if (redisClient) {
    const existingValue = await redisClient.get(lockKey);
    if (!existingValue) {
      return { isLocked: false, lockKey };
    }
    const [heldUserId2, heldLockId2] = existingValue.split(":");
    const ttl = await redisClient.ttl(lockKey);
    return {
      isLocked: true,
      lockKey,
      heldByUserId: heldUserId2,
      lockId: heldLockId2,
      ttlSeconds: ttl > 0 ? ttl : 0
    };
  }
  cleanMemoryLocks();
  const existing = memoryLocks.get(lockKey);
  if (!existing || existing.expiresAt <= Date.now()) {
    return { isLocked: false, lockKey };
  }
  const [heldUserId, heldLockId] = existing.value.split(":");
  return {
    isLocked: true,
    lockKey,
    heldByUserId: heldUserId,
    lockId: heldLockId,
    ttlSeconds: Math.ceil((existing.expiresAt - Date.now()) / 1e3)
  };
}
async function forceReleaseSlotLock(lockKey) {
  if (redisClient) {
    await redisClient.del(lockKey);
  } else {
    memoryLocks.delete(lockKey);
  }
}
async function validateSlotLockForBooking(locationId, doctorId, slotTime, userId, lockId) {
  const info = await checkSlotLock(locationId, doctorId, slotTime);
  if (distributedLockUnavailable()) {
    return { valid: false, lockKey: info.lockKey, message: "Distributed slot locking is unavailable" };
  }
  if (!info.isLocked) {
    return { valid: true, lockKey: info.lockKey, message: "Slot is available" };
  }
  if (info.heldByUserId === userId) {
    return { valid: true, lockKey: info.lockKey, message: "Slot locked by you" };
  }
  return {
    valid: false,
    lockKey: info.lockKey,
    message: "Slot is currently held by another user. Please select a different time."
  };
}

// utilities/invoiceNumber.ts
init_Counter();

// models/InvoiceSeries.ts
import mongoose41, { Schema as Schema37 } from "mongoose";
var schema9 = new Schema37({
  locationId: { type: Schema37.Types.ObjectId, ref: "Location", required: true, unique: true },
  series: { type: String, required: true, unique: true, match: /^[0-9A-Z]{4}$/ },
  version: { type: Number, default: 2, immutable: true }
});
schema9.pre("save", function() {
  if (!this.isNew) throw new Error("Invoice series reservations are immutable");
});
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"]) {
  schema9.pre(operation, function() {
    throw new Error("Invoice series reservations are immutable");
  });
}
schema9.pre("bulkWrite", function() {
  throw new Error("Invoice series reservations are immutable");
});
schema9.pre("deleteOne", { document: true, query: false }, function() {
  throw new Error("Invoice series reservations are immutable");
});
var InvoiceSeries = mongoose41.model("InvoiceSeries", schema9);

// utilities/invoiceNumber.ts
init_Location();
init_transaction();
init_CommandReceiptService();
init_indiaFinancialYear();

// models/PharmacyInvoiceNumbering.ts
import mongoose42, { Schema as Schema38 } from "mongoose";
var schema10 = new Schema38({
  organizationId: { type: Schema38.Types.ObjectId, ref: "Organization", required: true },
  locationId: { type: Schema38.Types.ObjectId, ref: "Location", required: true, unique: true },
  prefixTemplate: { type: String, required: true, maxlength: 20 },
  digits: { type: Number, required: true, min: 1, max: 9, validate: Number.isSafeInteger },
  resetPolicy: { type: String, enum: ["continuous", "financial_year"], required: true },
  revision: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  allocationRevision: { type: Number, required: true, default: 0, min: 0, validate: Number.isSafeInteger },
  reviewReference: { type: String, required: true, maxlength: 500 },
  confirmedBy: { type: Schema38.Types.ObjectId, ref: "User", required: true },
  confirmedAt: { type: Date, required: true }
}, { timestamps: true });
var PharmacyInvoiceNumbering = mongoose42.model("PharmacyInvoiceNumbering", schema10);
var reservation = new Schema38({
  prefix: { type: String, required: true },
  locationId: { type: Schema38.Types.ObjectId, ref: "Location", required: true },
  organizationId: { type: Schema38.Types.ObjectId, ref: "Organization", required: true }
}, { timestamps: { createdAt: true, updatedAt: false } });
reservation.index({ organizationId: 1, prefix: 1 }, { unique: true, name: "pharmacy_organization_prefix_v1" });
reservation.pre("save", function() {
  if (!this.isNew) throw new Error("Invoice prefix reservations are immutable");
});
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"])
  reservation.pre(operation, function() {
    throw new Error("Invoice prefix reservations are immutable");
  });
reservation.pre("bulkWrite", function() {
  throw new Error("Invoice prefix reservations are immutable");
});
reservation.pre("deleteOne", { document: true, query: false }, function() {
  throw new Error("Invoice prefix reservations are immutable");
});
var PharmacyInvoicePrefix = mongoose42.model("PharmacyInvoicePrefix", reservation);

// services/PharmacyInvoiceNumberingService.ts
init_Counter();
init_AuditLog();
init_Location();
init_Organization();
init_Invoice();

// models/PharmacyOfflineDevice.ts
import mongoose43, { Schema as Schema39 } from "mongoose";
var publicKey = new Schema39({ kty: { type: String, required: true }, crv: { type: String, required: true }, x: { type: String, required: true }, y: { type: String, required: true } }, { _id: false });
var device = new Schema39({
  organizationId: { type: Schema39.Types.ObjectId, required: true, ref: "Organization" },
  locationId: { type: Schema39.Types.ObjectId, required: true, ref: "Location", unique: true },
  deviceId: { type: String, required: true },
  deviceName: { type: String, required: true, maxlength: 80 },
  enrolledBy: { type: Schema39.Types.ObjectId, required: true, ref: "User" },
  publicKey: { type: publicKey, required: true },
  keyFingerprint: { type: String, required: true },
  enrollmentId: { type: String, required: true },
  requestHash: { type: String, required: true },
  payload: { type: String, required: true },
  signature: { type: String, required: true },
  signingKeyId: { type: String, required: true },
  signingPublicKey: { type: new Schema39({ kty: { type: String, required: true }, n: { type: String, required: true }, e: { type: String, required: true } }, { _id: false }), required: true },
  revision: { type: Number, required: true, default: 1 },
  status: { type: String, required: true, enum: ["enrolled", "revoked"], default: "enrolled" },
  authorityRevision: { type: Number, required: true, default: 0, min: 0, validate: Number.isSafeInteger },
  revokedBy: { type: Schema39.Types.ObjectId, ref: "User" },
  revokedAt: Date,
  revokeReference: String
}, { timestamps: true });
var mutable = /* @__PURE__ */ new Set(["status", "revision", "authorityRevision", "revokedBy", "revokedAt", "revokeReference", "updatedAt", "__v"]);
device.pre("save", function() {
  if (!this.isNew && this.modifiedPaths().some((path3) => !mutable.has(path3))) throw new Error("Offline enrollment evidence is immutable");
});
for (const operation of ["updateOne", "findOneAndUpdate"]) device.pre(operation, function() {
  const update = this.getUpdate();
  if (!update || Object.keys(update).some((key) => key !== "$set" && key !== "$setOnInsert") || Object.entries(update).some(([operator, fields]) => Object.keys(fields).some((key) => !(operator === "$setOnInsert" && key === "createdAt") && !mutable.has(key))))
    throw new Error("Offline enrollment evidence is immutable");
});
for (const operation of ["updateMany", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"])
  device.pre(operation, function() {
    throw new Error("Offline enrollment evidence cannot be removed or replaced");
  });
device.pre("bulkWrite", function() {
  throw new Error("Offline enrollment evidence is immutable");
});
device.pre("deleteOne", { document: true, query: false }, function() {
  throw new Error("Offline enrollment evidence cannot be removed");
});
var PharmacyOfflineDevice = mongoose43.model("PharmacyOfflineDevice", device);
var challenge = new Schema39({
  organizationId: { type: Schema39.Types.ObjectId, required: true },
  locationId: { type: Schema39.Types.ObjectId, required: true },
  actorId: { type: Schema39.Types.ObjectId, required: true },
  challengeId: { type: String, required: true, unique: true },
  deviceId: { type: String, required: true },
  publicKey: { type: publicKey, required: true },
  keyFingerprint: { type: String, required: true },
  context: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  consumedAt: Date
}, { timestamps: true });
challenge.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "pharmacy_device_challenge_expiry" });
var PharmacyOfflineChallenge = mongoose43.model("PharmacyOfflineChallenge", challenge);

// services/PharmacyInvoiceNumberingService.ts
init_CommandReceiptService();
init_transaction();
init_indiaFinancialYear();
init_pharmacyInvoiceNumberFormat();

// utilities/invoiceNumber.ts
init_indiaFinancialYear();
async function nextBounded(id, max) {
  await Counter.updateOne({ id }, { $setOnInsert: { seq: 0 } }, { upsert: true });
  const counter = await Counter.findOneAndUpdate({ id, seq: { $gte: 0, $lt: max } }, { $inc: { seq: 1 } }, { returnDocument: "after" });
  if (!counter || !Number.isSafeInteger(counter.seq)) throw new CommandError(409, "Invoice series exhausted or invalid; review numbering before issuing another document");
  return counter.seq;
}
async function reserveBranchSeries(locationId) {
  if (!await Location.exists({ _id: locationId })) throw new CommandError(404, "Invoice location not found");
  let reservation2 = await InvoiceSeries.findOne({ locationId });
  if (!reservation2) {
    const sequence = await nextBounded("invoice-series-v2", 36 ** 4 - 1);
    reservation2 = await InvoiceSeries.create({ locationId, series: sequence.toString(36).toUpperCase().padStart(4, "0") });
  }
  return reservation2;
}
async function allocateInvoiceNumber(locationId, at = /* @__PURE__ */ new Date()) {
  const fiscal = indiaFinancialYear(at);
  return withTransaction(async () => {
    const reservation2 = await reserveBranchSeries(locationId);
    const sequence = await nextBounded(`invoice-v2:${reservation2.series}:${fiscal.start}`, 999999);
    return {
      invoiceNumber: `I${reservation2.series}${fiscal.code}/${String(sequence).padStart(6, "0")}`,
      numberingVersion: 2,
      financialYear: fiscal.label,
      invoiceSeries: reservation2.series
    };
  });
}
async function generateLocationInvoiceNumber(locationId, year) {
  return (await allocateInvoiceNumber(locationId, year === void 0 ? /* @__PURE__ */ new Date() : new Date(Date.UTC(year, 3, 1)))).invoiceNumber;
}

// services/billing/SubscriptionAccess.ts
init_Location();
init_Organization();
init_Subscription();

// services/billing/SubscriptionService.ts
init_safeError();
import mongoose49 from "mongoose";

// models/SaaSPlan.ts
init_commercialQuoteSchema();
import mongoose44, { Schema as Schema40 } from "mongoose";
var SaaSPlanSchema = new Schema40({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true, index: true },
  legacyTier: { type: String, enum: ["starter", "professional", "enterprise"] },
  commercialFamily: { type: String, enum: ["location_products"] },
  commercialPricing: { type: commercialPricingSchema, default: void 0 },
  description: { type: String, required: true },
  monthlyPrice: { type: Number, required: true, default: 0 },
  annualPrice: { type: Number, required: true, default: 0 },
  currency: { type: String, default: "INR" },
  trialDays: { type: Number, default: 15 },
  selfServicePharmacy: { type: Boolean, default: false },
  status: { type: String, enum: ["active", "inactive", "archived"], default: "active", index: true },
  displayOrder: { type: Number, default: 0 },
  isPopular: { type: Boolean, default: false },
  limits: {
    maxLocations: { type: Number, default: 1 },
    maxDoctors: { type: Number, default: 2 },
    maxStaff: { type: Number, default: 5 },
    maxPatients: { type: Number, default: 500 },
    maxAppointments: { type: Number, default: 1e3 },
    maxStorageMB: { type: Number, default: 1024 },
    maxMonthlyWhatsApp: { type: Number, default: 500 }
  },
  features: {
    analytics: { type: Boolean, default: false },
    auditLogs: { type: Boolean, default: false },
    multiBranch: { type: Boolean, default: false },
    dataExport: { type: Boolean, default: false },
    apiAccess: { type: Boolean, default: false },
    aiFeatures: { type: Boolean, default: false },
    whatsappIntegration: { type: Boolean, default: true }
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });
SaaSPlanSchema.virtual("id").get(function() {
  return this._id.toHexString();
});
SaaSPlanSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});
var SaaSPlan = mongoose44.model("SaaSPlan", SaaSPlanSchema);

// services/billing/SubscriptionService.ts
init_Subscription();

// models/SubscriptionPayment.ts
init_commercialQuoteSchema();
import mongoose45, { Schema as Schema41 } from "mongoose";
var SubscriptionPaymentSchema = new Schema41({
  organizationId: { type: Schema41.Types.ObjectId, ref: "Organization", required: true, index: true },
  subscriptionId: { type: Schema41.Types.ObjectId, ref: "Subscription", required: true, index: true },
  planId: { type: Schema41.Types.ObjectId, ref: "SaaSPlan", required: true },
  commercialQuote: { type: commercialQuoteSchema, default: void 0 },
  checkoutSubscriptionFingerprint: { type: String, match: /^[a-f\d]{64}$/, default: void 0 },
  razorpayOrderId: { type: String, required: true, unique: true, index: true },
  razorpayPaymentId: { type: String, default: null, sparse: true, index: true },
  razorpaySignature: { type: String, default: null },
  amount: { type: Number, required: true },
  currency: { type: String, default: "INR" },
  status: {
    type: String,
    enum: ["created", "captured", "failed", "abandoned", "captured_review", "refunded"],
    default: "created",
    index: true
  },
  billingCycle: { type: String, enum: ["monthly", "annual"], default: "monthly" },
  idempotencyKey: { type: String, default: null, sparse: true, index: true },
  failureReason: { type: String, default: null },
  failedPaymentId: { type: String, default: null },
  subtotal: { type: Number, default: null },
  taxAmount: { type: Number, default: null },
  rawWebhookPayload: { type: Schema41.Types.Mixed, default: null },
  paidAt: { type: Date, default: null },
  lastReconciledAt: { type: Date, default: null },
  // Lookup failures do not prove a payment failed. Keep financial status intact
  // while deferring orders absent from the currently configured provider account.
  reconcileAfter: { type: Date, default: null },
  reconciliationIssue: { type: String, enum: ["provider_order_not_found"], default: null },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });
SubscriptionPaymentSchema.virtual("id").get(function() {
  return this._id.toHexString();
});
SubscriptionPaymentSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});
var SubscriptionPayment = mongoose45.model("SubscriptionPayment", SubscriptionPaymentSchema);

// models/SaaSInvoice.ts
init_commercialQuoteSchema();
import mongoose46, { Schema as Schema42 } from "mongoose";
var SaaSInvoiceSchema = new Schema42({
  invoiceNumber: { type: String, required: true, unique: true, index: true },
  organizationId: { type: Schema42.Types.ObjectId, ref: "Organization", required: true, index: true },
  subscriptionId: { type: Schema42.Types.ObjectId, ref: "Subscription", required: true, index: true },
  paymentId: { type: Schema42.Types.ObjectId, ref: "SubscriptionPayment", unique: true, sparse: true, index: true },
  planName: { type: String, required: true },
  commercialQuote: { type: commercialQuoteSchema, default: void 0 },
  billingCycle: { type: String, enum: ["monthly", "annual"], default: "monthly" },
  subtotal: { type: Number, required: true },
  taxAmount: { type: Number, default: 0 },
  totalAmount: { type: Number, required: true },
  currency: { type: String, default: "INR" },
  status: { type: String, enum: ["paid", "unpaid", "void", "refunded"], default: "paid", index: true },
  billingDetails: {
    orgName: { type: String, required: true },
    gstin: { type: String, default: null },
    address: { type: String, default: null },
    city: { type: String, default: null },
    email: { type: String, default: null }
  },
  pdfUrl: { type: String, default: null },
  paidAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });
SaaSInvoiceSchema.virtual("id").get(function() {
  return this._id.toHexString();
});
SaaSInvoiceSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});
var SaaSInvoice = mongoose46.model("SaaSInvoice", SaaSInvoiceSchema);

// services/billing/SubscriptionService.ts
init_UsageRecord();
init_Organization();
init_Location();
init_Doctor();
init_Receptionist();
init_Patient();
init_Appointment();

// services/billing/RazorpayService.ts
import crypto17 from "node:crypto";

// models/SaaSConfig.ts
import mongoose48, { Schema as Schema44 } from "mongoose";
var SaaSConfigSchema = new Schema44(
  {
    key: { type: String, required: true, unique: true, default: "platform_config" },
    razorpayKeyId: { type: String, default: "" },
    razorpayKeySecret: { type: String, default: "" },
    razorpayWebhookSecret: { type: String, default: "" },
    isLiveMode: { type: Boolean, default: false },
    currency: { type: String, default: "INR" }
  },
  { timestamps: true }
);
var SaaSConfig = mongoose48.models.SaaSConfig || mongoose48.model("SaaSConfig", SaaSConfigSchema);

// utilities/resilientHttpClient.ts
init_context();
init_concurrencyBudget();
init_scalability();
import crypto16 from "node:crypto";
var CircuitBreaker = class {
  state = "CLOSED";
  failures = 0;
  successes = 0;
  lastFailureTime = 0;
  halfOpenInFlight = false;
  name;
  options;
  constructor(name, options = {
    failureThreshold: 5,
    resetTimeoutMs: 2e4,
    halfOpenSuccessThreshold: 2
  }) {
    this.name = name;
    this.options = options;
  }
  canExecute() {
    const now = Date.now();
    if (this.state === "OPEN") {
      if (now - this.lastFailureTime > this.options.resetTimeoutMs) {
        this.state = "HALF_OPEN";
        this.successes = 0;
        this.halfOpenInFlight = true;
        return true;
      }
      return false;
    }
    if (this.state === "HALF_OPEN") {
      if (this.halfOpenInFlight) return false;
      this.halfOpenInFlight = true;
    }
    return true;
  }
  recordSuccess() {
    this.halfOpenInFlight = false;
    if (this.state === "HALF_OPEN") {
      this.successes++;
      if (this.successes >= this.options.halfOpenSuccessThreshold) {
        this.state = "CLOSED";
        this.failures = 0;
      }
    } else {
      this.failures = 0;
    }
  }
  recordFailure() {
    this.halfOpenInFlight = false;
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.state === "HALF_OPEN" || this.failures >= this.options.failureThreshold) {
      this.state = "OPEN";
    }
  }
};
var CircuitBreakerOpenError = class extends Error {
  provider;
  constructor(provider) {
    super(`Circuit breaker is OPEN for provider '${provider}'. Request rejected to prevent amplification.`);
    this.name = "CircuitBreakerOpenError";
    this.provider = provider;
  }
};
var AmbiguousOutcomeError = class extends Error {
  provider;
  idempotencyKey;
  originalError;
  constructor(provider, idempotencyKey, originalError) {
    super(
      `Ambiguous outcome for provider '${provider}' with idempotency key '${idempotencyKey || "none"}'. Mutation state cannot be confirmed. Manual or automated reconciliation required.`
    );
    this.name = "AmbiguousOutcomeError";
    this.provider = provider;
    this.idempotencyKey = idempotencyKey;
    this.originalError = originalError;
  }
};
var ResilientHttpClient = class {
  circuitBreakers = /* @__PURE__ */ new Map();
  metrics = /* @__PURE__ */ new Map();
  getCircuitBreaker(provider) {
    if (!this.circuitBreakers.has(provider)) {
      this.circuitBreakers.set(provider, new CircuitBreaker(provider));
    }
    return this.circuitBreakers.get(provider);
  }
  getMetrics(provider) {
    if (!this.metrics.has(provider)) {
      this.metrics.set(provider, {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        circuitBreakerTrips: 0,
        totalLatencyMs: 0,
        averageLatencyMs: 0
      });
    }
    return this.metrics.get(provider);
  }
  getAllMetrics() {
    const result = {};
    for (const [provider, metric] of this.metrics.entries()) {
      result[provider] = { ...metric };
    }
    return result;
  }
  /**
   * Safe classification: GET, HEAD, OPTIONS, PUT, DELETE are idempotent by HTTP spec.
   * POST and PATCH are only safe to retry if an explicit idempotencyKey is supplied.
   */
  isOperationSafeToRetry(method, hasIdempotencyKey, override) {
    if (typeof override === "boolean") return override;
    const idempotentMethods = ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"];
    if (idempotentMethods.includes(method)) return true;
    return hasIdempotencyKey;
  }
  /**
   * Parse Retry-After header adhering to RFC 7231
   */
  parseRetryAfter(response) {
    const header = response.headers.get("retry-after");
    if (!header) return null;
    const seconds = parseInt(header, 10);
    if (!isNaN(seconds)) {
      return Math.max(100, Math.min(seconds * 1e3, 3e4));
    }
    const dateMs = new Date(header).getTime();
    if (!isNaN(dateMs)) {
      return Math.max(100, Math.min(dateMs - Date.now(), 3e4));
    }
    return null;
  }
  /**
   * Execute outbound HTTP call with explicit timeout, circuit breaker, bounded retry, and telemetry.
   */
  async request(url, options) {
    return withConcurrencyBudget(`provider:${options.provider}`, MAX_PROVIDER_CONCURRENCY, () => this.requestBounded(url, options));
  }
  async requestBounded(url, options) {
    const provider = options.provider;
    const method = (options.method || "GET").toUpperCase();
    const timeoutMs = options.timeoutMs || 1e4;
    const hasIdempotency = !!options.idempotencyKey;
    const safeToRetry = this.isOperationSafeToRetry(method, hasIdempotency, options.isIdempotent);
    const maxRetries = options.maxRetries ?? (safeToRetry ? 2 : 0);
    const useCircuitBreaker = options.enableCircuitBreaker !== false;
    const breaker = useCircuitBreaker ? this.getCircuitBreaker(provider) : null;
    const metric = this.getMetrics(provider);
    if (breaker && !breaker.canExecute()) {
      metric.circuitBreakerTrips++;
      throw new CircuitBreakerOpenError(provider);
    }
    const context = requestContextStore.getStore();
    const correlationId = options.correlationId || context?.correlationId || crypto16.randomUUID();
    const headers = {
      "X-Correlation-ID": correlationId,
      "X-Request-ID": correlationId,
      ...options.headers || {}
    };
    if (options.idempotencyKey) {
      headers["Idempotency-Key"] = options.idempotencyKey;
      headers["X-Idempotency-Key"] = options.idempotencyKey;
    }
    if (options.body && typeof options.body === "object" && !(options.body instanceof FormData || options.body instanceof URLSearchParams)) {
      if (!headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }
    }
    const requestBody = options.body && typeof options.body === "object" && headers["Content-Type"]?.includes("application/json") ? JSON.stringify(options.body) : options.body;
    let attempt = 0;
    const startTime = Date.now();
    const deadline = startTime + (options.totalTimeoutMs || 8e3);
    while (attempt <= maxRetries) {
      if (Date.now() >= deadline) {
        breaker?.recordFailure();
        throw new Error("Provider total deadline exceeded");
      }
      attempt++;
      metric.totalRequests++;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), Math.max(1, Math.min(timeoutMs, deadline - Date.now())));
      const attemptStart = Date.now();
      let response;
      let data;
      try {
        response = await fetch(url, {
          method,
          headers,
          body: requestBody,
          signal: controller.signal
        });
        const contentType = response.headers.get("content-type") || "";
        data = contentType.includes("application/json") ? await response.json() : await response.text();
      } catch (err) {
        clearTimeout(timeoutId);
        metric.failedRequests++;
        metric.lastError = err?.message || "Outbound HTTP failed";
        metric.lastErrorTime = (/* @__PURE__ */ new Date()).toISOString();
        breaker?.recordFailure();
        if (safeToRetry && attempt <= maxRetries) {
          const backoff = Math.min(1e4, 500 * Math.pow(2, attempt - 1) + Math.random() * 200);
          await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(backoff, deadline - Date.now()))));
          continue;
        }
        if (!safeToRetry) {
          throw new AmbiguousOutcomeError(provider, options.idempotencyKey, err);
        }
        throw err;
      }
      clearTimeout(timeoutId);
      const latencyMs = Date.now() - attemptStart;
      metric.totalLatencyMs += latencyMs;
      metric.averageLatencyMs = Math.round(metric.totalLatencyMs / metric.totalRequests);
      if (response.ok) {
        breaker?.recordSuccess();
        metric.successfulRequests++;
        return { status: response.status, headers: response.headers, data, latencyMs, retries: attempt - 1 };
      }
      if (response.status >= 500 || response.status === 429) breaker?.recordFailure();
      else breaker?.recordSuccess();
      metric.failedRequests++;
      metric.lastError = `HTTP ${response.status}: ${response.statusText}`;
      metric.lastErrorTime = (/* @__PURE__ */ new Date()).toISOString();
      if ([500, 502, 503, 504, 429].includes(response.status) && safeToRetry && attempt <= maxRetries) {
        const retryAfterMs = this.parseRetryAfter(response);
        const backoffDelay = retryAfterMs ?? Math.min(1e4, 500 * Math.pow(2, attempt - 1) + Math.random() * 200);
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(backoffDelay, deadline - Date.now()))));
        continue;
      }
      if (!safeToRetry && response.status >= 500) {
        throw new AmbiguousOutcomeError(provider, options.idempotencyKey, new Error(`HTTP ${response.status}`));
      }
      const errText = typeof data === "string" ? data : JSON.stringify(data);
      const error = new Error(`Provider '${provider}' request failed with status ${response.status}`);
      error.status = response.status;
      error.responseBody = errText;
      throw error;
    }
    throw new Error(`Outbound request to provider '${provider}' exceeded maximum retry attempts (${maxRetries}).`);
  }
};
var resilientHttpClient = new ResilientHttpClient();

// services/billing/RazorpayService.ts
var RazorpayService = class {
  /** Provider reconciliation only; an empty result never authorizes a resend. */
  async findOrderByReceipt(receipt) {
    const { keyId, keySecret } = await this.getCredentials();
    const response = await resilientHttpClient.request(`https://api.razorpay.com/v1/orders?receipt=${encodeURIComponent(receipt)}&count=2`, {
      provider: "razorpay",
      method: "GET",
      headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}` }
    });
    const matches = (response.data.items || []).filter((order) => order.receipt === receipt);
    if (matches.length > 1) throw new Error("Multiple provider orders require operator review");
    return matches[0] || null;
  }
  /**
   * Fetch active platform Razorpay credentials dynamically from MongoDB (SaaSConfig)
   * Fallback to environment variables.
   */
  async getCredentials() {
    let keyId = (process.env.RAZORPAY_KEY_ID || "").trim();
    let keySecret = (process.env.RAZORPAY_KEY_SECRET || "").trim();
    let webhookSecret = (process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();
    let configuredMode = null;
    try {
      const config = await SaaSConfig.findOne({ key: "platform_config" });
      if (config && config.razorpayKeyId && config.razorpayKeySecret) {
        keyId = config.razorpayKeyId.trim();
        keySecret = config.razorpayKeySecret.trim();
        webhookSecret = (config.razorpayWebhookSecret || webhookSecret).trim();
        configuredMode = config.isLiveMode;
      }
    } catch (err) {
      console.warn("Failed to fetch dynamic SaaSConfig from MongoDB, checking process.env");
    }
    if (!keyId || !keySecret) {
      throw new Error(
        "Razorpay Credentials Not Saved in MongoDB. Please go to Root Admin Console (Dashboard \u2192 Admin \u2192 Billing \u2192 Razorpay Platform Gateway tab), enter your Razorpay Key ID & Key Secret, and click 'Save Gateway Credentials'."
      );
    }
    if (!/^rzp_(test|live)_/.test(keyId)) throw new Error("Razorpay Key ID has an invalid mode prefix");
    if (configuredMode !== null && configuredMode !== keyId.startsWith("rzp_live_")) {
      throw new Error("Razorpay key mode does not match the configured gateway mode");
    }
    return { keyId, keySecret, webhookSecret };
  }
  async getPublicParams() {
    try {
      const { keyId } = await this.getCredentials();
      return { keyId, configured: true };
    } catch {
      return { keyId: "", configured: false };
    }
  }
  /**
   * Create an order directly in Razorpay REST API
   */
  async createOrder(params) {
    const { keyId, keySecret, webhookSecret } = await this.getCredentials();
    if (!webhookSecret) throw new Error("Razorpay webhook secret must be configured before checkout");
    if (process.env.NODE_ENV === "test") {
      return {
        id: `order_test_${crypto17.randomUUID()}`,
        entity: "order",
        amount: Math.round(params.amount * 100),
        amount_paid: 0,
        amount_due: Math.round(params.amount * 100),
        currency: params.currency || "INR",
        receipt: params.receipt,
        status: "created",
        attempts: 0,
        notes: params.notes || {},
        created_at: Math.floor(Date.now() / 1e3)
      };
    }
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const payload = {
      amount: Math.round(params.amount * 100),
      // convert to paise
      currency: params.currency || "INR",
      receipt: params.receipt,
      notes: params.notes || {}
    };
    try {
      const response = await resilientHttpClient.request(
        "https://api.razorpay.com/v1/orders",
        {
          provider: "razorpay",
          method: "POST",
          headers: {
            "Authorization": `Basic ${auth}`,
            "Content-Type": "application/json"
          },
          body: payload,
          timeoutMs: 1e4,
          idempotencyKey: params.receipt ? `rzp_order:${params.receipt}` : void 0,
          isIdempotent: false,
          enableCircuitBreaker: true
        }
      );
      return response.data;
    } catch (err) {
      if (err.status === 401) {
        throw new Error(
          `Razorpay Authentication Failed (401): The Key ID '${keyId}' or Key Secret saved in MongoDB is invalid or rejected by Razorpay. Please re-enter your valid Razorpay Key ID (rzp_test_...) and Key Secret in Dashboard \u2192 Admin \u2192 Billing and click Save.`
        );
      }
      throw err;
    }
  }
  /**
   * Verify Razorpay Payment HMAC SHA256 Signature
   */
  async verifyPaymentSignature(orderId, paymentId, signature) {
    try {
      const { keySecret } = await this.getCredentials();
      const generatedSignature = crypto17.createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex");
      const received = Buffer.from(signature || "", "hex");
      const expected = Buffer.from(generatedSignature, "hex");
      return received.length === expected.length && crypto17.timingSafeEqual(received, expected);
    } catch {
      if (process.env.NODE_ENV === "test") {
        const generatedSignature = crypto17.createHmac("sha256", "test_secret").update(`${orderId}|${paymentId}`).digest("hex");
        return generatedSignature === signature;
      }
      return false;
    }
  }
  async isPaymentCaptured(paymentId, orderId, amountInRupees) {
    const { keyId, keySecret } = await this.getCredentials();
    if (process.env.NODE_ENV === "test") return true;
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const response = await resilientHttpClient.request(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
      provider: "razorpay",
      method: "GET",
      headers: { Authorization: `Basic ${auth}` },
      timeoutMs: 1e4,
      enableCircuitBreaker: true
    });
    const payment = response.data;
    if (payment.id === paymentId && payment.order_id === orderId && payment.status === "captured" && (payment.currency !== "INR" || payment.amount !== Math.round(amountInRupees * 100))) {
      throw new Error("Captured provider payment amount or currency differs from the stored Order");
    }
    return payment.id === paymentId && payment.order_id === orderId && payment.status === "captured" && payment.currency === "INR" && payment.amount === Math.round(amountInRupees * 100);
  }
  async fetchCapturedPaymentForOrder(orderId, amountInRupees) {
    const { keyId, keySecret } = await this.getCredentials();
    if (process.env.NODE_ENV === "test") return null;
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const response = await resilientHttpClient.request(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}/payments`, {
      provider: "razorpay",
      method: "GET",
      headers: { Authorization: `Basic ${auth}` },
      timeoutMs: 1e4,
      enableCircuitBreaker: true
    });
    const allCaptured = response.data.items?.filter((item) => item.order_id === orderId && item.status === "captured") || [];
    if (allCaptured.some((item) => item.currency !== "INR" || item.amount !== Math.round(amountInRupees * 100))) {
      throw new Error("Captured provider Order payment amount or currency needs review");
    }
    const captured = allCaptured.filter((item) => item.order_id === orderId && item.status === "captured" && item.currency === "INR" && item.amount === Math.round(amountInRupees * 100));
    if (captured.length > 1) throw new Error("Multiple captured payments for one Razorpay Order require review");
    return captured[0]?.id || null;
  }
  /**
   * Verify Razorpay Webhook HMAC SHA256 Signature
   */
  async verifyWebhookSignature(rawBody, signature) {
    const { webhookSecret } = await this.getCredentials();
    if (!webhookSecret) throw new Error("Razorpay webhook secret is not configured");
    const expectedSignature = crypto17.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
    const received = Buffer.from(signature || "", "hex");
    const expected = Buffer.from(expectedSignature, "hex");
    return received.length === expected.length && crypto17.timingSafeEqual(received, expected);
  }
  async fetchPaymentRefunds(paymentId) {
    if (!/^pay_[A-Za-z0-9]+$/.test(paymentId)) throw new Error("Invalid provider payment reference");
    const { keyId, keySecret } = await this.getCredentials();
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const response = await resilientHttpClient.request(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refunds?count=100`,
      {
        provider: "razorpay",
        method: "GET",
        headers: { Authorization: `Basic ${auth}` },
        timeoutMs: 1e4,
        enableCircuitBreaker: true
      }
    );
    return response.data;
  }
  /**
   * Process Razorpay Refund
   */
  async processRefund(params) {
    const { keyId, keySecret } = await this.getCredentials();
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const payload = {};
    if (params.amount) payload.amount = Math.round(params.amount * 100);
    const idempotencyKey = `refund:${params.paymentId}:${params.amount || "full"}`;
    const response = await resilientHttpClient.request(
      `https://api.razorpay.com/v1/payments/${params.paymentId}/refund`,
      {
        provider: "razorpay",
        method: "POST",
        headers: {
          "Authorization": `Basic ${auth}`,
          "Content-Type": "application/json"
        },
        body: payload,
        timeoutMs: 1e4,
        idempotencyKey,
        isIdempotent: false,
        enableCircuitBreaker: true
      }
    );
    return response.data;
  }
};
var razorpayService = new RazorpayService();

// services/billing/SubscriptionService.ts
init_eventBus();
init_types();
init_CommunicationOutbox();
init_transaction();
init_logger();

// utilities/commercialQuote.ts
init_CommandReceiptService();
import crypto18 from "node:crypto";

// utilities/billingPeriod.ts
function addBillingPeriod(start, cycle) {
  const result = new Date(Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth() + (cycle === "annual" ? 12 : 1),
    1,
    start.getUTCHours(),
    start.getUTCMinutes(),
    start.getUTCSeconds(),
    start.getUTCMilliseconds()
  ));
  result.setUTCDate(Math.min(start.getUTCDate(), new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate()));
  return result;
}

// utilities/commercialQuote.ts
var LEGACY_TIERS = ["starter", "professional", "enterprise"];
var MAX_PAISE = 1e11;
function integer(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new CommandError(400, `${name} must be a bounded non-negative integer`);
}
function isProductPlan(plan) {
  return plan.commercialFamily === "location_products";
}
function validateCommercialPlan(plan) {
  if (!isProductPlan(plan) || !LEGACY_TIERS.includes(plan.legacyTier) || plan.currency !== "INR") throw new CommandError(409, "A location-product catalogue requires an explicit legacy tier and INR currency");
  const config = plan.commercialPricing;
  if (!config || !["inclusive", "exclusive"].includes(config.taxMode)) throw new CommandError(409, "Reviewed commercial pricing and tax treatment are required");
  integer(config.revision, "Price revision");
  if (config.revision < 1) throw new CommandError(400, "Price revision must be positive");
  integer(config.taxRateBps, "Tax rate", 1e4);
  integer(config.includedDoctors, "Included doctors", 1e3);
  integer(config.doctorsPerAdditionalClinic, "Additional-clinic included doctors", 1e3);
  for (const rates2 of [config.monthly, ...config.annual ? [config.annual] : []]) {
    if (!rates2) throw new CommandError(409, "Monthly product prices must be configured");
    for (const key of ["clinicPaise", "pharmacyPaise", "pharmacyAddonPaise", "extraDoctorPaise"]) integer(rates2[key], key, MAX_PAISE);
    if (rates2.additionalPharmacyPaise != null) integer(rates2.additionalPharmacyPaise, "Additional pharmacy price", MAX_PAISE);
  }
  for (const key of ["maxLocations", "maxDoctors", "maxStaff"]) integer(plan.limits?.[key], key, key === "maxLocations" ? 100 : 1e4);
  return config;
}
function commercialFingerprint(value) {
  const canonical2 = (item) => Array.isArray(item) ? item.map(canonical2) : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical2(child)])) : item;
  return crypto18.createHash("sha256").update(JSON.stringify(canonical2(value))).digest("hex");
}
var quoteFingerprint = (value) => commercialFingerprint(value);
function calculateCommercialQuote(organizationId, plan, selection, now = /* @__PURE__ */ new Date()) {
  const config = validateCommercialPlan(plan);
  if (selection.priceRevision !== config.revision) throw new CommandError(409, "Commercial prices changed; reload the catalogue before quoting");
  if (!["monthly", "annual"].includes(selection.billingCycle)) throw new CommandError(400, "Invalid billing cycle");
  const rates2 = selection.billingCycle === "annual" ? config.annual : config.monthly;
  if (!rates2) throw new CommandError(409, "Annual product prices have not been configured");
  integer(selection.doctorSeats, "Doctor seats", 1e3);
  if (!Array.isArray(selection.locations) || !selection.locations.length || selection.locations.length > plan.limits.maxLocations) throw new CommandError(409, "Selected locations exceed the configured location capacity");
  const locations = selection.locations.map((location2) => {
    if (!/^[a-f\d]{24}$/i.test(location2.locationId) || typeof location2.clinic !== "boolean" || typeof location2.pharmacy !== "boolean" || !location2.clinic && !location2.pharmacy) throw new CommandError(400, "Each location needs an explicit clinic or pharmacy selection");
    integer(location2.capabilityRevision, "Location capability revision");
    return { locationId: location2.locationId.toLowerCase(), clinic: location2.clinic, pharmacy: location2.pharmacy, capabilityRevision: location2.capabilityRevision };
  }).sort((a, b) => a.locationId.localeCompare(b.locationId));
  if (new Set(locations.map((location2) => location2.locationId)).size !== locations.length) throw new CommandError(400, "Select each physical location once");
  const clinics = locations.filter((location2) => location2.clinic).length;
  const pharmacies = locations.filter((location2) => location2.pharmacy && !location2.clinic).length;
  const includedDoctors = clinics ? config.includedDoctors + (clinics - 1) * config.doctorsPerAdditionalClinic : 0;
  const maxDoctors = Math.max(selection.doctorSeats, includedDoctors);
  if (maxDoctors > plan.limits.maxDoctors) throw new CommandError(409, "Doctor seats exceed the configured capacity");
  const lines = [];
  for (const location2 of locations) {
    if (location2.clinic) lines.push({ id: `clinic:${location2.locationId}`, kind: "clinic", locationId: location2.locationId, quantity: 1, unitPricePaise: rates2.clinicPaise, amountPaise: rates2.clinicPaise });
    if (location2.pharmacy) {
      const kind = location2.clinic ? "pharmacy_addon" : "pharmacy";
      const earlierStandalone = locations.some((selected) => selected.clinic && selected.pharmacy) || lines.some((line2) => line2.kind === "pharmacy");
      const price = location2.clinic ? rates2.pharmacyAddonPaise : earlierStandalone ? rates2.additionalPharmacyPaise : rates2.pharmacyPaise;
      if (price == null) throw new CommandError(409, "Additional standalone pharmacy pricing has not been configured");
      lines.push({ id: `${kind}:${location2.locationId}`, kind, locationId: location2.locationId, quantity: 1, unitPricePaise: price, amountPaise: price });
    }
  }
  const extraDoctors = Math.max(0, selection.doctorSeats - includedDoctors);
  if (extraDoctors) lines.push({ id: "extra_doctor", kind: "extra_doctor", quantity: extraDoctors, unitPricePaise: rates2.extraDoctorPaise, amountPaise: extraDoctors * rates2.extraDoctorPaise });
  const amount = lines.reduce((sum, line2) => sum + line2.amountPaise, 0);
  integer(amount, "Quote amount", MAX_PAISE);
  const taxPaise = config.taxMode === "inclusive" ? amount - Math.round(amount * 1e4 / (1e4 + config.taxRateBps)) : Math.round(amount * config.taxRateBps / 1e4);
  const totalPaise = config.taxMode === "inclusive" ? amount : amount + taxPaise;
  integer(totalPaise, "Total quote amount", MAX_PAISE);
  const result = {
    version: 1,
    organizationId,
    planId: plan.id,
    priceRevision: config.revision,
    commercialFamily: clinics && (pharmacies || locations.some((location2) => location2.clinic && location2.pharmacy)) ? "mixed" : clinics ? "clinic" : "pharmacy",
    legacyTier: plan.legacyTier,
    billingCycle: selection.billingCycle,
    currency: "INR",
    taxMode: config.taxMode,
    taxRateBps: config.taxRateBps,
    periodStart: now.toISOString(),
    periodEnd: addBillingPeriod(now, selection.billingCycle).toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60 * 1e3).toISOString(),
    lines,
    subtotalPaise: totalPaise - taxPaise,
    taxPaise,
    totalPaise,
    entitlements: { maxLocations: locations.length, maxDoctors, maxStaff: plan.limits.maxStaff, locations }
  };
  return { ...result, fingerprint: quoteFingerprint(result) };
}

// services/billing/ProductActivationService.ts
init_Location();
init_Organization();
init_Doctor();
init_Receptionist();
init_Subscription();
init_cryptoEnvelope();
init_CommandReceiptService();
function openProductQuote(token, organizationId, planId, cycle) {
  try {
    if (typeof token !== "string" || token.length > 15e4 || !isEncrypted(token)) throw new Error();
    const sealed = JSON.parse(decryptField(token)), quote = sealed.quote;
    if (sealed.purpose !== "subscription-product-quote-v1" || quote.version !== 1 || quote.organizationId !== organizationId || quote.planId !== planId || quote.billingCycle !== cycle) throw new Error();
    return quote;
  } catch {
    throw new CommandError(409, "A server-issued location-product quote for this organization, plan and cycle is required");
  }
}
function productSelectionIdentity(quote) {
  return commercialFingerprint({ planId: quote.planId, billingCycle: quote.billingCycle, limits: {
    maxLocations: quote.entitlements.maxLocations,
    maxDoctors: quote.entitlements.maxDoctors,
    maxStaff: quote.entitlements.maxStaff
  }, locations: quote.entitlements.locations.map(({ locationId, clinic, pharmacy }) => ({ locationId, clinic, pharmacy })) });
}
function subscriptionBillingIdentity(subscription) {
  return commercialFingerprint({
    planId: String(subscription.planId?._id ?? subscription.planId),
    periodStart: new Date(subscription.currentPeriodStart).toISOString(),
    periodEnd: new Date(subscription.currentPeriodEnd).toISOString(),
    source: subscription.entitlementSource ?? null,
    quote: subscription.commercialQuote?.fingerprint ?? null
  });
}
function assertProductChangeAllowed(subscription, quote, now = /* @__PURE__ */ new Date()) {
  if (subscription.commercialQuote && ["active", "cancelled", "trialing"].includes(subscription.status) && new Date(subscription.status === "trialing" ? subscription.trialEndsAt : subscription.currentPeriodEnd) > now && productSelectionIdentity(subscription.commercialQuote.toObject?.() ?? subscription.commercialQuote) !== productSelectionIdentity(quote)) {
    throw new CommandError(409, "The current product period is still valid. Renew the same selection or change products after it ends; proration is not configured");
  }
}
async function validateProductFootprint(quote, session, pin = false) {
  if ((await Subscription.find({ organizationId: quote.organizationId }).select("_id").limit(2).session(session).lean()).length > 1) throw new CommandError(409, "Product subscription needs review before checkout or activation");
  const organization = await Organization.findById(quote.organizationId).select("isActive status currency countryCode").session(session).lean();
  if (!organization || organization.isActive === false || organization.status === "inactive" || organization.currency !== "INR" || organization.countryCode !== "IN") throw new CommandError(409, "Product organization needs review");
  const locations = await Location.find({ organizationId: quote.organizationId, isActive: { $ne: false } }).select("pharmacyCapability").limit(101).session(session).lean();
  if (locations.length !== quote.entitlements.locations.length || locations.some((location2) => !quote.entitlements.locations.some((selected) => selected.locationId === String(location2._id) && selected.capabilityRevision === (location2.pharmacyCapability?.revision ?? 0)))) throw new CommandError(409, "Location selection or capability changed; review a new quote");
  const doctors = await Doctor.countDocuments({ organizationId: quote.organizationId, isActive: { $ne: false } }).session(session);
  const staff = await Receptionist.countDocuments({ organizationId: quote.organizationId, status: { $ne: "inactive" } }).session(session);
  if (doctors > quote.entitlements.maxDoctors || staff > quote.entitlements.maxStaff) throw new CommandError(409, "Active doctor or staff profiles exceed the quoted capacity");
  if (pin) {
    for (const selected of quote.entitlements.locations) {
      const result = await Location.findOneAndUpdate({ _id: selected.locationId, organizationId: quote.organizationId, isActive: { $ne: false } }, { $inc: { __v: 1 } }, { session });
      if (!result) throw new CommandError(409, "Product location changed");
    }
  }
}
async function validateFreshProductQuote(quote, plan, session = null) {
  if (!(Date.parse(quote.expiresAt) > Date.now())) throw new CommandError(409, "Product quote expired; preview it again before checkout");
  const refreshed = calculateCommercialQuote(quote.organizationId, { ...plan.toObject(), id: String(plan._id) }, {
    billingCycle: quote.billingCycle,
    priceRevision: quote.priceRevision,
    doctorSeats: quote.entitlements.maxDoctors,
    locations: quote.entitlements.locations
  }, new Date(quote.periodStart));
  if (refreshed.fingerprint !== quote.fingerprint) throw new CommandError(409, "Product pricing or capacity changed; review a new quote");
  await validateProductFootprint(quote, session);
}

// services/billing/SubscriptionService.ts
init_CommandReceiptService();

// services/billing/ProductEntitlementService.ts
init_Organization();
init_Subscription();
init_Location();
init_CommandReceiptService();
async function getOrganizationProductEntitlements(organizationId, now = /* @__PURE__ */ new Date(), session = null) {
  const organization = await Organization.findById(organizationId).select("isActive status maxLocations maxDoctors maxStaff").session(session).lean();
  if (!organization) throw new CommandError(404, "Organization not found");
  const subscriptions = await Subscription.find({ organizationId }).sort({ createdAt: 1, _id: 1 }).limit(2).session(session).lean();
  const base = {
    enforcement: false,
    mode: "legacy_included",
    active: false,
    source: subscriptions[0]?.entitlementSource || "legacy",
    limits: { maxLocations: organization.maxLocations ?? 1, maxDoctors: organization.maxDoctors ?? 2, maxStaff: organization.maxStaff ?? 2 },
    clinicLocationIds: [],
    pharmacyLocationIds: [],
    fingerprint: null
  };
  if (subscriptions.length > 1) return { ...base, enforcement: true, mode: "review_required" };
  const subscription = subscriptions[0];
  const enabled = organization.isActive !== false && organization.status !== "inactive";
  const periodActive = Boolean(subscription && (subscription.status === "trialing" ? new Date(subscription.trialEndsAt) > now && new Date(subscription.trialStartedAt) <= now : ["active", "cancelled"].includes(subscription.status) && new Date(subscription.currentPeriodStart) <= now && new Date(subscription.currentPeriodEnd) > now));
  if (!subscription?.commercialQuote) {
    const productPlan = subscription && await SaaSPlan.exists({ _id: subscription.planId, commercialFamily: "location_products" }).session(session);
    return { ...base, enforcement: Boolean(productPlan), mode: productPlan ? "review_required" : base.mode, active: enabled && periodActive && !productPlan };
  }
  base.enforcement = true;
  const quote = subscription.commercialQuote;
  try {
    const { fingerprint, ...body } = quote;
    const ids = quote.entitlements.locations.map((location2) => location2.locationId);
    const lineAmount = quote.lines.reduce((sum, line2) => sum + line2.amountPaise, 0);
    const expectedTax = quote.taxMode === "inclusive" ? lineAmount - Math.round(lineAmount * 1e4 / (1e4 + quote.taxRateBps)) : Math.round(lineAmount * quote.taxRateBps / 1e4);
    const valid = quote.version === 1 && quote.organizationId === organizationId && quote.planId === String(subscription.planId) && quote.currency === "INR" && fingerprint === quoteFingerprint(body) && /^[a-f\d]{64}$/.test(fingerprint) && LEGACY_TIERS.includes(quote.legacyTier) && ["pharmacy", "clinic", "mixed"].includes(quote.commercialFamily) && ["inclusive", "exclusive"].includes(quote.taxMode) && Number.isSafeInteger(quote.taxRateBps) && quote.taxRateBps >= 0 && quote.taxRateBps <= 1e4 && quote.lines.length > 0 && new Set(quote.lines.map((line2) => line2.id)).size === quote.lines.length && quote.lines.every((line2) => Number.isSafeInteger(line2.quantity) && line2.quantity > 0 && Number.isSafeInteger(line2.unitPricePaise) && line2.unitPricePaise >= 0 && Number.isSafeInteger(line2.amountPaise) && line2.amountPaise >= 0 && line2.quantity * line2.unitPricePaise === line2.amountPaise && (line2.kind === "extra_doctor" ? line2.id === "extra_doctor" && !line2.locationId && line2.quantity <= quote.entitlements.maxDoctors : line2.quantity === 1 && line2.id === `${line2.kind}:${line2.locationId}` && quote.entitlements.locations.some((location2) => location2.locationId === line2.locationId && (line2.kind === "clinic" ? location2.clinic : line2.kind === "pharmacy_addon" ? location2.clinic && location2.pharmacy : line2.kind === "pharmacy" && !location2.clinic && location2.pharmacy)))) && Number.isSafeInteger(quote.totalPaise) && quote.totalPaise >= 0 && Number.isSafeInteger(quote.taxPaise) && quote.taxPaise >= 0 && quote.subtotalPaise + quote.taxPaise === quote.totalPaise && quote.taxPaise === expectedTax && lineAmount === (quote.taxMode === "inclusive" ? quote.totalPaise : quote.subtotalPaise) && quote.entitlements.maxLocations === ids.length && ids.length > 0 && new Set(ids).size === ids.length && [quote.entitlements.maxDoctors, quote.entitlements.maxStaff].every((value) => Number.isSafeInteger(value) && value >= 0) && quote.entitlements.locations.every((location2) => /^[a-f\d]{24}$/.test(location2.locationId) && typeof location2.clinic === "boolean" && typeof location2.pharmacy === "boolean" && (location2.clinic || location2.pharmacy) && Number.isSafeInteger(location2.capabilityRevision) && location2.capabilityRevision >= 0 && (!location2.clinic || quote.lines.some((line2) => line2.kind === "clinic" && line2.locationId === location2.locationId)) && (!location2.pharmacy || quote.lines.some((line2) => line2.kind === (location2.clinic ? "pharmacy_addon" : "pharmacy") && line2.locationId === location2.locationId))) && Date.parse(quote.periodEnd) > Date.parse(quote.periodStart);
    if (!valid) return { ...base, mode: "review_required" };
    const locations = await Location.countDocuments({ organizationId, _id: { $in: ids }, isActive: { $ne: false } }).session(session);
    if (locations !== ids.length) return { ...base, mode: "review_required" };
    let evidence = false;
    if (subscription.entitlementSource === "paid") evidence = Boolean(await SubscriptionPayment.exists({
      organizationId,
      subscriptionId: subscription._id,
      planId: subscription.planId,
      status: "captured",
      "commercialQuote.fingerprint": fingerprint,
      currency: "INR",
      amount: quote.totalPaise / 100,
      paidAt: { $lte: now }
    }).session(session));
    else if (subscription.entitlementSource === "manual") evidence = Boolean(subscription.manualGrantedBy && subscription.manualGrantedAt && new Date(subscription.manualGrantedAt) <= now && (subscription.manualGrantReason?.trim().length || 0) >= 10);
    else if (subscription.entitlementSource === "trial") evidence = subscription.status === "trialing";
    else if (subscription.entitlementSource === "free") evidence = quote.totalPaise === 0;
    if (!evidence) return { ...base, mode: "review_required" };
    const active = enabled && periodActive;
    return {
      ...base,
      mode: "configured",
      active,
      limits: { maxLocations: quote.entitlements.maxLocations, maxDoctors: quote.entitlements.maxDoctors, maxStaff: quote.entitlements.maxStaff },
      fingerprint,
      clinicLocationIds: active ? quote.entitlements.locations.filter((location2) => location2.clinic).map((location2) => location2.locationId) : [],
      pharmacyLocationIds: active ? quote.entitlements.locations.filter((location2) => location2.pharmacy).map((location2) => location2.locationId) : []
    };
  } catch {
    return { ...base, mode: "review_required" };
  }
}

// services/billing/SubscriptionService.ts
var PlanDowngradeViolationError = class extends Error {
  statusCode;
  violations;
  currentUsage;
  targetPlan;
  activeLocations;
  constructor(validation) {
    super(validation.violations[0]?.message || "Active resources exceed target plan limits");
    this.name = "PlanDowngradeViolationError";
    this.statusCode = 409;
    this.violations = validation.violations;
    this.currentUsage = validation.currentUsage;
    this.targetPlan = validation.targetPlan;
    this.activeLocations = validation.activeLocations || [];
  }
};
var SubscriptionService = class {
  async createInitialSubscription(organizationId, planSlug, customTrialDays, session) {
    if (customTrialDays !== void 0 && (!Number.isInteger(customTrialDays) || customTrialDays < 1 || customTrialDays > 365)) {
      throw new Error("Trial duration must be between 1 and 365 days");
    }
    let planQuery = SaaSPlan.findOne({ slug: planSlug, status: "active" });
    if (session) planQuery = planQuery.session(session);
    let chosenPlan = await planQuery;
    if (!chosenPlan) {
      planQuery = SaaSPlan.findOne({ slug: "starter", status: "active" });
      if (session) planQuery = planQuery.session(session);
      chosenPlan = await planQuery;
    }
    if (!chosenPlan) {
      chosenPlan = await createWithSession(SaaSPlan, {
        name: "Starter",
        slug: "starter",
        description: "Essential tools for individual practitioners & single locations",
        monthlyPrice: 0,
        annualPrice: 0,
        currency: "INR",
        trialDays: 15,
        limits: { maxLocations: 1, maxDoctors: 2, maxStaff: 5, maxPatients: 500, maxAppointments: 1e3, maxStorageMB: 1024, maxMonthlyWhatsApp: 100 },
        features: { analytics: false, auditLogs: false, multiBranch: false, dataExport: false, apiAccess: false, aiFeatures: false, whatsappIntegration: true }
      }, session);
    }
    if (!chosenPlan) throw new Error("Failed to initialize a subscription plan");
    if (isProductPlan(chosenPlan)) throw new CommandError(409, "Product subscriptions require a reviewed location selection and activation workflow");
    const now = /* @__PURE__ */ new Date();
    const trialDays = customTrialDays ?? chosenPlan.trialDays ?? 15;
    const trialEndsAt = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1e3);
    const manualEnterprise = planSlug === "enterprise" && customTrialDays === void 0;
    return createWithSession(Subscription, {
      organizationId,
      planId: chosenPlan._id,
      status: manualEnterprise ? "active" : "trialing",
      entitlementSource: manualEnterprise ? "manual" : "trial",
      billingCycle: "monthly",
      trialStartedAt: now,
      trialEndsAt,
      currentPeriodStart: now,
      currentPeriodEnd: trialEndsAt
    }, session);
  }
  /**
   * Get or initialize subscription for an organization (defaults to 15-day trial on Starter plan)
   */
  async getOrInitializeSubscription(organizationId, customTrialDays) {
    let sub = await Subscription.findOne({ organizationId }).populate("planId");
    if (!sub) {
      const claimToken = new mongoose49.Types.ObjectId().toString();
      let acquired = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const claimedOrg = await Organization.findOneAndUpdate(
          { _id: organizationId, $or: [
            { billingInitializationToken: null },
            { billingInitializationToken: { $exists: false } },
            { billingInitializationAt: { $lte: new Date(Date.now() - 12e4) } }
          ] },
          { $set: { billingInitializationToken: claimToken, billingInitializationAt: /* @__PURE__ */ new Date() } },
          { returnDocument: "after" }
        );
        if (claimedOrg) {
          acquired = true;
          break;
        }
        sub = await Subscription.findOne({ organizationId }).populate("planId");
        if (sub) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!sub && !acquired) throw new Error("Subscription initialization is in progress. Please retry shortly.");
      if (acquired) try {
        sub = await Subscription.findOne({ organizationId }).populate("planId");
        if (!sub) {
          const existingOrg = await Organization.findById(organizationId);
          if (!existingOrg) throw new Error("Organization not found");
          sub = await this.createInitialSubscription(organizationId, existingOrg.plan, customTrialDays, null);
          sub = await Subscription.findById(sub._id).populate("planId");
        }
      } finally {
        await Organization.updateOne(
          { _id: organizationId, billingInitializationToken: claimToken },
          { $unset: { billingInitializationToken: "", billingInitializationAt: "" } }
        );
      }
    }
    const now = /* @__PURE__ */ new Date();
    if (sub.status === "trialing" && sub.trialEndsAt <= now || sub.status === "active" && sub.currentPeriodEnd <= now) {
      await Subscription.updateOne({ _id: sub._id, $or: [
        { status: "trialing", trialEndsAt: { $lte: now } },
        { status: "active", currentPeriodEnd: { $lte: now } }
      ] }, { $set: { status: "expired" } });
      sub = await Subscription.findById(sub._id).populate("planId");
    }
    return sub;
  }
  /**
   * Recalculate and return usage statistics vs active subscription plan limits
   */
  async getOrganizationUsage(organizationId) {
    const orgObjId = new mongoose49.Types.ObjectId(organizationId);
    const locationsCount = await Location.countDocuments({ organizationId: orgObjId, isActive: { $ne: false } });
    const doctorsCount = await Doctor.countDocuments({ organizationId: orgObjId, isActive: { $ne: false } });
    const staffCount = await Receptionist.countDocuments({ organizationId: orgObjId, status: { $ne: "inactive" } });
    const orgLocations = await Location.find({ organizationId: orgObjId, isActive: { $ne: false } }).select("_id");
    const locationIds = orgLocations.map((c) => c._id);
    const patientsCount = await Patient.countDocuments({ organizationId: orgObjId });
    const appointmentsCount = await Appointment.countDocuments({ locationId: { $in: locationIds } });
    const usage = await UsageRecord.findOneAndUpdate(
      { organizationId: orgObjId },
      {
        locationsCount,
        doctorsCount,
        staffCount,
        patientsCount,
        appointmentsCount,
        storageUsedBytes: 0,
        lastCalculatedAt: /* @__PURE__ */ new Date()
      },
      { upsert: true, returnDocument: "after" }
    );
    const subscription = await this.getOrInitializeSubscription(organizationId);
    const plan = subscription.planId;
    const products = await getOrganizationProductEntitlements(organizationId);
    return {
      usage,
      limits: { ...plan?.limits?.toObject?.() || plan?.limits || {}, ...products.limits },
      features: plan ? plan.features : {},
      subscriptionStatus: subscription.status,
      planName: plan ? plan.name : "N/A",
      planSlug: plan ? plan.slug : "starter",
      trialEndsAt: subscription.trialEndsAt,
      currentPeriodEnd: subscription.currentPeriodEnd
    };
  }
  /**
   * Validate if organization's active resource footprint fits within a target plan's quota limits.
   * Prevents downgrade to a tier where active locations, doctors, or staff exceed the tier quota.
   */
  async validatePlanDowngrade(organizationId, targetPlanId) {
    const orgObjId = new mongoose49.Types.ObjectId(organizationId);
    const targetPlan = await SaaSPlan.findById(targetPlanId);
    if (!targetPlan || targetPlan.status !== "active") {
      throw new Error("Target plan not found or not active");
    }
    if (isProductPlan(targetPlan)) throw new CommandError(409, "Use a location-product quote; flat-plan changes cannot activate product selections");
    const activeLocationsCount = await Location.countDocuments({ organizationId: orgObjId, isActive: { $ne: false } });
    const activeDoctorsCount = await Doctor.countDocuments({ organizationId: orgObjId, isActive: { $ne: false } });
    const activeStaffCount = await Receptionist.countDocuments({ organizationId: orgObjId, status: { $ne: "inactive" } });
    const activeLocations = await Location.find({ organizationId: orgObjId, isActive: { $ne: false } }).select("_id name city address phone").lean();
    const maxLocations = targetPlan.limits?.maxLocations ?? 1;
    const maxDoctors = targetPlan.limits?.maxDoctors ?? 2;
    const maxStaff = targetPlan.limits?.maxStaff ?? 5;
    const violations = [];
    if (activeLocationsCount > maxLocations) {
      violations.push({
        resource: "locations",
        current: activeLocationsCount,
        allowed: maxLocations,
        excess: activeLocationsCount - maxLocations,
        message: `You currently have ${activeLocationsCount} active locations, but the ${targetPlan.name} plan allows a maximum of ${maxLocations}. Please deactivate ${activeLocationsCount - maxLocations} branch(es) before downgrading.`
      });
    }
    if (activeDoctorsCount > maxDoctors) {
      violations.push({
        resource: "doctors",
        current: activeDoctorsCount,
        allowed: maxDoctors,
        excess: activeDoctorsCount - maxDoctors,
        message: `You currently have ${activeDoctorsCount} active doctors, but the ${targetPlan.name} plan allows a maximum of ${maxDoctors}. Please deactivate ${activeDoctorsCount - maxDoctors} doctor(s) before downgrading.`
      });
    }
    if (activeStaffCount > maxStaff) {
      violations.push({
        resource: "staff",
        current: activeStaffCount,
        allowed: maxStaff,
        excess: activeStaffCount - maxStaff,
        message: `You currently have ${activeStaffCount} active staff members, but the ${targetPlan.name} plan allows a maximum of ${maxStaff}. Please deactivate ${activeStaffCount - maxStaff} staff member(s) before downgrading.`
      });
    }
    return {
      canDowngrade: violations.length === 0,
      targetPlan: {
        id: targetPlan._id.toString(),
        name: targetPlan.name,
        slug: targetPlan.slug,
        monthlyPrice: targetPlan.monthlyPrice,
        limits: targetPlan.limits
      },
      currentUsage: {
        locations: activeLocationsCount,
        doctors: activeDoctorsCount,
        staff: activeStaffCount
      },
      activeLocations: activeLocations.map((c) => ({
        id: c._id.toString(),
        name: c.name,
        city: c.city,
        address: c.address
      })),
      violations
    };
  }
  /**
   * Direct Switch Plan (for free tiers or direct plan adjustments without Razorpay gateway order)
   */
  async directSwitchPlan(organizationId, planId, billingCycle = "monthly", quoteToken) {
    if (billingCycle !== "monthly" && billingCycle !== "annual") throw new Error("Invalid billing cycle");
    const plan = await SaaSPlan.findById(planId);
    if (!plan || plan.status !== "active") {
      throw new Error("Selected plan is not available");
    }
    const quote = isProductPlan(plan) ? openProductQuote(quoteToken, organizationId, planId, billingCycle) : void 0;
    if (quote ? quote.totalPaise !== 0 : plan.monthlyPrice !== 0 || plan.annualPrice !== 0) {
      throw new Error("Paid plans require a verified checkout payment");
    }
    if (quote) await validateFreshProductQuote(quote, plan);
    else {
      if (quoteToken) throw new CommandError(409, "This plan does not accept a product quote");
      const validation = await this.validatePlanDowngrade(organizationId, planId);
      if (!validation.canDowngrade) throw new PlanDowngradeViolationError(validation);
    }
    const existing = await this.getOrInitializeSubscription(organizationId);
    const now = /* @__PURE__ */ new Date();
    const periodEnd = addBillingPeriod(now, billingCycle);
    const subscription = await withTransaction(async (session) => {
      const target = await Subscription.findById(existing._id).session(session);
      if (!target) throw new Error("Subscription not found");
      if (target.pendingCheckout?.paymentId) {
        throw new Error("A checkout is already in progress. Complete that payment before changing plans.");
      }
      if (target.commercialQuote && !quote) throw new CommandError(409, "A product subscription requires a reviewed product selection; flat plans cannot clear its pharmacy access contract");
      if (quote) {
        await validateFreshProductQuote(quote, plan, session);
        await validateProductFootprint(quote, session, true);
        assertProductChangeAllowed(target, quote, now);
        if (target.entitlementSource === "free" && target.status === "active" && target.currentPeriodEnd > now && target.commercialQuote) return target;
      }
      target.planId = plan._id;
      target.set("commercialQuote", quote);
      target.status = "active";
      target.entitlementSource = "free";
      target.cancelledAt = null;
      target.billingCycle = billingCycle;
      target.currentPeriodStart = now;
      target.currentPeriodEnd = periodEnd;
      target.lastBillingChangeAt = now;
      await target.save({ session });
      await Organization.findByIdAndUpdate(organizationId, {
        plan: quote?.legacyTier || plan.legacyTier || plan.slug,
        maxLocations: quote?.entitlements.maxLocations ?? plan.limits?.maxLocations ?? 1,
        maxDoctors: quote?.entitlements.maxDoctors ?? plan.limits?.maxDoctors ?? 2,
        maxStaff: quote?.entitlements.maxStaff ?? plan.limits?.maxStaff ?? 5
      }, session ? { session } : {});
      return target;
    });
    await eventBus.publishDurable({
      eventType: EVENT_TYPES.BILLING_INVOICE_GENERATED,
      category: "billing",
      organizationId,
      title: "Plan Changed",
      message: `Your subscription has been switched to ${plan.name} (${billingCycle}).`,
      severity: "info",
      actionUrl: "/dashboard/settings/billing"
    });
    return {
      subscription,
      planName: plan.name,
      planSlug: plan.slug
    };
  }
  /**
   * Create Razorpay Checkout Order for upgrade or renewal
   */
  async createCheckoutOrder(organizationId, planId, billingCycle, checkoutIntentId, quoteToken) {
    if (billingCycle !== "monthly" && billingCycle !== "annual") throw new Error("Invalid billing cycle");
    if (checkoutIntentId && !/^[a-zA-Z0-9-]{16,80}$/.test(checkoutIntentId)) throw new Error("Invalid checkout intent ID");
    const plan = await SaaSPlan.findById(planId);
    if (!plan || plan.status !== "active") {
      throw new Error("Selected plan is not available");
    }
    const productQuote = isProductPlan(plan) ? openProductQuote(quoteToken, organizationId, planId, billingCycle) : void 0;
    if (!productQuote && quoteToken) throw new CommandError(409, "This plan does not accept a product quote");
    if (productQuote && !checkoutIntentId) throw new CommandError(428, "A stable checkout intent ID is required for product checkout");
    const subscription = await this.getOrInitializeSubscription(organizationId);
    const intentKey = checkoutIntentId ? `${organizationId}:${checkoutIntentId}` : null;
    if (intentKey) {
      const previous = await SubscriptionPayment.findOne({ organizationId, idempotencyKey: intentKey });
      if (previous) {
        if (previous.planId.toString() !== planId || previous.billingCycle !== billingCycle || previous.commercialQuote?.fingerprint !== productQuote?.fingerprint) {
          throw new Error("Checkout intent belongs to another plan or billing cycle");
        }
        if (previous.status === "captured") return {
          alreadyCompleted: true,
          orderId: previous.razorpayOrderId,
          amount: previous.amount,
          currency: previous.currency,
          keyId: "",
          planName: plan.name,
          planSlug: plan.slug,
          billingCycle,
          paymentId: previous._id.toString()
        };
        if (previous.status === "abandoned" || previous.status === "captured_review" || previous.status === "refunded") {
          throw new Error("Checkout intent is already closed");
        }
        if (previous.status === "created" || previous.status === "failed") {
          const reconciled = await this.reconcileCheckout(organizationId, previous.razorpayOrderId);
          if (reconciled.success) return {
            alreadyCompleted: true,
            orderId: previous.razorpayOrderId,
            amount: previous.amount,
            currency: previous.currency,
            keyId: "",
            planName: plan.name,
            planSlug: plan.slug,
            billingCycle,
            paymentId: previous._id.toString()
          };
          const publicParams = await razorpayService.getPublicParams();
          if (!publicParams.keyId) throw new Error("Razorpay checkout key is unavailable");
          return {
            orderId: previous.razorpayOrderId,
            amount: previous.amount,
            currency: previous.currency,
            keyId: publicParams.keyId,
            planName: plan.name,
            planSlug: plan.slug,
            billingCycle,
            paymentId: previous._id.toString(),
            reused: true
          };
        }
      }
    }
    if (productQuote) {
      await validateFreshProductQuote(productQuote, plan);
      assertProductChangeAllowed(subscription, productQuote);
    } else {
      if (subscription.commercialQuote) throw new CommandError(409, "A product subscription requires a reviewed product selection; flat checkout is unavailable");
      const validation = await this.validatePlanDowngrade(organizationId, planId);
      if (!validation.canDowngrade) throw new PlanDowngradeViolationError(validation);
    }
    if (plan.currency !== "INR") throw new Error("Online checkout currently supports INR plans only");
    const basePrice = billingCycle === "annual" ? plan.annualPrice : plan.monthlyPrice;
    const basePricePaise = Math.round(basePrice * 100);
    if (!productQuote && basePrice === 0 || productQuote?.totalPaise === 0) throw new Error("This plan has no payable checkout amount; use the free plan switch instead");
    if (!Number.isFinite(basePrice) || basePrice < 0 || !Number.isSafeInteger(basePricePaise) || Math.abs(basePrice * 100 - basePricePaise) > 1e-6) {
      throw new Error("Plan price must be a positive INR amount with at most two decimal places");
    }
    const taxRate = 0.18;
    const taxAmount = productQuote ? productQuote.taxPaise / 100 : Math.round(basePricePaise * taxRate / 100);
    const totalPaise = productQuote?.totalPaise ?? basePricePaise + taxAmount * 100;
    if (!Number.isSafeInteger(totalPaise)) throw new Error("Invalid checkout amount");
    const totalAmount = totalPaise / 100;
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await Subscription.findById(subscription._id);
      const pendingId = current?.pendingCheckout?.paymentId;
      if (pendingId) {
        const pending = await SubscriptionPayment.findById(pendingId);
        if (pending?.status === "created" || pending?.status === "failed") {
          if (pending.planId.toString() !== planId || pending.billingCycle !== billingCycle || pending.commercialQuote?.fingerprint !== productQuote?.fingerprint) {
            throw new Error("Another checkout is in progress. Complete it before selecting a different plan.");
          }
          const reconciled = await this.reconcileCheckout(organizationId, pending.razorpayOrderId);
          if (reconciled.success) return {
            alreadyCompleted: true,
            orderId: pending.razorpayOrderId,
            amount: pending.amount,
            currency: pending.currency,
            keyId: "",
            planName: plan.name,
            planSlug: plan.slug,
            billingCycle,
            paymentId: pending._id.toString()
          };
          const publicParams = await razorpayService.getPublicParams();
          if (!publicParams.keyId) throw new Error("Razorpay checkout key is unavailable");
          return {
            orderId: pending.razorpayOrderId,
            amount: pending.amount,
            currency: pending.currency,
            keyId: publicParams.keyId,
            planName: plan.name,
            planSlug: plan.slug,
            billingCycle,
            paymentId: pending._id.toString(),
            reused: true
          };
        }
        if (!pending && current?.pendingCheckout?.claimedAt && Date.now() - current.pendingCheckout.claimedAt.getTime() < 12e4) {
          throw new Error("Checkout is being prepared. Please retry shortly.");
        }
        await Subscription.updateOne({ _id: subscription._id, "pendingCheckout.paymentId": pendingId }, { $unset: { pendingCheckout: "" } });
        continue;
      }
      break;
    }
    const paymentId = new mongoose49.Types.ObjectId();
    const claim = await Subscription.findOneAndUpdate(
      { _id: subscription._id, $or: [
        { "pendingCheckout.paymentId": { $exists: false } },
        { "pendingCheckout.paymentId": null }
      ] },
      { $set: { pendingCheckout: { paymentId, claimedAt: /* @__PURE__ */ new Date() } } },
      { returnDocument: "after" }
    );
    if (!claim) throw new Error("Checkout is already in progress. Please retry shortly.");
    const receipt = `rcpt_${paymentId.toString()}`;
    let providerOrderCreated = false;
    try {
      const order = await razorpayService.createOrder({
        amount: totalAmount,
        currency: "INR",
        receipt,
        notes: { organizationId, planId, planSlug: plan.slug, billingCycle }
      });
      providerOrderCreated = true;
      if (!order.id || order.amount !== totalPaise || order.currency !== "INR" || order.receipt !== receipt || order.status !== "created") {
        throw new Error("Razorpay Order does not match the server checkout quote");
      }
      const payment = await SubscriptionPayment.create({
        _id: paymentId,
        organizationId,
        subscriptionId: subscription._id,
        planId: plan._id,
        commercialQuote: productQuote,
        checkoutSubscriptionFingerprint: productQuote ? subscriptionBillingIdentity(claim) : void 0,
        razorpayOrderId: order.id,
        amount: totalAmount,
        subtotal: (productQuote?.subtotalPaise ?? basePricePaise) / 100,
        taxAmount,
        currency: "INR",
        status: "created",
        billingCycle,
        idempotencyKey: intentKey
      });
      const publicParams = await razorpayService.getPublicParams();
      if (!publicParams.keyId) throw new Error("Razorpay checkout key is unavailable");
      return {
        orderId: order.id,
        amount: totalAmount,
        currency: "INR",
        keyId: publicParams.keyId,
        planName: plan.name,
        planSlug: plan.slug,
        billingCycle,
        paymentId: payment._id.toString()
      };
    } catch (error) {
      if (!providerOrderCreated && !(error instanceof Error && error.name === "AmbiguousOutcomeError")) {
        await Subscription.updateOne(
          { _id: subscription._id, "pendingCheckout.paymentId": paymentId },
          { $unset: { pendingCheckout: "" } }
        );
      }
      throw error;
    }
  }
  /**
   * Verify Razorpay Payment Signature & Activate Subscription
   */
  async resumeCheckoutOrder(organizationId, orderId) {
    const payment = await SubscriptionPayment.findOne({ organizationId, razorpayOrderId: orderId });
    if (!payment) throw new CommandError(404, "Checkout order not found");
    const result = await this.reconcileCheckout(organizationId, orderId);
    if (result.success) return { alreadyCompleted: true, orderId };
    if (result.status !== "created") throw new CommandError(409, "This checkout is closed or requires review");
    const params = await razorpayService.getPublicParams();
    if (!params.keyId) throw new Error("Razorpay checkout key is unavailable");
    return {
      orderId,
      amount: payment.amount,
      currency: payment.currency,
      keyId: params.keyId,
      paymentId: String(payment._id),
      billingCycle: payment.billingCycle,
      reused: true
    };
  }
  async verifyAndActivateSubscription(organizationId, razorpayOrderId, razorpayPaymentId, razorpaySignature) {
    const payment = await SubscriptionPayment.findOne({ razorpayOrderId, organizationId });
    if (!payment) throw new Error("Payment record not found");
    const isValid = await razorpayService.verifyPaymentSignature(
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature
    );
    if (!isValid) {
      throw new Error("Payment verification failed: Invalid signature");
    }
    const captured = await razorpayService.isPaymentCaptured(razorpayPaymentId, razorpayOrderId, payment.amount);
    if (!captured) return { success: false, pending: true, message: "Payment is awaiting capture" };
    return this.activateCapturedPayment(payment, razorpayPaymentId, razorpaySignature);
  }
  async reconcileCheckout(organizationId, razorpayOrderId) {
    const subscription = razorpayOrderId ? null : await Subscription.findOne({ organizationId });
    const payment = razorpayOrderId ? await SubscriptionPayment.findOne({ organizationId, razorpayOrderId }) : subscription?.pendingCheckout?.paymentId ? await SubscriptionPayment.findOne({ _id: subscription.pendingCheckout.paymentId, organizationId }) : await SubscriptionPayment.findOne({ organizationId, status: { $in: ["created", "failed"] } }).sort({ createdAt: -1 });
    if (!payment) return { status: "none", success: false };
    if (payment.status === "captured") return { status: "captured", success: true, orderId: payment.razorpayOrderId };
    if (payment.status === "captured_review") return { status: "captured_review", success: false, requiresReview: true, orderId: payment.razorpayOrderId };
    if (payment.status !== "created" && payment.status !== "failed" && payment.status !== "abandoned") {
      return { status: payment.status, success: false, orderId: payment.razorpayOrderId };
    }
    const capturedId = await razorpayService.fetchCapturedPaymentForOrder(payment.razorpayOrderId, payment.amount);
    await SubscriptionPayment.updateOne({ _id: payment._id }, {
      $set: { lastReconciledAt: /* @__PURE__ */ new Date() },
      $unset: { reconcileAfter: "", reconciliationIssue: "" }
    });
    if (capturedId) {
      const activated = await this.activateCapturedPayment(payment, capturedId);
      return {
        status: activated.success ? "captured" : "captured_review",
        success: activated.success,
        requiresReview: !activated.success,
        orderId: payment.razorpayOrderId
      };
    }
    return {
      status: payment.status === "failed" ? "created" : payment.status,
      success: false,
      orderId: payment.razorpayOrderId,
      amount: payment.amount,
      currency: payment.currency,
      planId: payment.planId.toString(),
      billingCycle: payment.billingCycle,
      failureReason: payment.failureReason || null
    };
  }
  async abandonCheckout(organizationId, razorpayOrderId) {
    const payment = await SubscriptionPayment.findOne({ organizationId, razorpayOrderId });
    if (!payment) throw new Error("Checkout order not found");
    const current = await this.reconcileCheckout(organizationId, razorpayOrderId);
    if (current.success || current.status === "captured_review") return current;
    if (payment.status !== "created" && payment.status !== "failed") return current;
    await withTransaction(async (session) => {
      const latest = await SubscriptionPayment.findById(payment._id).session(session);
      if (!latest || latest.status !== "created" && latest.status !== "failed") return;
      latest.status = "abandoned";
      await latest.save({ session });
      await Subscription.updateOne(
        { _id: payment.subscriptionId, "pendingCheckout.paymentId": payment._id },
        { $unset: { pendingCheckout: "" } },
        session ? { session } : {}
      );
    });
    return { status: "abandoned", success: false, orderId: razorpayOrderId };
  }
  async activateCapturedPayment(payment, razorpayPaymentId, razorpaySignature) {
    const organizationId = payment.organizationId.toString();
    const activation = await withTransaction(async (session) => {
      const currentPayment = await SubscriptionPayment.findById(payment._id).session(session);
      if (!currentPayment) throw new Error("Payment record not found");
      if (currentPayment.status === "captured") {
        if (currentPayment.razorpayPaymentId !== razorpayPaymentId) throw new Error("Captured Order has a different payment ID");
        const [sub, existingInvoice] = await Promise.all([
          Subscription.findById(currentPayment.subscriptionId).populate("planId").session(session),
          SaaSInvoice.findOne({ paymentId: currentPayment._id }).session(session)
        ]);
        if (!sub || !existingInvoice) throw new Error("Captured payment needs subscription reconciliation");
        return { alreadyActivated: true, subscription: sub, invoice: existingInvoice, org: null, plan: null };
      }
      if (currentPayment.status === "captured_review") {
        if (currentPayment.razorpayPaymentId !== razorpayPaymentId) throw new Error("Order has a different captured payment ID");
        const invoice3 = await SaaSInvoice.findOne({ paymentId: currentPayment._id }).session(session);
        if (!invoice3) throw new Error("Captured payment needs invoice reconciliation");
        return { alreadyActivated: true, requiresReview: true, subscription: null, invoice: invoice3, org: null, plan: null };
      }
      if (currentPayment.status === "refunded") throw new Error("Refunded payment cannot activate a subscription");
      if (currentPayment.razorpayPaymentId && currentPayment.razorpayPaymentId !== razorpayPaymentId) {
        throw new Error("Payment ID does not match this order");
      }
      const plan2 = await SaaSPlan.findById(currentPayment.planId).session(session);
      const subscription = await Subscription.findById(currentPayment.subscriptionId).session(session);
      const org2 = await Organization.findById(organizationId).session(session);
      if (!plan2 || !subscription || !org2) throw new Error("Payment plan, subscription or organization not found");
      const now = /* @__PURE__ */ new Date();
      const quote = currentPayment.toObject().commercialQuote;
      let requiresReview = Boolean(subscription.lastBillingChangeAt && subscription.lastBillingChangeAt.getTime() > currentPayment.createdAt.getTime()) || String(subscription.organizationId) !== organizationId;
      if (quote) {
        const { fingerprint, ...body } = quote;
        requiresReview ||= !isProductPlan(plan2) || fingerprint !== quoteFingerprint(body) || quote.organizationId !== organizationId || quote.planId !== String(plan2._id) || currentPayment.checkoutSubscriptionFingerprint !== subscriptionBillingIdentity(subscription) || quote.billingCycle !== currentPayment.billingCycle || quote.currency !== currentPayment.currency || quote.totalPaise !== Math.round(currentPayment.amount * 100) || quote.subtotalPaise !== Math.round((currentPayment.subtotal ?? -1) * 100) || quote.taxPaise !== Math.round((currentPayment.taxAmount ?? -1) * 100);
        if (!requiresReview) try {
          assertProductChangeAllowed(subscription, quote, now);
          await validateProductFootprint(quote, session, true);
        } catch (error) {
          if (!(error instanceof CommandError)) throw error;
          requiresReview = true;
        }
      } else requiresReview ||= isProductPlan(plan2) || Boolean(subscription.commercialQuote);
      const continuingSamePlan = ["active", "cancelled"].includes(subscription.status) && subscription.planId.toString() === plan2._id.toString() && subscription.currentPeriodEnd > now;
      const extensionStart = continuingSamePlan ? subscription.currentPeriodEnd : now;
      const periodStart = quote && continuingSamePlan ? subscription.currentPeriodStart : extensionStart;
      const periodEnd = addBillingPeriod(extensionStart, currentPayment.billingCycle);
      if (!requiresReview) {
        subscription.planId = plan2._id;
        subscription.set("commercialQuote", quote);
        subscription.status = "active";
        subscription.entitlementSource = "paid";
        subscription.cancelledAt = null;
        subscription.billingCycle = currentPayment.billingCycle;
        subscription.currentPeriodStart = periodStart;
        subscription.currentPeriodEnd = periodEnd;
        subscription.lastBillingChangeAt = now;
        await subscription.save({ session });
        await Organization.findByIdAndUpdate(organizationId, {
          plan: quote?.legacyTier || plan2.legacyTier || plan2.slug,
          maxLocations: quote?.entitlements.maxLocations ?? plan2.limits?.maxLocations ?? 1,
          maxDoctors: quote?.entitlements.maxDoctors ?? plan2.limits?.maxDoctors ?? 2,
          maxStaff: quote?.entitlements.maxStaff ?? plan2.limits?.maxStaff ?? 5
        }, session ? { session } : {});
      }
      const { getNextAtomicSequence: getNextAtomicSequence2 } = await Promise.resolve().then(() => (init_Counter(), Counter_exports));
      const currentYear = now.getFullYear();
      const seq = await getNextAtomicSequence2(`saas_invoice_${currentYear}`);
      const invoiceNumber2 = `SAAS-${currentYear}-${seq.toString().padStart(6, "0")}`;
      const subtotal = currentPayment.subtotal ?? Math.round(currentPayment.amount / 1.18);
      const invoice2 = await createWithSession(SaaSInvoice, {
        invoiceNumber: invoiceNumber2,
        organizationId,
        subscriptionId: subscription._id,
        paymentId: currentPayment._id,
        planName: plan2.name,
        billingCycle: currentPayment.billingCycle,
        commercialQuote: currentPayment.commercialQuote,
        subtotal,
        taxAmount: currentPayment.taxAmount ?? currentPayment.amount - subtotal,
        totalAmount: currentPayment.amount,
        currency: "INR",
        status: "paid",
        billingDetails: {
          orgName: org2.name,
          gstin: org2.billingDetails?.gstin ?? org2.taxId ?? null,
          address: org2.billingDetails?.address ?? org2.address ?? null,
          city: org2.city || null,
          email: org2.billingDetails?.email ?? org2.email ?? null
        },
        paidAt: now
      }, session);
      currentPayment.razorpayPaymentId = razorpayPaymentId;
      if (razorpaySignature) currentPayment.razorpaySignature = razorpaySignature;
      currentPayment.status = requiresReview ? "captured_review" : "captured";
      currentPayment.paidAt = now;
      await currentPayment.save({ session });
      await Subscription.updateOne(
        { _id: subscription._id, "pendingCheckout.paymentId": currentPayment._id },
        { $unset: { pendingCheckout: "" } },
        session ? { session } : {}
      );
      return { alreadyActivated: false, requiresReview, subscription, invoice: invoice2, org: org2, plan: plan2 };
    });
    if (activation.alreadyActivated) return {
      success: !activation.requiresReview,
      requiresReview: activation.requiresReview,
      subscription: activation.subscription,
      invoice: activation.invoice,
      message: activation.requiresReview ? "Captured payment requires plan review" : "Subscription already activated"
    };
    if (!activation.plan || !activation.org) throw new Error("Subscription activation could not be completed");
    const { invoice, org, plan } = activation;
    const invoiceNumber = invoice.invoiceNumber;
    if (activation.requiresReview) {
      logger.warn("billing.payment.captured_review", { tenantId: organizationId }, {
        paymentId: payment._id.toString(),
        providerPaymentId: razorpayPaymentId,
        orderId: payment.razorpayOrderId
      });
      await eventBus.publishDurable({
        eventType: EVENT_TYPES.SYSTEM_ALERT,
        category: "billing",
        organizationId,
        title: "Captured payment needs review",
        message: `Payment ${razorpayPaymentId} was captured after a later plan change. Invoice #${invoiceNumber} is recorded.`,
        severity: "warning",
        actionUrl: "/dashboard/settings/billing"
      });
      return {
        success: false,
        requiresReview: true,
        subscription: activation.subscription,
        invoice,
        message: "Payment captured; plan change requires review"
      };
    }
    try {
      await eventBus.publishDurable({
        eventType: EVENT_TYPES.BILLING_INVOICE_GENERATED,
        category: "billing",
        organizationId,
        title: "Subscription Activated",
        message: `Your ${plan.name} (${payment.billingCycle}) subscription is now active! Invoice #${invoiceNumber} generated.`,
        severity: "success",
        actionUrl: "/dashboard/settings/billing"
      });
    } catch (eventError) {
      console.error("Failed to publish subscription activation event:", safeError(eventError));
    }
    const recipientEmail = org?.email || invoice.billingDetails?.email;
    if (recipientEmail && !recipientEmail.includes("placeholder.com")) {
      try {
        const emailBodyHtml = `
          <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f8fafc; padding: 30px; color: #1e293b;">
            <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; padding: 30px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
              <div style="text-align: center; border-bottom: 2px solid #0284c7; padding-bottom: 20px; margin-bottom: 20px;">
                <h1 style="color: #0284c7; margin: 0; font-size: 24px;">Ekavyu Healthcare SaaS</h1>
                <p style="color: #64748b; font-size: 13px; margin-top: 4px;">Commercial Subscription Invoice Receipt</p>
              </div>

              <p style="font-size: 15px; font-weight: 600;">Dear ${org?.name || "Customer"},</p>
              <p style="font-size: 14px; color: #334155; line-height: 1.6;">
                Thank you for subscribing to Ekavyu. Your payment for the <strong>${plan.name} Plan (${payment.billingCycle})</strong> has been successfully processed.
              </p>

              <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 13px;">
                <tr style="background: #f1f5f9;">
                  <td style="padding: 10px; border: 1px solid #cbd5e1; font-weight: bold;">Invoice Number</td>
                  <td style="padding: 10px; border: 1px solid #cbd5e1; font-family: monospace;">${invoiceNumber}</td>
                </tr>
                <tr>
                  <td style="padding: 10px; border: 1px solid #cbd5e1; font-weight: bold;">Plan Name</td>
                  <td style="padding: 10px; border: 1px solid #cbd5e1;">${plan.name} (${payment.billingCycle})</td>
                </tr>
                <tr style="background: #f1f5f9;">
                  <td style="padding: 10px; border: 1px solid #cbd5e1; font-weight: bold;">Paid Amount</td>
                  <td style="padding: 10px; border: 1px solid #cbd5e1; font-weight: bold; color: #0284c7;">\u20B9${payment.amount.toLocaleString("en-IN")} INR</td>
                </tr>
              </table>

              <p style="font-size: 13px; color: #64748b;">
                You can download a PDF copy of this invoice directly from your Organization Settings -> Commercial Billing & Subscription dashboard.
              </p>

              <div style="margin-top: 30px; padding-top: 15px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 12px; color: #94a3b8;">
                Ekavyu Healthcare SaaS System \u2022 Automated Commercial Billing & Invoicing
              </div>
            </div>
          </div>
        `;
        await enqueueTransactionalEmail({
          to: recipientEmail,
          subject: `[Ekavyu Invoice #${invoiceNumber}] Subscription Payment Confirmed - ${plan.name} Plan`,
          html: emailBodyHtml,
          idempotencyKey: `transactional-email:subscription-invoice:${invoice._id}`
        });
      } catch (emailErr) {
        console.error("Failed to enqueue subscription invoice email:", safeError(emailErr));
      }
    }
    const updatedSub = await Subscription.findById(activation.subscription._id).populate("planId");
    logger.info("billing.subscription.activated", { tenantId: organizationId }, {
      paymentId: payment._id.toString(),
      providerPaymentId: razorpayPaymentId,
      orderId: payment.razorpayOrderId,
      subscriptionId: activation.subscription._id.toString()
    });
    return {
      success: true,
      subscription: updatedSub,
      invoice,
      message: "Subscription activated successfully"
    };
  }
  /**
   * Process Razorpay Webhook Event Idempotently
   */
  async processRazorpayWebhook(rawBody, signature, eventData) {
    const isValid = await razorpayService.verifyWebhookSignature(rawBody, signature);
    if (!isValid) {
      throw new Error("Invalid webhook signature");
    }
    const event = eventData.event;
    const payload = eventData.payload;
    if (event === "payment.captured") {
      const paymentEntity = payload.payment?.entity;
      if (paymentEntity && paymentEntity.order_id) {
        const orderId = paymentEntity.order_id;
        const paymentId = paymentEntity.id;
        const existingPayment = await SubscriptionPayment.findOne({ razorpayOrderId: orderId });
        if (existingPayment) {
          if (paymentEntity.status !== "captured" || paymentEntity.amount !== Math.round(existingPayment.amount * 100) || paymentEntity.currency !== existingPayment.currency) {
            throw new Error("Captured webhook does not match the stored Order amount or currency");
          }
          if (existingPayment.status === "captured" || existingPayment.status === "captured_review") {
            if (existingPayment.razorpayPaymentId !== paymentId) throw new Error("Order has another captured payment ID");
          } else {
            await this.activateCapturedPayment(existingPayment, paymentId);
          }
        }
      }
    } else if (event === "payment.failed") {
      const paymentEntity = payload.payment?.entity;
      if (paymentEntity && paymentEntity.order_id) {
        const payment = await SubscriptionPayment.findOne({ razorpayOrderId: paymentEntity.order_id });
        if (payment && payment.status === "created") {
          payment.failedPaymentId = paymentEntity.id || null;
          payment.failureReason = paymentEntity.error_description || "Payment failed at gateway";
          await payment.save();
          logger.info("billing.payment.attempt_failed", { tenantId: payment.organizationId.toString() }, {
            paymentId: payment._id.toString(),
            orderId: payment.razorpayOrderId,
            providerPaymentId: paymentEntity.id || null
          });
        }
      }
    }
    return { received: true };
  }
  /**
   * Cancel Subscription
   */
  async cancelSubscription(organizationId) {
    const sub = await Subscription.findOne({ organizationId });
    if (!sub) throw new Error("No subscription found");
    sub.cancelledAt = /* @__PURE__ */ new Date();
    await sub.save();
    await eventBus.publishDurable({
      eventType: EVENT_TYPES.SYSTEM_ALERT,
      category: "billing",
      organizationId,
      title: "Subscription Cancellation Requested",
      message: "Your subscription auto-renewal has been cancelled. Plan access remains active until the end of your billing cycle.",
      severity: "warning",
      actionUrl: "/dashboard/settings/billing"
    });
    const org = await Organization.findById(organizationId);
    if (org?.email && !org.email.includes("placeholder.com")) {
      try {
        await enqueueTransactionalEmail({
          to: org.email,
          subject: `[Ekavyu] Subscription Cancellation Confirmed - ${org.name}`,
          html: `<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">
            <h2>Subscription Cancellation Confirmed</h2>
            <p>Dear ${org.name},</p>
            <p>Your subscription auto-renewal for Ekavyu SaaS has been cancelled as requested.</p>
            <p>Your organization's current plan features and resource limits will remain active until the end of your current billing period.</p>
            <p>Best regards,<br/>Ekavyu Billing Team</p>
          </div>`,
          idempotencyKey: `transactional-email:subscription-cancelled:${sub._id}:${sub.cancelledAt.getTime()}`
        });
      } catch (emailErr) {
        console.error("Failed to enqueue cancellation email:", safeError(emailErr));
      }
    }
    return sub;
  }
};
var subscriptionService = new SubscriptionService();

// services/billing/SubscriptionAccess.ts
import mongoose50 from "mongoose";
async function canCreateLocationBooking(locationId, requirePublished = false) {
  if (!mongoose50.Types.ObjectId.isValid(locationId)) return false;
  const location2 = await Location.findById(locationId).select("organizationId isActive isPublished").lean();
  if (requirePublished && location2?.isPublished === false) return false;
  if (!location2 || location2.isActive === false || !location2.organizationId) return false;
  return canCreateOrganizationBooking(location2.organizationId.toString(), locationId);
}
async function canCreateOrganizationBooking(organizationId, locationId) {
  if (!mongoose50.Types.ObjectId.isValid(organizationId)) return false;
  const organization = await Organization.findById(organizationId).select("isActive status").lean();
  if (!organization || organization.isActive === false || organization.status === "inactive") return false;
  const subscription = await subscriptionService.getOrInitializeSubscription(organizationId);
  if (!subscriptionAllowsBooking(subscription)) return false;
  if (!subscription.commercialQuote && !isProductPlan(subscription.planId)) return true;
  const entitlement = await getOrganizationProductEntitlements(organizationId);
  return entitlement.active && (locationId ? entitlement.clinicLocationIds.includes(locationId) : entitlement.clinicLocationIds.length > 0);
}
function subscriptionAllowsBooking(subscription) {
  const now = Date.now();
  if (subscription.status === "trialing") return new Date(subscription.trialEndsAt).getTime() > now;
  if (["active", "cancelled"].includes(subscription.status)) return new Date(subscription.currentPeriodEnd).getTime() > now;
  return false;
}

// utilities/doctorBookingEligibility.ts
init_User();
init_Doctor();
import mongoose51 from "mongoose";
async function isActiveBookingDoctor(doctorId) {
  if (!mongoose51.Types.ObjectId.isValid(doctorId)) return false;
  const [user, disabledProfile] = await Promise.all([
    User.exists({ _id: doctorId, isActive: true }),
    Doctor.exists({ userId: doctorId, isActive: false })
  ]);
  return Boolean(user) && !disabledProfile;
}

// services/AppointmentService.ts
init_LocationAccessService();
init_eventBus();
init_types();
init_websocket();

// services/SlotService.ts
init_DoctorAssignment();
init_Appointment();
init_Location();
init_locationTime();
async function getEffectiveDoctorSchedule(doctorId, locationId, targetDate, assignmentWorkingHours, locationTimezone) {
  const timezone = locationTimezone || await getLocationTimezone(locationId);
  const dateStr = typeof targetDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(targetDate) ? targetDate : locationDateKey(typeof targetDate === "string" ? new Date(targetDate) : targetDate, timezone);
  const d = /* @__PURE__ */ new Date(`${dateStr}T12:00:00Z`);
  const daysOfWeek = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const dayName = daysOfWeek[d.getUTCDay()];
  const override = await DoctorDayOverride.findOne({ locationId, doctorId, date: dateStr });
  if (override) {
    if (override.status === "unavailable") {
      return {
        isWorkingDay: false,
        intervals: [],
        workingHoursLabel: override.reason ? `Unavailable: ${override.reason}` : "Doctor Unavailable (Override)",
        dayStartTime: "00:00",
        dayEndTime: "00:00",
        overrideActive: true,
        overrideStatus: "unavailable",
        overrideReason: override.reason || void 0
      };
    }
    if (override.status === "delayed" || override.status === "extended" || override.status === "available") {
      let baseSchedule2;
      if (assignmentWorkingHours !== void 0) {
        baseSchedule2 = parseDoctorWorkingHours(assignmentWorkingHours, dayName);
      } else {
        const assignment = await DoctorAssignment.findOne({ doctorId, locationId, isActive: true });
        baseSchedule2 = parseDoctorWorkingHours(assignment?.workingHours, dayName);
      }
      const start = override.effectiveStartTime || baseSchedule2.dayStartTime || "09:00";
      const end = override.effectiveEndTime || baseSchedule2.dayEndTime || "17:00";
      return {
        isWorkingDay: true,
        intervals: [{ start, end }],
        workingHoursLabel: `${start} - ${end}${override.reason ? ` (${override.reason})` : ""}`,
        dayStartTime: start,
        dayEndTime: end,
        overrideActive: true,
        overrideStatus: override.status,
        overrideReason: override.reason || void 0
      };
    }
  }
  let baseSchedule;
  if (assignmentWorkingHours !== void 0) {
    baseSchedule = parseDoctorWorkingHours(assignmentWorkingHours, dayName);
  } else {
    const assignment = await DoctorAssignment.findOne({ doctorId, locationId, isActive: true });
    baseSchedule = parseDoctorWorkingHours(assignment?.workingHours, dayName);
  }
  return {
    ...baseSchedule,
    overrideActive: false
  };
}
function parseDoctorWorkingHours(workingHoursRaw, dayName) {
  const defaultSchedule = {
    isWorkingDay: dayName.toLowerCase() !== "sunday",
    intervals: [{ start: "09:00", end: "17:00" }],
    workingHoursLabel: "09:00 - 17:00",
    dayStartTime: "09:00",
    dayEndTime: "17:00"
  };
  if (!workingHoursRaw) return defaultSchedule;
  try {
    let parsed = workingHoursRaw;
    if (typeof workingHoursRaw === "string") {
      const trimmed = workingHoursRaw.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        parsed = JSON.parse(trimmed);
      } else {
        const parts2 = trimmed.split(/[-–—to]/i).map((s) => s.trim()).filter(Boolean);
        if (parts2.length >= 2) {
          const start = parts2[0];
          const end = parts2[1];
          return {
            isWorkingDay: dayName.toLowerCase() !== "sunday",
            intervals: [{ start, end }],
            workingHoursLabel: `${start} - ${end}`,
            dayStartTime: start,
            dayEndTime: end
          };
        }
        return defaultSchedule;
      }
    }
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return defaultSchedule;
      const intervals = parsed.map((item) => ({
        start: item.start || "09:00",
        end: item.end || "17:00"
      }));
      return {
        isWorkingDay: dayName.toLowerCase() !== "sunday",
        intervals,
        workingHoursLabel: intervals.map((i) => `${i.start} - ${i.end}`).join(", "),
        dayStartTime: intervals[0].start,
        dayEndTime: intervals[intervals.length - 1].end
      };
    }
    if (typeof parsed === "object" && parsed !== null) {
      const lowerKey = Object.keys(parsed).find((k) => k.toLowerCase() === dayName.toLowerCase());
      const dayData = lowerKey ? parsed[lowerKey] : parsed.all || parsed.daily || null;
      if (!dayData) {
        return {
          isWorkingDay: false,
          intervals: [],
          workingHoursLabel: "Closed / Off",
          dayStartTime: "09:00",
          dayEndTime: "17:00"
        };
      }
      if (Array.isArray(dayData)) {
        if (dayData.length === 0) {
          return {
            isWorkingDay: false,
            intervals: [],
            workingHoursLabel: "Closed / Off",
            dayStartTime: "09:00",
            dayEndTime: "17:00"
          };
        }
        const intervals = dayData.map((item) => ({
          start: item.start || "09:00",
          end: item.end || "17:00"
        }));
        return {
          isWorkingDay: true,
          intervals,
          workingHoursLabel: intervals.map((i) => `${i.start} - ${i.end}`).join(", "),
          dayStartTime: intervals[0].start,
          dayEndTime: intervals[intervals.length - 1].end
        };
      }
      if (typeof dayData === "object" && dayData.start && dayData.end) {
        return {
          isWorkingDay: true,
          intervals: [{ start: dayData.start, end: dayData.end }],
          workingHoursLabel: `${dayData.start} - ${dayData.end}`,
          dayStartTime: dayData.start,
          dayEndTime: dayData.end
        };
      }
    }
    return defaultSchedule;
  } catch {
    return defaultSchedule;
  }
}

// services/AppointmentService.ts
init_publicTracker();
init_locationTime();
var AppointmentDomainError = class extends Error {
  statusCode;
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "AppointmentDomainError";
    this.statusCode = statusCode;
  }
};
async function validateAppointmentAvailability(actor, input, assignment, excludeAppointmentId) {
  const { doctorId, locationId, appointmentTime, duration } = input;
  const requestedDate = new Date(appointmentTime);
  if (isNaN(requestedDate.getTime())) {
    throw new AppointmentDomainError("Invalid appointment time format", 400);
  }
  const now = /* @__PURE__ */ new Date();
  const timezone = await getLocationTimezone(locationId);
  const bookingDateKey = locationDateKey(requestedDate, timezone);
  const todayKey = locationDateKey(now, timezone);
  const isStaffRole = ["receptionist", "admin", "doctor", "location_manager", "root"].includes(actor.role);
  const isWalkIn = input.appointmentType === "walk-in";
  if (requestedDate.getTime() < now.getTime() - 5 * 60 * 1e3) {
    const isSameDay = bookingDateKey === todayKey;
    if (!isStaffRole && !input.forceBooking && !isWalkIn || !isSameDay) {
      throw new AppointmentDomainError("Cannot book appointments in the past", 400);
    }
  }
  const effectiveSchedule = await getEffectiveDoctorSchedule(
    doctorId,
    locationId,
    requestedDate,
    assignment?.workingHours,
    timezone
  );
  const isHoliday = effectiveSchedule.overrideActive && effectiveSchedule.overrideStatus === "unavailable";
  if (isHoliday) {
    if (!input.forceBooking) {
      const reason = effectiveSchedule.overrideReason ? `: ${effectiveSchedule.overrideReason}` : "";
      throw new AppointmentDomainError(`Doctor is on holiday / leave on the selected date${reason}`, 400);
    }
  } else if (!effectiveSchedule.isWorkingDay || effectiveSchedule.intervals.length === 0) {
    if (!input.forceBooking && !isStaffRole && !isWalkIn && process.env.NODE_ENV !== "test") {
      const reason = effectiveSchedule.overrideReason ? `: ${effectiveSchedule.overrideReason}` : "";
      throw new AppointmentDomainError(`Doctor is not available on the selected date${reason}`, 400);
    }
  }
  const mode = assignment?.bookingMode;
  const isSequentialQueue = mode ? mode === "sequential_queue" : true;
  const slotDuration = duration || assignment?.appointmentDuration || 15;
  if (!isSequentialQueue) {
    const reqMinutes = locationClockMinutes(requestedDate, timezone);
    const isWithinWorkingHours = effectiveSchedule.intervals.some((interval2) => {
      const [startH, startM] = interval2.start.split(":").map(Number);
      const [endH, endM] = interval2.end.split(":").map(Number);
      const startMinutes = (startH || 0) * 60 + (startM || 0);
      const endMinutes = (endH || 0) * 60 + (endM || 0);
      return reqMinutes >= startMinutes && reqMinutes + slotDuration <= endMinutes;
    });
    if (!isWithinWorkingHours) {
      throw new AppointmentDomainError(
        `Requested appointment time is outside practitioner working hours (${effectiveSchedule.workingHoursLabel})`,
        400
      );
    }
  }
  const isBookingToday = bookingDateKey === todayKey;
  if (isBookingToday) {
    const [endH, endM] = (effectiveSchedule.dayEndTime || "17:00").split(":").map(Number);
    const closingMinutes = (endH || 0) * 60 + (endM || 0);
    const currentMinutes = locationClockMinutes(now, timezone);
    const remainingOperatingMinutes = closingMinutes - currentMinutes;
    if (remainingOperatingMinutes <= 0 && !input.forceBooking && !isStaffRole && process.env.NODE_ENV !== "test") {
      throw new AppointmentDomainError(
        `Doctor's working hours have already ended for today (${effectiveSchedule.dayEndTime})`,
        400
      );
    }
    const { start: startOfToday, end: endOfToday } = locationDayRange(todayKey, timezone);
    const { getAdaptiveConsultationDuration: getAdaptiveConsultationDuration2 } = await Promise.resolve().then(() => (init_queue(), queue_exports));
    const { duration: effectiveDuration } = await getAdaptiveConsultationDuration2(
      locationId,
      doctorId,
      startOfToday,
      endOfToday,
      slotDuration
    );
    const activeWaitingPatients = await Appointment.countDocuments({
      locationId,
      doctorId,
      appointmentTime: { $gte: startOfToday, $lte: endOfToday },
      status: { $in: ["pending", "confirmed", "checked-in", "in-consultation"] },
      ...excludeAppointmentId ? { _id: { $ne: excludeAppointmentId } } : {}
    });
    const estimatedQueueTime = activeWaitingPatients * effectiveDuration;
    const isOnlineBooking = input.appointmentType === "online";
    const safetyBuffer = isOnlineBooking ? assignment.onlineBookingSafetyBuffer ?? 30 : 0;
    const allowedOperatingMinutes = closingMinutes - safetyBuffer - currentMinutes;
    if (estimatedQueueTime + effectiveDuration > allowedOperatingMinutes && !input.forceBooking) {
      if (isOnlineBooking && estimatedQueueTime + effectiveDuration <= remainingOperatingMinutes) {
        throw new AppointmentDomainError(
          `Same-day online booking is closed for today due to queue backlog. A ${safetyBuffer}-minute safety buffer is enforced before shift end (${effectiveSchedule.dayEndTime}). Walk-in registration at the location may still be accepted.`,
          409
        );
      }
      throw new AppointmentDomainError(
        `Doctor capacity reached for today. Current queue backlog (${activeWaitingPatients} patients, ~${estimatedQueueTime} mins) exceeds available capacity (operating hours finish at ${effectiveSchedule.dayEndTime}).`,
        409
      );
    }
  }
  return { isSequentialQueue, requestedDate, slotDuration, timezone };
}
var AppointmentService = class {
  /**
   * Orchestrates the complete appointment booking workflow:
   * 1. Doctor assignment & booking mode validation
   * 2. Slot lock acquisition & validation
   * 3. Patient identity resolution (self, dependent, existing walk-in, or new profile)
   * 4. Duplicate booking guard & time-slot collision check
   * 5. Atomic sequential daily token counter generation
   * 6. Appointment record persistence
   * 7. Auto invoice creation for consultation fees
   * 8. Audit logging & async notification dispatch
   */
  async book(actor, input, effectiveOrgId, options = {}) {
    if (!actor.id && !(options.anonymousWalkIn && actor.role === "guest" && actor.bookingPatientId && input.appointmentType === "walk-in" && !input.patientDetails && !input.followUpForAppointmentId)) throw new AppointmentDomainError("A valid booking actor is required", 403);
    if (options.anonymousWalkIn && (actor.id || actor.role !== "guest" || !actor.bookingPatientId || input.appointmentType !== "walk-in")) throw new AppointmentDomainError("Invalid anonymous walk-in command", 403);
    let { doctorId } = input;
    const {
      locationId,
      appointmentTime,
      appointmentType,
      notes,
      patientId,
      patientDetails,
      followUpForAppointmentId,
      lockId,
      reasonForVisit,
      duration,
      payAtLocation
    } = input;
    if (!locationId || !doctorId || !appointmentTime || !appointmentType) {
      throw new AppointmentDomainError("locationId, doctorId, appointmentTime, and appointmentType are required", 400);
    }
    const orgId = effectiveOrgId || actor.organizationId;
    if (actor.role !== "root" && !orgId) {
      throw new AppointmentDomainError("Organization context is required to book an appointment", 403);
    }
    if (!await canCreateLocationBooking(locationId, ["patient", "family_member", "guest"].includes(actor.role))) {
      throw new AppointmentDomainError("Online booking is temporarily unavailable. Please contact reception directly.", 409);
    }
    const locationQuery = mongoose61.Types.ObjectId.isValid(locationId) ? { $in: [locationId, new mongoose61.Types.ObjectId(locationId)] } : locationId;
    let assignment = await DoctorAssignment.findOne({
      doctorId: mongoose61.Types.ObjectId.isValid(doctorId) ? { $in: [doctorId, new mongoose61.Types.ObjectId(doctorId)] } : doctorId,
      locationId: locationQuery
    });
    if (!assignment && mongoose61.Types.ObjectId.isValid(doctorId)) {
      const docProfile = await Doctor.findOne({
        $or: [{ _id: doctorId }, { userId: doctorId }]
      });
      if (docProfile) {
        const candidateIds = [docProfile.userId, docProfile._id].filter(Boolean);
        assignment = await DoctorAssignment.findOne({
          doctorId: { $in: candidateIds },
          locationId: locationQuery
        });
      }
    }
    if (!assignment) {
      throw new AppointmentDomainError("Doctor is not assigned to the selected location", 400);
    }
    doctorId = assignment.doctorId.toString();
    if (assignment.isActive === false || orgId && (!assignment.organizationId || assignment.organizationId.toString() !== orgId.toString()) || !await isActiveBookingDoctor(doctorId)) {
      throw new AppointmentDomainError("Doctor is unavailable for new appointments at this location", 409);
    }
    if (assignment.paymentRequired) {
      const organization = await Organization.findById(assignment.organizationId || orgId).select("countryCode currency").lean();
      if (!organization || organization.countryCode && organization.countryCode !== "IN" || organization.currency && organization.currency !== "INR") {
        throw new AppointmentDomainError("Online prepayment is unavailable for this location; use payment at reception", 409);
      }
    }
    const { isSequentialQueue, timezone: bookingTimezone } = await validateAppointmentAvailability(actor, { ...input, doctorId }, assignment);
    let lockValidation = { valid: true };
    if (!isSequentialQueue) {
      if (!actor.id) throw new AppointmentDomainError("This clinician requires a scheduled booking; contact reception", 409);
      lockValidation = await validateSlotLockForBooking(
        locationId,
        doctorId,
        appointmentTime,
        actor.id,
        lockId
      );
      if (!lockValidation.valid) {
        throw new AppointmentDomainError(lockValidation.message || "Slot is unavailable", 409);
      }
    }
    const { booking, lockKey, appointmentId, trackerToken } = await withTransaction(async (session) => {
      const option = session ? { session } : {};
      let finalPatientId;
      if (actor.role === "patient" || actor.role === "guest") {
        if (actor.role === "guest" && (!actor.bookingPatientId || patientId && patientId !== actor.bookingPatientId)) throw new AppointmentDomainError("This booking session belongs to another patient", 403);
        const targetPatientId = actor.role === "guest" ? actor.bookingPatientId || patientId : patientId;
        if (targetPatientId) {
          let isAuthorized = actor.role === "guest" ? !!await Patient.exists({ _id: targetPatientId }).setOptions({ bypassTenantFilter: true }).session(session || null) : !!await FamilyRelationship.findOne(
            { userId: actor.id, patientId: targetPatientId, status: "active" },
            null,
            option
          );
          if (!isAuthorized) {
            const selfPatient = await Patient.findById(targetPatientId, null, option).setOptions({ bypassTenantFilter: true });
            if (selfPatient && (String(selfPatient.userId || "") === String(actor.id) || String(selfPatient._id || "") === String(actor.id))) {
              isAuthorized = true;
            }
          }
          if (!isAuthorized) {
            throw new AppointmentDomainError("Unauthorized: You do not have permission to book for this patient", 403);
          }
          finalPatientId = targetPatientId;
        } else {
          let selfRel = await FamilyRelationship.findOne({ userId: actor.id, relationship: "self", status: "active" }, null, option);
          let patient = selfRel ? await Patient.findById(selfRel.patientId, null, option).setOptions({ bypassTenantFilter: true }) : await Patient.findOne({ userId: actor.id }, null, option).setOptions({ bypassTenantFilter: true });
          if (!patient) {
            const loggedUser = await User.findById(actor.id, null, option);
            patient = await createWithSession(Patient, {
              userId: loggedUser?._id || actor.id,
              name: loggedUser?.name || "Patient",
              phone: loggedUser?.phone || null,
              email: loggedUser?.email || null,
              accountType: "self",
              createdBy: actor.id,
              organizationId: orgId
            }, session);
            await createWithSession(FamilyRelationship, {
              userId: actor.id,
              patientId: patient._id,
              relationship: "self",
              status: "active"
            }, session);
          }
          if (!patient.organizationId && orgId) {
            patient.organizationId = orgId;
            await patient.save(option);
          }
          if (patient.userId && orgId) {
            const memberExists = await OrgMember.findOne({ userId: patient.userId, organizationId: orgId }, null, option);
            if (!memberExists) {
              await createWithSession(OrgMember, { userId: patient.userId, organizationId: orgId, role: "patient" }, session);
            }
          }
          finalPatientId = patient.id;
        }
      } else {
        if (patientId) {
          const patient = await Patient.findById(patientId, null, option).setOptions({ bypassTenantFilter: true });
          if (!patient) throw new AppointmentDomainError("Patient profile not found", 404);
          if (patient.organizationId && orgId && patient.organizationId.toString() !== orgId.toString()) {
            const { getOrganizationPatient: getOrganizationPatient2 } = await Promise.resolve().then(() => (init_PatientRecordAccessService(), PatientRecordAccessService_exports));
            if (!await getOrganizationPatient2(patient.id, orgId)) throw new AppointmentDomainError("Patient profile not found", 404);
          }
          if (!patient.organizationId && orgId) {
            patient.organizationId = orgId;
            await patient.save(option);
          }
          finalPatientId = patient.id;
          if (orgId && patient.userId) {
            const memberExists = await OrgMember.findOne({ userId: patient.userId, organizationId: orgId }, null, option);
            if (!memberExists) {
              await createWithSession(OrgMember, { userId: patient.userId, organizationId: orgId, role: "patient" }, session);
            }
          }
        } else if (patientDetails) {
          const { name, dob, gender, phone, email, address, allergies, conditions, medicalNotes } = patientDetails;
          if (!name || !dob || !gender) {
            throw new AppointmentDomainError("name, dob, and gender are required for new patient registration", 400);
          }
          const patientProfile = await createWithSession(Patient, {
            name: name.trim(),
            phone: phone?.trim() || null,
            email: email?.trim().toLowerCase() || null,
            accountType: "walkin",
            createdBy: actor.id,
            organizationId: orgId,
            personalVaultId: `pvt_${Date.now()}_${Math.floor(1e3 + Math.random() * 9e3)}`,
            dob: new Date(dob),
            gender,
            address: address || null,
            allergies: allergies || [],
            conditions: conditions || [],
            medicalNotes: medicalNotes || null
          }, session);
          finalPatientId = patientProfile.id;
        } else {
          throw new AppointmentDomainError("Either patientId or patientDetails is required for staff booking", 400);
        }
      }
      const requestedDate = new Date(appointmentTime);
      const existingDuplicate = await Appointment.findOne({
        patientId: finalPatientId,
        doctorId,
        locationId,
        appointmentTime: requestedDate,
        status: { $in: ["pending", "pending_payment", "confirmed", "checked-in", "in-consultation"] }
      }, null, option);
      if (existingDuplicate) {
        throw new AppointmentDomainError("An active appointment for this patient with this practitioner at the selected time already exists", 409);
      }
      const currentBookingMode = assignment?.bookingMode || "sequential_queue";
      if (currentBookingMode === "time_slot") {
        const slotCollision = await Appointment.findOne({
          locationId,
          doctorId,
          appointmentTime: requestedDate,
          bookingMode: "time_slot",
          status: { $in: ["pending", "pending_payment", "confirmed", "checked-in", "in-consultation"] }
        }, null, option);
        if (slotCollision) {
          throw new AppointmentDomainError("This consultation time slot has already been booked by another patient", 409);
        }
      }
      const dateStr = locationDateKey(requestedDate, bookingTimezone);
      const counterKey = `token_${locationId}_${doctorId}_${dateStr}`;
      const tokenNumber = await getNextAtomicSequence(counterKey, session);
      const maxTokens = assignment?.maxDailyTokens;
      if (maxTokens && tokenNumber > maxTokens) {
        throw new AppointmentDomainError(`Daily token limit of ${maxTokens} reached for this practitioner.`, 400);
      }
      const queuePosition = tokenNumber;
      const initialStatus = options.anonymousWalkIn ? "checked-in" : actor.role === "patient" ? "pending" : "confirmed";
      const slotDuration = duration || assignment?.appointmentDuration || 15;
      const visitReason = reasonForVisit || (followUpForAppointmentId ? "follow_up" : "new_consultation");
      const assignmentFeeType = assignment?.feeType || "fixed";
      let isPaymentRequired = assignment?.paymentRequired === true;
      let initialPaymentStatus = isPaymentRequired ? "pending" : payAtLocation ? "pay_at_location" : "not_required";
      let apptPaymentAmount = assignment?.fees ?? 500;
      if (assignmentFeeType === "post_consultation") {
        isPaymentRequired = false;
        initialPaymentStatus = "pay_at_location";
        apptPaymentAmount = 0;
      } else if (assignmentFeeType === "free") {
        isPaymentRequired = false;
        initialPaymentStatus = "not_required";
        apptPaymentAmount = 0;
      }
      const trackerCapability = createTrackerCapability();
      const appointment = await createWithSession(Appointment, {
        organizationId: orgId || null,
        locationId,
        doctorId,
        patientId: finalPatientId,
        bookedByUserId: actor.id,
        trackerTokenHash: trackerCapability.hash,
        trackerTokenCiphertext: trackerCapability.token,
        trackerTokenExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1e3),
        appointmentTime: requestedDate,
        appointmentType,
        status: isPaymentRequired ? "pending_payment" : initialStatus,
        paymentStatus: initialPaymentStatus,
        feeType: assignmentFeeType,
        paymentAmount: apptPaymentAmount,
        bookingSource: actor.role === "patient" ? "patient_portal" : "staff",
        tokenNumber,
        queuePosition,
        bookingMode: currentBookingMode,
        duration: slotDuration,
        reasonForVisit: visitReason,
        notes: notes || null
      }, session);
      if (followUpForAppointmentId) {
        if (!mongoose61.Types.ObjectId.isValid(followUpForAppointmentId)) {
          throw new AppointmentDomainError("Invalid followUpForAppointmentId", 400);
        }
        const parentAppt = await Appointment.findOne({
          _id: followUpForAppointmentId,
          patientId: finalPatientId,
          organizationId: orgId
        }, null, option);
        if (!parentAppt || parentAppt.status !== "completed") throw new AppointmentDomainError("Choose a completed source visit in this organization; booking cannot complete a clinical visit", 409);
        if (!["patient", "family_member", "guest", "root"].includes(actor.role)) {
          const grants = await resolveStaffLocationGrant(actor.id, String(orgId), actor.role, true);
          if (grants && !grants.includes(String(parentAppt.locationId))) throw new AppointmentDomainError("The source visit is outside your authorized branches", 403);
        }
        const activeFollowUp = await Appointment.exists({
          organizationId: orgId,
          patientId: finalPatientId,
          followUpForAppointmentId,
          _id: { $ne: appointment._id },
          status: { $nin: ["cancelled", "completed", "no-show"] }
        });
        if (activeFollowUp) throw new AppointmentDomainError("A follow-up booking already exists for this recommendation. Review it before creating another.", 409);
        appointment.followUpForAppointmentId = parentAppt._id;
        appointment.followUpConfirmationEvidence = "explicit_booking";
        await appointment.save(option);
        parentAppt.followUpAppointmentId = appointment._id;
        parentAppt.followUpWorkflow = "booked";
        await parentAppt.save(option);
      }
      if (assignmentFeeType === "fixed" && assignment?.fees && assignment.fees > 0) {
        const doctorUser = await User.findById(doctorId, null, option);
        const doctorName = doctorUser?.name ? `Dr. ${doctorUser.name}` : `Dr. ${doctorId}`;
        const invoiceNumber = await generateLocationInvoiceNumber(locationId, Number(dateStr.slice(0, 4)));
        let is7DayCourtesyFollowUp = false;
        let courtesyReason = "";
        if (followUpForAppointmentId) {
          const parent = await Appointment.findById(followUpForAppointmentId, null, option);
          if (parent) {
            const parentDate = new Date(parent.appointmentTime);
            const daysDiff = (requestedDate.getTime() - parentDate.getTime()) / (1e3 * 60 * 60 * 24);
            if (daysDiff >= 0 && daysDiff <= 7) {
              is7DayCourtesyFollowUp = true;
              courtesyReason = `7-Day Follow-Up Courtesy Waiver (Parent Token #${parent.tokenNumber})`;
            }
          }
        } else if (visitReason === "follow_up") {
          const sevenDaysAgo = new Date(requestedDate);
          sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
          const recentAppt = await Appointment.findOne({
            patientId: finalPatientId,
            locationId,
            doctorId,
            status: "completed",
            appointmentTime: { $gte: sevenDaysAgo, $lte: requestedDate }
          }, null, option);
          if (recentAppt) {
            is7DayCourtesyFollowUp = true;
            courtesyReason = `7-Day Follow-Up Courtesy Waiver (Recent Token #${recentAppt.tokenNumber})`;
          }
        }
        if (is7DayCourtesyFollowUp) {
          await createWithSession(Invoice, {
            clinicalChargeVersion: 1,
            invoiceNumber,
            organizationId: orgId || null,
            patientId: finalPatientId,
            appointmentId: appointment._id,
            locationId,
            doctorId,
            items: [
              {
                description: `Consultation Fee - ${doctorName} (${courtesyReason})`,
                amount: 0,
                quantity: 1
              }
            ],
            subtotal: 0,
            tax: 0,
            discount: 0,
            totalAmount: 0,
            status: "paid",
            paymentMethod: "courtesy_waiver",
            paymentDate: /* @__PURE__ */ new Date()
          }, session);
          appointment.paymentStatus = "not_required";
          appointment.paymentAmount = 0;
          if (appointment.status === "pending_payment") appointment.status = initialStatus;
          await appointment.save(option);
        } else {
          await createWithSession(Invoice, {
            clinicalChargeVersion: 1,
            invoiceNumber,
            organizationId: orgId || null,
            patientId: finalPatientId,
            appointmentId: appointment._id,
            locationId,
            doctorId,
            items: [
              {
                description: `Consultation Fee - ${doctorName}`,
                amount: assignment.fees,
                quantity: 1
              }
            ],
            subtotal: assignment.fees,
            tax: 0,
            discount: 0,
            totalAmount: assignment.fees,
            status: "unpaid"
          }, session);
        }
      }
      await createWithSession(AuditLog, {
        userId: actor.id,
        organizationId: orgId || void 0,
        action: "APPOINTMENT_CREATE",
        targetId: appointment._id,
        targetModel: "Appointment",
        details: { tokenNumber, appointmentTime, locationId, doctorId }
      }, session);
      await publishAppointmentCommunication(appointment, { action: "booked", actorId: ["patient", "family_member", "guest"].includes(actor.role) ? void 0 : actor.id }, session);
      if (doctorId !== actor.id) await eventBus.publishDurable({
        eventId: `booking:doctor:${appointment._id}`,
        eventType: EVENT_TYPES.PATIENT_APPOINTMENT_BOOKED,
        category: "clinical",
        organizationId: orgId,
        targetUserId: doctorId,
        title: "New appointment booked",
        message: "A new appointment was added to your schedule.",
        severity: "info",
        actionUrl: "/dashboard/appointments",
        metadata: { appointmentId: String(appointment._id), locationId }
      }, session);
      return {
        booking: {
          id: appointment.id,
          locationId,
          doctorId,
          patientId: finalPatientId,
          appointmentTime: appointment.appointmentTime,
          appointmentType: appointment.appointmentType,
          status: appointment.status,
          paymentStatus: appointment.paymentStatus,
          paymentAmount: appointment.paymentAmount,
          bookingMode: appointment.bookingMode,
          tokenNumber: appointment.tokenNumber,
          queuePosition: appointment.queuePosition,
          duration: appointment.duration,
          reasonForVisit: appointment.reasonForVisit,
          notes: appointment.notes,
          trackerToken: trackerCapability.token,
          createdAt: appointment.createdAt
        },
        lockKey: lockValidation.lockKey,
        appointmentId: appointment._id,
        trackerToken: trackerCapability.token
      };
    });
    const afterCommit = async () => {
      if (lockKey) await forceReleaseSlotLock(lockKey).catch((err) => console.warn("Slot lock release failed:", safeError(err)));
      try {
        broadcastQueueUpdate(locationId, { type: "QUEUE_UPDATED", data: { locationId, appointmentId: String(appointmentId) }, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
      } catch (err) {
        console.warn("Booking queue broadcast skipped:", safeError(err));
      }
    };
    if (options.deferAfterCommit) options.deferAfterCommit(afterCommit);
    else afterCommit().catch((err) => console.warn("Booking follow-up failed:", safeError(err)));
    return booking;
  }
};
var appointmentService = new AppointmentService();

// services/AppointmentRefundService.ts
init_transaction();
init_eventBus();
init_types();
async function onlineRefundSource(appointment, invoice) {
  if (!invoice || invoice.status !== "paid" || invoice.currency !== "INR" || String(invoice.patientId) !== String(appointment.patientId?._id || appointment.patientId) || String(invoice.locationId) !== String(appointment.locationId?._id || appointment.locationId)) return null;
  const receipt = invoice.payments?.length === 1 ? invoice.payments[0] : null;
  const captures = await AppointmentPayment.find({
    status: "captured",
    paymentMethod: "razorpay",
    $or: [{ appointmentId: appointment._id }, { invoiceId: invoice._id }]
  }).limit(2);
  const capture = captures.length === 1 ? captures[0] : null;
  const paymentId = capture?.razorpayPaymentId || (captures.length === 0 ? receipt?.referenceNumber : "") || "";
  const amount = Number(capture?.amount ?? receipt?.amount ?? 0);
  const valid = capture ? capture.currency === "INR" && String(capture.patientId) === String(invoice.patientId) && (!invoice.payments?.length || receipt?.paymentMethod === "online" && receipt.referenceNumber === paymentId) : captures.length === 0 && receipt?.paymentMethod === "online";
  return valid && /^pay_[A-Za-z0-9]+$/.test(paymentId) && Number.isFinite(amount) && amount > 0 && Math.round(amount * 100) === Math.round(Number(invoice.amountPaid) * 100) ? { paymentId, amount, currency: "INR" } : null;
}

// services/disruptionService.ts
init_AuditLog();

// services/CareFollowUpService.ts
init_Appointment();
init_PatientRelationship();
init_CrmTaskService();
init_locationTime();
init_Task();
init_CrmActivity();
async function recordAppointmentRecovery(appointment, actorId, outcome) {
  const ref2 = (value) => value?._id?.toString() || value?.toString();
  const organizationId = ref2(appointment.organizationId), locationId = ref2(appointment.locationId), patientId = ref2(appointment.patientId);
  if (!organizationId || !locationId || !patientId) throw new AppointmentDomainError("Appointment context requires administrative review", 409);
  const relationship = await PatientRelationship.findOne({ organizationId, patientId, locationId, status: "active" }).select("ownerId").lean();
  return createCrmTask({
    organizationId,
    locationId,
    patientId,
    appointmentId: appointment.id || ref2(appointment._id),
    actorId,
    kind: "crm_recovery",
    title: outcome === "disruption" ? "Review doctor disruption recovery" : outcome === "no-show" ? "Review missed appointment" : "Review cancelled appointment",
    dueDate: /* @__PURE__ */ new Date(),
    assignedTo: relationship?.ownerId?.toString(),
    dedupeKey: `recovery:${appointment.id || ref2(appointment._id)}:${outcome}`
  });
}
async function resolveAppointmentRecovery(appointment, actorId, outcome, resultAppointmentId) {
  const tasks = await TaskModel.find({ organizationId: appointment.organizationId, appointmentId: appointment._id, kind: "crm_recovery", status: { $ne: "completed" } }).select("_id revision locationId patientId").limit(21);
  if (tasks.length > 20) throw new AppointmentDomainError("Recovery task history requires administrative review", 409);
  for (const task of tasks) {
    const changed = await TaskModel.updateOne({ _id: task._id, organizationId: appointment.organizationId, revision: task.revision }, { $set: { status: "completed", outcome, completedAt: /* @__PURE__ */ new Date(), ...resultAppointmentId ? { resultAppointmentId } : {} }, $unset: { snoozedUntil: 1 }, $inc: { revision: 1 } });
    if (changed.modifiedCount !== 1) throw new AppointmentDomainError("Recovery task changed during appointment recovery", 409);
    await CrmActivity.create({ organizationId: appointment.organizationId, locationId: task.locationId, patientId: task.patientId, appointmentId: appointment._id, taskId: task._id, actorId, kind: "appointment_recovery_resolved", outcome });
    await publishCrmTaskEvent(await TaskModel.findById(task._id), actorId);
  }
}

// services/disruptionService.ts
init_User();
init_websocket();

// services/payment/PaymentProvider.ts
init_safeError();
var LiveRazorpayPaymentProvider = class {
  name = "RazorpayPaymentGateway";
  async createPaymentLink(request) {
    if (process.env.NODE_ENV === "test") {
      const paymentLinkId2 = `paylink_${Math.random().toString(36).substr(2, 9)}`;
      return {
        paymentLinkId: paymentLinkId2,
        checkoutUrl: `https://pay.ekavyu.health/checkout/${paymentLinkId2}`,
        status: "created",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1e3).toISOString()
      };
    }
    try {
      const { keyId, keySecret } = await razorpayService.getCredentials();
      const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
      const payload = {
        amount: Math.round(request.amount * 100),
        currency: request.currency || "INR",
        accept_partial: false,
        description: request.description || `Medical Invoice #${request.invoiceId}`,
        customer: {
          email: request.customerEmail
        },
        notify: {
          sms: true,
          email: !!request.customerEmail
        },
        reminder_enable: true,
        notes: {
          invoiceId: request.invoiceId
        }
      };
      const response = await fetch("https://api.razorpay.com/v1/payment_links", {
        method: "POST",
        headers: {
          "Authorization": `Basic ${auth}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(1e4),
        redirect: "error"
      });
      if (response.ok) {
        const data = await response.json();
        return {
          paymentLinkId: data.id,
          checkoutUrl: data.short_url,
          status: "created",
          expiresAt: data.expire_by ? new Date(data.expire_by * 1e3).toISOString() : new Date(Date.now() + 24 * 60 * 60 * 1e3).toISOString()
        };
      } else {
        throw new Error(`Razorpay API responded with status ${response.status}`);
      }
    } catch (err) {
      console.error("[PaymentProvider] Live Razorpay payment link generation failed", safeError(err));
      if (process.env.NODE_ENV === "production") {
        throw new Error("Failed to generate online payment link: Payment gateway unavailable");
      }
    }
    const paymentLinkId = `paylink_dev_${Math.random().toString(36).substr(2, 9)}`;
    return {
      paymentLinkId,
      checkoutUrl: `https://pay.ekavyu.health/checkout/${paymentLinkId}`,
      status: "created",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1e3).toISOString()
    };
  }
  async processRefund(request) {
    if (process.env.NODE_ENV === "test") {
      return {
        refundId: `rfnd_${Math.random().toString(36).substr(2, 9)}`,
        status: "processed",
        amount: request.amount
      };
    }
    try {
      const refundResult = await razorpayService.processRefund({
        paymentId: request.transactionId,
        amount: request.amount,
        notes: { reason: request.reason || "Patient Refund" }
      });
      return {
        refundId: refundResult.id || "",
        status: refundResult.status === "processed" && refundResult.id ? "processed" : refundResult.status === "failed" ? "failed" : "pending",
        amount: request.amount
      };
    } catch (err) {
      console.error("[PaymentProvider] Refund processing failed:", safeError(err));
      return {
        refundId: "",
        status: "failed",
        amount: request.amount
      };
    }
  }
};
var paymentProvider = new LiveRazorpayPaymentProvider();

// services/disruptionService.ts
init_transaction();
init_Counter();
init_locationTime();
function requirePendingDisruption(appointment) {
  if (appointment.status !== "disruption_triage" || appointment.triageAction !== "pending") {
    throw new AppointmentDomainError("Appointment is no longer awaiting a disruption response", 409);
  }
}
async function communicationActor(userId) {
  if (!mongoose62.Types.ObjectId.isValid(userId)) return void 0;
  const actor = await User.findById(userId).select("role").lean();
  return actor && !["patient", "family_member", "guest"].includes(actor.role) ? userId : void 0;
}
async function nextDisruptionToken(locationId, doctorId, date, start, end) {
  const key = `token_${locationId}_${doctorId}_${date}`;
  const last = await Appointment.findOne({ locationId, doctorId, appointmentTime: { $gte: start, $lte: end } }).sort({ tokenNumber: -1 }).select("tokenNumber");
  await Counter.findOneAndUpdate({ id: key }, { $max: { seq: last?.tokenNumber || 0 } }, { upsert: true });
  return getNextAtomicSequence(key);
}
var disruptionService = {
  /**
   * Orchestrates patient triage when doctor availability is disrupted.
   * - In-consultation patients are preserved and completed normally
   * - Checked-in waiting patients are flagged for immediate reception triage
   * - Confirmed/pending patients enter staff review with consent-aware durable communication
   */
  async processDoctorDisruption(params) {
    const {
      locationId,
      doctorId,
      date,
      status,
      effectiveEndTime,
      reason,
      userId,
      organizationId,
      disruptionId
    } = params;
    const timezone = await getLocationTimezone(locationId);
    const { start: startOfDay, end: endOfDay } = locationDayRange(date, timezone);
    let closingMinutes = 24 * 60;
    if (effectiveEndTime && status !== "unavailable") {
      const [endH, endM] = effectiveEndTime.split(":").map(Number);
      closingMinutes = (endH || 0) * 60 + (endM || 0);
    }
    const appointments = await Appointment.find({
      locationId,
      doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      status: { $in: ["in-consultation", "checked-in", "confirmed", "pending", "pending_payment"] }
    }).populate("locationId", "name phone organizationId").populate("doctorId", "name email").populate({
      path: "patientId",
      populate: { path: "userId", select: "name email phone" }
    });
    let inConsultationPreservedCount = 0;
    let checkedInTriageCount = 0;
    let remoteTriageCount = 0;
    const triagedAppointments = [];
    const now = /* @__PURE__ */ new Date();
    const reviewDueAt = new Date(now.getTime() + 60 * 60 * 1e3);
    for (const appt of appointments) {
      const apptDate = new Date(appt.appointmentTime);
      const apptMinutes = locationClockMinutes(apptDate, timezone);
      const isAffected = status === "unavailable" || apptMinutes >= closingMinutes;
      if (!isAffected) continue;
      if (appt.status === "in-consultation") {
        inConsultationPreservedCount++;
        continue;
      }
      if (appt.status === "checked-in") {
        const notes = appt.notes ? `${appt.notes} | [TRIAGE: Doctor unavailable - awaiting reception action]` : `[TRIAGE: Doctor unavailable - awaiting reception action]`;
        const triagedAppointment = await withClinicalTransaction(async () => {
          const claimed = await Appointment.findOneAndUpdate(
            { _id: appt._id, status: "checked-in" },
            {
              $set: {
                status: "disruption_triage",
                disruptionOriginalStatus: "checked-in",
                disruptionId,
                disruptedAt: now,
                triageAction: "pending",
                notes
              }
            },
            { returnDocument: "after" }
          ).populate("locationId", "name phone organizationId").populate("doctorId", "name email").populate({ path: "patientId", populate: { path: "userId", select: "name email phone" } });
          if (claimed) await recordAppointmentRecovery(claimed, userId, "disruption");
          return claimed;
        });
        triagedAppointment?.$session(null);
        if (!triagedAppointment) continue;
        checkedInTriageCount++;
        const patientDoc = triagedAppointment.patientId;
        triagedAppointments.push(triagedAppointment);
        continue;
      }
      if (["confirmed", "pending", "pending_payment"].includes(appt.status)) {
        const notes = appt.notes ? `${appt.notes} | [Doctor unavailable (${status}) - awaiting patient or reception action]` : `[Doctor unavailable (${status}) - awaiting patient or reception action]`;
        const triagedAppointment = await withClinicalTransaction(async () => {
          const claimed = await Appointment.findOneAndUpdate(
            { _id: appt._id, status: appt.status },
            {
              $set: {
                status: "disruption_triage",
                disruptionOriginalStatus: appt.status,
                disruptionId,
                disruptedAt: now,
                disruptionReviewDueAt: reviewDueAt,
                triageAction: "pending",
                notes
              }
            },
            { returnDocument: "after" }
          ).populate("locationId", "name phone organizationId").populate("doctorId", "name email").populate({ path: "patientId", populate: { path: "userId", select: "name email phone" } });
          if (claimed) {
            await recordAppointmentRecovery(claimed, userId, "disruption");
            await publishAppointmentCommunication(claimed, { action: "disruption", actorId: userId });
          }
          return claimed;
        });
        triagedAppointment?.$session(null);
        if (!triagedAppointment) continue;
        remoteTriageCount++;
        triagedAppointments.push(triagedAppointment);
      }
    }
    if (checkedInTriageCount > 0) {
      broadcastQueueUpdate(locationId, {
        type: "DISRUPTION_TRIAGE_REQUIRED",
        message: `${checkedInTriageCount} waiting patient(s) need immediate transfer or assistance.`,
        data: {
          title: "Urgent: Patients Require Triage",
          severity: "urgent",
          actionUrl: `/dashboard/queue`,
          locationId,
          doctorId,
          count: checkedInTriageCount
        }
      });
    }
    broadcastQueueUpdate(locationId, {
      type: "QUEUE_UPDATED",
      data: {
        locationId,
        doctorId,
        date,
        overrideStatus: status,
        checkedInTriageCount,
        remoteTriageCount,
        remoteNotifiedCount: 0,
        inConsultationPreservedCount
      },
      message: `Doctor availability modified: ${status}`,
      timestamp: now.toISOString()
    });
    await AuditLog.create({
      userId,
      organizationId: organizationId ? new mongoose62.Types.ObjectId(organizationId) : void 0,
      action: "DOCTOR_DISRUPTION_PROCESSED",
      targetId: disruptionId,
      targetModel: "DoctorDayOverride",
      details: {
        locationId,
        doctorId,
        date,
        status,
        inConsultationPreservedCount,
        checkedInTriageCount,
        remoteTriageCount,
        remoteNotifiedCount: 0,
        totalAffected: checkedInTriageCount + remoteTriageCount
      }
    });
    return {
      inConsultationPreservedCount,
      checkedInTriageCount,
      remoteTriageCount,
      remoteNotifiedCount: 0,
      triagedAppointmentsCount: triagedAppointments.length
    };
  },
  /**
   * Finds eligible replacement doctors at the same location.
   * Doctor must:
   * 1. Have active DoctorAssignment at this location
   * 2. Not be the original disrupted doctor
   * 3. Not have an 'unavailable' DoctorDayOverride on this date
   */
  async getEligibleReplacementDoctors(locationId, date, originalDoctorId) {
    const assignments = await DoctorAssignment.find({
      locationId,
      doctorId: { $ne: new mongoose62.Types.ObjectId(originalDoctorId) },
      isActive: true
    }).populate("doctorId", "name email specialization");
    const eligibleDoctors = [];
    const timezone = await getLocationTimezone(locationId);
    const { start: startOfDay, end: endOfDay } = locationDayRange(date, timezone);
    const doctorIds = assignments.flatMap((assignment) => assignment.doctorId ? [assignment.doctorId._id] : []);
    if (!doctorIds.length) return eligibleDoctors;
    const [overrides, loads] = await Promise.all([
      DoctorDayOverride.find({ locationId, doctorId: { $in: doctorIds }, date }).select("doctorId status").lean(),
      Appointment.aggregate([
        { $match: {
          locationId: new mongoose62.Types.ObjectId(locationId),
          doctorId: { $in: doctorIds },
          appointmentTime: { $gte: startOfDay, $lte: endOfDay },
          status: { $in: ["confirmed", "checked-in", "in-consultation"] }
        } },
        { $group: { _id: "$doctorId", count: { $sum: 1 } } }
      ])
    ]);
    const overrideByDoctor = new Map(overrides.map((override) => [override.doctorId.toString(), override]));
    const loadByDoctor = new Map(loads.map((load) => [load._id.toString(), load.count]));
    for (const assignment of assignments) {
      const docUser = assignment.doctorId;
      if (!docUser) continue;
      const override = overrideByDoctor.get(docUser._id.toString());
      if (override?.status === "unavailable") {
        continue;
      }
      const currentBookingsCount = loadByDoctor.get(docUser._id.toString()) || 0;
      eligibleDoctors.push({
        doctorId: docUser._id.toString(),
        name: docUser.name,
        email: docUser.email,
        specialization: docUser.specialization || "General Practice",
        fees: assignment.fees || 0,
        appointmentDuration: assignment.appointmentDuration || 15,
        bookingMode: assignment.bookingMode || "sequential_queue",
        maxDailyTokens: assignment.maxDailyTokens || null,
        currentBookingsCount,
        overrideStatus: override?.status || "available"
      });
    }
    return eligibleDoctors;
  },
  /**
   * Transfers a triaged patient to a replacement doctor.
   * Atomically assigns a new sequential token, updates invoice, notifies patient via WhatsApp, and logs audit trail.
   */
  async transferPatient(params) {
    const { appointmentId, replacementDoctorId, transferredByUserId, reason } = params;
    const { appt, locationId, previousDoctorId, previousDoctorName, targetDoctor, patientDoc, newTokenNumber } = await withClinicalTransaction(async () => {
      const appt2 = await Appointment.findById(appointmentId).populate("locationId", "name phone organizationId").populate("doctorId", "name email").populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" }
      });
      if (!appt2) {
        throw new Error("Appointment not found");
      }
      requirePendingDisruption(appt2);
      const previousDoctorId2 = appt2.doctorId?._id?.toString() || appt2.doctorId?.toString();
      const previousDoctorName2 = appt2.doctorId?.name || "Doctor";
      const previousToken = appt2.tokenNumber;
      const locationId2 = appt2.locationId?._id?.toString() || appt2.locationId?.toString();
      const isWaiting = appt2.status === "checked-in" || appt2.status === "disruption_triage";
      const targetDoctor2 = await User.findById(replacementDoctorId);
      if (!targetDoctor2) {
        throw new Error("Replacement doctor not found");
      }
      if (replacementDoctorId === previousDoctorId2) throw new AppointmentDomainError("Choose a different replacement doctor", 400);
      const replacementAssignment = await DoctorAssignment.findOne({ locationId: locationId2, doctorId: replacementDoctorId, isActive: true });
      if (!replacementAssignment || String(replacementAssignment.organizationId) !== String(appt2.organizationId || appt2.locationId?.organizationId)) {
        throw new AppointmentDomainError("Replacement doctor is not assigned to this location", 404);
      }
      await validateAppointmentAvailability({ role: "doctor" }, {
        locationId: locationId2,
        doctorId: replacementDoctorId,
        appointmentTime: new Date(appt2.appointmentTime).toISOString(),
        appointmentType: appt2.appointmentType,
        duration: appt2.duration
      }, replacementAssignment, appt2.id);
      const apptDate = new Date(appt2.appointmentTime);
      const timezone = await getLocationTimezone(locationId2);
      const { start: startOfDay, end: endOfDay } = locationDayRange(locationDateKey(apptDate, timezone), timezone);
      const newTokenNumber2 = await nextDisruptionToken(locationId2, replacementDoctorId, locationDateKey(apptDate, timezone), startOfDay, endOfDay);
      if (replacementAssignment.maxDailyTokens && newTokenNumber2 > replacementAssignment.maxDailyTokens) throw new AppointmentDomainError("Replacement doctor's daily token limit has been reached", 409);
      const claimed = await Appointment.updateOne({ _id: appt2._id, status: "disruption_triage", triageAction: "pending" }, { $set: { triageAction: "transferred" } });
      if (!claimed.modifiedCount) throw new AppointmentDomainError("Appointment was changed by another request", 409);
      let assignedQueuePosition = 1;
      if (isWaiting) {
        const existingWaiting = await Appointment.find({
          locationId: locationId2,
          doctorId: replacementDoctorId,
          appointmentTime: { $gte: startOfDay, $lte: endOfDay },
          status: { $in: ["checked-in", "confirmed", "pending"] },
          _id: { $ne: appt2._id }
        }).sort({ queuePosition: 1, tokenNumber: 1 });
        assignedQueuePosition = 1;
        for (let i = 0; i < existingWaiting.length; i++) {
          existingWaiting[i].queuePosition = i + 2;
          await existingWaiting[i].save();
        }
      } else {
        const countWaiting = await Appointment.countDocuments({
          locationId: locationId2,
          doctorId: replacementDoctorId,
          appointmentTime: { $gte: startOfDay, $lte: endOfDay },
          status: { $in: ["checked-in", "confirmed", "pending"] },
          _id: { $ne: appt2._id }
        });
        assignedQueuePosition = countWaiting + 1;
      }
      const [prevAssignment, repAssignment] = await Promise.all([
        DoctorAssignment.findOne({ doctorId: previousDoctorId2, locationId: locationId2 }),
        DoctorAssignment.findOne({ doctorId: replacementDoctorId, locationId: locationId2 })
      ]);
      const prevFee = (prevAssignment?.fees ?? prevAssignment?.consultationFee) || 0;
      const repFee = (repAssignment?.fees ?? repAssignment?.consultationFee) || 0;
      const feeVariance = repFee - prevFee;
      let feeResolution = "exact_match";
      if (feeVariance > 0) {
        feeResolution = "waived_courtesy";
      } else if (feeVariance < 0) {
        feeResolution = "partial_refund";
      }
      appt2.originalDoctorId = new mongoose62.Types.ObjectId(previousDoctorId2);
      appt2.originalTokenNumber = previousToken;
      appt2.doctorId = new mongoose62.Types.ObjectId(replacementDoctorId);
      appt2.bookingMode = replacementAssignment.bookingMode;
      appt2.tokenNumber = newTokenNumber2;
      appt2.queuePosition = assignedQueuePosition;
      appt2.transferredAt = /* @__PURE__ */ new Date();
      appt2.transferredBy = new mongoose62.Types.ObjectId(transferredByUserId);
      appt2.triageAction = "transferred";
      appt2.status = isWaiting ? "checked-in" : appt2.paymentStatus === "pending" ? "pending_payment" : "confirmed";
      appt2.feeVariance = feeVariance;
      appt2.feeResolution = feeResolution;
      appt2.notes = appt2.notes ? `${appt2.notes} | [PRIORITY TRANSFER: Next up for Dr. ${targetDoctor2.name} (transferred from Dr. ${previousDoctorName2}): ${reason || "Disruption reassignment"}]` : `[PRIORITY TRANSFER: Next up for Dr. ${targetDoctor2.name} (transferred from Dr. ${previousDoctorName2}): ${reason || "Disruption reassignment"}]`;
      await appt2.save();
      await resolveAppointmentRecovery(appt2, transferredByUserId, "transferred", appt2.id);
      await publishAppointmentCommunication(appt2, { action: "rescheduled", actorId: await communicationActor(transferredByUserId) });
      const feeNote = feeVariance > 0 ? ` | Disruption Courtesy: Original fee \u20B9${prevFee} honored (\u20B9${feeVariance} difference absorbed by location)` : feeVariance < 0 ? ` | Disruption Reassignment: Original fee \u20B9${prevFee} vs Replacement fee \u20B9${repFee}` : "";
      await Invoice.updateMany(
        { appointmentId: appt2._id },
        {
          $set: {
            doctorId: new mongoose62.Types.ObjectId(replacementDoctorId),
            notes: `Doctor reassigned from Dr. ${previousDoctorName2} to Dr. ${targetDoctor2.name}${feeNote}`
          }
        }
      );
      const patientDoc2 = appt2.patientId;
      const auditUserId = mongoose62.Types.ObjectId.isValid(transferredByUserId) ? new mongoose62.Types.ObjectId(transferredByUserId) : void 0;
      await AuditLog.create({
        userId: auditUserId,
        organizationId: appt2.organizationId || appt2.locationId?.organizationId,
        action: "APPOINTMENT_TRANSFERRED",
        targetId: appt2._id,
        targetModel: "Appointment",
        category: "ADMIN",
        details: {
          fromDoctor: previousDoctorId2,
          toDoctor: replacementDoctorId,
          fromDoctorName: previousDoctorName2,
          toDoctorName: targetDoctor2.name,
          reason: reason || "Doctor schedule disruption transfer",
          staffId: transferredByUserId,
          originalToken: previousToken,
          newToken: newTokenNumber2,
          queuePosition: assignedQueuePosition,
          isPriorityNextUp: isWaiting,
          originalFee: prevFee,
          replacementFee: repFee,
          feeVariance,
          feeResolution
        }
      });
      return { appt: appt2, locationId: locationId2, previousDoctorId: previousDoctorId2, previousDoctorName: previousDoctorName2, replacementDoctorId, targetDoctor: targetDoctor2, patientDoc: patientDoc2, newTokenNumber: newTokenNumber2 };
    });
    appt.$session(null);
    broadcastQueueUpdate(locationId, {
      type: "QUEUE_UPDATED",
      data: { locationId, doctorId: previousDoctorId },
      message: `Patient transferred to Dr. ${targetDoctor.name}`,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
    broadcastQueueUpdate(locationId, {
      type: "QUEUE_UPDATED",
      data: { locationId, doctorId: replacementDoctorId },
      message: `New patient transferred from Dr. ${previousDoctorName}`,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
    return appt;
  },
  /**
   * Cancels an appointment due to doctor disruption and processes refund for prepaid bookings.
   */
  async cancelByDisruption(params) {
    const { appointmentId, cancelledByUserId, reason } = params;
    if (cancelledByUserId === "system") throw new AppointmentDomainError("Unanswered disruption requires staff review", 409);
    let appt = await Appointment.findById(appointmentId).populate("locationId", "name phone organizationId").populate("doctorId", "name email").populate({
      path: "patientId",
      populate: { path: "userId", select: "name email phone" }
    });
    if (!appt) {
      throw new Error("Appointment not found");
    }
    requirePendingDisruption(appt);
    if (appt.status !== "disruption_triage") throw new AppointmentDomainError("Appointment is no longer awaiting a disruption response", 409);
    const previousPaymentStatus = appt.paymentStatus;
    const claimed = await withClinicalTransaction(async () => {
      const changed = await Appointment.findOneAndUpdate(
        { _id: appt._id, status: "disruption_triage", paymentStatus: previousPaymentStatus, triageAction: "pending" },
        { $set: {
          status: "cancelled",
          triageAction: "cancelled",
          paymentStatus: previousPaymentStatus === "paid" ? "refund_pending" : previousPaymentStatus,
          cancellationReason: reason || "Doctor schedule disruption",
          notes: `${appt.notes ? `${appt.notes} | ` : ""}[Cancelled due to doctor disruption: ${reason || "Doctor unavailable"}]`
        } },
        { returnDocument: "after" }
      ).populate("locationId", "name phone organizationId").populate("doctorId", "name email").populate({ path: "patientId", populate: { path: "userId", select: "name email phone" } });
      if (changed) {
        if (previousPaymentStatus !== "paid") await Invoice.updateMany({ appointmentId: changed._id, organizationId: changed.organizationId, status: "unpaid" }, { status: "cancelled" });
        await AuditLog.create({ userId: mongoose62.Types.ObjectId.isValid(cancelledByUserId) ? cancelledByUserId : void 0, organizationId: changed.organizationId, action: "APPOINTMENT_CANCELLED", targetId: changed._id, targetModel: "Appointment", category: "ADMIN", details: { appointmentId: changed.id, fromDoctor: String(changed.doctorId?._id || changed.doctorId), doctorId: String(changed.doctorId?._id || changed.doctorId), locationId: String(changed.locationId?._id || changed.locationId), staffId: cancelledByUserId, refundProcessed: false, refundPending: previousPaymentStatus === "paid", reason: reason || "Doctor schedule disruption" } });
        await publishAppointmentCommunication(changed, { action: "cancelled", actorId: await communicationActor(cancelledByUserId) });
      }
      return changed;
    });
    if (!claimed) throw new AppointmentDomainError("Appointment was changed by another request", 409);
    appt = claimed;
    appt.$session(null);
    const patientDoc = appt.patientId;
    const locationId = appt.locationId?._id?.toString() || appt.locationId?.toString();
    const doctorId = appt.doctorId?._id?.toString() || appt.doctorId?.toString();
    const doctorName = appt.doctorId?.name || "Doctor";
    const locationName = appt.locationId?.name || "Location";
    const patientName = patientDoc?.name || patientDoc?.userId?.name || "Patient";
    const patientPhone = patientDoc?.phone || patientDoc?.userId?.phone;
    const auditUserId = mongoose62.Types.ObjectId.isValid(cancelledByUserId) ? new mongoose62.Types.ObjectId(cancelledByUserId) : void 0;
    let refundAmount = 0;
    let refundId = "";
    if (previousPaymentStatus === "paid") {
      const invoice = await Invoice.findOne({ appointmentId: appt._id });
      const source = await onlineRefundSource(appt, invoice);
      refundAmount = source?.amount || 0;
      appt.paymentStatus = "refund_pending";
      if (source) {
        await AuditLog.create({
          userId: auditUserId,
          organizationId: appt.organizationId || appt.locationId?.organizationId,
          action: "REFUND_REQUESTED",
          targetId: appt._id,
          targetModel: "Appointment",
          category: "BILLING",
          details: { paymentId: source.paymentId, amount: source.amount, currency: source.currency }
        });
        const refundResult = await paymentProvider.processRefund({
          transactionId: source.paymentId,
          amount: refundAmount,
          reason: `Doctor Disruption Cancellation: ${reason || "Doctor unavailable"}`
        }).catch((error) => {
          console.error("[DisruptionService] Automatic refund failed:", safeError(error));
          return null;
        });
        refundId = refundResult?.refundId || "";
        if (refundResult?.status === "processed") {
          const appointmentKey = appt._id;
          appt = await withClinicalTransaction(async () => {
            const current = await Appointment.findById(appointmentKey).populate("locationId", "name phone organizationId").populate("doctorId", "name email").populate({ path: "patientId", populate: { path: "userId", select: "name email phone" } });
            const currentInvoice = invoice && await Invoice.findById(invoice._id);
            const currentSource = current && await onlineRefundSource(current, currentInvoice);
            if (!current || current.status !== "cancelled" || current.paymentStatus !== "refund_pending" || !currentInvoice || !currentSource || currentSource.paymentId !== source.paymentId || currentSource.amount !== source.amount) {
              throw new AppointmentDomainError("Payment records changed during refund confirmation; reconcile the provider result", 409);
            }
            currentInvoice.status = "refunded";
            current.paymentStatus = "refunded";
            current.triageAction = "refunded";
            await currentInvoice.save();
            await current.save();
            await AuditLog.create({ userId: auditUserId, organizationId: current.organizationId, action: "APPOINTMENT_REFUNDED", targetId: currentInvoice._id, targetModel: "Invoice", category: "BILLING", details: { appointmentId: current.id, invoiceId: currentInvoice.id, amount: refundAmount, refundId, staffId: cancelledByUserId } });
            await publishAppointmentCommunication(current, { action: "refund", actorId: await communicationActor(cancelledByUserId) });
            return current;
          });
          appt.$session(null);
        } else {
          await AuditLog.create({ userId: auditUserId, organizationId: appt.organizationId, action: "REFUND_PROVIDER_RESULT", targetId: appt._id, targetModel: "Appointment", category: "BILLING", details: { appointmentId: appt.id, paymentId: source.paymentId, refundId, providerStatus: refundResult?.status || "unknown", refundProcessed: false, amount: refundAmount } });
        }
      }
    }
    broadcastQueueUpdate(locationId, {
      type: "QUEUE_UPDATED",
      data: { locationId, doctorId },
      message: "Appointment cancelled due to schedule disruption",
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
    return appt;
  },
  /**
   * Reschedules a disrupted appointment with highest priority for next available slot/date.
   * Payment status and records are preserved.
   */
  async priorityReschedule(params) {
    const { appointmentId, targetDate, targetDoctorId, targetTimeSlot, rescheduledByUserId, reason } = params;
    const { originalAppt, newAppt, locationId, doctorId, patientDoc, newTokenNumber, newAppointmentTime, timezone } = await withClinicalTransaction(async () => {
      const originalAppt2 = await Appointment.findById(appointmentId).populate("locationId", "name phone organizationId").populate("doctorId", "name email").populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" }
      });
      if (!originalAppt2) {
        throw new Error("Appointment not found");
      }
      requirePendingDisruption(originalAppt2);
      const locationId2 = originalAppt2.locationId?._id?.toString() || originalAppt2.locationId?.toString();
      const doctorId2 = targetDoctorId || originalAppt2.doctorId?._id?.toString() || originalAppt2.doctorId?.toString();
      const timezone2 = await getLocationTimezone(locationId2);
      let newAppointmentTime2;
      try {
        newAppointmentTime2 = locationLocalTimeToDate(targetDate, targetTimeSlot || "09:00", timezone2);
      } catch {
        throw new AppointmentDomainError("Invalid location date or time", 400);
      }
      const { start: startOfDay, end: endOfDay } = locationDayRange(targetDate, timezone2);
      const assignment = await DoctorAssignment.findOne({ locationId: locationId2, doctorId: doctorId2, isActive: true });
      if (!assignment || String(assignment.organizationId) !== String(originalAppt2.organizationId || originalAppt2.locationId?.organizationId)) {
        throw new AppointmentDomainError("Doctor is not assigned to this location", 404);
      }
      const actor = mongoose62.Types.ObjectId.isValid(rescheduledByUserId) ? await User.findById(rescheduledByUserId).select("role") : null;
      await validateAppointmentAvailability({ role: actor?.role || "patient" }, {
        locationId: locationId2,
        doctorId: doctorId2,
        appointmentTime: newAppointmentTime2.toISOString(),
        appointmentType: originalAppt2.appointmentType,
        duration: originalAppt2.duration
      }, assignment, originalAppt2.id);
      const newTokenNumber2 = await nextDisruptionToken(locationId2, doctorId2, targetDate, startOfDay, endOfDay);
      if (assignment.maxDailyTokens && newTokenNumber2 > assignment.maxDailyTokens) throw new AppointmentDomainError("Doctor's daily token limit has been reached", 409);
      const claimed = await Appointment.updateOne({ _id: originalAppt2._id, status: "disruption_triage", triageAction: "pending" }, { $set: { status: "cancelled", triageAction: "rescheduled" } });
      if (!claimed.modifiedCount) throw new AppointmentDomainError("Appointment was changed by another request", 409);
      if (assignment.bookingMode === "sequential_queue" && originalAppt2.paymentStatus !== "pending") {
        const waiting = await Appointment.find({
          locationId: locationId2,
          doctorId: doctorId2,
          appointmentTime: { $gte: startOfDay, $lte: endOfDay },
          status: { $in: ["pending", "confirmed", "checked-in"] },
          _id: { $ne: originalAppt2._id }
        }).sort({ queuePosition: 1, tokenNumber: 1 });
        for (let index = 0; index < waiting.length; index++) {
          waiting[index].queuePosition = index + 2;
          await waiting[index].save();
        }
      }
      const newAppt2 = await Appointment.create({
        organizationId: originalAppt2.organizationId || originalAppt2.locationId?.organizationId,
        locationId: locationId2,
        doctorId: doctorId2,
        patientId: originalAppt2.patientId?._id || originalAppt2.patientId,
        bookedByUserId: originalAppt2.bookedByUserId,
        appointmentTime: newAppointmentTime2,
        appointmentType: originalAppt2.appointmentType,
        status: originalAppt2.paymentStatus === "pending" ? "pending_payment" : "confirmed",
        paymentStatus: originalAppt2.paymentStatus,
        // carry forward prepaid status!
        bookingSource: originalAppt2.bookingSource,
        tokenNumber: newTokenNumber2,
        queuePosition: assignment.bookingMode === "sequential_queue" && originalAppt2.paymentStatus !== "pending" ? 1 : newTokenNumber2,
        bookingMode: assignment.bookingMode,
        duration: originalAppt2.duration || 15,
        reasonForVisit: originalAppt2.reasonForVisit,
        priorityRescheduledFromId: originalAppt2._id,
        notes: `[Priority Rescheduled from ${locationDateKey(new Date(originalAppt2.appointmentTime), timezone2)}: ${reason || "Disruption"}]`
      });
      originalAppt2.status = "cancelled";
      originalAppt2.triageAction = "rescheduled";
      originalAppt2.cancellationReason = `Priority Rescheduled to ${targetDate}`;
      originalAppt2.notes = originalAppt2.notes ? `${originalAppt2.notes} | [Rescheduled to ${targetDate} - New Appointment ID: ${newAppt2._id}]` : `[Rescheduled to ${targetDate} - New Appointment ID: ${newAppt2._id}]`;
      await originalAppt2.save();
      await resolveAppointmentRecovery(originalAppt2, mongoose62.Types.ObjectId.isValid(rescheduledByUserId) ? rescheduledByUserId : void 0, "rescheduled", newAppt2.id);
      await publishAppointmentCommunication(newAppt2, { action: "rescheduled", actorId: await communicationActor(rescheduledByUserId) });
      if (["paid", "pending", "pay_at_location"].includes(originalAppt2.paymentStatus)) {
        await Invoice.updateMany(
          { appointmentId: originalAppt2._id, organizationId: originalAppt2.organizationId, status: { $ne: "cancelled" } },
          {
            appointmentId: newAppt2._id,
            notes: `Carried forward from appointment ${originalAppt2._id}`
          }
        );
      }
      const patientDoc2 = originalAppt2.patientId;
      const auditUserId = mongoose62.Types.ObjectId.isValid(rescheduledByUserId) ? new mongoose62.Types.ObjectId(rescheduledByUserId) : void 0;
      await AuditLog.create({
        userId: auditUserId,
        organizationId: originalAppt2.organizationId || originalAppt2.locationId?.organizationId,
        action: "APPOINTMENT_RESCHEDULED",
        targetId: originalAppt2._id,
        targetModel: "Appointment",
        category: "ADMIN",
        details: {
          originalAppointmentId: originalAppt2._id.toString(),
          newAppointmentId: newAppt2._id.toString(),
          fromDoctor: originalAppt2.doctorId.toString(),
          toDoctor: doctorId2,
          targetDate,
          reason: reason || "Doctor schedule disruption",
          staffId: rescheduledByUserId,
          newTokenNumber: newTokenNumber2,
          priorityQueuePosition: 1
        }
      });
      return { originalAppt: originalAppt2, newAppt: newAppt2, locationId: locationId2, doctorId: doctorId2, patientDoc: patientDoc2, newTokenNumber: newTokenNumber2, newAppointmentTime: newAppointmentTime2, timezone: timezone2 };
    });
    originalAppt.$session(null);
    newAppt.$session(null);
    broadcastQueueUpdate(locationId, {
      type: "QUEUE_UPDATED",
      data: { locationId, doctorId },
      message: "New appointment scheduled via priority reschedule",
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
    return { originalAppt, newAppt };
  },
  /**
   * Batch action for multiple appointments (transfer, cancel, or reschedule).
   */
  async batchTriageAction(params) {
    const { action, appointmentIds, actorUserId, replacementDoctorId, targetDate, targetTimeSlot, reason } = params;
    let successfulCount = 0;
    let failedCount = 0;
    const errors = [];
    const processed = [];
    for (const apptId of appointmentIds) {
      try {
        if (action === "transfer") {
          if (!replacementDoctorId) throw new Error("replacementDoctorId is required for transfer");
          const res = await this.transferPatient({
            appointmentId: apptId,
            replacementDoctorId,
            transferredByUserId: actorUserId,
            reason
          });
          processed.push(res);
          successfulCount++;
        } else if (action === "cancel") {
          const res = await this.cancelByDisruption({
            appointmentId: apptId,
            cancelledByUserId: actorUserId,
            reason
          });
          processed.push(res);
          successfulCount++;
        } else if (action === "reschedule") {
          if (!targetDate) throw new Error("targetDate is required for reschedule");
          const res = await this.priorityReschedule({
            appointmentId: apptId,
            targetDate,
            targetDoctorId: replacementDoctorId,
            targetTimeSlot,
            rescheduledByUserId: actorUserId,
            reason
          });
          processed.push(res);
          successfulCount++;
        }
      } catch (err) {
        failedCount++;
        errors.push({ appointmentId: apptId, error: err.message || String(err) });
      }
    }
    return { successfulCount, failedCount, errors, processed };
  },
  /** Unanswered disruption is staff review; silence never cancels or refunds care. */
  async processDisruptionTimeout(fence) {
    const now = /* @__PURE__ */ new Date();
    const due = { status: "disruption_triage", triageAction: { $in: ["pending", "timeout_processing"] }, disruptionReviewRequiredAt: { $exists: false }, $or: [
      { disruptionReviewDueAt: { $lte: now } },
      { disruptionResponseDeadline: { $lte: now } },
      { disruptionReviewDueAt: { $exists: false }, disruptionResponseDeadline: { $exists: false }, disruptedAt: { $lte: new Date(now.getTime() - 60 * 60 * 1e3) } }
    ] };
    const appointments = await Appointment.find(due).sort({ _id: 1 }).limit(100);
    let reviewRequiredCount = 0;
    for (const appointment of appointments) {
      const claimed = await withClinicalTransaction(async () => {
        if (fence) await fence();
        if (!appointment.organizationId || !await Location.exists({ _id: appointment.locationId, organizationId: appointment.organizationId, isActive: true })) return false;
        const changed = await Appointment.findOneAndUpdate({ ...due, _id: appointment._id, organizationId: appointment.organizationId }, { $set: { disruptionReviewRequiredAt: now, triageAction: "pending" }, $unset: { disruptionTimeoutClaimedAt: 1, disruptionTimeoutClaimToken: 1 } }, { returnDocument: "after" });
        if (!changed) return false;
        const relationship = await PatientRelationship.findOne({ organizationId: changed.organizationId, patientId: changed.patientId, locationId: changed.locationId, status: "active" }).select("ownerId").lean();
        await createCrmTask({ organizationId: String(changed.organizationId), locationId: String(changed.locationId), patientId: String(changed.patientId), appointmentId: changed.id, kind: "crm_recovery", title: "Review unanswered doctor disruption", dueDate: now, assignedTo: relationship?.ownerId?.toString(), dedupeKey: "disruption-unanswered:" + changed.id + ":" + String(changed.disruptionId || "legacy") });
        return true;
      });
      if (claimed) reviewRequiredCount++;
    }
    return { autoCancelledCount: 0, reviewRequiredCount, totalExpiredFound: appointments.length };
  }
};

// utilities/workerLoop.ts
var WorkerLoop = class {
  timer;
  active;
  stopped = true;
  idleMs = 0;
  lastCompletedAt = Date.now();
  failures = 0;
  start(work, baseMs) {
    if (!this.stopped) return;
    this.stopped = false;
    this.idleMs = baseMs;
    const tick = () => {
      if (this.stopped) return;
      this.active = (async () => {
        try {
          const result = await work();
          this.lastCompletedAt = Date.now();
          this.idleMs = result?.processed ? baseMs : Math.min(Math.max(baseMs, 15e3), Math.max(baseMs, this.idleMs * 2));
        } catch {
          this.failures++;
          this.idleMs = Math.min(Math.max(baseMs, 15e3), Math.max(baseMs, this.idleMs * 2));
          console.error("[WorkerLoop] Batch failed; retrying with bounded backoff");
        }
      })().finally(() => {
        this.active = void 0;
        if (!this.stopped) {
          this.timer = setTimeout(tick, this.idleMs + Math.floor(Math.random() * this.idleMs * 0.2));
          this.timer.unref?.();
        }
      });
    };
    this.timer = setTimeout(tick, baseMs);
    this.timer.unref?.();
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = void 0;
    if (this.active) {
      let timeout;
      try {
        await Promise.race([this.active, new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Worker drain deadline exceeded; durable leases will recover unfinished work")), 45e3);
          timeout.unref?.();
        })]);
      } finally {
        clearTimeout(timeout);
      }
    }
  }
  progress() {
    return { running: !this.stopped, active: !!this.active, lastCompletedAt: this.lastCompletedAt, failures: this.failures, idleMs: this.idleMs };
  }
};

// models/WorkerLease.ts
import mongoose63, { Schema as Schema51 } from "mongoose";
var WorkerLeaseSchema = new Schema51(
  {
    name: { type: String, required: true, unique: true, immutable: true },
    holderId: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    fenceRevision: { type: Number, default: 0 }
  },
  { timestamps: true }
);
WorkerLeaseSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
var WorkerLease = mongoose63.models.WorkerLease || mongoose63.model(
  "WorkerLease",
  WorkerLeaseSchema
);

// utilities/workerLease.ts
async function acquireOrRenewWorkerLease({
  name,
  holderId,
  leaseMs: leaseMs2,
  now = /* @__PURE__ */ new Date()
}) {
  if (!Number.isFinite(leaseMs2) || leaseMs2 <= 0) {
    throw new Error("Worker lease duration must be a positive number of milliseconds");
  }
  try {
    const lease = await WorkerLease.findOneAndUpdate(
      {
        name,
        $or: [
          { holderId },
          { expiresAt: { $lte: now } },
          { expiresAt: { $exists: false } }
        ]
      },
      {
        $set: {
          holderId,
          expiresAt: new Date(now.getTime() + leaseMs2)
        },
        $setOnInsert: { name }
      },
      {
        returnDocument: "after",
        upsert: true,
        setDefaultsOnInsert: true
      }
    ).lean();
    return lease?.holderId === holderId;
  } catch (error) {
    if (error?.code === 11e3) return false;
    throw error;
  }
}
async function releaseWorkerLease(name, holderId) {
  await WorkerLease.deleteOne({ name, holderId });
}

// jobs/disruptionTimeoutJob.ts
var loop = new WorkerLoop();
var getDisruptionTimeoutProgress = () => loop.progress();
var disruptionHolderId = `${process.env.HOSTNAME || "api"}:${process.pid}:${crypto21.randomUUID()}`;
async function runDisruptionTimeoutSweep(fence) {
  try {
    const result = await disruptionService.processDisruptionTimeout(fence);
    if (result.reviewRequiredCount > 0) {
      console.log(`[DisruptionTimeoutJob] ${result.reviewRequiredCount} unanswered disruption appointments require staff review.`);
    }
    return result;
  } catch (err) {
    console.error("[DisruptionTimeoutJob] Error during disruption sweep:", safeError(err));
    return { autoCancelledCount: 0, reviewRequiredCount: 0, error: err };
  }
}
function startDisruptionTimeoutJob(intervalMs = 5 * 60 * 1e3) {
  loop.start(async () => {
    const name = "disruption-timeout-sweeper";
    const ownsLease = await acquireOrRenewWorkerLease({ name, holderId: disruptionHolderId, leaseMs: 12e4 });
    if (!ownsLease) return { processed: 0 };
    try {
      const result = await runDisruptionTimeoutSweep(async () => {
        const fence = await WorkerLease.updateOne({ name, holderId: disruptionHolderId, expiresAt: { $gt: /* @__PURE__ */ new Date() } }, { $inc: { fenceRevision: 1 }, $set: { expiresAt: new Date(Date.now() + 12e4) } });
        if (fence.matchedCount !== 1) throw new Error("Disruption review scheduler lease lost");
      });
      if ("error" in result) throw result.error;
      return { processed: result.reviewRequiredCount };
    } finally {
      await releaseWorkerLease(name, disruptionHolderId);
    }
  }, intervalMs);
}
async function stopDisruptionTimeoutJob() {
  await loop.stop();
}

// workers/disruptionTimeoutWorker.ts
verifyEnv();
await init_db().then(() => db_exports);
var interval = Number(process.env.DISRUPTION_TIMEOUT_SWEEP_INTERVAL_MS || 3e5);
if (!Number.isFinite(interval) || interval < 1e3) throw new Error("Invalid disruption sweep interval");
startDisruptionTimeoutJob(interval);
var health = startWorkerHealthServer({ workerName: "disruptionTimeoutWorker", defaultPort: 5003, onProgress: getDisruptionTimeoutProgress });
var shutdown = async () => {
  await stopDisruptionTimeoutJob();
  await health.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
