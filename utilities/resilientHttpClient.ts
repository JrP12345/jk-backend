import crypto from "node:crypto";
import { requestContextStore } from "./context.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export interface CircuitBreakerOptions {
  failureThreshold?: number; // Number of consecutive failures to open circuit (default: 5)
  resetTimeoutMs?: number; // Cooldown before trying half-open (default: 20000ms)
  halfOpenSuccessThreshold?: number; // Number of consecutive successes to close circuit (default: 2)
}

class CircuitBreaker {
  public state: "CLOSED" | "OPEN" | "HALF_OPEN" = "CLOSED";
  public failures = 0;
  public successes = 0;
  public lastFailureTime = 0;

  constructor(
    public readonly name: string,
    public readonly options: Required<CircuitBreakerOptions> = {
      failureThreshold: 5,
      resetTimeoutMs: 20_000,
      halfOpenSuccessThreshold: 2,
    },
  ) {}

  public canExecute(): boolean {
    const now = Date.now();
    if (this.state === "OPEN") {
      if (now - this.lastFailureTime > this.options.resetTimeoutMs) {
        this.state = "HALF_OPEN";
        this.successes = 0;
        return true;
      }
      return false;
    }
    return true;
  }

  public recordSuccess(): void {
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

  public recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.state === "HALF_OPEN" || this.failures >= this.options.failureThreshold) {
      this.state = "OPEN";
    }
  }
}

export interface ProviderMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  circuitBreakerTrips: number;
  totalLatencyMs: number;
  averageLatencyMs: number;
  lastError?: string;
  lastErrorTime?: string;
}

export class CircuitBreakerOpenError extends Error {
  constructor(public readonly provider: string) {
    super(`Circuit breaker is OPEN for provider '${provider}'. Request rejected to prevent amplification.`);
    this.name = "CircuitBreakerOpenError";
  }
}

export class AmbiguousOutcomeError extends Error {
  constructor(
    public readonly provider: string,
    public readonly idempotencyKey?: string,
    public readonly originalError?: any,
  ) {
    super(
      `Ambiguous outcome for provider '${provider}' with idempotency key '${idempotencyKey || "none"}'. Mutation state cannot be confirmed. Manual or automated reconciliation required.`,
    );
    this.name = "AmbiguousOutcomeError";
  }
}

export interface ResilientRequestOptions {
  provider: string; // e.g. "razorpay", "whatsapp", "abdm", "sms"
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: any;
  timeoutMs?: number; // Explicit timeout (mandatory default 10s)
  idempotencyKey?: string;
  correlationId?: string;
  isIdempotent?: boolean; // Override automated classification
  maxRetries?: number;
  enableCircuitBreaker?: boolean;
}

export interface ResilientResponse<T = any> {
  status: number;
  headers: Headers;
  data: T;
  latencyMs: number;
  retries: number;
}

export class ResilientHttpClient {
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private metrics: Map<string, ProviderMetrics> = new Map();

  private getCircuitBreaker(provider: string): CircuitBreaker {
    if (!this.circuitBreakers.has(provider)) {
      this.circuitBreakers.set(provider, new CircuitBreaker(provider));
    }
    return this.circuitBreakers.get(provider)!;
  }

  private getMetrics(provider: string): ProviderMetrics {
    if (!this.metrics.has(provider)) {
      this.metrics.set(provider, {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        circuitBreakerTrips: 0,
        totalLatencyMs: 0,
        averageLatencyMs: 0,
      });
    }
    return this.metrics.get(provider)!;
  }

  public getAllMetrics(): Record<string, ProviderMetrics> {
    const result: Record<string, ProviderMetrics> = {};
    for (const [provider, metric] of this.metrics.entries()) {
      result[provider] = { ...metric };
    }
    return result;
  }

  /**
   * Safe classification: GET, HEAD, OPTIONS, PUT, DELETE are idempotent by HTTP spec.
   * POST and PATCH are only safe to retry if an explicit idempotencyKey is supplied.
   */
  public isOperationSafeToRetry(method: HttpMethod, hasIdempotencyKey: boolean, override?: boolean): boolean {
    if (typeof override === "boolean") return override;
    const idempotentMethods = ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"];
    if (idempotentMethods.includes(method)) return true;
    return hasIdempotencyKey;
  }

  /**
   * Parse Retry-After header adhering to RFC 7231
   */
  private parseRetryAfter(response: Response): number | null {
    const header = response.headers.get("retry-after");
    if (!header) return null;

    const seconds = parseInt(header, 10);
    if (!isNaN(seconds)) {
      return Math.max(100, Math.min(seconds * 1000, 30_000));
    }

    const dateMs = new Date(header).getTime();
    if (!isNaN(dateMs)) {
      return Math.max(100, Math.min(dateMs - Date.now(), 30_000));
    }

    return null;
  }

  /**
   * Execute outbound HTTP call with explicit timeout, circuit breaker, bounded retry, and telemetry.
   */
  public async request<T = any>(url: string, options: ResilientRequestOptions): Promise<ResilientResponse<T>> {
    const provider = options.provider;
    const method = (options.method || "GET").toUpperCase() as HttpMethod;
    const timeoutMs = options.timeoutMs || 10_000;
    const hasIdempotency = !!options.idempotencyKey;
    const safeToRetry = this.isOperationSafeToRetry(method, hasIdempotency, options.isIdempotent);
    const maxRetries = options.maxRetries ?? (safeToRetry ? 2 : 0);
    const useCircuitBreaker = options.enableCircuitBreaker !== false;

    const breaker = useCircuitBreaker ? this.getCircuitBreaker(provider) : null;
    const metric = this.getMetrics(provider);

    // 1. Check Circuit Breaker
    if (breaker && !breaker.canExecute()) {
      metric.circuitBreakerTrips++;
      throw new CircuitBreakerOpenError(provider);
    }

    // 2. Prepare Headers (inject Correlation ID & Idempotency Key)
    const context = requestContextStore.getStore();
    const correlationId =
      options.correlationId ||
      context?.correlationId ||
      crypto.randomUUID();

    const headers: Record<string, string> = {
      "X-Correlation-ID": correlationId,
      "X-Request-ID": correlationId,
      ...(options.headers || {}),
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

    const requestBody =
      options.body && typeof options.body === "object" && headers["Content-Type"]?.includes("application/json")
        ? JSON.stringify(options.body)
        : options.body;

    let attempt = 0;
    const startTime = Date.now();

    while (attempt <= maxRetries) {
      attempt++;
      metric.totalRequests++;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const attemptStart = Date.now();

      try {
        const response = await fetch(url, {
          method,
          headers,
          body: requestBody,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        const latencyMs = Date.now() - attemptStart;
        metric.totalLatencyMs += latencyMs;
        metric.averageLatencyMs = Math.round(metric.totalLatencyMs / metric.totalRequests);

        // Success responses (2xx / 3xx)
        if (response.ok) {
          breaker?.recordSuccess();
          metric.successfulRequests++;

          let data: any;
          const contentType = response.headers.get("content-type") || "";
          if (contentType.includes("application/json")) {
            data = await response.json();
          } else {
            data = await response.text();
          }

          return {
            status: response.status,
            headers: response.headers,
            data,
            latencyMs,
            retries: attempt - 1,
          };
        }

        // Retryable Server Errors: 502, 503, 504, or 429
        const isRetryableStatus = [502, 503, 504, 429].includes(response.status);

        if (isRetryableStatus && attempt <= maxRetries && safeToRetry) {
          breaker?.recordFailure();
          metric.failedRequests++;

          // Respect Retry-After header or compute exponential jitter backoff
          const retryAfterMs = this.parseRetryAfter(response);
          const backoffDelay = retryAfterMs ?? Math.min(10_000, 500 * Math.pow(2, attempt - 1) + Math.random() * 200);

          await new Promise((resolve) => setTimeout(resolve, backoffDelay));
          continue;
        }

        // Non-retryable error or retries exhausted
        breaker?.recordFailure();
        metric.failedRequests++;
        metric.lastError = `HTTP ${response.status}: ${response.statusText}`;
        metric.lastErrorTime = new Date().toISOString();

        // If this was a non-idempotent mutation that received a 5xx error, mark as ambiguous
        if (!safeToRetry && [500, 502, 503, 504].includes(response.status)) {
          throw new AmbiguousOutcomeError(provider, options.idempotencyKey, new Error(`HTTP ${response.status}`));
        }

        const errText = await response.text().catch(() => "");
        const error = new Error(`Provider '${provider}' request failed with status ${response.status}: ${errText.slice(0, 300)}`);
        (error as any).status = response.status;
        (error as any).responseBody = errText;
        throw error;
      } catch (err: any) {
        clearTimeout(timeoutId);
        metric.failedRequests++;
        metric.lastError = err?.message || "Outbound HTTP failed";
        metric.lastErrorTime = new Date().toISOString();

        const isTimeout = err.name === "AbortError" || err.message?.includes("abort");

        // Safe retry on network or timeout failure
        if (safeToRetry && attempt <= maxRetries) {
          breaker?.recordFailure();
          const backoff = Math.min(10_000, 500 * Math.pow(2, attempt - 1) + Math.random() * 200);
          await new Promise((resolve) => setTimeout(resolve, backoff));
          continue;
        }

        breaker?.recordFailure();

        // If non-idempotent operation timed out or crashed at network level, outcome is ambiguous!
        if (!safeToRetry && (isTimeout || err.code === "ECONNRESET")) {
          throw new AmbiguousOutcomeError(provider, options.idempotencyKey, err);
        }

        throw err;
      }
    }

    throw new Error(`Outbound request to provider '${provider}' exceeded maximum retry attempts (${maxRetries}).`);
  }
}

export const resilientHttpClient = new ResilientHttpClient();
