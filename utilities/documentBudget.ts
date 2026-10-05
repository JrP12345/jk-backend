import mongoose, { Schema } from "mongoose";

/** Bound embedded histories without discarding any existing clinical records. */
export function documentBudget(schema: Schema, limits: Record<string, number>) {
  schema.pre("validate", function(this: any) {
    for (const [path, limit] of Object.entries(limits)) {
      if ((this.get(path)?.length || 0) > limit) throw Object.assign(new Error(`Embedded ${path} limit reached; retain history and use a new record`), { statusCode: 409 });
    }
    if (mongoose.mongo.BSON.calculateObjectSize(this.toObject({ virtuals: false, getters: false })) > 8 * 1024 * 1024) throw Object.assign(new Error("Document growth budget exceeded"), { statusCode: 409 });
  });
  for (const method of ["updateOne", "updateMany", "findOneAndUpdate"] as const) {
    schema.pre(method, function(this: any) {
      const update = this.getUpdate();
      if (!update || Array.isArray(update)) return;
      for (const [path, limit] of Object.entries(limits)) {
        const replacement = update.$set?.[path] ?? update[path];
        if (Array.isArray(replacement) && replacement.length > limit) throw Object.assign(new Error(`Embedded ${path} limit reached`), { statusCode: 409 });
        const append = update.$push?.[path] ?? update.$addToSet?.[path];
        if (append !== undefined) {
          const size = append?.$each ? append.$each.length : 1;
          // Atomic count predicate also protects concurrent appenders.
          this.setQuery({ $and: [this.getFilter(), { $expr: { $lte: [{ $size: { $ifNull: [`$${path}`, []] } }, limit - size] } }] });
        }
      }
    });
  }
}
