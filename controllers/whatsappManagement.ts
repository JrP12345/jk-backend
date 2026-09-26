import crypto from "node:crypto";
import mongoose from "mongoose";
import type { FastifyRequest, FastifyReply } from "fastify";
import { WhatsAppAccount } from "../models/WhatsAppAccount.ts";
import { WhatsAppTemplate } from "../models/WhatsAppTemplate.ts";
import { WhatsAppWebhookInbox } from "../models/WhatsAppWebhookInbox.ts";
import { Organization } from "../models/Organization.ts";
import { NotificationLog } from "../models/NotificationLog.ts";
import { OutboundMessage } from "../models/OutboundMessage.ts";
import { encrypt } from "../utilities/encryption.ts";
import { isRootRequest } from "../utilities/tenant.ts";
import { getPlatformAccount, publicAccount, resolveWhatsAppAccount } from "../services/WhatsAppAccountService.ts";
import { whatsAppCloudApiService } from "../services/WhatsAppCloudApiService.ts";
import { resolveOrganizationIdOrReply } from "./whatsappCredits.ts";
import { buildMetaTemplateParams, type SupportedTemplateId } from "../services/SmsWhatsAppService.ts";
import { AuditLog } from "../models/AuditLog.ts";

async function accountForRequest(req: FastifyRequest, reply: FastifyReply) {
  if (req.url.startsWith("/api/admin/whatsapp")) return { ...await getPlatformAccount(), scope: "platform" };
  const orgId = await resolveOrganizationIdOrReply(req, reply);
  if (!orgId) return null;
  return resolveWhatsAppAccount(orgId);
}

export async function getPlatformWhatsAppConfig(_req: FastifyRequest, reply: FastifyReply) {
  return reply.send({ success: true, data: publicAccount(await getPlatformAccount()) });
}
export async function savePlatformWhatsAppConfig(req: FastifyRequest, reply: FastifyReply) {
  const body = req.body as any;
  if (body.wabaId && await Organization.exists({ "whatsappConfig.wabaId": body.wabaId })) return reply.code(409).send({ success: false, message: "WABA is already assigned to an organization" });
  const current = await getPlatformAccount();
  const fields: any = {};
  for (const key of ["wabaId", "phoneNumberId"]) if (current[key]) fields[key] = current[key];
  for (const key of ["accessToken", "appSecret", "verifyToken"]) if (current[key]) fields[key] = encrypt(current[key]);
  for (const key of ["wabaId", "phoneNumberId"]) if (body[key]?.trim()) fields[key] = body[key].trim();
  for (const key of ["accessToken", "appSecret"]) if (body[key]?.trim()) fields[key] = encrypt(body[key].replace(/\s/g, ""));
  if (typeof body.enabled === "boolean") fields.enabled = body.enabled;
  if (!current.verifyToken) fields.verifyToken = encrypt(`ananta_${crypto.randomBytes(24).toString("base64url")}`);
  if (typeof body.enabled !== "boolean") fields.enabled = current.enabled || false;
  if (body.accessToken?.trim() || body.appSecret?.trim() || (body.wabaId && body.wabaId !== current.wabaId) || (body.phoneNumberId && body.phoneNumberId !== current.phoneNumberId)) {
    fields.connectionStatus = "pending"; fields.verifiedAt = null; fields.lastError = "";
  }
  await WhatsAppAccount.findOneAndUpdate({ key: "platform" }, { $set: fields }, { upsert: true });
  await AuditLog.create({ userId: (req as any).user?.id, action: "WHATSAPP_PLATFORM_SETTINGS_UPDATE", targetModel: "WhatsAppAccount", details: { enabled: fields.enabled, credentialsChanged: !!(body.accessToken || body.appSecret), wabaId: fields.wabaId } });
  return reply.send({ success: true, data: publicAccount(await getPlatformAccount()) });
}

async function updateConnection(account: any, fields: any) {
  if (account.scope === "platform") await WhatsAppAccount.findOneAndUpdate({ key: "platform" }, { $set: fields, $setOnInsert: {
    enabled: account.enabled, wabaId: account.wabaId, phoneNumberId: account.phoneNumberId,
    accessToken: encrypt(account.accessToken), appSecret: encrypt(account.appSecret), verifyToken: encrypt(account.verifyToken),
  } }, { upsert: true });
  else await Organization.updateOne({ _id: account.scope }, { $set: Object.fromEntries(Object.entries(fields).map(([key, value]) => [`whatsappConfig.${key}`, value])) });
}
export async function testWhatsAppConnection(req: FastifyRequest, reply: FastifyReply) {
  const account = await accountForRequest(req, reply);
  if (!account) return;
  if (account.scope === "platform" && !isRootRequest(req)) return reply.code(403).send({ success: false, message: "Only root can test or configure the shared gateway" });
  if (!account.wabaId || !account.phoneNumberId || !account.accessToken || !account.appSecret) return reply.code(400).send({ success: false, message: "WABA ID, phone ID, access token and app secret are required" });
  try {
    let after = "";
    let matched: any;
    for (let page = 0; page < 100; page++) {
      const result = await whatsAppCloudApiService.request(`${account.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating&limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`, account);
      matched = result.data?.find((row: any) => row.id === account.phoneNumberId);
      if (matched || !result.paging?.next || !result.paging?.cursors?.after) break;
      after = result.paging.cursors.after;
    }
    if (!matched) throw new Error("PHONE_NUMBER_DOES_NOT_BELONG_TO_WABA");
    await updateConnection(account, { connectionStatus: "connected", verifiedAt: new Date(), lastError: "", phoneDisplay: matched.display_phone_number });
    return reply.send({ success: true, message: "Connection verified. Sync templates before enabling notifications." });
  } catch (error: any) {
    await updateConnection(account, { connectionStatus: "error", lastError: error.message });
    return reply.code(400).send({ success: false, message: error.message });
  }
}

export async function syncWhatsAppTemplates(req: FastifyRequest, reply: FastifyReply) {
  const account = await accountForRequest(req, reply);
  if (!account) return;
  if (account.scope === "platform" && !isRootRequest(req)) return reply.code(403).send({ success: false, message: "Only root can sync shared gateway templates" });
  if (!account.wabaId || !account.accessToken) return reply.code(400).send({ success: false, message: "Save credentials first" });
  try {
    const startedAt = new Date();
    let after = "";
    let count = 0;
    const ids: string[] = [];
    for (let page = 0; page < 100; page++) {
      const result = await whatsAppCloudApiService.request(`${account.wabaId}/message_templates?fields=id,name,language,status,category,components&limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`, account);
      for (const row of result.data || []) {
        ids.push(row.id);
        await WhatsAppTemplate.updateOne({ scope: account.scope, name: row.name, language: row.language }, { $setOnInsert: { metaId: row.id } }, { upsert: true });
        await WhatsAppTemplate.updateOne({ scope: account.scope, name: row.name, language: row.language, $or: [{ lastMetaEventAt: { $lte: startedAt } }, { lastMetaEventAt: { $exists: false } }] },
          { $set: { metaId: row.id, status: row.status, category: row.category, components: row.components, lastMetaEventAt: startedAt } });
        count++;
      }
      if (!result.paging?.next) break;
      if (!result.paging?.cursors?.after || page === 99) throw new Error("TEMPLATE_PAGINATION_INCOMPLETE");
      after = result.paging.cursors.after;
    }
    await WhatsAppTemplate.updateMany({ scope: account.scope, metaId: { $nin: ids }, lastMetaEventAt: { $lte: startedAt } }, { $set: { status: "DELETED" } });
    return reply.send({ success: true, message: `Synced ${count} templates` });
  } catch (error: any) { return reply.code(400).send({ success: false, message: error.message }); }
}

export async function getWhatsAppHealth(req: FastifyRequest, reply: FastifyReply) {
  const account = await accountForRequest(req, reply);
  if (!account) return;
  const templates = await WhatsAppTemplate.find({ scope: account.scope }).select("name language status category").sort({ name: 1 }).lean();
  const organizationFilter = req.url.startsWith("/api/admin/") ? {} : { organizationId: account.organizationId };
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const start = new Date(`${date}T00:00:00+05:30`);
  const messages = await NotificationLog.find({ ...organizationFilter, channel: "whatsapp" }).select("createdAt recipientPhone templateId status errorReason").sort({ createdAt: -1 }).limit(50).lean();
  const today = await NotificationLog.aggregate([
    { $match: { ...(!req.url.startsWith("/api/admin/") ? { organizationId: new mongoose.Types.ObjectId(account.organizationId) } : {}), channel: "whatsapp", createdAt: { $gte: start, $lt: new Date(start.getTime() + 86400_000) } } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const pending = await OutboundMessage.countDocuments({ ...(account.organizationId ? { "payload.organizationId": account.organizationId } : {}), kind: { $in: ["whatsapp_document", "whatsapp_freeform", "communication_template"] }, status: { $in: ["pending", "retrying", "processing"] } });
  const lastWebhook = await WhatsAppWebhookInbox.findOne({ status: "done", scope: account.scope }).sort({ updatedAt: -1 }).select("updatedAt").lean();
  const connection = publicAccount(account);
  const issues: string[] = [];
  if (!connection.configured) issues.push("Complete the sender credentials");
  if (connection.connectionStatus !== "connected") issues.push("Test the connection");
  if (!templates.some(t => t.status === "APPROVED")) issues.push("Sync approved templates from WhatsApp Manager");
  const purposes: SupportedTemplateId[] = ["BOOKING_CONFIRMATION", "APPOINTMENT_REMINDER", "APPOINTMENT_CANCELLED", "CONSULTATION_COMPLETED", "QUEUE_UPDATE", "LAB_RESULTS_READY", "BILLING_RECEIPT", "DOCTOR_DISRUPTION", "DISRUPTION_TRANSFER", "DISRUPTION_REFUND_CONFIRMATION", "QUEUE_DELAY_ALERT", "OTP_VERIFICATION"];
  const expected = purposes.map(templateId => ({ purpose: templateId, name: buildMetaTemplateParams({ phone: "", templateId, variables: {} }).templateName, language: process.env.META_WHATSAPP_LANG || "en" }));
  const missing = expected.filter(item => !templates.some(template => template.name === item.name && template.language === item.language && template.status === "APPROVED"));
  if (missing.length) issues.push(`Missing approved templates: ${missing.map(item => item.name).join(", ")}`);
  if (!lastWebhook) issues.push("No verified webhook has been processed yet");
  const webhookFailures = await WhatsAppWebhookInbox.countDocuments({ scope: account.scope, status: "failed", createdAt: { $gte: start } });
  if (webhookFailures) issues.push(`${webhookFailures} webhook event(s) need review. An interrupted clinical command is not repeated automatically.`);
  if (messages.some(row => row.status === "accepted" && Date.now() - row.createdAt.getTime() > 30 * 60_000)) issues.push("Messages are awaiting delivery callbacks for more than 30 minutes. Check the Meta webhook subscription.");
  return reply.send({ success: true, data: { connection, templates, requiredTemplates: expected, today, pending, lastWebhookAt: lastWebhook?.updatedAt || null, issues,
    messages: messages.map(row => ({ ...row, recipientPhone: `••••${row.recipientPhone.slice(-4)}` })) } });
}
