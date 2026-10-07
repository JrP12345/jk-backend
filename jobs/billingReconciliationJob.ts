import { WorkerLoop } from "../utilities/workerLoop.ts";
import { reconcileAppointmentOrderIntents } from "../services/AppointmentOrderReconciliationService.ts";
import { releaseWorkerLease } from "../utilities/workerLease.ts";
import crypto from "node:crypto";
import { SubscriptionPayment } from "../models/SubscriptionPayment.ts";
import { subscriptionService } from "../services/billing/SubscriptionService.ts";
import { acquireOrRenewWorkerLease } from "../utilities/workerLease.ts";

const holderId = `${process.env.HOSTNAME || "api"}:${process.pid}:${crypto.randomUUID()}`;
const loop = new WorkerLoop();

export async function runBillingReconciliation() {
  const now = Date.now();
  const pending = await SubscriptionPayment.find({
    createdAt: { $lte: new Date(now - 2 * 60_000) },
    // Explicit local simulation references never identify a gateway Order.
    // Do not guess validity from the length/case of other provider order IDs.
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
  loop.start(async () => {
    if (!await acquireOrRenewWorkerLease({ name: "billing-reconciliation", holderId, leaseMs: 120_000 })) return { processed: 1 };
    const heartbeat = setInterval(() => { void acquireOrRenewWorkerLease({ name: "billing-reconciliation", holderId, leaseMs: 120_000 }).catch(() => console.error("billing.reconcile.lease.failed")); }, 20_000);
    heartbeat.unref?.();
    try { await reconcileAppointmentOrderIntents(); await runBillingReconciliation(); return { processed: 1 }; }
    finally { clearInterval(heartbeat); await releaseWorkerLease("billing-reconciliation", holderId); }
  }, intervalMs);
}
export async function stopBillingReconciliationJob() { await loop.stop(); }
