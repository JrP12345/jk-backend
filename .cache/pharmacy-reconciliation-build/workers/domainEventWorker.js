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

// models/User.ts
import mongoose6, { Schema as Schema5 } from "mongoose";
var AUTH_METHOD_OPTIONS, UserSchema, User;
var init_User = __esm({
  "models/User.ts"() {
    "use strict";
    AUTH_METHOD_OPTIONS = ["email_password", "phone_otp", "email_otp", "both"];
    UserSchema = new Schema5({
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

// models/RefreshToken.ts
import mongoose7, { Schema as Schema6 } from "mongoose";
var ImpersonationSchema, RefreshTokenSchema, RefreshToken;
var init_RefreshToken = __esm({
  "models/RefreshToken.ts"() {
    "use strict";
    ImpersonationSchema = new Schema6({
      id: { type: Schema6.Types.ObjectId, ref: "User", required: true },
      email: { type: String },
      name: { type: String },
      originalRole: { type: String, default: "root" }
    }, { _id: false });
    RefreshTokenSchema = new Schema6({
      userId: { type: Schema6.Types.ObjectId, ref: "User", required: true },
      organizationId: { type: Schema6.Types.ObjectId, ref: "Organization", index: true },
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
      bookingPatientId: { type: Schema6.Types.ObjectId, ref: "Patient" },
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
    RefreshToken = mongoose7.model("RefreshToken", RefreshTokenSchema);
  }
});

// utilities/keys.ts
import crypto6 from "node:crypto";
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
  const { publicKey, privateKey } = crypto6.generateKeyPairSync("rsa", {
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
import mongoose8, { Schema as Schema7 } from "mongoose";
var OrgMemberSchema, OrgMember;
var init_OrgMember = __esm({
  "models/OrgMember.ts"() {
    "use strict";
    OrgMemberSchema = new Schema7({
      userId: { type: Schema7.Types.ObjectId, ref: "User", required: true, index: true },
      organizationId: { type: Schema7.Types.ObjectId, ref: "Organization", required: true, index: true },
      role: { type: String, required: true },
      locationAccess: { type: new Schema7({
        mode: { type: String, enum: ["all", "selected"], required: true },
        locationIds: [{ type: Schema7.Types.ObjectId, ref: "Location" }]
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
    OrgMember = mongoose8.model("OrgMember", OrgMemberSchema);
  }
});

// services/StaffMfaPolicy.ts
var init_StaffMfaPolicy = __esm({
  "services/StaffMfaPolicy.ts"() {
    "use strict";
  }
});

// models/Organization.ts
import mongoose9, { Schema as Schema8 } from "mongoose";
var OrganizationSchema, Organization;
var init_Organization = __esm({
  "models/Organization.ts"() {
    "use strict";
    OrganizationSchema = new Schema8({
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
    Organization = mongoose9.model("Organization", OrganizationSchema);
  }
});

// utilities/logger.ts
import crypto7 from "node:crypto";
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
          traceId: context.traceId || crypto7.randomUUID(),
          spanId: context.spanId || crypto7.randomUUID().substring(0, 16),
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
import mongoose10 from "mongoose";
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
import mongoose11, { Schema as Schema9 } from "mongoose";
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
        inventoryMode: { type: String, enum: ["tracked", "billing_only"], default: "tracked", required: true },
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
        if (ret.pharmacyCapability) ret.pharmacyCapability = { enabled: ret.pharmacyCapability.enabled, revision: ret.pharmacyCapability.revision, inventoryMode: ret.pharmacyCapability.inventoryMode };
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    });
    Location = mongoose11.model("Location", LocationSchema);
  }
});

// models/Role.ts
import mongoose12, { Schema as Schema10 } from "mongoose";
var RoleSchema, Role;
var init_Role = __esm({
  "models/Role.ts"() {
    "use strict";
    RoleSchema = new Schema10({
      name: { type: String, required: true, index: true },
      organizationId: { type: Schema10.Types.ObjectId, ref: "Organization", default: null, index: true },
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
    Role = mongoose12.model("Role", RoleSchema);
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
import mongoose13 from "mongoose";
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
  const orgFilter = organizationId && mongoose13.Types.ObjectId.isValid(organizationId) ? [{ organizationId: new mongoose13.Types.ObjectId(organizationId) }, { organizationId: null }] : [{ organizationId: null }];
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
import crypto8 from "node:crypto";
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
function getActiveSseConnectionsCount() {
  let count = 0;
  sseStreamsMap.forEach((streams) => {
    count += streams.size;
  });
  return count;
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
function broadcastRealtimeNotification(userId, payload) {
  sendToUserLocally(userId, payload);
  bufferCriticalAlert(`user:${userId}`, payload);
  if (redisClient) {
    const envelope = {
      originNodeId: NODE_ID,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      payload
    };
    redisClient.publish(`user_notifications:${userId}`, JSON.stringify(envelope)).catch((err) => {
      console.warn("[Redis PubSub Warning] Failed to publish notification to Redis:", safeError(err));
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
    NODE_ID = process.env.POD_NAME || process.env.HOSTNAME || `node-${crypto8.randomUUID()}`;
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

// utilities/transaction.ts
import mongoose18 from "mongoose";
async function withTransaction(fn, options) {
  const inherited = mongoose18.transactionAsyncLocalStorage?.getStore()?.session;
  if (inherited?.inTransaction()) return fn(inherited);
  const topologyType = mongoose18.connection?.client?.topology?.description?.type;
  const isStandalone = topologyType === "Single" || topologyType === "Unknown";
  if (isStandalone) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Multi-document ACID transactions require a MongoDB Replica Set in production");
    }
    return fn(null);
  }
  return mongoose18.connection.transaction(async (session) => fn(session), options);
}
var init_transaction = __esm({
  "utilities/transaction.ts"() {
    "use strict";
    mongoose18.set("transactionAsyncLocalStorage", true);
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
import mongoose35, { Schema as Schema29 } from "mongoose";
var AuditCheckpointSchema, AuditCheckpoint;
var init_AuditCheckpoint = __esm({
  "models/AuditCheckpoint.ts"() {
    "use strict";
    AuditCheckpointSchema = new Schema29({
      organizationId: { type: Schema29.Types.ObjectId, ref: "Organization", index: true, default: null },
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
    AuditCheckpoint = mongoose35.models.AuditCheckpoint || mongoose35.model("AuditCheckpoint", AuditCheckpointSchema);
  }
});

// models/AuditChainHead.ts
import mongoose36, { Schema as Schema30 } from "mongoose";
var schema5, AuditChainHead;
var init_AuditChainHead = __esm({
  "models/AuditChainHead.ts"() {
    "use strict";
    schema5 = new Schema30({
      _id: { type: String },
      sequence: { type: Number, required: true },
      hash: { type: String, required: true }
    }, { versionKey: false });
    AuditChainHead = mongoose36.models.AuditChainHead || mongoose36.model("AuditChainHead", schema5);
  }
});

// utilities/auditCrypto.ts
import crypto12 from "node:crypto";
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
  return crypto12.createHash("sha256").update(payload, "utf8").digest("hex");
}
var GENESIS_HASH;
var init_auditCrypto = __esm({
  "utilities/auditCrypto.ts"() {
    "use strict";
    GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";
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
import mongoose37 from "mongoose";
import crypto13 from "node:crypto";
async function recordAuditLog(input, options) {
  if (input.organizationId === void 0 && requestContextStore.getStore()?.organizationId) input = { ...input, organizationId: requestContextStore.getStore().organizationId };
  const orgKey = input.organizationId ? String(input.organizationId) : "GLOBAL";
  const inherited = options?.session || mongoose37.transactionAsyncLocalStorage?.getStore()?.session;
  const append = async (session) => {
    const opts = session ? { session } : {};
    const orgFilter = input.organizationId ? new mongoose37.Types.ObjectId(String(input.organizationId)) : null;
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
  const topology = mongoose37.connection.client?.topology?.description?.type;
  if (topology === "Single" || topology === "Unknown") {
    if (process.env.NODE_ENV === "production") throw new Error("Audit append requires a transaction-capable MongoDB deployment");
    return withChainLock(orgKey, () => append(null));
  }
  return withTransaction(append);
}
async function verifyAuditChainIntegrity(organizationId) {
  const orgFilter = organizationId ? { organizationId: new mongoose37.Types.ObjectId(organizationId) } : { organizationId: null };
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
    const checkpointOrgFilter = organizationId ? { organizationId: new mongoose37.Types.ObjectId(organizationId) } : { organizationId: null };
    const checkpoint = await AuditCheckpoint.findOne(checkpointOrgFilter).sort({ archivedUpToSequence: -1 }).lean();
    if (checkpoint) {
      if (checkpoint.signature && checkpoint.checkpointHash) {
        const secretKey = process.env.ENCRYPTION_SECRET || process.env.JWT_SECRET || "ekavyu-audit-anchor-secret";
        const expectedSig = crypto13.createHmac("sha256", secretKey).update(checkpoint.checkpointHash).digest("hex");
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
import mongoose38, { Schema as Schema31 } from "mongoose";
var AuditLogSchema, AuditLog;
var init_AuditLog = __esm({
  "models/AuditLog.ts"() {
    "use strict";
    init_auditRedaction();
    AuditLogSchema = new Schema31({
      userId: { type: Schema31.Types.ObjectId, ref: "User", index: true },
      organizationId: { type: Schema31.Types.ObjectId, ref: "Organization", default: null },
      action: { type: String, required: true, index: true },
      // e.g. "APPOINTMENT_CREATE", "VIP_OVERRIDE", "PHI_READ_ACCESS", "DPDP_PII_ANONYMIZED"
      targetId: { type: Schema31.Types.ObjectId },
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
      details: { type: Schema31.Types.Mixed },
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
    AuditLog = mongoose38.models.AuditLog || mongoose38.model("AuditLog", AuditLogSchema);
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
function auditPlugin(schema9) {
  schema9.post("save", async function(doc) {
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
  schema9.post("findOneAndUpdate", async function(res) {
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
  schema9.post("findOneAndDelete", async function(res) {
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
import mongoose45 from "mongoose";
var MONGODB_URI, connectDB, db_default;
var init_db = __esm({
  async "db.ts"() {
    "use strict";
    init_safeError();
    init_latencyHistogram();
    init_auditPlugin();
    init_scalability();
    mongoose45.plugin(auditPlugin);
    MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/ekavyu_dev";
    connectDB = async () => {
      try {
        const maxPoolSize = Number(process.env.MONGODB_MAX_POOL_SIZE) || DB_POOL_SIZE;
        const configuredMin = Number(process.env.MONGODB_MIN_POOL_SIZE ?? 2);
        const minPoolSize = Number.isInteger(configuredMin) && configuredMin >= 0 ? configuredMin : 2;
        await mongoose45.connect(MONGODB_URI, {
          maxPoolSize,
          minPoolSize,
          serverSelectionTimeoutMS: DB_SERVER_SELECTION_TIMEOUT_MS,
          socketTimeoutMS: DB_SOCKET_TIMEOUT_MS,
          waitQueueTimeoutMS: 5e3,
          maxIdleTimeMS: 6e4,
          monitorCommands: true
        });
        const client = mongoose45.connection.getClient();
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
    db_default = mongoose45;
  }
});

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

// services/DomainEventDeliveryWorker.ts
import crypto5 from "node:crypto";

// models/DomainEventOutbox.ts
init_scalability();
import mongoose, { Schema } from "mongoose";
var DomainEventOutboxSchema = new Schema(
  {
    idempotencyKey: { type: String, required: true, unique: true },
    eventType: { type: String, required: true, index: true },
    eventVersion: { type: Number, default: 1 },
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
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
    lastReplayedBy: { type: Schema.Types.ObjectId, ref: "User" }
  },
  { timestamps: true }
);
DomainEventOutboxSchema.index({ status: 1, nextAttemptAt: 1, lockedUntil: 1 });
var DomainEventOutbox = mongoose.models.DomainEventOutbox || mongoose.model("DomainEventOutbox", DomainEventOutboxSchema);

// services/DomainEventOutboxService.ts
import crypto2 from "node:crypto";
import mongoose2 from "mongoose";

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
var ENCRYPTION_SECRET = resolveEncryptionSecret();
var MASTER_KEY = crypto.scryptSync(ENCRYPTION_SECRET, "healthos-fle-salt-2026", 32);
var BLIND_INDEX_KEY = crypto.scryptSync(ENCRYPTION_SECRET, "healthos-blind-index-salt-2026", 32);
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

// services/DomainEventOutboxService.ts
function getDomainEventIdempotencyKey(options) {
  if (options.idempotencyKey) return options.idempotencyKey;
  if (options.payload?.eventId) return options.payload.eventId;
  return `domain:${options.eventType}:${crypto2.randomUUID()}`;
}
async function enqueueDomainEvent(options, session) {
  const idempotencyKey = getDomainEventIdempotencyKey(options);
  const orgId = options.organizationId ? typeof options.organizationId === "string" ? mongoose2.Types.ObjectId.isValid(options.organizationId) ? new mongoose2.Types.ObjectId(options.organizationId) : void 0 : options.organizationId : void 0;
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
function readEncryptedDomainEvent(row) {
  if (!row.payloadCiphertext) {
    throw new Error("Domain event payload is missing or was not selected");
  }
  return JSON.parse(decryptField(row.payloadCiphertext));
}

// events/eventBus.ts
import { EventEmitter } from "events";
import crypto4 from "node:crypto";

// platform/events/DomainEventBus.ts
init_safeError();

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

// platform/events/DomainEventBus.ts
var DomainEventBus = class {
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
var domainEventBus = new DomainEventBus();

// events/eventBus.ts
var TypedEventBus = class extends EventEmitter {
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
var eventBus = new TypedEventBus();

// services/DomainEventDeliveryWorker.ts
init_scalability();
var LOCK_DURATION_MS = Number(process.env.DOMAIN_EVENT_LOCK_MS) || 6e4;
var BASE_RETRY_DELAY_MS = 1e3;
var MAX_RETRY_DELAY_MS = 3e5;
var DomainEventDeliveryWorker = class {
  loop = new WorkerLoop();
  getProgress() {
    return this.loop.progress();
  }
  stopped = false;
  inBackpressure = false;
  start(intervalMs = DOMAIN_EVENT_WORKER_POLL_MS) {
    this.stopped = false;
    this.loop.start(() => this.processBatch(DOMAIN_EVENT_WORKER_BATCH_SIZE), intervalMs);
  }
  async stop() {
    this.stopped = true;
    await this.loop.stop();
  }
  async processBatch(batchSize = DOMAIN_EVENT_WORKER_BATCH_SIZE) {
    if (this.stopped) return { processed: 0 };
    const results = await Promise.allSettled(Array.from({ length: batchSize }, () => this.processOne()));
    return { processed: results.filter((result) => result.status === "fulfilled" && result.value).length };
  }
  async processOne() {
    const now = /* @__PURE__ */ new Date();
    const lockedBy = crypto5.randomUUID();
    const eventRow = await DomainEventOutbox.findOneAndUpdate(
      {
        status: { $in: ["pending", "retrying", "processing"] },
        nextAttemptAt: { $lte: now },
        $or: [
          { lockedUntil: { $exists: false } },
          { lockedUntil: null },
          { lockedUntil: { $lte: now } }
        ]
      },
      {
        $set: { status: "processing", lockedAt: now, lockedUntil: new Date(now.getTime() + LOCK_DURATION_MS), lockedBy },
        $inc: { attempts: 1 }
      },
      { sort: { nextAttemptAt: 1, createdAt: 1 }, returnDocument: "after" }
    ).select("+payloadCiphertext");
    if (!eventRow) return false;
    const heartbeat = setInterval(() => {
      void DomainEventOutbox.updateOne({ _id: eventRow._id, status: "processing", lockedBy }, { $set: { lockedUntil: new Date(Date.now() + LOCK_DURATION_MS) } }).catch(() => console.error("[DomainEventWorker] Lease renewal failed"));
    }, 2e4);
    heartbeat.unref?.();
    try {
      let payload;
      try {
        payload = readEncryptedDomainEvent(eventRow);
        if (!payload || !payload.eventType) {
          throw new Error("Poison event: missing deserialized payload or eventType");
        }
      } catch (deserializationError) {
        await DomainEventOutbox.updateOne(
          { _id: eventRow._id, status: "processing", lockedBy },
          {
            $set: {
              status: "dead_letter",
              error: `Poison event deserialization failure: ${deserializationError?.message || "Corrupted payload"}`,
              sentAt: /* @__PURE__ */ new Date()
            },
            $unset: { lockedAt: 1, lockedUntil: 1, lockedBy: 1, nextAttemptAt: 1 }
          }
        );
        return true;
      }
      try {
        await eventBus.dispatch({ ...payload, eventId: payload.eventId || eventRow.idempotencyKey });
        await DomainEventOutbox.updateOne(
          { _id: eventRow._id, status: "processing", lockedBy },
          {
            $set: { status: "sent", sentAt: /* @__PURE__ */ new Date() },
            $unset: { lockedAt: 1, lockedUntil: 1, lockedBy: 1, nextAttemptAt: 1 }
          }
        );
      } catch (error) {
        const retry = eventRow.attempts < eventRow.maxAttempts;
        if (retry) {
          const exponentialDelay = Math.min(
            MAX_RETRY_DELAY_MS,
            BASE_RETRY_DELAY_MS * Math.pow(2, Math.max(0, eventRow.attempts - 1))
          );
          const jitter = Math.floor(Math.random() * (exponentialDelay * 0.25));
          const delayMs = Math.min(MAX_RETRY_DELAY_MS, exponentialDelay + jitter);
          await DomainEventOutbox.updateOne(
            { _id: eventRow._id, status: "processing", lockedBy },
            {
              $set: {
                status: "retrying",
                error: error?.message || "Domain event dispatch failed",
                nextAttemptAt: new Date(Date.now() + delayMs)
              },
              $unset: { lockedAt: 1, lockedUntil: 1, lockedBy: 1 }
            }
          );
        } else {
          await DomainEventOutbox.updateOne(
            { _id: eventRow._id, status: "processing", lockedBy },
            {
              $set: {
                status: "dead_letter",
                error: `Max retry attempts (${eventRow.maxAttempts}) exceeded: ${error?.message || "Dispatch failed"}`,
                sentAt: /* @__PURE__ */ new Date()
              },
              $unset: { lockedAt: 1, lockedUntil: 1, lockedBy: 1, nextAttemptAt: 1 }
            }
          );
        }
      }
      return true;
    } finally {
      clearInterval(heartbeat);
    }
  }
  /**
   * Real-time metrics for monitoring queue depth, age, and dead letters.
   */
  async getMetrics() {
    const stats = await DomainEventOutbox.aggregate([
      { $match: { status: { $in: ["pending", "retrying", "processing", "failed", "dead_letter"] } } },
      { $limit: 5e3 },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          totalAttempts: { $sum: "$attempts" }
        }
      }
    ]).option({ maxTimeMS: 2e3 });
    const counts = {
      pending: 0,
      retrying: 0,
      processing: 0,
      failed: 0,
      dead_letter: 0,
      sent: 0
    };
    let totalAttempts = 0;
    for (const item of stats) {
      if (item._id && typeof counts[item._id] === "number") {
        counts[item._id] = item.count;
      }
      totalAttempts += item.totalAttempts || 0;
    }
    const oldestEvent = await DomainEventOutbox.findOne(
      { status: { $in: ["pending", "retrying"] } },
      { createdAt: 1 }
    ).sort({ createdAt: 1 }).lean();
    const oldestEventAgeMs = oldestEvent?.createdAt ? Math.max(0, Date.now() - new Date(oldestEvent.createdAt).getTime()) : null;
    this.inBackpressure = counts.pending >= WORKER_BACKPRESSURE_PENDING_LIMIT || oldestEventAgeMs !== null && oldestEventAgeMs >= WORKER_BACKPRESSURE_QUEUE_AGE_SEC * 1e3;
    return {
      oldestEventAgeMs,
      countsCapped: stats.reduce((sum, item) => sum + item.count, 0) >= 5e3,
      pendingCount: counts.pending,
      retryingCount: counts.retrying,
      processingCount: counts.processing,
      failures: counts.failed,
      deadLetterCount: counts.dead_letter,
      sentCount: counts.sent,
      totalAttempts,
      inBackpressure: this.inBackpressure
    };
  }
};
var domainEventDeliveryWorker = new DomainEventDeliveryWorker();

// notifications/services/NotificationService.ts
import crypto11 from "node:crypto";
import mongoose30 from "mongoose";

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

// models/NotificationPreference.ts
import mongoose4, { Schema as Schema3 } from "mongoose";
var NotificationPreferenceSchema = new Schema3({
  userId: { type: Schema3.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
  organizationId: { type: Schema3.Types.ObjectId, ref: "Organization" },
  channels: {
    email: { type: Boolean, default: true },
    inApp: { type: Boolean, default: true }
  },
  categories: {
    auth: { type: Boolean, default: true },
    organization: { type: Boolean, default: true },
    team: { type: Boolean, default: true },
    task: { type: Boolean, default: true },
    patient: { type: Boolean, default: true },
    billing: { type: Boolean, default: true },
    security: { type: Boolean, default: true },
    system: { type: Boolean, default: true }
  },
  updatedAt: { type: Date, default: Date.now }
});
NotificationPreferenceSchema.virtual("id").get(function() {
  return this._id.toHexString();
});
NotificationPreferenceSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});
var NotificationPreference = mongoose4.model(
  "NotificationPreference",
  NotificationPreferenceSchema
);

// models/NotificationDelivery.ts
import mongoose5, { Schema as Schema4 } from "mongoose";
var NotificationDeliverySchema = new Schema4({
  notificationId: { type: Schema4.Types.ObjectId, ref: "Notification", required: true, index: true },
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
  metadata: { type: Schema4.Types.Mixed },
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
  lastReplayedBy: { type: Schema4.Types.ObjectId, ref: "User" },
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
var NotificationDelivery = mongoose5.model(
  "NotificationDelivery",
  NotificationDeliverySchema
);

// notifications/services/NotificationService.ts
init_User();
init_websocket();

// notifications/services/NotificationQueue.ts
import crypto9 from "node:crypto";
var NotificationQueueManager = class {
  async enqueue(job) {
    const recipientDigest = crypto9.createHash("sha256").update(job.recipient.trim().toLowerCase()).digest("hex");
    const idempotencyKey = `notification:${job.notificationId}:${job.channel}:${recipientDigest}`;
    try {
      const delivery = await NotificationDelivery.findOneAndUpdate(
        { idempotencyKey },
        {
          $setOnInsert: {
            notificationId: job.notificationId,
            channel: job.channel,
            recipient: job.recipient,
            title: job.title,
            message: job.message,
            idempotencyKey,
            status: "pending",
            attempts: 0,
            maxAttempts: 5,
            nextAttemptAt: /* @__PURE__ */ new Date()
          }
        },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
      );
      return delivery._id.toString();
    } catch (error) {
      if (error?.code === 11e3) {
        const existing = await NotificationDelivery.findOne({ idempotencyKey }).select("_id");
        if (existing) return existing._id.toString();
      }
      throw error;
    }
  }
  async getQueueDepth() {
    return NotificationDelivery.countDocuments({
      channel: "email",
      status: { $in: ["pending", "retrying", "processing"] }
    });
  }
  async getStats() {
    const rows = await NotificationDelivery.aggregate([
      { $match: { channel: "email" } },
      { $group: { _id: "$status", count: { $sum: 1 } } }
    ]);
    const byStatus = Object.fromEntries(rows.map((row) => [row._id, row.count]));
    return {
      processedCount: byStatus.sent || 0,
      failureCount: byStatus.failed || 0,
      pendingCount: (byStatus.pending || 0) + (byStatus.retrying || 0) + (byStatus.processing || 0)
    };
  }
};
var notificationQueue = new NotificationQueueManager();

// notifications/services/NotificationRuleEngine.ts
var NotificationRuleEngineManager = class {
  defaultRules = [
    {
      ruleName: "Critical Escalation Rule",
      severity: "error",
      priority: "urgent",
      channels: {
        inApp: true,
        email: true
      }
    },
    {
      ruleName: "Security Alert Rule",
      category: "security",
      channels: {
        inApp: true,
        email: true
      }
    },
    {
      ruleName: "Standard System Event Rule",
      category: "system",
      channels: {
        inApp: true,
        email: false
      }
    }
  ];
  /**
   * Evaluate routing channels based on event severity, category, and priority
   */
  evaluateRouting(event, userPreferencesChannels) {
    let effectiveChannels = {
      inApp: userPreferencesChannels?.inApp !== false,
      email: userPreferencesChannels?.email === true
    };
    const matchingRule = this.defaultRules.find((rule) => {
      if (rule.severity && rule.severity !== event.severity) return false;
      if (rule.priority && rule.priority !== event.priority) return false;
      if (rule.category && rule.category !== event.category) return false;
      return true;
    });
    if (matchingRule) {
      effectiveChannels = {
        inApp: effectiveChannels.inApp && matchingRule.channels.inApp,
        email: effectiveChannels.email || matchingRule.channels.email && userPreferencesChannels?.email !== false
      };
    }
    return effectiveChannels;
  }
};
var notificationRuleEngine = new NotificationRuleEngineManager();

// models/Task.ts
import mongoose14, { Schema as Schema11 } from "mongoose";
var TaskSchema = new Schema11({
  organizationId: { type: Schema11.Types.ObjectId, ref: "Organization", index: true },
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
  assignedTo: { type: Schema11.Types.ObjectId, ref: "User", index: true },
  kind: { type: String, default: "general", index: true },
  patientId: { type: Schema11.Types.ObjectId, ref: "Patient" },
  locationId: { type: Schema11.Types.ObjectId, ref: "Location" },
  revision: { type: Number, default: 0 },
  dedupeKey: String,
  inquiryId: { type: Schema11.Types.ObjectId, ref: "Inquiry" },
  appointmentId: { type: Schema11.Types.ObjectId, ref: "Appointment" },
  orderId: { type: Schema11.Types.ObjectId, ref: "LabOrder" },
  sourceRevision: Number,
  snoozedUntil: Date,
  completedAt: Date,
  outcome: { type: String, maxlength: 60 },
  needsAssignment: { type: Boolean, default: false },
  resultAppointmentId: { type: Schema11.Types.ObjectId, ref: "Appointment" },
  followUpReview: { type: String, enum: ["ambiguous", "legacy"] },
  createdBy: { type: Schema11.Types.ObjectId, ref: "User", required: function() {
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
var TaskModel = mongoose14.model("Task", TaskSchema);

// services/CrmNotificationAuthority.ts
init_Location();
init_Organization();

// services/CrmAssignmentService.ts
init_OrgMember();
init_User();

// services/LocationAccessService.ts
init_OrgMember();

// models/DoctorAssignment.ts
import mongoose15, { Schema as Schema12 } from "mongoose";
var DoctorAssignmentSchema = new Schema12({
  doctorId: { type: Schema12.Types.ObjectId, ref: "User", required: true, index: true },
  locationId: { type: Schema12.Types.ObjectId, ref: "Location", required: true, index: true },
  organizationId: { type: Schema12.Types.ObjectId, ref: "Organization", required: true, index: true },
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
var DoctorAssignment = mongoose15.model("DoctorAssignment", DoctorAssignmentSchema);

// models/Receptionist.ts
import mongoose16, { Schema as Schema13 } from "mongoose";
var ReceptionistSchema = new Schema13({
  userId: { type: Schema13.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
  organizationId: { type: Schema13.Types.ObjectId, ref: "Organization", required: true, index: true },
  locationId: { type: Schema13.Types.ObjectId, ref: "Location", index: true },
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
var Receptionist = mongoose16.model("Receptionist", ReceptionistSchema);

// services/LocationAccessService.ts
init_Location();
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

// services/CommandReceiptService.ts
import crypto10 from "node:crypto";
import mongoose19 from "mongoose";

// models/OperationReceipt.ts
import mongoose17, { Schema as Schema14 } from "mongoose";
var schema = new Schema14({
  scope: { type: String, required: true },
  key: { type: String, required: true },
  requestHash: { type: String, required: true },
  resultId: { type: Schema14.Types.ObjectId },
  responseCiphertext: { type: String, select: false, set: encryptField },
  createdAt: { type: Date, default: Date.now }
});
schema.index({ scope: 1, key: 1 }, { unique: true });
var OperationReceipt = mongoose17.models.OperationReceipt || mongoose17.model("OperationReceipt", schema);

// services/CommandReceiptService.ts
init_transaction();
var CommandError = class extends Error {
  statusCode;
  details;
  constructor(statusCode, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
};
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function commandHash(payload) {
  return crypto10.createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
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
    const topology = mongoose19.connection?.client?.topology?.description?.type;
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

// services/CrmAssignmentService.ts
init_permissions();
async function validateCrmAssignee(userId, organizationId, locationId, permission = "VIEW_CRM") {
  const member = await OrgMember.findOne({ userId, organizationId }).lean();
  if (!member || ["patient", "family_member", "guest", "root"].includes(member.role) || !await User.exists({ _id: userId, isActive: true })) throw new CommandError(400, "Choose an active staff member in this workspace");
  const grant = await resolveStaffLocationGrant(userId, organizationId, member.role, true);
  if (grant !== void 0 && !grant.includes(locationId)) throw new CommandError(400, "The assignee does not have access to this branch");
  const permissions = await getEffectivePermissions(member.role, organizationId, 1, true);
  if (!permissions.has("VIEW_CRM") || !permissions.has(permission)) throw new CommandError(400, "The assignee does not have permission to work on this CRM item");
  return member;
}

// services/CrmReminderService.ts
init_Organization();
init_Location();

// services/CrmEntitlementService.ts
init_Organization();

// models/Subscription.ts
import mongoose20, { Schema as Schema16 } from "mongoose";

// models/commercialQuoteSchema.ts
import { Schema as Schema15 } from "mongoose";
var quantity = { type: Number, min: 0, required: true, validate: Number.isSafeInteger };
var rates = new Schema15({
  clinicPaise: quantity,
  pharmacyPaise: quantity,
  pharmacyAddonPaise: quantity,
  extraDoctorPaise: quantity,
  additionalPharmacyPaise: { type: Number, min: 0, validate: Number.isSafeInteger }
}, { _id: false });
var commercialPricingSchema = new Schema15({
  revision: { ...quantity, min: 1 },
  monthly: { type: rates, required: true },
  annual: { type: rates, default: void 0 },
  taxMode: { type: String, enum: ["inclusive", "exclusive"], required: true },
  taxRateBps: { ...quantity, max: 1e4 },
  includedDoctors: quantity,
  doctorsPerAdditionalClinic: quantity
}, { _id: false });
var location = new Schema15({ locationId: { type: String, required: true }, clinic: { type: Boolean, required: true }, pharmacy: { type: Boolean, required: true }, capabilityRevision: quantity }, { _id: false });
var commercialQuoteSchema = new Schema15({
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
  lines: { type: [new Schema15({
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

// models/Subscription.ts
var SubscriptionSchema = new Schema16({
  organizationId: { type: Schema16.Types.ObjectId, ref: "Organization", required: true, index: true },
  planId: { type: Schema16.Types.ObjectId, ref: "SaaSPlan", required: true, index: true },
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
  manualGrantedBy: { type: Schema16.Types.ObjectId, ref: "User", default: null },
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
    paymentId: { type: Schema16.Types.ObjectId, ref: "SubscriptionPayment", default: null },
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
var Subscription = mongoose20.model("Subscription", SubscriptionSchema);

// services/CrmEntitlementService.ts
async function crmEntitlementActive(organizationId, now = /* @__PURE__ */ new Date()) {
  const [org, subscription] = await Promise.all([
    Organization.findOne({ _id: organizationId, isActive: true, status: "active" }).select("_id").lean(),
    Subscription.findOne({ organizationId }).sort({ createdAt: 1, _id: 1 }).select("status trialEndsAt currentPeriodEnd").lean()
  ]);
  return !!org && !!subscription && (subscription.status === "active" && subscription.currentPeriodEnd > now || subscription.status === "trialing" && subscription.trialEndsAt > now);
}

// models/WorkerLease.ts
import mongoose21, { Schema as Schema17 } from "mongoose";
var WorkerLeaseSchema = new Schema17(
  {
    name: { type: String, required: true, unique: true, immutable: true },
    holderId: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    fenceRevision: { type: Number, default: 0 }
  },
  { timestamps: true }
);
WorkerLeaseSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
var WorkerLease = mongoose21.models.WorkerLease || mongoose21.model(
  "WorkerLease",
  WorkerLeaseSchema
);

// models/CrmActivity.ts
import mongoose23, { Schema as Schema19 } from "mongoose";

// utilities/tenantPlugin.ts
init_context();
import mongoose22, { Schema as Schema18 } from "mongoose";
function tenantPlugin(schema9, options = {}) {
  const tenantField = options.tenantField || "organizationId";
  if (!schema9.path(tenantField)) {
    schema9.add({
      [tenantField]: {
        type: Schema18.Types.ObjectId,
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
    if (!mongoose22.Types.ObjectId.isValid(context.organizationId)) {
      return { apply: false };
    }
    return {
      apply: true,
      orgId: new mongoose22.Types.ObjectId(context.organizationId)
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
    schema9.pre(method, function() {
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
  schema9.pre("save", function() {
    const context = requestContextStore.getStore();
    if (context?.organizationId && !context.isRoot) {
      if (this.get(tenantField) && String(this.get(tenantField)) !== context.organizationId) throw new Error("Tenant ownership mismatch");
      if (!this.get(tenantField)) {
        this.set(tenantField, new mongoose22.Types.ObjectId(context.organizationId));
      }
    }
  });
  for (const method of ["updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace"]) {
    schema9.pre(method, function() {
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

// models/CrmActivity.ts
var schema2 = new Schema19({
  organizationId: { type: Schema19.Types.ObjectId, ref: "Organization", required: true },
  locationId: { type: Schema19.Types.ObjectId, ref: "Location" },
  patientId: { type: Schema19.Types.ObjectId, ref: "Patient" },
  inquiryId: { type: Schema19.Types.ObjectId, ref: "Inquiry" },
  appointmentId: { type: Schema19.Types.ObjectId, ref: "Appointment" },
  taskId: { type: Schema19.Types.ObjectId, ref: "Task" },
  actorId: { type: Schema19.Types.ObjectId, ref: "User" },
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
schema2.index({ organizationId: 1, patientId: 1, createdAt: -1, _id: -1 });
schema2.index({ organizationId: 1, inquiryId: 1, createdAt: -1, _id: -1 });
schema2.index({ organizationId: 1, eventKey: 1 }, { unique: true, partialFilterExpression: { eventKey: { $type: "string" } } });
schema2.plugin(tenantPlugin);
var CrmActivity = mongoose23.models.CrmActivity || mongoose23.model("CrmActivity", schema2);

// services/CrmTaskService.ts
var CRM_TASK_KINDS = ["crm_callback", "crm_review", "crm_inquiry", "crm_followup", "crm_recovery", "crm_feedback", "crm_diagnostic"];
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

// utilities/workerLease.ts
async function acquireOrRenewWorkerLease({
  name,
  holderId: holderId2,
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
          { holderId: holderId2 },
          { expiresAt: { $lte: now } },
          { expiresAt: { $exists: false } }
        ]
      },
      {
        $set: {
          holderId: holderId2,
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
    return lease?.holderId === holderId2;
  } catch (error) {
    if (error?.code === 11e3) return false;
    throw error;
  }
}

// services/CrmReminderService.ts
init_transaction();

// utilities/locationTime.ts
init_Location();
init_Organization();
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

// services/CrmReminderService.ts
async function crmRemindersEnabled(organizationId, now = /* @__PURE__ */ new Date()) {
  const [org, entitled] = await Promise.all([
    Organization.findOne({ _id: organizationId, isActive: true, status: "active", "crmSettings.automationEnabled": true }).select("_id").lean(),
    crmEntitlementActive(organizationId, now)
  ]);
  return !!org && entitled;
}
async function crmReminderWindow(organizationId, locationId, now = /* @__PURE__ */ new Date()) {
  const org = await Organization.findById(organizationId).select("crmSettings").lean();
  const timezone = await getLocationTimezone(locationId), minutes = locationClockMinutes(now, timezone);
  return {
    allowed: minutes >= (org?.crmSettings?.reminderStartHour ?? 8) * 60 && minutes < (org?.crmSettings?.reminderEndHour ?? 20) * 60,
    revision: org?.crmSettings?.revision || 0,
    localDate: locationDateKey(now, timezone)
  };
}
async function runOrganizationCrmReminders(organizationId, holderId2, cursor, limit = 100) {
  const name = `crm-reminders:${organizationId}`;
  if (!await crmRemindersEnabled(organizationId) || !await acquireOrRenewWorkerLease({ name, holderId: holderId2, leaseMs: 12e4 })) return { processed: 0, nextCursor: cursor || null };
  const pageSize = Math.min(100, Math.max(1, Math.floor(limit)));
  const rows = await TaskModel.find({ organizationId, kind: { $in: CRM_TASK_KINDS }, status: { $ne: "completed" }, dueDate: { $lte: /* @__PURE__ */ new Date() }, assignedTo: { $exists: true }, ...cursor ? { _id: { $gt: cursor } } : {} }).sort({ _id: 1 }).select("_id").limit(pageSize).lean();
  let processed = 0;
  for (const row of rows) await withTransaction(async () => {
    const fence = await WorkerLease.updateOne({ name, holderId: holderId2, expiresAt: { $gt: /* @__PURE__ */ new Date() } }, { $inc: { fenceRevision: 1 }, $set: { expiresAt: new Date(Date.now() + 12e4) } });
    if (fence.matchedCount !== 1) throw new Error("CRM reminder lease lost");
    if (!await crmRemindersEnabled(organizationId)) return;
    const task = await TaskModel.findOne({ _id: row._id, organizationId, kind: { $in: CRM_TASK_KINDS }, status: { $ne: "completed" }, dueDate: { $lte: /* @__PURE__ */ new Date() } });
    if (!task?.assignedTo || task.snoozedUntil && task.snoozedUntil > /* @__PURE__ */ new Date() || !await Location.exists({ _id: task.locationId, organizationId, isActive: true })) return;
    try {
      await validateCrmAssignee(String(task.assignedTo), organizationId, String(task.locationId), "MANAGE_CRM_TASKS");
    } catch (error) {
      if (error.statusCode === 400) return;
      throw error;
    }
    const window = await crmReminderWindow(organizationId, String(task.locationId));
    if (!window.allowed) return;
    await eventBus.publishDurable({ eventId: `crm:task:due:${task.id}:${task.revision || 0}:${window.localDate}:${window.revision}`, eventType: "crm.task.due", category: "task", organizationId, targetUserId: String(task.assignedTo), title: "Patient relationship task due", message: "Review the current task in your authorized workspace.", actionUrl: `/dashboard/crm/tasks?taskId=${task.id}`, channels: { inApp: true, email: false, sms: false, push: false }, metadata: { taskId: task.id, taskRevision: task.revision || 0, locationId: String(task.locationId), localDate: window.localDate, settingsRevision: window.revision } });
    processed++;
  });
  return { processed, nextCursor: rows.length === pageSize ? String(rows[rows.length - 1]._id) : null };
}

// services/CrmNotificationAuthority.ts
function isCrmTaskNotification(event) {
  return ["crm.task.changed", "crm.task.due"].includes(event.eventType);
}
async function canDeliverCrmTaskNotification(event) {
  if (!event.organizationId || !event.targetUserId || !event.metadata?.taskId) return false;
  const task = await TaskModel.findOne({ _id: event.metadata.taskId, organizationId: event.organizationId, assignedTo: event.targetUserId, kind: /^crm_/, status: { $ne: "completed" } }).lean();
  if (!task || String(task.locationId) !== event.metadata.locationId) return false;
  const revision = event.metadata.taskRevision;
  if (!Number.isInteger(revision) || revision !== task.revision) return false;
  if (event.eventType === "crm.task.due" && (!task.dueDate || task.dueDate > /* @__PURE__ */ new Date() || task.snoozedUntil && task.snoozedUntil > /* @__PURE__ */ new Date())) return false;
  if (event.eventType === "crm.task.due") {
    if (!await crmRemindersEnabled(event.organizationId)) return false;
    const window = await crmReminderWindow(event.organizationId, String(task.locationId));
    if (!window.allowed || event.metadata.localDate !== window.localDate || event.metadata.settingsRevision !== window.revision) return false;
  }
  if (!await Organization.exists({ _id: event.organizationId, isActive: true, status: "active" }) || !await Location.exists({ _id: task.locationId, organizationId: event.organizationId, isActive: true })) return false;
  try {
    await validateCrmAssignee(event.targetUserId, event.organizationId, String(task.locationId), "MANAGE_CRM_TASKS");
  } catch (error) {
    if (error.statusCode === 400) return false;
    throw error;
  }
  return true;
}

// services/PatientNotificationAuthority.ts
init_User();
import mongoose29 from "mongoose";

// models/Patient.ts
import mongoose26, { Schema as Schema22 } from "mongoose";

// utilities/documentBudget.ts
import mongoose24 from "mongoose";
function documentBudget(schema9, limits) {
  schema9.pre("validate", function() {
    for (const [path3, limit] of Object.entries(limits)) {
      if ((this.get(path3)?.length || 0) > limit) throw Object.assign(new Error(`Embedded ${path3} limit reached; retain history and use a new record`), { statusCode: 409 });
    }
    if (mongoose24.mongo.BSON.calculateObjectSize(this.toObject({ virtuals: false, getters: false })) > 8 * 1024 * 1024) throw Object.assign(new Error("Document growth budget exceeded"), { statusCode: 409 });
  });
  for (const method of ["updateOne", "updateMany", "findOneAndUpdate"]) {
    schema9.pre(method, function() {
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
import mongoose25, { Schema as Schema21 } from "mongoose";
var CounterSchema = new Schema21(
  {
    id: { type: String, required: true, unique: true },
    seq: { type: Number, default: 0 }
  },
  { timestamps: true }
);
var Counter = mongoose25.models.Counter || mongoose25.model("Counter", CounterSchema);
async function getNextAtomicSequence(counterId, session) {
  const result = await Counter.findOneAndUpdate(
    { id: counterId },
    { $inc: { seq: 1 } },
    { returnDocument: "after", upsert: true, ...session ? { session } : {} }
  );
  return result.seq;
}

// models/Patient.ts
var PatientSchema = new Schema22({
  userId: { type: Schema22.Types.ObjectId, ref: "User", unique: true, sparse: true, index: true },
  name: { type: String, trim: true, index: true },
  phone: { type: String, trim: true, index: true },
  email: { type: String, trim: true, index: true },
  accountType: { type: String, enum: ["self", "dependent", "walkin"], default: "self" },
  createdBy: { type: Schema22.Types.ObjectId, ref: "User" },
  organizationId: { type: Schema22.Types.ObjectId, ref: "Organization", index: true },
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
      appointmentId: { type: Schema22.Types.ObjectId, ref: "Appointment" },
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
var Patient = mongoose26.models.Patient || mongoose26.model("Patient", PatientSchema);

// models/Appointment.ts
import mongoose27, { Schema as Schema23 } from "mongoose";

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
var AppointmentSchema = new Schema23({
  organizationId: { type: Schema23.Types.ObjectId, ref: "Organization", index: true },
  feedbackRevision: { type: Number, default: 0 },
  locationId: { type: Schema23.Types.ObjectId, ref: "Location", required: true, index: true },
  doctorId: { type: Schema23.Types.ObjectId, ref: "User", required: true, index: true },
  patientId: { type: Schema23.Types.ObjectId, ref: "Patient", required: true, index: true },
  bookedByUserId: { type: Schema23.Types.ObjectId, ref: "User", index: true },
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
  invoiceId: { type: Schema23.Types.ObjectId, ref: "Invoice", index: true },
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
  followUpForAppointmentId: { type: Schema23.Types.ObjectId, ref: "Appointment", index: true },
  followUpAppointmentId: { type: Schema23.Types.ObjectId, ref: "Appointment", index: true },
  followUpTaskId: { type: Schema23.Types.ObjectId, ref: "Task" },
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
  disruptionId: { type: Schema23.Types.ObjectId, ref: "DoctorDayOverride", index: true },
  // Missing on legacy records: attendance must be reviewed, never inferred from notes.
  disruptionOriginalStatus: { type: String, enum: ["checked-in", "confirmed", "pending", "pending_payment"] },
  originalDoctorId: { type: Schema23.Types.ObjectId, ref: "User", index: true },
  originalTokenNumber: { type: Number },
  transferredAt: { type: Date },
  transferredBy: { type: Schema23.Types.ObjectId, ref: "User" },
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
  priorityRescheduledFromId: { type: Schema23.Types.ObjectId, ref: "Appointment", index: true },
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
    recordedBy: { type: Schema23.Types.ObjectId, ref: "User" },
    recordedByName: { type: String }
  },
  // Emergency / STAT Protocol Fields
  isEmergency: { type: Boolean, default: false, index: true },
  emergencyTriagedAt: { type: Date },
  // Diagnostic Investigation Results from Lab
  investigationResults: [
    {
      testId: { type: Schema23.Types.ObjectId, ref: "LabTest" },
      testName: { type: String },
      value: { type: String },
      unit: { type: String },
      referenceRange: { type: String },
      isAbnormal: { type: Boolean, default: false },
      resultNotes: { type: String },
      attachmentUrl: { type: String, default: "" },
      resultedAt: { type: Date, default: Date.now },
      labOrderId: { type: Schema23.Types.ObjectId, ref: "LabOrder" }
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
var Appointment = mongoose27.model("Appointment", AppointmentSchema);

// services/PatientNotificationAuthority.ts
init_Location();
init_Organization();

// models/LabOrder.ts
import mongoose28, { Schema as Schema24 } from "mongoose";
var LabOrderSchema = new Schema24({
  // ─── Multi-Tenant Isolation ────────────────────────────────────
  organizationId: { type: Schema24.Types.ObjectId, ref: "Organization" },
  locationId: { type: Schema24.Types.ObjectId, ref: "Location", required: true, index: true },
  // ─── Encounter Aggregate Root Linkage ──────────────────────────
  // Optional for standalone laboratory orders
  encounterId: { type: Schema24.Types.ObjectId, ref: "Encounter", index: true, default: null },
  appointmentId: { type: Schema24.Types.ObjectId, ref: "Appointment", default: null },
  // ─── Clinical Context ──────────────────────────────────────────
  patientId: { type: Schema24.Types.ObjectId, ref: "Patient", required: true, index: true },
  testId: { type: Schema24.Types.ObjectId, ref: "LabTest", required: true, index: true },
  priority: { type: String, enum: ["routine", "urgent", "stat"], default: "routine" },
  clinicalReason: { type: String, default: "" },
  // Why the test was ordered
  // ─── Accountability (distinct roles) ───────────────────────────
  orderedBy: { type: Schema24.Types.ObjectId, ref: "User", index: true, default: null },
  collectedBy: { type: Schema24.Types.ObjectId, ref: "User", default: null },
  resultedBy: { type: Schema24.Types.ObjectId, ref: "User", default: null },
  // Primary Ordering Physician reference
  doctorId: { type: Schema24.Types.ObjectId, ref: "User", index: true },
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
var LabOrder = mongoose28.models.LabOrder || mongoose28.model("LabOrder", LabOrderSchema);

// services/PatientNotificationAuthority.ts
async function patientNotificationAudience(event) {
  const deny2 = { protected: true, allowed: false, appointmentId: void 0, orderId: void 0, patientId: void 0, locationId: void 0 };
  if (!event.targetUserId || !mongoose29.isValidObjectId(event.targetUserId)) return deny2;
  const target = await User.findById(event.targetUserId).select("role isActive").lean();
  if (!target?.isActive) return deny2;
  const appointmentId = event.metadata?.appointmentId || event.metadata?.context?.appointmentId;
  const patientId = event.metadata?.patientId || event.metadata?.context?.patientId;
  const orderId = event.metadata?.orderId;
  const care = ["patient", "clinical", "labs", "consent", "billing"].includes(event.category);
  if (!care && !appointmentId && !patientId && !orderId) return { ...deny2, protected: false, allowed: true };
  const visit = mongoose29.isValidObjectId(appointmentId) ? await Appointment.findById(appointmentId).select("organizationId locationId patientId communicationRevision").lean() : null;
  const order = mongoose29.isValidObjectId(orderId) ? await LabOrder.findById(orderId).select("organizationId locationId patientId status deletedAt").lean() : null;
  if (orderId && (!order || order.deletedAt)) return deny2;
  const source = order || visit;
  const patient = source ? await Patient.findById(source.patientId).select("userId").setOptions({ bypassTenantFilter: true }).lean() : mongoose29.isValidObjectId(patientId) ? await Patient.findById(patientId).select("userId").setOptions({ bypassTenantFilter: true }).lean() : null;
  const owner = patient?.userId?.toString() === event.targetUserId;
  if (!owner && !["patient", "family_member", "guest"].includes(target.role)) return { ...deny2, protected: false, allowed: true };
  if (!owner || target.role === "family_member" || !event.organizationId || !source || String(source.organizationId) !== event.organizationId) return deny2;
  if (patientId && String(source.patientId) !== String(patientId)) return deny2;
  if (order && visit && (String(order.patientId) !== String(visit.patientId) || String(order.locationId) !== String(visit.locationId))) return deny2;
  if (order && event.metadata?.context?.orderStatus !== void 0 && event.metadata.context.orderStatus !== order.status) return deny2;
  const pinned = event.metadata?.context?.communicationRevision;
  if (pinned !== void 0 && (!visit || pinned !== (visit.communicationRevision || 0))) return deny2;
  if (!await Organization.exists({ _id: source.organizationId, isActive: true }) || !await Location.exists({ _id: source.locationId, organizationId: source.organizationId, isActive: true })) return deny2;
  return { protected: true, allowed: true, appointmentId: visit ? String(visit._id) : void 0, orderId: order ? String(order._id) : void 0, patientId: String(source.patientId), locationId: String(source.locationId) };
}

// notifications/services/NotificationService.ts
var NotificationService = class {
  constructor() {
    eventBus.subscribeAll((event) => this.handleDomainEvent(event));
  }
  /**
   * Operational metrics helper for monitoring queue depth and SSE connections
   */
  async getMetrics() {
    const [queueDepth, stats] = await Promise.all([
      notificationQueue.getQueueDepth(),
      notificationQueue.getStats()
    ]);
    const activeSseConnections = getActiveSseConnectionsCount();
    return {
      queueDepth,
      activeSseConnections,
      queueStats: stats
    };
  }
  /**
   * Get or initialize default user notification preferences
   */
  async getPreferences(userId, organizationId) {
    let pref = await NotificationPreference.findOne({ userId: new mongoose30.Types.ObjectId(userId) }).lean();
    if (!pref) {
      try {
        pref = (await NotificationPreference.create({
          userId: new mongoose30.Types.ObjectId(userId),
          organizationId: organizationId ? new mongoose30.Types.ObjectId(organizationId) : void 0
        })).toJSON();
      } catch (err) {
        if (err.code === 11e3) {
          pref = await NotificationPreference.findOne({ userId: new mongoose30.Types.ObjectId(userId) }).lean();
        } else {
          throw err;
        }
      }
    }
    return pref;
  }
  /**
   * Update notification preferences
   */
  async updatePreferences(userId, data) {
    const pref = await NotificationPreference.findOneAndUpdate(
      { userId: new mongoose30.Types.ObjectId(userId) },
      {
        $set: {
          ...data.channels ? { channels: data.channels } : {},
          ...data.categories ? { categories: data.categories } : {},
          updatedAt: /* @__PURE__ */ new Date()
        }
      },
      { returnDocument: "after", upsert: true }
    );
    return pref;
  }
  /**
   * Main domain event handler triggered by EventBus
   */
  async handleDomainEvent(event) {
    if (!event.targetUserId) return;
    const audience = await patientNotificationAudience(event);
    if (!audience.allowed) return;
    if (audience.protected) event = {
      ...event,
      category: "patient",
      title: audience.orderId ? "Diagnostic order update" : "Visit update",
      message: audience.orderId ? "Open your diagnostic orders to review their current state." : "There is an update for your visit. Open your appointments to review its current state.",
      actionUrl: audience.orderId ? `/dashboard/laboratory?orderId=${audience.orderId}` : `/dashboard/appointments?appointmentId=${audience.appointmentId}`,
      metadata: { appointmentId: audience.appointmentId, orderId: audience.orderId, patientId: audience.patientId, locationId: audience.locationId, idempotencyKey: event.metadata?.idempotencyKey }
    };
    const {
      eventId,
      targetUserId,
      category,
      type,
      title,
      message,
      priority,
      severity,
      actionUrl,
      icon,
      metadata,
      organizationId,
      createdBy
    } = event;
    if (!targetUserId) return;
    const crmTaskEvent = isCrmTaskNotification(event);
    if (crmTaskEvent && !await canDeliverCrmTaskNotification(event)) return;
    const idempotencyKey = eventId || metadata?.idempotencyKey;
    const existing = idempotencyKey ? await Notification.findOne({
      targetUser: new mongoose30.Types.ObjectId(targetUserId),
      idempotencyKey
    }) : null;
    const pref = await this.getPreferences(targetUserId, organizationId);
    if (!pref) return;
    const mappedCategory = category === "clinical" ? "patient" : category;
    if (pref.categories && pref.categories[mappedCategory] === false) {
      console.log(`[NotificationService] Suppressed event ${type} for user ${targetUserId} (Category ${category} disabled)`);
      return;
    }
    const effectiveChannels = notificationRuleEngine.evaluateRouting(event, pref.channels);
    if (crmTaskEvent || audience.protected) effectiveChannels.email = false;
    let createdNotification = existing;
    let inserted = false;
    if (effectiveChannels.inApp || existing) {
      const fields = {
        organizationId: organizationId ? new mongoose30.Types.ObjectId(organizationId) : void 0,
        createdBy: createdBy ? new mongoose30.Types.ObjectId(createdBy) : void 0,
        targetUser: new mongoose30.Types.ObjectId(targetUserId),
        category: mappedCategory,
        type: type || event.eventType || "NOTIFICATION",
        title,
        message,
        priority: priority || "medium",
        severity: severity || "info",
        actionUrl,
        icon,
        metadata,
        idempotencyKey,
        entityType: event.metadata?.entityType,
        entityId: event.metadata?.entityId,
        groupKey: event.metadata?.groupKey,
        createdAt: /* @__PURE__ */ new Date()
      };
      if (!createdNotification) {
        if (idempotencyKey) {
          const _id = new mongoose30.Types.ObjectId(crypto11.createHash("sha256").update(`${targetUserId}:${idempotencyKey}`).digest("hex").slice(0, 24));
          const result = await Notification.findOneAndUpdate({ _id }, { $setOnInsert: fields }, { upsert: true, returnDocument: "after", includeResultMetadata: true });
          createdNotification = result.value;
          inserted = !result.lastErrorObject?.updatedExisting;
        } else {
          createdNotification = await Notification.create(fields);
          inserted = true;
        }
      }
      await NotificationDelivery.findOneAndUpdate({ idempotencyKey: `inApp:${createdNotification._id}` }, { $setOnInsert: {
        notificationId: createdNotification._id,
        channel: "inApp",
        recipient: targetUserId,
        status: "delivered",
        sentAt: /* @__PURE__ */ new Date(),
        idempotencyKey: `inApp:${createdNotification._id}`
      } }, { upsert: true });
      const unreadCount = await this.getUnreadCount(targetUserId, organizationId);
      if (inserted) broadcastRealtimeNotification(targetUserId, {
        type: "NOTIFICATION_RECEIVED",
        data: {
          notification: createdNotification.toJSON(),
          unreadCount
        }
      });
    }
    const requested = event.metadata?.requestedChannels;
    const shouldSendEmail = !crmTaskEvent && !audience.protected && (requested?.email !== false && effectiveChannels.email || requested?.email === true);
    if (shouldSendEmail && createdNotification) {
      let recipientEmail;
      const userDoc = await User.findById(targetUserId).select("email").lean();
      recipientEmail = userDoc?.email || void 0;
      if (recipientEmail?.trim()) {
        await notificationQueue.enqueue({
          notificationId: createdNotification._id.toString(),
          channel: "email",
          recipient: recipientEmail,
          title: title || "Notification Alert",
          message: message || ""
        });
      }
    }
  }
  /**
   * Fetch user notifications with filters, multi-tenant isolation, pinned sorting, and pagination
   */
  async getNotifications(userId, query) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const skip = (page - 1) * limit;
    const filter = {
      targetUser: new mongoose30.Types.ObjectId(userId),
      archived: query.archived === true,
      deletedAt: null
    };
    if (!query.includeSnoozed) {
      filter.$or = [
        { snoozedUntil: null },
        { snoozedUntil: { $lte: /* @__PURE__ */ new Date() } }
      ];
    }
    if (query.organizationId) {
      filter.organizationId = new mongoose30.Types.ObjectId(query.organizationId);
    }
    if (query.category) {
      filter.category = query.category;
    }
    if (query.entityType) {
      filter.entityType = query.entityType;
    }
    if (query.entityId) {
      filter.entityId = query.entityId;
    }
    if (query.unreadOnly) {
      filter.readAt = null;
    }
    if (query.search) {
      const searchRegex = { $regex: query.search, $options: "i" };
      if (filter.$or) {
        filter.$and = [
          { $or: filter.$or },
          { $or: [{ title: searchRegex }, { message: searchRegex }] }
        ];
        delete filter.$or;
      } else {
        filter.$or = [{ title: searchRegex }, { message: searchRegex }];
      }
    }
    const [items, total] = await Promise.all([
      Notification.find(filter).sort({ pinned: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Notification.countDocuments(filter)
    ]);
    const unreadCount = await this.getUnreadCount(userId, query.organizationId);
    return {
      notifications: items.map((doc) => ({
        ...doc,
        id: doc._id.toString()
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      },
      unreadCount
    };
  }
  /**
   * Fast unread count getter with multi-tenant isolation and snooze exclusion
   */
  async getUnreadCount(userId, organizationId) {
    const filter = {
      targetUser: new mongoose30.Types.ObjectId(userId),
      readAt: null,
      archived: false,
      deletedAt: null,
      $or: [
        { snoozedUntil: null },
        { snoozedUntil: { $lte: /* @__PURE__ */ new Date() } }
      ]
    };
    if (organizationId) {
      const orgIdObj = new mongoose30.Types.ObjectId(organizationId);
      filter.$and = [
        { $or: filter.$or },
        { $or: [{ organizationId: orgIdObj }, { organizationId: null }, { organizationId: { $exists: false } }] }
      ];
      delete filter.$or;
    }
    return Notification.countDocuments(filter);
  }
  /**
   * Mark single notification as read with multi-tenant scoping
   */
  async markAsRead(userId, notificationId, organizationId) {
    const filter = {
      _id: new mongoose30.Types.ObjectId(notificationId),
      targetUser: new mongoose30.Types.ObjectId(userId),
      deletedAt: null
    };
    if (organizationId) {
      const orgIdObj = new mongoose30.Types.ObjectId(organizationId);
      filter.$or = [
        { organizationId: orgIdObj },
        { organizationId: null },
        { organizationId: { $exists: false } }
      ];
    }
    const notification = await Notification.findOneAndUpdate(
      filter,
      { $set: { readAt: /* @__PURE__ */ new Date() } },
      { returnDocument: "after" }
    );
    const unreadCount = await this.getUnreadCount(userId, organizationId);
    broadcastRealtimeNotification(userId, {
      type: "UNREAD_COUNT_UPDATED",
      data: { unreadCount }
    });
    return { notification, unreadCount };
  }
  /**
   * Mark all unread notifications as read with multi-tenant scoping
   */
  async markAllAsRead(userId, organizationId) {
    const filter = {
      targetUser: new mongoose30.Types.ObjectId(userId),
      readAt: null,
      archived: false,
      deletedAt: null
    };
    if (organizationId) {
      filter.organizationId = new mongoose30.Types.ObjectId(organizationId);
    }
    await Notification.updateMany(filter, { $set: { readAt: /* @__PURE__ */ new Date() } });
    const unreadCount = await this.getUnreadCount(userId, organizationId);
    broadcastRealtimeNotification(userId, {
      type: "UNREAD_COUNT_UPDATED",
      data: { unreadCount }
    });
    return { unreadCount };
  }
  /**
   * Archive a notification with multi-tenant scoping
   */
  async archiveNotification(userId, notificationId, organizationId) {
    const filter = {
      _id: new mongoose30.Types.ObjectId(notificationId),
      targetUser: new mongoose30.Types.ObjectId(userId),
      deletedAt: null
    };
    if (organizationId) {
      filter.organizationId = new mongoose30.Types.ObjectId(organizationId);
    }
    const notification = await Notification.findOneAndUpdate(
      filter,
      { $set: { archived: true } },
      { returnDocument: "after" }
    );
    const unreadCount = await this.getUnreadCount(userId, organizationId);
    return { notification, unreadCount };
  }
  /**
   * Soft delete a notification with multi-tenant scoping
   */
  async deleteNotification(userId, notificationId, organizationId) {
    const filter = {
      _id: new mongoose30.Types.ObjectId(notificationId),
      targetUser: new mongoose30.Types.ObjectId(userId),
      deletedAt: null
    };
    if (organizationId) {
      filter.organizationId = new mongoose30.Types.ObjectId(organizationId);
    }
    await Notification.findOneAndUpdate(filter, { $set: { deletedAt: /* @__PURE__ */ new Date() } });
    const unreadCount = await this.getUnreadCount(userId, organizationId);
    return { unreadCount };
  }
  /**
   * Snooze a notification for a specified duration in minutes
   */
  async snoozeNotification(userId, notificationId, durationMinutes, organizationId) {
    const filter = {
      _id: new mongoose30.Types.ObjectId(notificationId),
      targetUser: new mongoose30.Types.ObjectId(userId),
      deletedAt: null
    };
    if (organizationId) {
      filter.organizationId = new mongoose30.Types.ObjectId(organizationId);
    }
    const snoozedUntil = new Date(Date.now() + durationMinutes * 60 * 1e3);
    const notification = await Notification.findOneAndUpdate(
      filter,
      { $set: { snoozedUntil } },
      { returnDocument: "after" }
    );
    const unreadCount = await this.getUnreadCount(userId, organizationId);
    return { notification, unreadCount };
  }
  /**
   * Toggle pin status of a notification
   */
  async togglePinNotification(userId, notificationId, organizationId) {
    const filter = {
      _id: new mongoose30.Types.ObjectId(notificationId),
      targetUser: new mongoose30.Types.ObjectId(userId),
      deletedAt: null
    };
    if (organizationId) {
      filter.organizationId = new mongoose30.Types.ObjectId(organizationId);
    }
    const currentDoc = await Notification.findOne(filter);
    if (!currentDoc) return null;
    const notification = await Notification.findOneAndUpdate(
      filter,
      { $set: { pinned: !currentDoc.pinned } },
      { returnDocument: "after" }
    );
    const unreadCount = await this.getUnreadCount(userId, organizationId);
    return { notification, unreadCount };
  }
};
var notificationService = new NotificationService();

// services/AppointmentCommunicationEvents.ts
init_Location();
init_User();
init_Organization();

// models/PatientRelationship.ts
import mongoose31, { Schema as Schema25 } from "mongoose";
var schema3 = new Schema25({
  organizationId: { type: Schema25.Types.ObjectId, ref: "Organization", required: true },
  patientId: { type: Schema25.Types.ObjectId, ref: "Patient", required: true },
  locationId: { type: Schema25.Types.ObjectId, ref: "Location" },
  ownerId: { type: Schema25.Types.ObjectId, ref: "User" },
  revision: { type: Number, default: 0 },
  status: { type: String, enum: ["active", "archived"], default: "active" },
  contact: {
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    availability: { type: String, enum: ["unknown", "reachable", "unreachable", "invalid"], default: "unknown" },
    recipientType: { type: String, enum: ["patient", "family"], default: "patient" },
    familyRelationshipId: { type: Schema25.Types.ObjectId, ref: "FamilyRelationship" },
    correctedAt: Date,
    correctedBy: { type: Schema25.Types.ObjectId, ref: "User" }
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
    reviewedBy: { type: Schema25.Types.ObjectId, ref: "User" },
    retentionBasis: { type: String, maxlength: 200 }
  }
}, { timestamps: true });
schema3.index({ organizationId: 1, patientId: 1 }, { unique: true });
schema3.index({ organizationId: 1, locationId: 1, ownerId: 1, updatedAt: -1, _id: -1 });
schema3.plugin(tenantPlugin);
var PatientRelationship = mongoose31.models.PatientRelationship || mongoose31.model("PatientRelationship", schema3);

// models/OutboundMessage.ts
init_scalability();
import mongoose32, { Schema as Schema26 } from "mongoose";
var OutboundMessageSchema = new Schema26(
  {
    kind: {
      type: String,
      enum: ["payment_receipt", "communication_template", "whatsapp_document", "whatsapp_freeform", "transactional_email"],
      required: true,
      index: true
    },
    idempotencyKey: { type: String, required: true, unique: true },
    payload: { type: Schema26.Types.Mixed, required: true },
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
    lastReplayedBy: { type: Schema26.Types.ObjectId, ref: "User" }
  },
  { timestamps: true }
);
OutboundMessageSchema.index({ status: 1, nextAttemptAt: 1, lockedUntil: 1 });
OutboundMessageSchema.index({ "payload.organizationId": 1, "payload.locationId": 1, "payload.patientId": 1, _id: -1 });
var OutboundMessage = mongoose32.models.OutboundMessage || mongoose32.model(
  "OutboundMessage",
  OutboundMessageSchema
);

// services/PatientCommunicationPolicy.ts
init_Organization();
init_Location();

// services/PatientRecordAccessService.ts
init_OrgMember();

// models/PatientRecordAccess.ts
import mongoose33, { Schema as Schema27 } from "mongoose";
var schema4 = new Schema27({
  tokenHash: { type: String, required: true, unique: true },
  patientId: { type: Schema27.Types.ObjectId, ref: "Patient", required: true },
  userId: { type: Schema27.Types.ObjectId, ref: "User", required: true },
  organizationId: { type: Schema27.Types.ObjectId, ref: "Organization", required: true },
  sessionId: { type: String, required: true },
  expiresAt: { type: Date, required: true }
}, { timestamps: true });
schema4.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
var PatientRecordAccess = mongoose33.models.PatientRecordAccess || mongoose33.model("PatientRecordAccess", schema4);

// services/PatientRecordAccessService.ts
async function getOrganizationPatient(patientId, organizationId) {
  const patient = await Patient.findById(patientId).setOptions({ bypassTenantFilter: true }).populate("userId", "name phone email");
  if (!patient) return null;
  const userId = patient.userId?._id || patient.userId;
  if (patient.organizationId?.toString() === organizationId) return patient;
  const related = await Appointment.exists({ patientId, organizationId }).setOptions({ bypassTenantFilter: true }) || await PatientRelationship.exists({ patientId, organizationId, status: "active" }).setOptions({ bypassTenantFilter: true });
  if (related || userId && await OrgMember.exists({ userId, organizationId })) return patient;
  return null;
}

// models/DPDPConsent.ts
import mongoose34, { Schema as Schema28 } from "mongoose";
var DPDP_PURPOSES = [
  "COMMUNICATION_WHATSAPP",
  "AI_CLINICAL_ASSISTANCE",
  "PREVENTIVE_HEALTH_RECALLS",
  "FEEDBACK_AND_SURVEYS",
  "COMMUNICATION_EMAIL",
  "COMMUNICATION_PHONE"
];
var DPDPConsentSchema = new Schema28(
  {
    patientId: { type: Schema28.Types.ObjectId, ref: "Patient", required: true, index: true },
    userId: { type: Schema28.Types.ObjectId, ref: "User", index: true },
    organizationId: { type: Schema28.Types.ObjectId, ref: "Organization", required: true, index: true },
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
          recordedBy: { type: Schema28.Types.ObjectId, ref: "User" },
          recordedAt: Date,
          activityId: { type: Schema28.Types.ObjectId, ref: "CrmActivity" },
          recipientHash: String,
          familyRelationshipId: { type: Schema28.Types.ObjectId, ref: "FamilyRelationship" },
          familyAuthorityRevision: Number
        }
      }
    ],
    history: [
      {
        purpose: { type: String, enum: DPDP_PURPOSES, required: true },
        action: { type: String, enum: ["GRANTED", "WITHDRAWN"], required: true },
        timestamp: { type: Date, default: Date.now },
        actorId: { type: Schema28.Types.ObjectId, ref: "User" },
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
var DPDPConsent = mongoose34.model("DPDPConsent", DPDPConsentSchema);

// services/PatientConsentService.ts
init_AuditLog();

// models/FamilyRelationship.ts
import mongoose39, { Schema as Schema32 } from "mongoose";
var FamilyRelationshipSchema = new Schema32(
  {
    userId: { type: Schema32.Types.ObjectId, ref: "User", required: true, index: true },
    patientId: { type: Schema32.Types.ObjectId, ref: "Patient", required: true, index: true },
    relationship: {
      type: String,
      enum: ["self", "mother", "father", "son", "daughter", "spouse", "guardian", "other"],
      required: true
    },
    status: { type: String, enum: ["active", "pending", "revoked"], default: "active" },
    identityClaim: { type: Boolean, default: false },
    reviewedBy: { type: Schema32.Types.ObjectId, ref: "User" },
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
      organizationId: { type: Schema32.Types.ObjectId, ref: "Organization", required: true },
      communication: { type: Boolean, default: false },
      consent: { type: Boolean, default: false },
      dataRights: { type: Boolean, default: false },
      revision: { type: Number, default: 0 },
      reviewedBy: { type: Schema32.Types.ObjectId, ref: "User", required: true },
      reviewedAt: { type: Date, required: true }
    }]
  },
  { timestamps: true }
);
FamilyRelationshipSchema.index({ userId: 1, patientId: 1 }, { unique: true });
var FamilyRelationship = mongoose39.models.FamilyRelationship || mongoose39.model("FamilyRelationship", FamilyRelationshipSchema);

// services/FamilyAuthorityService.ts
init_User();
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

// services/PatientConsentService.ts
var CONSENT_NOTICE_VERSION = "communication-choices-2026-10-v1";
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

// services/PatientCommunicationPolicy.ts
init_OrgMember();
init_User();
init_permissions();

// models/WhatsAppRecipient.ts
import mongoose40, { Schema as Schema33 } from "mongoose";
var schema6 = new Schema33({
  scope: { type: String, required: true },
  phoneHash: { type: String, required: true },
  optedOut: { type: Boolean, default: false },
  lastInboundAt: Date,
  lastPreferenceAt: Date
}, { timestamps: true });
schema6.index({ scope: 1, phoneHash: 1 }, { unique: true });
var WhatsAppRecipient = mongoose40.model("WhatsAppRecipient", schema6);

// models/WhatsAppTemplate.ts
import mongoose41, { Schema as Schema34 } from "mongoose";
var schema7 = new Schema34({
  scope: { type: String, required: true },
  metaId: String,
  name: { type: String, required: true },
  language: { type: String, required: true },
  status: String,
  category: String,
  components: Schema34.Types.Mixed,
  lastMetaEventAt: Date
}, { timestamps: true });
schema7.index({ scope: 1, name: 1, language: 1 }, { unique: true });
var WhatsAppTemplate = mongoose41.model("WhatsAppTemplate", schema7);

// services/WhatsAppCloudApiService.ts
import crypto15 from "node:crypto";

// utilities/concurrencyBudget.ts
init_redis();
import crypto14 from "node:crypto";
var local = /* @__PURE__ */ new Map();
var leaseMs = 6e4;
var acquire = `redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1]); if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end; redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4]); redis.call('PEXPIRE', KEYS[1], 120000); return 1`;
async function withConcurrencyBudget(scope, limit, work) {
  const key = `budget:${scope}`;
  const token = crypto14.randomUUID();
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

// services/WhatsAppCloudApiService.ts
init_scalability();

// services/WhatsAppAccountService.ts
init_Organization();

// models/WhatsAppAccount.ts
import mongoose42, { Schema as Schema35 } from "mongoose";
var schema8 = new Schema35({
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
var WhatsAppAccount = mongoose42.model("WhatsAppAccount", schema8);

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

// services/WhatsAppCloudApiService.ts
var WhatsAppCloudApiService = class {
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
      return { success: true, status: "accepted", providerMessageId: `wamid.sandbox.${crypto15.randomUUID()}`, rawResponse: { mode: "sandbox" } };
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
var whatsAppCloudApiService = new WhatsAppCloudApiService();

// services/WhatsAppSendPolicy.ts
function phoneHash(phone) {
  return computeBlindIndex(whatsAppCloudApiService.formatPhoneNumber(phone));
}

// models/Invoice.ts
import mongoose43, { Schema as Schema38 } from "mongoose";
init_auditPlugin();
init_Organization();
init_Location();

// models/pharmacyDocumentSchema.ts
import { Schema as Schema36 } from "mongoose";
var pharmacyDocumentSchema = new Schema36({
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
  issuedBy: { type: Schema36.Types.ObjectId, ref: "User" },
  issuedAt: Date,
  notice: String
}, { _id: false });
var pharmacyTaxAmounts = {
  baseAmountPaise: { type: Number, min: 0, validate: Number.isSafeInteger },
  cgstPaise: { type: Number, min: 0, validate: Number.isSafeInteger },
  sgstPaise: { type: Number, min: 0, validate: Number.isSafeInteger },
  grossAmountPaise: { type: Number, min: 0, validate: Number.isSafeInteger }
};

// models/pharmacyCalculationSchema.ts
import { Schema as Schema37 } from "mongoose";

// services/InvoiceCalculationService.ts
var PHARMACY_CALCULATION_POLICY = "pharmacy-paise-v2";

// models/pharmacyCalculationSchema.ts
var paise = { type: Number, required: true, min: 0, validate: Number.isSafeInteger };
var amounts = {
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
var line = new Schema37({
  lineId: { type: String, required: true },
  quantity: { ...paise, min: 1 },
  gstRateBps: { ...paise, max: 1e4 },
  ...amounts
}, { _id: false });
var pharmacyCalculationSchema = new Schema37({
  policy: { type: String, enum: [PHARMACY_CALCULATION_POLICY], required: true },
  currency: { type: String, enum: ["INR"], required: true },
  priceMode: { type: String, enum: ["inclusive", "exclusive"], required: true },
  taxMode: { type: String, enum: ["sgst", "utgst", "igst", "unallocated", "none"], required: true },
  lines: { type: [line], required: true },
  totals: { type: new Schema37({ ...amounts, roundOffPaise: { type: Number, required: true, min: -99, max: 99, validate: Number.isSafeInteger }, payablePaise: paise }, { _id: false }), required: true }
}, { _id: false });

// utilities/pharmacyTax.ts
function toPaise(value) {
  const scaled = value * 100;
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(scaled)) || Math.abs(scaled - Math.round(scaled)) > 1e-6) {
    throw new CommandError(409, "Pharmacy prices must be nonnegative, bounded amounts with at most two decimal places");
  }
  return Math.round(scaled);
}

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
  if (invoice.documentVersion !== 2 || !invoice.createdBy || !invoice.organizationId || !customer || typeof customer.anonymous !== "boolean" || !customer.anonymous && (!customer.partyId || !customer.name || !Number.isSafeInteger(customer.revision)) || customer.anonymous && customer.partyId || invoice.patientId || invoice.doctorId || invoice.encounterId || invoice.appointmentId || invoice.supplementForInvoiceId || !calc || calc.policy !== "pharmacy-paise-v2" || calc.currency !== "INR" || calc.priceMode !== "inclusive" || !["sgst", "none"].includes(calc.taxMode) || !doc || doc.version !== 2 || doc.pricingPolicy !== calc.policy || !["tax_invoice", "bill_of_supply", "invoice_cum_bill_of_supply", "ordinary_bill"].includes(doc.kind) || !doc.issuer?.legalName || !doc.issuer.address || !doc.issuer.authorisedSignatory || !doc.issuer.drugLicenceNumbers?.length || !doc.recipient?.name || String(doc.issuedBy) !== String(invoice.createdBy) || doc.signatureMode !== "manual_on_print" || doc.supplyMode !== "counter_pickup" || !invoice.issuedAt || doc.issuedAt?.getTime() !== invoice.issuedAt.getTime() || invoice.currency !== "INR" || invoice.numberingVersion !== 2 || !/^I[0-9A-Z]{4}[0-9]{4}\/[0-9]{6}$/.test(invoice.invoiceNumber) || !invoice.financialYear || invoice.invoiceSeries !== invoice.invoiceNumber.slice(1, 5) || !invoice.items.length || calc.lines.length !== invoice.items.length || !calc.totals || invoice.isInterstate || invoice.invoiceType !== "B2C") fail();
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

// models/Invoice.ts
var InvoiceItemSchema = new Schema38({
  ...pharmacyTaxAmounts,
  taxTreatment: String,
  unitCode: String,
  pharmacyDispenseId: { type: Schema38.Types.ObjectId, ref: "PharmacyDispense" },
  pharmacyDispenseLineId: { type: Schema38.Types.ObjectId },
  calculationLineId: String,
  serviceCatalogId: { type: Schema38.Types.ObjectId, ref: "ServiceCatalog" },
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
var InvoiceSchema = new Schema38({
  kind: { type: String, enum: ["clinical", "pharmacy"], default: "clinical", required: true },
  createdBy: { type: Schema38.Types.ObjectId, ref: "User" },
  customerSnapshot: { type: new Schema38({ anonymous: { type: Boolean, required: true }, partyId: Schema38.Types.ObjectId, revision: Number, name: String, address: String, phone: String }, { _id: false }), default: void 0 },
  openingBalanceId: { type: Schema38.Types.ObjectId },
  openingBalanceSnapshot: { type: new Schema38({
    amountPaise: { type: Number, min: 1, required: true, validate: Number.isSafeInteger },
    sourceDate: { type: String, required: true },
    sourceReference: { type: String, required: true },
    reviewReference: { type: String, required: true },
    issuer: { legalName: { type: String, required: true }, address: { type: String, required: true }, drugLicenceNumbers: [String] }
  }, { _id: false }), default: void 0 },
  calculation: { type: pharmacyCalculationSchema },
  invoiceNumber: { type: String, required: true, unique: true },
  generationKey: { type: String },
  clinicalChargeVersion: { type: Number },
  supplementForInvoiceId: { type: Schema38.Types.ObjectId, ref: "Invoice" },
  issuedAt: { type: Date },
  documentVersion: { type: Number },
  numberingVersion: { type: Number },
  financialYear: { type: String },
  invoiceSeries: { type: String },
  taxDocument: { type: pharmacyDocumentSchema },
  organizationId: { type: Schema38.Types.ObjectId, ref: "Organization" },
  currency: { type: String, enum: ["INR", "USD", "CAD", "GBP", "AED", "EUR"] },
  patientId: { type: Schema38.Types.ObjectId, ref: "Patient", required: function() {
    return this.kind !== "pharmacy";
  }, index: true },
  appointmentId: { type: Schema38.Types.ObjectId, ref: "Appointment", index: true },
  encounterId: { type: Schema38.Types.ObjectId, ref: "Encounter", index: true },
  locationId: { type: Schema38.Types.ObjectId, ref: "Location", required: true },
  doctorId: { type: Schema38.Types.ObjectId, ref: "User", required: function() {
    return this.kind !== "pharmacy";
  }, index: true },
  items: [InvoiceItemSchema],
  pharmacyDispenseLineIds: { type: [Schema38.Types.ObjectId], default: void 0 },
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
      receiptId: { type: Schema38.Types.ObjectId },
      componentId: String,
      actorId: { type: Schema38.Types.ObjectId, ref: "User" },
      shiftId: { type: Schema38.Types.ObjectId, ref: "CashierShift" },
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
    const validNumber = /^I[0-9A-Z]{4}[0-9]{4}\/[0-9]{6}$/.test(this.invoiceNumber);
    const sum = (key) => this.items.reduce((total, item) => total + (item[key] ?? NaN), 0);
    if (!this.issuedAt || !document || document.version !== 1 || !validNumber || this.numberingVersion !== 2 || this.currency !== "INR" || !document.issuer?.legalName || !document.issuer.address || !document.issuer.stateCode || !document.issuer.authorisedSignatory || !document.issuer.drugLicenceNumbers?.length || !document.recipient?.name || !document.issuedBy || document.signatureMode !== "manual_on_print" || document.issuedAt?.getTime() !== this.issuedAt.getTime() || this.invoiceSeries !== this.invoiceNumber.slice(1, 5) || !this.financialYear || !this.invoiceSeries || !this.items.length || this.items.some((item) => !/^\d{4}(\d{2})?(\d{2})?$/.test(item.hsnSacCode) || !/^[A-Z]{3}$/.test(item.unitCode || "") || ![item.baseAmountPaise, item.cgstPaise, item.sgstPaise, item.grossAmountPaise].every((value) => Number.isSafeInteger(value) && value >= 0) || item.baseAmountPaise + item.cgstPaise + item.sgstPaise !== item.grossAmountPaise || Math.abs(item.amount * item.quantity - item.baseAmountPaise / 100) > 1e-6 || item.totalItemAmount !== item.grossAmountPaise / 100) || this.subtotal !== sum("baseAmountPaise") / 100 || this.totalAmount !== sum("grossAmountPaise") / 100 || this.tax !== (sum("cgstPaise") + sum("sgstPaise")) / 100 || this.cgstTotal !== sum("cgstPaise") / 100 || this.sgstTotal !== sum("sgstPaise") / 100 || this.igstTotal !== 0 || this.discount !== 0 || !["tax_invoice", "invoice_cum_bill_of_supply"].includes(document.kind) && this.tax !== 0) {
      throw new CommandError(409, "Issued pharmacy document does not reconcile with its captured tax lines");
    }
  }
});
var protectedIssuePaths = ["openingBalanceId", "openingBalanceSnapshot", "kind", "createdBy", "customerSnapshot", "calculation", "items", "pharmacyDispenseLineIds", "invoiceNumber", "documentVersion", "numberingVersion", "financialYear", "invoiceSeries", "taxDocument", "issuedAt", "currency", "organizationId", "locationId", "patientId", "doctorId", "encounterId", "appointmentId", "supplementForInvoiceId", "subtotal", "taxableAmount", "tax", "discount", "totalAmount", "cgstTotal", "sgstTotal", "igstTotal", "supplierGstin", "customerGstin", "invoiceType", "placeOfSupply", "isInterstate", "deletedAt"];
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
var Invoice = mongoose43.models.Invoice || mongoose43.model("Invoice", InvoiceSchema);

// services/PatientCommunicationPolicy.ts
var CommunicationPolicyError = class extends Error {
  reason;
  constructor(reason) {
    super(reason);
    this.reason = reason;
    this.name = "CommunicationPolicyError";
  }
};
var deny = (reason) => {
  throw new CommunicationPolicyError(reason);
};
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

// services/CommunicationOutbox.ts
import crypto16 from "node:crypto";
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
  return `communication:${crypto16.createHash("sha256").update(stablePayload).digest("hex")}`;
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
  const idempotencyKey = options.idempotencyKey || `whatsapp-document:${crypto16.createHash("sha256").update(JSON.stringify([options.to, options.documentUrl, options.filename, options.caption || ""])).digest("hex")}`;
  return enqueueEncryptedOutbound(
    "whatsapp_document",
    idempotencyKey,
    { ...options, to: options.to.trim(), idempotencyKey },
    { deliveryType: "document", ...decision.context }
  );
}
async function enqueueTransactionalEmail(options) {
  if (options.communicationContext) {
    const decision = await patientCommunicationPolicy(options.communicationContext, "email", options.to);
    options = { ...options, communicationContext: decision.context, to: decision.recipient };
  }
  const { session, ...email } = options;
  const normalized = { ...email, to: email.to.trim() };
  const idempotencyKey = options.idempotencyKey || `transactional-email:${crypto16.createHash("sha256").update(JSON.stringify([normalized.to.toLowerCase(), normalized.subject, normalized.text || "", normalized.html, normalized.from || ""])).digest("hex")}`;
  return enqueueEncryptedOutbound(
    "transactional_email",
    idempotencyKey,
    { ...normalized, idempotencyKey },
    { deliveryType: "transactional_email", ...options.communicationContext || {} },
    session
  );
}

// services/PrescriptionCommunicationService.ts
init_AuditLog();

// utilities/publicTracker.ts
import crypto17 from "node:crypto";
function createTrackerCapability() {
  const token = crypto17.randomBytes(32).toString("base64url");
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
  return crypto17.createHash("sha256").update(token).digest("hex");
}

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

// services/AppointmentCommunicationEvents.ts
init_transaction();

// utilities/manualNotificationContent.ts
function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// services/AppointmentCommunicationEvents.ts
async function review(context, key) {
  if (!await Location.exists({ _id: context.locationId, organizationId: context.organizationId, isActive: true })) return;
  const relationship = await PatientRelationship.findOne({ organizationId: context.organizationId, patientId: context.patientId, locationId: context.locationId, status: "active" }).select("ownerId").lean();
  await createCrmTask({ organizationId: context.organizationId, locationId: context.locationId, patientId: context.patientId, appointmentId: context.appointmentId, actorId: context.actorId, kind: "crm_review", title: "Review unavailable appointment communication", dueDate: /* @__PURE__ */ new Date(), assignedTo: relationship?.ownerId?.toString(), dedupeKey: `communication-event-review:${key}` });
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
eventBus.subscribe("crm.appointment.communication", handleAppointmentCommunication);

// services/PaymentReceiptEvents.ts
init_Location();
init_transaction();
async function review2(context, key) {
  if (!await Location.exists({ _id: context.locationId, organizationId: context.organizationId, isActive: true })) return;
  const relationship = await PatientRelationship.findOne({ organizationId: context.organizationId, patientId: context.patientId, locationId: context.locationId, status: "active" }).select("ownerId").lean();
  await createCrmTask({
    organizationId: context.organizationId,
    locationId: context.locationId,
    patientId: context.patientId,
    appointmentId: context.appointmentId,
    assignedTo: relationship?.ownerId?.toString(),
    kind: "crm_review",
    title: "Review unavailable payment receipt communication",
    dueDate: /* @__PURE__ */ new Date(),
    dedupeKey: `receipt-review:${key}`
  });
}
async function handlePaymentReceipt(event) {
  const { context, channels } = event.metadata || {};
  if (!event.eventId || !event.organizationId || context?.organizationId !== event.organizationId || !context.invoiceId || !Array.isArray(channels)) throw new Error("Invalid receipt event");
  for (const entry of channels) await withTransaction(async () => {
    if (!["whatsapp", "email"].includes(entry.channel) || entry.context?.organizationId !== event.organizationId || entry.context?.invoiceId !== context.invoiceId || entry.context?.paymentReference !== context.paymentReference || !entry.context?.recipientHash || !entry.context?.consentEvidenceHash) throw new Error("Invalid pinned receipt channel");
    const key = `${event.eventId}:${entry.channel}`;
    if (await OutboundMessage.exists({ idempotencyKey: key, "payload.organizationId": event.organizationId })) return;
    try {
      const decision = await patientCommunicationPolicy(entry.context, entry.channel);
      const invoice = await Invoice.findOne({ _id: context.invoiceId, organizationId: event.organizationId }).select("invoiceNumber currency").lean();
      if (!invoice) throw new CommunicationPolicyError("COMMUNICATION_PAYMENT_SOURCE_CHANGED");
      const amount = new Intl.NumberFormat("en-IN", { style: "currency", currency: context.paymentCurrency }).format(context.paymentAmount);
      const billsUrl = `${getFrontendBaseUrl()}/dashboard/bills`;
      const text = `Payment of ${amount} was recorded for invoice ${invoice.invoiceNumber} via ${context.paymentMethod}. If you have a patient account, review your bills at ${billsUrl}. Contact reception for an invoice copy.`;
      if (entry.channel === "email") await enqueueTransactionalEmail({ to: decision.recipient, subject: "Visit payment recorded", text, html: `<p>${escapeHtml(text)}</p>`, idempotencyKey: key, communicationContext: decision.context });
      else await enqueueCommunicationTemplate({
        organizationId: event.organizationId,
        appointmentId: context.appointmentId,
        phone: decision.recipient,
        patientName: decision.patient?.name || "Patient",
        channel: "whatsapp",
        templateId: "BILLING_RECEIPT",
        variables: { patientName: decision.patient?.name || "Patient", invoiceNumber: invoice.invoiceNumber, amount, paymentMethod: context.paymentMethod, trackingUrl: billsUrl, receiptUrl: billsUrl },
        idempotencyKey: key,
        communicationContext: decision.context
      });
    } catch (error) {
      if (!(error instanceof CommunicationPolicyError)) throw error;
      await review2(entry.context, key);
    }
  });
}
eventBus.subscribe("crm.payment.receipt", handlePaymentReceipt);

// services/DoctorAssignmentRecoveryEvents.ts
init_Location();
init_transaction();
async function handleDoctorAssignmentRemoval(event) {
  const data = event.metadata;
  if (!event.eventId || !event.organizationId || !data?.assignmentId || !Number.isInteger(data.assignmentRevision)) throw new Error("Invalid assignment recovery event");
  await withTransaction(async () => {
    const assignment = await DoctorAssignment.findOneAndUpdate({ _id: data.assignmentId, organizationId: event.organizationId, isActive: false, assignmentRevision: data.assignmentRevision }, { $inc: { recoveryScanRevision: 1 } }, { returnDocument: "after" });
    if (!assignment || !await Location.exists({ _id: assignment.locationId, organizationId: event.organizationId, isActive: true })) return;
    const timezone = await getLocationTimezone(String(assignment.locationId));
    const start = locationDayRange(locationDateKey(/* @__PURE__ */ new Date(), timezone), timezone).start;
    const visits = await Appointment.find({ organizationId: event.organizationId, locationId: assignment.locationId, doctorId: assignment.doctorId, appointmentTime: { $gte: start }, status: { $in: ["pending_payment", "pending", "confirmed", "checked-in", "standby", "disruption_triage"] }, ...data.cursor ? { _id: { $gt: data.cursor } } : {} }).sort({ _id: 1 }).limit(100);
    for (const appointment of visits) {
      const relationship = await PatientRelationship.findOne({ organizationId: event.organizationId, locationId: assignment.locationId, patientId: appointment.patientId, status: "active" }).select("ownerId").lean();
      await createCrmTask({ organizationId: event.organizationId, locationId: String(assignment.locationId), patientId: String(appointment.patientId), appointmentId: appointment.id, actorId: event.createdBy, assignedTo: relationship?.ownerId?.toString(), kind: "crm_recovery", title: "Review removed doctor assignment", dueDate: /* @__PURE__ */ new Date(), dedupeKey: `assignment-recovery:${assignment.id}:${data.assignmentRevision}:${appointment.id}` });
    }
    if (visits.length === 100) {
      const cursor = visits[visits.length - 1].id;
      await eventBus.publishDurable({ ...event, eventId: `crm:assignment:page:${assignment.id}:${data.assignmentRevision}:${cursor}`, metadata: { ...data, cursor } });
    }
  });
}
eventBus.subscribe("crm.doctor.assignment.removed", handleDoctorAssignmentRemoval);

// jobs/crmReminderJob.ts
init_Organization();
import crypto18 from "node:crypto";
var loop = new WorkerLoop();
var holderId = `${process.pid}:${crypto18.randomUUID()}`;
var cursors = /* @__PURE__ */ new Map();
var organizationCursor;
async function runCrmReminderBatch() {
  const orgs = await Organization.find({ isActive: true, status: "active", "crmSettings.automationEnabled": true, ...organizationCursor ? { _id: { $gt: organizationCursor } } : {} }).sort({ _id: 1 }).select("_id").limit(20).lean();
  let processed = 0;
  for (const org of orgs) {
    const result = await runOrganizationCrmReminders(String(org._id), holderId, cursors.get(String(org._id)));
    if (result.nextCursor) cursors.set(String(org._id), result.nextCursor);
    else cursors.delete(String(org._id));
    processed += result.processed;
  }
  organizationCursor = orgs.length === 20 ? String(orgs[orgs.length - 1]._id) : void 0;
  return { processed };
}
function startCrmReminderJob(intervalMs = 6e4) {
  loop.start(runCrmReminderBatch, intervalMs);
}
async function stopCrmReminderJob() {
  await loop.stop();
}

// utilities/workerHealthServer.ts
init_safeError();
import http from "node:http";

// utilities/readiness.ts
init_redis();
import mongoose44 from "mongoose";
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
  const readyState = mongoose44.connection.readyState;
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
    if (mongoose44.connection.db) {
      await pingWithTimeout(mongoose44.connection.db.admin().ping(), "Database");
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

// workers/domainEventWorker.ts
verifyEnv();
await init_db().then(() => db_exports);
domainEventDeliveryWorker.start();
startCrmReminderJob();
console.log("[DomainEventWorker] Worker started successfully");
var healthServer = startWorkerHealthServer({
  workerName: "domain-event-worker",
  defaultPort: 5004,
  envPortVar: "WORKER_HEALTH_PORT",
  onProgress: () => domainEventDeliveryWorker.getProgress(),
  onMetrics: () => domainEventDeliveryWorker.getMetrics()
});
var shutdown = async () => {
  console.log("[DomainEventWorker] Graceful shutdown initiated...");
  await domainEventDeliveryWorker.stop();
  await stopCrmReminderJob();
  console.log("[DomainEventWorker] Worker stopped cleanly.");
  await healthServer.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
