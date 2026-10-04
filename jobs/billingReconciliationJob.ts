import crypto from "node:crypto";
import { SubscriptionPayment } from "../models/SubscriptionPayment.ts";
import { subscriptionService } from "../services/billing/SubscriptionService.ts";
import { acquireOrRenewWorkerLease } from "../utilities/workerLease.ts";

const holderId = `${process.env.HOSTNAME || "api"}:${process.pid}:${crypto.randomUUID()}`;
let timer: NodeJS.Timeout | null = null;

export async function runBillingReconciliation() {
  const now = Date.now();
  const pending = await SubscriptionPayment.find({
    createdAt: { $lte: new Date(now - 2 * 60_000) },
    // Explicit local simulation references never identify a gateway Order.
    // Do not guess validity from the length/case of other legacy order IDs.
    razorpayOrderId: { $not: /^order_(?:sim|test)_/ },
    $and: [{ $or: [{ reconcileAfter: null }, { reconcileAfter: { $lte: new Date(now) } }] }],
    $or: [
      { status: { $in: ["created", "failed"] }, $or: [
        { lastReconciledAt: null }, { lastReconciledAt: { $lte: new Date(now - 15 * 60_000) } },
      ] },
      { status: "abandoned", $or: [
        { lastReconciledAt: null }, { lastReconciledAt: { $lte: new Date(now - 24 * 60 * 60_000) } },
      ] },
    ],
  }).sort({ lastReconciledAt: 1, createdAt: 1 }).limit(100).lean();
  for (const payment of pending) {
    try {
      await subscriptionService.reconcileCheckout(payment.organizationId.toString(), payment.razorpayOrderId);
    } catch (err) {
      const missingOrder = (err as { status?: number } | null)?.status === 404;
      const details = {
        paymentId: payment._id.toString(), organizationId: payment.organizationId.toString(),
        orderId: payment.razorpayOrderId, error: err instanceof Error ? err.message : String(err),
      };
      const checkedAt = new Date();
      if (missingOrder) {
        const retryAt = new Date(checkedAt.getTime() + 24 * 60 * 60_000);
        console.warn("billing.reconcile.deferred", { ...details,
          reason: "provider_order_not_found", retryAt: retryAt.toISOString() });
        await SubscriptionPayment.updateOne({ _id: payment._id }, { $set: {
          lastReconciledAt: checkedAt, reconcileAfter: retryAt,
          reconciliationIssue: "provider_order_not_found",
        } });
      } else {
        console.error("billing.reconcile.failed", details);
        await SubscriptionPayment.updateOne({ _id: payment._id }, { $set: { lastReconciledAt: checkedAt } });
      }
    }
  }
}

export function startBillingReconciliationJob(intervalMs = 5 * 60_000) {
  if (timer) return;
  timer = setInterval(async () => {
    try {
      if (await acquireOrRenewWorkerLease({ name: "billing-reconciliation", holderId, leaseMs: intervalMs * 2 })) {
        await runBillingReconciliation();
      }
    } catch (err) {
      console.error("billing.reconcile.job.failed", err);
    }
  }, intervalMs);
  timer.unref?.();
}

export function stopBillingReconciliationJob() {
  if (timer) clearInterval(timer);
  timer = null;
}
