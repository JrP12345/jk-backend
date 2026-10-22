import mongoose, { Schema } from "mongoose";

// Global reservation avoids collisions between branches with the same ObjectId suffix.
const schema = new Schema({
  locationId: { type: Schema.Types.ObjectId, ref: "Location", required: true, unique: true },
  series: { type: String, required: true, unique: true, match: /^[0-9A-Z]{4}$/ },
  version: { type: Number, default: 2, immutable: true },
});
schema.pre("save", function () { if (!this.isNew) throw new Error("Invoice series reservations are immutable"); });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) {
  schema.pre(operation, function () { throw new Error("Invoice series reservations are immutable"); });
}
schema.pre("bulkWrite", function () { throw new Error("Invoice series reservations are immutable"); });
schema.pre("deleteOne", { document: true, query: false }, function () { throw new Error("Invoice series reservations are immutable"); });
export const InvoiceSeries = mongoose.model("InvoiceSeries", schema);
