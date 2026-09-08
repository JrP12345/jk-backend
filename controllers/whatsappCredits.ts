import type { FastifyRequest, FastifyReply } from "fastify";
import { Organization } from "../models/Organization.ts";
import { SaaSInvoice } from "../models/SaaSInvoice.ts";
import { AuditLog } from "../models/AuditLog.ts";

export const WHATSAPP_CREDIT_PACKS = {
  bronze: {
    id: "bronze",
    name: "Bronze Credit Pack",
    credits: 1000,
    price: 200,
    currency: "INR",
    description: "1,000 WhatsApp Notification Credits (~400 appointments)",
  },
  silver: {
    id: "silver",
    name: "Silver Credit Pack",
    credits: 3000,
    price: 550,
    currency: "INR",
    popular: true,
    description: "3,000 WhatsApp Notification Credits (~1,200 appointments)",
  },
  gold: {
    id: "gold",
    name: "Gold Credit Pack",
    credits: 10000,
    price: 1700,
    currency: "INR",
    description: "10,000 WhatsApp Notification Credits (~4,000 appointments)",
  },
} as const;

/**
 * GET /api/organization/whatsapp
 * Returns WhatsApp configuration, usage metrics, low-balance warning, and pack rates.
 */
export async function getOrganizationWhatsAppConfig(req: FastifyRequest, reply: FastifyReply) {
  const user = (req as any).user;
  const queryOrgId = (req.query as any)?.organizationId;
  const orgId = queryOrgId || req.headers["x-organization-id"] || user?.organization_id || user?.organizationId;

  if (!orgId) {
    return reply.code(400).send({ success: false, message: "Organization context required" });
  }

  const org = await Organization.findById(orgId);
  if (!org) {
    return reply.code(404).send({ success: false, message: "Organization not found" });
  }

  // Monthly Quota Reset Check
  const now = new Date();
  const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const config = org.whatsappConfig || ({} as any);

  if (config.quotaResetMonth !== currentMonthStr) {
    const monthlyQuota = config.monthlyQuota || 500;
    // Add monthly quota refresh and update reset month
    await Organization.updateOne(
      { _id: org._id },
      {
        $set: {
          "whatsappConfig.creditsUsedThisMonth": 0,
          "whatsappConfig.quotaResetMonth": currentMonthStr,
        },
        $inc: {
          "whatsappConfig.creditsBalance": monthlyQuota,
        },
      }
    );
    config.creditsUsedThisMonth = 0;
    config.creditsBalance = (config.creditsBalance || 0) + monthlyQuota;
    config.quotaResetMonth = currentMonthStr;
  }

  const creditsBalance = config.creditsBalance ?? 500;
  const lowThreshold = config.lowBalanceThreshold ?? 50;
  const isLowBalance = creditsBalance <= lowThreshold;

  return reply.code(200).send({
    success: true,
    data: {
      mode: config.mode || "shared",
      monthlyQuota: config.monthlyQuota || 500,
      creditsBalance,
      creditsUsedThisMonth: config.creditsUsedThisMonth || 0,
      prepaidCredits: config.prepaidCredits || 0,
      lowBalanceThreshold: lowThreshold,
      isLowBalance,
      autoRechargeEnabled: config.autoRechargeEnabled || false,
      autoRechargePack: config.autoRechargePack || "bronze",
      hasDedicatedCredentials: !!(config.wabaId && config.phoneNumberId),
      wabaId: config.wabaId || null,
      phoneNumberId: config.phoneNumberId || null,
      notifications: config.notifications || {
        sendBookingConfirmation: true,
        sendConsultationComplete: true,
        sendAppointmentCancellation: true,
        sendTurnApproaching: false,
        sendQueueDelayAlert: true,
        sendDisruptionAlert: true,
      },
      availablePacks: Object.values(WHATSAPP_CREDIT_PACKS),
    },
  });
}

/**
 * PATCH /api/organization/whatsapp
 * Updates WhatsApp gateway mode, notification preferences, and thresholds.
 */
export async function updateOrganizationWhatsAppConfig(req: FastifyRequest, reply: FastifyReply) {
  const user = (req as any).user;
  const body = req.body as any;
  const queryOrgId = (req.query as any)?.organizationId;
  const orgId = body?.organizationId || queryOrgId || req.headers["x-organization-id"] || user?.organization_id || user?.organizationId;

  if (!orgId) {
    return reply.code(400).send({ success: false, message: "Organization context required" });
  }

  const updateFields: Record<string, any> = {};

  if (body.mode && ["disabled", "shared", "dedicated"].includes(body.mode)) {
    updateFields["whatsappConfig.mode"] = body.mode;
  }
  if (typeof body.lowBalanceThreshold === "number") {
    updateFields["whatsappConfig.lowBalanceThreshold"] = Math.max(10, body.lowBalanceThreshold);
  }
  if (typeof body.autoRechargeEnabled === "boolean") {
    updateFields["whatsappConfig.autoRechargeEnabled"] = body.autoRechargeEnabled;
  }
  if (body.autoRechargePack && ["bronze", "silver", "gold"].includes(body.autoRechargePack)) {
    updateFields["whatsappConfig.autoRechargePack"] = body.autoRechargePack;
  }

  // Dedicated enterprise WABA credentials
  if (body.wabaId !== undefined) updateFields["whatsappConfig.wabaId"] = body.wabaId;
  if (body.phoneNumberId !== undefined) updateFields["whatsappConfig.phoneNumberId"] = body.phoneNumberId;
  if (body.accessToken) updateFields["whatsappConfig.accessToken"] = body.accessToken;

  // Granular notification toggles
  if (body.notifications) {
    if (typeof body.notifications.sendBookingConfirmation === "boolean") {
      updateFields["whatsappConfig.notifications.sendBookingConfirmation"] = body.notifications.sendBookingConfirmation;
    }
    if (typeof body.notifications.sendConsultationComplete === "boolean") {
      updateFields["whatsappConfig.notifications.sendConsultationComplete"] = body.notifications.sendConsultationComplete;
    }
    if (typeof body.notifications.sendAppointmentCancellation === "boolean") {
      updateFields["whatsappConfig.notifications.sendAppointmentCancellation"] = body.notifications.sendAppointmentCancellation;
    }
    if (typeof body.notifications.sendTurnApproaching === "boolean") {
      updateFields["whatsappConfig.notifications.sendTurnApproaching"] = body.notifications.sendTurnApproaching;
    }
    if (typeof body.notifications.sendQueueDelayAlert === "boolean") {
      updateFields["whatsappConfig.notifications.sendQueueDelayAlert"] = body.notifications.sendQueueDelayAlert;
    }
    if (typeof body.notifications.sendDisruptionAlert === "boolean") {
      updateFields["whatsappConfig.notifications.sendDisruptionAlert"] = body.notifications.sendDisruptionAlert;
    }
  }

  const updatedOrg = await Organization.findByIdAndUpdate(
    orgId,
    { $set: updateFields },
    { new: true }
  );

  return reply.code(200).send({
    success: true,
    message: "WhatsApp configuration saved successfully",
    data: {
      mode: updatedOrg?.whatsappConfig?.mode,
      notifications: updatedOrg?.whatsappConfig?.notifications,
      lowBalanceThreshold: updatedOrg?.whatsappConfig?.lowBalanceThreshold,
      autoRechargeEnabled: updatedOrg?.whatsappConfig?.autoRechargeEnabled,
    },
  });
}

/**
 * POST /api/organization/whatsapp/top-up
 * Purchases prepaid WhatsApp credit packs using existing billing rails.
 */
export async function purchaseWhatsAppCredits(req: FastifyRequest, reply: FastifyReply) {
  const user = (req as any).user;
  const body = req.body as any;
  const queryOrgId = (req.query as any)?.organizationId;
  const orgId = body?.organizationId || queryOrgId || req.headers["x-organization-id"] || user?.organization_id || user?.organizationId;

  if (!orgId) {
    return reply.code(400).send({ success: false, message: "Organization context required" });
  }

  const packId = body.pack as keyof typeof WHATSAPP_CREDIT_PACKS;
  const pack = WHATSAPP_CREDIT_PACKS[packId];

  if (!pack) {
    return reply.code(400).send({
      success: false,
      message: "Invalid pack selection. Choose bronze, silver, or gold.",
    });
  }

  const org = await Organization.findById(orgId);
  if (!org) {
    return reply.code(404).send({ success: false, message: "Organization not found" });
  }

  // Generate SaaS Invoice for the transaction
  const invoiceNumber = `INV-WA-${Date.now().toString().slice(-6)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  const invoice = await SaaSInvoice.create({
    invoiceNumber,
    organizationId: org._id,
    subscriptionId: org._id, // Tied to organization commercial record
    planName: `WhatsApp Top-Up: ${pack.name} (${pack.credits.toLocaleString()} Credits)`,
    billingCycle: "monthly",
    subtotal: pack.price,
    taxAmount: 0,
    totalAmount: pack.price,
    currency: pack.currency,
    status: "paid",
    billingDetails: {
      orgName: org.name,
      gstin: org.taxId || null,
      address: org.address || null,
      city: org.city || null,
      email: org.email || user.email || null,
    },
    paidAt: new Date(),
  });

  // Atomically top up credits
  const updatedOrg = await Organization.findByIdAndUpdate(
    org._id,
    {
      $inc: {
        "whatsappConfig.creditsBalance": pack.credits,
        "whatsappConfig.prepaidCredits": pack.credits,
      },
    },
    { new: true }
  );

  // Record Audit Trail
  await AuditLog.create({
    userId: user._id || user.id,
    organizationId: org._id,
    action: "ORGANIZATION_WHATSAPP_TOPUP",
    targetModel: "Organization",
    targetId: org._id,
    category: "BILLING",
    details: {
      pack: pack.id,
      creditsAdded: pack.credits,
      price: pack.price,
      newBalance: updatedOrg?.whatsappConfig?.creditsBalance,
      invoiceNumber,
    },
  }).catch(() => {});

  return reply.code(201).send({
    success: true,
    message: `Successfully credited ${pack.credits.toLocaleString()} WhatsApp credits!`,
    data: {
      creditsAdded: pack.credits,
      newCreditsBalance: updatedOrg?.whatsappConfig?.creditsBalance,
      invoiceNumber: invoice.invoiceNumber,
      invoiceId: invoice._id.toString(),
    },
  });
}
