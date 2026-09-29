# International configuration cross-verification — 2026-09-29

## Verdict

The implemented foundation has focused regression coverage. The original
international rollout is **not complete**. Creating a foreign organization does
not certify all clinical, financial, notification or operational flows for that
country. No production records, provider account, deployment or database
migration was changed during this verification.

## Original requirements

| Requirement | Status | Evidence and limit |
| --- | --- | --- |
| 19. Directions | Implemented for the public clinic detail | `Clinic` already stores address, city, latitude and longitude. There is no dedicated map URL/directions field. `Get Directions` uses valid coordinates, then street address plus city; it hides with missing location data. No mapping dependency. Tests cover coordinates, invalid coordinates/address fallback, and missing address. Production address completeness was not queried. |
| 20. Static values | Partial remediation; remaining findings below | Country/currency/timezone context, real doctor identity, configurable assignment duration, plan quotas/trial and invoice currency are connected. Numerous rupee labels, date scopes and patient defaults remain. |
| 21. Scaling | Foundation supports organization → branch → doctor assignment | Country/currency belong to organization, optional timezone to branch, schedule/duration/fees to assignment, historical currency to invoice. No business-ID exceptions were added. Tenant regression tests cover access boundaries. End-to-end foreign hospital workflows remain unverified. |
| 22. Pipeline | Existing CI retained; production URL guard strengthened | Both repositories already run the main quality gates. The backend auditor runs TypeScript and its full serial test suite. Docker validates an explicit frontend API URL. Provider deployment settings, branch protection, staging and rollback execution were not accessible or exercised. |

## Defects found and corrected during cross-verification

- Public clinic availability, waiting counts and online cutoff used a different
  calendar from booking. They now share the branch timezone and reuse the loaded
  organization/context across doctors, avoiding extra timezone lookups per doctor.
- Public tracker day scopes, doctor overrides, `isToday`, self check-in override
  checks and queue TV now use the branch timezone. Tracker returns that timezone.
- Staff queue list/status use clinic day boundaries. Reschedule and appointment
  completion follow-up token counters use the same local date as booking.
- Slot requests now reject malformed/impossible calendar dates with HTTP 400.
  Local-time conversion rejects invalid dates, invalid clock values and times
  skipped by daylight-saving changes. Tests cover 23-hour and 25-hour local days.
- Full and partial invoice collection could bypass the appointment UPI guard.
  Foreign UPI requests now fail without changing the invoice; authorization is
  checked before exposing the configuration restriction.
- Patient bills and receipts used rupees for foreign invoices. They now use the
  invoice currency; foreign unpaid invoices direct the patient to reception.
- An Indian traveller's explicit `+91` number was rejected at a foreign clinic
  after normalization. Country-code input and legacy Indian storage now coexist.
- WhatsApp formatting could prepend `91` to an explicit foreign number whose
  complete international representation had ten digits. Explicit `+` input now
  retains its own country code.
- Editing a clinic without coordinate fields erased its stored coordinates.
  Omitted coordinates are now preserved. API schemas enforce coordinate bounds.
- Configured `professional` plans could initialize a Starter subscription while
  organization limits came from Professional. Initialization recognizes the
  existing `pro` alias, and explicit zero-day trials no longer become 15 days.
- Docker's string prefix check accepted malformed URLs and missed IPv6 loopback.
  The reusable Node URL validator rejects malformed/local/credentialed URLs.

## Remaining work before foreign production use

| Priority | Finding | Why variability is required / next action |
| --- | --- | --- |
| High | Several queue mutations and OPD sessions still use server-local day ranges (`controllers/queue.ts`); frontend queue uses UTC “today”. | Calling next, reordering, report review and closing a session must select the same clinic day as booking. Finish conversion together, with midnight transition tests for those operations. The list/status correction alone does not certify the full queue. |
| High | Disruption actions, clinical follow-up scheduling and doctor availability have additional UTC date paths. | Holiday/reassignment and follow-up dates are local clinic dates. Audit `disruptionService`, `doctorAvailability` and `clinicalNote` before international operational rollout. |
| High | Tax and charge capture remain India-specific. | GST fields cannot represent every country's tax workflow. Foreign manual invoices/encounter billing/consolidated checkout are deliberately blocked. Review the required tax rules and accounting workflow, then add a small centralized tax policy. |
| High | Financial aggregates, cashier reports, EHR invoice snippets, pharmacy/lab screens and notification templates still label amounts as rupees. | Foreign amounts must retain their currency. Cross-organization totals must group by currency; changing the symbol on a mixed total is insufficient. Update each relevant consumer before exposing it abroad. |
| High | Live international OTP/SMS/WhatsApp and payment delivery is not verified. | Country/provider coverage, approved templates and credentials are deployment facts. Run a controlled delivery/payment test with configured accounts; form acceptance is insufficient. |
| High | `Patient.nationality` and patient registration still default to “Indian”. | Clinic location does not establish patient nationality. Replace the default with unknown/explicit patient input, preserve saved history and test registration/clinical exports. |
| High | Legacy organization country and phone identity need data review. | Do not infer legal country from city/currency, or merge phone identities automatically. Existing invoices lacking currency retain the previous INR display interpretation; review any historical foreign business records explicitly. No data backfill ran. |
| Medium | Runtime date labels and locale preference remain largely English/browser-dependent. | Patient and clinic calendars differ from viewing-device context. Use clinic timezone for clinic events; add a user locale preference only when the product needs that formatting choice. Language translation is a separate product decision. |
| Medium | Quota synchronization still raises stored limits to plan limits at startup. | Organization overrides and subscription entitlements need a single policy. Review `syncOrganizationPlanQuotas` before allowing lower custom organization limits; its current behavior predates this change. |
| Medium | A repeated daylight-saving clock hour has one deterministic selectable occurrence. | Slots currently identify local `HH:mm`, so both offset occurrences cannot be selected separately. Review overnight operation requirements before supporting both. Day boundaries already account for the 25-hour day. |

## Static/configuration classification

| Category | Values | Treatment and reason |
| --- | --- | --- |
| A. Keep static | Country-code/currency reference mapping, supported country list, status enums, permission identifiers, coordinate bounds | These describe supported product contracts and validation, rather than tenant preferences. No tenant settings panel is needed. |
| B. Application configuration | Platform identity, supported payment capabilities, plan catalogue, global defaults/limits | Centrally owned product/commercial policy. Existing plan records should remain authoritative; bootstrap fallbacks are limited to missing catalogue data. |
| C. Business/database settings | Clinic contact/address/coordinates/branding, organization country/currency/timezone, branch timezone, doctor assignment schedule/duration/fee, clinic UPI merchant details, existing notification/print preferences | Real organizations and branches operate differently. Reuse existing records and forms. Do not invent contact data or clinical credentials. An organization uses one clinical currency; another legal/currency context currently needs another organization. |
| D. Environment | API/frontend origins, database/Redis URLs, signing/encryption keys, storage/mail/payment/provider credentials | Deployment-owned infrastructure and secrets. Keep them out of business forms and client bundles. The public API origin must be set at frontend build time. |
| E. Runtime/context | Active clinic, effective timezone, current permissions, invoice display currency, local “today”, derived directions URL | Derive from loaded context and saved invoice data. Store the invoice currency because it is historical financial data; do not redundantly save computed map links or local dates on unrelated records. |

## Minimum release and rollback checklist

1. Require green CI on both exact frontend/backend commits and record that pair.
   Frontend CI artifacts currently use localhost as a build-verification origin;
   rebuild production with the deployed API origin rather than serving that artifact.
2. Verify deployment environment, tenant/phone/currency data readiness and any
   required migration/index prerequisites. Run migrations only as reviewed
   operational work, with a backup and compatibility plan.
3. Keep production deployment controlled by the existing provider. Confirm that
   its deploy gate waits for green CI, or deploy the recorded commits manually.
   No live provider setting was changed here.
4. Use a preview/staging environment for the critical patient → receptionist →
   doctor → billing journey, especially when switching country context. The
   repositories do not currently provide an automated browser E2E suite.
5. Preserve previous working commits/image tags and environment references.
   Deploy the API, frontend and workers consistently; verify API readiness,
   worker readiness, login, booking and the main clinic flow.
6. If health or critical flows fail, redeploy the previous compatible frontend,
   API and worker versions through the existing provider/Compose setup. Retain
   the current database; do not automatically reverse a migration or restore a
   backup over newer patient data. Verify readiness and the failed journey again.

This is a documented release procedure. A live deployment/rollback drill and
load/performance benchmark were not performed during this task.

## Verification evidence

- 60 distinct backend tests across 11 focused files passed: country/time
  boundaries, international booking, public tracker/check-in, availability,
  queue integrity, billing, tenant authorization, onboarding, subscriptions,
  downgrade limits and WhatsApp reliability. Failed new quota assertions were
  corrected to inspect the persisted organization rather than its intentionally
  limited onboarding DTO, and the affected test passed on rerun.
- The international integration case verifies admin booking/configuration,
  patient access to the USD invoice, and doctor/receptionist login plus access
  to the clinic-local queue. This is API coverage, not a complete browser journey.
- 56 distinct frontend tests across eight focused files passed: directions,
  patient login, time conversion, clinical document validation and successful
  generation, invoice currency/payment availability, printing, workflow
  recovery and production API URL validation.
- Frontend production build compiled and generated 41 pages; backend build
  produced the API and five executable worker bundles. Backend TypeScript,
  changed-file frontend lint, payment boundary and diff checks passed. Frontend
  lint has warnings (65 in the affected files) and no errors; this is not a
  warning-free repository.
- Full release CI/security auditing, live provider delivery, native maps
  handoff on a physical phone, viewport/manual accessibility checks and
  production deployment/rollback were not exercised. Passing these focused
  checks establishes evidence for the tested scope, not a universal absence
  of regressions.
