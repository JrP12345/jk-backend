import { verifyEnv } from "./config.ts";
import { getServerPort } from "./serverPort.ts";

// Run before importing the database, providers or application routes. Calling
// verifyEnv in index.ts's body is too late under ESM dependency evaluation.
getServerPort();
verifyEnv();
