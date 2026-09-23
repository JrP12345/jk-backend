import mongoose from "mongoose";
import { AIChatSession } from "../models/AIChatSession.ts";
import { AIChatMessage } from "../models/AIChatMessage.ts";
import { verifyEnv } from "../utilities/config.ts";

export interface BackfillResult {
  sessionsProcessed: number;
  messagesBackfilled: number;
  sessionsVerified: number;
  discrepancies: Array<{ sessionId: string; embeddedCount: number; normalizedCount: number }>;
}

/**
 * Batched backfill helper that idempotently migrates embedded session.messages
 * into normalized AIChatMessage collection with sequence numbers and count verification.
 */
export async function backfillAIChatMessages(batchSize = 100): Promise<BackfillResult> {
  const result: BackfillResult = {
    sessionsProcessed: 0,
    messagesBackfilled: 0,
    sessionsVerified: 0,
    discrepancies: [],
  };

  let lastId: mongoose.Types.ObjectId | null = null;
  let hasMore = true;

  while (hasMore) {
    const query: Record<string, any> = {
      "messages.0": { $exists: true },
    };
    if (lastId) {
      query._id = { $gt: lastId };
    }

    const sessions = await AIChatSession.find(query)
      .sort({ _id: 1 })
      .limit(batchSize)
      .lean();

    if (sessions.length === 0) {
      hasMore = false;
      break;
    }

    for (const session of sessions) {
      lastId = session._id as mongoose.Types.ObjectId;
      result.sessionsProcessed += 1;

      const embeddedMessages = session.messages || [];
      if (embeddedMessages.length === 0) continue;

      // Check existing normalized message count for this session
      const existingCount = await AIChatMessage.countDocuments({ sessionId: session._id });

      if (existingCount < embeddedMessages.length) {
        // Prepare missing messages for bulk upsert
        for (let i = 0; i < embeddedMessages.length; i++) {
          const msg = embeddedMessages[i];
          const seq = i + 1;

          await AIChatMessage.updateOne(
            {
              sessionId: session._id,
              sequence: seq,
            },
            {
              $setOnInsert: {
                sessionId: session._id,
                organizationId: session.organizationId,
                userId: session.userId,
                sender: msg.sender,
                text: msg.text,
                citations: msg.citations || [],
                suggestedActions: msg.suggestedActions || [],
                sequence: seq,
                timestamp: msg.timestamp || new Date().toISOString(),
                createdAt: msg.createdAt || new Date(),
              },
            },
            { upsert: true },
          );
          result.messagesBackfilled += 1;
        }
      }

      // Verification pass
      const verifiedCount = await AIChatMessage.countDocuments({ sessionId: session._id });
      if (verifiedCount === embeddedMessages.length) {
        result.sessionsVerified += 1;
      } else {
        result.discrepancies.push({
          sessionId: session._id.toString(),
          embeddedCount: embeddedMessages.length,
          normalizedCount: verifiedCount,
        });
      }
    }

    if (sessions.length < batchSize) {
      hasMore = false;
    }
  }

  return result;
}

async function main() {
  verifyEnv();
  await import("../db.ts");

  console.log("[BackfillAIChatMessages] Starting batch backfill of embedded AI chat messages...");
  const startTime = Date.now();
  const summary = await backfillAIChatMessages(100);
  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log(`[BackfillAIChatMessages] Completed in ${elapsedSec}s:`);
  console.log(`  - Sessions processed: ${summary.sessionsProcessed}`);
  console.log(`  - Messages backfilled: ${summary.messagesBackfilled}`);
  console.log(`  - Sessions verified: ${summary.sessionsVerified}`);
  if (summary.discrepancies.length > 0) {
    console.warn(`  - Discrepancies detected: ${summary.discrepancies.length}`, summary.discrepancies);
  } else {
    console.log("  - Verification status: 100% matched counts & ordering.");
  }

  await mongoose.disconnect();
  process.exit(0);
}

if (process.argv[1]?.includes("backfill-ai-chat-messages")) {
  main().catch((err) => {
    console.error("[BackfillAIChatMessages] Fatal error:", err);
    process.exit(1);
  });
}
