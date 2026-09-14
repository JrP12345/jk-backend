import { redisClient } from "./redis.ts";

// Per-organization in-memory async lock queue to guarantee serial execution in single-node / test mode
const inMemoryChainLocks = new Map<string, Promise<any>>();

async function withInMemoryQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  while (inMemoryChainLocks.has(key)) {
    try {
      await inMemoryChainLocks.get(key);
    } catch {
      // Ignore errors from previous task
    }
  }

  let release: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  inMemoryChainLocks.set(key, lockPromise);

  try {
    return await operation();
  } finally {
    inMemoryChainLocks.delete(key);
    release!();
  }
}

/**
 * Distributed + In-Memory lock for audit chain serialization.
 * If Redis is connected and ready, acquires a distributed lock (SETNX with TTL).
 * Always wraps the operation in an in-process serialized queue to prevent concurrent
 * hash generation within the same Node.js process as well as across cluster nodes.
 */
export async function withChainLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const isRedisReady = redisClient && redisClient.status === "ready";
  const lockKey = `lock:audit_chain:${key}`;
  const lockToken = `tok_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  const LOCK_TTL_SECONDS = 10;

  if (isRedisReady && redisClient) {
    let acquired = false;
    const maxWaitMs = 6000;
    const startTime = Date.now();

    while (!acquired && Date.now() - startTime < maxWaitMs) {
      try {
        const res = await redisClient.set(lockKey, lockToken, "EX", LOCK_TTL_SECONDS, "NX");
        if (res === "OK") {
          acquired = true;
          break;
        }
      } catch {
        // Fall back to in-memory locking if Redis fails unexpectedly
        break;
      }
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
    }

    if (acquired) {
      try {
        return await withInMemoryQueue(key, operation);
      } finally {
        const unlockScript = `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
          else
            return 0
          end
        `;
        try {
          await redisClient?.eval(unlockScript, 1, lockKey, lockToken);
        } catch {
          // Ignore release errors
        }
      }
    }
  }

  // Fallback to in-memory serialized queue
  return withInMemoryQueue(key, operation);
}
