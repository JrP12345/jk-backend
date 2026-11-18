import type { FastifyRequest, FastifyReply } from "fastify";
import crypto from "node:crypto";
import { Organization } from "../models/Organization.ts";
import { decryptField } from "../utilities/cryptoEnvelope.ts";
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
