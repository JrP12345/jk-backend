# SaaS billing flow

The commercial subscription uses Razorpay **Orders** and Standard Checkout. It does not use Razorpay's recurring Subscriptions API. Renewal is a deliberate new Order. Patient invoice payments use separate routes and records.

## Authority and IDs

`/api/billing/*` requires `MANAGE_ORGANIZATION`. A normal administrator's organization comes from the authenticated `organization_id`; a mismatched body or query organization is rejected. Platform Root can select an organization. A Root impersonation session is limited to its signed organization context. Browser headers and selected clinic preferences do not determine billing scope.

The browser submits only plan ID and billing cycle. The server fetches the active plan and quotes its stored INR price plus rounded 18% GST. It sends total rupees as integer paise to Razorpay. `SubscriptionPayment._id` is the internal attempt ID, `razorpayOrderId` is the provider Order ID, `razorpayPaymentId` is the provider payment ID, `subscriptionId` is the internal entitlement record, and `SaaSInvoice.paymentId` links the invoice to the internal attempt. No provider subscription or provider invoice ID is used.

`GET/PUT /api/billing/details` reads and saves the selected organization's invoice GSTIN, email, and address under the same tenant authorization. New invoices copy those fields at capture time, falling back to the organization's existing tax/contact fields until billing details are first saved. Older invoice snapshots are preserved.

## State transitions

| Payment state | Cause | Entitlement |
| --- | --- | --- |
| `created` | Server quote, provider Order, and payment row committed | Existing plan remains |
| `created` with `failureReason` | `payment.failed` for an attempt on the Order | Existing plan remains; Order may be retried |
| `abandoned` | Authorized user closes the unpaid attempt after provider status check | Existing plan remains; late capture remains eligible for reconciliation |
| `captured` | Signed callback plus provider fetch, signed `payment.captured` webhook, or provider reconciliation | Subscription and organization updated once; invoice recorded |
| `captured_review` | Captured older Order after a newer plan change | Invoice and payment recorded; current entitlement preserved for Root review/refund |
| `refunded` | Root refund of a captured provider payment | Invoice marked refunded; entitlement requires explicit operational review |

The subscription remains `trialing` or `active` while an Order is open. A failed payment attempt does not set the subscription to `payment_failed`. Expiry is calculated from stored UTC instants and applied when read. Same-plan paid renewal starts at the later current expiry; a different plan starts when payment is captured and does not prorate unused time. Free-plan switching also starts immediately. Month and year additions clamp to the last valid UTC calendar day.

## Delivery and recovery

Checkout sends the provider callback's Order ID, payment ID and signature to `/api/billing/verify-payment`. The server uses its stored Order ID for HMAC validation and fetches the payment to confirm captured state, Order, amount, and INR currency. `/api/billing/webhook` validates Razorpay's HMAC against the raw request body and processes only `payment.captured` and `payment.failed`. `payment.captured` and callback verification call the same transactional activation code. Replays return the existing invoice without extending the plan again.

`GET /api/billing/checkout-status` fetches provider payments for the organization's outstanding Order and activates a captured payment when the browser callback was lost. A job repeats this check for old `created`, `failed`, or `abandoned` attempts every five minutes in deployments with inline jobs enabled. Deployments without inline jobs must run an equivalent worker. Checkout reservations and client intent IDs prevent concurrent order creation for one organization and repeated submission of the same purchase intent. Users can resume an unpaid Order or abandon it to select another plan.

## Deployment checks

- Configure one matching Razorpay key pair and webhook secret for the intended test or live mode. The configured mode must match the `rzp_test_` or `rzp_live_` Key ID. The server never returns the secret to the browser.
- Set the dashboard webhook URL to the backend `/api/billing/webhook`; enable `payment.captured` and `payment.failed`. Enable automatic payment capture for Orders. Send a test payment and verify the provider delivery, internal payment, invoice, and entitlement.
- Use a transaction-capable MongoDB replica set in production. Check that the billing reconciliation worker is running (`RUN_INLINE_JOBS=true` for the inline deployment).
- Review `captured_review` payments in the Root billing console. Resolve each by inspecting the provider payment and invoice before granting access or refunding. Do not change the current plan merely because an older Order was paid late.
- Reconcile open Orders before rotating Razorpay credentials. Rotation while outstanding Orders exist is rejected by the admin endpoint.

Live dashboard settings, webhook reachability, and a real provider payment cannot be verified by repository tests alone.
