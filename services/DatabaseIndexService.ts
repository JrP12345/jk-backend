import type { Model } from "mongoose";
import { isDeepStrictEqual } from "node:util";

type Key = Record<string, unknown>;
export type DatabaseIndexModel = Model<any, any, any, any, any, any, any>;
export interface DatabaseIndexIssue { model: string; collection: string; kind: "missing_collection" | "missing_index" | "index_options_conflict" | "unexpected_unique_index" | "unexpected_ttl_index"; index: string; action: string }
export interface DatabaseIndexReadiness { ready: boolean; models: number; expectedIndexes: number; issues: DatabaseIndexIssue[] }
export class DatabaseIndexSetupError extends Error {
  public report?: DatabaseIndexReadiness;
  constructor(message: string, report?: DatabaseIndexReadiness) { super(message); this.name = "DatabaseIndexSetupError"; this.report = report; }
}
const ordered = (value: Key) => JSON.stringify(Object.entries(value));
const name = (key: Key) => Object.entries(key).map(([field, direction]) => `${field}_${String(direction)}`).join("_");
function sameKey(expected: Key, actual: Key, options: Key, actualOptions: Key) {
  const text = Object.entries(expected).filter(([, value]) => value === "text").map(([field]) => field).sort();
  if (!text.length) return ordered(expected) === ordered(actual);
  if (actual._fts !== "text" || actual._ftsx !== 1) return false;
  const weights = actualOptions.weights as Key | undefined;
  if (!weights || JSON.stringify(Object.keys(weights).sort()) !== JSON.stringify(text)) return false;
  if (text.some(field => weights[field] !== ((options.weights as Key | undefined)?.[field] ?? 1))) return false;
  return ordered(Object.fromEntries(Object.entries(expected).filter(([, direction]) => direction !== "text"))) === ordered(Object.fromEntries(Object.entries(actual).filter(([field]) => !["_fts", "_ftsx"].includes(field))));
}
function sameOptions(expected: Key, actual: Key) {
  if (Boolean(expected.unique) !== Boolean(actual.unique) || Boolean(expected.sparse) !== Boolean(actual.sparse) || Boolean(expected.hidden) !== Boolean(actual.hidden)) return false;
  if (!isDeepStrictEqual(expected.partialFilterExpression ?? null, actual.partialFilterExpression ?? null) || (expected.expireAfterSeconds ?? null) !== (actual.expireAfterSeconds ?? null)) return false;
  if ((actual.key as Key)?._fts === "text" && ((expected.default_language ?? "english") !== (actual.default_language ?? "english") || (expected.language_override ?? "language") !== (actual.language_override ?? "language"))) return false;
  const collation = expected.collation as Key | undefined, stored = actual.collation as Key | undefined;
  if (!collation || collation.locale === "simple") return !stored || stored.locale === "simple";
  return Boolean(stored && Object.entries(collation).every(([key, value]) => isDeepStrictEqual(value, stored[key])));
}
export function currentSchemaIndexManifest(models: DatabaseIndexModel[]) {
  return [...models].sort((a, b) => a.modelName.localeCompare(b.modelName)).map(model => ({ model: model.modelName, collection: model.collection.name,
    indexes: model.schema.indexes().map(([key, options]) => ({ key, options })) }));
}

/** Read index metadata only. Never initialize models, inspect records, or change indexes. */
export async function inspectDatabaseIndexes(models: DatabaseIndexModel[]): Promise<DatabaseIndexReadiness> {
  const issues: DatabaseIndexIssue[] = [];
  let expectedIndexes = 0;
  for (const model of [...models].sort((a, b) => a.modelName.localeCompare(b.modelName))) {
    const expected = model.schema.indexes(), collection = model.collection.name;
    expectedIndexes += expected.length;
    let actual: Key[];
    try { actual = await model.collection.listIndexes({ maxTimeMS: 8000 }).toArray(); }
    catch (error) {
      if ((error as { code?: number }).code !== 26) throw new DatabaseIndexSetupError(`Cannot inspect ${model.modelName} indexes. Check the selected database and metadata permissions; connection/record details are omitted.`);
      issues.push({ model: model.modelName, collection, kind: "missing_collection", index: "_id_", action: "Run explicit current-schema setup for this selected database before enabling writes." });
      continue;
    }
    const matched = new Set<string>();
    for (const [key, options] of expected) {
      const candidates = actual.filter(index => sameKey(key, index.key as Key, options, index));
      const compatible = candidates.find(index => sameOptions(options, index) && (!options.name || index.name === options.name));
      if (compatible) { matched.add(String(compatible.name)); continue; }
      for (const candidate of candidates) matched.add(String(candidate.name));
      issues.push({ model: model.modelName, collection, kind: candidates.length ? "index_options_conflict" : "missing_index", index: String(options.name || name(key)),
        action: candidates.length ? "Review the stale development index options explicitly; setup will not drop or replace it." : "Run explicit current-schema setup with writes paused; no source records need a backfill." });
    }
    for (const index of actual) {
      if (index.name === "_id_" || matched.has(String(index.name))) continue;
      if (index.unique || index.expireAfterSeconds !== undefined) issues.push({ model: model.modelName, collection,
        kind: index.unique ? "unexpected_unique_index" : "unexpected_ttl_index", index: String(index.name), action: "Review this undeclared constraint/expiry index explicitly in the selected development database. No automatic removal is allowed." });
    }
  }
  return { ready: issues.length === 0, models: models.length, expectedIndexes, issues };
}

/** Operator-only setup. No application request calls this; never sync/drop indexes or records. */
export async function prepareDatabaseIndexes(models: DatabaseIndexModel[]): Promise<DatabaseIndexReadiness> {
  const before = await inspectDatabaseIndexes(models);
  if (before.issues.some(issue => !["missing_collection", "missing_index"].includes(issue.kind))) throw new DatabaseIndexSetupError("Current schema setup is blocked by stale index constraints. Review the readiness report; no indexes or records were removed.", before);
  for (const model of [...models].sort((a, b) => a.modelName.localeCompare(b.modelName))) {
    try { await model.createCollection(); await model.createIndexes(); }
    catch {
      throw new DatabaseIndexSetupError(`Cannot prepare ${model.modelName}. Check source duplicates or index/collection options in the selected development database. Earlier missing indexes may have been created; no records or indexes were removed.`);
    }
  }
  const after = await inspectDatabaseIndexes(models);
  if (!after.ready) throw new DatabaseIndexSetupError("Current schema readiness is incomplete. Keep writes paused and review the report.", after);
  return after;
}
