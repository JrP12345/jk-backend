import type { Connection } from "mongoose";

/** Restrict schema resets and sample data to an explicitly confirmed local development database. */
export function developmentDatabaseName(uri: string, args: readonly string[], environment: string | undefined): string {
  if (environment !== "development") throw new Error("Development data commands require NODE_ENV=development");
  const parsed = new URL(uri);
  if (parsed.protocol !== "mongodb:" || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
    throw new Error("Development data commands only accept a local MongoDB instance");
  }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!/^ekavyu_(dev|test)(?:_[a-z0-9]+)*$/.test(database)) throw new Error("Use an explicitly named ekavyu_dev or ekavyu_test database");
  if (!args.includes(`--confirm-database=${database}`)) throw new Error("Confirm the exact development database name");
  return database;
}

export async function assertDevelopmentDatabaseEmpty(connection: Connection): Promise<void> {
  if (!connection.db) throw new Error("Development database is not connected");
  const collections = await connection.db.listCollections({}, { nameOnly: true }).toArray();
  for (const collection of collections) {
    if (await connection.db.collection(collection.name).findOne({}, { projection: { _id: 1 } })) {
      throw new Error("Seed requires an empty development database. Preview and explicitly apply reset:development first.");
    }
  }
}
