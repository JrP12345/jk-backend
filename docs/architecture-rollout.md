# Architecture remediation rollout

The repository fixes preserve the modular monolith, MongoDB transactions, existing Redis coordination and durable outboxes. Repository verification is separate from deployed production evidence.

## Deployment sequence

1. Take and verify a BSON-preserving provider snapshot/PITR restore point. Retain persistent encryption, prescription signing and JWT verification keys in the secret manager. Pause write traffic and workers for the index rollout; retain the previous immutable image tags.
2. For development records using superseded schemas, use the guarded [reset and reseed lifecycle](development-data.md). Existing clinical, financial and audit authority requires reviewed reconciliation; index preparation never deletes those records.
3. Deploy API and four consumers: domain events, notifications, outbound messages/webhooks (also billing reconciliation and upload cleanup), disruption timeouts. Remove the inactive no-show container. Keep `RUN_INLINE_JOBS=false` when dedicated consumers are deployed. Compose gives processes 60 seconds to stop; consumers stop accepting batches immediately and drain concurrently for at most 45 seconds. The API/outbound process deadline is 55 seconds; durable leases recover abandoned work.
4. Preview with `npm run db:indexes`, then apply with `npm run db:indexes -- --writes-paused --apply` against the intended database and record the resulting index definitions. Index application neither resets data nor drops existing indexes. Inspect unexpected indexes and duplicate-key failures before reopening writes. Development reset recreates the canonical schema from an empty database.
5. Check API readiness plus every consumer's `/ready`, lease progress, oldest pending age, dead letters, provider errors and pool occupancy. Workers cannot issue JWTs: use `WORKLOAD_ROLE=worker` with only the verification key. Provision workload-specific DB/storage/provider credentials and grants. Shared Compose/environment-group inheritance is a convenience, not evidence of least privilege at the provider.
6. Enroll and verify every platform root in MFA before reopening access. Confirm organization suspension closes sessions, a clinical draft can be saved twice and signed correctly, checkout/installment replay posts one payment, clinical documents register/download, and queue reconnect reloads current state. Test tenant-denial cases and payment reconciliation using the provider sandbox.
7. Roll back application images together if a gate fails; keep new additive indexes and operation receipts. Do not restore unsafe deletion, TTL cleanup or payment replay behavior. Requests without expectedRevision/Idempotency-Key receive a visible precondition error; deploy the current frontend with the API. Review data repair separately from code rollback.

Render definitions use the existing `jk-production` environment group. Create/provision it and match existing service names before blueprint adoption; no keys are generated or rotated by this change. Configure worker health monitoring externally: background workers do not provide the web-service health routing. [Render blueprint specification](https://render.com/docs/blueprint-spec).

## Recovery evidence

Use provider snapshots/PITR or BSON-native tooling as primary recovery. The custom archive is a small supplemental export: actual export requires `--writes-paused`, has a 64 MiB default data budget, preserves canonical EJSON and index options, and cannot guarantee consistency while writes continue. Pause ALL writers, including workers, for the whole export. Its restore drill checks counts, indexes and BSON samples in an isolated database; it explicitly reports `applicationRecoveryVerified=false`.

A real rehearsal additionally restores encryption keys, decrypts sampled PHI and outbox payloads, verifies per-organization audit chains, validates relationships and uniqueness, boots API/consumers against the isolated restore, and completes auth/clinical/billing/upload journeys with provider sandbox credentials. Record backup age/RPO, full RTO including key retrieval, off-site/object-lock access, independent credentials, monitoring alert delivery, and cutover/rollback results. No production restore or backup ran as a local test.

## Capacity, privacy and cost

API pool defaults to min 2/max 30; each worker min 0/max 5. Budget total connections across all instances plus monitoring sockets against provider limits. Start with one API and one of each consumer; grow only from measured p95/p99 latency, CPU/RSS, pool checkout failures and queue age. Worker idle polling backs off to 15 seconds; scheduled jobs retain their longer cadence. Metrics use fixed buckets and route templates and never record Mongo commands/PHI.

Module configuration is memoized only during one request. Shared active prompts cache for 30 seconds (local approval invalidates immediately; other nodes converge within TTL). Context metrics cache is bounded to 100 entries. No new general patient-record cache is introduced. Timeline returns bounded source windows; keyword filtering can produce an empty page with a valid next cursor. Follow `hasMore`/`nextCursor`; `totalCount` is the current page count, not historical cardinality. Search indexes/keyset catalog pagination should follow measured query latency.

Clinical AI stays disabled in production until `CLINICAL_AI_PAYLOAD_REVIEWED=true` is backed by provider/data-flow review. The complete compiled context/history/system payload passes privacy screening; pattern matching still cannot prove arbitrary narrative is anonymous. ABDM enrollment/lookup remains sandbox-only. Upload `contentValidationPassed` means size/type/magic-byte validation; `malwareClean=false` is honest and does not claim an antivirus scan. Decide and provision the required scanning/quarantine policy, private bucket grants/lifecycle rules and CDN exclusion before rollout.

AI provider calls combine deadlines with request cancellation; an unfinished client disconnect aborts provider reads and does not retry another provider. Production OTP requests report failure when the provider declines delivery and expire the undelivered code. Cleanup includes unregistered quarantined uploads, retries failed storage deletion without losing metadata, and excludes registered authority and live verification leases. Queue metrics deliberately cover unfinished/dead-letter work, excluding historical sent rows; current `sentCount` is zero in this bounded view and `countsCapped` flags truncated pending totals. Use delivery counters/provider monitoring for historical throughput.

New MRNs include the full organization identifier; existing identifiers remain unchanged. Multiple staff memberships fail with an explicit unsupported-selection response until a real organization-selection workflow is required. Embedded histories reject growth at their budgets; retain records and normalize the affected history before the limit is reached. Do not truncate clinical or financial history.

## Operational gates still requiring evidence

- Current database/index preparation, consumer deployment/health, root enrollment, cloud/provider permissions and malware/privacy policy.
- Independent off-site recovery/decryption with RPO/RTO and externally monitored failures.
- Review immutable per-organization audit chains/checkpoints before accepting a migrated chain head; this change does not rewrite historical hashes or automatically repair old authority.
- Deployed browser journeys, load baseline, capacity limits and rollback rehearsal.

Microservices, Kafka, Kubernetes, CQRS, sharding and extra infrastructure remain deferred until measured requirements justify them.
