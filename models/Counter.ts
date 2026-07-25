import mongoose, { Schema, Document } from "mongoose";

export interface ICounter extends Document {
  id: string; // e.g. "invoice_ORG123_2026"
  seq: number;
}

const CounterSchema = new Schema<ICounter>(
  {
    id: { type: String, required: true, unique: true },
    seq: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const Counter = mongoose.models.Counter || mongoose.model<ICounter>("Counter", CounterSchema);

/**
 * Atomic counter sequence generator for clean, predictable audit numbering
 * e.g. generateAtomicSequence("invoice_ORG123_2026") => 1, 2, 3...
 */
export async function getNextAtomicSequence(counterId: string): Promise<number> {
  const result = await Counter.findOneAndUpdate(
    { id: counterId },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return result.seq;
}
