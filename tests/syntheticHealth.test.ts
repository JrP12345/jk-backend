import { describe, it, expect } from "vitest";
import app from "../index.js";
import mongoose from "mongoose";

describe("Synthetic Panic-Alert Canary & Deep Health Probe Suite", () => {
  it("should successfully execute /api/health/synthetic probe", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/health/synthetic",
    });

    expect([200, 503]).toContain(res.statusCode);
    const body = JSON.parse(res.body);

    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("checks");
    expect(body.checks.panicEvaluationEngine.ok).toBe(true);
    expect(body.checks.database.ok).toBe(true);
    expect(body.checks.database.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("should ensure zero residual canary records exist in _canary_probes collection", async () => {
    const db = mongoose.connection.db;
    if (db) {
      const remainingDocs = await db.collection("_canary_probes").countDocuments();
      expect(remainingDocs).toBe(0);
    }
  });
});
