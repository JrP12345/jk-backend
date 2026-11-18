import mongoose from "mongoose";
import { afterEach, expect, it, vi } from "vitest";
import { connectDB } from "../db.ts";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each(["production", "development", "test"])("uses deliberate collection/index setup in %s", async environment => {
  vi.stubEnv("NODE_ENV", environment);
  const connect = vi.spyOn(mongoose, "connect").mockResolvedValue(mongoose);
  vi.spyOn(mongoose.connection, "getClient").mockReturnValue({ on: vi.fn() } as any);
  await connectDB();
  expect(connect).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ autoIndex: environment !== "production", autoCreate: environment !== "production", waitQueueTimeoutMS: 5000 }));
});
