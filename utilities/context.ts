import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  userId?: string;
  organizationId?: string;
  ipAddress?: string;
  userAgent?: string;
}

export const requestContextStore = new AsyncLocalStorage<RequestContext>();
