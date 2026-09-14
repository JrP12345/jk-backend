import mongoose from "mongoose";
import { SaaSPlan } from "../../models/SaaSPlan.ts";
import { Subscription } from "../../models/Subscription.ts";
import { SubscriptionPayment } from "../../models/SubscriptionPayment.ts";
import { SaaSInvoice } from "../../models/SaaSInvoice.ts";
import { UsageRecord } from "../../models/UsageRecord.ts";
import { Organization } from "../../models/Organization.ts";
import { Clinic } from "../../models/Clinic.ts";
import { Doctor } from "../../models/Doctor.ts";
import { Receptionist } from "../../models/Receptionist.ts";
import { Patient } from "../../models/Patient.ts";
import { Appointment } from "../../models/Appointment.ts";
import { razorpayService } from "./RazorpayService.ts";
import { eventBus } from "../../events/eventBus.ts";
import { EVENT_TYPES } from "../../events/types.ts";

export class PlanDowngradeViolationError extends Error {
  statusCode: number;
  violations: Array<{
    resource: "clinics" | "doctors" | "staff";
    current: number;
    allowed: number;
    excess: number;
    message: string;
  }>;
  currentUsage: any;
  targetPlan: any;
  activeClinics: any[];

  constructor(validation: any) {
    super(validation.violations[0]?.message || "Active resources exceed target plan limits");
    this.name = "PlanDowngradeViolationError";
    this.statusCode = 409;
    this.violations = validation.violations;
    this.currentUsage = validation.currentUsage;
    this.targetPlan = validation.targetPlan;
    this.activeClinics = validation.activeClinics || [];
  }
}

export class SubscriptionService {
  /**
   * Get or initialize subscription for an organization (defaults to 15-day trial on Starter plan)
   */
  async getOrInitializeSubscription(organizationId: string, customTrialDays?: number) {
    let sub: any = await Subscription.findOne({ organizationId }).populate("planId");
    
    if (!sub) {
      const existingOrg = await Organization.findById(organizationId);
      const targetSlug = existingOrg?.plan || "starter";
      let chosenPlan = await SaaSPlan.findOne({ slug: targetSlug });
      if (!chosenPlan) {
        chosenPlan = await SaaSPlan.findOne({ slug: "starter" });
      }
      if (!chosenPlan) {
        chosenPlan = await SaaSPlan.create({
          name: "Starter",
          slug: "starter",
          description: "Essential tools for individual practitioners & single clinics",
          monthlyPrice: 0,
          annualPrice: 0,
          currency: "INR",
          trialDays: customTrialDays || 15,
          limits: {
            maxClinics: 1,
            maxDoctors: 2,
            maxStaff: 5,
            maxPatients: 500,
            maxAppointments: 1000,
            maxStorageMB: 1024,
            maxMonthlyWhatsApp: 100,
          },
          features: {
            analytics: false,
            auditLogs: false,
            multiBranch: false,
            dataExport: false,
            apiAccess: false,
            aiFeatures: false,
            whatsappIntegration: true,
          },
        });
      }

      const now = new Date();
      const trialDays = customTrialDays || chosenPlan.trialDays || 15;
      const trialEndsAt = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);

      sub = await Subscription.create({
        organizationId,
        planId: chosenPlan._id,
        status: existingOrg?.plan === "enterprise" ? "active" : "trialing",
        billingCycle: "monthly",
        trialStartedAt: now,
        trialEndsAt,
        currentPeriodStart: now,
        currentPeriodEnd: trialEndsAt,
      });

      if (existingOrg) {
        const newMaxClinics = Math.max(existingOrg.maxClinics ?? 1, chosenPlan.limits?.maxClinics ?? 1);
        const newMaxDoctors = Math.max(existingOrg.maxDoctors ?? 2, chosenPlan.limits?.maxDoctors ?? 2);
        const newMaxStaff = Math.max(existingOrg.maxStaff ?? 5, chosenPlan.limits?.maxStaff ?? 5);
        await Organization.findByIdAndUpdate(organizationId, {
          plan: existingOrg.plan || chosenPlan.slug,
          maxClinics: newMaxClinics,
          maxDoctors: newMaxDoctors,
          maxStaff: newMaxStaff,
        });
      }

      // Populate planId
      sub = await Subscription.findById(sub._id).populate("planId");
    }

    // Auto-expire trial if trial date passed
    if (sub.status === "trialing" && sub.trialEndsAt < new Date()) {
      sub.status = "expired";
      await sub.save();
    }

    return sub;
  }

  /**
   * Recalculate and return usage statistics vs active subscription plan limits
   */
  async getOrganizationUsage(organizationId: string) {
    const orgObjId = new mongoose.Types.ObjectId(organizationId);

    // Fetch active clinics count (only operating, non-deactivated branches)
    const clinicsCount = await Clinic.countDocuments({ organizationId: orgObjId, isActive: { $ne: false } });
    // Fetch active doctors count
    const doctorsCount = await Doctor.countDocuments({ organizationId: orgObjId, status: { $ne: "inactive" } });
    // Fetch active staff count (receptionists)
    const staffCount = await Receptionist.countDocuments({ organizationId: orgObjId, status: { $ne: "inactive" } });

    // Fetch patients count linked to org clinics
    const orgClinics = await Clinic.find({ organizationId: orgObjId, isActive: { $ne: false } }).select("_id");
    const clinicIds = orgClinics.map(c => c._id);
    const patientsCount = await Patient.countDocuments({ organizationId: orgObjId });
    const appointmentsCount = await Appointment.countDocuments({ clinicId: { $in: clinicIds } });

    // Update or upsert UsageRecord cache
    const usage = await UsageRecord.findOneAndUpdate(
      { organizationId: orgObjId },
      {
        clinicsCount,
        doctorsCount,
        staffCount,
        patientsCount,
        appointmentsCount,
        storageUsedBytes: 0,
        lastCalculatedAt: new Date(),
      },
      { upsert: true, returnDocument: 'after' }
    );

    const subscription = await this.getOrInitializeSubscription(organizationId);
    const plan = subscription.planId as any;

    return {
      usage,
      limits: plan ? plan.limits : {},
      features: plan ? plan.features : {},
      subscriptionStatus: subscription.status,
      planName: plan ? plan.name : "N/A",
      planSlug: plan ? plan.slug : "starter",
      trialEndsAt: subscription.trialEndsAt,
      currentPeriodEnd: subscription.currentPeriodEnd,
    };
  }

  /**
   * Validate if organization's active resource footprint fits within a target plan's quota limits.
   * Prevents downgrade to a tier where active clinics, doctors, or staff exceed the tier quota.
   */
  async validatePlanDowngrade(organizationId: string, targetPlanId: string) {
    const orgObjId = new mongoose.Types.ObjectId(organizationId);
    const targetPlan = await SaaSPlan.findById(targetPlanId);
    if (!targetPlan || targetPlan.status !== "active") {
      throw new Error("Target plan not found or not active");
    }

    const activeClinicsCount = await Clinic.countDocuments({ organizationId: orgObjId, isActive: { $ne: false } });
    const activeDoctorsCount = await Doctor.countDocuments({ organizationId: orgObjId, status: { $ne: "inactive" } });
    const activeStaffCount = await Receptionist.countDocuments({ organizationId: orgObjId, status: { $ne: "inactive" } });

    const activeClinics = await Clinic.find({ organizationId: orgObjId, isActive: { $ne: false } })
      .select("_id name city address phone")
      .lean();

    const maxClinics = targetPlan.limits?.maxClinics ?? 1;
    const maxDoctors = targetPlan.limits?.maxDoctors ?? 2;
    const maxStaff = targetPlan.limits?.maxStaff ?? 5;

    const violations: Array<{
      resource: "clinics" | "doctors" | "staff";
      current: number;
      allowed: number;
      excess: number;
      message: string;
    }> = [];

    if (activeClinicsCount > maxClinics) {
      violations.push({
        resource: "clinics",
        current: activeClinicsCount,
        allowed: maxClinics,
        excess: activeClinicsCount - maxClinics,
        message: `You currently have ${activeClinicsCount} active clinic branches, but the ${targetPlan.name} plan allows a maximum of ${maxClinics}. Please deactivate ${activeClinicsCount - maxClinics} branch(es) before downgrading.`,
      });
    }

    if (activeDoctorsCount > maxDoctors) {
      violations.push({
        resource: "doctors",
        current: activeDoctorsCount,
        allowed: maxDoctors,
        excess: activeDoctorsCount - maxDoctors,
        message: `You currently have ${activeDoctorsCount} active doctors, but the ${targetPlan.name} plan allows a maximum of ${maxDoctors}. Please deactivate ${activeDoctorsCount - maxDoctors} doctor(s) before downgrading.`,
      });
    }

    if (activeStaffCount > maxStaff) {
      violations.push({
        resource: "staff",
        current: activeStaffCount,
        allowed: maxStaff,
        excess: activeStaffCount - maxStaff,
        message: `You currently have ${activeStaffCount} active staff members, but the ${targetPlan.name} plan allows a maximum of ${maxStaff}. Please deactivate ${activeStaffCount - maxStaff} staff member(s) before downgrading.`,
      });
    }

    return {
      canDowngrade: violations.length === 0,
      targetPlan: {
        id: targetPlan._id.toString(),
        name: targetPlan.name,
        slug: targetPlan.slug,
        monthlyPrice: targetPlan.monthlyPrice,
        limits: targetPlan.limits,
      },
      currentUsage: {
        clinics: activeClinicsCount,
        doctors: activeDoctorsCount,
        staff: activeStaffCount,
      },
      activeClinics: activeClinics.map((c: any) => ({
        id: c._id.toString(),
        name: c.name,
        city: c.city,
        address: c.address,
      })),
      violations,
    };
  }

  /**
   * Direct Switch Plan (for free tiers or direct plan adjustments without Razorpay gateway order)
   */
  async directSwitchPlan(organizationId: string, planId: string, billingCycle: "monthly" | "annual" = "monthly") {
    const plan = await SaaSPlan.findById(planId);
    if (!plan || plan.status !== "active") {
      throw new Error("Selected plan is not available");
    }

    const validation = await this.validatePlanDowngrade(organizationId, planId);
    if (!validation.canDowngrade) {
      throw new PlanDowngradeViolationError(validation);
    }

    const subscription = await this.getOrInitializeSubscription(organizationId);

    const now = new Date();
    const periodEnd = new Date(now);
    if (billingCycle === "annual") {
      periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    } else {
      periodEnd.setMonth(periodEnd.getMonth() + 1);
    }

    subscription.planId = plan._id;
    subscription.status = "active";
    subscription.billingCycle = billingCycle;
    subscription.currentPeriodStart = now;
    subscription.currentPeriodEnd = periodEnd;
    await subscription.save();

    await Organization.findByIdAndUpdate(organizationId, {
      plan: plan.slug,
      maxClinics: plan.limits?.maxClinics ?? 1,
      maxDoctors: plan.limits?.maxDoctors ?? 2,
      maxStaff: plan.limits?.maxStaff ?? 5,
    });

    eventBus.publish({
      eventType: EVENT_TYPES.BILLING_INVOICE_GENERATED,
      category: "billing",
      organizationId,
      title: "Plan Changed",
      message: `Your subscription has been switched to ${plan.name} (${billingCycle}).`,
      severity: "info",
      actionUrl: "/dashboard/settings/billing",
    });

    return {
      subscription,
      planName: plan.name,
      planSlug: plan.slug,
    };
  }

  /**
   * Create Razorpay Checkout Order for upgrade or renewal
   */
  async createCheckoutOrder(organizationId: string, planId: string, billingCycle: "monthly" | "annual") {
    const plan = await SaaSPlan.findById(planId);
    if (!plan || plan.status !== "active") {
      throw new Error("Selected plan is not available");
    }

    // Pre-flight check: Ensure active resource footprint fits within plan limits
    const validation = await this.validatePlanDowngrade(organizationId, planId);
    if (!validation.canDowngrade) {
      throw new PlanDowngradeViolationError(validation);
    }

    const subscription = await this.getOrInitializeSubscription(organizationId);
    const basePrice = billingCycle === "annual" ? plan.annualPrice : plan.monthlyPrice;
    const taxRate = 0.18; // GST 18%
    const taxAmount = Math.round(basePrice * taxRate);
    const totalAmount = basePrice + taxAmount;

    const receipt = `rcpt_${organizationId.substring(0, 8)}_${Date.now()}`;
    const order = await razorpayService.createOrder({
      amount: totalAmount,
      currency: "INR",
      receipt,
      notes: {
        organizationId,
        planId,
        planSlug: plan.slug,
        billingCycle,
      },
    });

    const payment = await SubscriptionPayment.create({
      organizationId,
      subscriptionId: subscription._id,
      planId: plan._id,
      razorpayOrderId: order.id,
      amount: totalAmount,
      currency: "INR",
      status: "created",
      billingCycle,
    });

    const publicParams = await razorpayService.getPublicParams();

    return {
      orderId: order.id,
      amount: totalAmount,
      currency: "INR",
      keyId: publicParams.keyId,
      planName: plan.name,
      planSlug: plan.slug,
      billingCycle,
      paymentId: payment._id.toString(),
    };
  }

  /**
   * Verify Razorpay Payment Signature & Activate Subscription
   */
  async verifyAndActivateSubscription(
    organizationId: string,
    razorpayOrderId: string,
    razorpayPaymentId: string,
    razorpaySignature: string
  ) {
    const payment = await SubscriptionPayment.findOne({ razorpayOrderId, organizationId });
    if (!payment) {
      throw new Error("Payment record not found");
    }

    if (payment.status === "captured") {
      // Idempotency: Already processed cleanly
      const sub = await Subscription.findById(payment.subscriptionId).populate("planId");
      return { success: true, subscription: sub, message: "Subscription already activated" };
    }

    const isValid = razorpayService.verifyPaymentSignature(
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature
    );

    if (!isValid) {
      payment.status = "failed";
      payment.failureReason = "Invalid HMAC payment signature";
      await payment.save();
      throw new Error("Payment verification failed: Invalid signature");
    }

    // Update payment record
    payment.razorpayPaymentId = razorpayPaymentId;
    payment.razorpaySignature = razorpaySignature;
    payment.status = "captured";
    payment.paidAt = new Date();
    await payment.save();

    // Activate subscription & calculate extended period
    const plan = await SaaSPlan.findById(payment.planId);
    if (!plan) throw new Error("Plan not found");

    const subscription = await Subscription.findById(payment.subscriptionId);
    if (!subscription) throw new Error("Subscription not found");

    const now = new Date();
    const periodStart = subscription.currentPeriodEnd > now ? subscription.currentPeriodEnd : now;
    const periodEnd = new Date(periodStart);

    if (payment.billingCycle === "annual") {
      periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    } else {
      periodEnd.setMonth(periodEnd.getMonth() + 1);
    }

    subscription.planId = plan._id;
    subscription.status = "active";
    subscription.billingCycle = payment.billingCycle;
    subscription.currentPeriodStart = periodStart;
    subscription.currentPeriodEnd = periodEnd;
    await subscription.save();

    // Sync Organization resource quotas
    await Organization.findByIdAndUpdate(organizationId, {
      plan: plan.slug,
      maxClinics: plan.limits?.maxClinics ?? 1,
      maxDoctors: plan.limits?.maxDoctors ?? 2,
      maxStaff: plan.limits?.maxStaff ?? 5,
    });

    // Generate SaaS Commercial Invoice
    const { getNextAtomicSequence } = await import("../../models/Counter.ts");
    const currentYear = new Date().getFullYear();
    const seq = await getNextAtomicSequence(`saas_invoice_${currentYear}`);
    const invoiceNumber = `SAAS-${currentYear}-${seq.toString().padStart(6, "0")}`;

    const org = await Organization.findById(organizationId);

    const subtotal = Math.round(payment.amount / 1.18);
    const taxAmount = payment.amount - subtotal;

    const invoice = await SaaSInvoice.create({
      invoiceNumber,
      organizationId,
      subscriptionId: subscription._id,
      paymentId: payment._id,
      planName: plan.name,
      billingCycle: payment.billingCycle,
      subtotal,
      taxAmount,
      totalAmount: payment.amount,
      currency: "INR",
      status: "paid",
      billingDetails: {
        orgName: org?.name || "Organization",
        gstin: (org as any)?.gstin || null,
        address: org?.address || null,
        city: org?.city || null,
        email: org?.email || null,
      },
      paidAt: new Date(),
    });

    // Dispatch Event & Notifications
    eventBus.publish({
      eventType: EVENT_TYPES.BILLING_INVOICE_GENERATED,
      category: "billing",
      organizationId,
      title: "Subscription Activated",
      message: `Your ${plan.name} (${payment.billingCycle}) subscription is now active! Invoice #${invoiceNumber} generated.`,
      severity: "success",
      actionUrl: "/dashboard/settings/billing",
    });

    // Send Commercial Invoice Email Notification
    const recipientEmail = org?.email || (invoice.billingDetails as any)?.email;
    if (recipientEmail && !recipientEmail.includes("placeholder.com")) {
      try {
        const emailBodyHtml = `
          <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f8fafc; padding: 30px; color: #1e293b;">
            <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; padding: 30px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
              <div style="text-align: center; border-bottom: 2px solid #0284c7; padding-bottom: 20px; margin-bottom: 20px;">
                <h1 style="color: #0284c7; margin: 0; font-size: 24px;">ANANT Healthcare SaaS</h1>
                <p style="color: #64748b; font-size: 13px; margin-top: 4px;">Commercial Subscription Invoice Receipt</p>
              </div>
              
              <p style="font-size: 15px; font-weight: 600;">Dear ${org?.name || "Customer"},</p>
              <p style="font-size: 14px; color: #334155; line-height: 1.6;">
                Thank you for subscribing to ANANT. Your payment for the <strong>${plan.name} Plan (${payment.billingCycle})</strong> has been successfully processed.
              </p>

              <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 13px;">
                <tr style="background: #f1f5f9;">
                  <td style="padding: 10px; border: 1px solid #cbd5e1; font-weight: bold;">Invoice Number</td>
                  <td style="padding: 10px; border: 1px solid #cbd5e1; font-family: monospace;">${invoiceNumber}</td>
                </tr>
                <tr>
                  <td style="padding: 10px; border: 1px solid #cbd5e1; font-weight: bold;">Plan Name</td>
                  <td style="padding: 10px; border: 1px solid #cbd5e1;">${plan.name} (${payment.billingCycle})</td>
                </tr>
                <tr style="background: #f1f5f9;">
                  <td style="padding: 10px; border: 1px solid #cbd5e1; font-weight: bold;">Paid Amount</td>
                  <td style="padding: 10px; border: 1px solid #cbd5e1; font-weight: bold; color: #0284c7;">₹${payment.amount.toLocaleString("en-IN")} INR</td>
                </tr>
              </table>

              <p style="font-size: 13px; color: #64748b;">
                You can download a PDF copy of this invoice directly from your Organization Settings -> Commercial Billing & Subscription dashboard.
              </p>

              <div style="margin-top: 30px; padding-top: 15px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 12px; color: #94a3b8;">
                ANANT Healthcare SaaS System • Automated Commercial Billing & Invoicing
              </div>
            </div>
          </div>
        `;

        const { emailProvider } = await import("../../notifications/providers/emailProvider.ts");
        await emailProvider.sendEmail({
          to: recipientEmail,
          subject: `[ANANT Invoice #${invoiceNumber}] Subscription Payment Confirmed - ${plan.name} Plan`,
          html: emailBodyHtml,
        });
      } catch (emailErr) {
        console.error("Failed to send subscription invoice email:", emailErr);
      }
    }

    const updatedSub = await Subscription.findById(subscription._id).populate("planId");
    return {
      success: true,
      subscription: updatedSub,
      invoice,
      message: "Subscription activated successfully",
    };
  }

  /**
   * Process Razorpay Webhook Event Idempotently
   */
  async processRazorpayWebhook(rawBody: string, signature: string, eventData: any) {
    const isValid = await razorpayService.verifyWebhookSignature(rawBody, signature);
    if (!isValid) {
      throw new Error("Invalid webhook signature");
    }

    const event = eventData.event;
    const payload = eventData.payload;

    if (event === "payment.captured") {
      const paymentEntity = payload.payment?.entity;
      if (paymentEntity && paymentEntity.order_id) {
        const orderId = paymentEntity.order_id;
        const paymentId = paymentEntity.id;

        const existingPayment = await SubscriptionPayment.findOne({ razorpayOrderId: orderId });
        if (existingPayment && existingPayment.status !== "captured") {
          await this.verifyAndActivateSubscription(
            existingPayment.organizationId.toString(),
            orderId,
            paymentId,
            "webhook_verified_signature"
          );
        }
      }
    } else if (event === "payment.failed") {
      const paymentEntity = payload.payment?.entity;
      if (paymentEntity && paymentEntity.order_id) {
        const payment = await SubscriptionPayment.findOne({ razorpayOrderId: paymentEntity.order_id });
        if (payment) {
          payment.status = "failed";
          payment.failureReason = paymentEntity.error_description || "Payment failed at gateway";
          await payment.save();

          await Subscription.findByIdAndUpdate(payment.subscriptionId, { status: "payment_failed" });
        }
      }
    }

    return { received: true };
  }

  /**
   * Cancel Subscription
   */
  async cancelSubscription(organizationId: string) {
    const sub = await Subscription.findOne({ organizationId });
    if (!sub) throw new Error("No subscription found");

    sub.cancelledAt = new Date();
    await sub.save();

    // Dispatch In-App Event Notification
    eventBus.publish({
      eventType: EVENT_TYPES.SYSTEM_ALERT,
      category: "billing",
      organizationId,
      title: "Subscription Cancellation Requested",
      message: "Your subscription auto-renewal has been cancelled. Plan access remains active until the end of your billing cycle.",
      severity: "warning",
      actionUrl: "/dashboard/settings/billing",
    });

    // Send Confirmation Email
    const org = await Organization.findById(organizationId);
    if (org?.email && !org.email.includes("placeholder.com")) {
      try {
        const { emailProvider } = await import("../../notifications/providers/emailProvider.ts");
        await emailProvider.sendEmail({
          to: org.email,
          subject: `[ANANT] Subscription Cancellation Confirmed - ${org.name}`,
          html: `<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">
            <h2>Subscription Cancellation Confirmed</h2>
            <p>Dear ${org.name},</p>
            <p>Your subscription auto-renewal for ANANT SaaS has been cancelled as requested.</p>
            <p>Your organization's current plan features and resource limits will remain active until the end of your current billing period.</p>
            <p>Best regards,<br/>ANANT Billing Team</p>
          </div>`,
        });
      } catch (emailErr) {
        console.error("Failed to send cancellation email:", emailErr);
      }
    }

    return sub;
  }
}

export const subscriptionService = new SubscriptionService();
