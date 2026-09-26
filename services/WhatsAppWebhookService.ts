import crypto from "node:crypto";
import type { FastifyRequest } from "fastify";
import { WhatsAppWebhookInbox } from "../models/WhatsAppWebhookInbox.ts";
import { encrypt, decrypt } from "../utilities/encryption.ts";
import { getPlatformAccount, resolveWebhookOwner } from "./WhatsAppAccountService.ts";

function assertSignature(req: FastifyRequest, secret: string | undefined, raw: Buffer | null) {
  if (!secret && process.env.NODE_ENV === "test") return;
  const signature = req.headers["x-hub-signature-256"];
  if (!secret || secret === "[DECRYPTION_FAILED]" || !raw || typeof signature !== "string" || !/^sha256=[a-f0-9]{64}$/i.test(signature)) throw new Error("INVALID_WEBHOOK_SIGNATURE");
  const expected = crypto.createHmac("sha256", secret).update(raw).digest();
  if (!crypto.timingSafeEqual(Buffer.from(signature.slice(7), "hex"), expected)) throw new Error("INVALID_WEBHOOK_SIGNATURE");
}

export async function enqueueWhatsAppWebhook(req: FastifyRequest) {
  const body = req.body as any;
  if (body?.object !== "whatsapp_business_account") return;
  const rawBody = (req as any).rawBody;
  const raw = Buffer.isBuffer(rawBody) ? rawBody : typeof rawBody === "string" ? Buffer.from(rawBody) : null;
  if (!body.entry?.length) assertSignature(req, (await getPlatformAccount()).appSecret, raw);
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const owner = await resolveWebhookOwner(entry.id, change.value?.metadata?.phone_number_id);
      if (!owner) continue;
      assertSignature(req, owner.appSecret, raw);
      const value = change.value || {};
      const events = change.field === "messages"
        ? [...(value.messages || []).map((message: any) => ({ ...change, value: { ...value, messages: [message], statuses: undefined } })),
           ...(value.statuses || []).map((status: any) => ({ ...change, value: { ...value, statuses: [status], messages: undefined } }))]
        : [change];
      for (const event of events) {
        const item = event.value.messages?.[0] || event.value.statuses?.[0];
        const eventId = item ? [item.id, item.status || "inbound", ...(item.status ? [item.timestamp] : [])] : event;
        const dedupeKey = crypto.createHash("sha256").update(JSON.stringify([entry.id, change.field, eventId])).digest("hex");
        const payload = { object: body.object, entry: [{ id: entry.id, owner: { scope: owner.scope, organizationId: owner.organizationId }, changes: [event] }] };
        try {
          await WhatsAppWebhookInbox.updateOne({ dedupeKey }, { $setOnInsert: { dedupeKey, scope: owner.scope, payloadCiphertext: encrypt(JSON.stringify(payload)), status: "pending", nextAttemptAt: new Date() } }, { upsert: true });
        } catch (error: any) { if (error.code !== 11000) throw error; }
      }
    }
  }
}

export class WhatsAppWebhookWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  start() {
    if (!this.timer) this.timer = setInterval(() => { void this.processBatch().catch(() => console.error("[WhatsAppWebhookWorker] Processing failed")); }, 500);
    this.timer.unref?.();
  }
  async stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async processBatch(limit = 10) {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let n = 0; n < limit; n++) {
        const now = new Date();
        const lockedBy = crypto.randomUUID();
        const row = await WhatsAppWebhookInbox.findOneAndUpdate({ status: { $in: ["pending", "processing"] }, nextAttemptAt: { $lte: now }, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
          { $set: { status: "processing", lockedUntil: new Date(Date.now() + 120_000), lockedBy }, $inc: { attempts: 1 } }, { returnDocument: "before", sort: { createdAt: 1 } }).select("+payloadCiphertext");
        if (!row) break;
        let inboundCommand = false;
        try {
          const body = JSON.parse(decrypt(row.payloadCiphertext));
          inboundCommand = !!body.entry?.[0]?.changes?.[0]?.value?.messages?.length;
          // A crashed clinical bot command can have committed a booking/queue change.
          if (row.status === "processing" && body.entry?.[0]?.changes?.[0]?.value?.messages?.length) throw new Error("AMBIGUOUS_INBOUND_COMMAND");
          const { processWhatsAppWebhookPayload } = await import("../controllers/whatsappWebhook.ts");
          await processWhatsAppWebhookPayload(body);
          await WhatsAppWebhookInbox.updateOne({ _id: row._id, lockedBy }, { $set: { status: "done" }, $unset: { payloadCiphertext: 1, lockedUntil: 1, lockedBy: 1, error: 1 } });
        } catch (error: any) {
          const retry = !inboundCommand && row.attempts < 9 && error.message !== "AMBIGUOUS_INBOUND_COMMAND";
          await WhatsAppWebhookInbox.updateOne({ _id: row._id, lockedBy }, { $set: { status: retry ? "pending" : "failed", error: error.message === "ORPHAN_STATUS" ? "ORPHAN_STATUS" : "WEBHOOK_PROCESSING_FAILED", nextAttemptAt: new Date(Date.now() + Math.min(300_000, 1000 * 2 ** row.attempts)) }, $unset: { lockedUntil: 1, lockedBy: 1 } });
        }
      }
    } finally { this.busy = false; }
  }
}
export const whatsAppWebhookWorker = new WhatsAppWebhookWorker();
