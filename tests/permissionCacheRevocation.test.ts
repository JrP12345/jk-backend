import { describe, it, expect, vi } from "vitest";
import mongoose from "mongoose";

const cache = vi.hoisted(() => new Map<string, string>());
vi.mock("../utilities/redis.ts", () => ({
  redisClient: {
    get: vi.fn(async (key: string) => cache.get(key) ?? null),
    mget: vi.fn(async (...keys: string[]) => keys.map((key) => cache.get(key) ?? null)),
    set: vi.fn(async (key: string, value: string) => { cache.set(key, value); return "OK"; }),
    incr: vi.fn(async (key: string) => { const value = Number(cache.get(key) || 0) + 1; cache.set(key, String(value)); return value; }),
  },
  createRedisSubscriber: () => null,
  publishRedisEvent: vi.fn(async () => 0),
}));

import { Role } from "../models/Role.ts";
import { getEffectivePermissions, invalidateRoleCache } from "../utilities/permissions.ts";

describe("Shared role permission revocation", () => {
  it("does not reload a retained Redis grant after role revocation, even without Pub/Sub delivery", async () => {
    const org = new mongoose.Types.ObjectId().toString();
    const role = await Role.create({ name: "doctor", organizationId: org, permissions: ["VIEW_EHR"] });
    expect(await getEffectivePermissions("doctor", org)).toEqual(new Set(["VIEW_EHR"]));
    const oldKeys = [...cache.keys()].filter((key) => key.startsWith("auth:role:perm:"));
    expect(oldKeys).toHaveLength(1);
    // Bypass model hooks to mimic a second process changing the DB; invalidation
    // updates the shared generation while the previous grant remains in Redis.
    await Role.collection.updateOne({ _id: role._id }, { $set: { permissions: [] } });
    await invalidateRoleCache("doctor", org);
    expect(cache.get(oldKeys[0])).toBe('["VIEW_EHR"]');
    expect((await getEffectivePermissions("doctor", org)).size).toBe(0);
  });
});
