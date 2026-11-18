import crypto from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mongoose from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCdciImport, cdciReviewDraft } from "../scripts/import-pharmacy-cdci.ts";
import { readCdciPackage, inspectCdciPackage } from "../utilities/pharmacyCdci.ts";
import { PharmacyGlobalProduct } from "../models/PharmacyGlobalProduct.ts";
import { Medicine } from "../models/Medicine.ts";
import { User } from "../models/User.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { syntheticCdciFiles, syntheticCdciZip } from "./helpers/pharmacyCdciFixture.ts";

afterEach(() => vi.restoreAllMocks());

async function fixture(count = 1, withRejected = false) {
  const directory = await mkdtemp(join(tmpdir(), "ekavyu-cdci-activation-")), file = join(directory, "synthetic.zip"), rights = join(directory, "synthetic-rights.json");
  const header = syntheticCdciFiles["BrandMaster.txt"].split("\n")[0];
  const brands = Array.from({ length: count }, (_, i) => `${700000 + i}\tSynthetic activation ${i} 10 mg tablet\t300\t400\t200\t\tUNKNOWN\t\t20260819\t`);
  if (withRejected) brands.push("999999\tSynthetic rejected record\t999\t400\t200\t\tUNKNOWN\t\t20260819\t");
  const bytes = syntheticCdciZip({ "BrandMaster.txt": [header, ...brands, ""].join("\n") });
  await writeFile(file, bytes);
  const report = inspectCdciPackage(readCdciPackage(bytes));
  await writeFile(rights, JSON.stringify({ ...cdciReviewDraft(report), reviewReference: "SYNTHETIC approval for disposable test data only", snomedAffiliateReference: "SYNTHETIC fixture only", indiaDeploymentAndUsersConfirmed: true, commercialStorageAndRedistributionApproved: true }));
  const root = await User.create({ name: "Synthetic activation operator", email: `${crypto.randomUUID()}@example.test`, role: "root" });
  const uri = process.env.MONGODB_URI!;
  const run = async (flags: string[]) => {
    // Exercise the command's actual connect/check/disconnect lifecycle against only the test replica set.
    await mongoose.disconnect();
    try { return await runCdciImport([file, `--actor=${root.id}`, ...flags]); }
    finally { await mongoose.connect(uri); }
  };
  return { directory, file, rights, root, run, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

describe("CDCI activation command on a disposable transaction-capable database", () => {
  it("reports pending rights and then ready evidence without changing products, audit or the operator", async () => {
    const f = await fixture(); vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const before = { products: await PharmacyGlobalProduct.countDocuments(), audit: await AuditLog.countDocuments(), root: (await User.findById(f.root.id).lean())!.__v };
      expect(await f.run(["--check"])).toMatchObject({ mode: "check", ready: false, rightsReady: false, databaseChanged: false, transactionCapable: true, actorReady: true, indexes: { ready: true } });
      expect(await f.run(["--check", `--review=${f.rights}`])).toMatchObject({ ready: true, rightsReady: true, databaseChanged: false });
      expect({ products: await PharmacyGlobalProduct.countDocuments(), audit: await AuditLog.countDocuments(), root: (await User.findById(f.root.id).lean())!.__v }).toEqual(before);
    } finally { await f.cleanup(); }
  });
  it("reports missing indexes without creating them and refuses apply before any product is written", async () => {
    const f = await fixture(); vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await PharmacyGlobalProduct.collection.dropIndex("pharmacy_global_search");
      const before = await PharmacyGlobalProduct.countDocuments();
      expect(await f.run(["--check", `--review=${f.rights}`])).toMatchObject({ ready: false, indexes: { ready: false, issues: expect.arrayContaining([expect.objectContaining({ index: "pharmacy_global_search", kind: "missing_index" })]) } });
      await expect(f.run(["--apply", "--release=SYNTHETIC", `--review=${f.rights}`])).rejects.toThrow(/Prepare catalogue/);
      expect((await PharmacyGlobalProduct.collection.listIndexes().toArray()).some(index => index.name === "pharmacy_global_search")).toBe(false);
      expect(await PharmacyGlobalProduct.countDocuments()).toBe(before);
    } finally { await PharmacyGlobalProduct.createIndexes(); await f.cleanup(); }
  });
  it("rejects an inactive root account before ingestion", async () => {
    const f = await fixture(); vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await User.updateOne({ _id: f.root.id }, { $set: { isActive: false } });
      expect(await f.run(["--check", `--review=${f.rights}`])).toMatchObject({ ready: false, actorReady: false });
      await expect(f.run(["--apply", "--release=SYNTHETIC", `--review=${f.rights}`])).rejects.toThrow(/active root/);
    } finally { await f.cleanup(); }
  });
  it("refuses a database without transaction support before any catalogue writes", async () => {
    const f = await fixture(); vi.spyOn(console, "log").mockImplementation(() => {});
    // Only the explicit hello probe is altered; actual query/index reads still use the test database.
    const realCommand = mongoose.mongo.Admin.prototype.command;
    const probe = vi.spyOn(mongoose.mongo.Admin.prototype, "command");
    probe.mockImplementation(function (this: mongoose.mongo.Admin, ...args: Parameters<typeof realCommand>) {
      if (args[0].hello === 1) return Promise.resolve({ ok: 1, isWritablePrimary: true });
      return realCommand.apply(this, args);
    });
    try {
      const before = await PharmacyGlobalProduct.countDocuments();
      expect(await f.run(["--check", `--review=${f.rights}`])).toMatchObject({ ready: false, transactionCapable: false });
      await expect(f.run(["--apply", "--release=SYNTHETIC", `--review=${f.rights}`])).rejects.toThrow(/transaction-capable/);
      expect(await PharmacyGlobalProduct.countDocuments()).toBe(before);
    } finally { probe.mockRestore(); await f.cleanup(); }
  });
  it("resumes committed batches after interruption, excludes reviewed bad rows and leaves branch stock/prices untouched", async () => {
    const f = await fixture(201, true); vi.spyOn(console, "log").mockImplementation(() => {});
    const branchId = new mongoose.Types.ObjectId();
    // A branch sentinel verifies that reference publication never rewrites owned records.
    await Medicine.collection.insertOne({ _id: branchId, name: "Synthetic existing branch product", price: 19, stockQuantity: 23, locationId: new mongoose.Types.ObjectId() });
    const sentinel = await Medicine.collection.findOne({ _id: branchId });
    const original = PharmacyGlobalProduct.bulkWrite.bind(PharmacyGlobalProduct);
    const write = vi.spyOn(PharmacyGlobalProduct, "bulkWrite");
    write.mockImplementationOnce((...args: Parameters<typeof PharmacyGlobalProduct.bulkWrite>) => original(...args));
    write.mockRejectedValueOnce(new Error("SYNTHETIC interrupted second batch"));
    const flags = ["--apply", "--release=SYNTHETIC-ACTIVATION", `--review=${f.rights}`];
    try {
      await expect(f.run(flags)).rejects.toThrow(/interrupted second batch/);
      expect(await PharmacyGlobalProduct.countDocuments({ provider: "cdci", sourceId: { $gte: "700000", $lte: "700200" } })).toBe(200);
      write.mockRestore();
      expect(await f.run(flags)).toEqual({ created: 1, updated: 0, unchanged: 200, excluded: 1 });
      expect(await f.run(flags)).toEqual({ created: 0, updated: 0, unchanged: 201, excluded: 1 });
      expect(await PharmacyGlobalProduct.countDocuments({ provider: "cdci", sourceId: "999999" })).toBe(0);
      expect(await PharmacyGlobalProduct.countDocuments({ provider: "cdci", sourceId: { $gte: "700000", $lte: "700200" }, revision: 1 })).toBe(201);
      expect(await Medicine.collection.findOne({ _id: branchId })).toEqual(sentinel);
      expect(await AuditLog.countDocuments({ action: "PHARMACY_GLOBAL_CATALOGUE_IMPORTED", "details.release": "SYNTHETIC-ACTIVATION" })).toBe(5);
    } finally { await f.cleanup(); }
  });
});
