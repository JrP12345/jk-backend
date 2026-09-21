import mongoose, { Schema } from "mongoose";

/**
 * A fenced, expiring ownership record for singleton background schedulers.
 *
 * The record is deliberately held in MongoDB rather than process memory so
 * multiple worker pods coordinate against the same durable authority.
 */
export interface IWorkerLease extends mongoose.Document {
  name: string;
  holderId: string;
  expiresAt: Date;
}

const WorkerLeaseSchema = new Schema<IWorkerLease>(
  {
    name: { type: String, required: true, unique: true, immutable: true },
    holderId: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// Expired records are also eligible for atomic takeover. TTL cleanup merely
// keeps abandoned records from accumulating; it is not used for correctness.
WorkerLeaseSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const WorkerLease = mongoose.models.WorkerLease || mongoose.model<IWorkerLease>(
  "WorkerLease",
  WorkerLeaseSchema,
);
