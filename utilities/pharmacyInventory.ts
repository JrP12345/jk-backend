import type mongoose from "mongoose";

export class PharmacyInventoryError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 409) {
    super(message);
    this.name = "PharmacyInventoryError";
    this.statusCode = statusCode;
  }
}

export function requireStockTransaction(session: mongoose.ClientSession | null): asserts session is mongoose.ClientSession {
  if (!session?.inTransaction()) {
    throw new PharmacyInventoryError("Inventory writes require a transaction-capable MongoDB replica set", 503);
  }
}

export function stockRevisionFilter(revision: number) {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
    throw new PharmacyInventoryError("Invalid stock revision; review inventory");
  }
  return revision === 0
    ? { $or: [{ stockRevision: 0 }, { stockRevision: { $exists: false } }] }
    : { stockRevision: revision };
}
