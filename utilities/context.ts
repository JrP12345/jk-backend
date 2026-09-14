import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  userId?: string;
  organizationId?: string;
  isRoot?: boolean;
  ipAddress?: string;
  userAgent?: string;
}

export const requestContextStore = new AsyncLocalStorage<RequestContext>();

/**
 * Executes an asynchronous function within a scoped RequestContext.
 * Ideal for background workers, automated tests, or scheduled jobs.
 */
export function runWithContext<T>(context: RequestContext, fn: () => Promise<T>): Promise<T> {
  return requestContextStore.run(context, fn);
}

