import crypto from "node:crypto";
import type mongoose from "mongoose";
import { decrypt, encrypt } from "../utilities/encryption.ts";
import { OutboundMessage } from "../models/OutboundMessage.ts";
import type { SendMessageOptions } from "./SmsWhatsAppService.ts";
import type { EmailOptions, SmtpConfig } from "../notifications/providers/emailProvider.ts";

export interface WhatsAppDocumentMessage {
  to: string;
  documentUrl: string;
  filename: string;
  caption?: string;
  idempotencyKey?: string;
}

export interface WhatsAppFreeformMessage {
  to: string;
  text: string;
  organizationId?: string;
  recipientName?: string;
  idempotencyKey?: string;
}

export interface TransactionalEmailMessage extends EmailOptions {
  /** A stable business-event key prevents duplicate sends across retries/pods. */
  idempotencyKey?: string;
  /** Lets callers persist the notification in the business transaction. */
  session?: mongoose.ClientSession | null;
  /** Optional organization SMTP settings; encrypted with the email body. */
  orgSmtp?: SmtpConfig | null;
}

function getCommunicationIdempotencyKey(options: SendMessageOptions): string {
  if (options.idempotencyKey) return options.idempotencyKey;
  const channel = options.channel || "whatsapp";
  if (options.appointmentId) return `${channel}_${options.appointmentId}_${options.templateId}`;

  const stablePayload = JSON.stringify({
    channel,
    phone: options.phone.trim(),
    templateId: options.templateId,
    patientName: options.patientName || "",
    variables: Object.entries(options.variables).sort(([a], [b]) => a.localeCompare(b)),
  });
  return `communication:${crypto.createHash("sha256").update(stablePayload).digest("hex")}`;
}

/**
 * Persist a clinical template delivery. The API never calls the provider: the
 * standalone outbound worker decrypts and dispatches this record after commit.
 */
export async function enqueueCommunicationTemplate(options: SendMessageOptions) {
  const idempotencyKey = getCommunicationIdempotencyKey(options);
  const normalized: SendMessageOptions = {
    ...options,
    phone: options.phone.trim(),
    channel: options.channel || "whatsapp",
    idempotencyKey,
  };

  try {
    return await OutboundMessage.findOneAndUpdate(
      { idempotencyKey },
      {
        $setOnInsert: {
          kind: "communication_template",
          idempotencyKey,
          // Retain only safe routing metadata in the normally selected field.
          payload: {
            channel: normalized.channel,
            templateId: normalized.templateId,
            appointmentId: normalized.appointmentId || null,
          },
          sensitivePayloadCiphertext: encrypt(JSON.stringify(normalized)),
          status: "pending",
          attempts: 0,
          maxAttempts: 5,
          nextAttemptAt: new Date(),
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    );
  } catch (error: any) {
    if (error?.code === 11000) {
      const existing = await OutboundMessage.findOne({ idempotencyKey });
      if (existing) return existing;
    }
    throw error;
  }
}

async function enqueueEncryptedOutbound(
  kind: "whatsapp_document" | "whatsapp_freeform" | "transactional_email",
  idempotencyKey: string,
  payload: Record<string, unknown>,
  safeMetadata: Record<string, unknown>,
  session?: mongoose.ClientSession | null,
) {
  try {
    return await OutboundMessage.findOneAndUpdate(
      { idempotencyKey },
      {
        $setOnInsert: {
          kind,
          idempotencyKey,
          payload: safeMetadata,
          sensitivePayloadCiphertext: encrypt(JSON.stringify(payload)),
          status: "pending",
          attempts: 0,
          maxAttempts: 5,
          nextAttemptAt: new Date(),
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, session: session || undefined },
    );
  } catch (error: any) {
    if (error?.code === 11000) {
      const existing = await OutboundMessage.findOne({ idempotencyKey }).session(session || null);
      if (existing) return existing;
    }
    throw error;
  }
}

export async function enqueueWhatsAppDocument(options: WhatsAppDocumentMessage) {
  const idempotencyKey = options.idempotencyKey || `whatsapp-document:${crypto
    .createHash("sha256")
    .update(JSON.stringify([options.to, options.documentUrl, options.filename, options.caption || ""]))
    .digest("hex")}`;
  return enqueueEncryptedOutbound(
    "whatsapp_document",
    idempotencyKey,
    { ...options, to: options.to.trim(), idempotencyKey },
    { deliveryType: "document" },
  );
}

export async function enqueueWhatsAppFreeform(options: WhatsAppFreeformMessage) {
  const idempotencyKey = options.idempotencyKey || `whatsapp-freeform:${crypto
    .createHash("sha256")
    .update(JSON.stringify([options.to, options.text]))
    .digest("hex")}`;
  return enqueueEncryptedOutbound(
    "whatsapp_freeform",
    idempotencyKey,
    { ...options, to: options.to.trim(), idempotencyKey },
    { deliveryType: "freeform" },
  );
}

/**
 * Persist a business email before the provider is contacted. Email addresses,
 * message bodies, and capability links stay exclusively in the encrypted
 * payload; normal outbox projections expose only delivery state.
 */
export async function enqueueTransactionalEmail(options: TransactionalEmailMessage) {
  const { session, ...email } = options;
  const normalized = { ...email, to: email.to.trim() };
  const idempotencyKey = options.idempotencyKey || `transactional-email:${crypto
    .createHash("sha256")
    .update(JSON.stringify([normalized.to.toLowerCase(), normalized.subject, normalized.text || "", normalized.html, normalized.from || ""]))
    .digest("hex")}`;

  return enqueueEncryptedOutbound(
    "transactional_email",
    idempotencyKey,
    { ...normalized, idempotencyKey },
    { deliveryType: "transactional_email" },
    session,
  );
}

export function readEncryptedOutboundPayload<T>(message: { sensitivePayloadCiphertext?: string }): T {
  if (!message.sensitivePayloadCiphertext) {
    throw new Error("Outbound message payload is missing or was not selected");
  }
  return JSON.parse(decrypt(message.sensitivePayloadCiphertext)) as T;
}

export function readCommunicationTemplate(message: { sensitivePayloadCiphertext?: string }): SendMessageOptions {
  const parsed = readEncryptedOutboundPayload<any>(message);
  if (!parsed?.phone || !parsed?.templateId || !parsed?.variables) {
    throw new Error("Communication outbox payload is invalid");
  }
  return parsed as SendMessageOptions;
}
