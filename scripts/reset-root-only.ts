import mongoose, { type Connection } from "mongoose";
import { pathToFileURL } from "node:url";

type ResetOptions = { database: string; rootEmail?: string; apply: boolean };

export function rootOnlyResetOptions(args: readonly string[]): ResetOptions {
  const allowed = /^(--confirm-database=.+|--root-email=.+|--apply)$/;
  if (args.some(arg => !allowed.test(arg))) throw new Error("Unknown reset argument");
  const databases = args.filter(arg => arg.startsWith("--confirm-database="));
  if (databases.length !== 1) throw new Error("Provide --confirm-database with the exact database name");
  const database = databases[0].slice("--confirm-database=".length);
  if (!database || /[\\/\.\s\0$]/.test(database) || ["admin", "local", "config"].includes(database.toLowerCase())) {
    throw new Error("Refusing a system or invalid database target");
  }
  const emails = args.filter(arg => arg.startsWith("--root-email="));
  if (emails.length > 1) throw new Error("Choose only one Root account");
  return { database, rootEmail: emails[0]?.slice("--root-email=".length).trim().toLowerCase(), apply: args.includes("--apply") };
}

/** Deletes development records on the explicitly chosen installation while preserving Root authentication. */
export async function resetRootOnlyConnection(connection: Connection, options: ResetOptions) {
  const db = connection.db;
  if (!db || db.databaseName !== options.database) throw new Error("Connected database does not match --confirm-database");
  const entries = await db.listCollections({}, { nameOnly: false }).toArray();
  if (entries.some(entry => entry.name.startsWith("system.") || entry.type !== "collection" || entry.options?.timeseries || entry.options?.capped)) {
    throw new Error("Reset requires ordinary application collections; system, view, capped or time-series collections require review");
  }
  const users = db.collection("users");
  const roots = await users.find({ role: "root", ...(options.rootEmail ? { email: options.rootEmail } : {}) }).toArray();
  if (roots.length !== 1) throw new Error("Choose exactly one existing Root using --root-email");
  const root = roots[0];
  if (root.isActive === false || !root.twoFactorEnabled || typeof root.twoFactorSecret !== "string" || !root.twoFactorSecret.startsWith("enc:v1:")) {
    throw new Error("Root must be active with current encrypted MFA before resetting");
  }
  if (!process.env.DATA_ENCRYPTION_KEY) throw new Error("The existing DATA_ENCRYPTION_KEY is required to verify Root MFA");
  const { decryptField } = await import("../utilities/cryptoEnvelope.ts");
  if (!/^[A-Z2-7]+=*$/.test(decryptField(root.twoFactorSecret))) throw new Error("Root MFA cannot be decrypted with the configured key");
  const passkeys = db.collection("passkeys");
  const keptPasskeys = await passkeys.countDocuments({ userId: root._id });
  const collections = [];
  for (const entry of entries) {
    const documents = await db.collection(entry.name).countDocuments({});
    const preserve = entry.name === "users" ? 1 : entry.name === "passkeys" ? keptPasskeys : 0;
    collections.push({ name: entry.name, documents, preserve, remove: documents - preserve });
  }
  const preview = { database: db.databaseName, rootId: root._id.toString(), mfaVerified: true, keptPasskeys, collections, apply: options.apply };
  if (!options.apply) return preview;

  const topology = await db.admin().command({ hello: 1 });
  if (!topology.setName && topology.msg !== "isdbgrid") throw new Error("A replica set or sharded cluster is required for an atomic reset");
  const session = await connection.startSession();
  try {
    await session.withTransaction(async () => {
      const currentRoot = await users.findOne({ _id: root._id }, { session });
      if (JSON.stringify(currentRoot) !== JSON.stringify(root)) throw new Error("Root changed after preview; reset cancelled");
      for (const entry of entries) {
        const filter = entry.name === "users" ? { _id: { $ne: root._id } } : entry.name === "passkeys" ? { userId: { $ne: root._id } } : {};
        await db.collection(entry.name).deleteMany(filter, { session });
      }
      for (const entry of entries) {
        const expected = entry.name === "users" ? 1 : entry.name === "passkeys" ? keptPasskeys : 0;
        if (await db.collection(entry.name).countDocuments({}, { session }) !== expected) throw new Error("Reset verification failed; transaction cancelled");
      }
      if (JSON.stringify(await users.findOne({ _id: root._id }, { session })) !== JSON.stringify(root)) throw new Error("Root authentication changed; transaction cancelled");
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
  } finally {
    await session.endSession();
  }
  // The committed reset leaves Root in place throughout; remove empty schemas and their obsolete indexes afterwards.
  for (const entry of entries) {
    if (entry.name !== "users" && entry.name !== "passkeys") {
      if (await db.collection(entry.name).countDocuments({}) !== 0) throw new Error("Writes resumed after reset; pause processes before removing recreated records");
      await db.dropCollection(entry.name);
    }
  }
  const remaining = await db.listCollections({}, { nameOnly: true }).toArray();
  const recreatedEmptyCollections: string[] = [];
  for (const entry of remaining) {
    if (["users", "passkeys"].includes(entry.name)) continue;
    if (await db.collection(entry.name).countDocuments({}) !== 0) throw new Error("Writes recreated data after reset; pause processes and retry");
    recreatedEmptyCollections.push(entry.name);
  }
  if (await users.countDocuments({}) !== 1 || await passkeys.countDocuments({}) !== keptPasskeys) throw new Error("Writes recreated authentication records after reset; pause processes and retry");
  if (JSON.stringify(await users.findOne({ _id: root._id })) !== JSON.stringify(root)) throw new Error("Root changed during collection cleanup; verify authentication before restarting");
  return { ...preview, resetComplete: true, recreatedEmptyCollections };
}

export async function resetRootOnly(uri: string, args: readonly string[]) {
  const options = rootOnlyResetOptions(args);
  if (!/^mongodb(?:\+srv)?:\/\//.test(uri)) throw new Error("MONGODB_URI is required");
  const connection = await mongoose.createConnection(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15000, maxPoolSize: 2 }).asPromise();
  try { return await resetRootOnlyConnection(connection, options); }
  finally { await connection.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  resetRootOnly(process.env.MONGODB_URI || "", process.argv.slice(2))
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => {
      console.error(JSON.stringify({ resetStopped: true, error: error.name, code: error.code, codeName: error.codeName,
        reason: error.name === "Error" ? error.message : "MongoDB operation failed; authentication values are not logged" }));
      process.exitCode = 1;
    });
}
