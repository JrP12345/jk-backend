# Subscription reconciliation lookup failures

`billing.reconcile.failed` comes from `jobs/billingReconciliationJob.ts`, not appointment refund reconciliation. The job wakes every five minutes, selects subscription payments older than two minutes, and retries created/failed orders after fifteen minutes or abandoned orders after one day. A failed lookup previously only changed `lastReconciledAt`, so the same unavailable order remained eligible indefinitely.

The request path `/v1/orders/{orderId}/payments` matches [Razorpay's official SDK](https://github.com/razorpay/razorpay-node/blob/master/lib/resources/orders.js). A 404 means that request could not resolve the order; it does not establish that no money was captured. Explicit `order_sim_` and `order_test_` references are local simulation identifiers. Other missing provider orders may be invalid references or belong to another provider account/test-live mode; the supplied logs do not distinguish those causes. Credentials can come from the platform gateway configuration before environment-variable fallback.

## Scheduling correction — 2026-10-04

- Exclude known simulation prefixes before the batch limit; keep those records intact. Real Razorpay test-mode orders remain eligible because they use actual gateway order IDs, not local `order_test_` fixture IDs.
- On HTTP 404, retain financial status and record `reconciliationIssue: provider_order_not_found`, `lastReconciledAt` and `reconcileAfter` one day ahead. Log `billing.reconcile.deferred` with the next attempt time instead of repeating a fifteen-minute error.
- Keep transient failures on the existing cadence. Existing HTTP classification prevents client 404s from opening the provider circuit.
- Explicit reconciliation still bypasses the background deferral. A successful provider read clears the issue/deferral, whether it returns a capture or no captured payment. Existing capture validation and activation remain authoritative.
- Optional scheduling fields require no data or index migration. Records missing them retain their normal eligibility. No payment/subscription/invoice is deleted or marked paid/failed to suppress a log.

Verification: `billingReconciliationJob`, `billingAndSubscription` and `resilientHttpClient` pass 27 cases across three files, including provider/simulation selection, 24-hour deferral, explicit recovery, transient retries, terminal states, lost callbacks and 404 circuit behavior. Backend TypeScript and API/four-worker build pass. Tests use disposable MongoDB and mocked provider reads. No configured database cleanup or live provider verification was performed.

Review genuine unresolved orders against the account and mode that created them before changing payment records. Restart an API using a static bundle after rebuilding; the development watcher normally reloads imported source changes.
