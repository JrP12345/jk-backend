import { describe, it, expect, beforeEach, afterEach } from "vitest";
import mongoose from "mongoose";
import fs from "node:fs/promises";
import path from "node:path";
import { AuditLog } from "../models/AuditLog.ts";
import { archiveAuditLogs } from "../utilities/auditArchiver.ts";

describe("AuditLog Archival & Cold-Storage Offloading", () => {
  const testExportDir = path.join(process.cwd(), "tests", "scratch_archive");

  beforeEach(async () => {
    await AuditLog.deleteMany({});
  });

  afterEach(async () => {
    await fs.rm(testExportDir, { recursive: true, force: true });
  });

  it("returns zero counts when no eligible records are older than cutoff", async () => {
    const userId = new mongoose.Types.ObjectId();
    await AuditLog.create({
      userId,
      action: "RECENT_ACTION",
      createdAt: new Date(),
    });

    const result = await archiveAuditLogs({
      olderThanDays: 30,
      exportDir: testExportDir,
    });

    expect(result.archivedCount).toBe(0);
    expect(result.deletedCount).toBe(0);
    expect(await AuditLog.countDocuments()).toBe(1);
  });

  it("archives older audit logs to NDJSON file and prunes MongoDB collection", async () => {
    const userId = new mongoose.Types.ObjectId();
    const hundredDaysAgo = new Date(Date.now() - 100 * 86400000);
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000);

    // Create 3 old records
    for (let i = 1; i <= 3; i++) {
      await AuditLog.create({
        userId,
        action: `OLD_ACTION_${i}`,
        createdAt: new Date(hundredDaysAgo.getTime() + i * 1000),
      });
    }

    // Create 2 recent records
    for (let i = 1; i <= 2; i++) {
      await AuditLog.create({
        userId,
        action: `RECENT_ACTION_${i}`,
        createdAt: new Date(tenDaysAgo.getTime() + i * 1000),
      });
    }

    expect(await AuditLog.countDocuments()).toBe(5);

    const result = await archiveAuditLogs({
      olderThanDays: 30,
      batchSize: 2, // test multi-batch streaming
      exportDir: testExportDir,
      deleteArchived: true,
    });

    expect(result.archivedCount).toBe(3);
    expect(result.deletedCount).toBe(3);
    expect(result.filePath).toBeDefined();

    // Verify remaining in DB
    const remaining = await AuditLog.find({});
    expect(remaining.length).toBe(2);
    expect(remaining.map((r) => r.action)).toEqual(["RECENT_ACTION_1", "RECENT_ACTION_2"]);

    // Verify NDJSON contents
    const fileContent = await fs.readFile(result.filePath!, "utf8");
    const lines = fileContent.trim().split("\n");
    expect(lines.length).toBe(3);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.map((p) => p.action)).toEqual(["OLD_ACTION_1", "OLD_ACTION_2", "OLD_ACTION_3"]);
  });
});
