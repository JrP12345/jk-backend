# Ekavyu production security, scalability and performance audit

Audit date: 2026-09-27. Backend revision: `5a3d0b5`; frontend revision:
`7302d9f`. This document records an audit, not implemented remediation or a
production certification. Application code, deployment settings and production
data were not changed during the audit. The authorized implementation progress
below records subsequent local changes separately from the original findings.

## Remediation progress — 2026-09-27

First implementation group: account identity, tenant isolation and role authority.
These changes are local and have not been committed, pushed or deployed.

| Finding | Local implementation | Compatibility / release notes |
| --- | --- | --- |
| C01 | Anonymous booking no longer changes an existing account's email, phone or name, links an email-only account to a supplied phone, or adds dependents to an existing account. Unverified contact email stays on a new booking profile. Guest bookings use their server-issued patient capability | Guest booking, refresh and booking-only access remain available. An unmatched name on an existing phone creates an unclaimed walk-in profile rather than a trusted dependent. Review historical account-contact attachments separately; existing production records were not rewritten |
| C02 | Analytics validates selected clinic ownership before querying and explicitly scopes invoice/appointment aggregation by organization. Empty explicitly scoped root views stay empty | Global root analytics remain available when no organization is selected. Existing endpoint/response shape retained |
| C03 | AI organization lookup never falls back to other tenants. Empty clinic sets remain empty. Financial context requires effective server-side permissions and organization authority; a route string cannot grant access | Authorized financial AI context retained. Cached context is separated by organization and permitted context type; restart the API as part of release to discard old process caches |
| H03 | Role creation/update/deletion requires an authorized organization scope. Tenant updates create overrides instead of modifying global roles. Listings prefer the tenant override | Global changes require a root caller operating without tenant scope. Built-in role deletion remains prohibited. Existing custom role names and API routes retained; review already-modified global roles without blanket seed replacement |
| H04 | Explicitly empty role permissions deny access. Shared Redis generation keys prevent reload of old grants after invalidation; model hooks await invalidation | Missing built-in definitions still use existing defaults. Redis cache test uses an isolated fake shared store with missed Pub/Sub delivery; real Redis outage/recovery and replica testing remain release checks. Complete the rollout across replicas before treating old cache consumers as retired |
| H05 | Consumers cannot fall through to staff organization access. AI active-patient context checks effective clinical permissions and patient ownership before chart assembly | Self and active family relationships remain valid. AI prescription/lab/appointment reads retain an explicit organization scope; approved cross-organization timeline flows were not rewritten |

Regression coverage includes takeover attempts, email-only account linking,
legacy phone spelling, complete guest booking of an unclaimed profile, guest
patient-ID substitution, foreign and inconsistent clinic/org invoices, root
scope, empty-tenant AI, nurse financial denial, self/family chart access, role
overrides and retained shared-cache grants.

Validation: 71 tests passed across 12 suites (`productionSecurityRemediation`,
`permissionCacheRevocation`, `role`, `rbac`, `auth`, `contextEngineV2`,
`tenantRouteMatrix`, `browseBookingSecurityPolish`, `securityAndSafetyHardening`,
`aiGatewayAndPipelines`, `aiChatPersistence`, `aiValidationAndSecurity`). Backend
TypeScript checking passed, and the production build verified the API plus all
five worker bundles. These checks use throwaway databases and a fake shared Redis
cache; they do not execute real provider transactions or certify a live rollout.
After final review adjustments, the 15 booking/remediation tests were rerun and
passed; backend TypeScript and the six-bundle build passed again.

Remaining P0 work: H01/H02 authentication and distributed session revocation;
H06/H09/H10 billing authority, signature verification and settlement integrity;
H07 file handling; H08 deployed signing-key retirement verification. P1–P3 and
live operational checks remain open. No production-readiness approval is implied.

## 1. Executive Summary

**Do not approve a paying-customer rollout yet.** Confirmed account takeover,
cross-tenant financial disclosure, broken payment verification and inconsistent
authorization outweigh the existing hardening and passing tests.

The architecture is appropriate for the current scale: separate Next.js/React
frontend and Fastify/TypeScript backend, MongoDB/Mongoose, signed access tokens,
hashed refresh tokens, optional Redis coordination, private R2 storage, durable
MongoDB outboxes, and separately runnable workers. There is no demonstrated need
to replace this with microservices, Kafka or Kubernetes.

Review method: inventory and security-pattern searches across 509 backend and
244 frontend tracked files; detailed tracing of shared middleware, authentication,
roles, clinical/consumer access, payments, uploads, AI, workers, database models,
browser caching, deployment and recovery scripts. This is not a claim that every
branch of every endpoint has been dynamically exercised.

Evidence collected:

- Isolated throwaway MongoDB tests reproduced the account takeover, foreign
  clinic revenue response, global role mutation, paid-plan activation without
  payment, invalid payment signature acceptance, Google MFA/session bypass,
  empty-permission fallback, inactive tenant rate limiter, anonymous profiling,
  cross-tenant AI context, another patient's document metadata response, and
  no-Redis slot-lock failure. No external payment,
  email, SMS, WhatsApp or AI delivery was executed.
- Existing `rbac`, `security`, `tenantRouteMatrix` and `billingAndSubscription`
  suites passed: 17 tests in 4 files. These do not cover the reproduced failures.
- Frontend and backend TypeScript checks passed. No new production build or
  production deployment was performed during this audit.
- Both lockfiles returned zero known vulnerabilities from `npm audit` on this
  date. This says nothing about business-logic vulnerabilities.
- Current tracked-file secret-pattern checks found examples/test fixtures,
  not another confirmed live credential. Git history contains a valid private
  signing key. Its public fingerprint differs from the current local key;
  whether production still accepts it is unverified. No secret values were
  printed or copied into this report.
- Existing frontend build assets total 2,948,223 JS bytes, or 805,367 bytes using
  individual gzip compression, across 94 chunks. This is all route assets,
  **not initial page transfer size**. No browser load test or production database
  query-plan benchmark was performed.

Not accessible in this audit: actual Render/Vercel environments, current live
revision, database roles/network rules/index deployment, R2 ACLs, provider
dashboards, backup schedules/archives, production load and monitoring receipts.
These are verification gaps, not assumed vulnerabilities.

## 2. Critical Findings

| ID / Severity | Location | Problem | Exploit / failure scenario | Impact | Recommended fix |
| --- | --- | --- | --- | --- | --- |
| C01 CRITICAL | `controllers/auth.ts:75`, `:136`, `:643`, `:680`; `models/User.ts` | Anonymous booking attaches an unverified email to an existing phone-only patient account; recovery trusts that email | Supply a known patient's phone and attacker-owned email to `/api/public/booking-session`, request password reset, then log in. The local test returned 200 at every step and logged into the original victim ID. The fixture had the model's default verified-email state, which also satisfies the production login check | Patient account takeover and access to linked health records | Keep booking contact data separate from account recovery identity. Never attach/change account phone/email or dependent ownership anonymously. Require proof of the existing identity and verify the new contact before enabling recovery |
| C02 CRITICAL | `controllers/analytics.ts:19`, `:53`; `utilities/tenantPlugin.ts` | Executive analytics replaces the authorized clinic list with arbitrary query `clinicId`; aggregation has no automatic tenant filter | A tenant A administrator with analytics permission supplies tenant B's clinic ID. Local HTTP test returned 200 and B's seeded revenue, 777, once A had its own active clinic | Cross-tenant financial disclosure | Validate clinic ownership; retain mandatory organization scope in every aggregation `$match`. Never replace an authorized set with unchecked input |
| C03 CRITICAL | `services/ai/ContextEngine.ts:100`, `:117`; `controllers/aiGateway.ts`; `services/ai/InboundPipeline.ts` | Empty-tenant context falls back to clinics across all organizations and aggregates their finances | A valid organization with no clinics requests AI context for a billing/analytics route. An isolated tenant-scoped context test included a foreign clinic and its revenue | Cross-tenant financial information enters AI context and, when a provider executes, its request | Return empty context for that tenant; remove global fallback from tenant calls. Apply tenant filters to aggregation and authorize finance access independently of the caller-supplied screen name |

## 3. Security Findings

### Authentication

**H01 HIGH — Google sign-in bypasses local MFA and session revocation.**
`controllers/auth.ts:1517` calls `authenticateWithGoogleProfile` directly;
`services/GoogleAuthService.ts` issues an access JWT without `sessionId` and
does not call the shared two-factor login flow. `middleware/auth.ts` only resolves
sessions when that claim exists. A local root fixture with MFA enabled received
an access token and `/api/auth/me` still returned 200 after `revokeUserSessions`.
Existing Google credentials are required; this is not unauthenticated arbitrary
root login. Use the common login/MFA/session issuance flow and require session
claims for new access tokens, with a deliberate expiry-based legacy transition.

**H02 HIGH — Redis-backed revocation can reload active stale sessions.**
`utilities/sessionResolver.ts:253` and `:288` revoke MongoDB rows and evict local
memory, but do not invalidate their active Redis records. The subscriber also
only evicts local entries. `resolveSession` trusts the cached Redis state without
checking current MongoDB authorization. After password/role change or family
revocation, the next request can reload that old active record. Exposure lasts
up to the remaining access-JWT lifetime, rather than indefinitely. Write revoked
tombstones/delete affected shared records or check a shared user/session version
before accepting a cache hit. Verify on two replicas with Redis enabled.

**M01 MEDIUM — Google verification is incomplete.**
`services/GoogleAuthService.ts` makes audience validation optional and links by
email without requiring `email_verified` or a stored provider subject. It uses
remote `tokeninfo` without a timeout. Reject wrong/missing configured audience,
verify identity claims, use stable `sub` associations and an explicit linking
policy, and bound requests. Google's [backend authentication guidance](https://developers.google.com/identity/sign-in/web/backend-auth)
requires audience validation and explains the limits of trusting third-party
email ownership. Production Google configuration could mitigate part of this;
it was not inspected.

**M02 MEDIUM — SSO assertions are replayable and use a separate login path.**
`controllers/sso.ts` validates an HMAC but has no signed expiry, nonce or consumed
assertion record. `services/SsoAuthService.ts` issues sessionless access tokens,
does not use local MFA, and returns raw tokens. Exploitation requires a valid
captured assertion or a compromised trusted SSO bridge. Decide whether IdP MFA
satisfies application policy, enforce it explicitly, bind assertion audience and
expiry, and consume assertion IDs once. Do not call this a full OIDC/SAML verifier;
it is a custom signed identity bridge.

Password strengths: bcrypt hashes; cryptographically random OTPs; purpose-bound
OTP records with attempt limits and atomic successful consumption; hashed reset
and verification tokens; 15-minute RS256 access tokens; hashed opaque refresh
tokens; atomic refresh consumption and reuse detection. Keep these mechanisms.
Reset-token consumption uses read/hash/save rather than an atomic one-time claim;
concurrent submissions with a valid token can race. This is a **LOW** reliability
hardening item, not a demonstrated unauthenticated reset bypass.

### Authorization and multi-tenancy

**H03 HIGH — Tenant admins can modify global/foreign role definitions.**
`controllers/role.ts:227` and `:263` use `Role.findOne({ name })` for updates and
deletes; `models/Role.ts` has no tenant plugin. Local `/api/roles/doctor` mutation
changed the global doctor's permissions using a tenant A admin. Names shared by
multiple tenant roles are ambiguous. Restrict tenant-admin writes to that
organization, create tenant overrides for system roles, and reserve global-role
mutation for platform root. Treat existing global definitions as shared data,
not tenant-editable defaults.

**H04 HIGH — Clearing permissions restores access.**
`utilities/permissions.ts:268` treats `permissions: []` like a missing role and
restores built-in permissions. A local empty nurse role produced nine permissions.
Only fall back when no role record exists; a present empty list must deny access.
Also, `invalidateRoleCache` clears memory but not `auth:role:*` Redis entries;
permission removals can stay stale for the five-minute Redis TTL. Version shared
cache keys or delete the authoritative affected cache records.

**H05 HIGH — Consumer ownership checks are inconsistent for documents and AI.**
`utilities/tenant.ts:checkPatientAccess` falls through from a failed patient/family
ownership check into staff-style organization access. `getPatientDocuments`
relies on that helper and its route permits `VIEW_EHR`. This lets a patient with
organization context access another patient's document list in that organization.
The upload download handler similarly checks tenant membership without patient
ownership or a file-read permission. The AI gateway accepts `activePatientId`
without consumer ownership checks; a local context test for the patient role
included another patient's seeded condition. Return a denial immediately for
consumers failing ownership and apply that policy to AI and signed downloads.
Same-tenant access is not authorization to every patient's chart.

The tenant plugin protects five models' normal queries; it does not protect
aggregation, raw collection calls, every model, or every write operation.
Missing context bypasses it. This is a limitation of the safety net, not proof
that all controllers leak data. Preserve explicit access checks and the
fail-closed TenantRepository; do not rely on a blanket plugin claim.

### API security and abuse

**H06 HIGH — SaaS operations are available to any authenticated tenant user.**
`routes/billing.ts` uses authentication alone for checkout, plan switching,
verification and cancellation. Controllers derive the tenant but do not require
its billing administrator. A nurse activated a paid plan through
`/api/billing/switch-plan`, with zero payment records. Add server-side billing
authority and allow immediate switching only to eligible free plans; paid plans
must use verified settlement. Preserve legitimate root administration separately.

**M03 MEDIUM — Tenant rate limiting runs before authentication.**
`index.ts:224` registers a shared preHandler; route-local authentication runs
later, so `req.user` is unset when the limiter executes. Confirmed HTTP responses
had no tenant-limit headers. Run the tenant limiter after authentication on
protected routes. Keep public IP limits and stricter login/OTP limits. Fastify's
[route lifecycle documentation](https://github.com/fastify/fastify/blob/main/docs/Reference/Routes.md)
documents shared-hook ordering. Reports, upload verification and messaging need
resource-specific budgets in addition to the existing global IP limit.

**M04 MEDIUM — Anonymous profiling exposes internals.**
`index.ts:397` serves `/api/admin/operations/profiling` without authentication;
the isolated request returned 200. `utilities/profiling.ts` also stores raw
unmatched paths as unbounded Map keys. Require root/operations authority and use
one bounded not-found label. Metrics are operational data, not a public API.

### Input validation and browser security

**M05 MEDIUM — Unescaped regex searches and unbounded exports.**
`controllers/preAuth.ts`, `scheduleH1.ts`, `soapTemplate.ts` and portions of
`onboarding.ts` construct regexes directly from input. Pre-authorization search
is staff-authenticated; onboarding search is separately guarded. Malformed
patterns can fail and expensive ones can consume database/CPU resources.
Use the existing `escapeRegex`, reasonable input lengths and query budgets.
Do not label the already escaped patient/public search paths as regex injection.

**M06 MEDIUM — Print markup and spreadsheet cells trust stored text.**
Frontend billing receipts, appointment slips and public booking print windows
interpolate names/addresses/descriptions into `document.write` without escaping.
`services/ReportExportService.ts:escapeCsv` quotes delimiters but does not
neutralize spreadsheet formulas. A crafted stored value can alter a printout or
be interpreted as a spreadsheet formula. Use safe DOM/text construction or
HTML escaping and formula-safe CSV cells. Arbitrary script execution under the
production nonce CSP was **not** browser-verified; report this as HTML injection,
not a proven CSP bypass.

**M07 MEDIUM — Client caches are not identity-scoped or cleared consistently.**
`components/providers.tsx` retains a QueryClient through SPA identity changes.
Notification queries use keys without user/organization IDs. `authStore.logout`
clears browser caches/sessionStorage, but not that QueryClient or clinic store;
organization switches do not reset notification caches. A shared workstation
or tenant switch can temporarily display a previous identity's cached data.
Cancel/clear identity-specific memory caches and namespace query keys.

Production cookies in `utilities/types.ts` are HttpOnly for access/refresh,
Secure, path `/`, with 15-minute/seven-day lifetimes and configurable domain and
SameSite. `SameSite=None` is intentional for cross-site deployments, supported
by Origin/Referer CSRF checks. The readable session indicator is a navigation
hint, not server authentication. Production cookie-domain/browser behavior and
forwarded-host trust require deployment verification. No demonstrated CSRF or
NoSQL/command injection bypass was established in this audit.

### File security

**H07 HIGH — Upload bounds and the secure intent workflow are incomplete.**
`utilities/r2.ts:generatePresignedUrl` accepts `maxSizeBytes` but does not enforce
it. `getObjectBuffer` downloads the entire object before verification checks its
size. Authenticated repeated large objects can exhaust API memory or storage.
`routes/upload.ts` does not compare detected MIME against permitted MIME,
legacy endpoints skip intent checks, and `controllers/documentUpload.ts` makes
the intent optional and trusts caller `fileUrl` even with an intent.
The actual frontend `useR2Upload` uses the legacy base64 path. Additionally,
the `/api` plugin prefix combined with `/api/uploads/...` declarations creates
`/api/api/uploads/...`, while legacy endpoints have the normal `/api/...` path.
Bound bytes during upload and download, verify metadata before streaming,
bind patient/object/MIME/size to a completed intent, atomically consume it, and
migrate legacy callers with a compatibility adapter. A pattern-based scanner
is not a full malware scan; private bucket policy is not enforceable by a comment.

### Secrets, data protection, integrations and infrastructure

**H08 HIGH — Historical private signing key needs production rotation evidence.**
Commit `bb4843ca` contains a parseable `keys/private.pem`; a later commit removed
it. Current files ignore key material and the current local key differs, but
deletion does not remove Git history. If production still trusts that key,
forged arbitrary role JWTs become a critical compromise, particularly since
sessionless JWTs are accepted. Compare the deployed public fingerprint safely,
rotate if necessary and invalidate old trust before considering history cleanup.
Do not change the data-encryption key as part of JWT rotation.

**H09 HIGH — SaaS signature verification accepts a Promise as truthy.**
`services/billing/SubscriptionService.ts:394` omits `await` for the async
`verifyPaymentSignature`. A local verifier returning `Promise<false>` still
marked payment captured and activated the subscription. Fix the await and verify
provider capture/order/amount/currency before granting paid entitlement.

**H10 HIGH — SaaS settlement is not atomic or monotonic.**
The same method saves `captured` before subscription/quota/invoice writes, has
no transaction/CAS claim, and treats captured payments as already complete.
A crash after the first save makes retries skip incomplete activation; concurrent
callbacks can duplicate invoices/extend entitlement. `payment.failed` webhooks
overwrite captured status and subscription status without a precedence guard.
Use one idempotent settlement transition with unique payment-to-invoice binding
and transaction participation. After fixing H09, don't pass the literal
`webhook_verified_signature` through checkout-HMAC verification: a verified
webhook needs an explicit trusted settlement entry point. These changes must
be coordinated. Verify signature rejection, duplicate and out-of-order callbacks,
capture validation and fault injection after every write.

UPI settlement already has HMAC validation, server-order binding and transaction
logic; WhatsApp uses raw-body HMAC verification, encrypted inbox storage and
deduplication. Preserve them. Actual provider contracts and live credentials were
not tested. The UPI compatibility canonical signature omits status; only use it
with a documented provider contract and independent settlement verification.
No forged production callback was demonstrated.

`index.ts` masks unhandled production 500 messages, but controller-level replies
sometimes include raw `err.message` or database error details (for example billing
and AI). Fastify request logs include request URLs; tracker API query tokens can
therefore enter logs despite fragment-based UI links. `utilities/telemetry.ts`
also forwards context/title and an unsanitized first stack line to ops webhooks.
These are **MEDIUM** data-minimization issues: use route templates, redact
capability query values and sanitize exception/alert output consistently.

AES-GCM field encryption, encrypted outbox payloads, audit-detail redaction and
retired clinical IndexedDB storage are useful boundaries. Not every clinical
field is encrypted, so managed database/disk encryption, role restrictions and
retention still matter. Encryption does not itself certify privacy compliance.

Dependency results do not justify blanket upgrades. Preserve lockfiles and CI
advisory gates. Pin third-party CI actions to reviewed immutable revisions as a
**LOW** supply-chain improvement; no malicious dependency was found.

## 4. Scalability Findings

| Severity | What breaks first | Evidence and practical action |
| --- | --- | --- |
| HIGH | Background delivery on the supplied Render blueprint | `render.yaml` deploys only the web process; production inline jobs are off by default. Separate notification/domain/outbound/disruption/no-show worker commands exist, but no worker is provisioned by that blueprint. A healthy API does not prove OTP/reset/receipt/event delivery. Verify actual deployment; run the necessary workers or explicitly supported bounded inline processing |
| HIGH | Timed-slot booking in no-Redis production mode | `SlotLockService.ts` rejects locks in production without ready Redis even with `ALLOW_SINGLE_NODE_IN_PRODUCTION=true`. Local test: readiness policy did not require Redis, but lock acquisition failed. Earlier advice that the override alone preserves all functionality was incomplete. Use Redis for current timed-slot behavior or deliberately support safe single-instance locking while retaining the database unique-slot invariant |
| MEDIUM | Worker concurrency and restart safety | Domain, notification and outbound worker timers can launch overlapping batches. `stop()` clears timers but doesn't await in-flight work; standalone entrypoints then exit. Lease expiry permits reclaim; external delivery may already have happened. Notification/domain leases do not all renew during slow processing. Bound active batches, await drain and preserve unknown-outcome reconciliation |
| MEDIUM | Audit-chain integrity under concurrency | `AuditLog` releases `withChainLock` during pre-save, before insertion. Another save can compute the same sequence; its unique index rejects one. Generic audit hooks catch and continue. Redis failure also falls back to node-local locks. Serialize through persistence or use an atomic chain append, with explicit failed-audit handling and concurrency tests |
| IMPROVEMENT | Memory and database connections as replicas grow | Session/permission/context/alert maps have expiry checks but not uniformly bounded eviction. Each API/worker process gets its own Mongo pool (production max 50, min 10). Count all process pools before raising limits; bound expired-cache retention |

Redis has concrete existing uses: distributed sessions, permissions, realtime
fan-out and timed-slot locks. One process can use local fallbacks where the code
supports them, but merely removing Redis configuration does not establish a
complete single-instance operating mode. Multiple replicas must not be enabled
under that override without validating these dependencies.

## 5. Performance Findings

### Frontend

**IMPROVEMENT:** Queue pages refresh through realtime plus polling. Queue polls
every 15 seconds; TV every 3.5 seconds, about 17 requests/minute per display before
other calls. Timers are cleaned up in the reviewed components, but slow requests
can overlap. Pause hidden-page polling, prevent overlapping polls and measure
fallback intervals before changing realtime behavior.

**MEDIUM reliability / IMPROVEMENT performance:** Appointments fetch a default
server page without consuming pagination headers, then display client pagination.
At more than the backend's default 50 matching records, the UI can omit records.
Implement server-page navigation using the existing contract; don't merely
increase the limit. Large clinical files are a maintenance concern, not by
themselves a proven browser bottleneck.

The existing asset measurement is a baseline only. Capture actual initial-route
transfer, interaction latency and hydration profiles before adding virtualization
or replacing dependencies. Preserve existing lazy AI loading and shared controls.

### Backend and database

- **IMPROVEMENT:** `TimelineService` fetches all provider events, then searches,
  sorts and applies the cursor in memory. `DocumentUploadProvider` has no query
  limit/date predicate. Push range/cursor/limits to provider queries and merge
  bounded results while preserving chronology and cross-org approval policy.
- **IMPROVEMENT:** `SlotService` awaits Redis get/TTL checks separately for every
  offered slot. Pipeline batched lock reads; preserve ownership and TTL semantics.
- **MEDIUM:** Schedule-H1 exports have unbounded `.find().lean()` and no required
  date window. Use bounded/streamed exports and report-specific concurrency
  limits. Normal report exports already have row/range caps; retain those.
- **IMPROVEMENT:** Executive analytics scans all history when no date range is
  supplied. After fixing tenant scope, measure an allowed default window and
  staged aggregates if real volume warrants them.
- **IMPROVEMENT:** Document cursors sort on `uploadedAt, _id`, but the existing
  relevant index stops at `uploadedAt`. Consider `{organizationId, patientId,
  uploadedAt:-1, _id:-1}` only after `explain('executionStats')` demonstrates
  sort/scanning cost. Replace redundant indexing where safe rather than adding
  blindly.
- **IMPROVEMENT:** H1 list queries filter organization and sort `dispensedAt`,
  while model compound indexes begin with clinic. Measure whether an
  `{organizationId:1, dispensedAt:-1, _id:-1}` index is needed for tenant-wide
  listing/export. A regex predicate generally still needs separate treatment.
- **IMPROVEMENT:** Invoice analytics filters clinic and createdAt, while current
  compounds are clinic/status or organization/createdAt. Include organization
  in the corrected query first and inspect its actual plan before adding a
  clinic/date compound.

Existing appointment slot uniqueness, consultation lock, tenant/date and
outbox claim indexes have demonstrated purposes. Verify installed production
indexes and migration status; schema declarations alone are not evidence of
deployment. No measured production p95 latency or query-plan results are claimed.

### Network and external integrations

Most reviewed payment/WhatsApp HTTP paths have timeouts; Google calls lack them.
AI fallback can invoke multiple providers sequentially, each with a timeout:
one frontend 10-second timeout can expire before backend provider work finishes.
Bound the overall request, propagate cancellation and coordinate client budgets;
never blindly retry a timed-out financial mutation.

## 6. Vibe-Code Problems

- **HIGH:** Three authentication/session issuance paths implement different
  guarantees. Share the policy boundary after verifying each provider identity,
  retaining its existing response contract through adapters.
- **MEDIUM:** A secure upload-intent system coexists with unchecked legacy
  uploads; frontend callers actually use the legacy path. Strengthen compatibility
  behavior instead of declaring old callers safe or deleting them blindly.
- **MEDIUM:** AI fallback chooses other tenants to make empty screens look
  populated. Empty tenant context must remain empty.
- **LOW:** Global/system role defaults are duplicated in `permissions.ts`,
  `controllers/role.ts` and onboarding seed logic and differ. Establish one
  versioned seed/catalog source without silently rewriting customer permissions.
- **LOW:** `requireModule` permits unknown module keys. Detect typos in CI and
  deny unknown production keys unless an explicit compatibility rule applies.
- **IMPROVEMENT:** `check:tenants` is an advisory regex scan that always exits 0,
  not an isolation proof. Keep it advisory and add runtime two-tenant tests for
  each security boundary; don't use its pass status as release certification.
- **IMPROVEMENT:** Placeholder captions such as outbound-pipeline "Safety Audit"
  exceed what the implementation checks. That stage validates nonempty output,
  rehydrates placeholders and supplies default citations; it does not establish
  clinical safety or citation truth. State actual checks accurately.

## 7. Reliability / Edge Cases

1. **HIGH:** Retry after SaaS payment capture save but before entitlement/invoice
   completion: retry incorrectly treats incomplete work as finished (H10).
2. **HIGH:** Signed `payment.failed` arrives after successful capture: accepted
   settlement/subscription state is downgraded (H10).
3. **HIGH:** Password change or forced logout with Redis active: evicted sessions
   reload stale shared state (H02). Google JWTs lack revocation linkage (H01).
4. **HIGH:** No-Redis override with timed-slot schedules: healthy deployment,
   failed bookings. Sequential queue mode has a different path.
5. **MEDIUM:** Worker exits after provider acceptance but before acknowledgment:
   replay may duplicate delivery. Existing WhatsApp ledger/unknown-outcome
   handling is useful; standard email and every event subscriber need their own
   duplicate policy. Do not promise exactly-once external delivery.
6. **MEDIUM:** Upload intent is checked, document inserted, then intent updated:
   two concurrent requests can register the same intent; submitted file URL is
   not bound to that intent. Use a transactional/atomic registration claim.
7. **MEDIUM:** Audit chain assignment races with insertion and drops an audit
   entry while business changes succeed.
8. **MEDIUM:** Shared-workstation SPA logout/login or organization switch can
   retain notification query data and previous clinic state.
9. **MEDIUM:** `mongoBackup.ts` reads entire collections sequentially into memory,
   serializes ordinary JSON, then synchronously gzips the whole database. Writes
   during backup can produce an inconsistent cross-collection image; BSON type
   fidelity/index restore is not guaranteed by ordinary JSON. Prefer provider
   snapshots/PITR or a bounded BSON-preserving procedure with a real isolated
   restore validation. The included runbook explicitly avoids promising an SLA.

## 8. Recommended Fix Plan

Each row is a recommendation, not authorization to modify or deploy code.

| Priority / findings | What and why | Affected area / change risk | Preserve compatibility | Verification |
| --- | --- | --- | --- | --- |
| P0 C01 | Separate anonymous booking contact from account identity; stop recovery takeover | Booking/auth/recovery; medium risk to phone-only patients | Keep guest bookings; verify existing ownership before account linking. Review suspect contact attachments without automatic deletion | Existing-phone attacker email, email-only phone attachment, OTP ownership, reset recipients, production verification states |
| P0 C02/C03/H05 | Enforce tenant/resource ownership in analytics, AI and documents | Tenant queries/consumer EHR; medium risk to legitimate family and cross-clinic access | Preserve verified family relationships and explicit OTP-approved cross-org history; reject arbitrary organization/clinic/patient selection | Two tenants, empty tenant, ordinary patient, dependent, nurse without billing permission, authorized root and approved cross-org access |
| P0 H03/H04 | Scope role writes; deny configured empty permissions; invalidate shared role cache | RBAC; medium risk because current global roles may have been edited | Tenant overrides, explicit root global management and versioned cache transition; no blanket seed overwrite | Same role name across two tenants; role deletion; empty permissions; two-replica Redis invalidation |
| P0 H01/H02/H08 | Unify session/MFA policy; revoke shared records; verify historical-key retirement | Authentication/key trust; medium/high rollout risk to active sessions | Allow old tokens only through a bounded transition if necessary; rotate JWT trust independently of data encryption keys | Root Google MFA, disabled user/org, logout/reset/role change, reuse, two-replica revocation, rejected historical-key JWT |
| P0 H06/H09/H10 | Require billing authority, paid-plan settlement, awaited validation and atomic/idempotent state changes | SaaS money/entitlements; high risk, needs coordinated changes | Preserve response/plan IDs; explicit verified-webhook settlement; reconcile existing captured-but-incomplete records | Invalid signatures/capture/amount/currency, nurse denial, duplicate/order permutations, failures at each write, one invoice/period extension |
| P0 H07 | Bound storage/memory and bind clinical files to verified intent and patient authority | Upload/download; medium risk to existing avatar/document callers | Secure legacy adapter, correct canonical URLs and measured cutover; retain access to existing authorized files | Oversized/unknown-length objects, MIME mismatch, revoked access, cross-patient download, intent reuse, legacy clients |
| P1 worker deployment / Redis mode | Deploy required processors and choose an operating mode that supports enabled workflows | Render/deployment/booking; medium operational risk | Retain readiness checks, unique-slot index and existing worker commands. Redis is justified for current timed-slot workflow | Real deployed revision, no-Redis timed-slot behavior, queue age, OTP/reset/receipt delivery and worker restart |
| P1 M03/M04/worker drain/audit chain | Fix hook order, protect metrics, bound workers and keep audit append serialization through persistence | Middleware/workers/audit; medium risk to throughput | Keep public auth budgets; don't block unknown-outcome reconciliation | Multiple IPs same tenant, concurrent workers, slow SMTP, SIGTERM, Redis outage, concurrent audit sequences |
| P1 M05/M06/M07/logging/backup | Bound search/export, escape outputs, clear identity caches and validate backups | UI/reports/logging/recovery; medium behavior risk | Keep CSV columns and print layouts; carefully neutralize formula cells; retain old archives/keys | Malformed regex, formula cells, hostile markup under CSP, SPA identity changes, token-free logs, isolated restore |
| P2 measured performance | Provider-side timeline pagination, batched slot-lock reads, measured indexes and poll backoff | DB/read paths; medium chronology/query risk | Keep cursor shape/order, returned fields and realtime fallback | Query-plan comparisons, larger histories, equal timestamps, canceled/hidden requests, before/after p95 measurements |
| P3 optional cleanup | Consolidate catalogs, pin CI actions and remove only proven unused helpers | Tooling/maintenance; low risk | No schema/route/legacy-identifier renaming | Existing consumer tests and review of deployed action versions |

## 9. Things NOT to Change

- Keep Next.js + Fastify + MongoDB and the separate frontend/backend repositories.
- Keep RS256, bcrypt, hashed refresh/reset tokens and production key guards;
  fix alternate-flow enforcement instead of replacing authentication wholesale.
- Keep private file storage, short-lived authorized URLs and encrypted durable
  outboxes; strengthen their existing boundaries.
- Keep transaction-capable MongoDB and production fail-closed transaction behavior.
  A standalone override does not make transactional clinical/payment operations safe.
- Keep unique active timed-slot and consultation-lock indexes, atomic counters,
  UPI server-order binding, WhatsApp inbox/ledger and explicit reconciliation.
- Keep capability-based public trackers and approved cross-org patient-history
  access. Object IDs remain identifiers, never credentials.
- Keep server-side permission/module/resource checks and the TenantRepository.
- Keep frontend nonce CSP, backend error masking, retired PHI browser persistence,
  lazy AI loading and existing UI design. No redesign is needed for these fixes.
- Keep readiness/liveness separation and graceful API shutdown. Do not switch
  deployment health checks to a bypass just to conceal dependency failures.
- Keep technical legacy identifiers and integration URLs unless a separate,
  compatibility-safe migration is justified.

## 10. Final Production Checklist

- [ ] Security: C01-C03 and all P0 findings remediated and independently retested.
- [ ] Authentication: every provider honors MFA, account/org suspension and
  revocable session policy; deployed signing key is not historically exposed.
- [ ] Authorization: role mutations are tenant-scoped; configured empty roles
  deny; shared permission invalidation works.
- [ ] Multi-tenancy: two-tenant, empty-tenant and consumer ownership tests cover
  analytics, AI, documents, reports, clinical workflows and signed downloads.
- [ ] Database: replica-set transactions, least-privilege credentials, network
  rules and installed unique/index migrations verified in deployment.
- [ ] APIs: actual tenant limits, endpoint resource budgets, output validation,
  bounded regex/pagination and safe errors verified.
- [ ] Payments: invalid signatures denied; verified capture and monotonic,
  idempotent settlement withstand duplicates, reorder and partial failures.
- [ ] Performance: measure target-scale p95, memory, initial route transfer and
  real query plans; fix missing server pagination before increasing caps.
- [ ] Scalability: one-instance or multi-instance operating mode documented;
  Redis-dependent bookings/realtime/revocation and worker pools tested.
- [ ] Logging: capability tokens, secrets and unnecessary PHI absent from HTTP,
  controller, ops webhook and error-tracking outputs.
- [ ] Monitoring: worker readiness plus queue age/dead letters/delivery failure
  alerts exercised; public health response alone is insufficient.
- [ ] Backups: off-site receipt and retention verified, keys escrowed, isolated
  BSON/index/decryption/clinical/financial restore demonstrated.
- [ ] Deployment: correct backend build/start/readiness settings, required
  workers, frontend cookie/proxy settings and rollback revision verified.
- [ ] Integrations: real sandbox provider signature/capture/replay/delivery tests
  passed; credentials/ACLs verified without exposing their values.

Passing builds, existing tests and an empty dependency advisory report cannot
replace the above business-logic and deployment checks.
