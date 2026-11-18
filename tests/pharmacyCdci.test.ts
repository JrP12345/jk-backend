import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mongoose from "mongoose";
import { readCdciPackage, mapCdciBrand, inspectCdciPackage, CDCI_MAPPING_VERSION, CDCI_LIMITS } from "../utilities/pharmacyCdci.ts";
import { cdciApproval, cdciReviewDraft, runCdciImport } from "../scripts/import-pharmacy-cdci.ts";
import { syntheticCdciFiles, syntheticCdciZip } from "./helpers/pharmacyCdciFixture.ts";

afterEach(() => vi.restoreAllMocks());
describe("CDCI exact source mapping and read-only review", () => {
  it("joins all seven tables by IDs, preserves provenance and makes no pack, manufacturer or stock assumptions", () => {
    const data = readCdciPackage(syntheticCdciZip()), brand = data.tables["BrandMaster.txt"].get("000700")!;
    expect(data.tables["BrandMaster.txt"].size).toBe(1);
    const mapped = mapCdciBrand(data, brand);
    expect(mapped).toMatchObject({ sourceId: "000700", name: "Synthetic Brand 10 mg tablet", composition: "Synthetic salt A + Synthetic salt B", supplierName: "Synthetic supplier", dosageForm: "Synthetic oral tablet", sourceUpdatedOn: "20260819", manufacturer: "", strength: "", packSize: "", barcodes: [],
      sourceIds: { product: "300", generic: "200", supplier: "400", substances: ["100", "101"], dosageForms: ["500"], routes: ["600"] } });
    for (const field of ["stockQuantity", "price", "costPrice", "unitsPerPack", "scheduleType", "batchNumber", "expiry"]) expect(mapped).not.toHaveProperty(field);
    const report = inspectCdciPackage(data);
    expect(report).toMatchObject({ importable: 1, rejected: 0, newestRecordDate: "20260819", mappingVersion: CDCI_MAPPING_VERSION, databaseChanged: false });
    expect(report.packageSha256).toMatch(/^[a-f\d]{64}$/); expect(Object.keys(report.fileHashes)).toHaveLength(7);
  });
  it("accepts source trailing empty tabs/omitted trailing fields without shifting values", () => {
    const raw = syntheticCdciFiles["BrandMaster.txt"].replace("\t20260819\t", "");
    const data = readCdciPackage(syntheticCdciZip({ "BrandMaster.txt": raw }));
    const mapped = mapCdciBrand(data, data.tables["BrandMaster.txt"].get("000700")!);
    expect(mapped.sourceUpdatedOn).toBe(""); expect(mapped.sourceIds.generic).toBe("200");
  });
  it("rejects changed headers, duplicate IDs and extra nonempty fields instead of guessing a mapping", () => {
    expect(() => readCdciPackage(syntheticCdciZip({ "BrandMaster.txt": syntheticCdciFiles["BrandMaster.txt"].replace("Brand Name", "Unknown Brand Column") }))).toThrow(/headers changed/);
    expect(() => readCdciPackage(syntheticCdciZip({ "ProductMaster.txt": syntheticCdciFiles["ProductMaster.txt"] + "300\tAnother product\n" }))).toThrow(/duplicate source ID/);
    expect(() => readCdciPackage(syntheticCdciZip({ "SupplierMaster.txt": syntheticCdciFiles["SupplierMaster.txt"].replace("India\t", "India\tunexpected") }))).toThrow(/unexpected columns/);
  });
  it("quarantines broken references and retains an explicit rejected source manifest", () => {
    for (const field of ["\t300\t", "\t400\t", "\t200\t"]) {
      const data = readCdciPackage(syntheticCdciZip({ "BrandMaster.txt": syntheticCdciFiles["BrandMaster.txt"].replace(field, "\t999999\t") }));
      expect(inspectCdciPackage(data)).toMatchObject({ importable: 0, rejected: 1, rejectedSourceIds: ["000700"], databaseChanged: false });
    }
    const data = readCdciPackage(syntheticCdciZip({ "GenericMaster.txt": syntheticCdciFiles["GenericMaster.txt"].replace("100+101", "100+999") }));
    expect(inspectCdciPackage(data).rejectedSamples[0].reason).toMatch(/Missing substance reference/);
  });
  it("does not truncate oversized clinical identity or silently repair invalid source dates", () => {
    const tooLong = readCdciPackage(syntheticCdciZip({ "BrandMaster.txt": syntheticCdciFiles["BrandMaster.txt"].replace("Synthetic Brand 10 mg tablet", "x".repeat(201)) }));
    expect(inspectCdciPackage(tooLong)).toMatchObject({ importable: 0, rejected: 1 });
    const badDate = readCdciPackage(syntheticCdciZip({ "BrandMaster.txt": syntheticCdciFiles["BrandMaster.txt"].replace("20260819", "20260231") }));
    expect(inspectCdciPackage(badDate).rejectedSamples[0].reason).toMatch(/Invalid source update date/);
  });
  it("rejects missing licence, missing masters, traversal, duplicate file names and oversized declarations before inflation", () => {
    expect(() => readCdciPackage(syntheticCdciZip({ "License.txt": null }))).toThrow(/License.txt/);
    expect(() => readCdciPackage(syntheticCdciZip({ "ProductMaster.txt": null }))).toThrow(/Missing CDCI/);
    expect(() => readCdciPackage(syntheticCdciZip({ "../outside.txt": "x" }))).toThrow(/Unsafe/);
    expect(() => readCdciPackage(syntheticCdciZip({ "nested/ProductMaster.txt": syntheticCdciFiles["ProductMaster.txt"] }))).toThrow(/Duplicate ProductMaster/);
    const bytes = syntheticCdciZip(), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 0; at + 28 < bytes.length; at++) if (view.getUint32(at, true) === 0x02014b50) { view.setUint32(at + 24, CDCI_LIMITS.fileBytes + 1, true); break; }
    expect(() => readCdciPackage(bytes)).toThrow(/safe size limit/);
  });
  it("requires approval bound to the exact licence/package/mapping, India scope and actual affiliate evidence", () => {
    const report = inspectCdciPackage(readCdciPackage(syntheticCdciZip()));
    const approval = { packageSha256: report.packageSha256, licenceSha256: report.licenceSha256, mappingVersion: report.mappingVersion, reviewReference: "SYNTHETIC rights review", snomedAffiliateReference: "SYNTHETIC affiliate test", indiaDeploymentAndUsersConfirmed: true, commercialStorageAndRedistributionApproved: true, excludedBrandIds: [] };
    expect(cdciApproval(approval, report).reviewReference).toBe("SYNTHETIC rights review");
    expect(() => cdciApproval({ ...approval, commercialStorageAndRedistributionApproved: false }, report)).toThrow(/commercial rights/);
    expect(() => cdciApproval({ ...approval, snomedAffiliateReference: "" }, report)).toThrow(/affiliate/);
    expect(() => cdciApproval({ ...approval, packageSha256: "0".repeat(64) }, report)).toThrow(/exact package/);
    expect(() => cdciApproval({ ...approval, mappingVersion: "unreviewed" }, report)).toThrow(/mapping/);
    expect(() => cdciApproval({ ...approval, excludedBrandIds: ["000700"] }, report)).toThrow(/every rejected/);
  });
  it("runs default validation and writes a report without connecting to the selected database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ekavyu-cdci-test-")), file = join(directory, "synthetic.zip"), report = join(directory, "review.json");
    const connect = vi.spyOn(mongoose, "connect"), log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await writeFile(file, syntheticCdciZip());
      const result = await runCdciImport([file, `--report=${report}`]);
      expect(result).toMatchObject({ databaseChanged: false, importable: 1 }); expect(connect).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({ databaseChanged: false });
      await expect(runCdciImport([file, "--apply"])).rejects.toThrow(/actual release ID/); expect(connect).not.toHaveBeenCalled();
      const reviewed = inspectCdciPackage(readCdciPackage(syntheticCdciZip())), rightsPath = join(directory, "unapproved-rights.json");
      await writeFile(rightsPath, JSON.stringify({ packageSha256: reviewed.packageSha256, licenceSha256: reviewed.licenceSha256, mappingVersion: reviewed.mappingVersion,
        reviewReference: "SYNTHETIC test only", snomedAffiliateReference: "SYNTHETIC test only", indiaDeploymentAndUsersConfirmed: false, commercialStorageAndRedistributionApproved: false, excludedBrandIds: [] }));
      await expect(runCdciImport([file, "--apply", "--release=SYNTHETIC", `--actor=${"a".repeat(24)}`, `--review=${rightsPath}`])).rejects.toThrow(/commercial rights/);
      expect(connect).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("prepares a package-bound draft with explicit exclusions but leaves publication unapproved", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ekavyu-cdci-draft-")), file = join(directory, "synthetic.zip"), draft = join(directory, "pending.json");
    const connect = vi.spyOn(mongoose, "connect"); vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const bytes = syntheticCdciZip({ "BrandMaster.txt": syntheticCdciFiles["BrandMaster.txt"].replace("\t300\t", "\t999\t") });
      await writeFile(file, bytes);
      const report = inspectCdciPackage(readCdciPackage(bytes));
      await runCdciImport([file, `--draft-review=${draft}`]);
      const pending = JSON.parse(await readFile(draft, "utf8"));
      expect(pending).toEqual(cdciReviewDraft(report));
      expect(pending).toMatchObject({ excludedBrandIds: ["000700"], reviewReference: "", snomedAffiliateReference: "", commercialStorageAndRedistributionApproved: false, indiaDeploymentAndUsersConfirmed: false });
      expect(() => cdciApproval(pending, report)).toThrow(/commercial rights/);
      await expect(runCdciImport([file, `--draft-review=${draft}`])).rejects.toMatchObject({ code: "EEXIST" });
      expect(connect).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("rejects conflicting modes and artifact paths before creating output or connecting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ekavyu-cdci-path-")), file = join(directory, "synthetic.zip"), output = join(directory, "new.json");
    const connect = vi.spyOn(mongoose, "connect");
    try {
      await writeFile(file, syntheticCdciZip());
      for (const flags of [["--check", "--apply"], ["--check", "--check"], [`--draft-review=${file}`], [`--report=${output}`, `--draft-review=${output}`], [`--draft-review=${output}`, `--review=${output}`]]) {
        await expect(runCdciImport([file, ...flags])).rejects.toThrow();
      }
      await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
      expect(readCdciPackage(await readFile(file)).tables["BrandMaster.txt"].size).toBe(1);
      expect(connect).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
