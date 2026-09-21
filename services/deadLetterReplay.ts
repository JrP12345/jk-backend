import mongoose from "mongoose";
import { AuditLog } from "../models/AuditLog.ts";
import { NotificationDelivery } from "../models/NotificationDelivery.ts";
import { OutboundMessage } from "../models/OutboundMessage.ts";
import { DomainEventOutbox } from "../models/DomainEventOutbox.ts";

export const DEAD_LETTER_KINDS = ["notification_delivery", "outbound_message", "domain_event"] as const;
export type DeadLetterKind = (typeof DEAD_LETTER_KINDS)[number];

const MAX_MANUAL_REPLAYS = 3;

// The collections intentionally have different schemas. At this boundary
// they share only the outbox lifecycle fields queried below, so a common
// Mongoose model interface avoids creating an unsafe union of overloaded model
// methods.
type DeadLetterModel = mongoose.Model<any>;

function getModel(kind: DeadLetterKind): DeadLetterModel {
  if (kind === "notification_delivery") return NotificationDelivery;
  if (kind === "outbound_message") return OutboundMessage;
  return DomainEventOutbox;
}

/**
 * Return only operational metadata. The actual payload, body and recipient
 * fields can contain PHI and are intentionally never exposed by this console.
 */
export async function listDeadLetters(kind: DeadLetterKind, limit = 50) {
  const rows = await getModel(kind)
    .find({ status: "failed" })
    .select("_id kind channel eventType status attempts maxAttempts replayCount error sentAt createdAt lastReplayedAt")
    .sort({ sentAt: -1, createdAt: -1 })
    .limit(Math.min(Math.max(limit, 1), 100))
    .lean();

  return rows.map((row: any) => ({
    id: row._id.toString(),
    kind,
    deliveryKind: row.kind || row.channel || row.eventType,
    status: row.status,
    attempts: row.attempts || 0,
    maxAttempts: row.maxAttempts || 5,
    replayCount: row.replayCount || 0,
    replayLimit: MAX_MANUAL_REPLAYS,
    error: row.error || "Delivery failed",
    failedAt: row.sentAt || null,
    createdAt: row.createdAt,
    lastReplayedAt: row.lastReplayedAt || null,
  }));
}

export type ReplayResult =
  | { state: "replayed"; item: Record<string, unknown> }
  | { state: "not_found" | "not_replayable" };

/**
 * Requeue one terminal job. This is a root-only, explicit operation: failed
 * jobs remain terminal unless an operator supplies the required confirmation.
 */
export async function replayDeadLetter(
  kind: DeadLetterKind,
  id: string,
  actorUserId: string,
): Promise<ReplayResult> {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new Error("Invalid dead-letter identifier");
  }
  if (!mongoose.Types.ObjectId.isValid(actorUserId)) {
    throw new Error("Invalid replay operator identity");
  }

  const Model = getModel(kind);
  const now = new Date();
  const replayed = await Model.findOneAndUpdate(
    {
      _id: id,
      status: "failed",
      replayCount: { $lt: MAX_MANUAL_REPLAYS },
    },
    {
      $set: {
        status: "pending",
        attempts: 0,
        nextAttemptAt: now,
        lastReplayedAt: now,
        lastReplayedBy: new mongoose.Types.ObjectId(actorUserId),
      },
      $inc: { replayCount: 1 },
      $unset: { error: 1, sentAt: 1, lockedAt: 1, lockedUntil: 1, lockedBy: 1 },
    },
    // Return the terminal row so the immutable audit trail records the actual
    // failed-attempt count rather than the reset value.
    { returnDocument: "before" },
  ).lean();

  if (!replayed) {
    const exists = await Model.exists({ _id: id });
    return { state: exists ? "not_replayable" : "not_found" };
  }

  // The outbox row itself records who requeued it. Audit is an additional,
  // immutable operator trail and deliberately excludes payload/recipient data.
  await AuditLog.create({
    userId: new mongoose.Types.ObjectId(actorUserId),
    action: "OUTBOX_DEAD_LETTER_REPLAYED",
    targetId: replayed._id,
    targetModel: kind === "notification_delivery" ? "NotificationDelivery" : "OutboundMessage",
    category: "ADMIN",
    details: {
      deadLetterKind: kind,
      attemptsBeforeReplay: (replayed as any).attempts || 0,
      replayCount: ((replayed as any).replayCount || 0) + 1,
      manualReplayLimit: MAX_MANUAL_REPLAYS,
    },
  });

  return {
    state: "replayed",
    item: {
      id: replayed._id.toString(),
      kind,
      status: "pending",
      replayCount: ((replayed as any).replayCount || 0) + 1,
      replayLimit: MAX_MANUAL_REPLAYS,
      nextAttemptAt: now,
    },
  };
}
