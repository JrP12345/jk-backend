import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dispatchOpsAlert, reportCriticalError, reportWarning } from "../utilities/telemetry.ts";

describe("Telemetry & Ops Paging Alert Dispatcher Suite", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    process.env.OPS_ALERT_WEBHOOK_URL = "https://events.pagerduty.test/webhook";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  it("should dispatch P0 Critical alerts to the ops webhook with sanitized content", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: any) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ status: "success" }), { status: 200 });
    }) as any;

    const testError = new Error("Patient John Doe phone 9876543210 Aadhaar 1234 5678 9012 panic potassium high");
    await dispatchOpsAlert("P0_CRITICAL", "Panic Lab Evaluation Failure", testError, {
      clinicId: "clinic-test-123",
      route: "/api/emr/labs",
    });

    expect(capturedUrl).toBe("https://events.pagerduty.test/webhook");
    expect(capturedBody).toBeDefined();
    expect(capturedBody.severity).toBe("P0_CRITICAL");
    expect(capturedBody.title).toBe("Panic Lab Evaluation Failure");
    // Verify PHI allowlist scrubbing
    expect(capturedBody.message).toContain("[REDACTED_PHONE]");
    expect(capturedBody.message).toContain("[REDACTED_AADHAAR]");
    expect(capturedBody.message).not.toContain("9876543210");
    expect(capturedBody.message).not.toContain("1234 5678 9012");
    expect(capturedBody.context.clinicId).toBe("clinic-test-123");
    expect(capturedBody.nodeId).toBeDefined();
  });

  it("should prevent alert storms through 60-second deduplication", async () => {
    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      return new Response(JSON.stringify({ status: "success" }), { status: 200 });
    }) as any;

    const testError = new Error("Repeated connection timeout to Redis");

    // Call 5 times in rapid succession
    await dispatchOpsAlert("P0_CRITICAL", "Redis Timeout", testError);
    await dispatchOpsAlert("P0_CRITICAL", "Redis Timeout", testError);
    await dispatchOpsAlert("P0_CRITICAL", "Redis Timeout", testError);

    // Only the first call should trigger fetch; subsequent 2 are suppressed by dedupe window
    expect(fetchCount).toBe(1);
  });

  it("should never throw or interrupt caller execution when webhook fails or times out", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      throw new Error("Network timeout reaching PagerDuty endpoint");
    }) as any;

    // Must not throw
    await expect(
      reportCriticalError("Webhook Crash Test", new Error("Simulated diagnostic crash"))
    ).resolves.toBeUndefined();
  });

  it("should route reportCriticalError and reportWarning with proper severity levels", async () => {
    const severitiesCaptured: string[] = [];

    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
      const parsed = JSON.parse(init.body);
      severitiesCaptured.push(parsed.severity);
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }) as any;

    // Use unique error messages to avoid dedupe window
    await reportCriticalError("Critical Event Unique A", new Error("Unique msg A"));
    await reportWarning("Warning Event Unique B", new Error("Unique msg B"));

    expect(severitiesCaptured).toContain("P0_CRITICAL");
    expect(severitiesCaptured).toContain("P1_WARNING");
  });
});
