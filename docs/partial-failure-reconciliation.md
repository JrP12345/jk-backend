# Partial Failure Handling & Reconciliation Runbook

This guide specifies transaction boundaries, outbox guarantees, and operator reconciliation tools across core clinical and financial workflows.

---

## 1. Flow Transaction Boundaries & Outbox Separation

| Domain Flow | ACID Transaction Boundary | External Side Effects | Outbox Mechanism | Idempotency Key |
| :--- | :--- | :--- | :--- | :--- |
| **Appointment Booking** | `AppointmentService.bookAppointment`<br>Patient creation, slot validation, Appointment record, Invoice, and AuditLog | Slot lock release, Confirmation email, WhatsApp tracker link | `enqueueTransactionalEmail`<br>`enqueueCommunicationTemplate` | `transactional-email:booking:${appt._id}:${action}` |
| **Prescription & Encounter** | `controllers/appointment.ts`<br>Encounter state, Prescription items, CDSEvaluation, ClinicalNote, Follow-up appointment | WhatsApp Rx PDF link, Real-time queue broadcast | `DomainEventOutbox`<br>`CommunicationOutbox` | `presc:${prescriptionId}:v${version}` |
| **Laboratory Diagnostics** | `controllers/laboratory.ts`<br>LabOrder creation, Lab invoice, AuditLog | Patient notification, Real-time critical panic alert | `DomainEventOutbox`<br>`broadcastQueueUpdate` | `lab_order:${orderId}` |
| **Payments (Gateway / Counter)** | `controllers/upiWebhook.ts`<br>`controllers/appointmentPayment.ts`<br>AppointmentPayment (`captured`), Invoice (`paid`), Appointment (`paid`) | Payment receipt PDF, WhatsApp receipt, Accounting sync | `PaymentReceiptOutbox`<br>`OutboundMessage` | `receipt:${paymentId}` |
| **Outbound Messaging** | Worker claim transaction (`status: "processing"`, lease lock) | WhatsApp Cloud API, SMS gateway, SMTP | `OutboundMessage`<br>`NotificationDelivery` | `outbound:${message.idempotencyKey}` |

---

## 2. Invariants & Rules

1. **Commit First, Dispatch Later**:
   External HTTP calls and websocket broadcasts must NEVER be triggered inside an uncommitted database transaction. Side effects must either be committed into the transactional outbox (`eventBus.publishDurable(..., session)`) or triggered post-commit.

2. **Idempotent Consumers**:
   All consumers of domain events and outbox messages must be idempotent. Before taking user-visible action, check database status (e.g. `AppointmentPayment.status === "captured"`, `Notification.findOne({ idempotencyKey })`).

3. **Ambiguous State Preservation**:
   When an external payment or messaging call experiences network timeout or 5xx, the entity MUST transition to `pending_verification` / `ambiguous` rather than `failed`.

---

## 3. Operator Reconciliation Operations

### 3.1 Payment Gateway Reconciliation
Staff can reconcile stuck or ambiguous appointment payments:
- **API Endpoint:** `POST /api/appointment-payments/reconcile`
- **Payload:** `{ "appointmentId": "<APPT_ID>" }` or `{ "razorpayOrderId": "<ORDER_ID>" }`
- **Behavior:** Queries Razorpay API via `resilientHttpClient`. If captured, atomically settles invoice and appointment in MongoDB with an immutable `AuditLog` entry.

### 3.2 Dead-Letter Replay
Operators can inspect and replay terminal failed/dead-letter outbox jobs:
- **API Endpoints:**
  - `GET /api/admin/operations/dead-letters?kind=domain_event&limit=50`
  - `POST /api/admin/operations/dead-letters/:kind/:id/replay` (Body: `{ "confirmation": "REPLAY" }`)
- **CLI Command:**
  ```bash
  npx tsx scripts/operator-replay.ts --metrics
  npx tsx scripts/operator-replay.ts --list --kind=domain_event
  npx tsx scripts/operator-replay.ts --replay --kind=domain_event --id=<ID> --actor=<ROOT_USER_ID>
  npx tsx scripts/operator-replay.ts --replay-all --kind=domain_event --actor=<ROOT_USER_ID>
  ```
