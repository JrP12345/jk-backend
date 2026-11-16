import { AsyncLocalStorage } from "node:async_hooks";

/** Internal transaction authority, never populated from a header or request body.
 * Only a service that has verified device evidence may enter this context.
 */
export interface OfflineOwnershipContext { organizationId: string; locationId: string; authorityId: string; drawerId: string }
const ownership = new AsyncLocalStorage<Readonly<OfflineOwnershipContext>>();
export function withVerifiedOfflineOwnership<T>(scope: OfflineOwnershipContext, write: () => Promise<T>) {
  return ownership.run(Object.freeze({ ...scope }), write);
}
export function offlineOwnerFilter(locationId: string) {
  const context = ownership.getStore();
  return { pharmacyOfflineOwner: context?.locationId === locationId ? context.authorityId : { $exists: false } };
}
export function offlineDrawerFilter(locationId: string) { return offlineOwnerFilter(locationId); }
export function ownsOfflineDrawer(drawerId: string, locationId: string) {
  const context = ownership.getStore();
  return Boolean(context && context.drawerId === drawerId && context.locationId === locationId);
}
