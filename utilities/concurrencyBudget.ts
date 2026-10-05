import crypto from "node:crypto";
import { redisClient } from "./redis.ts";
const local = new Map<string, number>();
const leaseMs = 60_000;
const acquire = `redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1]); if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end; redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4]); redis.call('PEXPIRE', KEYS[1], 120000); return 1`;

/** Fail fast instead of holding an unbounded waiting queue. Renew live leases. */
export async function withConcurrencyBudget<T>(scope: string, limit: number, work: () => Promise<T>): Promise<T> {
  const key = `budget:${scope}`;
  const token = crypto.randomUUID();
  const shared = redisClient?.status === "ready";
  if (!shared && process.env.NODE_ENV === "production") throw Object.assign(new Error("Concurrency coordination unavailable"), { statusCode: 503 });
  const count = local.get(key) || 0;
  const admitted = shared ? await redisClient!.eval(acquire, 1, key, Date.now(), Date.now() + leaseMs, Math.max(1, limit), token) : count < limit ? 1 : 0;
  if (!admitted) throw Object.assign(new Error("Operation capacity reached; retry shortly"), { statusCode: 429 });
  if (!shared) local.set(key, count + 1);
  const heartbeat = shared ? setInterval(() => { void redisClient!.eval("if redis.call('ZSCORE', KEYS[1], ARGV[1]) then redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1]); redis.call('PEXPIRE', KEYS[1], 120000); end", 1, key, token, Date.now() + leaseMs).catch(() => console.error("Concurrency lease renewal failed")); }, 15_000) : undefined;
  heartbeat?.unref?.();
  try { return await work(); }
  finally {
    clearInterval(heartbeat);
    if (shared) await redisClient!.zrem(key, token).catch(() => {});
    else { const remaining = (local.get(key) || 1) - 1; if (remaining) local.set(key, remaining); else local.delete(key); }
  }
}
