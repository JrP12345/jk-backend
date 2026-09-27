# Outbound HTTP reliability

utilities/resilientHttpClient.ts provides deadlines, method-aware retries,
provider circuit breakers, correlation headers and in-process metrics for its
callers. This does not cover every external request: WhatsApp and AI have their
own adapters, email uses SMTP, and storage uses the AWS SDK.

Retries require a safe operation or a provider-supported idempotency contract.
An application idempotency key alone cannot prove that a provider deduplicates
requests. Check the provider adapter before enabling mutation retries.

WhatsApp message POSTs are attempted once per dispatch. Network uncertainty and
recovered sending intents remain ambiguous; do not automatically resend them.
Meta acceptance is accepted, and verified delivery callbacks advance the state.
See whatsapp-setup.md for consent, template and ledger behavior.

Payment settlement uses verified callbacks, server-side amounts and transactional
updates. Operator reconciliation must consult the gateway before repeating a
payment action. There is no universal AMBIGUOUS_PENDING_RECONCILIATION database
status; inspect each service's persisted fields and supported recovery procedure.

Local circuit breakers and metrics reset with the process. Validate failures,
timeouts and provider behavior in staging before release; they are not evidence
of a successful real payment or delivery.
