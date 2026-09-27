import mongoose from "mongoose";

// Connection.transaction propagates its session to nested Mongoose operations.
// This covers clinical services that do not accept an explicit session argument.
mongoose.set("transactionAsyncLocalStorage", true);

export async function withClinicalTransaction<T>(fn: () => Promise<T>): Promise<T> {
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
  const topologyType = ((mongoose.connection as any)?.client as any)?.topology?.description?.type;
  const isStandalone = topologyType === "Single" || topologyType === "Unknown";

  if (isStandalone) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Multi-document ACID transactions require a MongoDB Replica Set in production");
    }
    return fn(null);
  }

  let session: mongoose.ClientSession | null = null;
  try {
    session = await mongoose.startSession();
    session.startTransaction();
    const result = await fn(session);
    if (session.inTransaction()) await session.commitTransaction();
    return result;
  } catch (err: any) {
    if (session?.inTransaction()) {
      try {
        await session.abortTransaction();
      } catch {
        // Preserve the workflow error; abort is best effort.
      }
    }

    const msg = err?.message || err?.errmsg || err?.errorResponse?.errmsg || "";
    const code = err?.code || err?.errorResponse?.code;
    if (code === 20 || msg.includes("replica set") || msg.includes("Transaction numbers")) {
      if (process.env.NODE_ENV === "production") {
        throw new Error(`Transaction failed: Multi-document ACID transactions require a MongoDB Replica Set in production (${msg})`);
      }
      return fn(null);
    }
    throw err;
  } finally {
    session?.endSession();
  }
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
