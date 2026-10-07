import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { runBillingReconciliation } from "../jobs/billingReconciliationJob.ts";
import { SubscriptionPayment } from "../models/SubscriptionPayment.ts";
import { SaaSInvoice } from "../models/SaaSInvoice.ts";
import { subscriptionService } from "../services/billing/SubscriptionService.ts";
import { razorpayService } from "../services/billing/RazorpayService.ts";

const now = new Date("2026-10-04T06:00:00Z");

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  await SubscriptionPayment.deleteMany({});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function pending(orderId: string, extra: Record<string, unknown> = {}) {
  return SubscriptionPayment.create({
    organizationId: new mongoose.Types.ObjectId(), subscriptionId: new mongoose.Types.ObjectId(),
    planId: new mongoose.Types.ObjectId(), razorpayOrderId: orderId, amount: 499,
    status: "created", createdAt: new Date(now.getTime() - 30 * 60_000), ...extra,
  });
}

describe("subscription reconciliation scheduling", () => {
  it("excludes explicit simulated orders without excluding other provider IDs", async () => {
    const simulated = await pending("order_sim_fj26qvtzzga");
    await pending("order_test_local_fixture");
    const providerOrder = await pending("order_dofp724broi");
    const fetch = vi.spyOn(razorpayService, "fetchCapturedPaymentForOrder").mockResolvedValue(null);

    await runBillingReconciliation();

    expect(fetch).toHaveBeenCalledExactlyOnceWith(providerOrder.razorpayOrderId, 499);
    expect((await SubscriptionPayment.findById(simulated.id))?.lastReconciledAt).toBeNull();
    expect((await SubscriptionPayment.findById(simulated.id))?.status).toBe("created");
    expect((await SubscriptionPayment.findById(providerOrder.id))?.lastReconciledAt).toEqual(now);
  });

  it("defers a missing provider order for a day without changing financial state", async () => {
    const payment = await pending("order_MissingProvider", { status: "failed" });
    const fetch = vi.spyOn(razorpayService, "fetchCapturedPaymentForOrder")
      .mockRejectedValue(Object.assign(new Error("Provider order not found"), { status: 404 }));

    await runBillingReconciliation();
    const stored = await SubscriptionPayment.findById(payment.id);
    expect(stored).toMatchObject({ status: "failed", amount: 499, reconciliationIssue: "provider_order_not_found" });
    expect(stored?.reconcileAfter).toEqual(new Date(now.getTime() + 24 * 60 * 60_000));
    expect(await SaaSInvoice.countDocuments({ paymentId: payment._id })).toBe(0);
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("billing.reconcile.deferred",
      expect.objectContaining({ paymentId: payment.id, reason: "provider_order_not_found" }));

    vi.setSystemTime(new Date(now.getTime() + 16 * 60_000));
    await runBillingReconciliation();
    expect(fetch).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(now.getTime() + 24 * 60 * 60_000 + 1));
    await runBillingReconciliation();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("allows an explicit check after configuration recovery and clears the deferral", async () => {
    const payment = await pending("order_RecoveredProvider", {
      reconcileAfter: new Date(now.getTime() + 86400000), reconciliationIssue: "provider_order_not_found",
    });
    const fetch = vi.spyOn(razorpayService, "fetchCapturedPaymentForOrder").mockResolvedValue(null);
    await runBillingReconciliation();
    expect(fetch).not.toHaveBeenCalled();

    expect(await subscriptionService.reconcileCheckout(payment.organizationId.toString(), payment.razorpayOrderId))
      .toMatchObject({ status: "created", success: false });
    const stored = await SubscriptionPayment.findById(payment.id);
    expect(stored?.reconcileAfter).toBeFalsy();
    expect(stored?.reconciliationIssue).toBeFalsy();

    vi.setSystemTime(new Date(now.getTime() + 16 * 60_000));
    await runBillingReconciliation();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps transient provider failures on the existing retry cadence", async () => {
    const payment = await pending("order_TransientProvider");
    const fetch = vi.spyOn(razorpayService, "fetchCapturedPaymentForOrder")
      .mockRejectedValue(Object.assign(new Error("Unavailable"), { status: 503 }));
    await runBillingReconciliation();
    expect((await SubscriptionPayment.findById(payment.id))?.reconcileAfter).toBeNull();
    expect(console.error).toHaveBeenCalledWith("billing.reconcile.failed", expect.any(Object));

    vi.setSystemTime(new Date(now.getTime() + 10 * 60_000));
    await runBillingReconciliation();
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(now.getTime() + 16 * 60_000));
    await runBillingReconciliation();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves the created-age, terminal-status and abandoned-order boundaries", async () => {
    await pending("order_TooYoung", { createdAt: new Date(now.getTime() - 60_000) });
    await pending("order_Captured", { status: "captured" });
    await pending("order_Refunded", { status: "refunded" });
    await pending("order_Review", { status: "captured_review" });
    await pending("order_AbandonedRecent", { status: "abandoned", lastReconciledAt: new Date(now.getTime() - 60 * 60_000) });
    const due = await pending("order_AbandonedDue", { status: "abandoned", lastReconciledAt: new Date(now.getTime() - 25 * 60 * 60_000) });
    const fetch = vi.spyOn(razorpayService, "fetchCapturedPaymentForOrder").mockResolvedValue(null);
    await runBillingReconciliation();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(due.razorpayOrderId, 499);
  });
});
