import { AsyncLocalStorage } from "node:async_hooks";

// Internal transaction authority only. HTTP input cannot authorize replacing
// enrollment evidence; the service must archive and reconcile it first.
const replacement = new AsyncLocalStorage<{ id: string; revision: number }>();
export function withOfflineDeviceReplacement<T>(id: string, revision: number, write: () => Promise<T>) {
  return replacement.run({ id, revision }, write);
}
export function permitsOfflineDeviceReplacement(filter: Record<string, unknown>, transaction: boolean) {
  const current = replacement.getStore();
  return Boolean(transaction && current && String(filter._id) === current.id && filter.revision === current.revision && filter.status === "revoked");
}
