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
import { enqueueTransactionalEmail } from "../CommunicationOutbox.ts";
import { withTransaction, createWithSession } from "../../utilities/transaction.ts";
import { logger } from "../../utilities/logger.ts";

export function addBillingPeriod(start: Date, billingCycle: "monthly" | "annual") {
  const months = billingCycle === "annual" ? 12 : 1;
  const result = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1,
    start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(start.getUTCDate(), lastDay));
  return result;
}

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
  async createInitialSubscription(
    organizationId: string,
    planSlug: string,
    customTrialDays: number | undefined,
    session: mongoose.ClientSession | null,
  ) {
    if (customTrialDays !== undefined && (!Number.isInteger(customTrialDays) || customTrialDays < 1 || customTrialDays > 365)) {
      throw new Error("Trial duration must be between 1 and 365 days");
    }

    let planQuery = SaaSPlan.findOne({ slug: planSlug, status: "active" });
    if (session) planQuery = planQuery.session(session);
    let chosenPlan = await planQuery;
    if (!chosenPlan && planSlug === "pro") {
      planQuery = SaaSPlan.findOne({ slug: "professional", status: "active" });
      if (session) planQuery = planQuery.session(session);
      chosenPlan = await planQuery;
    }
    if (!chosenPlan) {
      planQuery = SaaSPlan.findOne({ slug: "starter", status: "active" });
      if (session) planQuery = planQuery.session(session);
      chosenPlan = await planQuery;
    }
    if (!chosenPlan) {
      chosenPlan = await createWithSession(SaaSPlan, {
        name: "Starter",
        slug: "starter",
        description: "Essential tools for individual practitioners & single clinics",
        monthlyPrice: 0,
        annualPrice: 0,
        currency: "INR",
        trialDays: 15,
        limits: { maxClinics: 1, maxDoctors: 2, maxStaff: 5, maxPatients: 500, maxAppointments: 1000, maxStorageMB: 1024, maxMonthlyWhatsApp: 100 },
        features: { analytics: false, auditLogs: false, multiBranch: false, dataExport: false, apiAccess: false, aiFeatures: false, whatsappIntegration: true },
      }, session);
    }
    if (!chosenPlan) throw new Error("Failed to initialize a subscription plan");

    const now = new Date();
    const trialDays = customTrialDays ?? chosenPlan.trialDays ?? 15;
    const trialEndsAt = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);
    const manualEnterprise = planSlug === "enterprise" && customTrialDays === undefined;
    return createWithSession(Subscription, {
      organizationId,
      planId: chosenPlan._id,
      status: manualEnterprise ? "active" : "trialing",
      entitlementSource: manualEnterprise ? "manual" : "trial",
      billingCycle: "monthly",
      trialStartedAt: now,
      trialEndsAt,
      currentPeriodStart: now,
      currentPeriodEnd: trialEndsAt,
    }, session);
  }

  /**
   * Get or initialize subscription for an organization (defaults to 15-day trial on Starter plan)
   */
  async getOrInitializeSubscription(organizationId: string, customTrialDays?: number) {
    let sub: any = await Subscription.findOne({ organizationId }).populate("planId");
    
    if (!sub) {
      const claimToken = new mongoose.Types.ObjectId().toString();
      let acquired = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const claimedOrg = await Organization.findOneAndUpdate({ _id: organizationId, $or: [
          { billingInitializationToken: null },
          { billingInitializationToken: { $exists: false } },
          { billingInitializationAt: { $lte: new Date(Date.now() - 120_000) } },
        ] }, { $set: { billingInitializationToken: claimToken, billingInitializationAt: new Date() } },
        { returnDocument: "after" });
        if (claimedOrg) { acquired = true; break; }
        sub = await Subscription.findOne({ organizationId }).populate("planId");
        if (sub) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!sub && !acquired) throw new Error("Subscription initialization is in progress. Please retry shortly.");
      if (acquired) try {
      sub = await Subscription.findOne({ organizationId }).populate("planId");
      if (!sub) {
      const existingOrg = await Organization.findById(organizationId);
      const targetSlug = existingOrg?.plan || "starter";
      let chosenPlan = await SaaSPlan.findOne({ slug: targetSlug });
      if (!chosenPlan && targetSlug === "pro") {
        chosenPlan = await SaaSPlan.findOne({ slug: "professional" });
      }
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
          trialDays: customTrialDays ?? 15,
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
      const trialDays = customTrialDays ?? chosenPlan.trialDays ?? 15;
      const trialEndsAt = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);

      sub = await Subscription.create({
        organizationId,
        planId: chosenPlan._id,
        status: existingOrg?.plan === "enterprise" ? "active" : "trialing",
        entitlementSource: existingOrg?.plan === "enterprise" ? "manual" : "trial",
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
      } finally {
        await Organization.updateOne({ _id: organizationId, billingInitializationToken: claimToken },
          { $unset: { billingInitializationToken: "", billingInitializationAt: "" } });
      }
    }

    // Expire only the period observed here. A payment may activate a new period
    // concurrently, so saving a stale document would undo that activation.
    const now = new Date();
    if ((sub.status === "trialing" && sub.trialEndsAt <= now) ||
        (sub.status === "active" && sub.currentPeriodEnd <= now)) {
      await Subscription.updateOne({ _id: sub._id, $or: [
        { status: "trialing", trialEndsAt: { $lte: now } },
        { status: "active", currentPeriodEnd: { $lte: now } },
      ] }, { $set: { status: "expired" } });
      sub = await Subscription.findById(sub._id).populate("planId");
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
    if (billingCycle !== "monthly" && billingCycle !== "annual") throw new Error("Invalid billing cycle");
    const plan = await SaaSPlan.findById(planId);
    if (!plan || plan.status !== "active") {
      throw new Error("Selected plan is not available");
    }
    if (plan.monthlyPrice !== 0 || plan.annualPrice !== 0) {
      throw new Error("Paid plans require a verified checkout payment");
    }

    const validation = await this.validatePlanDowngrade(organizationId, planId);
    if (!validation.canDowngrade) {
      throw new PlanDowngradeViolationError(validation);
    }

    const existing = await this.getOrInitializeSubscription(organizationId);

    const now = new Date();
    const periodEnd = addBillingPeriod(now, billingCycle);

    const subscription = await withTransaction(async (session) => {
      const target = await Subscription.findById(existing._id).session(session);
      if (!target) throw new Error("Subscription not found");
      if (target.pendingCheckout?.paymentId) {
        throw new Error("A checkout is already in progress. Complete that payment before changing plans.");
      }
      target.planId = plan._id;
      target.status = "active";
      target.entitlementSource = "free";
      target.cancelledAt = null;
      target.billingCycle = billingCycle;
      target.currentPeriodStart = now;
      target.currentPeriodEnd = periodEnd;
      target.lastBillingChangeAt = now;
      await target.save({ session });
      await Organization.findByIdAndUpdate(organizationId, {
        plan: plan.slug,
        maxClinics: plan.limits?.maxClinics ?? 1,
        maxDoctors: plan.limits?.maxDoctors ?? 2,
        maxStaff: plan.limits?.maxStaff ?? 5,
      }, session ? { session } : {});
      return target;
    });

    await eventBus.publishDurable({
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
  async createCheckoutOrder(organizationId: string, planId: string, billingCycle: "monthly" | "annual", checkoutIntentId?: string): Promise<{
    orderId: string; amount: number; currency: string; keyId: string; planName: string; planSlug: string;
    billingCycle: "monthly" | "annual"; paymentId: string; alreadyCompleted?: boolean; reused?: boolean;
  }> {
    if (billingCycle !== "monthly" && billingCycle !== "annual") throw new Error("Invalid billing cycle");
    if (checkoutIntentId && !/^[a-zA-Z0-9-]{16,80}$/.test(checkoutIntentId)) throw new Error("Invalid checkout intent ID");
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
    const intentKey = checkoutIntentId ? `${organizationId}:${checkoutIntentId}` : null;
    if (intentKey) {
      const previous = await SubscriptionPayment.findOne({ organizationId, idempotencyKey: intentKey });
      if (previous) {
        if (previous.planId.toString() !== planId || previous.billingCycle !== billingCycle) {
          throw new Error("Checkout intent belongs to another plan or billing cycle");
        }
        if (previous.status === "captured") return {
          alreadyCompleted: true, orderId: previous.razorpayOrderId, amount: previous.amount,
          currency: previous.currency, keyId: "", planName: plan.name, planSlug: plan.slug,
          billingCycle, paymentId: previous._id.toString(),
        };
        if (previous.status === "abandoned" || previous.status === "captured_review" || previous.status === "refunded") {
          throw new Error("Checkout intent is already closed");
        }
        if (previous.status === "created" || previous.status === "failed") {
          const reconciled = await this.reconcileCheckout(organizationId, previous.razorpayOrderId);
          if (reconciled.success) return {
            alreadyCompleted: true, orderId: previous.razorpayOrderId, amount: previous.amount,
            currency: previous.currency, keyId: "", planName: plan.name, planSlug: plan.slug,
            billingCycle, paymentId: previous._id.toString(),
          };
          const publicParams = await razorpayService.getPublicParams();
          if (!publicParams.keyId) throw new Error("Razorpay checkout key is unavailable");
          return { orderId: previous.razorpayOrderId, amount: previous.amount, currency: previous.currency,
            keyId: publicParams.keyId, planName: plan.name, planSlug: plan.slug, billingCycle,
            paymentId: previous._id.toString(), reused: true };
        }
      }
    }
    if (plan.currency !== "INR") throw new Error("Online checkout currently supports INR plans only");
    const basePrice = billingCycle === "annual" ? plan.annualPrice : plan.monthlyPrice;
    const basePricePaise = Math.round(basePrice * 100);
    if (basePrice === 0) throw new Error("This plan has no payable checkout amount; use the free plan switch instead");
    if (!Number.isFinite(basePrice) || basePrice < 0 || !Number.isSafeInteger(basePricePaise) ||
      Math.abs(basePrice * 100 - basePricePaise) > 0.000001) {
      throw new Error("Plan price must be a positive INR amount with at most two decimal places");
    }
    const taxRate = 0.18; // GST 18%
    const taxAmount = Math.round(basePricePaise * taxRate / 100); // existing whole-rupee GST rule
    const totalPaise = basePricePaise + taxAmount * 100;
    if (!Number.isSafeInteger(totalPaise)) throw new Error("Invalid checkout amount");
    const totalAmount = totalPaise / 100;

    // One organization can have one payable order at a time. The subscription
    // document is the atomic reservation, so concurrent HTTP requests cannot
    // create two Razorpay orders for the same intended purchase.
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await Subscription.findById(subscription._id);
      const pendingId = current?.pendingCheckout?.paymentId;
      if (pendingId) {
        const pending = await SubscriptionPayment.findById(pendingId);
        if (pending?.status === "created" || pending?.status === "failed") {
          if (pending.planId.toString() !== planId || pending.billingCycle !== billingCycle) {
            throw new Error("Another checkout is in progress. Complete it before selecting a different plan.");
          }
          const reconciled = await this.reconcileCheckout(organizationId, pending.razorpayOrderId);
          if (reconciled.success) return {
            alreadyCompleted: true, orderId: pending.razorpayOrderId, amount: pending.amount,
            currency: pending.currency, keyId: "", planName: plan.name, planSlug: plan.slug,
            billingCycle, paymentId: pending._id.toString(),
          };
          const publicParams = await razorpayService.getPublicParams();
          if (!publicParams.keyId) throw new Error("Razorpay checkout key is unavailable");
          return { orderId: pending.razorpayOrderId, amount: pending.amount, currency: pending.currency,
            keyId: publicParams.keyId, planName: plan.name, planSlug: plan.slug,
            billingCycle, paymentId: pending._id.toString(), reused: true };
        }
        if (!pending && current?.pendingCheckout?.claimedAt && Date.now() - current.pendingCheckout.claimedAt.getTime() < 120_000) {
          throw new Error("Checkout is being prepared. Please retry shortly.");
        }
        await Subscription.updateOne({ _id: subscription._id, "pendingCheckout.paymentId": pendingId }, { $unset: { pendingCheckout: "" } });
        continue;
      }
      break;
    }

    const paymentId = new mongoose.Types.ObjectId();
    const claim = await Subscription.findOneAndUpdate(
      { _id: subscription._id, $or: [
        { "pendingCheckout.paymentId": { $exists: false } },
        { "pendingCheckout.paymentId": null },
      ] },
      { $set: { pendingCheckout: { paymentId, claimedAt: new Date() } } },
      { returnDocument: "after" },
    );
    if (!claim) throw new Error("Checkout is already in progress. Please retry shortly.");

    const receipt = `rcpt_${paymentId.toString()}`;
    let providerOrderCreated = false;
    try {
      const order = await razorpayService.createOrder({
        amount: totalAmount,
        currency: "INR",
        receipt,
        notes: { organizationId, planId, planSlug: plan.slug, billingCycle },
      });
      providerOrderCreated = true;
      if (!order.id || order.amount !== totalPaise || order.currency !== "INR" ||
        order.receipt !== receipt || order.status !== "created") {
        throw new Error("Razorpay Order does not match the server checkout quote");
      }

      const payment = await SubscriptionPayment.create({
        _id: paymentId,
        organizationId,
        subscriptionId: subscription._id,
        planId: plan._id,
        razorpayOrderId: order.id,
        amount: totalAmount,
        subtotal: basePricePaise / 100,
        taxAmount,
        currency: "INR",
        status: "created",
        billingCycle,
        idempotencyKey: intentKey,
      });

      const publicParams = await razorpayService.getPublicParams();
      if (!publicParams.keyId) throw new Error("Razorpay checkout key is unavailable");

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
    } catch (error) {
      // An uncertain or successful provider response must not create a second order.
      if (!providerOrderCreated && !(error instanceof Error && error.name === "AmbiguousOutcomeError")) {
        await Subscription.updateOne({ _id: subscription._id, "pendingCheckout.paymentId": paymentId },
          { $unset: { pendingCheckout: "" } });
      }
      throw error;
    }
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
    if (!payment) throw new Error("Payment record not found");

    const isValid = await razorpayService.verifyPaymentSignature(
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature
    );

    if (!isValid) {
      throw new Error("Payment verification failed: Invalid signature");
    }

    const captured = await razorpayService.isPaymentCaptured(razorpayPaymentId, razorpayOrderId, payment.amount);
    if (!captured) return { success: false, pending: true, message: "Payment is awaiting capture" };

    return this.activateCapturedPayment(payment, razorpayPaymentId, razorpaySignature);
  }

  async reconcileCheckout(organizationId: string, razorpayOrderId?: string) {
    const subscription = razorpayOrderId ? null : await Subscription.findOne({ organizationId });
    const payment = razorpayOrderId
      ? await SubscriptionPayment.findOne({ organizationId, razorpayOrderId })
      : subscription?.pendingCheckout?.paymentId
        ? await SubscriptionPayment.findOne({ _id: subscription.pendingCheckout.paymentId, organizationId })
        : await SubscriptionPayment.findOne({ organizationId, status: { $in: ["created", "failed"] } }).sort({ createdAt: -1 });
    if (!payment) return { status: "none", success: false };
    if (payment.status === "captured") return { status: "captured", success: true, orderId: payment.razorpayOrderId };
    if (payment.status === "captured_review") return { status: "captured_review", success: false, requiresReview: true, orderId: payment.razorpayOrderId };
    if (payment.status !== "created" && payment.status !== "failed" && payment.status !== "abandoned") {
      return { status: payment.status, success: false, orderId: payment.razorpayOrderId };
    }
    const capturedId = await razorpayService.fetchCapturedPaymentForOrder(payment.razorpayOrderId, payment.amount);
    await SubscriptionPayment.updateOne({ _id: payment._id }, {
      $set: { lastReconciledAt: new Date() },
      $unset: { reconcileAfter: "", reconciliationIssue: "" },
    });
    if (capturedId) {
      const activated = await this.activateCapturedPayment(payment, capturedId);
      return { status: activated.success ? "captured" : "captured_review", success: activated.success,
        requiresReview: !activated.success, orderId: payment.razorpayOrderId };
    }
    return { status: payment.status === "failed" ? "created" : payment.status, success: false, orderId: payment.razorpayOrderId,
      amount: payment.amount, currency: payment.currency, planId: payment.planId.toString(),
      billingCycle: payment.billingCycle, failureReason: payment.failureReason || null };
  }

  async abandonCheckout(organizationId: string, razorpayOrderId: string) {
    const payment = await SubscriptionPayment.findOne({ organizationId, razorpayOrderId });
    if (!payment) throw new Error("Checkout order not found");
    const current = await this.reconcileCheckout(organizationId, razorpayOrderId);
    if (current.success || current.status === "captured_review") return current;
    if (payment.status !== "created" && payment.status !== "failed") return current;
    await withTransaction(async (session) => {
      const latest = await SubscriptionPayment.findById(payment._id).session(session);
      if (!latest || (latest.status !== "created" && latest.status !== "failed")) return;
      latest.status = "abandoned";
      await latest.save({ session });
      await Subscription.updateOne({ _id: payment.subscriptionId, "pendingCheckout.paymentId": payment._id },
        { $unset: { pendingCheckout: "" } }, session ? { session } : {});
    });
    return { status: "abandoned", success: false, orderId: razorpayOrderId };
  }

  private async activateCapturedPayment(payment: any, razorpayPaymentId: string, razorpaySignature?: string) {
    const organizationId = payment.organizationId.toString();
    const activation = await withTransaction(async (session) => {
      const currentPayment = await SubscriptionPayment.findById(payment._id).session(session);
      if (!currentPayment) throw new Error("Payment record not found");
      if (currentPayment.status === "captured") {
        if (currentPayment.razorpayPaymentId !== razorpayPaymentId) throw new Error("Captured Order has a different payment ID");
        const [sub, existingInvoice] = await Promise.all([
          Subscription.findById(currentPayment.subscriptionId).populate("planId").session(session),
          SaaSInvoice.findOne({ paymentId: currentPayment._id }).session(session),
        ]);
        if (!sub || !existingInvoice) throw new Error("Captured payment needs subscription reconciliation");
        return { alreadyActivated: true, subscription: sub, invoice: existingInvoice, org: null, plan: null };
      }
      if (currentPayment.status === "captured_review") {
        if (currentPayment.razorpayPaymentId !== razorpayPaymentId) throw new Error("Order has a different captured payment ID");
        const invoice = await SaaSInvoice.findOne({ paymentId: currentPayment._id }).session(session);
        if (!invoice) throw new Error("Captured payment needs invoice reconciliation");
        return { alreadyActivated: true, requiresReview: true, subscription: null, invoice, org: null, plan: null };
      }
      if (currentPayment.status === "refunded") throw new Error("Refunded payment cannot activate a subscription");
      if (currentPayment.razorpayPaymentId && currentPayment.razorpayPaymentId !== razorpayPaymentId) {
        throw new Error("Payment ID does not match this order");
      }
      const plan = await SaaSPlan.findById(currentPayment.planId).session(session);
      const subscription = await Subscription.findById(currentPayment.subscriptionId).session(session);
      const org = await Organization.findById(organizationId).session(session);
      if (!plan || !subscription || !org) throw new Error("Payment plan, subscription or organization not found");

      const now = new Date();
      const requiresReview = Boolean(subscription.lastBillingChangeAt &&
        subscription.lastBillingChangeAt.getTime() > currentPayment.createdAt.getTime());
      const continuingSamePlan = subscription.status === "active" &&
        subscription.planId.toString() === plan._id.toString() && subscription.currentPeriodEnd > now;
      const periodStart = continuingSamePlan ? subscription.currentPeriodEnd : now;
      const periodEnd = addBillingPeriod(periodStart, currentPayment.billingCycle);

      if (!requiresReview) {
        subscription.planId = plan._id;
        subscription.status = "active";
        subscription.entitlementSource = "paid";
        subscription.cancelledAt = null;
        subscription.billingCycle = currentPayment.billingCycle;
        subscription.currentPeriodStart = periodStart;
        subscription.currentPeriodEnd = periodEnd;
        subscription.lastBillingChangeAt = now;
        await subscription.save({ session });
        await Organization.findByIdAndUpdate(organizationId, {
          plan: plan.slug,
          maxClinics: plan.limits?.maxClinics ?? 1,
          maxDoctors: plan.limits?.maxDoctors ?? 2,
          maxStaff: plan.limits?.maxStaff ?? 5,
        }, session ? { session } : {});
      }

      const { getNextAtomicSequence } = await import("../../models/Counter.ts");
      const currentYear = now.getFullYear();
      const seq = await getNextAtomicSequence(`saas_invoice_${currentYear}`);
      const invoiceNumber = `SAAS-${currentYear}-${seq.toString().padStart(6, "0")}`;
      const subtotal = currentPayment.subtotal ?? Math.round(currentPayment.amount / 1.18);
      const invoice = await createWithSession(SaaSInvoice, {
        invoiceNumber, organizationId, subscriptionId: subscription._id, paymentId: currentPayment._id,
        planName: plan.name, billingCycle: currentPayment.billingCycle,
        subtotal, taxAmount: currentPayment.taxAmount ?? currentPayment.amount - subtotal, totalAmount: currentPayment.amount,
        currency: "INR", status: "paid",
        billingDetails: {
          orgName: org.name, gstin: org.billingDetails?.gstin ?? org.taxId ?? null,
          address: org.billingDetails?.address ?? org.address ?? null,
          city: org.city || null, email: org.billingDetails?.email ?? org.email ?? null,
        },
        paidAt: now,
      }, session) as any;
      currentPayment.razorpayPaymentId = razorpayPaymentId;
      if (razorpaySignature) currentPayment.razorpaySignature = razorpaySignature;
      currentPayment.status = requiresReview ? "captured_review" : "captured";
      currentPayment.paidAt = now;
      await currentPayment.save({ session });
      await Subscription.updateOne({ _id: subscription._id, "pendingCheckout.paymentId": currentPayment._id },
        { $unset: { pendingCheckout: "" } }, session ? { session } : {});
      return { alreadyActivated: false, requiresReview, subscription, invoice, org, plan };
    });
    if (activation.alreadyActivated) return {
      success: !activation.requiresReview, requiresReview: activation.requiresReview,
      subscription: activation.subscription, invoice: activation.invoice,
      message: activation.requiresReview ? "Captured payment requires plan review" : "Subscription already activated",
    };
    if (!activation.plan || !activation.org) throw new Error("Subscription activation could not be completed");
    const { invoice, org, plan } = activation;
    const invoiceNumber = invoice.invoiceNumber;

    if (activation.requiresReview) {
      logger.warn("billing.payment.captured_review", { tenantId: organizationId }, {
        paymentId: payment._id.toString(), providerPaymentId: razorpayPaymentId,
        orderId: payment.razorpayOrderId,
      });
      await eventBus.publishDurable({ eventType: EVENT_TYPES.SYSTEM_ALERT, category: "billing",
        organizationId, title: "Captured payment needs review",
        message: `Payment ${razorpayPaymentId} was captured after a later plan change. Invoice #${invoiceNumber} is recorded.`,
        severity: "warning", actionUrl: "/dashboard/settings/billing" });
      return { success: false, requiresReview: true, subscription: activation.subscription, invoice,
        message: "Payment captured; plan change requires review" };
    }

    // Dispatch Event & Notifications
    try {
      await eventBus.publishDurable({
        eventType: EVENT_TYPES.BILLING_INVOICE_GENERATED,
        category: "billing",
        organizationId,
        title: "Subscription Activated",
        message: `Your ${plan.name} (${payment.billingCycle}) subscription is now active! Invoice #${invoiceNumber} generated.`,
        severity: "success",
        actionUrl: "/dashboard/settings/billing",
      });
    } catch (eventError) {
      console.error("Failed to publish subscription activation event:", eventError);
    }

    // Send Commercial Invoice Email Notification
    const recipientEmail = org?.email || (invoice.billingDetails as any)?.email;
    if (recipientEmail && !recipientEmail.includes("placeholder.com")) {
      try {
        const emailBodyHtml = `
          <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f8fafc; padding: 30px; color: #1e293b;">
            <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; padding: 30px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
              <div style="text-align: center; border-bottom: 2px solid #0284c7; padding-bottom: 20px; margin-bottom: 20px;">
                <h1 style="color: #0284c7; margin: 0; font-size: 24px;">Ekavyu Healthcare SaaS</h1>
                <p style="color: #64748b; font-size: 13px; margin-top: 4px;">Commercial Subscription Invoice Receipt</p>
              </div>
              
              <p style="font-size: 15px; font-weight: 600;">Dear ${org?.name || "Customer"},</p>
              <p style="font-size: 14px; color: #334155; line-height: 1.6;">
                Thank you for subscribing to Ekavyu. Your payment for the <strong>${plan.name} Plan (${payment.billingCycle})</strong> has been successfully processed.
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
                Ekavyu Healthcare SaaS System • Automated Commercial Billing & Invoicing
              </div>
            </div>
          </div>
        `;

        await enqueueTransactionalEmail({
          to: recipientEmail,
          subject: `[Ekavyu Invoice #${invoiceNumber}] Subscription Payment Confirmed - ${plan.name} Plan`,
          html: emailBodyHtml,
          idempotencyKey: `transactional-email:subscription-invoice:${invoice._id}`,
        });
      } catch (emailErr) {
        console.error("Failed to enqueue subscription invoice email:", emailErr);
      }
    }

    const updatedSub = await Subscription.findById(activation.subscription._id).populate("planId");
    logger.info("billing.subscription.activated", { tenantId: organizationId }, {
      paymentId: payment._id.toString(), providerPaymentId: razorpayPaymentId,
      orderId: payment.razorpayOrderId, subscriptionId: activation.subscription._id.toString(),
    });
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
        if (existingPayment) {
          if (paymentEntity.status !== "captured" || paymentEntity.amount !== Math.round(existingPayment.amount * 100) ||
            paymentEntity.currency !== existingPayment.currency) {
            throw new Error("Captured webhook does not match the stored Order amount or currency");
          }
          if (existingPayment.status === "captured" || existingPayment.status === "captured_review") {
            if (existingPayment.razorpayPaymentId !== paymentId) throw new Error("Order has another captured payment ID");
          } else {
            await this.activateCapturedPayment(existingPayment, paymentId);
          }
        }
      }
    } else if (event === "payment.failed") {
      const paymentEntity = payload.payment?.entity;
      if (paymentEntity && paymentEntity.order_id) {
        const payment = await SubscriptionPayment.findOne({ razorpayOrderId: paymentEntity.order_id });
        if (payment && payment.status === "created") {
          // Razorpay can retry a failed payment against the same Order.
          payment.failedPaymentId = paymentEntity.id || null;
          payment.failureReason = paymentEntity.error_description || "Payment failed at gateway";
          await payment.save();
          logger.info("billing.payment.attempt_failed", { tenantId: payment.organizationId.toString() }, {
            paymentId: payment._id.toString(), orderId: payment.razorpayOrderId,
            providerPaymentId: paymentEntity.id || null,
          });
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
    await eventBus.publishDurable({
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
        await enqueueTransactionalEmail({
          to: org.email,
          subject: `[Ekavyu] Subscription Cancellation Confirmed - ${org.name}`,
          html: `<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">
            <h2>Subscription Cancellation Confirmed</h2>
            <p>Dear ${org.name},</p>
            <p>Your subscription auto-renewal for Ekavyu SaaS has been cancelled as requested.</p>
            <p>Your organization's current plan features and resource limits will remain active until the end of your current billing period.</p>
            <p>Best regards,<br/>Ekavyu Billing Team</p>
          </div>`,
          idempotencyKey: `transactional-email:subscription-cancelled:${sub._id}:${sub.cancelledAt!.getTime()}`,
        });
      } catch (emailErr) {
        console.error("Failed to enqueue cancellation email:", emailErr);
      }
    }

    return sub;
  }
}

export const subscriptionService = new SubscriptionService();
