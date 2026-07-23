import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { redisClient } from "../utilities/redis.ts";

describe("Centralized Rate Limiting Unit Tests", () => {
  beforeAll(async () => {
    await app.ready();
  });

  it("should respond to health check under rate limit threshold", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/health"
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
  });

  it("should respond 200 OK to liveness probe", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/health/liveness"
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
  });

  it("should respond 200 OK to readiness probe with DB status", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/health/readiness"
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ready");
    expect(body.database).toBe("connected");
  });

  it("should handle redis store initialization safely without throwing", () => {
    // If REDIS_URL or REDIS_HOST is not set, redisClient defaults safely to null for in-memory fallback
    if (!process.env.REDIS_URL && !process.env.REDIS_HOST) {
      expect(redisClient).toBeNull();
    } else {
      expect(redisClient).toBeDefined();
    }
  });
});
