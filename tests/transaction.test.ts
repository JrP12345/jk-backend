import { afterEach, describe, it, expect, vi } from "vitest";
import mongoose from "mongoose";
import { withTransaction } from "../utilities/transaction.ts";

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe("ACID Session Transaction Helper Tests", () => {
  it("should execute operations successfully within withTransaction", async () => {
    const result = await withTransaction(async (session) => {
      return "transaction_success";
    });

    expect(result).toBe("transaction_success");
  });

  it("should throw and handle error thrown inside transaction block", async () => {
    await expect(
      withTransaction(async (session) => {
        throw new Error("Simulated transaction failure");
      })
    ).rejects.toThrow("Simulated transaction failure");
  });

  it("fails closed when production lacks a transaction-capable MongoDB topology", async () => {
    process.env.NODE_ENV = "production";
    vi.spyOn((mongoose.connection as any).client.topology, "description", "get").mockReturnValue({ type: "Single" });
    await expect(withTransaction(async () => "must not run")).rejects.toThrow("Replica Set");
  });
});
