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
      console.error("billing.reconcile.failed", {
        paymentId: payment._id.toString(), organizationId: payment.organizationId.toString(),
        orderId: payment.razorpayOrderId, error: err instanceof Error ? err.message : String(err),
      });
      await SubscriptionPayment.updateOne({ _id: payment._id }, { $set: { lastReconciledAt: new Date() } });
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
