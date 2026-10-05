import mongoose from "mongoose";

// Connection.transaction propagates its session to nested Mongoose operations.
// This covers clinical services that do not accept an explicit session argument.
mongoose.set("transactionAsyncLocalStorage", true);

export async function withClinicalTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const inherited = (mongoose as any).transactionAsyncLocalStorage?.getStore()?.session;
  if (inherited?.inTransaction()) return fn();
  const topology = (mongoose.connection as any)?.client?.topology?.description?.type;
  if (topology === "Single" || topology === "Unknown") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Clinical finalization requires a transaction-capable MongoDB replica set");
    }
    return fn();
  }
  return mongoose.connection.transaction(fn);
}

/**
 * Execute a multi-document workflow in a Mongoose ACID transaction.
 *
 * Local development and tests may deliberately use a standalone MongoDB and
 * receive a null session. Production never falls back: all callers relying on
 * this helper fail closed until a replica set or managed transaction-capable
 * service is available.
 */
export async function withTransaction<T>(
  fn: (session: mongoose.ClientSession | null) => Promise<T>
): Promise<T> {
  const inherited = (mongoose as any).transactionAsyncLocalStorage?.getStore()?.session;
  if (inherited?.inTransaction()) return fn(inherited);
  const topologyType = ((mongoose.connection as any)?.client as any)?.topology?.description?.type;
  const isStandalone = topologyType === "Single" || topologyType === "Unknown";

  if (isStandalone) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Multi-document ACID transactions require a MongoDB Replica Set in production");
    }
    return fn(null);
  }

  // Driver-managed retry/commit handling and Mongoose session propagation.
  // Callers must keep irreversible external effects outside this callback.
  return mongoose.connection.transaction(async (session) => fn(session));
}

/** Create a document with an optional transaction session. */
export async function createWithSession<T = any>(
  model: any,
  docData: any,
  session: mongoose.ClientSession | null
): Promise<T> {
  if (session) {
    const [created] = await model.create([docData], { session });
    return created;
  }
  return model.create(docData);
}
