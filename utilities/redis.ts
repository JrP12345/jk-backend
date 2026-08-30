import { Redis } from "ioredis";

/**
 * Redis client initialization with graceful fallback.
 * If REDIS_URL or REDIS_HOST is configured, returns an ioredis client.
 * Otherwise returns null to let plugins fall back to in-memory storage safely.
 */
function createRedisClient(): Redis | null {
  const redisUrl = process.env.REDIS_URL;
  const redisHost = process.env.REDIS_HOST;

  // In production, if REDIS_URL contains localhost, treat as unset unless explicit
  const isLocalInProd = process.env.NODE_ENV === "production" && (redisUrl?.includes("localhost") || redisUrl?.includes("127.0.0.1"));

  if ((!redisUrl && !redisHost) || isLocalInProd) {
    console.log("[Redis] No valid remote REDIS_URL or REDIS_HOST set. Using in-memory fallback store.");
    return null;
  }

  try {
    const client = redisUrl
      ? new Redis(redisUrl, {
          maxRetriesPerRequest: 1,
          enableOfflineQueue: true,
          retryStrategy: (times: number) => Math.min(times * 100, 2000),
        })
      : new Redis({
          host: redisHost,
          port: parseInt(process.env.REDIS_PORT || "6379", 10),
          password: process.env.REDIS_PASSWORD || undefined,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: true,
          retryStrategy: (times: number) => Math.min(times * 100, 2000),
        });

    client.on("error", (err: Error) => {
      console.warn("[Redis Warning] Connection error:", err.message);
    });

    client.on("connect", () => {
      console.log("[Redis] Connected successfully to centralized Redis backing store.");
    });

    return client;
  } catch (err: any) {
    console.warn("[Redis Error] Failed to initialize Redis client:", err.message);
    return null;
  }
}

export const redisClient = createRedisClient();
