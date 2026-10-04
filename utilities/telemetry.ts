/**
 * Ekavyu Telemetry, Error Tracking & Alert Dispatcher
 *
 * Implements:
 * 1. Sentry APM with request/span data minimization and error-value redaction.
 * 2. Severity-tiered Ops Paging (P0 Critical immediately pages Slack / PagerDuty / Ops Webhook).
 */

import * as Sentry from "@sentry/node";
import { NODE_ID } from "../notifications/websocket.ts";
import type { Event } from '@sentry/node';

export type AlertSeverity = "P0_CRITICAL" | "P1_WARNING" | "P2_INFO";

export interface AlertContext {
  component?: string;
  route?: string;
  action?: string;
  clinicId?: string;
  [key: string]: string | undefined;
}

// ─── Allowlist PHI / PII Scrubber ──────────────────────────────────────────
// Pattern redaction complements data minimization; it is not a PHI classifier.
function sanitizeErrorMessage(msg: string): string {
  if (!msg) return "";
  return msg
    // Redact 10-digit Indian mobile numbers
    .replace(/\b[6-9]\d{9}\b/g, "[REDACTED_PHONE]")
    // Redact 12-digit Aadhaar numbers
    .replace(/\b\d{4}\s?\d{4}\s?\d{4}\b/g, "[REDACTED_AADHAAR]")
    // Redact 14-digit ABHA addresses
    .replace(/\b\d{2}-\d{4}-\d{4}-\d{4}\b/g, "[REDACTED_ABHA]")
    // Redact email addresses
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[REDACTED_EMAIL]")
    // Redact bearer tokens and hex secrets
    .replace(/bearer\s+[a-zA-Z0-9._-]+/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]")
    .replace(/\b[0-9a-fA-F]{32,64}\b/g, "[REDACTED_HASH]");
}

// ─── Sentry Initialization ────────────────────────────────────────────────
const sentryDsn = process.env.SENTRY_DSN;

export function scrubTelemetry<T extends Event>(event: T): T {
  event.request = undefined;
  event.user = undefined;
  event.breadcrumbs = undefined;
  event.extra = undefined;
  event.contexts = undefined;
  event.logentry = undefined;
  if (event.message) event.message = sanitizeErrorMessage(event.message);
  // A URL-derived transaction name may include private route identifiers.
  if (event.transaction) event.transaction = event.transaction.split(/[?#]/, 1)[0].replace(/\b[a-f\d]{24}\b/gi, ':id');
  for (const span of event.spans || []) {
    span.description = span.op || 'operation';
    span.data = {};
  }
  for (const ex of event.exception?.values || []) {
    if (ex.value) ex.value = sanitizeErrorMessage(ex.value);
  }
  event.tags = { nodeId: NODE_ID, service: 'healthos-backend' };
  return event;
}

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1.0,
    sendDefaultPii: false, // Never send IP, headers, or cookies
    beforeSend: scrubTelemetry,
    beforeSendTransaction: scrubTelemetry,
  });
  console.log("[Telemetry] Sentry initialized with minimized request/span data.");
} else {
  console.log("[Telemetry] SENTRY_DSN not configured. Local telemetry fallback active.");
}

// ─── Immediate Ops Paging (Dead-Man / PagerDuty / Slack Webhook) ─────────
const recentAlertTimestamps = new Map<string, number>();
const DEDUPE_WINDOW_MS = 60000; // 1 minute alert deduping

export async function dispatchOpsAlert(
  severity: AlertSeverity,
  title: string,
  error: Error | string,
  context: AlertContext = {}
): Promise<void> {
  const webhookUrl = process.env.OPS_ALERT_WEBHOOK_URL;
  const rawErrorMessage = typeof error === "string" ? error : error.message;
  const sanitizedMsg = sanitizeErrorMessage(rawErrorMessage);
  const errorStack = typeof error !== "string" && error.stack ? sanitizeErrorMessage(error.stack.split("\n").slice(1, 4).join("\n")) : "";

  const dedupeKey = `${severity}:${title}:${sanitizedMsg}`;
  const now = Date.now();
  const lastSent = recentAlertTimestamps.get(dedupeKey) || 0;
  if (now - lastSent < DEDUPE_WINDOW_MS) {
    return; // Suppress alert flood
  }
  for (const [key, timestamp] of recentAlertTimestamps) {
    if (now - timestamp >= DEDUPE_WINDOW_MS) recentAlertTimestamps.delete(key);
  }
  if (recentAlertTimestamps.size >= 1000) recentAlertTimestamps.delete(recentAlertTimestamps.keys().next().value!);
  recentAlertTimestamps.set(dedupeKey, now);

  const payload = {
    severity,
    title,
    message: sanitizedMsg,
    nodeId: NODE_ID,
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
    context,
    stackTrace: errorStack,
  };

  // 1. Console alert logging
  if (severity === "P0_CRITICAL") {
    console.error(`🚨 [${severity}] ${title}: ${sanitizedMsg}`);
  } else {
    console.warn(`⚠️ [${severity}] ${title}: ${sanitizedMsg}`);
  }

  // 2. HTTP Webhook dispatch if configured
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err: any) {
      console.warn("[Telemetry Warning] Failed to dispatch ops alert webhook:", err?.message || err);
    }
  }

  // 3. Sentry reporting
  if (sentryDsn && typeof error !== "string") {
    Sentry.withScope((scope) => {
      scope.setLevel(severity === "P0_CRITICAL" ? "fatal" : "warning");
      scope.setTags({ severity, ...context });
      Sentry.captureException(error);
    });
  }
}

/**
 * Report a P0 Critical error (Immediate Pager / Slack notification)
 * Used for: Panic lab alert drops, STAT triage failures, unhandled route crashes, DB disconnects.
 */
export async function reportCriticalError(
  title: string,
  error: Error | string,
  context?: AlertContext
): Promise<void> {
  await dispatchOpsAlert("P0_CRITICAL", title, error, context);
}

/**
 * Report a P1 Warning (Next-business-day / Warning telemetry)
 */
export async function reportWarning(
  title: string,
  error: Error | string,
  context?: AlertContext
): Promise<void> {
  await dispatchOpsAlert("P1_WARNING", title, error, context);
}
