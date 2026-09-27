import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRedisConfiguration } from "../utilities/redisConfiguration.ts";
import { validateConfig } from "../utilities/config.ts";
import { checkRedisReadiness } from "../utilities/readiness.ts";

const backingStore = vi.hoisted(() => ({
  client: null as { status: string; ping: () => Promise<string> } | null,
}));
vi.mock("../utilities/redis.ts", () => ({
  get redisClient() { return backingStore.client; },
}));

describe("Production Redis configuration and readiness", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv, NODE_ENV: "production" };
    delete process.env.REDIS_URL;
    delete process.env.REDIS_HOST;
    delete process.env.ALLOW_SINGLE_NODE_IN_PRODUCTION;
    backingStore.client = null;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it.each([
    ["REDIS_URL", "redis://localhost:6379"],
    ["REDIS_URL", "redis://127.0.0.1:6379"],
    ["REDIS_URL", "redis://[::1]:6379"],
    ["REDIS_HOST", "localhost"],
  ])("rejects the development placeholder %s=%s before startup", (key, value) => {
    process.env[key] = value;
    expect(getRedisConfiguration().error).toContain("remote hostname");
    expect(validateConfig().errors.join(" ")).toContain("Production Redis must use a remote hostname");
  });

  it("requires a Redis service when no explicit single-instance override exists", async () => {
    expect(validateConfig().errors.join(" ")).toContain("REDIS_URL or REDIS_HOST is not configured");
    expect(await checkRedisReadiness()).toMatchObject({ ready: false, required: true, status: "not_configured" });
  });

  it("permits missing Redis only with the explicit single-instance override", async () => {
    process.env.ALLOW_SINGLE_NODE_IN_PRODUCTION = "true";
    expect(validateConfig().errors.filter(error => /Redis|REDIS/.test(error))).toEqual([]);
    expect(await checkRedisReadiness()).toMatchObject({ ready: true, required: false, status: "single_node_override" });
  });

  it("checks the hostname rather than matching localhost in credentials", () => {
    process.env.REDIS_URL = "rediss://user:localhost-test-secret@redis.example.test:6379";
    expect(getRedisConfiguration().error).toBeUndefined();
    expect(validateConfig().errors.filter(error => /Redis|REDIS/.test(error))).toEqual([]);
  });

  it("rejects malformed connection URLs without disclosing credentials", () => {
    process.env.REDIS_URL = "https://user:test-secret@redis.example.test";
    const errors = validateConfig().errors.join(" ");
    expect(errors).toContain("redis:// or rediss://");
    expect(errors).not.toContain("test-secret");
    expect(errors).not.toContain("redis.example.test");
  });

  it("retains local Redis and the in-memory fallback for development", async () => {
    process.env.NODE_ENV = "development";
    process.env.REDIS_URL = "redis://localhost:6379";
    expect(getRedisConfiguration().error).toBeUndefined();
    delete process.env.REDIS_URL;
    expect(await checkRedisReadiness()).toMatchObject({ ready: true, required: false });
  });

  it("keeps production unhealthy when a configured Redis service cannot answer", async () => {
    process.env.REDIS_URL = "redis://redis.example.test:6379";
    backingStore.client = { status: "ready", ping: async () => { throw new Error("Connection refused"); } };
    expect(await checkRedisReadiness()).toMatchObject({ ready: false, required: true, status: "unreachable" });
  });

  it("marks the required Redis service ready after a successful ping", async () => {
    process.env.REDIS_HOST = "redis.example.test";
    backingStore.client = { status: "ready", ping: async () => "PONG" };
    expect(await checkRedisReadiness()).toMatchObject({ ready: true, required: true, status: "ready" });
  });
});
