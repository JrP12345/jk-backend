import { Schema } from "mongoose";
import { CommandError } from "../services/CommandReceiptService.ts";

/** A sale hold never changes physical stock, source identity or dispensing classification. */
export const pharmacySaleControlSchema = new Schema({
  revision: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  blocked: { type: Boolean, required: true }, reason: { type: String, required: true, maxlength: 500 },
  reviewReference: { type: String, required: true, maxlength: 200 },
  changedAt: { type: Date, required: true }, changedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  blockedAt: { type: Date },
}, { _id: false });

export interface SaleControlled { saleControl?: { blocked?: boolean | null; blockedAt?: Date | string | null; reason?: string | null } | null }
export function saleBlocked(row: SaleControlled, at?: Date) {
  if (row.saleControl?.blocked !== true) return false;
  const from = row.saleControl.blockedAt;
  // Unknown/invalid evidence is never a reason to bypass a current hold.
  return !at || !from || !Number.isFinite(new Date(from).getTime()) || new Date(from) <= at;
}
export function assertSaleAllowed(row: SaleControlled, at?: Date) {
  if (saleBlocked(row, at)) throw new CommandError(409, "This product or batch is on a sale hold. Ask an authorized administrator to review the recorded restriction.");
}
