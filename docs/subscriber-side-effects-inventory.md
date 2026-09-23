# Domain Event Subscribers & Side Effects Inventory

This document provides a comprehensive inventory of all subscribers, side effects, idempotency key guarantees, and failure modes across the platform event bus.

---

## 1. Architecture Overview

```
[Domain Entity Operation (ACID Tx)]
                │
                ▼
   [DomainEventOutbox (Encrypted)]
                │ (Lease claim & lock)
                ▼
   [DomainEventDeliveryWorker]
                │
     ┌──────────┴──────────┐
     ▼                     ▼
[eventBus]         [domainEventBus]
  (In-process)       (Platform)
     │                     │
     ├─ NotificationService ├─ ClinicalSearchService
     └─ Realtime SSE/WS     └─ Derived Metrics
```

---

## 2. Event Inventory & Side Effects

| Event Type | Publisher | Subscribers | Side Effect Category | Idempotency Key Strategy | Failure Mode & Recovery |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `APPOINTMENT_SCHEDULED` | `controllers/public.ts`, `patientPortal.ts` | `NotificationService` | In-App Notification, Outbound Email/SMS | `event.eventId` / `metadata.idempotencyKey` | Idempotent DB upsert; Outbox retry on transient failure; Poison events -> `dead_letter` |
| `APPOINTMENT_CANCELLED` | `controllers/public.ts`, `patientPortal.ts` | `NotificationService` | In-App Notification, Real-time SSE alert | `event.eventId` | Deduplicated in `NotificationService.handleDomainEvent` |
| `PRESCRIPTION_ISSUED` | `controllers/prescriptions.ts` | `NotificationService` | In-App Notification, WhatsApp PDF link | `presc:${prescriptionId}:v${version}` | Deduplicated via outbox; customer message logged in `NotificationLog` |
| `LAB_ORDER_PLACED` | `controllers/labs.ts` | `NotificationService` | In-App Notification to phlebotomy | `lab_order:${orderId}` | Idempotent dispatch |
| `RESULT_UPLOADED` | `controllers/labs.ts`, `patientPortal.ts` | `NotificationService`, `ClinicalSearchService` | In-App Notification, Search metric bump | `lab_result:${orderId}:${resultId}` | Search counter is monotonic; notifications deduplicated |
| `MEDICATION_ADMINISTERED` | `controllers/mar.ts` | `ClinicalSearchService` | In-memory search metric counter | `mar:${adminRecordId}` | In-memory count update |
| `DISCHARGE_FINALIZED` | `controllers/encounters.ts` | `ClinicalSearchService`, `NotificationService` | Search metric bump, Patient discharge packet dispatch | `discharge:${encounterId}` | Deduplicated via outbox idempotency key |
| `INVOICE_PAID` | `controllers/billing.ts`, `invoice.ts` | `NotificationService`, `OutboundMessageWorker` | Payment receipt PDF, SMS/WhatsApp | `receipt:${paymentId}` | Unique constraint in `OutboundMessage.idempotencyKey` |
| `EMERGENCY_DISRUPTION` | `services/disruptionService.ts` | `NotificationService` | P0 High-severity push & alert banner | `disrupt:${clinicId}:${timestamp}` | Broadcast via Redis SSE |

---

## 3. Idempotency Key Invariants

1. **Write-Time Enforcement**:
   Every durable event persisted via `eventBus.publishDurable(payload, session)` assigns an `idempotencyKey`:
   `event.eventId || "domain:" + event.eventType + ":" + crypto.randomUUID()`
   Backed by a unique MongoDB index on `DomainEventOutbox.idempotencyKey`.

2. **Downstream Side-Effect Protection**:
   - `NotificationService`: Checks `Notification.findOne({ targetUser, idempotencyKey })` before inserting and before dispatching to external email/SMS providers.
   - `OutboundMessage`: Enforces unique index on `idempotencyKey`.
   - `NotificationLog`: Records `idempotencyKey` to prevent double-charging SMS/WhatsApp credits.

---

## 4. Bounded Retry & Poison Event Management

- **Retry Policy**: Exponential backoff with 25% jitter:
  $$\text{Delay} = \min(300000, 1000 \times 2^{\text{attempts}-1}) + \text{jitter}$$
- **Poison Event Containment**: Deserialization or decryption failures immediately transition status to `dead_letter` without retrying.
- **Operator Replay**:
  - Web UI / Admin API: `POST /api/admin/operations/dead-letters/:kind/:id/replay` (requires root privileges and confirmation `REPLAY`).
  - CLI: `npx tsx scripts/operator-replay.ts --replay --kind=domain_event --id=<ID> --actor=<USER_ID>`.
  - Immutable audit trail logged to `AuditLog` under action `OUTBOX_DEAD_LETTER_REPLAYED`.
