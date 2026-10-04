# Appointment refund reconciliation

Scope: doctor-disruption cancellations with an existing paid invoice. This uses the current Appointment/Invoice/AppointmentPayment models and notification outbox. It does not issue a new refund or retry an ambiguous external write.

## Billing workflow

1. Open the existing billing invoice list. A cancelled visit awaiting a refund has a **Check refund status** action for users with effective `MANAGE_BILLING` authority, on desktop and mobile.
2. The action calls `POST /api/appointment-payments/reconcile-refund` with `{ "appointmentId": "..." }`. Authentication, billing module access, effective billing permission and operational clinic/organization access are required.
3. The backend finds one full captured Razorpay payment or one compatible legacy online invoice receipt. Cash, mixed receipts, unsupported currency and missing/ambiguous references remain for billing review without a provider request.
4. Read the result:

| Result | Meaning / next action |
| --- | --- |
| `processed` | One matching full refund is confirmed processed by the provider. Visit/invoice state, immutable audit and deduplicated notification outbox are committed together. Replays preserve this state. |
| `pending` | The provider is processing the refund. The local visit remains refund_pending. Check later; do not initiate another refund. |
| `review` | Missing, multiple, partial, mismatched, failed or unknown refund evidence. Compare the payment/refund ledger in the provider dashboard and resolve through authorized billing procedures. No new refund was issued. |
| HTTP 502 | Provider read or local confirmation failed. Local financial state stays pending. Refresh/check the ledger; this is not proof that an external refund failed. |

The provider read is bounded to 100 refund records. Only an exactly-one matching full refund may be confirmed automatically; larger or multiple-refund histories require manual review. No amount, provider ID or processed status from the browser is accepted as proof. Do not mark cash/mixed payments refunded through this online reconciliation endpoint.

## Evidence and operational limits

The original cancellation records `REFUND_REQUESTED` before the first provider call. Reconciliation can recover a processed result even when the original response/refund ID was lost, by reading refunds for the verified provider payment ID. Pending IDs and latest known provider statuses are retained in immutable audits. Financial writes require a transaction-capable MongoDB replica set in production.

Provider behavior was checked against the [official payment refund resource](https://github.com/razorpay/razorpay-node/blob/master/lib/resources/payments.js) and [refund status documentation](https://github.com/razorpay/markdown-docs/blob/master/api/refunds/normal-refunds-idempotent.md). Tests use mocked provider evidence and a disposable real MongoDB replica set, including concurrent confirmation, rollback, foreign tenants, revoked grants and malformed evidence. No live provider or real-money flow was exercised.

The existing domain-event worker delivers the confirmed-refund notification. There is no additional refund worker, automatic financial retry, manual status override endpoint or new financial collection. Receipt mismatches and asynchronous provider failures remain human billing decisions.
