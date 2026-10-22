import crypto from "node:crypto";
import mongoose from "mongoose";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { withTransaction } from "../utilities/transaction.ts";

export class CommandError extends Error {
  public statusCode: number;
  public details?: unknown;
  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function commandHash(payload: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
}
/** Reserve, write and persist the resulting reference in the same transaction. */
export async function executeRecordedCommand(scope: string, key: string, payload: unknown, write: () => Promise<string>, transactionOptions?: mongoose.mongo.TransactionOptions) {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(400, "A valid request identifier is required");
  const requestHash = commandHash(payload);
  for (let attempt = 0; attempt < 3; attempt++) {
    const prior = await OperationReceipt.findOne({ scope, key }).lean() as any;
    if (prior) {
      if (prior.requestHash !== requestHash) throw new CommandError(409, "This request identifier was used with different details. Start a new command.");
      if (!prior.resultId) throw new CommandError(409, "The command is still being processed. Retry the same request.");
      return { resultId: String(prior.resultId), replayed: true };
    }
    const topology = (mongoose.connection as any)?.client?.topology?.description?.type;
    if (topology === "Single" || topology === "Unknown") throw new CommandError(503, "This workflow requires a transaction-capable MongoDB replica set");
    try {
      const resultId = await withTransaction(async () => {
        await OperationReceipt.create({ scope, key, requestHash });
        const id = await write();
        await OperationReceipt.updateOne({ scope, key, requestHash }, { $set: { resultId: id } });
        return id;
      }, transactionOptions);
      return { resultId, replayed: false };
    } catch (error: any) {
      if (error?.code === 11000 && attempt < 2) continue;
      throw error;
    }
  }
  throw new CommandError(409, "Concurrent command conflict. Retry the same request.");
}
