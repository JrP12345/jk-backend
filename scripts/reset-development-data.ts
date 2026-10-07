import mongoose from "mongoose";
import { developmentDatabaseName } from "./developmentDatabase.ts";

/** Explicit local-development reset for a schema change. Never invoked by startup. */
export async function resetDevelopmentData(uri: string, args: readonly string[], environment: string | undefined) {
  const database = developmentDatabaseName(uri, args, environment);
  const connection = await mongoose.createConnection(uri, { autoIndex: false }).asPromise();
  try {
    const collections = await connection.db!.listCollections({}, { nameOnly: true }).toArray();
    console.log(JSON.stringify({ database, collections: collections.map(item => item.name), apply: args.includes("--apply") }));
    if (!args.includes("--apply")) return;
    if (!args.includes("--writes-paused")) throw new Error("Stop development API and workers before resetting data");
    await connection.dropDatabase();
    console.log("Development data reset. Run the current seed before restarting the API and workers.");
  } finally {
    await connection.close();
  }
}

if (process.argv[1]?.endsWith("reset-development-data.ts")) {
  resetDevelopmentData(process.env.MONGODB_URI || "", process.argv.slice(2), process.env.NODE_ENV)
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
