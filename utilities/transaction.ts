import mongoose from "mongoose";

/**
 * Utility helper to execute multi-document operations inside a Mongoose ACID session transaction.
 *
 * Automatically manages session lifecycle (startSession, startTransaction, commitTransaction, abortTransaction).
 * Provides seamless fallback for standalone single-instance MongoDB environments without replica sets.
 */
export async function withTransaction<T>(
  fn: (session: mongoose.ClientSession | null) => Promise<T>
): Promise<T> {
  // Check if MongoDB connection is a standalone single instance (no replica set)
  const topologyType = ((mongoose.connection as any)?.client as any)?.topology?.description?.type;
  const isStandalone = topologyType === "Single" || topologyType === "Unknown";

  if (isStandalone) {
    // Standalone single-instance MongoDB (local dev/test) — execute non-transactionally
    return await fn(null);
  }

  let session: mongoose.ClientSession | null = null;

  try {
    session = await mongoose.startSession();
    session.startTransaction();

    const result = await fn(session);

    await session.commitTransaction();
    return result;
  } catch (err: any) {
    if (session && session.inTransaction()) {
      try {
        await session.abortTransaction();
      } catch {
        // ignore abort failure
      }
    }

    const msg = err?.message || err?.errmsg || err?.errorResponse?.errmsg || "";
    const code = err?.code || err?.errorResponse?.code;

    // Additional fallback check for standalone MongoDB code 20 errors
    if (code === 20 || msg.includes("replica set") || msg.includes("Transaction numbers")) {
      return await fn(null);
    }

    throw err;
  } finally {
    if (session) {
      session.endSession();
    }
  }
}

/**
 * Helper to create a document with optional session support.
 * Returns a single created document whether operating in a session transaction or standalone mode.
 */
export async function createWithSession<T = any>(
  model: any,
  docData: any,
  session: mongoose.ClientSession | null
): Promise<T> {
  if (session) {
    const [created] = await model.create([docData], { session });
    return created;
  }
  return await model.create(docData);
}
