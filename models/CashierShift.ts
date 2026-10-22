import mongoose, { Schema } from "mongoose";
import { CommandError, commandHash } from "../services/CommandReceiptService.ts";

export function assertDrawerEvidence(value: any) {
  if (value.kind !== "drawer" || value.status !== "closed") return;
  const row = typeof value.toObject === "function" ? value.toObject() : value;
  if (!row.drawerTotals || !Array.isArray(row.receiptEvidence) || !Array.isArray(row.eventEvidence) || row.evidenceHash !== commandHash({ totals: row.drawerTotals, receipts: row.receiptEvidence, events: row.eventEvidence })) throw new CommandError(409, "Saved drawer evidence differs from its closing snapshot");
}

const CashierShiftSchema = new Schema(
  {
    kind: { type: String, enum: ["receipt_report", "drawer"], default: "receipt_report", required: true },
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
    locationId: { type: Schema.Types.ObjectId, ref: "Location", required: true, index: true },
    cashierId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    cashierName: { type: String, required: true },
    shiftDate: { type: String, required: true, index: true }, // "YYYY-MM-DD"
    collectionBasis: { type: String, enum: ["receipt_v1", "drawer_v1"] },
    drawerCode: String, organizationName: String, locationName: String,
    openingFloatPaise: { type: Number, min: 0, default: 0, validate: Number.isSafeInteger },
    revision: { type: Number, min: 0, default: 0, validate: Number.isSafeInteger },
    closedBy: { type: Schema.Types.ObjectId, ref: "User" }, closedByName: String,
    evidenceHash: String,
    drawerTotals: { type: new Schema({
      incoming: { cash: Number, upi: Number, card: Number, other: Number },
      outgoing: { cash: Number, upi: Number, card: Number, other: Number },
      eventIncoming: { cash: Number, upi: Number, card: Number, other: Number },
      expectedCashPaise: Number, receiptCount: Number, eventCount: Number, invoiceCount: Number,
    }, { _id: false }), default: undefined },
    receiptEvidence: { type: [new Schema({ invoiceId: String, paymentId: String, operationKey: String, amountPaise: Number, paymentMethod: String, paidAt: String, actorId: String }, { _id: false })], default: undefined },
    eventEvidence: { type: [new Schema({ eventId: String, kind: String, direction: String, amountPaise: Number, paymentMethod: String, recordedAt: String, actorId: String, referenceNumber: String }, { _id: false })], default: undefined },
    timezone: String,
    currency: String,
    periodEnd: Date,
    asOf: Date,
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date, default: function (this: { kind?: string }) { return this.kind === "drawer" ? undefined : new Date(); } },
    systemTotals: {
      cash: { type: Number, default: 0 },
      upi: { type: Number, default: 0 },
      card: { type: Number, default: 0 },
      other: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
      invoiceCount: { type: Number, default: 0 },
      receiptCount: Number,
      legacyReceiptCount: Number,
    },
    actualCashCounted: { type: Number, required: function (this: { status?: string }) { return this.status === "closed"; } },
    cashVariance: { type: Number, required: function (this: { status?: string }) { return this.status === "closed"; } },
    varianceReason: { type: String, default: "" },
    handoverNotes: { type: String, default: "" },
    status: { type: String, enum: ["active", "closed"], default: "closed", index: true },
  },
  { timestamps: true }
);

CashierShiftSchema.index({ locationId: 1, shiftDate: 1 });
CashierShiftSchema.index({ organizationId: 1, locationId: 1, drawerCode: 1 }, { unique: true, partialFilterExpression: { kind: "drawer", status: "active" } });
CashierShiftSchema.index({ organizationId: 1, locationId: 1, cashierId: 1 }, { unique: true, partialFilterExpression: { kind: "drawer", status: "active" } });
CashierShiftSchema.pre("validate", function () {
  if (this.kind !== "drawer") { if (this.status !== "closed") throw new CommandError(409, "Receipt reports cannot be active physical drawers"); return; }
  if (!this.organizationId || !this.organizationName || !this.locationName || !this.currency || !this.timezone || this.collectionBasis !== "drawer_v1" || !/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(this.drawerCode || "") || !this.startedAt || !Number.isFinite(this.startedAt.getTime())) throw new CommandError(409, "Physical drawer source evidence is incomplete");
  if (this.status === "active" && (this.endedAt || this.drawerTotals || this.actualCashCounted !== undefined)) throw new CommandError(409, "Active drawer cannot contain a closing snapshot");
  if (this.status === "closed" && (!this.endedAt || this.endedAt < this.startedAt || !this.closedBy || !this.closedByName || !this.drawerTotals || !/^[a-f0-9]{64}$/.test(this.evidenceHash || "") || !Number.isSafeInteger(this.drawerTotals.expectedCashPaise) || this.drawerTotals.expectedCashPaise! < 0)) throw new CommandError(409, "Drawer closing evidence is incomplete");
  assertDrawerEvidence(this);
});
const openingFacts = ["kind", "organizationId", "locationId", "cashierId", "cashierName", "drawerCode", "openingFloatPaise", "organizationName", "locationName", "currency", "timezone", "shiftDate", "startedAt", "collectionBasis"];
CashierShiftSchema.pre("save", async function () {
  if (this.isNew) return;
  const prior = await mongoose.model("CashierShift").findById(this._id).select("status").session(this.$session()).lean() as { status?: string } | null;
  if (prior?.status === "closed" || openingFacts.some(path => this.isModified(path))) throw new CommandError(409, "Drawer opening facts and closed reports are immutable");
});
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) CashierShiftSchema.pre(op, function () {
  const update = this.getUpdate() as Record<string, any> | null;
  if (!["updateOne", "findOneAndUpdate"].includes(op) || !update || Object.keys(update).some(key => key !== "$inc") || Object.keys(update.$inc || {}).some(key => !["revision", "__v"].includes(key)) || update.$inc?.revision !== 1 || update.$inc?.__v !== 1 || this.getFilter().status !== "active" || this.getFilter().kind !== "drawer" || !this.getFilter()._id || !Number.isSafeInteger(this.getFilter().revision)) throw new CommandError(409, "Use guarded drawer lifecycle mutations; closed reports are immutable");
});
CashierShiftSchema.pre("bulkWrite", function () { throw new CommandError(409, "Drawer and closing facts cannot be bulk rewritten"); });
CashierShiftSchema.pre("deleteOne", { document: true, query: false }, function () { throw new CommandError(409, "Drawer and closing facts cannot be deleted"); });

CashierShiftSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

CashierShiftSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const CashierShift = mongoose.model("CashierShift", CashierShiftSchema);
