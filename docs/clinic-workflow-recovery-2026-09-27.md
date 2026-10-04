# Clinic workflow fixes — implementation and verification

Implemented locally on 2026-09-27 following the G1–G10 source-traced product
review. The table below retains its findings and resulting behavior. Existing routes,
status names, clinical identities and permission boundaries are retained. No
production deployment, database migration or live provider transaction was run.

| Finding | Implemented change |
| --- | --- |
| G1: booking/payment truth | Booking responses now include payment state and amount. Tickets and print payment labels derive from server state. Pending payment is explicitly distinguished from confirmation. Payment setup failures retain the visit and expose a manual retry and reception guidance; creating an order never labels a visit paid. |
| G2: finalization | Completion couples its appointment, encounter, prescriptions, required clinical note, CDS records and audit writes in a transaction. Notifications and broadcasts run after commit. Signing checks the linked visit, seals prescriptions and completes required records atomically. Successful repeated completion/signing reconciles existing records. Explicit close-and-call-next commits required visit/encounter/audit work together and states that it does not save or sign unsaved notes. |
| G3: synchronization | Sanitized queue events also reach the authenticated clinical channel used by Queue Desk. Polling refreshes the whole queue view. Queue, auxiliary filter reads, appointment reads and tracker reads reject obsolete responses. Appointments reconcile on a visible-tab timer and visibility changes. Tracker refresh failures retain its last data and show reconnecting/stale information. |
| G4: full list | Appointment search runs across authorized matching records before server pagination. Ownership and clinic filters remain active. The UI consumes total/page headers, exposes server page controls, resets filters to page one and labels page-scoped counts and exports. Patient accounts without a patient profile use the same filtered/paginated path. |
| G5: check-in | The existing surface was already labelled a staff kiosk; the initial audit overstated this branding problem. It now guards its form by staff queue permissions. Phone lookup uses today's date and the selected clinic and requires an explicit visit selection. The endpoint atomically accepts only pending/confirmed arrivals, rejects payment-pending and terminal visits, and returns consistent first/repeat result shapes. |
| G6: draft protection | SOAP shows saved/unsaved state, warns before losing edits through links, tabs, reload or call-next, and requires the latest changes to be saved before signing. Workspace call-next uses client navigation. Existing server draft saving is retained; no clinical data is persisted to browser storage. |
| G7: section recovery | Timeline and refill failures have separate retry states; successfully loaded portal sections remain usable. The fabricated fallback encounter count was removed. Encounter diagnostic orders reconcile changes from other sessions and all existing local order-status events, retaining loaded orders after refresh failure. |
| G8: doctor setup | Failed clinic assignment is reported separately from successful account creation. Its existing assignment payload can be retried without registering another account; the recovery notice states the fee, duration and booking mode. |
| G9: safe moves | Rescheduling and new booking share availability, holiday, working-interval and same-day capacity validation. Rescheduling preserves pending-payment state, enforces the daily token limit and couples token allocation, the guarded move and its audit transactionally. Conflicts preserve the original visit. |
| G10: arrival clarity | Queue counts distinguish bookings that have not arrived from checked-in waiting patients. Next-token display follows the backend status priority. Current UI clients request explicit confirmation before calling an unarrived visit; server confirmation binds to that candidate. Legacy callers retain their existing default policy. Standby tracker text distinguishes investigations from stepping out and does not promise an unconditional next turn. |

## Additional defect found during validation

Making prescription sealing a required signing step exposed an existing save
guard that treated the first seal as an edit to an already sealed record. The
guard now checks persisted sealing state, permits first sealing with diagnosis
and signature, and rejects unsealing or later clinical edits. Existing query
immutability protections remain active.

## Verification

- Full frontend suite: **110 tests, 18 files passed**.
- Backend targeted runs cover **59 distinct tests across 10 files**. The wider
  nine-file run initially passed 49/50 tests and exposed the sealing defect.
  After correction, the affected clinical/signing/sealing/recovery run passed
  **22/22 tests across three files**; the other seven files had passed.
- Recovery tests use an actual MongoDB replica set and the appointment indexes,
  rather than a mocked transaction or standalone fallback. They exercise late
  note-write rollback, retry without duplicate prescriptions, cancelled-visit
  signing rejection, repeat signing, initial sealing and immutability, kiosk
  repeat responses, arrival confirmation before previous-visit completion,
  call-next rollback, search beyond 50 rows, payment-gated moves and holiday
  rejection.
- Both production builds passed, including frontend TypeScript checking and all
  six backend executable bundles. Backend standalone TypeScript checking passed.
- Focused frontend lint: **zero errors, 53 warnings**, principally existing
  effect/dependency/unused-code findings in these large screens. Diff whitespace
  checks passed in both repositories.
- Tests use synthetic records and temporary databases. These results do not
  certify real payments, message delivery, real-device keyboards or production
  infrastructure.

## Intentional compatibility and operational limits

- Production finalization requires a transaction-capable MongoDB replica set
  (including the existing managed/Atlas deployment model). Standalone development
  fallback does not provide the rollback guarantees tested on the replica set.
- Historical completed visits missing required records are flagged for clinical
  review rather than silently treated as a successful retry or automatically
  rewritten. Explicit audited queue closure remains distinct from note signing.
- Booking payment recovery uses existing payment-setup endpoints and reception
  verification. No new gateway checkout or unverified paid-state shortcut was
  introduced. Provider credentials and actual settlement remain release checks.
- Browser history interception uses the Navigation API where available; links,
  tabs, reload and explicit call-next have separate protections. History behavior
  in unsupported browsers still needs real-device verification.
- Failed assignment recovery is held in the current staff screen. After reload,
  use the existing doctor assignment management flow to configure that account.
- Existing technical identifiers, collection names, permissions and integrations
  were not renamed. The separate security audit's remaining findings are not
  declared resolved by this workflow work.
