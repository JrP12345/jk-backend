import { UploadIntent } from "../models/UploadIntent.ts";
import { deleteObjectFromStorage } from "../utilities/r2.ts";
import { logger } from "../utilities/logger.ts";

/**
 * Worker: Orphan Upload Cleanup & Quarantine Purge
 * Finds expired, orphaned upload intents older than their expiry threshold
 * and removes unverified objects from storage to prevent storage leaks.
 */
export async function cleanOrphanedUploads(): Promise<{ cleanedCount: number }> {
  const expiredIntents = await UploadIntent.find({
    status: { $in: ["pending", "quarantined"] },
    expiresAt: { $lt: new Date() },
  }).limit(50);

  let cleanedCount = 0;

  for (const intent of expiredIntents) {
    try {
      if (intent.objectKey) {
        await deleteObjectFromStorage(intent.objectKey).catch(() => {});
      }
      intent.status = "expired";
      intent.rejectionReason = "Upload intent expired without completion";
      await intent.save();
      cleanedCount++;
    } catch (err: any) {
      logger.warn(`[OrphanCleanup] Failed to clean object ${intent.objectKey}:`, err.message);
    }
  }

  return { cleanedCount };
}
