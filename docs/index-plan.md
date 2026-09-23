# MongoDB Index Plan & Validation Audit — Phase 6 Step 6.1

This document provides a comprehensive index specification and audit for all high-volume query paths across HealthOS. Each query profile defines the filter criteria, multi-tenant isolation field, sort specifications, expected cardinality, projections, current index baseline, and proposed compound index. It also catalogs single-field indexes made redundant by compound prefixes.

---

## 1. High-Volume Query Profiles

### 1.1 Appointments
* **Workload**: High-frequency patient and doctor reads, booking concurrency, no-show sweeps.
* **Filter fields**: `clinicId`, `doctorId`, `appointmentTime`, `status`
* **Tenant field**: `organizationId`
* **Sort**: `appointmentTime: 1`, `queuePosition: 1`, `createdAt: -1`
* **Expected cardinality**: ~10,000–500,000 documents per tenant annually.
* **Projection**: `_id`, `clinicId`, `doctorId`, `patientId`, `tokenNumber`, `queuePosition`, `status`, `appointmentTime`, `bookingMode`
* **Existing indexes**:
  * `{ clinicId: 1, doctorId: 1, appointmentTime: 1 }` (unique partial: `bookingMode: "time_slot"`)
  * `{ activeConsultationDoctorDayKey: 1 }` (unique sparse)
* **Compound indexes added**:
  1. `{ clinicId: 1, doctorId: 1, appointmentTime: 1, queuePosition: 1 }` — Satisfies clinic doctor schedule lookups and queue ordering without in-memory sort.
  2. `{ patientId: 1, organizationId: 1, createdAt: -1 }` — Satisfies patient portal appointment history queries.
  3. `{ status: 1, disruptionResponseDeadline: 1 }` — Supports disruption triage timeout sweep worker.
* **Write overhead**: Minimal (< 3% increase on insert/update). Indexed fields change only during state transitions.

---

### 1.2 Queue & Active Consultation
* **Workload**: Real-time lobby display updates, call-next operations, doctor cabin concurrency.
* **Filter fields**: `clinicId`, `status` (`"checked-in"`, `"in-consultation"`, `"waiting"`)
* **Tenant field**: `organizationId`
* **Sort**: `queuePosition: 1`, `tokenNumber: 1`
* **Expected cardinality**: 50–500 active tokens per clinic per day.
* **Projection**: `_id`, `tokenNumber`, `queuePosition`, `status`, `doctorStatus`, `doctorName`, `roomNumber`, `estimatedWaitTime`
* **Existing indexes**:
  * `{ clinicId: 1, status: 1, appointmentTime: 1 }`
  * `{ organizationId: 1, clinicId: 1, status: 1, appointmentTime: 1 }`
* **Compound indexes added**:
  * Covered by `{ clinicId: 1, doctorId: 1, appointmentTime: 1, queuePosition: 1 }` and `{ organizationId: 1, clinicId: 1, status: 1, appointmentTime: 1 }`.

---

### 1.3 Encounters
* **Workload**: Doctor clinical workflow, EHR chart reviews, past visit timelines.
* **Filter fields**: `patientId`, `clinicId`, `status`
* **Tenant field**: `organizationId`
* **Sort**: `createdAt: -1`
* **Expected cardinality**: 1–20 encounters per patient; 50,000–500,000 per tenant.
* **Projection**: `_id`, `organizationId`, `clinicId`, `appointmentId`, `patientId`, `doctorId`, `encounterType`, `status`, `startedAt`, `createdAt`
* **Existing indexes**:
  * `{ organizationId: 1, appointmentId: 1, status: 1 }`
  * `{ clinicId: 1, status: 1 }`
* **Compound indexes added**:
  1. `{ patientId: 1, createdAt: -1 }` — Fast chronological patient encounter timeline.
  2. `{ organizationId: 1, clinicId: 1, status: 1, createdAt: -1 }` — Tenant-scoped clinic encounter dashboard with status filters.
* **Redundant indexes removed**:
  * Single-field `organizationId: 1` (subsumed by `{ organizationId: 1, clinicId: 1, status: 1, createdAt: -1 }`)
  * Single-field `patientId: 1` (subsumed by `{ patientId: 1, createdAt: -1 }`)

---

### 1.4 Diagnostic Lab Orders
* **Workload**: Diagnostic test creation, sample collection worklist, result entry and verification.
* **Filter fields**: `patientId`, `clinicId`, `appointmentId`, `status`
* **Tenant field**: `organizationId`
* **Sort**: `createdAt: -1`, `orderDate: -1`
* **Expected cardinality**: ~50,000–200,000 per tenant annually.
* **Projection**: `_id`, `organizationId`, `clinicId`, `patientId`, `testId`, `status`, `priority`, `orderDate`, `result`, `createdAt`
* **Existing indexes**:
  * `{ appointmentId: 1, status: 1 }`
* **Compound indexes added**:
  1. `{ organizationId: 1, patientId: 1, createdAt: -1 }` — Patient EHR diagnostic history.
  2. `{ organizationId: 1, clinicId: 1, status: 1, createdAt: -1 }` — Clinic laboratory bench worklist (e.g. pending sample collection/processing).
* **Redundant indexes removed**:
  * Single-field `organizationId: 1` (subsumed by compound prefix)
  * Single-field `appointmentId: 1` (subsumed by `{ appointmentId: 1, status: 1 }`)

---

### 1.5 Clinical Notes
* **Workload**: Real-time SOAP documentation, draft auto-saving, signed notes history, versioning.
* **Filter fields**: `patientId`, `encounterId`, `isLatest`, `version`
* **Tenant field**: `organizationId`
* **Sort**: `version: -1`
* **Expected cardinality**: 100,000–1,000,000 notes per tenant.
* **Projection**: `_id`, `organizationId`, `clinicId`, `encounterId`, `patientId`, `doctorId`, `version`, `isLatest`, `subjective`, `objective`, `assessment`, `plan`, `status`
* **Compound indexes added**:
  1. `{ organizationId: 1, patientId: 1, isLatest: 1 }` — Direct lookup of patient's current active clinical notes.
  2. `{ encounterId: 1, version: -1 }` — Encounter note revision history and latest version resolution.
* **Redundant indexes removed**:
  * Single-field `organizationId: 1` (subsumed by `{ organizationId: 1, patientId: 1, isLatest: 1 }`)
  * Single-field `encounterId: 1` (subsumed by `{ encounterId: 1, version: -1 }`)

---

### 1.6 Document Uploads
* **Workload**: Patient portal uploads, OCR ingestion, clinical record attachments.
* **Filter fields**: `patientId`, `category`, `ocrStatus`
* **Tenant field**: `organizationId`
* **Sort**: `uploadedAt: -1`
* **Expected cardinality**: 20,000–100,000 documents per tenant.
* **Projection**: `_id`, `patientId`, `organizationId`, `fileName`, `fileUrl`, `fileSizeBytes`, `mimeType`, `category`, `ocrStatus`, `uploadedAt`
* **Compound indexes added**:
  1. `{ patientId: 1, uploadedAt: -1 }` — Patient document gallery sorted chronologically.
  2. `{ organizationId: 1, category: 1 }` — Tenant-wide category filtering (e.g., all lab reports).
  3. `{ organizationId: 1, patientId: 1, uploadedAt: -1 }` — Tenant-isolated patient document listing.
* **Redundant indexes removed**:
  * Single-field `organizationId: 1` (subsumed by compound prefix)
  * Single-field `patientId: 1` (subsumed by `{ patientId: 1, uploadedAt: -1 }`)

---

### 1.7 Billing & Invoices
* **Workload**: Cashier point-of-sale checkout, payment receipts, insurance billing ledger.
* **Filter fields**: `patientId`, `clinicId`, `status`
* **Tenant field**: `organizationId`
* **Sort**: `createdAt: -1`
* **Expected cardinality**: 50,000–500,000 invoices per tenant annually.
* **Projection**: `_id`, `invoiceNumber`, `organizationId`, `patientId`, `clinicId`, `subtotal`, `totalAmount`, `status`, `paymentMethod`, `createdAt`
* **Existing indexes**:
  * `{ invoiceNumber: 1 }` (unique)
  * `{ clinicId: 1, status: 1 }`
* **Compound indexes added**:
  1. `{ organizationId: 1, createdAt: -1 }` — Tenant ledger & date-bounded financial reports.
  2. `{ organizationId: 1, patientId: 1, createdAt: -1 }` — Patient billing and statement history.
* **Redundant indexes removed**:
  * Single-field `organizationId: 1` (subsumed by `{ organizationId: 1, createdAt: -1 }`)
  * Single-field `clinicId: 1` (subsumed by `{ clinicId: 1, status: 1 }`)

---

### 1.8 Audit Logs
* **Workload**: Continuous append-only write stream for compliance, targeted DPDP compliance queries.
* **Filter fields**: `organizationId`, `category`, `userId`, `action`
* **Tenant field**: `organizationId`
* **Sort**: `createdAt: -1`, `sequence: 1`
* **Expected cardinality**: Millions of records annually.
* **Existing indexes**:
  * `{ organizationId: 1, sequence: 1 }` (unique)
  * `{ organizationId: 1, createdAt: -1 }`
* **Compound indexes added**:
  1. `{ category: 1, createdAt: -1 }` — System-wide category audit sweeps (root).
  2. `{ organizationId: 1, category: 1, createdAt: -1 }` — Tenant compliance audit filtering by category and date.
* **Redundant indexes removed**:
  * Single-field `organizationId: 1` (subsumed by `{ organizationId: 1, createdAt: -1 }`)

---

### 1.9 Prescriptions
* **Workload**: Doctor e-prescribing, pharmacy dispensing queue, NMC sealing validation.
* **Filter fields**: `patientId`, `clinicId`, `encounterId`, `status`
* **Tenant field**: `organizationId`
* **Sort**: `createdAt: -1`
* **Expected cardinality**: 100,000–500,000 per tenant annually.
* **Existing indexes**:
  * `{ patientId: 1, createdAt: -1 }`
  * `{ clinicId: 1, status: 1 }`
* **Compound indexes added**:
  1. `{ encounterId: 1, createdAt: -1 }` — Encounter discharge and medication review.
* **Redundant indexes removed**:
  * Single-field `clinicId: 1` (subsumed by `{ clinicId: 1, status: 1 }`)
  * Single-field `encounterId: 1` (subsumed by `{ encounterId: 1, createdAt: -1 }`)
  * Single-field `patientId: 1` (subsumed by `{ patientId: 1, createdAt: -1 }`)

---

### 1.10 Event Processing & Messaging
* **DomainEventOutbox**:
  * Query: `{ status: { $in: ["pending", "retrying", "processing"] }, nextAttemptAt: { $lte: now }, $or: [...] }`
  * Sort: `{ nextAttemptAt: 1, createdAt: 1 }`
  * Index: `{ status: 1, nextAttemptAt: 1, createdAt: 1 }`
* **OutboundMessage**:
  * Query: `{ status: { $in: ["pending", "retrying", "processing"] }, nextAttemptAt: { $lte: now }, $or: [...] }`
  * Sort: `{ nextAttemptAt: 1, createdAt: 1 }`
  * Index: `{ status: 1, nextAttemptAt: 1, createdAt: 1 }`
  * Deduplication index: `{ idempotencyKey: 1 }` (unique sparse)
* **WorkerLease**:
  * Unique lock index: `{ name: 1 }` (unique)

---

### 1.11 Identity & Refresh Tokens
* **Workload**: Token refresh, family reuse detection, logout, session revocation.
* **Filter fields**: `userId`, `revoked`, `familyId`, `tokenHash`
* **Sort**: `createdAt: -1`
* **Compound indexes added**:
  1. `{ expiresAt: 1 }` (TTL: `expireAfterSeconds: 0`)
  2. `{ userId: 1, revoked: 1, createdAt: -1 }` — Active user session listing and concurrent session enforcement.
* **Redundant indexes removed**:
  * Single-field `userId: 1` (subsumed by `{ userId: 1, revoked: 1, createdAt: -1 }`)
  * Single-field `tokenHash: 1` (subsumed by unique constraint `{ tokenHash: 1, unique: true }`)

---

## 2. Summary of Redundant Index Removals

Removing redundant single-field indexes reduces write amplification, frees working-set RAM in WiredTiger, and preserves write throughput under heavy transactional load:

| Collection | Removed Redundant Index | Subsumed By Compound Index |
|---|---|---|
| `Encounter` | `{ organizationId: 1 }` | `{ organizationId: 1, clinicId: 1, status: 1, createdAt: -1 }` |
| `Encounter` | `{ patientId: 1 }` | `{ patientId: 1, createdAt: -1 }` |
| `LabOrder` | `{ organizationId: 1 }` | `{ organizationId: 1, patientId: 1, createdAt: -1 }` |
| `LabOrder` | `{ appointmentId: 1 }` | `{ appointmentId: 1, status: 1 }` |
| `ClinicalNote` | `{ organizationId: 1 }` | `{ organizationId: 1, patientId: 1, isLatest: 1 }` |
| `ClinicalNote` | `{ encounterId: 1 }` | `{ encounterId: 1, version: -1 }` |
| `DocumentUpload` | `{ organizationId: 1 }` | `{ organizationId: 1, category: 1 }` |
| `DocumentUpload` | `{ patientId: 1 }` | `{ patientId: 1, uploadedAt: -1 }` |
| `Invoice` | `{ organizationId: 1 }` | `{ organizationId: 1, createdAt: -1 }` |
| `Invoice` | `{ clinicId: 1 }` | `{ clinicId: 1, status: 1 }` |
| `AuditLog` | `{ organizationId: 1 }` | `{ organizationId: 1, createdAt: -1 }` |
| `Prescription` | `{ clinicId: 1 }` | `{ clinicId: 1, status: 1 }` |
| `Prescription` | `{ encounterId: 1 }` | `{ encounterId: 1, createdAt: -1 }` |
| `Prescription` | `{ patientId: 1 }` | `{ patientId: 1, createdAt: -1 }` |
| `AIChatSession` | `{ organizationId: 1 }` | `{ organizationId: 1, userId: 1, deletedAt: 1, updatedAt: -1 }` |
| `ImagingStudy` | `{ clinicId: 1 }` | `{ clinicId: 1, patientId: 1, createdAt: -1 }` |
| `RefreshToken` | `{ userId: 1 }` | `{ userId: 1, revoked: 1, createdAt: -1 }` |

---

## 3. Staging Execution Plan & Validation Guidelines

When applying these indexes to staging or production MongoDB clusters:
1. **Background Index Creation**: All index creation in production must run in the background (or use Rolling Index Build on replica sets) so read/write availability remains uninterrupted.
2. **Execution Plan Inspection**: Run `.explain("executionStats")` on each query path. Verify:
   * `stage: "IXSCAN"` (Index Scan) rather than `"COLLSCAN"` (Collection Scan).
   * `totalDocsExamined` is equal or very close to `nReturned`.
   * In-memory sorting (`stage: "SORT"`) is absent for sorted queries covered by the index.
3. **Write Overhead Measurement**:
   * Measure insertion latency before and after index creation.
   * Average write latency increase should remain under 5ms per document write.
