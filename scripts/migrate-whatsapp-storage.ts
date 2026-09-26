import mongoose from "mongoose";
import { Organization } from "../models/Organization.ts";
import { NotificationLog } from "../models/NotificationLog.ts";
import { WhatsAppAccount } from "../models/WhatsAppAccount.ts";
import { WhatsAppTemplate } from "../models/WhatsAppTemplate.ts";
import { WhatsAppWebhookInbox } from "../models/WhatsAppWebhookInbox.ts";
import { WhatsAppRecipient } from "../models/WhatsAppRecipient.ts";
import { WhatsAppInboundMessage } from "../models/WhatsAppInboundMessage.ts";
import { WhatsAppBookingSession } from "../models/WhatsAppBookingSession.ts";
import { encrypt, isEncrypted } from "../utilities/encryption.ts";

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
  const apply = process.argv.includes("--apply");
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
  const duplicates = await NotificationLog.aggregate([
    { $match: { metaMessageId: { $type: "string" } } }, { $group: { _id: "$metaMessageId", count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }, { $count: "count" },
  ]);
  if (duplicates.length) throw new Error("Duplicate provider message IDs exist; reconcile them before creating the unique index");
  let credentials = 0;
  const organizations = Organization.collection.find({});
  for await (const org of organizations) {
    const updates: Record<string, unknown> = {};
    if (org.whatsappConfig?.wabaId === "") updates["whatsappConfig.wabaId"] = null;
    for (const key of ["accessToken", "appSecret", "verifyToken"]) {
      const value = org.whatsappConfig?.[key];
      if (value && !isEncrypted(value)) { updates[`whatsappConfig.${key}`] = encrypt(value); credentials++; }
    }
    if (apply && Object.keys(updates).length) await Organization.collection.updateOne({ _id: org._id }, { $set: updates });
  }
  let bodies = 0;
  for await (const log of NotificationLog.collection.find({ channel: "whatsapp", messageContent: { $type: "string" } })) {
    if (!isEncrypted(log.messageContent)) {
      bodies++;
      if (apply) await NotificationLog.collection.updateOne({ _id: log._id }, { $set: { messageContent: encrypt(log.messageContent) } });
    }
  }
  if (apply) for (const model of [Organization, NotificationLog, WhatsAppAccount, WhatsAppTemplate, WhatsAppWebhookInbox, WhatsAppRecipient, WhatsAppInboundMessage, WhatsAppBookingSession]) await model.createIndexes();
  console.log(JSON.stringify({ mode: apply ? "applied" : "preview", legacyCredentials: credentials, legacyBodies: bodies, indexesCreated: apply }));
}
main().catch(() => { console.error("WhatsApp migration failed; check database connectivity, encryption configuration and duplicate IDs."); process.exitCode = 1; }).finally(() => mongoose.disconnect());
