import { describe, it, expect } from "vitest";
import { withTransaction } from "../utilities/transaction.ts";
import { Bed } from "../models/Bed.ts";

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
});
