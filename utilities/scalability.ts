/**
 * Scalability Configuration — Step 6.2 / 6.4
 *
 * Centralized, measurable resource budgets and multi-replica coordination
 * settings. Every limit is tunable via environment variables but has a safe
 * production default. The values here are the single source of truth: API
 * handlers, middleware, and workers all import from this module.
 */

// ─── Request / Upload Budgets ────────────────────────────────────────────────

/** Maximum JSON request body in bytes (default 10 MB) */
export const MAX_REQUEST_BODY_BYTES = positiveInt("MAX_REQUEST_BODY_BYTES", 10 * 1024 * 1024);

/** Maximum single-file upload in bytes (default 25 MB) */
export const MAX_UPLOAD_BYTES = positiveInt("MAX_UPLOAD_BYTES", 25 * 1024 * 1024);

/** Maximum total multipart upload in bytes (default 50 MB) */
export const MAX_MULTIPART_BYTES = positiveInt("MAX_MULTIPART_BYTES", 50 * 1024 * 1024);

// ─── Pagination Budgets ──────────────────────────────────────────────────────

/** Hard ceiling for any paginated endpoint's `limit` parameter (default 100) */
export const MAX_PAGINATION_LIMIT = positiveInt("MAX_PAGINATION_LIMIT", 100);

/** Default page size when the client omits a `limit` (default 20) */
export const DEFAULT_PAGINATION_LIMIT = positiveInt("DEFAULT_PAGINATION_LIMIT", 20);

// ─── Report / Export Budgets ─────────────────────────────────────────────────

/** Maximum report date range in days (default 365 days = 1 year) */
export const MAX_REPORT_RANGE_DAYS = positiveInt("MAX_REPORT_RANGE_DAYS", 365);

/** Maximum rows exported per report (default 10 000) */
export const MAX_REPORT_ROWS = positiveInt("MAX_REPORT_ROWS", 10_000);

// ─── AI / LLM Budgets ───────────────────────────────────────────────────────

/** Maximum conversation turns sent to the LLM as context (default 8 = 16 messages) */
export const MAX_AI_CONTEXT_TURNS = positiveInt("MAX_AI_CONTEXT_TURNS", 8);

/** Maximum messages stored per AI chat session (default 500) */
export const MAX_AI_SESSION_MESSAGES = positiveInt("MAX_AI_SESSION_MESSAGES", 500);

/** Maximum concurrent AI streaming requests per tenant (default 5) */
export const MAX_AI_CONCURRENT_PER_TENANT = positiveInt("MAX_AI_CONCURRENT_PER_TENANT", 5);

// ─── Event Processing Budgets ────────────────────────────────────────────────

/** Maximum retry attempts for domain events before dead-lettering (default 5) */
export const MAX_EVENT_RETRY_COUNT = positiveInt("MAX_EVENT_RETRY_COUNT", 5);

/** Maximum retry attempts for outbound messages before failing (default 5) */
export const MAX_OUTBOUND_RETRY_COUNT = positiveInt("MAX_OUTBOUND_RETRY_COUNT", 5);

// ─── Database Connection Pool ────────────────────────────────────────────────

/** Maximum MongoDB connection pool size per process (default 10, production recommendation: 50) */
export const DB_POOL_SIZE = positiveInt("DB_POOL_SIZE",
  process.env.NODE_ENV === "production" ? 50 : 10
);

/** MongoDB socket timeout in milliseconds (default 30s) */
export const DB_SOCKET_TIMEOUT_MS = positiveInt("DB_SOCKET_TIMEOUT_MS", 30_000);

/** MongoDB server selection timeout in milliseconds (default 15s) */
export const DB_SERVER_SELECTION_TIMEOUT_MS = positiveInt("DB_SERVER_SELECTION_TIMEOUT_MS", 15_000);

// ─── Provider / External Service Concurrency ─────────────────────────────────

/** Maximum concurrent outbound HTTP requests to payment providers (default 5) */
export const MAX_PROVIDER_CONCURRENCY = positiveInt("MAX_PROVIDER_CONCURRENCY", 5);

/** Maximum concurrent WhatsApp API calls (default 3) */
export const MAX_WHATSAPP_CONCURRENCY = positiveInt("MAX_WHATSAPP_CONCURRENCY", 3);

// ─── Rate Limits ─────────────────────────────────────────────────────────────

/** Global rate limit per IP per minute (default 500 in production, 10000 in dev) */
export const GLOBAL_RATE_LIMIT_PER_MINUTE = positiveInt("GLOBAL_RATE_LIMIT_PER_MINUTE",
  process.env.NODE_ENV === "production" ? 500 : 10_000
);

/** Per-tenant rate limit per minute (default 2000) */
export const TENANT_RATE_LIMIT_PER_MINUTE = positiveInt("TENANT_RATE_LIMIT_PER_MINUTE", 2_000);

/** Auth endpoint rate limit per IP per minute (default 20) */
export const AUTH_RATE_LIMIT_PER_MINUTE = positiveInt("AUTH_RATE_LIMIT_PER_MINUTE", 20);

// ─── Worker Concurrency ─────────────────────────────────────────────────────

/** Domain event worker batch size (default 10) */
export const DOMAIN_EVENT_WORKER_BATCH_SIZE = positiveInt("DOMAIN_EVENT_WORKER_BATCH_SIZE", 10);

/** Domain event worker poll interval in ms (default 500) */
export const DOMAIN_EVENT_WORKER_POLL_MS = positiveInt("DOMAIN_EVENT_WORKER_POLL_MS", 500);

/** Outbound message worker batch size (default 5) */
export const OUTBOUND_MESSAGE_WORKER_BATCH_SIZE = positiveInt("OUTBOUND_MESSAGE_WORKER_BATCH_SIZE", 5);

/** Outbound message worker poll interval in ms (default 1000) */
export const OUTBOUND_MESSAGE_WORKER_POLL_MS = positiveInt("OUTBOUND_MESSAGE_WORKER_POLL_MS", 1_000);

/** No-show sweep interval in ms (default 5 minutes) */
export const NO_SHOW_SWEEP_INTERVAL_MS = positiveInt("NO_SHOW_SWEEP_INTERVAL_MS", 5 * 60 * 1000);

// ─── Multi-Replica Coordination ──────────────────────────────────────────────

/** Redis pub/sub channel prefix for WebSocket fan-out (default "ws") */
export const WS_PUBSUB_PREFIX = process.env.WS_PUBSUB_PREFIX || "ws";

/** Redis pub/sub channel for session revocation broadcast (default "session:revoke") */
export const SESSION_REVOKE_CHANNEL = process.env.SESSION_REVOKE_CHANNEL || "session:revoke";

/** Redis pub/sub channel for permission invalidation broadcast (default "perm:invalidate") */
export const PERMISSION_INVALIDATE_CHANNEL = process.env.PERMISSION_INVALIDATE_CHANNEL || "perm:invalidate";

/** Graceful shutdown drain period in ms (default 2000, test: 0) */
export const SHUTDOWN_DRAIN_MS = process.env.NODE_ENV === "test" ? 0 : positiveInt("SHUTDOWN_DRAIN_MS", 2_000);

// ─── Worker Backpressure ─────────────────────────────────────────────────────

/** Maximum queue age in seconds before a worker pauses polling to relieve pressure (default 300 = 5 min) */
export const WORKER_BACKPRESSURE_QUEUE_AGE_SEC = positiveInt("WORKER_BACKPRESSURE_QUEUE_AGE_SEC", 300);

/** Maximum pending items before a worker enters backpressure mode (default 500) */
export const WORKER_BACKPRESSURE_PENDING_LIMIT = positiveInt("WORKER_BACKPRESSURE_PENDING_LIMIT", 500);

/** Poll multiplier during backpressure (2 = double the normal interval, default 2) */
export const WORKER_BACKPRESSURE_POLL_MULTIPLIER = positiveInt("WORKER_BACKPRESSURE_POLL_MULTIPLIER", 2);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function positiveInt(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[ScalabilityConfig] Invalid value for ${envName}="${raw}", using fallback ${fallback}`);
    return fallback;
  }
  return parsed;
}
