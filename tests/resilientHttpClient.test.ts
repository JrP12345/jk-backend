import { afterEach, describe, expect, it, vi } from "vitest";
import { AmbiguousOutcomeError, CircuitBreakerOpenError, ResilientHttpClient } from "../utilities/resilientHttpClient.ts";

afterEach(() => vi.unstubAllGlobals());

describe("provider HTTP failure classification", () => {
  it("keeps the timeout active while consuming a response body", async () => {
    const client = new ResilientHttpClient();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: any) => ({
      ok: true, status: 200, headers: new Headers(),
      text: () => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("body timeout")), { once: true })),
    })));
    await expect(client.request("https://provider.test/body", { provider: "body-deadline", method: "POST", isIdempotent: false, totalTimeoutMs: 25 })).rejects.toBeInstanceOf(AmbiguousOutcomeError);
  });
  it("does not retry 404s or open a provider-wide circuit after repeated missing orders", async () => {
    const client = new ResilientHttpClient();
    const fetchMock = vi.fn().mockImplementation(async () => new Response("no Route matched with those values", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    for (let i = 0; i < 6; i++) {
      await expect(client.request("https://api.razorpay.com/v1/orders/missing/payments", {
        provider: "razorpay", method: "GET",
      })).rejects.toMatchObject({ status: 404 });
    }

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    expect((await client.request("https://api.razorpay.com/v1/orders/other/payments", {
      provider: "razorpay", method: "GET",
    })).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(client.getAllMetrics().razorpay).toMatchObject({ totalRequests: 7, failedRequests: 6, successfulRequests: 1, circuitBreakerTrips: 0 });
  });

  it("retries a transient server error and recovers on a successful response", async () => {
    const client = new ResilientHttpClient();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await client.request<{ items: unknown[] }>("https://api.razorpay.com/v1/orders/example/payments", {
      provider: "razorpay", method: "GET", maxRetries: 1,
    });
    expect(response).toMatchObject({ status: 200, retries: 1, data: { items: [] } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(client.getAllMetrics().razorpay).toMatchObject({ totalRequests: 2, failedRequests: 1, successfulRequests: 1 });
  });

  it("opens after repeated provider outages, then rejects without another network call", async () => {
    const client = new ResilientHttpClient();
    const fetchMock = vi.fn().mockImplementation(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    for (let i = 0; i < 5; i++) {
      await expect(client.request("https://api.razorpay.com/v1/orders/example/payments", {
        provider: "razorpay", method: "GET", maxRetries: 0,
      })).rejects.toMatchObject({ status: 503 });
    }
    await expect(client.request("https://api.razorpay.com/v1/orders/example/payments", {
      provider: "razorpay", method: "GET", maxRetries: 0,
    })).rejects.toBeInstanceOf(CircuitBreakerOpenError);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("keeps an uncertain mutation outcome ambiguous", async () => {
    const client = new ResilientHttpClient();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection reset")));
    await expect(client.request("https://api.razorpay.com/v1/orders", {
      provider: "razorpay", method: "POST", body: { amount: 100 }, isIdempotent: false,
    })).rejects.toBeInstanceOf(AmbiguousOutcomeError);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
    await expect(client.request("https://api.razorpay.com/v1/orders", {
      provider: "razorpay", method: "POST", body: { amount: 100 }, isIdempotent: false,
    })).rejects.toBeInstanceOf(AmbiguousOutcomeError);
  });
});
