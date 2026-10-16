import { User } from "../models/User.ts";
import { RefreshToken } from "../models/RefreshToken.ts";
import { PendingTwoFactorSetup } from "../models/PendingTwoFactorSetup.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { withTransaction } from "../utilities/transaction.ts";
import { CommandError } from "./CommandReceiptService.ts";
import { publishRedisEvent } from "../utilities/redis.ts";
import { disconnectUserWebSockets } from "../notifications/websocket.ts";

/** Operator-only recovery. Identity review is an operational prerequisite.
 * Reset requires enrollment again and never issues a session or disables policy.
 */
export async function recoverStaffMfa(userId: string, reviewedBy: string, expectedAuthVersion: number) {
  const result = await withTransaction(async () => {
    const operator = await User.exists({ _id: reviewedBy, role: "root", isActive: true, twoFactorEnabled: true });
    if (!operator || userId === reviewedBy) throw new CommandError(403, "An independent active platform root reviewer is required");
    const user = await User.findOneAndUpdate({ _id: userId, role: { $nin: ["root", "patient", "family_member", "guest"] }, authVersion: expectedAuthVersion, isActive: true },
      { $set: { twoFactorEnabled: false, twoFactorEnrollmentRequired: true }, $unset: { twoFactorSecret: 1 }, $inc: { authVersion: 1 } }, { returnDocument: "after" }).select("_id");
    if (!user) throw new CommandError(409, "Staff identity changed or is unavailable; review again");
    await RefreshToken.updateMany({ userId, revoked: false }, { $set: { revoked: true, revocationReason: "terminated" } });
    await PendingTwoFactorSetup.deleteMany({ userId });
    await AuditLog.create({ userId: reviewedBy, targetId: user._id, targetModel: "User", category: "ADMIN", action: "STAFF_MFA_RECOVERY", details: { identityReviewCompleted: true } });
    return { recovered: true, enrollmentRequired: true };
  });
  disconnectUserWebSockets(userId, 4001, "MFA recovery requires a new login");
  await publishRedisEvent("session:events", { type: "REVOKE_USER", userId, reason: "mfa_recovery" });
  return result;
}
