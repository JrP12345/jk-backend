import mongoose from "mongoose";
import { RefreshToken } from "../models/RefreshToken.ts";
import { User } from "../models/User.ts";
import { redisClient, publishRedisEvent, createRedisSubscriber } from "./redis.ts";
import { disconnectUserWebSockets } from "../notifications/websocket.ts";
import { revokeSessionFamily } from "./replicaCoordination.ts";
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

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days (matches refresh token lifespan)
const localSessionMemoryCache = new Map<string, { state: SessionState; cachedAt: number }>();
const LOCAL_CACHE_TTL_MS = process.env.NODE_ENV === "test" ? 0 : 30 * 1000; // 30s local cache

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
          localSessionMemoryCache.delete(event.sessionId);
          if (event.userId) {
            disconnectUserWebSockets(event.userId, 4001, "Session revoked across cluster");
          }
        } else if (event.type === "REVOKE_USER" && event.userId) {
          for (const [sid, item] of localSessionMemoryCache.entries()) {
            if (item.state.userId === event.userId) {
              localSessionMemoryCache.delete(sid);
            }
          }
          disconnectUserWebSockets(event.userId, 4001, "All user sessions terminated");
        } else if (event.type === "REVOKE_FAMILY" && event.familyId) {
          if (Array.isArray(event.sessionIds)) {
            for (const sid of event.sessionIds) {
              localSessionMemoryCache.delete(sid);
            }
          }
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

/**
 * Centrally registers an active session state into Redis and local cache.
 */
export async function registerSession(state: SessionState): Promise<void> {
  localSessionMemoryCache.set(state.sessionId, { state, cachedAt: Date.now() });

  if (redisClient) {
    try {
      const redisKey = `healthos:session:${state.sessionId}`;
      await redisClient.set(
        redisKey,
        JSON.stringify(state),
        "EX",
        SESSION_TTL_SECONDS
      );
    } catch (err: any) {
      console.warn("[SessionResolver Warning] Failed to write session to Redis:", err.message);
    }
  }
}

/**
 * Resolves session validity centrally across HTTP requests and WebSockets.
 * Fails closed if session is revoked, displaced, or authVersion is mismatched.
 */
export async function resolveSession(
  sessionId: string,
  expectedAuthVersion?: number
): Promise<SessionResolution> {
  if (!sessionId) {
    return { valid: false, reason: "Missing session ID" };
  }

  const now = Date.now();
  const cached = localSessionMemoryCache.get(sessionId);
  if (cached && (now - cached.cachedAt) < LOCAL_CACHE_TTL_MS) {
    const s = cached.state;
    if (s.status === "revoked") {
      return { valid: false, reason: s.revocationReason || "Session revoked" };
    }
    if (s.expiresAt < now) {
      return { valid: false, reason: "Session expired" };
    }
    if (expectedAuthVersion !== undefined && s.authVersion < expectedAuthVersion) {
      return { valid: false, reason: "Session displaced by newer authorization credentials" };
    }
    return { valid: true, session: s };
  }

  // Check Redis central session store
  if (redisClient) {
    try {
      const raw = await redisClient.get(`healthos:session:${sessionId}`);
      if (raw) {
        const s: SessionState = JSON.parse(raw);
        localSessionMemoryCache.set(sessionId, { state: s, cachedAt: now });

        if (s.status === "revoked") {
          return { valid: false, reason: s.revocationReason || "Session revoked" };
        }
        if (s.expiresAt < now) {
          return { valid: false, reason: "Session expired" };
        }
        if (expectedAuthVersion !== undefined && s.authVersion < expectedAuthVersion) {
          return { valid: false, reason: "Session displaced by newer authorization credentials" };
        }
        return { valid: true, session: s };
      }
    } catch (redisErr: any) {
      console.warn("[SessionResolver Warning] Redis lookup failed, entering degraded mode:", redisErr.message);
    }
  }

  // Degraded Mode: Query authoritative MongoDB backing store
  try {
    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      return { valid: false, reason: "Malformed session ID" };
    }

    const sessionDoc = await RefreshToken.findById(sessionId).lean();
    if (!sessionDoc) {
      return { valid: false, reason: "Session not found" };
    }

    if (sessionDoc.revoked) {
      return { valid: false, reason: `Session revoked: ${sessionDoc.revocationReason || "revoked"}` };
    }

    if (new Date(sessionDoc.expiresAt).getTime() < now) {
      return { valid: false, reason: "Session expired" };
    }

    // Verify user authorization version
    const userDoc = await User.findById(sessionDoc.userId).select("isActive authVersion role").lean();
    if (!userDoc || !userDoc.isActive) {
      return { valid: false, reason: "User account deactivated or suspended" };
    }

    const currentAuthVersion = (userDoc as any).authVersion || 1;
    if (sessionDoc.authVersion && sessionDoc.authVersion < currentAuthVersion) {
      return { valid: false, reason: "Session invalidated by role or credential change" };
    }

    const state: SessionState = {
      sessionId,
      userId: sessionDoc.userId.toString(),
      organizationId: sessionDoc.organizationId?.toString(),
      role: sessionDoc.isGuest ? "guest" : (userDoc as any).role || "patient",
      authVersion: currentAuthVersion,
      status: "active",
      expiresAt: new Date(sessionDoc.expiresAt).getTime(),
    };

    // Populate Redis & memory cache for subsequent checks
    await registerSession(state);
    return { valid: true, session: state };
  } catch (err: any) {
    // Fail-Closed for high-risk operations
    logger.error("Session resolution failed closed", { errMessage: err.message } as any);
    return { valid: false, reason: "Authentication infrastructure unavailable (fail-closed)" };
  }
}

/**
 * Revoke an individual session centrally, update DB, and close associated WebSockets.
 */
export async function revokeSession(sessionId: string, reason: string = "logout"): Promise<void> {
  if (!sessionId) return;

  localSessionMemoryCache.delete(sessionId);

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

  // 1. Evict local memory
  for (const [sid, item] of localSessionMemoryCache.entries()) {
    if (item.state.userId === userId) {
      localSessionMemoryCache.delete(sid);
    }
  }

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
  sessionIds.forEach((sid) => {
    localSessionMemoryCache.delete(sid);
  });

  const firstUser = tokens[0]?.userId?.toString();
  if (firstUser) {
    disconnectUserWebSockets(firstUser, 4003, `Token family revoked: ${reason}`);
  }

  // Multi-replica synchronization
  await revokeSessionFamily(familyId);
  await publishRedisEvent("session:events", {
    type: "REVOKE_FAMILY",
    familyId,
    sessionIds,
    userId: firstUser,
    reason,
  });
}
