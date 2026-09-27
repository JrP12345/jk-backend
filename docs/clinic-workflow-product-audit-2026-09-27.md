# Existing clinic workflow: real-user product audit

Implementation follow-up: [G1-G10 fixes and verification](clinic-workflow-recovery-2026-09-27.md). The review below records the pre-implementation findings.

Reviewed 2026-09-27 against the current local frontend and backend, including the
recent local UX, identity/permission and root-MFA changes. No application code,
business rules or production configuration was changed for this audit. Local
changes are not evidence of what is currently deployed.

This is a source-traced journey review, supplemented by 19 passing existing
backend tests across `appointment`, `queueIntegrity`, `queueOperationsAndDelay`
and `clinicalContinuityAndTillClose`. Tests use temporary databases. No real
appointments, payments, messages or live clinic transactions were executed.
Race, disconnect and partial-write scenarios below are traced failure paths,
not newly executed fault-injection or concurrent-browser demonstrations.

## A. Biggest existing product gaps

| ID / Priority | Role → Page / flow | Existing problem | Real-world impact | Recommended refinement |
| --- | --- | --- | --- | --- |
| G1 / P0 | Patient + reception → public booking / ticket | The UI constructs a ticket using the selected payment mode and prints **Online Paid** before gateway verification. Creating an order happens later, with failures swallowed. Booking confirmation also does not reflect a server `pending_payment` status | A patient presents a paid-looking slip while reception sees an unpaid/pending visit; staff must decide which screen to trust | Derive booking and payment labels from returned server state. An order is not a payment. Retain the existing visit after payment failure and provide its actual next step; never promise payment success before verified settlement |
| G2 / P0 | Doctor + reception → complete consultation / sign note / call next | Generic completion changes the appointment first, then saves encounter/prescription/note/audit work. A later failure leaves the appointment completed; the same-status retry returns success before repairing those records. Note signing completes its linked appointment without checking its previous appointment status. Auto-complete-on-next follows another, smaller completion path | A visit can be closed with incomplete clinical records, or a stale draft can change a cancelled visit to completed. Reception may advance the queue while the doctor believes saving failed | Keep existing clinical steps but give completion/signing one guarded, recoverable contract. Couple required records with the transition; make retries finish missing work safely. Define what explicit auto-completion does and does not save |
| G3 / P1 | Reception + doctor → open queue / appointments / tracker | Queue Desk connects to `/clinical/ws`, while ordinary arrival/status/call-next updates use the queue channel. Its fallback refreshes appointment rows every 15 seconds, not all status metrics. Appointments has no cross-session subscription/poll. Queue/filter reads have no latest-response guard. Tracker retains old data after background errors while its Live badge remains visible | Reception and doctor can disagree about who arrived, is being seen or finished. Rapid doctor/date switching can show old results under a new selection; a patient can trust an outdated ETA | Wire existing event delivery to the correct consumers, reconcile the entire active view, reject obsolete reads, and expose stale/reconnecting status. Keep explicit patient/doctor identity on every action; do not blank usable data |
| G4 / P1 | Reception + doctor + patient → appointment list / search | Backend defaults to 50 results with pagination headers. The list sends no server page/limit and consumes no total headers; its shared table only paginates/searches the received subset | On a busy day, later appointments disappear from this view and local totals/search look complete. A patient with long history sees only a subset | Connect the existing list controls to existing server pagination and totals. Make local versus complete-list counts clear; search the intended full dataset rather than silently filtering one fetched page |
| G5 / P1 | Patient + reception → `/check-in` | Already labelled as a staff reception kiosk, but its public route displays a form without guarding staff access and asks for internal appointment/clinic IDs. Phone lookup calls an authenticated list, supplies no date/clinic filter, and chooses the first eligible result. Backend kiosk check-in uses read/save, rejects only cancelled/completed, and returns a different shape for already-checked-in visits | Anonymous patients hit access errors; staff can select the wrong appointment or get an incomplete success display. Kiosk behavior disagrees with the protected tracker and other transition rules | Identify this existing surface as a staff kiosk, or use the already-existing patient tracker capability for patient entry. Require selection of the correct visit, today's clinic context and identity; align permitted transitions and success/repeat responses |
| G6 / P1 | Doctor → SOAP editor / next patient / reload | Unsaved SOAP fields live only in React memory until Save Draft; no dirty-navigation warning was found. Workspace Call Next performs a full document navigation. Several other dialogs also rely on transient component state | A refresh, back action or patient change can erase work that has not reached the server; reopening does not restore that unsaved edit | Make saved versus unsaved state explicit and warn before losing it. Reuse the existing server draft operation; do not restore clinical data to localStorage. Preserve entered data after failed saves |
| G7 / P1 | Patient + doctor → history / diagnostic orders | Patient timeline failure only logs an error and can resemble no history. A secondary refill failure labels the whole portal as failed. Encounter order updates listen only to the in-browser event bus and only ORDER_COMPLETED; there is no cross-session refresh subscription in that provider | A doctor may believe lab work has not arrived; a patient may believe records are missing. A secondary service failure obscures the health information that did load | Give each existing section its own error/retry state, retain successful sections, and reconcile orders changed by other staff through existing event/refresh mechanisms |
| G8 / P1 | Admin/owner → create doctor / clinic assignment | Doctor creation can succeed while automatic clinic assignment fails; the error is logged and the overall UI still says registration succeeded | The owner believes the doctor is ready, but reception/patients cannot book them at the selected clinic | Report account creation and assignment separately; show a retry for the failed existing assignment and the actual configured fee/schedule/mode before treating setup as ready |
| G9 / P1 | Patient + reception + admin → reschedule | Existing reschedule checks future time, current status and slot lock, but does not reuse new-booking schedule/holiday/capacity validation. It accepts `pending_payment` and unconditionally sets the new appointment to confirmed | A moved visit can land outside the doctor's working schedule or present as confirmed despite its configured payment requirement | Reapply existing availability and payment requirements to the move, while preserving prior payment/clinical identity. Explain conflicts and keep the existing appointment until the move succeeds |
| G10 / P1 | Reception + doctor + patient → waiting / next / standby | Queue “waiting” includes pending, confirmed and checked-in appointments; call-next can select un-arrived confirmed/pending visits after checked-in visits. “Standby” means both stepped out and held for investigations. Tracker treats standby as already checked in | Staff can confuse booked with physically waiting, call an absent patient or misinterpret a patient's return from investigations | Show arrival separately from booking and label the existing standby reason. Make calling an un-arrived patient explicit according to existing clinic policy; do not introduce extra status values |

### Evidence locations

- G1: `frontend/src/app/browse/[id]/BrowseDetailClient.tsx:858` (creation),
  `:900` (background payment), `:981` and `:2121` (Online Paid labels);
  `backend/services/AppointmentService.ts:420` (fee/payment-dependent status).
- G2: `backend/controllers/appointment.ts:309`, `:409`, `:441`;
  `backend/controllers/clinicalNote.ts:279`, `:312`;
  `backend/controllers/queue.ts:710`; Queue Desk's auto-complete prompt at
  `frontend/src/app/(dashboard)/dashboard/queue/page.tsx:3930`.
- G3: Queue Desk `:592`, `:1002`, `:1026`; Appointments `:474`, `:518`;
  tracker `:285`, `:370`, `:697`; `backend/notifications/websocket.ts:424`
  versus `broadcastClinicalRealtime`; `backend/controllers/appointment.ts:720`.
- G4: `backend/controllers/appointment.ts:173`, `:241`;
  `backend/utilities/helpers.ts:225`; Appointments `:474` and its Table.
- G5: `frontend/src/app/check-in/page.tsx:17`, `:68`;
  `backend/routes/checkIn.ts:11`; `backend/controllers/checkIn.ts:50` onward.
- G6: `frontend/src/components/clinical/SOAPNoteEditor.tsx:305`, `:387`;
  `frontend/src/components/clinical/EncounterWorkspace.tsx:109`.
- G7: `frontend/src/app/(dashboard)/dashboard/patient-portal/page.tsx:184`, `:229`;
  `frontend/src/providers/EncounterProvider.tsx:25`, `:42` and
  `frontend/src/events/EncounterEventBus.ts`.
- G8: `frontend/src/app/(dashboard)/dashboard/staff/page.tsx:484`.
- G9: `backend/controllers/appointment.ts:836`–`:883`, compared with
  availability handling in `backend/services/AppointmentService.ts`.
- G10: Queue Desk `:1122`; `backend/controllers/queue.ts:750`–`:796`;
  tracker `:719`, `:1396`.

## B. Role-by-role audit

### Patient

The existing journey is browse → clinic/doctor information → date/slot or queue
booking → ticket/tracker → arrival → consultation → existing documents/billing.
There are doctor specializations, location filters, fees and booking-mode cues;
the tracker already brings several visit details together. Keep those paths.

The patient needs the doctor, clinic, date, token, booking state, amount due and
next action immediately. Secondary information is doctor detail, history and
download/print. Internal IDs, raw statuses and clinical operational terms should
not be required to arrive. G1/G5/G9/G10 most directly generate reception calls.
G3/G7 undermine the answer to “what happens next?” and “where are my records?”

On slow booking requests, the button prevents normal repeat clicks, and the
backend has duplicate/collision checks. However, this flow has no visible
reconciliation step for “server booked, response timed out.” It reports failure
and invites another attempt. Do not assume this proves duplicates occur in every
case: exact-match guards and unique slot indexes already limit some duplicates.
Refine uncertain outcomes to recover the existing visit before creating another.

Recent shared mobile, table, focus and browse recovery fixes are present locally.
This audit did not repeat a real-phone booking/payment walkthrough or virtual
keyboard test; the earlier four-width browse checks do not certify every dialog.

### Reception / front desk

Queue Desk already supports arrival, walk-ins, priority/order changes, standby,
investigations, completion and payment-related handoffs. Appointments defaults
staff to today. These capabilities should remain in their current workflow.

Must see: selected clinic/doctor/day, current patient, arrived waiting patients,
next eligible patient, current workload and exceptions. Secondary: later bookings,
details and historical visits. Detailed clinical/administrative panels should not
compete with arrival and next-patient controls unless the role needs them.

G3/G4/G10 are the highest-frequency desk friction. G5 complicates repeat arrival;
G1/G2 create disagreements reception cannot safely resolve from a success toast.
Patient search and registration already expose identifying contact data and
duplicate warnings in principal registration paths. Preserve these safeguards.
There are multiple registration paths with different required fields, including
name/contact in the directory versus name/DOB in appointment forms. Align the
requirements needed for each existing operation and distinguish similar names
using available MRN, phone and DOB; never silently pick a same-name person.

Search/filter state is principally component state. Returning from a detail or
refreshing can reset context; retain nonclinical list filters in the URL where
appropriate. This does not justify storing patient records in browser storage.
No timed reception usability session was performed, so exact click counts and
staff task-completion times are not claimed.

### Doctor

PatientHeader already shows name, MRN, demographics, allergies and conditions;
unknown allergies are displayed as not recorded, not as an invented all-clear.
The workspace and SOAP editor already support notes, draft save, signing,
history, investigations and the existing prescription workflow. Keep them.

Must see: the exact current patient/appointment, arrival/current visit status,
reason/history and saved state. Secondary: prior visits, orders and billing
preview. Owner configuration and broad finance views are unnecessary in the
primary consultation task even when the user has additional permissions.

G2/G6/G7 are the main risks: incomplete completion, lost unsaved work and results
that do not refresh from another staff session. Consultation initialization
falls back from a failed single-appointment read to a paginated appointment list;
an older appointment outside that first page may fail to initialize. Preserve
explicit identity checks and recover the targeted appointment, rather than
treating an arbitrary list as a reliable lookup.

Signing a note and marking a visit completed need clearly communicated effects.
The separate queue completion form and SOAP signing path currently perform
different work. This is a refinement of existing finalization, not a request for
new clinical capabilities.

### Admin / owner

Existing Team, assignments, schedules/holidays, Locations, Service Catalog,
permissions and settings cover the current operations. Keep role/module-filtered
navigation, confirmation dialogs and server-side authority checks.

Must see: which doctor is actually assigned to which clinic, the effective hours,
booking mode, capacity and fee rule, and who can perform each existing action.
Secondary: historical reports and advanced controls. Developer identifiers and
silent configuration dependencies should not be needed to make a doctor bookable.

G8 makes account creation look like a complete setup. G9 means schedule rules
can differ between booking and moving an appointment. Existing settings are
distributed across a doctor profile, clinic assignment and daily override;
surface the effective values and scope rather than introducing another settings
page. Configuration changes should not promise that already-booked visits were
updated automatically unless the existing disruption flow actually handled them.

Previously audited authentication, revocation and billing-integrity release gates
remain separate. Local tenant/role fixes must be deployed consistently; sidebar
visibility alone cannot establish that a permission revoked during an open session
has stopped working. See the current remediation status in
[the security audit](production-security-scalability-audit-2026-09-27.md).

## C. Cross-role workflow and status model

The existing generic appointment transition map is:

```text
pending_payment → pending / confirmed / cancelled
pending         → confirmed / checked-in / cancelled / no-show
confirmed       → checked-in / cancelled / no-show
checked-in      → in-consultation / cancelled / no-show
in-consultation → completed
standby         → checked-in / cancelled / no-show
disruption_triage → confirmed / cancelled
completed / cancelled / no-show → terminal in the generic transition map
```

“Booked” is a patient-facing description, not an additional stored appointment
status. “Arrived” and “waiting” are descriptions derived from existing states;
they should not imply the same thing as confirmed. Payment has its own separate
state model; completing a consultation is not proof of payment.

Specialized flows extend or bypass that map:

- Call Next can move pending/confirmed directly into consultation.
- Investigation/standby flows hold a patient in standby and return them to
  checked-in for review. Distinguish why they are held without inventing states.
- Reschedule changes several eligible states, including pending_payment,
  back to confirmed and issues a new token.
- Kiosk check-in can move states not explicitly approved by the generic map.
- SOAP signing completes its linked appointment directly; it does not check the
  appointment's prior state. Its appointment lock-release hook exists, so this
  audit does **not** claim signing necessarily leaves the consultation lock stuck.

The main defect is multiple transition paths with different guarantees, rather
than the mere number or spelling of statuses. Unify their guards, effects and
patient-facing meaning while preserving the legitimate special workflows.

| Real clinic situation | Existing behavior / gap | Needed refinement |
| --- | --- | --- |
| Morning with 80 appointments | Appointment list receives the first 50; table pagination cannot reveal the remaining 30 | Consume the existing server pagination/totals |
| Patient books online, then arrives with a printed slip | Ticket can say Online Paid from selection alone | Authoritative booking/payment confirmation |
| Reception checks in while doctor queue is open | Queue event goes to queue sockets; staff view uses clinical sockets and later polling | Correct event consumption and full reconciliation |
| Reception switches doctor while an earlier request is slow | Earlier callback can overwrite the currently selected view | Latest-response guard and action identity check |
| Doctor saves completion and a later record write fails | Appointment can remain completed; repeated request can report success without repair | Recoverable finalization rather than a false completed outcome |
| Cancelled visit has an older draft subsequently signed | Signing can directly change the linked appointment to completed | Guard against stale/terminal-state modification |
| Patient reschedules onto a holiday or while payment is pending | New-booking eligibility/payment checks are not fully reapplied | Preserve effective existing availability/payment rules |
| Staff refreshes or doctor changes page before Save Draft | Unsaved memory-only entries disappear | Unsaved warning and explicit server-saved state |
| Queue tab stays open for hours / connection drops | Polling helps, but metrics/connection freshness can diverge; tracker remains labelled Live | Show freshness; reconcile on return/reconnect |
| Duplicate click / event | Buttons, atomic transitions and slot/consultation uniqueness already protect important paths; not all specialized writes have equivalent guards | Retain working protections and extend them only to the inconsistent paths |
| Server restarts / notification worker is delayed | Durable outboxes exist; actual worker delivery and restart recovery were not exercised here | Verify existing workers and show dispatched versus delivered accurately |
| Permission is revoked while someone is working | Some local permission fixes exist; distributed session revocation remains an open audit gate | Verify revocation on the deployed replicas; preserve entered data without accepting unauthorized writes |

## D. Production priorities

**P0 — before real clinic use:** G1 payment/confirmation truthfulness and G2
recoverable, guarded clinical finalization. Rescheduling must also preserve any
configured payment gate; treating pending payment as confirmed needs correction
before enabling that affected flow. Existing unresolved security/payment release
gates cannot be cleared by this UX audit.

**P1 — refine before launch:** G3–G10, particularly cross-role freshness, complete
appointment visibility, a usable arrival route and saved-state clarity. Fix the
existing contract/surface mismatch; no new module is needed. Validate actual
provider payment/refund delivery before presenting guaranteed outcomes.

**P2 — safe after the blocking work:** preserve filter/back context, simplify
secondary wording, make the existing standby reasons clearer, and tune existing
mobile dialog/keyboard layouts using real devices. No blanket navigation redesign,
advanced search platform or virtualization dependency is justified by this review.

## E. What is already good

- Public clinic discovery, doctor/fee details, location filtering and booking-mode
  handling already exist. Recent browse errors differ from real empty results.
- Slot uniqueness, atomic daily tokens, the single-active-consultation database
  lock and generic compare-and-set status changes protect important operations.
- Consumer self-service routes perform ownership checks; public tracking and
  patient check-in use separate capability mechanisms.
- Queue has explicit active-consultation conflict handling, arrival priority,
  standby/investigation workflows and exception controls rather than one flat list.
- Server SOAP drafts, note signing/amendment, patient identity headers and clinical
  safety review already exist. Do not rewrite them for visual consistency.
- Shared controls provide mobile cards, keyboard/focus handling, confirmation
  dialogs, reduced motion, disabled/busy submits and retained rows during refresh.
- Contextual recovery exists in many principal pages. Durable notification/event
  outboxes and existing audit logs are useful foundations; verify actual deployment
  and delivery instead of replacing them with another architecture.

Passing tests demonstrate these selected normal paths and protections. They do
not disprove the untested browser/partial-failure paths identified above.

## If this exact local product went live tomorrow

The ten most likely sources of frustration, mistakes or reception calls are:

1. A slip says Online Paid when payment has not been verified.
2. A visit appears completed despite incomplete finalization, or signing an old
   draft changes a visit that another user already cancelled.
3. Doctor and reception disagree about arrival/completion because views refresh
   differently, or old requests populate the wrong selected queue context.
4. Staff cannot find later appointments on a day with more than 50 bookings.
5. A patient-facing self-check-in page demands IDs and staff permissions.
6. An unsaved note disappears after refresh or moving to another patient.
7. Missing or stale history/results look like genuinely absent clinical data.
8. The owner sees Doctor registered successfully although clinic assignment failed.
9. A rescheduled visit conflicts with working hours or its payment requirement.
10. Booked-but-not-arrived, physically waiting and standby patients are difficult
    to distinguish when calling the next patient.

These are refinements to the existing patient → reception → doctor → billing flow,
not proposals for additional product modules.
