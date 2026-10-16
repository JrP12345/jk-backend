/** Metadata only: exception messages/stacks/causes may contain patient values,
 * credentials, provider URLs, Mongo filters or submitted validation data.
 * Keep those values out of every ordinary log sink.
 */
export function safeError(error: unknown): { errorType: string; statusCode?: number; databaseCode?: number } {
  const knownNames = new Set(["Error", "TypeError", "RangeError", "ValidationError", "CastError", "MongoServerError", "MongoNetworkError", "MongoBulkWriteError", "AbortError", "TimeoutError", "CommandError", "WorkspaceError"]);
  if (!error || typeof error !== "object") return { errorType: "Error" };
  const value = error as { name?: unknown; statusCode?: unknown; code?: unknown };
  return {
    errorType: typeof value.name === "string" && knownNames.has(value.name) ? value.name : "Error",
    ...(typeof value.statusCode === "number" && Number.isInteger(value.statusCode) && value.statusCode >= 400 && value.statusCode <= 599 ? { statusCode: value.statusCode } : {}),
    ...(typeof value.code === "number" && [11000, 112, 50, 91, 251].includes(value.code) ? { databaseCode: value.code } : {}),
  };
}
