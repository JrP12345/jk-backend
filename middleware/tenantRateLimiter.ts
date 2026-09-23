/**
 * Tenant-Level Rate Limiter Middleware — Step 6.4
 *
 * Enforces per-tenant resource budgets across horizontally-scaled API replicas.
 * Uses Redis INCR with TTL when Redis is available, or an in-memory sliding
 * window when running single-node / offline.
 *
 * Prevents noisy-neighbor starvation where one runaway tenant exhausts API capacity.
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import { redisClient } from "../utilities/redis.ts";
import { TENANT_RATE_LIMIT_PER_MINUTE } from "../utilities/scalability.ts";

interface LocalTenantBucket {
  count: number;
  resetAt: number;
}

const localTenantBuckets = new Map<string, LocalTenantBucket>();
const WINDOW_MS = 60_000;

// Periodic cleanup of expired local in-memory buckets
setInterval(() => {
  const now = Date.now();
  for (const [orgId, bucket] of localTenantBuckets) {
    if (now > bucket.resetAt) {
      localTenantBuckets.delete(orgId);
    }
  }
}, WINDOW_MS).unref?.();

/**
 * Fastify preHandler hook for tenant-scoped rate limiting.
 */
export async function tenantRateLimiter(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Only apply to authenticated tenant requests (anonymous/public routes use IP-based rate limiting)
  const orgId = req.user?.organization_id;
  if (!orgId) return;

  const limit = TENANT_RATE_LIMIT_PER_MINUTE;
  const now = Date.now();

  let currentCount: number;
  let resetSeconds: number;

  if (redisClient) {
    try {
      const key = `ratelimit:tenant:${orgId}`;
      const count = await redisClient.incr(key);
      if (count === 1) {
        await redisClient.expire(key, 60);
      }
      const ttl = await redisClient.ttl(key);
      currentCount = count;
      resetSeconds = Math.max(1, ttl);
    } catch {
      // Degrade gracefully to local in-memory bucket on Redis error
      currentCount = checkLocalBucket(orgId, now);
      resetSeconds = 60;
    }
  } else {
    currentCount = checkLocalBucket(orgId, now);
    resetSeconds = 60;
  }

  reply.header("X-Tenant-RateLimit-Limit", limit);
  reply.header("X-Tenant-RateLimit-Remaining", Math.max(0, limit - currentCount));

  if (currentCount > limit) {
    reply.header("Retry-After", resetSeconds);
    reply.code(429).send({
      statusCode: 429,
      error: "Too Many Requests",
      message: `Tenant rate limit of ${limit} requests per minute exceeded. Please throttle requests.`,
      retryAfterSeconds: resetSeconds,
    });
  }
}

function checkLocalBucket(orgId: string, now: number): number {
  let bucket = localTenantBuckets.get(orgId);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 1, resetAt: now + WINDOW_MS };
    localTenantBuckets.set(orgId, bucket);
    return 1;
  }
  bucket.count++;
  return bucket.count;
}
