import type { FastifyRequest, FastifyReply } from "fastify";
import { SaaSPlan } from "../models/SaaSPlan.ts";
import { Subscription } from "../models/Subscription.ts";
import { SubscriptionPayment } from "../models/SubscriptionPayment.ts";
import { SaaSInvoice } from "../models/SaaSInvoice.ts";
import { subscriptionService } from "../services/billing/SubscriptionService.ts";
import { razorpayService } from "../services/billing/RazorpayService.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

/**
 * Get active commercial SaaS plans
 */
export async function getSaaSPlans(req: FastifyRequest, reply: FastifyReply) {
  try {
    const plans = await SaaSPlan.find({ status: "active" }).sort({ displayOrder: 1 }).lean();
    const formatted = plans.map((p: any) => ({ ...p, id: p._id.toString() }));
    return reply.code(200).send(successResponse(formatted, "SaaS plans fetched successfully"));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to fetch SaaS plans", err.message));
  }
}

/**
 * Get subscription details for authenticated user's organization
 */
export async function getSubscriptionDetails(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    if (!orgId) {
      return reply.code(400).send(errorResponse("No organization linked to account"));
    }

    const subscription = await subscriptionService.getOrInitializeSubscription(orgId);
    return reply.code(200).send(successResponse(subscription));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to fetch subscription details", err.message));
  }
}

/**
 * Get organization usage metrics & quota limits
 */
export async function getOrganizationUsageMetrics(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    if (!orgId) {
      return reply.code(400).send(errorResponse("No organization linked to account"));
    }

    const usageInfo = await subscriptionService.getOrganizationUsage(orgId);
    return reply.code(200).send(successResponse(usageInfo));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to fetch organization usage", err.message));
  }
}

/**
 * Create Razorpay Order for Checkout
 */
export async function createCheckoutOrderController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    if (!orgId) {
      return reply.code(400).send(errorResponse("No organization linked to account"));
    }

    const { planId, billingCycle } = req.body as { planId: string; billingCycle?: "monthly" | "annual" };
    if (!planId) {
      return reply.code(400).send(errorResponse("planId is required"));
    }

    const checkoutData = await subscriptionService.createCheckoutOrder(
      orgId,
      planId,
      billingCycle || "monthly"
    );

    return reply.code(200).send(successResponse(checkoutData, "Checkout order created successfully"));
  } catch (err: any) {
    return reply.code(400).send(errorResponse(err.message || "Failed to create checkout order"));
  }
}

/**
 * Verify Razorpay Payment Signature and activate subscription
 */
export async function verifyPaymentController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    if (!orgId) {
      return reply.code(400).send(errorResponse("No organization linked to account"));
    }

    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body as {
      razorpayOrderId: string;
      razorpayPaymentId: string;
      razorpaySignature: string;
    };

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return reply.code(400).send(errorResponse("razorpayOrderId, razorpayPaymentId, and razorpaySignature are required"));
    }

    const result = await subscriptionService.verifyAndActivateSubscription(
      orgId,
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature
    );

    return reply.code(200).send(successResponse(result, "Subscription payment verified and activated successfully"));
  } catch (err: any) {
    return reply.code(400).send(errorResponse(err.message || "Payment verification failed"));
  }
}

/**
 * Razorpay Webhook Handler (Idempotent Signature Verification)
 */
export async function razorpayWebhookController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const signature = req.headers["x-razorpay-signature"] as string;
    const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);

    const result = await subscriptionService.processRazorpayWebhook(rawBody, signature || "", req.body);
    return reply.code(200).send(result);
  } catch (err: any) {
    req.log.error(`Razorpay webhook error: ${err.message}`);
    return reply.code(400).send({ error: err.message || "Webhook processing failed" });
  }
}

/**
 * Cancel Subscription
 */
export async function cancelSubscriptionController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    if (!orgId) {
      return reply.code(400).send(errorResponse("No organization linked to account"));
    }

    const result = await subscriptionService.cancelSubscription(orgId);
    return reply.code(200).send(successResponse(result, "Subscription cancelled successfully"));
  } catch (err: any) {
    return reply.code(400).send(errorResponse(err.message || "Failed to cancel subscription"));
  }
}

/**
 * List SaaS Invoices for organization
 */
export async function getSaaSInvoices(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    if (!orgId) {
      return reply.code(400).send(errorResponse("No organization linked to account"));
    }

    const invoices = await SaaSInvoice.find({ organizationId: orgId }).sort({ createdAt: -1 }).lean();
    const formatted = invoices.map((inv: any) => ({ ...inv, id: inv._id.toString() }));
    return reply.code(200).send(successResponse(formatted));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to fetch SaaS invoices", err.message));
  }
}

// ─── ADMIN CONTROLLERS ──────────────────────────────────────────────

/**
 * Platform Admin: Get all plans
 */
export async function adminGetPlans(req: FastifyRequest, reply: FastifyReply) {
  try {
    const plans = await SaaSPlan.find({}).sort({ displayOrder: 1 }).lean();
    const formatted = plans.map((p: any) => ({ ...p, id: p._id.toString() }));
    return reply.code(200).send(successResponse(formatted));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to fetch admin plans", err.message));
  }
}

/**
 * Platform Admin: Create or update SaaS Plan
 */
export async function adminUpsertPlan(req: FastifyRequest, reply: FastifyReply) {
  try {
    const body = req.body as any;
    if (!body.name || !body.slug) {
      return reply.code(400).send(errorResponse("Name and slug are required"));
    }

    const plan = await SaaSPlan.findOneAndUpdate(
      { slug: body.slug },
      { $set: body },
      { upsert: true, returnDocument: "after" }
    );

    return reply.code(200).send(successResponse(plan, "SaaS Plan saved successfully"));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to save SaaS plan", err.message));
  }
}

/**
 * Platform Admin: List all subscriptions across platform
 */
export async function adminGetSubscriptions(req: FastifyRequest, reply: FastifyReply) {
  try {
    const subscriptions = await Subscription.find({})
      .populate("organizationId", "name city email plan")
      .populate("planId")
      .sort({ createdAt: -1 })
      .lean();

    const formatted = subscriptions.map((s: any) => ({ ...s, id: s._id.toString() }));
    return reply.code(200).send(successResponse(formatted));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to fetch admin subscriptions", err.message));
  }
}

/**
 * Platform Admin: Extend Trial Period for an organization
 */
export async function adminExtendTrial(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const { extraDays } = req.body as { extraDays: number };

    const subscription = await Subscription.findById(id);
    if (!subscription) {
      return reply.code(404).send(errorResponse("Subscription not found"));
    }

    const daysToAdd = extraDays || 15;
    const currentTrialEnd = subscription.trialEndsAt > new Date() ? subscription.trialEndsAt : new Date();
    subscription.trialEndsAt = new Date(currentTrialEnd.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
    subscription.currentPeriodEnd = subscription.trialEndsAt;
    subscription.status = "trialing";
    await subscription.save();

    // Dispatch In-App Event Notification
    const { eventBus } = await import("../events/eventBus.ts");
    const { EVENT_TYPES } = await import("../events/types.ts");
    eventBus.publish({
      eventType: EVENT_TYPES.SYSTEM_ALERT,
      category: "billing",
      organizationId: subscription.organizationId.toString(),
      title: "Free Trial Extended! 🎉",
      message: `Root Admin extended your free trial by ${daysToAdd} extra days! Your trial now ends on ${subscription.trialEndsAt.toLocaleDateString()}.`,
      severity: "success",
      actionUrl: "/dashboard/settings/billing",
    });

    // Send Notification Email
    const { Organization } = await import("../models/Organization.ts");
    const { emailProvider } = await import("../notifications/providers/emailProvider.ts");
    const org = await Organization.findById(subscription.organizationId);
    if (org?.email && !org.email.includes("placeholder.com")) {
      try {
        await emailProvider.sendEmail({
          to: org.email,
          subject: `[ANANTA] Free Trial Extended for ${org.name}`,
          html: `<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">
            <h2>Great News! Free Trial Extended 🎉</h2>
            <p>Dear ${org.name},</p>
            <p>Your free trial of ANANTA Healthcare SaaS has been extended by <strong>${daysToAdd} additional days</strong>.</p>
            <p>Your trial will now expire on <strong>${subscription.trialEndsAt.toLocaleDateString()}</strong>.</p>
            <p>Best regards,<br/>ANANTA Platform Operations</p>
          </div>`,
        });
      } catch (e) {
        console.error("Failed to send trial extension email:", e);
      }
    }

    return reply.code(200).send(successResponse(subscription, `Trial extended by ${daysToAdd} days`));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to extend trial", err.message));
  }
}

/**
 * Platform Admin: Refund Payment
 */
export async function adminRefundPayment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { paymentId } = req.params as { paymentId: string };
    const payment = await SubscriptionPayment.findById(paymentId);
    if (!payment) {
      return reply.code(404).send(errorResponse("Payment record not found"));
    }

    const refund = await razorpayService.processRefund({
      paymentId: payment.razorpayPaymentId || payment._id.toString(),
      amount: payment.amount,
    });

    payment.status = "refunded";
    await payment.save();

    await SaaSInvoice.findOneAndUpdate(
      { paymentId: payment._id },
      { status: "refunded" }
    );

    return reply.code(200).send(successResponse(refund, "Refund processed successfully"));
  } catch (err: any) {
    return reply.code(400).send(errorResponse("Failed to process refund", err.message));
  }
}

/**
 * Platform Admin: Get dynamic Razorpay Gateway credentials from MongoDB
 */
export async function adminGetRazorpayConfig(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { SaaSConfig } = await import("../models/SaaSConfig.ts");
    const config = await SaaSConfig.findOne({ key: "platform_config" }).lean();
    return reply.code(200).send(successResponse({
      keyId: config?.razorpayKeyId || process.env.RAZORPAY_KEY_ID || "",
      keySecret: config?.razorpayKeySecret || process.env.RAZORPAY_KEY_SECRET || "",
      webhookSecret: config?.razorpayWebhookSecret || process.env.RAZORPAY_WEBHOOK_SECRET || "ananta_razorpay_webhook_secret_2026",
      isLiveMode: config?.isLiveMode || false,
    }));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to fetch Razorpay gateway config", err.message));
  }
}

/**
 * Platform Admin: Save dynamic Razorpay Gateway credentials into MongoDB
 */
export async function adminSaveRazorpayConfig(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { SaaSConfig } = await import("../models/SaaSConfig.ts");
    const { keyId, keySecret, webhookSecret, isLiveMode } = req.body as {
      keyId: string;
      keySecret: string;
      webhookSecret?: string;
      isLiveMode?: boolean;
    };

    const updateFields: any = {
      key: "platform_config",
      razorpayKeyId: (keyId || "").trim(),
      razorpayKeySecret: (keySecret || "").trim(),
      razorpayWebhookSecret: (webhookSecret || "ananta_razorpay_webhook_secret_2026").trim(),
      isLiveMode: isLiveMode || false,
    };

    const config = await SaaSConfig.findOneAndUpdate(
      { key: "platform_config" },
      { $set: updateFields },
      { upsert: true, returnDocument: "after" }
    );

    return reply.code(200).send(successResponse(config, "Platform Razorpay Gateway credentials saved dynamically to MongoDB!"));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to save Razorpay config to MongoDB", err.message));
  }
}
