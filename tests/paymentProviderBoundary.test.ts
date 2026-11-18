import { afterEach, expect, it, vi } from "vitest";
import { paymentProvider } from "../services/payment/PaymentProvider.ts";

vi.mock("../services/billing/RazorpayService.ts", () => ({ razorpayService: { getCredentials: vi.fn().mockResolvedValue({ keyId: "synthetic", keySecret: "synthetic" }) } }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const input = { invoiceId: "synthetic-invoice", amount: 15, customerEmail: "synthetic@example.invalid", description: "Synthetic gateway boundary check" };

it.each(["development", "production"])("does not fabricate a successful payment link after a gateway failure in %s", async environment => {
  vi.stubEnv("NODE_ENV", environment);
  const request = vi.fn().mockResolvedValue(new Response("Unavailable", { status: 503 })); vi.stubGlobal("fetch", request);
  await expect(paymentProvider.createPaymentLink(input)).rejects.toThrow(/gateway unavailable/);
  expect(request).toHaveBeenCalledOnce();
});

it("returns the actual gateway link while preserving the existing request deadline", async () => {
  vi.stubEnv("NODE_ENV", "development");
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "actual-provider-id", short_url: "https://provider.example.invalid/payment" }), { status: 200 })); vi.stubGlobal("fetch", request);
  expect(await paymentProvider.createPaymentLink(input)).toMatchObject({ paymentLinkId: "actual-provider-id", checkoutUrl: "https://provider.example.invalid/payment", status: "created" });
  expect(request.mock.calls[0][1]).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
});
