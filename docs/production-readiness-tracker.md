# Backend operational release gates

Current source requirements, 2026-10-07. Local cleanup evidence is recorded in [pre-production-cleanup.md](pre-production-cleanup.md). Historical test totals are not a current release certification.

## Required environment and deployment

- Node 24; install build dependencies, compile, then start the built API. Production build does not run tests or connect to MongoDB. Four workers are domain-event, notification, outbound-message and disruption-timeout. Each requires its own health/ready monitoring (ports 5001-5004); API readiness does not prove worker progress.
- Transaction-capable, authenticated MongoDB with TLS/restricted ingress and reviewed uniqueness/TTL indexes. Use db:indexes preview before controlled index creation; review conflicting rows separately. Development schema changes use reset and fresh seeds.
- Persistent RS256 keys, DATA_ENCRYPTION_KEY and explicit PRESCRIPTION_SIGNING_KEY. Same keys/configuration must be available to relevant replicas and workers. Root requires fresh encrypted MFA enrollment. Immutable audit chains and signatures must never be rewritten through ordinary cleanup.
- Authenticated private Redis for multiple replicas. Missing/malformed/loopback production Redis fails startup/readiness; ALLOW_SINGLE_NODE_IN_PRODUCTION is explicit for a single API instance only. Configure exact proxy trust, origin verification, allowed origins and cookie scope for the real ingress.

## Provider and file evidence

Verify Razorpay signed callbacks, captures, pending/processed refunds and uncertain-response reconciliation using synthetic records and provider sandbox credentials. No automatic replay of ambiguous financial writes. Match platform/tenant provider modes and accounts.

Verify Meta WABA/phone ownership, signed webhooks, approved templates, delivery/retry/opt-out behavior and test recipients. Configure validated SMTP TLS/sender DNS. SMS has no live provider adapter; do not promise SMS delivery. Configure Google audience/redirect and WebAuthn RP ID/origin; exercise hardware passkeys and MFA. Optional SSO requires signed audience-bound, short-lived one-use assertions.

R2 stays private with least-privileged grants and restricted CORS. Verify signed size/type, patient-bound intent registration, private download authorization and staging cleanup. contentValidationPassed is byte/type validation; malwareClean=false does not claim antivirus scanning. Provision the required scanning/quarantine policy. Clinical AI remains disabled until payload/provider privacy review is supported by evidence. ABDM enrollment remains sandbox-only; private video/PACS bridges require deployment validation.

## Recovery, monitoring and capacity

Monitor API and each worker, process exits, queue age, retries/dead letters, callback failures and unresolved financial reviews. Configure independent external alerts; redact clinical data and tracker capabilities in hosting/CDN logs. Private APIs, trackers and authenticated clinical pages must not be publicly cached.

Use provider/PITR or BSON-native backup as primary recovery. Rehearse an isolated restore including keys, PHI decryption, audit integrity, relationships, indexes, auth/booking/clinical/billing/upload journeys and worker restart. Record RPO/RTO, off-site/object-lock access, alert delivery and recovery ownership. The supplemental archive's count/index drill alone does not verify application recovery.

Budget Mongo connections across API (min 2/max 30 defaults), workers (min 0/max 5 each) and driver monitoring. Use measured p95/p99 latency, RSS, CPU, pool checkout failures and queue age before scaling. Keep bounded histories/results and measured index plans. Test coordinated API/frontend/worker rollback without restoring unsafe deletion or replay behavior.

## Release verification

CI retains full types, tests, architecture/security checks and bundle builds; run install/startup and provider-boundary probes when their contracts change. Hosted CI, designated authenticated browser journeys, deployed workers, real restore, load baseline and rollback evidence remain required. No live reset, seed, provider operation, cloud provisioning or deployment was performed by source cleanup.
