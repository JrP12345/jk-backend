import mongoose from "mongoose";
import { RefreshToken } from "../models/RefreshToken.ts";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { redisClient, publishRedisEvent, createRedisSubscriber } from "./redis.ts";
import { disconnectUserWebSockets } from "../notifications/websocket.ts";
import { logger } from "./logger.ts";

export interface SessionState {
  sessionId: string;
  userId: string;
  organizationId?: string;
  role: string;
  authVersion: number;
  status: "active" | "revoked";
  revocationReason?: string;
  expiresAt: number; // ms timestamp
}

export interface SessionResolution {
  valid: boolean;
  session?: SessionState;
  reason?: string;
}


// Cluster-wide session revocation listener
const sessionSubClient = createRedisSubscriber();
if (sessionSubClient) {
  sessionSubClient.subscribe("session:events", (err) => {
    if (err) {
      console.warn("[SessionResolver] Failed to subscribe to session:events:", err.message);
    }
  });

  sessionSubClient.on("message", (channel, message) => {
    if (channel === "session:events") {
      try {
        const event = JSON.parse(message);
        if (event.type === "REVOKE_SESSION" && event.sessionId) {
          if (event.userId) {
            disconnectUserWebSockets(event.userId, 4001, "Session revoked across cluster");
          }
        } else if (event.type === "REVOKE_USER" && event.userId) {
          disconnectUserWebSockets(event.userId, 4001, "All user sessions terminated");
        } else if (event.type === "REVOKE_FAMILY" && event.familyId) {
          if (event.userId) {
            disconnectUserWebSockets(event.userId, 4003, `Token family revoked: ${event.reason || "reuse_detected"}`);
          }
        }
      } catch {
        // safe ignore
      }
    }
  });
}

/** Session authority is persisted; cached active snapshots cannot override revocation. */
export async function resolveSession(sessionId: string, expectedAuthVersion?: number): Promise<SessionResolution> {
  if (!mongoose.Types.ObjectId.isValid(sessionId)) return { valid: false, reason: "Malformed session ID" };
  try {
    const [session] = await RefreshToken.aggregate([
      { $match: { _id: new mongoose.Types.ObjectId(sessionId) } },
      { $lookup: { from: User.collection.name, localField: "userId", foreignField: "_id",
        pipeline: [{ $project: { isActive: 1, authVersion: 1, role: 1, twoFactorEnabled: 1 } }], as: "owner" } },
      { $lookup: { from: Organization.collection.name, localField: "organizationId", foreignField: "_id",
        pipeline: [{ $project: { isActive: 1, status: 1 } }], as: "organization" } },
      { $project: { userId: 1, organizationId: 1, isGuest: 1, authVersion: 1, revoked: 1,
        revocationReason: 1, expiresAt: 1, owner: 1, organization: 1 } },
    ]);
    if (!session) return { valid: false, reason: "Session not found" };
    if (session.revoked) return { valid: false, reason: "Session revoked" };
    if (new Date(session.expiresAt).getTime() <= Date.now()) return { valid: false, reason: "Session expired" };
    const owner = session.owner[0];
    if (!owner?.isActive) return { valid: false, reason: "User account deactivated or suspended" };
    if (process.env.NODE_ENV === "production" && owner.role === "root" && !owner.twoFactorEnabled) return { valid: false, reason: "Platform MFA enrollment required" };
    if (session.organizationId && owner.role !== "root" && (!session.organization[0] || session.organization[0].isActive === false || session.organization[0].status === "inactive")) {
      return { valid: false, reason: "Organization is unavailable" };
    }
    const version = owner.authVersion || 1;
    if ((session.authVersion || 1) !== version ||
      (expectedAuthVersion !== undefined && expectedAuthVersion !== version)) {
      return { valid: false, reason: "Session invalidated by role or credential change" };
    }
    return { valid: true, session: { sessionId, userId: String(session.userId),
      organizationId: session.organizationId?.toString(), role: session.isGuest ? "guest" : owner.role,
      authVersion: version, status: "active", expiresAt: new Date(session.expiresAt).getTime() } };
  } catch {
    logger.error("Session resolution failed closed");
    return { valid: false, reason: "Authentication infrastructure unavailable" };
  }
}

export async function revokeOrganizationSessions(organizationId: string, reason: string): Promise<void> {
  const sessions = await RefreshToken.find({ organizationId, revoked: false }).select("userId").lean();
  await RefreshToken.updateMany({ organizationId, revoked: false }, { $set: { revoked: true, revocationReason: reason } });
  for (const userId of new Set(sessions.map(value => String(value.userId)))) {
    disconnectUserWebSockets(userId, 4001, reason);
    await publishRedisEvent("session:events", { type: "REVOKE_USER", userId, reason });
  }
}

/**
 * Revoke an individual session centrally, update DB, and close associated WebSockets.
 */
export async function revokeSession(sessionId: string, reason: string = "logout"): Promise<void> {
  if (!sessionId) return;

  // 1. Update MongoDB RefreshToken
  if (mongoose.Types.ObjectId.isValid(sessionId)) {
    const doc = await RefreshToken.findByIdAndUpdate(
      sessionId,
      { revoked: true, revocationReason: reason },
      { new: true }
    ).lean();

    const userId = doc?.userId?.toString();

    // 2. Update Redis session record to revoked state
    if (redisClient) {
      try {
        const redisKey = `healthos:session:${sessionId}`;
        const existing = await redisClient.get(redisKey);
        if (existing) {
          const parsed = JSON.parse(existing);
          parsed.status = "revoked";
          parsed.revocationReason = reason;
          await redisClient.set(redisKey, JSON.stringify(parsed), "EX", 3600); // 1 hr retention of revoked tombstone
        } else {
          await redisClient.set(
            redisKey,
            JSON.stringify({ sessionId, status: "revoked", revocationReason: reason }),
            "EX",
            3600
          );
        }
      } catch (err: any) {
        console.warn("[SessionResolver Warning] Failed to update Redis revoked state:", err.message);
      }
    }

    // 3. Broadcast cluster-wide revocation event
    await publishRedisEvent("session:events", {
      type: "REVOKE_SESSION",
      sessionId,
      userId,
      reason,
    });

    // 4. Force disconnect local WebSockets
    if (userId) {
      disconnectUserWebSockets(userId, 4001, `Session terminated: ${reason}`);
    }
  }
}

/**
 * Revoke all sessions for a user (password change, role update, user suspension).
 */
export async function revokeUserSessions(userId: string, reason: string = "user_revoked"): Promise<void> {
  if (!userId) return;

  // 2. Mark all user refresh tokens revoked in MongoDB
  if (mongoose.Types.ObjectId.isValid(userId)) {
    await RefreshToken.updateMany(
      { userId: new mongoose.Types.ObjectId(userId), revoked: false },
      { revoked: true, revocationReason: reason }
    );

    // Increment user's authVersion
    await User.updateOne({ _id: userId }, { $inc: { authVersion: 1 } });
  }

  // 3. Broadcast cluster-wide event
  await publishRedisEvent("session:events", {
    type: "REVOKE_USER",
    userId,
    reason,
  });

  // 4. Disconnect associated WebSockets
  disconnectUserWebSockets(userId, 4001, `All sessions revoked: ${reason}`);
}

/**
 * Revoke an entire refresh token family upon suspicious reuse.
 */
export async function revokeTokenFamily(familyId: string, reason: string = "reuse_detected"): Promise<void> {
  if (!familyId) return;

  const tokens = await RefreshToken.find({ familyId }).select("_id userId").lean();
  await RefreshToken.updateMany({ familyId }, { revoked: true, revocationReason: reason });

  const sessionIds = tokens.map((t) => t._id.toString());

  const firstUser = tokens[0]?.userId?.toString();
  if (firstUser) {
    disconnectUserWebSockets(firstUser, 4003, `Token family revoked: ${reason}`);
  }

  // Multi-replica synchronization
  await publishRedisEvent("session:events", {
    type: "REVOKE_FAMILY",
    familyId,
    sessionIds,
    userId: firstUser,
    reason,
  });
}
