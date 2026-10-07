import { describe, expect, it } from "vitest";
import { resetDevelopmentData } from "../scripts/reset-development-data.ts";
import { assertDevelopmentDatabaseEmpty, developmentDatabaseName } from "../scripts/developmentDatabase.ts";
import type { Connection } from "mongoose";

describe("Development schema reset boundaries", () => {
  it("refuses production and unspecified environments before connecting", async () => {
    for (const environment of ["production", "test", undefined]) {
      await expect(resetDevelopmentData("mongodb://localhost/ekavyu_dev", [], environment)).rejects.toThrow("NODE_ENV=development");
    }
  });
  it("refuses remote hosts and unconfirmed database targets before connecting", async () => {
    for (const uri of ["mongodb://db.example/ekavyu_dev", "mongodb+srv://db.example/ekavyu_dev"]) {
      await expect(resetDevelopmentData(uri, [], "development")).rejects.toThrow("local MongoDB");
    }
    await expect(resetDevelopmentData("mongodb://localhost/patients", [], "development")).rejects.toThrow("explicitly named");
    await expect(resetDevelopmentData("mongodb://localhost/ekavyu_dev", ["--confirm-database=ekavyu_test"], "development")).rejects.toThrow("exact development database");
  });
  it("accepts only the exact confirmed local development target", () => {
    expect(developmentDatabaseName("mongodb://127.0.0.1/ekavyu_dev", ["--confirm-database=ekavyu_dev"], "development")).toBe("ekavyu_dev");
  });
  it("refuses to seed any nonempty collection", async () => {
    const connection = { db: { listCollections: () => ({ toArray: async () => [{ name: "patients" }] }), collection: () => ({ findOne: async () => ({ _id: "existing" }) }) } } as unknown as Connection;
    await expect(assertDevelopmentDatabaseEmpty(connection)).rejects.toThrow("empty development database");
  });
});
