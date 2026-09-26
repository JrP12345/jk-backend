import { NotificationLog } from "../models/NotificationLog.ts";
import { isPermanentWhatsAppFailure } from "./WhatsAppSendPolicy.ts";

/** The unique ledger key owns the attempt across API requests and worker restarts. */
export async function claimWhatsAppIntent(key: string, fields: Record<string, unknown>) {
  let existing: any;
  try {
    existing = await NotificationLog.findOneAndUpdate({ idempotencyKey: key }, { $setOnInsert: { ...fields, idempotencyKey: key, status: "sending" } }, { upsert: true, returnDocument: "before" });
  } catch (error: any) {
    if (error.code !== 11000) throw error;
    existing = await NotificationLog.findOne({ idempotencyKey: key });
  }
  if (!existing) return { claimed: true, log: await NotificationLog.findOne({ idempotencyKey: key }) };
  if (["accepted", "sent", "delivered", "read"].includes(existing.status)) return { claimed: false, log: existing };
  if (existing.status === "sending") throw new Error("AMBIGUOUS_NETWORK");
  if (isPermanentWhatsAppFailure(existing.errorReason) || existing.errorReason === "INSUFFICIENT_CREDITS") throw new Error(existing.errorReason);
  const log = await NotificationLog.findOneAndUpdate({ _id: existing._id, status: "failed", errorReason: existing.errorReason }, { $set: { ...fields, status: "sending" }, $unset: { errorReason: 1 } }, { returnDocument: "after" });
  if (!log) throw new Error("AMBIGUOUS_NETWORK");
  return { claimed: true, log };
}
