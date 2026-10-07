# Subscription and appointment operations

## Subscription access

The target location's organization determines whether a new booking may be created. The booking API checks this again at write time; the public location availability flag is only a user-interface hint. No grace period is currently configured, so none is assumed.

| Effective condition | New bookings | Existing appointments, queue, clinical records and billing | Staff workspace | Public location page |
| --- | --- | --- | --- | --- |
| Trialing before `trialEndsAt` | Allowed | Available | Normal access | Booking available |
| Trialing after `trialEndsAt` or `expired` | Blocked | Preserved and available | Existing care and administration remain accessible | Location information and contact remain visible; online booking unavailable |
| Active before `currentPeriodEnd` | Allowed | Available | Normal access | Booking available |
| Active after `currentPeriodEnd`, `payment_pending`, `payment_failed` or `cancelled` | Blocked | Preserved and available | Existing care and administration remain accessible | Location information and contact remain visible; online booking unavailable |
| Organization `inactive` or `isActive: false` | Blocked | Preserved in storage | Existing authentication policy denies the suspended workspace | Location information may remain visible; online booking unavailable |

Patients see “Online booking is temporarily unavailable. Please contact the location directly.” The API never exposes the organization's payment status to them. Existing patient appointment details and public tracking remain readable. Existing-care status changes and records are not gated by subscription expiry. Reactivation or a valid paid period restores new booking without rewriting historical appointments.

## Appointment review

The stored statuses remain `pending_payment`, `pending`, `confirmed`, `checked-in`, `in-consultation`, `standby`, `disruption_triage`, `completed`, `cancelled` and `no-show`. The `overdue` and `unresolved` values are derived review labels, not new statuses or medical facts. A passed time slot in `pending_payment`, `pending` or `confirmed` is overdue. Any nonterminal appointment is unresolved after a full elapsed day. Staff can open **Needs review** from Appointments; patients see a neutral request to contact the location. The list refreshes while in use, and appointment/queue clients reconcile live events with periodic refreshes.

| Situation | Stored status until evidence is recorded | Staff action | Patient view |
| --- | --- | --- | --- |
| Booked, no arrival recorded | `pending` or `confirmed` | Contact patient; explicitly mark no-show, cancel or reschedule when known | Existing booking, then follow-up notice if unresolved |
| Arrived but reception did not check in | `pending` or `confirmed` | Check in after confirming arrival | No arrival is inferred |
| Checked in but clinician did not start | `checked-in` | Review queue; start consultation or resolve explicitly | Existing queue state, then follow-up notice |
| Consultation occurred but completion was forgotten | `in-consultation` | Clinician verifies and completes the visit | No treatment/completion is inferred |
| Location closed with unfinished work | Current nonterminal status | Review individually; closing the OPD session keeps work open by default | Follow-up notice after the elapsed-day threshold |
| Location/system offline | Current persisted status | Reconcile against actual clinical activity on return | Last known state, with later refresh |
| Appointment date passed but still looks upcoming | `pending_payment`, `pending` or `confirmed` | Use Needs review to contact and resolve | No false completed/no-show status |

The automatic no-show sweep and its unavailable endpoint are removed. Queue reads never change appointment status. Closing an OPD session never completes an in-progress consultation or marks a group as no-show. An explicit bulk cancellation option remains for operational cancellation; it leaves invoices and payments untouched for separate financial review. The canonical `cancel` request value **does not issue a refund**.

## Notification routing

| Event | Recipient | When | Reason | Delivery |
| --- | --- | --- | --- | --- |
| New booking | Assigned doctor, except when they book it themselves | After successful booking | New schedule item | One durable, appointment-keyed in-app event; patient confirmation uses the existing channel |
| Appointment approaching | No automatic recipient | None yet | Timing alone does not establish a needed intervention | Visible in existing schedule/queue |
| Booked patient not processed or appointment overdue | Reception/doctor through **Needs review** | When the relevant screen is opened or refreshed | Requires staff verification | Derived list label, no repeated toast |
| End-of-day unresolved work | Staff through **Needs review** and OPD session summary | After a full elapsed day or during session close | Reconcile actual outcome | Derived list/summary, no inferred transition |

This avoids per-appointment polling notifications and a new scheduler. If an unattended alert is later needed, it should be one idempotent event per appointment and review window, owned by an existing worker with location-local hours, after measuring whether the review view is insufficient.
