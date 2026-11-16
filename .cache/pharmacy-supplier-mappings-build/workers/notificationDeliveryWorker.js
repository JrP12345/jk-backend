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

// models/User.ts
import mongoose4, { Schema as Schema3 } from "mongoose";
var AUTH_METHOD_OPTIONS, UserSchema, User;
var init_User = __esm({
  "models/User.ts"() {
    "use strict";
    AUTH_METHOD_OPTIONS = ["email_password", "phone_otp", "email_otp", "both"];
    UserSchema = new Schema3({
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
    User = mongoose4.model("User", UserSchema);
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
import mongoose10, { Schema as Schema9 } from "mongoose";
var LocationSchema, Location;
var init_Location = __esm({
  "models/Location.ts"() {
    "use strict";
    init_facility();
    init_googleMapsEmbed();
    LocationSchema = new Schema9({
      organizationId: { type: Schema9.Types.ObjectId, ref: "Organization", required: true, index: true },
      name: { type: String, required: true },
      facilityType: { type: String, enum: [...FACILITY_TYPES], default: null },
      publicPharmacy: { type: new Schema9({ catalogueEnabled: { type: Boolean, default: false }, pickupEnabled: { type: Boolean, default: false }, revision: { type: Number, required: true, min: 0, validate: Number.isSafeInteger } }, { _id: false }), default: void 0 },
      pharmacyCapability: { type: new Schema9({
        enabled: { type: Boolean, required: true },
        revision: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
        reviewReference: String,
        confirmedBy: { type: Schema9.Types.ObjectId, ref: "User" },
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
        if (ret.pharmacyCapability) ret.pharmacyCapability = { enabled: ret.pharmacyCapability.enabled, revision: ret.pharmacyCapability.revision };
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    });
    Location = mongoose10.model("Location", LocationSchema);
  }
});

// models/Organization.ts
import mongoose11, { Schema as Schema10 } from "mongoose";
var OrganizationSchema, Organization;
var init_Organization = __esm({
  "models/Organization.ts"() {
    "use strict";
    OrganizationSchema = new Schema10({
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
import mongoose14, { Schema as Schema12 } from "mongoose";
var AuditCheckpointSchema, AuditCheckpoint;
var init_AuditCheckpoint = __esm({
  "models/AuditCheckpoint.ts"() {
    "use strict";
    AuditCheckpointSchema = new Schema12({
      organizationId: { type: Schema12.Types.ObjectId, ref: "Organization", index: true, default: null },
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
    AuditCheckpoint = mongoose14.models.AuditCheckpoint || mongoose14.model("AuditCheckpoint", AuditCheckpointSchema);
  }
});

// models/AuditChainHead.ts
import mongoose15, { Schema as Schema13 } from "mongoose";
var schema, AuditChainHead;
var init_AuditChainHead = __esm({
  "models/AuditChainHead.ts"() {
    "use strict";
    schema = new Schema13({
      _id: { type: String },
      sequence: { type: Number, required: true },
      hash: { type: String, required: true }
    }, { versionKey: false });
    AuditChainHead = mongoose15.models.AuditChainHead || mongoose15.model("AuditChainHead", schema);
  }
});

// utilities/transaction.ts
import mongoose16 from "mongoose";
async function withTransaction(fn, options) {
  const inherited = mongoose16.transactionAsyncLocalStorage?.getStore()?.session;
  if (inherited?.inTransaction()) return fn(inherited);
  const topologyType = mongoose16.connection?.client?.topology?.description?.type;
  const isStandalone = topologyType === "Single" || topologyType === "Unknown";
  if (isStandalone) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Multi-document ACID transactions require a MongoDB Replica Set in production");
    }
    return fn(null);
  }
  return mongoose16.connection.transaction(async (session) => fn(session), options);
}
var init_transaction = __esm({
  "utilities/transaction.ts"() {
    "use strict";
    mongoose16.set("transactionAsyncLocalStorage", true);
  }
});

// utilities/auditCrypto.ts
import crypto4 from "node:crypto";
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
  return crypto4.createHash("sha256").update(payload, "utf8").digest("hex");
}
var GENESIS_HASH;
var init_auditCrypto = __esm({
  "utilities/auditCrypto.ts"() {
    "use strict";
    GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";
  }
});

// models/RefreshToken.ts
import mongoose17, { Schema as Schema14 } from "mongoose";
var ImpersonationSchema, RefreshTokenSchema, RefreshToken;
var init_RefreshToken = __esm({
  "models/RefreshToken.ts"() {
    "use strict";
    ImpersonationSchema = new Schema14({
      id: { type: Schema14.Types.ObjectId, ref: "User", required: true },
      email: { type: String },
      name: { type: String },
      originalRole: { type: String, default: "root" }
    }, { _id: false });
    RefreshTokenSchema = new Schema14({
      userId: { type: Schema14.Types.ObjectId, ref: "User", required: true },
      organizationId: { type: Schema14.Types.ObjectId, ref: "Organization", index: true },
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
      bookingPatientId: { type: Schema14.Types.ObjectId, ref: "Patient" },
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
    RefreshToken = mongoose17.model("RefreshToken", RefreshTokenSchema);
  }
});

// utilities/keys.ts
import crypto5 from "node:crypto";
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
  const { publicKey, privateKey } = crypto5.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  try {
    fs2.writeFileSync(privPath, privateKey, "utf8");
    fs2.writeFileSync(pubPath, publicKey, "utf8");
  } catch {
  }
  SERVICE_PRIVATE_KEY = privateKey;
  SERVICE_PUBLIC_KEY = publicKey;
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

// models/OrgMember.ts
import mongoose18, { Schema as Schema15 } from "mongoose";
var OrgMemberSchema, OrgMember;
var init_OrgMember = __esm({
  "models/OrgMember.ts"() {
    "use strict";
    OrgMemberSchema = new Schema15({
      userId: { type: Schema15.Types.ObjectId, ref: "User", required: true, index: true },
      organizationId: { type: Schema15.Types.ObjectId, ref: "Organization", required: true, index: true },
      role: { type: String, required: true },
      locationAccess: { type: new Schema15({
        mode: { type: String, enum: ["all", "selected"], required: true },
        locationIds: [{ type: Schema15.Types.ObjectId, ref: "Location" }]
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
    OrgMember = mongoose18.model("OrgMember", OrgMemberSchema);
  }
});

// services/StaffMfaPolicy.ts
var init_StaffMfaPolicy = __esm({
  "services/StaffMfaPolicy.ts"() {
    "use strict";
  }
});

// utilities/logger.ts
import crypto6 from "node:crypto";
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
          traceId: context.traceId || crypto6.randomUUID(),
          spanId: context.spanId || crypto6.randomUUID().substring(0, 16),
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
import mongoose19 from "mongoose";
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
import mongoose20, { Schema as Schema16 } from "mongoose";
var RoleSchema, Role;
var init_Role = __esm({
  "models/Role.ts"() {
    "use strict";
    RoleSchema = new Schema16({
      name: { type: String, required: true, index: true },
      organizationId: { type: Schema16.Types.ObjectId, ref: "Organization", default: null, index: true },
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
    Role = mongoose20.model("Role", RoleSchema);
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
import mongoose21 from "mongoose";
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
var ADMIN_PERMISSIONS, DOCTOR_PERMISSIONS, RECEPTIONIST_PERMISSIONS, NURSE_PERMISSIONS, LAB_TECH_PERMISSIONS, PHARMACIST_PERMISSIONS, CASHIER_PERMISSIONS, LOCATION_MANAGER_PERMISSIONS, PATIENT_PERMISSIONS, FAMILY_MEMBER_PERMISSIONS, BUILTIN_ROLE_PERMISSIONS, rolePermissionsCache, ROLE_CACHE_TTL_MS, roleSubClient;
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
import crypto7 from "node:crypto";
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
var NODE_ID, MAX_CONNECTION_BUFFER, sseStreamsMap, userWebSocketsMap, locationQueueWebSocketsMap, privateGuards, privateClosers, locationClinicalWebSocketsMap, CANARY_LOCATION_ID, syntheticClinicalObservers, redisSubscriber;
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
    NODE_ID = process.env.POD_NAME || process.env.HOSTNAME || `node-${crypto7.randomUUID()}`;
    MAX_CONNECTION_BUFFER = 256 * 1024;
    sseStreamsMap = /* @__PURE__ */ new Map();
    userWebSocketsMap = /* @__PURE__ */ new Map();
    locationQueueWebSocketsMap = /* @__PURE__ */ new Map();
    privateGuards = /* @__PURE__ */ new WeakMap();
    privateClosers = /* @__PURE__ */ new Map();
    locationClinicalWebSocketsMap = /* @__PURE__ */ new Map();
    CANARY_LOCATION_ID = "00000000000000000000canary";
    syntheticClinicalObservers = /* @__PURE__ */ new Set();
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
import mongoose22 from "mongoose";
import crypto8 from "node:crypto";
async function recordAuditLog(input, options) {
  if (input.organizationId === void 0 && requestContextStore.getStore()?.organizationId) input = { ...input, organizationId: requestContextStore.getStore().organizationId };
  const orgKey = input.organizationId ? String(input.organizationId) : "GLOBAL";
  const inherited = options?.session || mongoose22.transactionAsyncLocalStorage?.getStore()?.session;
  const append = async (session) => {
    const opts = session ? { session } : {};
    const orgFilter = input.organizationId ? new mongoose22.Types.ObjectId(String(input.organizationId)) : null;
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
  const topology = mongoose22.connection.client?.topology?.description?.type;
  if (topology === "Single" || topology === "Unknown") {
    if (process.env.NODE_ENV === "production") throw new Error("Audit append requires a transaction-capable MongoDB deployment");
    return withChainLock(orgKey, () => append(null));
  }
  return withTransaction(append);
}
async function verifyAuditChainIntegrity(organizationId) {
  const orgFilter = organizationId ? { organizationId: new mongoose22.Types.ObjectId(organizationId) } : { organizationId: null };
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
    const checkpointOrgFilter = organizationId ? { organizationId: new mongoose22.Types.ObjectId(organizationId) } : { organizationId: null };
    const checkpoint = await AuditCheckpoint.findOne(checkpointOrgFilter).sort({ archivedUpToSequence: -1 }).lean();
    if (checkpoint) {
      if (checkpoint.signature && checkpoint.checkpointHash) {
        const secretKey = process.env.ENCRYPTION_SECRET || process.env.JWT_SECRET || "ekavyu-audit-anchor-secret";
        const expectedSig = crypto8.createHmac("sha256", secretKey).update(checkpoint.checkpointHash).digest("hex");
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
import mongoose23, { Schema as Schema17 } from "mongoose";
var AuditLogSchema, AuditLog;
var init_AuditLog = __esm({
  "models/AuditLog.ts"() {
    "use strict";
    init_auditRedaction();
    AuditLogSchema = new Schema17({
      userId: { type: Schema17.Types.ObjectId, ref: "User", index: true },
      organizationId: { type: Schema17.Types.ObjectId, ref: "Organization", default: null },
      action: { type: String, required: true, index: true },
      // e.g. "APPOINTMENT_CREATE", "VIP_OVERRIDE", "PHI_READ_ACCESS", "DPDP_PII_ANONYMIZED"
      targetId: { type: Schema17.Types.ObjectId },
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
      details: { type: Schema17.Types.Mixed },
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
    AuditLog = mongoose23.models.AuditLog || mongoose23.model("AuditLog", AuditLogSchema);
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

// utilities/auditPlugin.ts
function auditPlugin(schema2) {
  schema2.post("save", async function(doc) {
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
  schema2.post("findOneAndUpdate", async function(res) {
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
  schema2.post("findOneAndDelete", async function(res) {
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

// db.ts
var db_exports = {};
__export(db_exports, {
  connectDB: () => connectDB,
  default: () => db_default
});
import mongoose24 from "mongoose";
var MONGODB_URI, connectDB, db_default;
var init_db = __esm({
  async "db.ts"() {
    "use strict";
    init_safeError();
    init_latencyHistogram();
    init_auditPlugin();
    init_scalability();
    mongoose24.plugin(auditPlugin);
    MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/ekavyu_dev";
    connectDB = async () => {
      try {
        const maxPoolSize = Number(process.env.MONGODB_MAX_POOL_SIZE) || DB_POOL_SIZE;
        const configuredMin = Number(process.env.MONGODB_MIN_POOL_SIZE ?? 2);
        const minPoolSize = Number.isInteger(configuredMin) && configuredMin >= 0 ? configuredMin : 2;
        await mongoose24.connect(MONGODB_URI, {
          maxPoolSize,
          minPoolSize,
          serverSelectionTimeoutMS: DB_SERVER_SELECTION_TIMEOUT_MS,
          socketTimeoutMS: DB_SOCKET_TIMEOUT_MS,
          waitQueueTimeoutMS: 5e3,
          maxIdleTimeMS: 6e4,
          monitorCommands: true
        });
        const client = mongoose24.connection.getClient();
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
    db_default = mongoose24;
  }
});

// utilities/workerHealthServer.ts
init_safeError();
import http from "node:http";

// utilities/readiness.ts
init_redis();
import mongoose from "mongoose";

// utilities/config.ts
init_redisConfiguration();
import fs from "node:fs";
import path from "node:path";

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

// utilities/config.ts
var baseRequiredEnv = [
  "MONGODB_URI"
];
var productionRequiredEnv = [
  "MONGODB_URI",
  "CORS_ALLOWED_ORIGINS"
];
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

// utilities/readiness.ts
init_redisConfiguration();
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

// notifications/workers/NotificationDeliveryWorker.ts
import crypto3 from "node:crypto";

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

// models/NotificationDelivery.ts
import mongoose2, { Schema } from "mongoose";
var NotificationDeliverySchema = new Schema({
  notificationId: { type: Schema.Types.ObjectId, ref: "Notification", required: true, index: true },
  channel: {
    type: String,
    enum: ["inApp", "email", "push", "sms", "socket"],
    required: true
  },
  recipient: { type: String, required: true },
  status: {
    type: String,
    enum: ["pending", "processing", "retrying", "sent", "delivered", "failed", "suppressed"],
    default: "pending"
  },
  sentAt: { type: Date },
  error: { type: String },
  metadata: { type: Schema.Types.Mixed },
  // Durable external-delivery outbox fields. In-app deliveries leave these
  // empty; the standalone worker claims only email rows in pending/retrying.
  title: { type: String },
  message: { type: String },
  idempotencyKey: { type: String, unique: true, sparse: true, index: true },
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 5 },
  nextAttemptAt: { type: Date, index: true },
  lockedAt: { type: Date },
  lockedUntil: { type: Date, index: true },
  lockedBy: { type: String, index: true },
  // A human replay is explicitly bounded and attributable. It receives a new
  // automatic retry budget without allowing an infinite operator retry loop.
  replayCount: { type: Number, default: 0 },
  lastReplayedAt: { type: Date },
  lastReplayedBy: { type: Schema.Types.ObjectId, ref: "User" },
  createdAt: { type: Date, default: Date.now, index: true }
});
NotificationDeliverySchema.virtual("id").get(function() {
  return this._id.toHexString();
});
NotificationDeliverySchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});
var NotificationDelivery = mongoose2.model(
  "NotificationDelivery",
  NotificationDeliverySchema
);

// notifications/providers/emailProvider.ts
init_safeError();
import nodemailer from "nodemailer";

// utilities/concurrencyBudget.ts
init_redis();
import crypto from "node:crypto";
var local = /* @__PURE__ */ new Map();
var leaseMs = 6e4;
var acquire = `redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1]); if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end; redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4]); redis.call('PEXPIRE', KEYS[1], 120000); return 1`;
async function withConcurrencyBudget(scope, limit, work) {
  const key = `budget:${scope}`;
  const token = crypto.randomUUID();
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

// notifications/providers/emailProvider.ts
init_scalability();

// utilities/cryptoEnvelope.ts
import crypto2 from "node:crypto";
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
var ENCRYPTION_SECRET = resolveEncryptionSecret();
var MASTER_KEY = crypto2.scryptSync(ENCRYPTION_SECRET, "healthos-fle-salt-2026", 32);
var BLIND_INDEX_KEY = crypto2.scryptSync(ENCRYPTION_SECRET, "healthos-blind-index-salt-2026", 32);
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
  const iv = crypto2.randomBytes(12);
  const cipher = crypto2.createCipheriv("aes-256-gcm", MASTER_KEY, iv);
  let encrypted = cipher.update(str, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `enc:v1:${iv.toString("hex")}:${authTag}:${encrypted}`;
}
function decryptField(ciphertext) {
  if (ciphertext === null || ciphertext === void 0) return ciphertext;
  const str = String(ciphertext);
  if (!isEncrypted(str)) return str;
  const parts = str.split(":");
  if (parts.length === 5) {
    try {
      const decipher = crypto2.createDecipheriv("aes-256-gcm", MASTER_KEY, Buffer.from(parts[2], "hex"));
      decipher.setAuthTag(Buffer.from(parts[3], "hex"));
      return decipher.update(parts[4], "hex", "utf8") + decipher.final("utf8");
    } catch {
    }
  }
  console.error("[FLE] Decryption or authentication tag verification failed");
  return "[DECRYPTION_FAILED]";
}

// notifications/providers/emailProvider.ts
var EmailProvider = class {
  transporter = null;
  lastConfigKey = "";
  constructor() {
    this.initTransporter();
  }
  initTransporter() {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT) || 587;
    const secure = process.env.SMTP_SECURE === "true" || port === 465;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const currentKey = `${host}:${port}:${user}:${pass}:${secure}`;
    this.lastConfigKey = currentKey;
    if (host && user && pass) {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass },
        tls: { rejectUnauthorized: process.env.NODE_ENV === "production" },
        requireTLS: process.env.NODE_ENV === "production" && !secure,
        connectionTimeout: 1e4,
        greetingTimeout: 1e4,
        socketTimeout: 3e4
      });
      console.log("[EmailProvider] Nodemailer initialized");
    } else {
      this.transporter = null;
      console.log("[EmailProvider] SMTP credentials are not configured; outbound email is unavailable.");
    }
  }
  /**
   * Build a one-time transporter from an org-level SMTP config (decrypting password if encrypted).
   */
  buildTransientTransporter(cfg) {
    const rawPass = cfg.pass && isEncrypted(cfg.pass) ? decryptField(cfg.pass) : cfg.pass;
    return nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port || 587,
      secure: cfg.secure || false,
      auth: { user: cfg.user, pass: rawPass },
      tls: { rejectUnauthorized: process.env.NODE_ENV === "production" },
      requireTLS: process.env.NODE_ENV === "production" && !cfg.secure,
      connectionTimeout: 1e4,
      greetingTimeout: 1e4,
      socketTimeout: 3e4
    });
  }
  /**
   * Send outbound email.
   * If orgSmtp is provided and has credentials, it is used instead of .env.
   */
  async sendEmail(options, orgSmtp) {
    return withConcurrencyBudget("provider:email", MAX_PROVIDER_CONCURRENCY, () => this.sendEmailBounded(options, orgSmtp));
  }
  async sendEmailBounded(options, orgSmtp) {
    const fromEmail = orgSmtp?.fromEmail || options.from || process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || "noreply@ekavyu.com";
    const configuredName = process.env.SMTP_FROM_NAME?.trim();
    const platformName = configuredName || "Ekavyu";
    const fromName = orgSmtp?.fromName || platformName;
    const formattedFrom = fromEmail.includes("<") ? fromEmail : `"${fromName}" <${fromEmail}>`;
    if (orgSmtp?.host && orgSmtp?.user && orgSmtp?.pass) {
      const transporter = this.buildTransientTransporter(orgSmtp);
      try {
        await transporter.sendMail({
          from: formattedFrom,
          to: options.to,
          subject: options.subject,
          text: options.text || options.html.replace(/<[^>]*>?/gm, ""),
          html: options.html
        });
        console.log("[EmailProvider] Sent via org SMTP");
        return true;
      } catch (err) {
        console.error("[EmailProvider] Org SMTP delivery failed", safeError(err));
        return false;
      }
    }
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT) || 587;
    const secure = process.env.SMTP_SECURE === "true" || port === 465;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const currentKey = `${host}:${port}:${user}:${pass}:${secure}`;
    if (currentKey !== this.lastConfigKey || !this.transporter && host && user && pass) {
      this.initTransporter();
    }
    if (this.transporter) {
      try {
        await this.transporter.sendMail({
          from: formattedFrom,
          to: options.to,
          subject: options.subject,
          text: options.text || options.html.replace(/<[^>]*>?/gm, ""),
          html: options.html
        });
        console.log("[EmailProvider] Email sent");
        return true;
      } catch (err) {
        console.error("[EmailProvider] Email delivery failed", safeError(err));
        return false;
      }
    }
    if (process.env.NODE_ENV === "test") {
      return true;
    }
    console.error("[EmailProvider] SMTP is not configured; refusing to report email delivery as successful");
    return false;
  }
  async verifyConnection(orgSmtp) {
    if (orgSmtp?.host && orgSmtp?.user && orgSmtp?.pass) {
      const transporter = this.buildTransientTransporter(orgSmtp);
      try {
        await transporter.verify();
        return { success: true, message: `SMTP verified: ${orgSmtp.host}:${orgSmtp.port} (${orgSmtp.user})` };
      } catch (err) {
        return { success: false, message: `SMTP verification failed: ${err.message}` };
      }
    }
    if (!this.transporter) {
      return {
        success: false,
        message: "SMTP is not configured. Set credentials in Organization Settings or backend/.env."
      };
    }
    try {
      await this.transporter.verify();
      return { success: true, message: "SMTP connection verified successfully!" };
    } catch (err) {
      return { success: false, message: `SMTP verification failed: ${err.message}` };
    }
  }
};
var emailProvider = new EmailProvider();

// models/Notification.ts
import mongoose3, { Schema as Schema2 } from "mongoose";
var NotificationSchema = new Schema2({
  organizationId: { type: Schema2.Types.ObjectId, ref: "Organization", index: true },
  tenantId: { type: String, index: true },
  createdBy: { type: Schema2.Types.ObjectId, ref: "User" },
  targetUser: { type: Schema2.Types.ObjectId, ref: "User", required: true, index: true },
  category: {
    type: String,
    enum: ["auth", "organization", "team", "task", "patient", "billing", "security", "system"],
    required: true,
    index: true
  },
  type: { type: String, required: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  priority: {
    type: String,
    enum: ["low", "medium", "high", "urgent"],
    default: "medium"
  },
  severity: {
    type: String,
    enum: ["info", "success", "warning", "error"],
    default: "info"
  },
  actionUrl: { type: String },
  icon: { type: String },
  metadata: { type: Schema2.Types.Mixed },
  idempotencyKey: { type: String, index: true, sparse: true },
  snoozedUntil: { type: Date, default: null, index: true },
  pinned: { type: Boolean, default: false, index: true },
  entityType: { type: String, index: true },
  entityId: { type: String, index: true },
  groupKey: { type: String, index: true },
  expiresAt: { type: Date },
  readAt: { type: Date, default: null, index: true },
  clickedAt: { type: Date, default: null },
  archived: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null, index: true },
  createdAt: { type: Date, default: Date.now, index: true }
});
NotificationSchema.index({ targetUser: 1, organizationId: 1, pinned: -1, archived: 1, deletedAt: 1, createdAt: -1 });
NotificationSchema.index({ targetUser: 1, organizationId: 1, readAt: 1, archived: 1, deletedAt: 1 });
NotificationSchema.index({ entityType: 1, entityId: 1 });
NotificationSchema.index({ title: "text", message: "text" });
NotificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, sparse: true });
NotificationSchema.virtual("id").get(function() {
  return this._id.toHexString();
});
NotificationSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});
var Notification = mongoose3.model("Notification", NotificationSchema);

// services/PatientNotificationAuthority.ts
init_User();
import mongoose13 from "mongoose";

// models/Patient.ts
import mongoose8, { Schema as Schema7 } from "mongoose";

// utilities/documentBudget.ts
import mongoose5 from "mongoose";
function documentBudget(schema2, limits) {
  schema2.pre("validate", function() {
    for (const [path3, limit] of Object.entries(limits)) {
      if ((this.get(path3)?.length || 0) > limit) throw Object.assign(new Error(`Embedded ${path3} limit reached; retain history and use a new record`), { statusCode: 409 });
    }
    if (mongoose5.mongo.BSON.calculateObjectSize(this.toObject({ virtuals: false, getters: false })) > 8 * 1024 * 1024) throw Object.assign(new Error("Document growth budget exceeded"), { statusCode: 409 });
  });
  for (const method of ["updateOne", "updateMany", "findOneAndUpdate"]) {
    schema2.pre(method, function() {
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

// models/Counter.ts
import mongoose6, { Schema as Schema5 } from "mongoose";
var CounterSchema = new Schema5(
  {
    id: { type: String, required: true, unique: true },
    seq: { type: Number, default: 0 }
  },
  { timestamps: true }
);
var Counter = mongoose6.models.Counter || mongoose6.model("Counter", CounterSchema);
async function getNextAtomicSequence(counterId, session) {
  const result = await Counter.findOneAndUpdate(
    { id: counterId },
    { $inc: { seq: 1 } },
    { returnDocument: "after", upsert: true, ...session ? { session } : {} }
  );
  return result.seq;
}

// utilities/tenantPlugin.ts
init_context();
import mongoose7, { Schema as Schema6 } from "mongoose";
function tenantPlugin(schema2, options = {}) {
  const tenantField = options.tenantField || "organizationId";
  if (!schema2.path(tenantField)) {
    schema2.add({
      [tenantField]: {
        type: Schema6.Types.ObjectId,
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
    if (!mongoose7.Types.ObjectId.isValid(context.organizationId)) {
      return { apply: false };
    }
    return {
      apply: true,
      orgId: new mongoose7.Types.ObjectId(context.organizationId)
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
    schema2.pre(method, function() {
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
  schema2.pre("save", function() {
    const context = requestContextStore.getStore();
    if (context?.organizationId && !context.isRoot) {
      if (this.get(tenantField) && String(this.get(tenantField)) !== context.organizationId) throw new Error("Tenant ownership mismatch");
      if (!this.get(tenantField)) {
        this.set(tenantField, new mongoose7.Types.ObjectId(context.organizationId));
      }
    }
  });
  for (const method of ["updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace"]) {
    schema2.pre(method, function() {
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

// models/Patient.ts
var PatientSchema = new Schema7({
  userId: { type: Schema7.Types.ObjectId, ref: "User", unique: true, sparse: true, index: true },
  name: { type: String, trim: true, index: true },
  phone: { type: String, trim: true, index: true },
  email: { type: String, trim: true, index: true },
  accountType: { type: String, enum: ["self", "dependent", "walkin"], default: "self" },
  createdBy: { type: Schema7.Types.ObjectId, ref: "User" },
  organizationId: { type: Schema7.Types.ObjectId, ref: "Organization", index: true },
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
      appointmentId: { type: Schema7.Types.ObjectId, ref: "Appointment" },
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
var Patient = mongoose8.models.Patient || mongoose8.model("Patient", PatientSchema);

// models/Appointment.ts
import mongoose9, { Schema as Schema8 } from "mongoose";

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

// models/Appointment.ts
var AppointmentSchema = new Schema8({
  organizationId: { type: Schema8.Types.ObjectId, ref: "Organization", index: true },
  feedbackRevision: { type: Number, default: 0 },
  locationId: { type: Schema8.Types.ObjectId, ref: "Location", required: true, index: true },
  doctorId: { type: Schema8.Types.ObjectId, ref: "User", required: true, index: true },
  patientId: { type: Schema8.Types.ObjectId, ref: "Patient", required: true, index: true },
  bookedByUserId: { type: Schema8.Types.ObjectId, ref: "User", index: true },
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
  invoiceId: { type: Schema8.Types.ObjectId, ref: "Invoice", index: true },
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
  followUpForAppointmentId: { type: Schema8.Types.ObjectId, ref: "Appointment", index: true },
  followUpAppointmentId: { type: Schema8.Types.ObjectId, ref: "Appointment", index: true },
  followUpTaskId: { type: Schema8.Types.ObjectId, ref: "Task" },
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
  disruptionId: { type: Schema8.Types.ObjectId, ref: "DoctorDayOverride", index: true },
  // Missing on legacy records: attendance must be reviewed, never inferred from notes.
  disruptionOriginalStatus: { type: String, enum: ["checked-in", "confirmed", "pending", "pending_payment"] },
  originalDoctorId: { type: Schema8.Types.ObjectId, ref: "User", index: true },
  originalTokenNumber: { type: Number },
  transferredAt: { type: Date },
  transferredBy: { type: Schema8.Types.ObjectId, ref: "User" },
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
  priorityRescheduledFromId: { type: Schema8.Types.ObjectId, ref: "Appointment", index: true },
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
    recordedBy: { type: Schema8.Types.ObjectId, ref: "User" },
    recordedByName: { type: String }
  },
  // Emergency / STAT Protocol Fields
  isEmergency: { type: Boolean, default: false, index: true },
  emergencyTriagedAt: { type: Date },
  // Diagnostic Investigation Results from Lab
  investigationResults: [
    {
      testId: { type: Schema8.Types.ObjectId, ref: "LabTest" },
      testName: { type: String },
      value: { type: String },
      unit: { type: String },
      referenceRange: { type: String },
      isAbnormal: { type: Boolean, default: false },
      resultNotes: { type: String },
      attachmentUrl: { type: String, default: "" },
      resultedAt: { type: Date, default: Date.now },
      labOrderId: { type: Schema8.Types.ObjectId, ref: "LabOrder" }
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
var Appointment = mongoose9.model("Appointment", AppointmentSchema);

// services/PatientNotificationAuthority.ts
init_Location();
init_Organization();

// models/LabOrder.ts
import mongoose12, { Schema as Schema11 } from "mongoose";
var LabOrderSchema = new Schema11({
  // ─── Multi-Tenant Isolation ────────────────────────────────────
  organizationId: { type: Schema11.Types.ObjectId, ref: "Organization" },
  locationId: { type: Schema11.Types.ObjectId, ref: "Location", required: true, index: true },
  // ─── Encounter Aggregate Root Linkage ──────────────────────────
  // Optional for standalone laboratory orders
  encounterId: { type: Schema11.Types.ObjectId, ref: "Encounter", index: true, default: null },
  appointmentId: { type: Schema11.Types.ObjectId, ref: "Appointment", default: null },
  // ─── Clinical Context ──────────────────────────────────────────
  patientId: { type: Schema11.Types.ObjectId, ref: "Patient", required: true, index: true },
  testId: { type: Schema11.Types.ObjectId, ref: "LabTest", required: true, index: true },
  priority: { type: String, enum: ["routine", "urgent", "stat"], default: "routine" },
  clinicalReason: { type: String, default: "" },
  // Why the test was ordered
  // ─── Accountability (distinct roles) ───────────────────────────
  orderedBy: { type: Schema11.Types.ObjectId, ref: "User", index: true, default: null },
  collectedBy: { type: Schema11.Types.ObjectId, ref: "User", default: null },
  resultedBy: { type: Schema11.Types.ObjectId, ref: "User", default: null },
  // Primary Ordering Physician reference
  doctorId: { type: Schema11.Types.ObjectId, ref: "User", index: true },
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
var LabOrder = mongoose12.models.LabOrder || mongoose12.model("LabOrder", LabOrderSchema);

// services/PatientNotificationAuthority.ts
async function patientNotificationAudience(event) {
  const deny = { protected: true, allowed: false, appointmentId: void 0, orderId: void 0, patientId: void 0, locationId: void 0 };
  if (!event.targetUserId || !mongoose13.isValidObjectId(event.targetUserId)) return deny;
  const target = await User.findById(event.targetUserId).select("role isActive").lean();
  if (!target?.isActive) return deny;
  const appointmentId = event.metadata?.appointmentId || event.metadata?.context?.appointmentId;
  const patientId = event.metadata?.patientId || event.metadata?.context?.patientId;
  const orderId = event.metadata?.orderId;
  const care = ["patient", "clinical", "labs", "consent", "billing"].includes(event.category);
  if (!care && !appointmentId && !patientId && !orderId) return { ...deny, protected: false, allowed: true };
  const visit = mongoose13.isValidObjectId(appointmentId) ? await Appointment.findById(appointmentId).select("organizationId locationId patientId communicationRevision").lean() : null;
  const order = mongoose13.isValidObjectId(orderId) ? await LabOrder.findById(orderId).select("organizationId locationId patientId status deletedAt").lean() : null;
  if (orderId && (!order || order.deletedAt)) return deny;
  const source = order || visit;
  const patient = source ? await Patient.findById(source.patientId).select("userId").setOptions({ bypassTenantFilter: true }).lean() : mongoose13.isValidObjectId(patientId) ? await Patient.findById(patientId).select("userId").setOptions({ bypassTenantFilter: true }).lean() : null;
  const owner = patient?.userId?.toString() === event.targetUserId;
  if (!owner && !["patient", "family_member", "guest"].includes(target.role)) return { ...deny, protected: false, allowed: true };
  if (!owner || target.role === "family_member" || !event.organizationId || !source || String(source.organizationId) !== event.organizationId) return deny;
  if (patientId && String(source.patientId) !== String(patientId)) return deny;
  if (order && visit && (String(order.patientId) !== String(visit.patientId) || String(order.locationId) !== String(visit.locationId))) return deny;
  if (order && event.metadata?.context?.orderStatus !== void 0 && event.metadata.context.orderStatus !== order.status) return deny;
  const pinned = event.metadata?.context?.communicationRevision;
  if (pinned !== void 0 && (!visit || pinned !== (visit.communicationRevision || 0))) return deny;
  if (!await Organization.exists({ _id: source.organizationId, isActive: true }) || !await Location.exists({ _id: source.locationId, organizationId: source.organizationId, isActive: true })) return deny;
  return { protected: true, allowed: true, appointmentId: visit ? String(visit._id) : void 0, orderId: order ? String(order._id) : void 0, patientId: String(source.patientId), locationId: String(source.locationId) };
}

// utilities/manualNotificationContent.ts
function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// notifications/workers/NotificationDeliveryWorker.ts
var LOCK_DURATION_MS = 6e4;
var NotificationDeliveryWorker = class {
  loop = new WorkerLoop();
  getProgress() {
    return this.loop.progress();
  }
  stopped = false;
  start(intervalMs = 500) {
    this.stopped = false;
    this.loop.start(() => this.processBatch(Number(process.env.MAX_NOTIFICATION_CONCURRENCY) || 5), intervalMs);
  }
  async stop() {
    this.stopped = true;
    await this.loop.stop();
  }
  async processBatch(batchSize = 15) {
    if (this.stopped) return { processed: 0 };
    const results = await Promise.allSettled(
      Array.from({ length: batchSize }, () => this.processOne())
    );
    return { processed: results.filter((result) => result.status === "fulfilled" && result.value).length };
  }
  async processOne() {
    const now = /* @__PURE__ */ new Date();
    const lockedBy = crypto3.randomUUID();
    const job = await NotificationDelivery.findOneAndUpdate(
      {
        channel: "email",
        status: { $in: ["pending", "retrying", "processing"] },
        nextAttemptAt: { $lte: now },
        $or: [
          { lockedUntil: { $exists: false } },
          { lockedUntil: null },
          { lockedUntil: { $lte: now } }
        ]
      },
      {
        $set: {
          status: "processing",
          lockedAt: now,
          lockedUntil: new Date(now.getTime() + LOCK_DURATION_MS),
          lockedBy
        },
        $inc: { attempts: 1 }
      },
      { sort: { nextAttemptAt: 1, createdAt: 1 }, returnDocument: "after" }
    );
    if (!job) return false;
    const heartbeat = setInterval(() => {
      void NotificationDelivery.updateOne({ _id: job._id, status: "processing", lockedBy }, { $set: { lockedUntil: new Date(Date.now() + LOCK_DURATION_MS) } }).catch(() => console.error("[NotificationDeliveryWorker] Lease renewal failed"));
    }, 2e4);
    heartbeat.unref?.();
    try {
      const notification = await Notification.findById(job.notificationId).lean();
      const audience = notification ? await patientNotificationAudience({ eventType: notification.type, category: notification.category, organizationId: notification.organizationId?.toString(), targetUserId: notification.targetUser.toString(), metadata: notification.metadata }) : { protected: true, allowed: false };
      if (audience.protected || !audience.allowed) {
        await NotificationDelivery.updateOne({ _id: job._id, status: "processing", lockedBy }, { $set: { status: "suppressed", error: "PATIENT_EXTERNAL_REQUIRES_COMMUNICATION_DISPATCH" }, $unset: { lockedAt: 1, lockedUntil: 1, lockedBy: 1, nextAttemptAt: 1 } });
        return true;
      }
      const sent = await emailProvider.sendEmail({
        to: job.recipient,
        subject: job.title || "Notification Alert",
        html: `<p>${escapeHtml(job.message || "")}</p>`,
        text: job.message || ""
      });
      if (!sent) throw new Error("Email provider declined delivery");
      await NotificationDelivery.updateOne(
        { _id: job._id, status: "processing", lockedBy },
        {
          $set: { status: "sent", sentAt: /* @__PURE__ */ new Date() },
          $unset: { lockedAt: 1, lockedUntil: 1, lockedBy: 1, nextAttemptAt: 1 }
        }
      );
    } catch (error) {
      const retry = (job.attempts || 1) < (job.maxAttempts || 5);
      const retryDelayMs = Math.pow(2, Math.max(0, (job.attempts || 1) - 1)) * 1e3;
      await NotificationDelivery.updateOne(
        { _id: job._id, status: "processing", lockedBy },
        retry ? {
          $set: {
            status: "retrying",
            error: error?.message || "Delivery failed",
            nextAttemptAt: new Date(Date.now() + retryDelayMs)
          },
          $unset: { lockedAt: 1, lockedUntil: 1, lockedBy: 1 }
        } : {
          $set: {
            status: "failed",
            error: error?.message || "Exhausted maximum retry attempts",
            sentAt: /* @__PURE__ */ new Date()
          },
          $unset: { lockedAt: 1, lockedUntil: 1, lockedBy: 1, nextAttemptAt: 1 }
        }
      );
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }
};
var notificationDeliveryWorker = new NotificationDeliveryWorker();

// workers/notificationDeliveryWorker.ts
verifyEnv();
await init_db().then(() => db_exports);
notificationDeliveryWorker.start();
console.log("Notification delivery worker started");
var healthServer = startWorkerHealthServer({ workerName: "notificationDeliveryWorker", defaultPort: 5001, onProgress: () => notificationDeliveryWorker.getProgress() });
var shutdown = async () => {
  await notificationDeliveryWorker.stop();
  await healthServer.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
