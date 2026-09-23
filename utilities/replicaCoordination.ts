/**
 * Multi-Replica Coordination — Step 6.2
 *
 * Uses Redis Pub/Sub to broadcast correctness-critical events across all API
 * replicas. Ensures session revocations, permission invalidations, and
 * WebSocket messages propagate to every node in a horizontally-scaled cluster.
 *
 * When Redis is unavailable (local dev, single-node), all operations degrade
 * to local-only with a logged warning — never crash.
 */

import { redisClient, createRedisSubscriber, publishRedisEvent } from "./redis.ts";
import {
  SESSION_REVOKE_CHANNEL,
  PERMISSION_INVALIDATE_CHANNEL,
} from "./scalability.ts";

// ─── In-Process Caches (invalidated via pub/sub) ─────────────────────────────

/**
 * Local permission cache. In a single-process deployment this is the canonical
 * store. In a multi-replica deployment, a pub/sub message from any replica
 * invalidates this cache across all nodes.
 */
const localPermissionCache = new Map<string, { permissions: string[]; expiresAt: number }>();
const PERMISSION_CACHE_TTL_MS = 60_000; // 1 minute

export function getCachedPermissions(userId: string): string[] | null {
  const entry = localPermissionCache.get(userId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    localPermissionCache.delete(userId);
    return null;
  }
  return entry.permissions;
}

export function setCachedPermissions(userId: string, permissions: string[]): void {
  localPermissionCache.set(userId, {
    permissions,
    expiresAt: Date.now() + PERMISSION_CACHE_TTL_MS,
  });
}

export function invalidateLocalPermissionCache(userId: string): void {
  localPermissionCache.delete(userId);
}

// ─── Session Revocation Broadcast ────────────────────────────────────────────

/**
 * Local set of revoked session family IDs. When a user logs out or a session
 * is revoked, we add the familyId here AND broadcast via Redis so all replicas
 * reject the JWT before the DB round-trip.
 */
const localRevokedFamilies = new Map<string, number>();
const REVOKED_FAMILY_TTL_MS = 15 * 60_000; // 15 minutes (covers JWT max lifetime)

export function isSessionFamilyRevoked(familyId: string): boolean {
  const expiresAt = localRevokedFamilies.get(familyId);
  if (expiresAt === undefined) return false;
  if (Date.now() > expiresAt) {
    localRevokedFamilies.delete(familyId);
    return false;
  }
  return true;
}

/**
 * Revoke a session family locally and broadcast to all replicas.
 * Used on logout, session termination, and refresh-token reuse detection.
 */
export async function revokeSessionFamily(familyId: string): Promise<void> {
  localRevokedFamilies.set(familyId, Date.now() + REVOKED_FAMILY_TTL_MS);
  await publishRedisEvent(SESSION_REVOKE_CHANNEL, { familyId, timestamp: Date.now() });
}

/**
 * Invalidate a user's permission cache locally and broadcast to all replicas.
 * Used when roles or permissions are changed.
 */
export async function broadcastPermissionInvalidation(userId: string): Promise<void> {
  invalidateLocalPermissionCache(userId);
  await publishRedisEvent(PERMISSION_INVALIDATE_CHANNEL, { userId, timestamp: Date.now() });
}

// ─── Redis Pub/Sub Subscriber ────────────────────────────────────────────────

let subscriberInitialized = false;

/**
 * Initializes the Redis subscriber for cross-replica coordination.
 * Call this once during API startup. Safe to call when Redis is unavailable.
 */
export function initReplicaCoordination(): void {
  if (subscriberInitialized) return;
  subscriberInitialized = true;

  const subscriber = createRedisSubscriber();
  if (!subscriber) {
    console.log("[ReplicaCoordination] Redis unavailable — operating in single-node mode. Session revocation and permission invalidation are local-only.");
    return;
  }

  subscriber.subscribe(SESSION_REVOKE_CHANNEL, PERMISSION_INVALIDATE_CHANNEL).catch((err: Error) => {
    console.warn("[ReplicaCoordination] Failed to subscribe to coordination channels:", err.message);
  });

  subscriber.on("message", (channel: string, message: string) => {
    try {
      const data = JSON.parse(message);

      if (channel === SESSION_REVOKE_CHANNEL && data.familyId) {
        localRevokedFamilies.set(data.familyId, Date.now() + REVOKED_FAMILY_TTL_MS);
      }

      if (channel === PERMISSION_INVALIDATE_CHANNEL && data.userId) {
        invalidateLocalPermissionCache(data.userId);
      }
    } catch {
      // Malformed message — ignore silently
    }
  });

  // Periodic GC for expired entries (every 5 minutes)
  setInterval(() => {
    const now = Date.now();
    for (const [key, expiresAt] of localRevokedFamilies) {
      if (now > expiresAt) localRevokedFamilies.delete(key);
    }
    for (const [key, entry] of localPermissionCache) {
      if (now > entry.expiresAt) localPermissionCache.delete(key);
    }
  }, 5 * 60_000).unref();

  console.log("[ReplicaCoordination] Redis pub/sub subscriber initialized for session revocation and permission invalidation.");
}

// ─── Leader Election Safety ──────────────────────────────────────────────────

/**
 * Wraps a scheduled job so it only runs if the current process holds the
 * distributed lease. If the lease cannot be acquired (Redis down, another leader
 * exists), the function does NOT fall back to competing local work — it simply
 * skips the iteration and logs the skip.
 *
 * This prevents split-brain where multiple replicas run the same scheduled job
 * concurrently.
 */
export function withLeaderGuard(
  jobName: string,
  isLeader: () => boolean,
  fn: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    if (!isLeader()) {
      // Intentionally silent in non-leader replicas to avoid log noise.
      // The leader reconciliation loop already logs acquisition/loss.
      return;
    }
    try {
      await fn();
    } catch (error) {
      console.error(`[LeaderGuard] Error in leader-only job '${jobName}':`, error);
    }
  };
}
