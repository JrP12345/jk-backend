import type { FastifyRequest, FastifyReply } from "fastify";
import crypto from "node:crypto";
import { NotificationLog, type INotificationLog } from "../models/NotificationLog.ts";
import { OutboundMessage } from '../models/OutboundMessage.ts';
import { Appointment } from '../models/Appointment.ts';
import { recordCommunicationRecovery, resolveCommunicationRecovery } from '../services/CommunicationRecoveryService.ts';
import { withTransaction } from '../utilities/transaction.ts';
import { UsageRecord } from "../models/UsageRecord.ts";
import { Organization } from "../models/Organization.ts";
import { WhatsAppRecipient } from "../models/WhatsAppRecipient.ts";
import { WhatsAppTemplate } from "../models/WhatsAppTemplate.ts";
import { WhatsAppInboundMessage } from "../models/WhatsAppInboundMessage.ts";
import { encryptField, decryptField } from "../utilities/cryptoEnvelope.ts";
import { phoneHash } from "../services/WhatsAppSendPolicy.ts";
import { getPlatformAccount, secretProjection } from "../services/WhatsAppAccountService.ts";
import { enqueueWhatsAppWebhook, whatsAppWebhookWorker } from "../services/WhatsAppWebhookService.ts";

/**
 * GET /api/webhooks/whatsapp
 * Meta Webhook verification handshake
 */
export async function verifyWhatsAppWebhook(req: FastifyRequest, reply: FastifyReply) {
  let query = (req.query as any) || {};

  // Resilient fallback: parse URL searchParams directly if req.query is empty
  if (Object.keys(query).length === 0 && req.url.includes("?")) {
    const searchParams = new URL(req.url, "http://localhost").searchParams;
    query = Object.fromEntries(searchParams.entries());
  }

  const mode = query["hub.mode"] || query?.hub?.mode;
  const token = query["hub.verify_token"] || query?.hub?.verify_token;
  const challenge = query["hub.challenge"] || query?.hub?.challenge;

  const platform = await getPlatformAccount();
  const organizations = await Organization.find({ "whatsappConfig.verifyToken": { $ne: null } }).select(secretProjection);
  const tokens = [platform.verifyToken, ...organizations.map(org => decryptField(org.whatsappConfig?.verifyToken))].filter(value => value && value !== "[DECRYPTION_FAILED]");
  const matches = typeof token === "string" && tokens.some(expected => Buffer.byteLength(token) === Buffer.byteLength(expected) && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected)));
  if (mode === "subscribe" && matches) {
    return reply.code(200).send(challenge);
  }

  return reply.code(403).send({ error: "Forbidden: Invalid verify token" });
}

/**
 * POST /api/webhooks/whatsapp
 * Handles status receipts (sent, delivered, read, failed) and inbound messages (STOP opt-out)
 */
export async function handleWhatsAppWebhookEvent(req: FastifyRequest, reply: FastifyReply) {
  try {
    await enqueueWhatsAppWebhook(req);
    if (process.env.NODE_ENV === "test") await whatsAppWebhookWorker.processBatch();
    return reply.code(200).send({ success: true, status: "accepted" });
  } catch (error: any) {
    return reply.code(error.message === "INVALID_WEBHOOK_SIGNATURE" ? 401 : 503).send({ success: false, error: error.message === "INVALID_WEBHOOK_SIGNATURE" ? "Invalid webhook signature" : "Webhook persistence failed" });
  }
}

export async function processWhatsAppWebhookPayload(body: any) {
  const entries = body.entry || [];

  for (const entry of entries) {
    const owner = entry.owner;
    if (!owner) continue;
    const changes = entry.changes || [];
    for (const change of changes) {
      if (change.field !== "messages") {
        const event = change.value || {};
        const timestamp = new Date(Number(event.timestamp || entry.time || Date.now() / 1000) * 1000);
        const filter: any = { scope: owner.scope, $or: [{ lastMetaEventAt: { $lt: timestamp } }, { lastMetaEventAt: { $exists: false } }] };
        if (event.message_template_id) filter.metaId = String(event.message_template_id);
        else if (event.message_template_name) filter.name = event.message_template_name;
        else continue;
        const fields: any = { lastMetaEventAt: timestamp };
        if (change.field === "message_template_status_update" && event.event) fields.status = event.event === "DELETED" ? "DELETED" : event.event;
        if (change.field === "template_category_update" && event.new_category) fields.category = event.new_category;
        if (change.field === "message_template_quality_update" && event.new_quality_score === "RED") fields.status = "PAUSED";
        await WhatsAppTemplate.updateMany(filter, { $set: fields });
        continue;
      }
      const val = change.value;
      if (!val) continue;

      // ─────────────────────────────────────────────────────────────────────
      // 1. Delivery Status Updates
      // ─────────────────────────────────────────────────────────────────────
      if (Array.isArray(val.statuses)) {
        for (const statusObj of val.statuses) {
          const wamid = statusObj.id;
          const status = statusObj.status; // "sent", "delivered", "read", "failed"

          if (!wamid) continue;

          const log = await NotificationLog.findOne({
            ...(owner.organizationId ? { organizationId: owner.organizationId } : {}),
            $or: [{ metaMessageId: wamid }, { providerMessageId: wamid }],
          });

          if (!log) throw new Error("ORPHAN_STATUS");
          const allowed: Record<string, string[]> = { sent: ["queued", "sending", "accepted"], delivered: ["queued", "sending", "accepted", "sent", "failed"], read: ["queued", "sending", "accepted", "sent", "delivered", "failed"], failed: ["queued", "sending", "accepted", "sent"] };
          if (!allowed[status]) continue;
          const changed = await NotificationLog.updateOne({ _id: log._id, status: { $in: allowed[status] as INotificationLog["status"][] } }, { $set: {
            status, [`${status}At`]: new Date(Number(statusObj.timestamp || Date.now() / 1000) * 1000),
            ...(statusObj.pricing ? { pricing: statusObj.pricing } : {}),
            ...(statusObj.errors?.length ? { errorReason: `META_ERROR_${statusObj.errors[0].code || "UNKNOWN"}` } : {}),
          } });
          // Reconcile independently on every replay: a crash after the ledger write
          // must not strand the outbox. Never downgrade delivered/read evidence.
          if (log.idempotencyKey && log.organizationId) {
            const key = log.idempotencyKey.replace(/^outbound:/, '');
            const evidence = await NotificationLog.findById(log._id);
            const observed = evidence?.status;
            if (observed && allowed[observed]) await OutboundMessage.updateOne({ idempotencyKey: key, 'payload.organizationId': String(log.organizationId), status: { $in: ['pending', 'processing', 'retrying', ...allowed[observed]] } }, { $set: { status: observed, [observed + 'At']: evidence?.get(observed + 'At') || new Date(), ...(observed === 'failed' ? { error: evidence?.errorReason || 'PROVIDER_REJECTED' } : {}) }, $unset: { lockedAt: 1, lockedUntil: 1, lockedBy: 1, nextAttemptAt: 1, ...(observed !== 'failed' ? { error: 1 } : {}) } });
            const current = await OutboundMessage.findOne({ idempotencyKey: key, 'payload.organizationId': String(log.organizationId) });
            if (current && ['failed', 'delivered', 'read'].includes(current.status)) await withTransaction(async () => {
              if (current.status === 'failed') await recordCommunicationRecovery(current);
              else await resolveCommunicationRecovery(current);
              if (['delivered', 'read'].includes(current.status) && current.kind === 'whatsapp_document' && (current.idempotencyKey.startsWith('rx:') || current.idempotencyKey.startsWith('whatsapp-document:consultation-complete:')) && current.payload.appointmentId) await Appointment.updateOne({ _id: current.payload.appointmentId, organizationId: current.payload.organizationId, patientId: current.payload.patientId }, { $set: { rxDispatchedAt: current.deliveredAt || current.readAt || new Date() } });
              if (['delivered', 'read'].includes(current.status) && current.payload.communicationAction === 'disruption' && current.payload.appointmentId) await Appointment.updateOne({ _id: current.payload.appointmentId, organizationId: current.payload.organizationId, patientId: current.payload.patientId, communicationRevision: current.payload.communicationRevision, status: 'disruption_triage', disruptionNotifiedAt: { $exists: false } }, { $set: { disruptionNotifiedAt: current.deliveredAt || current.readAt || new Date() } });
            });
          }
          if (changed.modifiedCount) {

            // Update organization-level UsageRecord aggregates
            if (log.organizationId) {
              if (status === "delivered") {
                await UsageRecord.updateOne(
                  { organizationId: log.organizationId },
                  { $inc: { whatsappDeliveredCount: 1 } }, { upsert: true }
                ).catch(() => {});
              } else if (status === "failed") {
                await UsageRecord.updateOne(
                  { organizationId: log.organizationId },
                  { $inc: { whatsappFailedCount: 1 } }, { upsert: true }
                ).catch(() => {});
              }
            }
          }
        }
      }

      // ─────────────────────────────────────────────────────────────────────
      // 2. Inbound Messages: Opt-Out & Two-Way Interactive OPD Assistant
      // ─────────────────────────────────────────────────────────────────────
      if (Array.isArray(val.messages)) {
        for (const msg of val.messages) {
          const from = msg.from; // Phone number e.g. "919876543210"
          const rawText = (msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "").trim();
          const textBody = rawText.toUpperCase();
          const fullDigits = String(from || "").replace(/\D/g, "");
          const digits = fullDigits.startsWith("91") && fullDigits.length === 12 ? fullDigits.slice(2) : fullDigits;

          if (!digits) continue;

          const stopped = /^(STOP(?:\s+ALL)?|UNSUBSCRIBE|OPT[ -]?OUT)[.!]*$/.test(textBody);
          const started = /^(START|SUBSCRIBE)[.!]*$/.test(textBody);
          if (!msg.id) continue;
          const inboundAt = new Date(Math.min(Date.now(), Number(msg.timestamp || Date.now() / 1000) * 1000));
          if (!Number.isFinite(inboundAt.getTime())) continue;
          await WhatsAppInboundMessage.updateOne({ scope: owner.scope, wamid: msg.id }, { $setOnInsert: { phoneHash: phoneHash(from), type: msg.type || "unknown", payloadCiphertext: encryptField(JSON.stringify(msg)), organizationId: owner.organizationId || null, pendingReview: !stopped && !started } }, { upsert: true });
          await WhatsAppRecipient.updateOne({ scope: owner.scope, phoneHash: phoneHash(from) }, { $max: { lastInboundAt: inboundAt } }, { upsert: true });
          if (stopped || started) await WhatsAppRecipient.updateOne({ scope: owner.scope, phoneHash: phoneHash(from), $or: [{ lastPreferenceAt: { $lt: inboundAt } }, { lastPreferenceAt: { $exists: false } }] }, { $set: { optedOut: stopped, lastPreferenceAt: inboundAt } });
          // Staff explicitly route and associate messages. Phone hints are not identity.
          // STOP is a sender-channel suppression; START never creates patient consent.
          continue;
        }
      }
    }
  }

}
