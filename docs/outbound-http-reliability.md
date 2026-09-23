# Outbound HTTP Reliability & Ambiguous Payment Contract

This specification governs all outbound HTTP integrations to third-party providers (payment gateways, WhatsApp Cloud API, ABDM, SMS, Email, and Cloudflare R2).

---

## 1. Shared Resilient HTTP Client (`resilientHttpClient`)

Every external HTTP call must use `resilientHttpClient` rather than raw `fetch()`:

```ts
import { resilientHttpClient } from "../utilities/resilientHttpClient.ts";

const response = await resilientHttpClient.request<RazorpayOrderResponse>(
  "https://api.razorpay.com/v1/orders",
  {
    provider: "razorpay",
    method: "POST",
    headers: { Authorization: `Basic ${auth}` },
    body: payload,
    timeoutMs: 10_000,
    idempotencyKey: `rzp_order:${receipt}`,
    enableCircuitBreaker: true,
  }
);
```

---

## 2. Invariants & Policies

### 2.1 Explicit Timeout
- Every outbound HTTP call has an explicit timeout (default: 10,000ms).
- When a provider fails to respond within the deadline, an `AbortController` aborts the request to release connection sockets and thread execution.

### 2.2 Safe Retry Classification
- **Idempotent Operations (`GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE`):** Safe to retry on network errors, socket timeouts, 502, 503, 504, and 429.
- **Non-Idempotent Mutations (`POST`, `PATCH`):** Only safe to retry if an explicit `Idempotency-Key` or `X-Idempotency-Key` is passed. Without an idempotency key, retries are prohibited to prevent double-charging or duplicate entity creation.
- **Client Errors (4xx):** Never retried (except 429 Rate Limit).

### 2.3 Provider `Retry-After` Support
- Parses standard RFC 7231 `Retry-After` headers (both integer seconds and HTTP dates).
- Clamped between 100ms and 30,000ms, sleeping before subsequent attempts.

### 2.4 Circuit Breaker Protection
- Independent circuit breaker state maintained per external provider (`CLOSED`, `OPEN`, `HALF_OPEN`).
- **Trip condition:** 5 consecutive failures (5xx or timeouts) in 20 seconds transitions provider to `OPEN`.
- **Mitigation:** In `OPEN` state, requests fail fast with `CircuitBreakerOpenError` without dispatching HTTP packets, preventing traffic amplification, queue backup, and thread exhaustion.
- **Recovery:** After 20 seconds, transitions to `HALF_OPEN`; 2 consecutive successful responses reset state to `CLOSED`.

### 2.5 Correlation and Idempotency Tracing
- Automatically attaches `X-Correlation-ID` and `X-Request-ID` from `requestContextStore`.
- Forwards `Idempotency-Key` and `X-Idempotency-Key` to upstream providers.

### 2.6 Metrics Telemetry
- Real-time metrics tracked per provider:
  - `totalRequests`
  - `successfulRequests`
  - `failedRequests`
  - `circuitBreakerTrips`
  - `averageLatencyMs`
  - `lastError` and `lastErrorTime`
- Accessible via platform root route: `GET /api/admin/operations/providers/metrics`.

---

## 3. Ambiguous Payment Outcome Contract

When calling a payment gateway (e.g. Razorpay, UPI) to create an order, charge, or refund:
If a network disconnect (`ECONNRESET`), socket timeout, or 500/502/504 gateway response occurs on a non-idempotent operation:

1. **Classification:** The outcome is **AMBIGUOUS**. The gateway may or may not have debited the customer or created the ledger record.
2. **Behavioral Rules:**
   - **DO NOT** mark the local invoice or appointment as `FAILED`.
   - **DO NOT** blindly retry or prompt the customer to re-enter payment details (prevents double-debiting).
   - Set internal status to `AMBIGUOUS_PENDING_RECONCILIATION`.
   - Retain the original `idempotencyKey` and `orderId`.
   - Allow background webhook processing or operator reconciliation (`GET /v1/orders/:id`) to determine final disposition.
