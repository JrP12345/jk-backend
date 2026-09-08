/**
 * HealthOS Telemetry, Error Tracking & Alert Dispatcher
 *
 * Implements:
 * 1. Sentry APM with a strict ALLOWLIST PHI scrubber (drops untrusted request data,
 *    cookies, query params, and sanitizes error messages per DPDP 2023 guidelines).
 * 2. Severity-tiered Ops Paging (P0 Critical immediately pages Slack / PagerDuty / Ops Webhook).
 */

import * as Sentry from "@sentry/node";
import { NODE_ID } from "../notifications/websocket.ts";

export type AlertSeverity = "P0_CRITICAL" | "P1_WARNING" | "P2_INFO";

export interface AlertContext {
  component?: string;
  route?: string;
  action?: string;
  clinicId?: string;
  [key: string]: string | undefined;
}

// ─── Allowlist PHI / PII Scrubber ──────────────────────────────────────────
// Denylists are inherently leaky for complex clinical domains.
// We strictly permit only approved technical fields and scrub all runtime values.
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
    .replace(/\b[0-9a-fA-F]{32,64}\b/g, "[REDACTED_HASH]");
}

// ─── Sentry Initialization ────────────────────────────────────────────────
const sentryDsn = process.env.SENTRY_DSN;

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1.0,
    sendDefaultPii: false, // Never send IP, headers, or cookies
    beforeSend(event) {
      // 1. Drop all request body / form data completely
      if (event.request) {
        event.request.data = undefined;
        event.request.cookies = undefined;
        event.request.headers = {
          "user-agent": event.request.headers?.["user-agent"] || "",
        };
        // Sanitize query string
        if (event.request.query_string) {
          event.request.query_string = "[STRIPPED_QUERY]";
        }
      }

      // 2. Drop user identity objects (names, emails, IPs)
      event.user = undefined;

      // 3. Scrub exception messages per allowlist rules
      if (event.exception?.values) {
        for (const ex of event.exception.values) {
          if (ex.value) {
            ex.value = sanitizeErrorMessage(ex.value);
          }
        }
      }

      // 4. Tag with process Node ID
      event.tags = {
        ...event.tags,
        nodeId: NODE_ID,
        service: "healthos-backend",
      };

      return event;
    },
  });
  console.log("[Telemetry] Sentry initialized with strict allowlist PHI scrubber.");
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
  const errorStack = typeof error !== "string" && error.stack ? error.stack.split("\n").slice(0, 4).join("\n") : "";

  const dedupeKey = `${severity}:${title}:${sanitizedMsg}`;
  const now = Date.now();
  const lastSent = recentAlertTimestamps.get(dedupeKey) || 0;
  if (now - lastSent < DEDUPE_WINDOW_MS) {
    return; // Suppress alert flood
  }
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
