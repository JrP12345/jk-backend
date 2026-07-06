import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  userId?: string;
}

export const requestContextStore = new AsyncLocalStorage<RequestContext>();
