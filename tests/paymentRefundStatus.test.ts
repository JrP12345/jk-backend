import { afterEach, describe, expect, it, vi } from "vitest";
import { paymentProvider } from "../services/payment/PaymentProvider.ts";
import { razorpayService } from "../services/billing/RazorpayService.ts";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("provider refund confirmation", () => {
  it.each([
    [{ id: "rfnd_pending", status: "pending" }, "pending", "rfnd_pending"],
    [{ id: "rfnd_processed", status: "processed" }, "processed", "rfnd_processed"],
    [{ status: "processed" }, "pending", ""],
    [{ id: "rfnd_failed", status: "failed" }, "failed", "rfnd_failed"],
    [{ id: "rfnd_unknown", status: "unknown" }, "pending", "rfnd_unknown"],
  ])("preserves provider result %j as %s", async (result, status, refundId) => {
    vi.stubEnv("NODE_ENV", "development");
    vi.spyOn(razorpayService, "processRefund").mockResolvedValue(result);
    const refund = await paymentProvider.processRefund({ transactionId: "pay_verified", amount: 600 });
    expect(refund).toEqual({ refundId, status, amount: 600 });
    expect(razorpayService.processRefund).toHaveBeenCalledWith({ paymentId: "pay_verified", amount: 600, notes: { reason: "Patient Refund" } });
  });

  it("keeps transport failure unconfirmed without fabricating a refund ID", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(razorpayService, "processRefund").mockRejectedValue(new Error("gateway unavailable"));
    expect(await paymentProvider.processRefund({ transactionId: "pay_verified", amount: 600 })).toEqual({ refundId: "", status: "failed", amount: 600 });
  });
});
