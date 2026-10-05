import { UploadIntent } from "../models/UploadIntent.ts";
import { deleteObjectFromStorage } from "../utilities/r2.ts";
export async function cleanupExpiredUploads() {
  const rows = await UploadIntent.find({ status: { $in: ["pending", "quarantined", "rejected", "expired", "verifying"] }, registeredDocumentId: { $exists: false },
    expiresAt: { $lt: new Date(Date.now() - 24 * 60 * 60_000) },
    $or: [{ status: { $ne: "verifying" } }, { verifyingUntil: { $lte: new Date() } }, { verifyingUntil: { $exists: false } }],
  }).sort({ expiresAt: 1 }).limit(100).lean();
  for (const row of rows) {
    const claimed = await UploadIntent.findOneAndUpdate({ _id: row._id, status: row.status, expiresAt: row.expiresAt, registeredDocumentId: { $exists: false },
      ...(row.status === "verifying" ? { verificationToken: row.verificationToken ?? { $exists: false }, verifyingUntil: row.verifyingUntil ?? { $exists: false } } : {}),
    }, { $set: { status: "expired" } });
    if (!claimed) continue;
    try {
      await deleteObjectFromStorage(row.objectKey);
      await UploadIntent.deleteOne({ _id: row._id, status: "expired" });
    } catch { console.error("upload.cleanup.failed", { intentId: String(row._id) }); }
  }
}
