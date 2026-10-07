import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { encryptField } from "../utilities/cryptoEnvelope.ts";
import { rootOnlyResetOptions, resetRootOnlyConnection } from "../scripts/reset-root-only.ts";

describe("Root-only development installation reset", () => {
  const rootId = new mongoose.Types.ObjectId();
  const otherId = new mongoose.Types.ObjectId();
  const root = { _id: rootId, role: "root", email: "root@reset.example.test", isActive: true, password: "existing-password-hash", twoFactorEnabled: true, twoFactorSecret: encryptField("JBSWY3DPEHPK3PXP"), authVersion: 3 };
  const passkey = { _id: new mongoose.Types.ObjectId(), userId: rootId, credentialId: "root-credential", publicKey: Buffer.from([1, 2, 3]), counter: 12 };
  const options = (apply: boolean) => ({ database: mongoose.connection.db!.databaseName, apply });

  beforeEach(async () => {
    const db = mongoose.connection.db!;
    for (const entry of await db.listCollections({}, { nameOnly: true }).toArray()) {
      await db.collection(entry.name).deleteMany({});
    }
    await db.collection("users").insertMany([root, { _id: otherId, role: "admin", email: "admin@reset.example.test" }]);
    await db.collection("passkeys").insertMany([passkey, { userId: otherId, credentialId: "other-credential", publicKey: Buffer.from([4]), counter: 0 }]);
    await db.collection("appointments").insertOne({ patientId: otherId });
    await db.collection("supersededlocations").insertOne({ name: "Discarded fixture" });
    await db.collection("refreshtokens").insertOne({ userId: rootId, tokenHash: "discarded-session" });
  });

  it("requires an exact safe database name and refuses ambiguous arguments", () => {
    expect(() => rootOnlyResetOptions([])).toThrow("exact database");
    for (const database of ["admin", "config", "local", "invalid/name", "invalid.name"]) {
      expect(() => rootOnlyResetOptions([`--confirm-database=${database}`, "--apply"])).toThrow("database target");
    }
    expect(() => rootOnlyResetOptions(["--confirm-database=a", "--confirm-database=b"])).toThrow("exact database");
    expect(() => rootOnlyResetOptions(["--confirm-database=test", "--force"])).toThrow("Unknown");
  });

  it("previews all collections without changing records or authentication", async () => {
    const db = mongoose.connection.db!;
    const before = await db.collection("users").findOne({ _id: rootId });
    const preview = await resetRootOnlyConnection(mongoose.connection, options(false));
    expect(preview).toMatchObject({ mfaVerified: true, keptPasskeys: 1, apply: false });
    expect(preview.collections.find(item => item.name === "users")).toMatchObject({ documents: 2, preserve: 1, remove: 1 });
    expect(await db.collection("users").findOne({ _id: rootId })).toEqual(before);
    expect(await db.collection("appointments").countDocuments()).toBe(1);
  });

  it("rejects a different connected database before deleting anything", async () => {
    await expect(resetRootOnlyConnection(mongoose.connection, { database: "wrong-database", apply: true })).rejects.toThrow("does not match");
    expect(await mongoose.connection.db!.collection("users").countDocuments()).toBe(2);
  });

  it("refuses ambiguous Root selection and unverifiable MFA", async () => {
    const db = mongoose.connection.db!;
    await db.collection("users").insertOne({ ...root, _id: new mongoose.Types.ObjectId(), email: "second@reset.example.test" });
    await expect(resetRootOnlyConnection(mongoose.connection, options(true))).rejects.toThrow("exactly one");
    await db.collection("users").updateOne({ _id: rootId }, { $set: { twoFactorSecret: "enc:v1:bad:bad:bad" } });
    await expect(resetRootOnlyConnection(mongoose.connection, { ...options(true), rootEmail: root.email })).rejects.toThrow("cannot be decrypted");
    expect(await db.collection("appointments").countDocuments()).toBe(1);
  });

  it("rolls back deletions if any collection cannot be cleared", async () => {
    const db = mongoose.connection.db!;
    const originalCollection = db.collection.bind(db);
    const spy = vi.spyOn(db, "collection").mockImplementation(((name: string, ...args: any[]) => {
      const collection = originalCollection(name, ...args);
      if (name === "supersededlocations") collection.deleteMany = vi.fn().mockRejectedValue(new Error("simulated deletion failure"));
      return collection;
    }) as typeof db.collection);
    try { await expect(resetRootOnlyConnection(mongoose.connection, options(true))).rejects.toThrow("simulated deletion failure"); }
    finally { spy.mockRestore(); }
    expect(await db.collection("users").countDocuments()).toBe(2);
    expect(await db.collection("refreshtokens").countDocuments()).toBe(1);
    expect(await db.collection("appointments").countDocuments()).toBe(1);
  });

  it("allows a running worker to recreate an empty collection without treating it as restored data", async () => {
    const db = mongoose.connection.db!;
    await db.createCollection("workerleases").catch(() => {});
    const dropCollection = db.dropCollection.bind(db);
    const spy = vi.spyOn(db, "dropCollection").mockImplementation(async (name, options) => {
      const result = await dropCollection(name, options);
      if (name === "workerleases") await db.createCollection("workerleases");
      return result;
    });
    try {
      expect(await resetRootOnlyConnection(mongoose.connection, options(true))).toMatchObject({ resetComplete: true, recreatedEmptyCollections: ["workerleases"] });
      expect(await db.collection("workerleases").countDocuments({})).toBe(0);
    } finally { spy.mockRestore(); }
  });

  it("keeps exactly Root and its passkey, preserves MFA/password, and removes every other schema", async () => {
    const db = mongoose.connection.db!;
    const before = await db.collection("users").findOne({ _id: rootId });
    const beforePasskey = await db.collection("passkeys").findOne({ userId: rootId });
    expect(await resetRootOnlyConnection(mongoose.connection, options(true))).toMatchObject({ resetComplete: true });
    expect(await db.collection("users").find({}).toArray()).toEqual([before]);
    expect(await db.collection("passkeys").find({}).toArray()).toEqual([beforePasskey]);
    expect((await db.listCollections({}, { nameOnly: true }).toArray()).map(item => item.name).sort()).toEqual(["passkeys", "users"]);
  });
});
