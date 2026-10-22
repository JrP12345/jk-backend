import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import mongoose, { type Connection } from "mongoose";
import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { currentSchemaIndexManifest, inspectDatabaseIndexes, prepareDatabaseIndexes, type DatabaseIndexModel } from "../services/DatabaseIndexService.ts";
import { databaseIndexMode } from "../scripts/prepare-database-indexes.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { Invoice } from "../models/Invoice.ts";
import { PharmacyDispense } from "../models/PharmacyDispense.ts";
import { PharmacyImport } from "../models/PharmacyImport.ts";

const connections = new Set<Connection>(), oid = () => new mongoose.Types.ObjectId();
beforeAll(async () => {
  const directory = new URL("../models/", import.meta.url);
  for (const file of (await readdir(directory)).filter(file => file.endsWith(".ts")).sort()) await import(new URL(file, directory).href);
});
afterEach(async () => { for (const connection of connections) await connection.close(); connections.clear(); });
async function fresh(models: DatabaseIndexModel[] = [OperationReceipt, MedicineBatch, Invoice, PharmacyDispense, PharmacyImport]) {
  const connection = await mongoose.createConnection(process.env.MONGODB_URI!, { dbName: `t25_${crypto.randomUUID().replaceAll("-", "")}`, autoIndex: false, autoCreate: false, monitorCommands: true }).asPromise();
  connections.add(connection);
  const copies = models.map(model => {
    const schema = model.schema.clone(); schema.set("autoIndex", false); schema.set("autoCreate", false);
    return connection.model(model.modelName, schema, model.collection.name);
  });
  return { connection, models: copies };
}
const modelNamed = (models: DatabaseIndexModel[], name: string) => models.find(model => model.modelName === name)!;
describe("Explicit current schema setup", () => {
  it("detects missing collections without writing and prepares every current model repeatably on a fresh replica-set database", async () => {
    const { connection, models } = await fresh(Object.values(mongoose.models));
    expect((await connection.db!.listCollections().toArray())).toHaveLength(0);
    const commands: string[] = [], record = (event: { commandName: string }) => commands.push(event.commandName);
    connection.getClient().on("commandStarted", record);
    const before = await inspectDatabaseIndexes(models);
    connection.getClient().off("commandStarted", record);
    expect(before.ready).toBe(false); expect(before.issues.every(issue => issue.kind === "missing_collection")).toBe(true);
    expect(commands.filter(command => /^(insert|update|delete|findAndModify|create|createIndexes|drop|dropIndexes|commitTransaction)$/i.test(command))).toEqual([]);
    expect((await connection.db!.listCollections().toArray())).toHaveLength(0);
    const first = await prepareDatabaseIndexes(models); expect(first.ready, JSON.stringify(first.issues)).toBe(true);
    const snapshot = await inspectDatabaseIndexes(models);
    expect(await prepareDatabaseIndexes(models)).toEqual(snapshot);
    expect((await connection.db!.listCollections().toArray()).length).toBe(models.length);
    for (const model of models) expect(await model.collection.countDocuments()).toBe(0);
  }, 120000);
  it("enforces real operation/receipt/source identities while retaining independent clinical and retail invoice rows", async () => {
    const { models } = await fresh(); await prepareDatabaseIndexes(models);
    const operations = modelNamed(models, "OperationReceipt").collection;
    await operations.insertOne({ scope: "org-a:branch", key: "source-key", requestHash: "a".repeat(64), resultId: oid() });
    await expect(operations.insertOne({ scope: "org-a:branch", key: "source-key", requestHash: "a".repeat(64), resultId: oid() })).rejects.toMatchObject({ code: 11000 });
    await operations.insertOne({ scope: "org-b:branch", key: "source-key", requestHash: "a".repeat(64), resultId: oid() });
    const org = oid(), location = oid(), medicine = oid(), batches = modelNamed(models, "MedicineBatch").collection;
    const lot = { organizationId: org, locationId: location, medicineId: medicine, batchNumber: "SAME-PRINTED-BATCH", lotVersion: 1, receiptLineId: "source-lot-1" };
    await batches.insertOne(lot); await batches.insertOne({ ...lot, _id: oid(), receiptLineId: "source-lot-2" });
    await expect(batches.insertOne({ ...lot, _id: oid() })).rejects.toMatchObject({ code: 11000 });
    const supplies = modelNamed(models, "PharmacyDispense").collection, prescription = oid();
    await supplies.insertOne({ organizationId: org, locationId: location, operationKey: "clinical-one", kind: "clinical", prescriptionIds: [prescription], fulfillmentClaims: [`${prescription}:1`] });
    await expect(supplies.insertOne({ organizationId: org, locationId: location, operationKey: "clinical-two", kind: "clinical", prescriptionIds: [prescription], fulfillmentClaims: [`${prescription}:1`] })).rejects.toMatchObject({ code: 11000 });
    await supplies.insertMany([{ organizationId: org, locationId: location, operationKey: "retail-one", kind: "pharmacy", prescriptionIds: [] }, { organizationId: org, locationId: location, operationKey: "retail-two", kind: "pharmacy", prescriptionIds: [] }]);
    const invoices = modelNamed(models, "Invoice").collection, sourceLine = oid();
    await invoices.insertMany([{ invoiceNumber: "CLINIC-A", kind: "clinical", items: [{ description: "Consultation" }] }, { invoiceNumber: "CLINIC-B", kind: "clinical", items: [{ description: "Clinical follow-up" }] }, { invoiceNumber: "RETAIL-A", kind: "pharmacy", pharmacyDispenseLineIds: [sourceLine] }]);
    await expect(invoices.insertOne({ invoiceNumber: "RETAIL-B", kind: "pharmacy", pharmacyDispenseLineIds: [sourceLine] })).rejects.toMatchObject({ code: 11000 });
    expect((await inspectDatabaseIndexes(models)).ready).toBe(true);
  });
  it("reports a retained batch-label unique index and refuses to alter it or remove source records", async () => {
    const { models } = await fresh([MedicineBatch]); await prepareDatabaseIndexes(models);
    const collection = models[0].collection;
    await collection.insertOne({ medicineId: oid(), locationId: oid(), batchNumber: "Synthetic retained label" });
    await collection.createIndex({ medicineId: 1, locationId: 1, batchNumber: 1 }, { unique: true, name: "synthetic_stale_batch_label" });
    const report = await inspectDatabaseIndexes(models);
    expect(report.issues).toContainEqual(expect.objectContaining({ kind: "unexpected_unique_index", index: "synthetic_stale_batch_label" }));
    await expect(prepareDatabaseIndexes(models)).rejects.toThrow(/stale index constraints/);
    expect(await collection.countDocuments()).toBe(1); expect((await collection.listIndexes().toArray()).some(index => index.name === "synthetic_stale_batch_label")).toBe(true);
  });
  it("distinguishes a missing receipt index from incompatible partial identity options", async () => {
    const { models } = await fresh([MedicineBatch]); await prepareDatabaseIndexes(models);
    const collection = models[0].collection;
    await collection.dropIndex("pharmacy_receipt_line_v1");
    expect((await inspectDatabaseIndexes(models)).issues).toContainEqual(expect.objectContaining({ kind: "missing_index", index: "pharmacy_receipt_line_v1" }));
    await collection.createIndex({ organizationId: 1, locationId: 1, receiptLineId: 1 }, { unique: true, name: "synthetic_wrong_receipt_filter" });
    expect((await inspectDatabaseIndexes(models)).issues).toContainEqual(expect.objectContaining({ kind: "index_options_conflict", index: "pharmacy_receipt_line_v1" }));
    await expect(prepareDatabaseIndexes(models)).rejects.toThrow(/stale index constraints/);
  });
  it("rejects an undeclared TTL on durable financial receipts without removing it", async () => {
    const { models } = await fresh([OperationReceipt]); await prepareDatabaseIndexes(models);
    await models[0].collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600, name: "synthetic_unsafe_receipt_ttl" });
    const report = await inspectDatabaseIndexes(models);
    expect(report.issues).toContainEqual(expect.objectContaining({ kind: "unexpected_ttl_index", index: "synthetic_unsafe_receipt_ttl" }));
    await expect(prepareDatabaseIndexes(models)).rejects.toThrow(/stale index constraints/);
  });
  it("does not modify documents when repeated setup creates only current indexes", async () => {
    const { connection, models } = await fresh([OperationReceipt]); await prepareDatabaseIndexes(models);
    await models[0].collection.insertOne({ scope: "real-synthetic-scope", key: "stable-key", requestHash: "b".repeat(64), resultId: oid() });
    const original = await models[0].collection.findOne({ key: "stable-key" }), commands: string[] = [];
    const record = (event: { commandName: string }) => commands.push(event.commandName);
    connection.getClient().on("commandStarted", record); await prepareDatabaseIndexes(models); connection.getClient().off("commandStarted", record);
    expect(commands.filter(command => /^(insert|update|delete|findAndModify|drop|dropIndexes)$/i.test(command))).toEqual([]);
    expect(await models[0].collection.findOne({ key: "stable-key" })).toEqual(original);
  });
  it("fails index creation on duplicate source facts with a safe actionable message and preserves both records", async () => {
    const { models } = await fresh([OperationReceipt]); await models[0].createCollection();
    await models[0].collection.insertMany([{ scope: "synthetic@example.test", key: "duplicate", requestHash: "c".repeat(64) }, { scope: "synthetic@example.test", key: "duplicate", requestHash: "c".repeat(64) }]);
    await expect(prepareDatabaseIndexes(models)).rejects.toThrow(/Check source duplicates/);
    try { await prepareDatabaseIndexes(models); } catch (error) { expect((error as Error).message).not.toContain("synthetic@example.test"); }
    expect(await models[0].collection.countDocuments()).toBe(2);
  });
});
describe("Disconnected preview and explicit CLI modes", () => {
  it("defaults to preview and requires the complete explicit apply acknowledgement", () => {
    expect(databaseIndexMode([])).toBe("preview"); expect(databaseIndexMode(["--check"])).toBe("check"); expect(databaseIndexMode(["--apply", "--writes-paused"])).toBe("apply");
    for (const args of [["--apply"], ["--writes-paused"], ["--check", "--apply", "--writes-paused"], ["--drop"], ["--check", "--check"]]) expect(() => databaseIndexMode(args)).toThrow();
  });
  it("lists actual pharmacy and clinical schema identities without touching a configured database", async () => {
    const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../scripts/prepare-database-indexes.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), env: { ...process.env, NODE_ENV: "test", MONGODB_URI: "mongodb://127.0.0.1:1/must_not_connect" }, timeout: 20000, maxBuffer: 2_000_000,
    });
    expect(result.stdout).toContain("Preview only. No database connection or index changes were made.");
    expect(result.stdout).toContain('"model":"PharmacyImport"'); expect(result.stdout).toContain('"model":"Invoice"');
    const manifest = currentSchemaIndexManifest([MedicineBatch, OperationReceipt]);
    expect(manifest.flatMap(model => model.indexes).some(index => index.options.name === "pharmacy_receipt_line_v1")).toBe(true);
  }, 25000);
  it("checks an isolated empty target through native Node without automatically creating collections or indexes", async () => {
    const { connection } = await fresh([]), uri = new URL(process.env.MONGODB_URI!); uri.pathname = `/${connection.name}`;
    let output = "", exitCode: unknown;
    try {
      await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../scripts/prepare-database-indexes.ts", import.meta.url)), "--check"], {
        cwd: fileURLToPath(new URL("../", import.meta.url)), env: { ...process.env, NODE_ENV: "test", MONGODB_URI: uri.toString() }, timeout: 20000, maxBuffer: 2_000_000,
      });
    } catch (error) { output = (error as { stdout: string }).stdout; exitCode = (error as { code: unknown }).code; }
    expect(exitCode).toBe(2);
    const line = output.split(/\r?\n/).find(value => value.startsWith('{"version":1,"mode":"check"'));
    expect(line).toBeTruthy(); expect(JSON.parse(line!)).toMatchObject({ ready: false, transactionCapable: true });
    expect(await connection.db!.listCollections().toArray()).toHaveLength(0);
  }, 25000);
});
