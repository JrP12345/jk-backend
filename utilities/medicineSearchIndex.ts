import type { Schema } from "mongoose";

export const medicineSearchFields = ["name", "genericName", "strength", "manufacturer"] as const;
export const normalizeMedicineSearch = (value: string) => value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");

/** Small literal substring keys, with an exact normalized residual match at read time. */
export function medicineSearchValue(input: unknown) {
  const value = normalizeMedicineSearch(typeof input === "string" ? input : "");
  const letters = Array.from(value), grams = new Set<string>();
  for (let size = 1; size <= 3; size++) for (let at = 0; at + size <= letters.length; at++) grams.add(letters.slice(at, at + size).join(""));
  return { value, grams: [...grams] };
}
export const medicineSearchAnchor = (term: string) => Array.from(term).slice(0, 3).join("");

type Write = Record<string, any>;
function projectDocument(document: Write) {
  document.searchIndex = Object.fromEntries(medicineSearchFields.map(field => [field, medicineSearchValue(document[field])]));
}
function projectUpdate(update: Write, replacement = false) {
  // No current medicine writer uses pipelines. Reject them rather than silently corrupt derived keys.
  if (Array.isArray(update)) throw new Error("Medicine update pipelines are not supported");
  if (replacement) { projectDocument(update); return; }
  for (const [operator, values] of Object.entries(update)) {
    if (!values || typeof values !== "object") continue;
    for (const path of Object.keys(values)) {
      if (path === "searchIndex" || path.startsWith("searchIndex.")) throw new Error("Medicine search keys are derived from catalogue fields");
      if (medicineSearchFields.some(field => path === field || path.startsWith(`${field}.`)) && !["$set", "$unset", "$setOnInsert"].includes(operator)) throw new Error("Catalogue search fields require a literal assignment");
      if (operator === "$rename" && medicineSearchFields.includes(values[path])) throw new Error("Catalogue search fields cannot be renamed");
    }
  }
  for (const field of medicineSearchFields) {
    if (Object.hasOwn(update, field)) {
      update.$set ??= {}; update.$set[field] = update[field]; delete update[field];
    }
    if (Object.hasOwn(update.$set || {}, field) || Object.hasOwn(update.$unset || {}, field)) {
      update.$set ??= {};
      update.$set[`searchIndex.${field}`] = medicineSearchValue(Object.hasOwn(update.$unset || {}, field) ? "" : update.$set[field]);
    } else if (Object.hasOwn(update.$setOnInsert || {}, field)) {
      update.$setOnInsert[`searchIndex.${field}`] = medicineSearchValue(update.$setOnInsert[field]);
    }
  }
}

/** Independent per-field projections avoid read/modify/write races on concurrent renames.
 * Stock, price and authority writes pass through without reads or index changes.
 */
export function installMedicineSearchIndex(schema: Schema) {
  schema.pre("validate", function(this: any) {
    for (const field of medicineSearchFields) if (this.isNew || this.isModified(field)) this.set(`searchIndex.${field}`, medicineSearchValue(this.get(field)));
  });
  schema.pre("insertMany", function(documents: Write[]) { for (const document of documents) projectDocument(document); });
  for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"] as const) schema.pre(operation, function() {
    const update = this.getUpdate(); if (update) { projectUpdate(update, operation === "replaceOne" || operation === "findOneAndReplace"); this.setUpdate(update); }
  });
  schema.pre("bulkWrite", function(operations: Write[]) {
    for (const operation of operations) {
      if (operation.insertOne) projectDocument(operation.insertOne.document);
      if (operation.replaceOne) projectUpdate(operation.replaceOne.replacement, true);
      for (const kind of ["updateOne", "updateMany"]) if (operation[kind]) projectUpdate(operation[kind].update);
    }
  });
}
