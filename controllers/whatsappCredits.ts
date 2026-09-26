import type { FastifyRequest, FastifyReply } from "fastify";
import { Organization } from "../models/Organization.ts";
import { SaaSInvoice } from "../models/SaaSInvoice.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { resolveAuthorizedOrganizationScope, isRootRequest } from "../utilities/tenant.ts";
import crypto from "node:crypto";
import { encrypt } from "../utilities/encryption.ts";
import { getPlatformAccount, publicAccount, resolveWhatsAppAccount, secretProjection } from "../services/WhatsAppAccountService.ts";

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
    price: 1500,
    currency: "INR",
    description: "10,000 WhatsApp Notification Credits (~4,000 appointments)",
  },
} as const;

export async function resolveOrganizationIdOrReply(req: FastifyRequest, reply: FastifyReply): Promise<string | undefined> {
  const scope = resolveAuthorizedOrganizationScope(req);
  if (!scope.allowed) {
    reply.code(scope.statusCode).send({ success: false, message: scope.message });
    return undefined;
  }
  let orgId = scope.organizationId;
  if (!orgId && isRootRequest(req)) {
    const defaultOrg = await Organization.findOne({ isActive: { $ne: false } }).sort({ createdAt: 1 });
    if (defaultOrg) orgId = defaultOrg._id.toString();
  }
  if (!orgId) {
    reply.code(400).send({ success: false, message: "Organization context required" });
    return undefined;
  }
  return orgId;
}

/**
 * GET /api/organization/whatsapp
 * Returns WhatsApp configuration, usage metrics, low-balance warning, and pack rates.
 */
export async function getOrganizationWhatsAppConfig(req: FastifyRequest, reply: FastifyReply) {
  const orgId = await resolveOrganizationIdOrReply(req, reply);
  if (!orgId) return;

  const org = await Organization.findById(orgId).select(secretProjection);
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
      { _id: org._id, "whatsappConfig.quotaResetMonth": { $ne: currentMonthStr } },
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
      connection: publicAccount(config.mode === "dedicated" ? await resolveWhatsAppAccount(orgId) : await getPlatformAccount()),
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
  const body = req.body as any;
  const orgId = await resolveOrganizationIdOrReply(req, reply);
  if (!orgId) return;

  const updateFields: Record<string, any> = {};
  const current = await Organization.findById(orgId).select(secretProjection);
  if (!current) return reply.code(404).send({ success: false, message: "Organization not found" });
  if (body.wabaId) {
    const platform = await getPlatformAccount();
    const clash = await Organization.exists({ _id: { $ne: orgId }, "whatsappConfig.wabaId": body.wabaId.trim() });
    if (clash || platform.wabaId === body.wabaId.trim()) return reply.code(409).send({ success: false, message: "This WABA is already assigned to another sender" });
  }

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
  if (body.wabaId?.trim()) updateFields["whatsappConfig.wabaId"] = body.wabaId.trim();
  if (body.phoneNumberId?.trim()) updateFields["whatsappConfig.phoneNumberId"] = body.phoneNumberId.trim();
  if (body.accessToken?.trim()) updateFields["whatsappConfig.accessToken"] = encrypt(body.accessToken.replace(/\s/g, ""));
  if (body.appSecret?.trim()) updateFields["whatsappConfig.appSecret"] = encrypt(body.appSecret.trim());
  if (body.accessToken?.trim() || body.appSecret?.trim() || (body.wabaId && body.wabaId !== current.whatsappConfig?.wabaId) || (body.phoneNumberId && body.phoneNumberId !== current.whatsappConfig?.phoneNumberId)) {
    updateFields["whatsappConfig.connectionStatus"] = "pending";
    updateFields["whatsappConfig.lastError"] = "";
    updateFields["whatsappConfig.verifiedAt"] = null;
  }
  if (!current.whatsappConfig?.verifyToken) updateFields["whatsappConfig.verifyToken"] = encrypt(`ananta_${crypto.randomBytes(24).toString("base64url")}`);

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
  await AuditLog.create({ userId: (req as any).user?.id, organizationId: orgId, action: "WHATSAPP_SETTINGS_UPDATE", targetId: orgId, targetModel: "Organization", details: { mode: updatedOrg?.whatsappConfig?.mode, credentialsChanged: !!(body.accessToken || body.appSecret) } });

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
  const orgId = await resolveOrganizationIdOrReply(req, reply);
  if (!orgId) return;

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
