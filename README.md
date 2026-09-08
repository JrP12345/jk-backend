# Ananta Health — Multi-Tenant Healthcare SaaS Platform

Ananta Health (codename **Project JK**) is a production-grade, AI-first, multi-tenant healthcare SaaS platform built for Indian outpatient clinics and polyclinics. It covers the full lifecycle of clinic operations — from organization onboarding and patient registration through real-time OPD queue management, in-cabin clinical encounters, laboratory diagnostics, pharmacy fulfillment, billing (with GST/UPI), WhatsApp patient communication, and India ABDM (Ayushman Bharat Digital Mission) national health stack integration.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Technology Stack](#technology-stack)
- [Monorepo Structure](#monorepo-structure)
- [Domain Model & Database Schema](#domain-model--database-schema)
- [User Roles & RBAC](#user-roles--rbac)
- [Implemented Features](#implemented-features)
- [API Surface](#api-surface)
- [Real-Time Communication](#real-time-communication)
- [Integrations](#integrations)
- [Security](#security)
- [Testing](#testing)
- [Environment Variables](#environment-variables)
- [Local Development Setup](#local-development-setup)
- [Deployment](#deployment)
- [Known Limitations & Incomplete Areas](#known-limitations--incomplete-areas)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Next.js 16 Frontend                         │
│  App Router · TailwindCSS 4 · Zustand · React Query · Lucide   │
│  Port 3000                                                      │
└──────────────────────────┬──────────────────────────────────────┘
                           │ REST + WebSocket
┌──────────────────────────▼──────────────────────────────────────┐
│                    Fastify 5 Backend API                         │
│  TypeScript (native strip-types) · Mongoose 9 · Node 20+        │
│  Port 5000                                                      │
├─────────────────────────────────────────────────────────────────┤
│  Middleware: JWT RS256 Auth · RBAC · Tenant Isolation · CSRF    │
│             Rate Limiting · Input Sanitization · Compression     │
├─────────────────────────────────────────────────────────────────┤
│  Notification: Email (SMTP) · WhatsApp (Meta Cloud API) · SSE  │
│               WebSocket · In-App · Queued delivery              │
├──────────┬──────────┬──────────┬────────────┬───────────────────┤
│ MongoDB  │  Redis   │ R2/S3    │ ABDM       │ Razorpay          │
│ (Primary)│ (Cache)  │ (Files)  │ (NHA API)  │ (Payments)        │
└──────────┴──────────┴──────────┴────────────┴───────────────────┘
```

The system is a **two-service monorepo** with fully separate Git repositories:

- **Backend** (`backend/`): Fastify REST API server with WebSocket support, all business logic, data persistence, and external integrations.
- **Frontend** (`frontend/`): Next.js 16 App Router SPA with server-side rendering, role-based layouts, and a custom UI component library.

Communication is via REST API calls (Axios with httpOnly cookie auth) and WebSocket connections for real-time queue/notification updates.

---

## Technology Stack

### Backend
| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ with `--experimental-strip-types` (native TS execution, no build step) |
| Framework | Fastify 5 |
| Database | MongoDB 7+ via Mongoose 9 (connection pooling, audit plugin) |
| Cache/PubSub | Redis (IoRedis 6) — optional, falls back to in-memory |
| Auth | RS256 asymmetric JWT (shared cluster secrets via env/K8s Secret, auto-generated in dev only), httpOnly cookies |
| File Storage | Cloudflare R2 (S3-compatible) via AWS SDK |
| Email | Nodemailer (SMTP) with per-org gateway override |
| Payments | Razorpay (order creation, webhook verification, refunds) |
| 2FA | TOTP via `speakeasy` with QR provisioning |
| Testing | Vitest with `mongodb-memory-server` |

### Frontend
| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router, React 19, React Compiler) |
| Styling | TailwindCSS 4 (PostCSS plugin) |
| State | Zustand (auth, clinic, module stores) |
| Data Fetching | TanStack React Query 5, Axios |
| Icons | Lucide React |
| Testing | Vitest, React Testing Library, jsdom |

---

## Monorepo Structure

### Backend (`backend/`)

```
backend/
├── index.ts                 # Fastify app bootstrap, plugin/route registration, health probes
├── db.ts                    # MongoDB connection with pool sizing
├── controllers/             # 49 controller files — route handlers with business logic
├── models/                  # 67 Mongoose schemas (domain entities)
├── routes/                  # 41 Fastify route plugins (URL → controller wiring)
├── services/                # Domain services & external integrations
│   ├── ai/                  #   AI gateway, context engine, tool routing, agents
│   ├── billing/             #   Razorpay, subscription lifecycle
│   ├── payment/             #   Payment provider abstraction
│   └── providers/           #   Billing, consultation, lab, document upload providers
├── middleware/              # auth, CSRF, sanitize, subscription guard, module guard
├── notifications/           # Multi-channel notification system
│   ├── providers/           #   Email provider (SMTP/Nodemailer)
│   ├── services/            #   NotificationService, Queue, RuleEngine
│   └── websocket.ts         #   SSE + WebSocket real-time broadcast
├── events/                  # CloudEvent-based domain event bus & type definitions
├── jobs/                    # Background jobs (disruption timeout)
├── platform/                # Platform gateway, workflow, search, interoperability stubs
├── utilities/               # Helpers, encryption, tenant isolation, permissions, logging
├── schemas/                 # Fastify JSON schema validators (clinical, billing, etc.)
├── scripts/                 # DB seeders, migrations, root admin setup
├── tests/                   # 90 integration test files
├── keys/                    # Dev-only auto-generated RS256 keypair (gitignored; production uses env vars)
├── data/                    # Static reference data
├── types/                   # Shared TypeScript type definitions
├── Dockerfile               # Multi-stage production image (Node 20 Alpine)
└── vitest.config.ts         # Test runner configuration
```

### Frontend (`frontend/`)

```
frontend/
├── src/
│   ├── app/                     # Next.js App Router pages
│   │   ├── (auth)/              #   Login, register, forgot password
│   │   ├── (dashboard)/         #   Authenticated dashboard layout
│   │   │   └── dashboard/       #     22 feature pages (queue, patients, billing, etc.)
│   │   ├── browse/              #   Public clinic/doctor marketplace
│   │   ├── check-in/            #   Patient self-check-in kiosk
│   │   ├── join/                #   Org invite acceptance flow
│   │   ├── pricing/             #   SaaS plan pricing page
│   │   ├── queue-tv/            #   Waiting room TV display (multi-cabin)
│   │   ├── track/               #   Patient live queue tracker (public)
│   │   └── verify-email/        #   Email verification callback
│   ├── components/
│   │   ├── ui/                  #   36 reusable UI primitives (Modal, Table, Toast, etc.)
│   │   ├── clinical/            #   26 clinical feature components
│   │   ├── ai/                  #   AI copilot components
│   │   ├── analytics/           #   Dashboard analytics charts
│   │   ├── billing/             #   Billing & invoice components
│   │   ├── pharmacy/            #   Pharmacy fulfillment UI
│   │   ├── ehr/                 #   EHR/timeline components
│   │   ├── notifications/       #   Notification center
│   │   └── dashboard/           #   Dashboard layout pieces
│   ├── store/                   # Zustand stores (auth, clinic, module)
│   ├── hooks/                   # Custom hooks (notifications, R2 upload, AI session)
│   ├── lib/                     # API client, permissions, route guards
│   ├── services/                # Frontend service layer (billing, SOAP, orders, etc.)
│   ├── events/                  # Frontend event system
│   ├── providers/               # React context providers
│   └── utils/                   # Audio chimes, formatters
├── public/                      # Static assets
├── Dockerfile                   # Multi-stage Next.js production image
└── vitest.config.ts
```

---

## Domain Model & Database Schema

The system has **67 Mongoose models**. The core domain entities and their relationships:

### Core Entities

| Model | Purpose |
|---|---|
| `Organization` | Top-level tenant. Holds plan tier, SMTP config, WhatsApp gateway config, GSTIN. |
| `Clinic` | Physical location under an org. Has address, UPI VPA, timings. |
| `User` | Authentication identity. Roles: `root`, `admin`, `doctor`, `receptionist`, `nurse`, `lab_tech`, `pharmacist`, `cashier`, `patient`, `family_member`. |
| `Doctor` | Doctor profile linked to a `User`. Stores specialization, NMC reg number, qualifications. |
| `DoctorAssignment` | Maps a doctor to a clinic with fees, cabin number, working hours, booking mode. |
| `Patient` | Clinical patient record. Contains demographics, ABHA number/address, allergies, care contexts, consent requests. |
| `Appointment` | Central transactional entity. Covers scheduling, queue position, token number, vitals, investigation results, consultation phases, disruption triage, panic alerts, ABDM links. |

### Clinical Entities

| Model | Purpose |
|---|---|
| `ClinicalNote` | SOAP notes, structured observations, AI-generated summaries, signed status. |
| `Encounter` | Clinical encounter instance linked to appointment and patient. |
| `Observation` | Discrete clinical observations (vitals, measurements). |
| `Prescription` | Medication prescriptions linked to appointments. |
| `LabTest` | Lab test catalog (name, code, department, sample type, price, normal range). |
| `LabOrder` | Lab order lifecycle: ordered → sample-collected → processing → result-uploaded. |
| `ImagingStudy` | Radiology/imaging study orders and results. |
| `OpdTemplate` | Reusable OPD consultation templates with preset prescriptions, investigations. |
| `SoapTemplate` | SOAP note templates. |

### Billing & Payments

| Model | Purpose |
|---|---|
| `Invoice` | GST-compliant invoice with line items, CGST/SGST/IGST, e-invoice hooks. |
| `AppointmentPayment` | Payment records for appointments (Razorpay order/payment IDs, UPI). |
| `ServiceCatalog` | Service catalog items with HSN/SAC codes and prices. |
| `InsuranceTariff` | Insurance tariff schedules. |
| `PreAuthorization` | Insurance pre-authorization requests and approvals. |
| `Claim` | Insurance claim submissions and tracking. |
| `CashierShift` | Cashier shift open/close with cash reconciliation. |

### SaaS & Subscription

| Model | Purpose |
|---|---|
| `SaaSPlan` | Plan definitions (Starter/Pro/Enterprise) with feature flags and resource limits. |
| `Subscription` | Org subscription state (active/trial/expired/cancelled). |
| `SaaSInvoice` | Platform-level SaaS billing invoices. |
| `SubscriptionPayment` | SaaS subscription payment records. |
| `UsageRecord` | Resource usage metering per org. |
| `ModuleRegistry` | Per-org feature module enable/disable registry. |

### AI

| Model | Purpose |
|---|---|
| `AIChatSession` | Persistent AI conversation sessions per user. |
| `AIOrganizationConfig` | Per-org AI configuration (model, temperature). |
| `AIPromptTemplate` | Managed prompt templates for clinical AI. |
| `AIToolExecutionLog` | Audit log for AI tool function calls. |
| `AIObservabilityMetric` | AI inference observability metrics. |
| `CDSEvaluation` | Clinical Decision Support evaluation records. |

### Notifications & Communication

| Model | Purpose |
|---|---|
| `Notification` | In-app notification records. |
| `NotificationDelivery` | Delivery tracking per channel (email, SMS, WhatsApp, push). |
| `NotificationLog` | Historical notification audit log. |
| `NotificationPreference` | Per-user notification channel preferences. |
| `NotificationTemplate` | Notification content templates. |

### Other

| Model | Purpose |
|---|---|
| `AuditLog` | Comprehensive audit trail for all state mutations. |
| `Consent` | Patient consent records (break-glass access control). |
| `DocumentUpload` | File upload metadata (R2 references). |
| `FamilyRelationship` | Family member linkage between patients. |
| `OrgInvite` / `OrgMember` | Team invitation and membership. |
| `RefreshToken` | JWT refresh token records. |
| `Role` / `Permission` | Custom RBAC role and permission documents. |
| `ShiftRoster` | Staff shift scheduling. |
| `Task` | Internal task management. |
| `TeleconsultationSession` | Teleconsultation session metadata. |
| `PatientFeedback` | Patient satisfaction surveys. |
| `OtpVerification` | OTP verification records (phone auth, ABDM). |
| `DoctorDayOverride` | Doctor availability overrides and disruption declarations. |
| `OpdSession` | Doctor OPD shift sessions (start/end/break tracking). |
| `Counter` | Atomic sequence counters (token numbers, invoice numbers). |
| `OnboardingDraft` | In-progress onboarding wizard state. |

---

## User Roles & RBAC

The system implements a **granular RBAC model** with 10 built-in roles. Each role has a default permission set defined in `utilities/permissions.ts`, backed by a `Role` document in MongoDB for runtime customization.

| Role | Description | Key Permissions |
|---|---|---|
| `root` | Platform super-admin. Bypasses all auth/tenant checks. | All |
| `admin` | Organization admin. Full access within their tenant. | MANAGE_STAFF, MANAGE_CLINICS, MANAGE_BILLING, MANAGE_APPOINTMENTS, VIEW_ANALYTICS, MANAGE_EHR, MANAGE_ORDERS |
| `doctor` | Clinician. Clinical encounter workflows. | VIEW_PATIENTS, MANAGE_APPOINTMENTS, MANAGE_QUEUE, MANAGE_EHR, MANAGE_CLINICAL_NOTES, MANAGE_ORDERS |
| `receptionist` | Front desk. Patient registration, queue, billing. | MANAGE_PATIENTS, MANAGE_APPOINTMENTS, MANAGE_QUEUE, MANAGE_BILLING |
| `nurse` | Nurse. Vitals capture, medication administration. | MANAGE_QUEUE, MANAGE_EHR, ADMINISTER_MEDICATION |
| `lab_tech` | Laboratory technician. | MANAGE_LAB_TESTS, MANAGE_ORDERS |
| `pharmacist` | Pharmacy staff. | MANAGE_MEDICINES, VIEW_EHR |
| `cashier` | Billing counter staff. | MANAGE_BILLING, VIEW_BILLING |
| `clinic_manager` | Branch manager. | MANAGE_PATIENTS, MANAGE_QUEUE, MANAGE_BILLING |
| `patient` | Patient self-service portal. | VIEW_APPOINTMENTS, VIEW_EHR, VIEW_BILLING |
| `family_member` | Family member with delegated access. | VIEW_APPOINTMENTS, VIEW_EHR, VIEW_BILLING |

**Authorization flow:**
1. `authenticate` — RS256 JWT verification from httpOnly cookie (zero DB lookups).
2. `authorize(role)` / `checkPermission(perm)` / `checkAnyPermission(...)` — Role/permission evaluation against the Role document.
3. `enforceTenantIsolation` — Cross-tenant access prevention (`organization_id` from JWT vs request target).
4. `checkClinicAccess` / `checkOperationalRecordAccess` — Row-level scoping to the caller's clinics within their organization.

---

## Implemented Features

### 1. Organization Onboarding & Multi-Tenancy
- **Guided onboarding wizard**: Organization → Admin user → Clinic(s) → Doctor(s) → 2FA setup.
- **Strict tenant isolation**: Every query is scoped to `organizationId` via middleware + utility helpers.
- **Plan-gated resource limits**: SaaS plan controls max clinics, doctors, staff, patients, appointments.
- **Module registry**: Per-org feature module enable/disable (e.g., `ai`, `whatsapp`, `laboratory`, `pharmacy`).

### 2. Real-Time OPD Queue Management
- **Sequential queue** with auto-assigned token numbers per clinic/doctor/day.
- **Time-slot booking** mode as alternative (mutual exclusion with sequential).
- **Queue lifecycle**: `pending` → `confirmed` → `checked-in` → `in-consultation` → `completed`.
- **STAT emergency triage**: Immediate queue priority override with chime notification.
- **Standby / park patient**: 2-phase consultation support (initial consult → investigation → report review).
- **1-click cabin recall**: Re-prioritize standby patient to position 1 with bilingual (Hindi/English) TV lounge announcements.
- **Doctor break management**: Break start/end with countdown timers and patient notifications.
- **OPD session lifecycle**: Start, break, end-of-day with standby reconciliation.
- **Waiting room TV display** (`/queue-tv/:clinicId`): Public multi-cabin real-time token board.
- **Live patient tracker** (`/track/:appointmentId`): Public real-time position tracking page.
- **Proactive delay alerts**: Detect queue overruns and dispatch WhatsApp notifications with revised ETAs.
- **Turn-approaching notifications**: Autonomous alerts when patient is N positions from being called.
- **Quick walk-in registration**: Inline patient + appointment creation from queue page.

### 3. Doctor Availability & Disruption Management
- **Working hours schedules** per doctor-clinic assignment.
- **Day overrides**: Mark doctor as unavailable, delayed, or extended for specific dates.
- **Disruption service**: When a doctor declares disruption mid-day:
  - Affected waiting patients are flagged for triage.
  - Automated WhatsApp notifications with transfer/cancel/reschedule options.
  - Patient triage actions: transfer to another doctor, cancel with refund, priority reschedule.
  - Fee variance reconciliation for different doctor fees.
  - Timeout job auto-escalates un-triaged patients.

### 4. Clinical Encounter & EHR
- **In-cabin SOAP note editor** with structured observations, AI-assisted note generation.
- **Pre-consultation nurse vitals**: BP, pulse, temperature, SpO2, weight, height, BMI, blood sugar, allergies.
- **OPD clinical preset templates**: Reusable diagnosis/prescription/investigation templates per speciality.
- **Prescription management**: NMC-compliant prescription generation with formatted output.
- **Drug interaction & allergy checks**: Prescription safety validation engine.
- **Clinical decision support (CDS)**: Rule-based evaluation engine for clinical alerts.
- **NEWS2 early warning score**: National Early Warning Score 2 calculator.
- **Follow-up recall register**: Track recommended follow-ups and dispatch recall messages.
- **Patient timeline**: Longitudinal EHR view across all encounters.
- **Document upload**: Patient documents stored in Cloudflare R2 with pre-signed URLs.

### 5. Laboratory Diagnostics
- **Lab test catalog CRUD** (name, code, department, sample type, price, reference range).
- **Lab order lifecycle**: ordered → sample-collected → processing → result-uploaded.
- **In-cabin lab order modal**: Doctor places orders directly from consultation view.
- **Result upload with appointment sync**: Results automatically populate `investigationResults` on appointment.
- **Lab panic critical value detection**: Automatic evaluation of Troponin, Potassium, Glucose, Platelets, Hemoglobin against critical thresholds. Triggers `CLINICAL_PANIC_ALERT` WebSocket broadcast.
- **In-cabin investigation viewer**: View results with historical comparison and red alert banners for critical values.
- **Lab TAT (turnaround time) metrics**: Analytics for STAT vs routine completion times.

### 6. Pharmacy & Inventory
- **Medicine catalog** with batch tracking, expiry dates.
- **Pharmacy fulfillment workflow**: Prescription → dispense → complete.
- **Inventory management**: Stock levels, batch FIFO, low-stock alerts.
- **Prescription-to-dispense pipeline**: Pharmacist receives pending prescriptions from completed consultations.

### 7. Billing, Invoicing & Payments
- **GST-compliant invoicing**: CGST/SGST/IGST calculations, B2C/B2B classification, HSN/SAC codes.
- **Service catalog**: Configurable service items with pricing and tax rates.
- **Auto-invoice generation**: On consultation completion, auto-generate invoice with consultation + pharmacy + lab line items.
- **Razorpay integration**: Online payment order creation, payment verification, webhook processing.
- **UPI/QR payment**: Counter-top dynamic UPI QR generation via clinic's VPA.
- **Cashier shift management**: Open/close shifts with cash reconciliation and transaction summaries.
- **Insurance pre-authorization** and claim submission workflows.
- **Insurance tariff management**.
- **SaaS subscription billing**: Plan upgrades, Razorpay subscription payments, usage metering.

### 8. WhatsApp Integration (Meta Cloud API)
- **Multi-channel message dispatch**: Booking confirmation, consultation complete, prescription delivery, delay alerts.
- **WhatsApp credits system**: Per-org monthly quotas with prepaid top-up packs (Bronze/Silver/Gold), auto-recharge.
- **Inbound conversational chatbot**: Patients text keywords to get responses:
  - `HI`/`HELLO` → Welcome with booking options.
  - `BOOK` → Booking link with next available slots.
  - `STATUS`/`TOKEN` → Live queue position tracker.
  - `RX`/`PRESCRIPTION`/`PDF` → Prescription summary + direct PDF document attachment.
  - `BILL`/`INVOICE` → Tax invoice PDF document attachment.
  - `CANCEL` → Cancel active appointment.
  - `HELP` → Command menu.
- **Direct PDF document delivery**: Signed prescription and invoice PDFs sent as WhatsApp media attachments (`type: "document"`).
- **Webhook verification**: Meta webhook signature validation (HMAC SHA-256).

### 9. ABDM (Ayushman Bharat Digital Mission) Integration
- **ABHA verification**: OTP-based ABHA number/address verification flow.
- **Scan & Share**: QR-code based patient registration from ABHA card.
- **Patient search**: Search ABDM registry by ABHA number.
- **Milestone 3 (M3) Care-Context Linking**: Link OPD encounters as verified care contexts in patient's ABHA account.
- **HL7 FHIR R4 Bundle Generation**: NRCES/NHA compliant document bundles (`PrescriptionRecord`, `DiagnosticReportRecord`) with `Composition`, `Practitioner`, `Organization`, `Patient`, `Encounter`, `MedicationRequest` resources.
- **HIU Consent Management**: Create consent requests, track consent status, fetch external health data from multi-hospital ABDM network.

### 10. AI Platform
- **Multi-provider AI gateway**: Supports Gemini, Groq, OpenAI with automatic failover.
- **Clinical AI copilot**: Contextual AI assistant with patient/encounter context injection.
- **AI-powered SOAP note generation**: Generate clinical notes from encounter context.
- **Tool execution framework**: Registered AI tools with execution logging.
- **Prompt governance**: Managed prompt templates with version control.
- **Context engine**: Builds rich clinical context from patient history, current encounter, lab results.
- **AI observability**: Inference latency, token usage, error rate metrics.
- **Per-org AI configuration**: Model selection, temperature, feature flags per organization.
- **Knowledge retrieval engine**: Clinical knowledge base for RAG-style responses.

### 11. Notification System
- **Multi-channel delivery**: In-app (SSE/WebSocket), email (SMTP), WhatsApp.
- **Notification queue**: Async delivery with retry logic and deduplication.
- **Rule engine**: Configurable notification rules per event type.
- **User preferences**: Per-user channel opt-in/opt-out.
- **Notification templates**: Templated content with variable substitution.
- **Real-time delivery**: SSE streams and WebSocket connections for instant in-app updates.

### 12. Analytics & Reporting
- **Operational analytics**: Queue wait times, consultation duration, no-show rates.
- **Financial analytics**: Revenue by doctor/service, payment method breakdown, daily collections.
- **Lab TAT metrics**: STAT vs routine turnaround compliance.
- **Report export**: CSV/PDF export capabilities.

### 13. Patient Portal & Public Pages
- **Patient self-service**: View appointments, prescriptions, bills, lab results.
- **Online booking**: Browse doctors, select slots, book and pay online.
- **Public clinic directory** (`/browse`): Searchable clinic/doctor marketplace.
- **Patient self-check-in** (`/check-in`): QR-based arrival check-in kiosk.
- **Patient feedback**: Post-consultation satisfaction surveys (star rating + comments).
- **Family member access**: Delegated access to linked patient records.

### 14. Staff & Administration
- **Staff management**: CRUD for doctors, nurses, receptionists, lab techs, pharmacists, cashiers.
- **Shift roster management**: Staff scheduling with shift patterns.
- **Task management**: Internal task assignment and tracking.
- **Audit logging**: Comprehensive audit trail for all write operations.
- **Custom RBAC**: Create custom roles with granular permission matrix.
- **SSO**: Single sign-on integration stubs.

---

## API Surface

All routes are prefixed with `/api/`. The API supports versioning via `/api/v1/` (rewritten to `/api/`). Swagger/OpenAPI documentation is available at `/documentation` in non-production environments.

### Key Route Groups

| Route Prefix | Controller | Description |
|---|---|---|
| `/api/auth/*` | `auth.ts` | Register, login, logout, refresh, password reset, 2FA, email verification |
| `/api/onboarding/*` | `onboarding.ts` | Organization, clinic, doctor, staff creation wizard |
| `/api/queue/*` | `queue.ts` | Queue CRUD, call-next, park, resume, STAT, delay alerts, session management |
| `/api/appointments/*` | `appointment.ts` | Booking, cancel, reschedule, status updates |
| `/api/patients/*` | `patient.ts` | Patient CRUD, search, merge |
| `/api/clinical/*` | `clinicalNote.ts` | SOAP notes, observations, encounter management |
| `/api/laboratory/*` | `laboratory.ts` | Lab tests, orders, results, TAT metrics |
| `/api/pharmacy/*` | `medicine.ts` | Medicine catalog, batches, dispensing, inventory |
| `/api/billing/*` | `billing.ts`, `invoice.ts` | Invoice CRUD, GST calculations, payment reconciliation |
| `/api/appointment-payments/*` | `appointmentPayment.ts` | Razorpay order/verify, UPI payment tracking |
| `/api/abdm/*` | `abdm.ts` | ABHA verification, care-context linking, FHIR bundles, HIU consent |
| `/api/ai/*` | `ai.ts` | Chat sessions, clinical copilot, SOAP generation |
| `/api/webhooks/whatsapp` | `whatsappWebhook.ts` | Meta WhatsApp inbound messages & webhook verification |
| `/api/webhooks/upi` | `upiWebhook.ts` | UPI payment callback processing |
| `/api/notifications/*` | (notifications routes) | In-app notifications, real-time SSE, preferences |
| `/api/public/*` | `public.ts` | Queue TV, patient tracker, clinic directory, online booking |
| `/api/analytics/*` | `analytics.ts` | Dashboard metrics, operational reports |
| `/api/feedback/*` | `feedback.ts` | Patient satisfaction surveys |
| `/api/roles/*` | `role.ts` | Custom RBAC role management |
| `/api/shifts/*` | `shifts.ts` | Staff shift scheduling |
| `/api/platform/*` | `gateway.ts` | Platform health, module registry |
| `/api/health` | (inline) | Health check, liveness, readiness probes |

---

## Real-Time Communication

### WebSocket Events

The backend broadcasts real-time events via WebSocket connections per clinic:

| Event Type | Trigger |
|---|---|
| `QUEUE_UPDATED` | Any queue state change |
| `QUEUE_CALL_NEXT` | Patient called for consultation |
| `QUEUE_EMERGENCY_STAT` | STAT emergency triage activated |
| `PATIENT_RETURNED` | Standby patient returned to clinic |
| `PATIENT_RECALLED_TO_CABIN` | Doctor recalls patient for report review |
| `CLINICAL_PANIC_ALERT` | Critical lab panic value detected |
| `LAB_RESULTS_READY` | Lab results uploaded for a patient |
| `LAB_ORDER_PLACED` | New lab order placed |
| `PAYMENT_RECEIVED` | Payment confirmed |
| `PRESCRIPTION_ISSUED` | Prescription created |
| `PRESCRIPTION_DISPENSED` | Pharmacy dispensed medication |
| `DISRUPTION_TRIAGE_REQUIRED` | Doctor disruption affecting waiting patients |
| `NOTIFICATION_RECEIVED` | New in-app notification |

### SSE Streams
- Per-user SSE connections for notification delivery.
- Used as fallback when WebSocket is unavailable.

---

## Integrations

| Integration | Status | Details |
|---|---|---|
| **MongoDB** | ✅ Implemented | Primary data store with connection pooling, audit plugin |
| **Redis** | ✅ Implemented (optional) | Rate limiting, slot locking, session cache. Falls back to in-memory if unavailable |
| **Cloudflare R2** | ✅ Implemented | Document/image storage via S3-compatible API with pre-signed URLs |
| **Razorpay** | ✅ Implemented | Payment orders, verification, webhooks, refunds, subscriptions |
| **Meta WhatsApp Cloud API** | ✅ Implemented | Outbound messages, document attachments, inbound webhook. Sandbox mock fallback when no credentials |
| **ABDM / NHA** | ✅ Implemented (sandbox) | OTP verification, scan-share, care-context linking, FHIR R4 bundles. Uses sandbox simulation mode |
| **SMTP Email** | ✅ Implemented | Nodemailer with per-org SMTP gateway override |
| **PACS** | 🔧 Stub | `PACS_BASE_URL` env var referenced but integration is placeholder |
| **Teleconsultation** | 🔧 Stub | Session model and routes exist; actual video provider integration is external |
| **Google SSO** | 🔧 Partial | `GoogleAuthService` exists; routes registered |

---

## Security

### Authentication
- **RS256 asymmetric JWT**: In production, keypairs are loaded via cluster environment secrets (`JWT_PRIVATE_KEY_BASE64` / `JWT_PUBLIC_KEY_BASE64` generated via `npm run generate:keys`), guaranteeing zero session invalidation across horizontal pod replicas and rolling deployments. In development, keys fall back to `./keys/`. Access tokens in httpOnly cookies (15min TTL), refresh tokens in DB (7d TTL).
- **Phone OTP authentication**: Alternative to email/password.
- **Two-Factor Authentication**: TOTP with QR code provisioning via `speakeasy`.
- **Account lockout**: Progressive lockout after 5 failed login attempts.
- **Password policy**: Min 8 chars, mixed case, digit, special character (enforced in production).

### Authorization
- **RBAC with permission evaluation**: Role documents in DB serve as single source of truth.
- **Tenant isolation middleware**: JWT `organization_id` enforced on all scoped operations.
- **Row-level security**: Clinic access scoping within organizations.

### Transport & Input
- **CSRF protection**: Token-based CSRF guard on state-changing requests.
- **NoSQL injection sanitization**: Request body/query sanitizer middleware.
- **Rate limiting**: Global (500 req/min production, 10k in dev/test) with Redis backing.
- **Security headers**: HSTS, X-Content-Type-Options, X-Frame-Options, CSP, Referrer-Policy.
- **Sensitive field redaction**: Authorization headers, cookies, passwords redacted from logs.

### Data Protection
- **Field-level encryption**: `ENCRYPTION_KEY` for encrypting sensitive credentials in MongoDB.
- **PHI anonymizer**: Utility for anonymizing Protected Health Information in logs/exports.
- **PHI audit**: Access logging for protected health data.
- **Audit logging**: All mutations tracked via global Mongoose plugin with userId, action, timestamp.

---

## Testing

The backend has **90 integration test files** using Vitest with `mongodb-memory-server` for isolated testing.

### Running Tests

```bash
# All backend tests
cd backend && npm test

# Specific test file
cd backend && npx vitest run tests/auth.test.ts

# Frontend type check
cd frontend && npx tsc --noEmit
```

### Test Coverage Areas
- Authentication & authorization (login, 2FA, RBAC, permissions)
- Onboarding wizard flow
- Appointment booking & queue management
- Clinical notes, SOAP editor, prescriptions
- Laboratory order lifecycle & panic values
- Billing, invoicing, payment flows
- WhatsApp chatbot inbound/outbound
- ABDM integration (OTP, scan-share, care-context, FHIR)
- AI platform (gateway, chat persistence, tools)
- Doctor disruption & availability management
- Notification delivery & real-time updates
- Multitenancy & tenant isolation
- Security hardening (CSRF, rate limits, sanitization, VAPT)
- Dynamic UPI / SoundBox
- Pharmacy inventory & fulfillment
- Teleconsultation sessions
- Search, analytics, feedback
- Subscription & SaaS billing

### Test Configuration
- Environment: `NODE_ENV=test`
- Database: In-memory MongoDB (via `mongodb-memory-server`)
- Redis: In-memory fallback
- Timeout: 60s per test
- Serial execution: `fileParallelism: false`
- Setup: `tests/setup.ts` (connects in-memory DB, drops collections between runs)

---

## Environment Variables

See `backend/.env.example` for the full list. Key variables:

| Variable | Required | Description |
|---|---|---|
| `PORT` | No (default: 5000) | Backend server port |
| `NODE_ENV` | No (default: development) | Environment mode |
| `MONGODB_URI` | Yes | MongoDB connection string |
| `CORS_ALLOWED_ORIGINS` | No (default: localhost:3000) | Comma-separated allowed origins |
| `REDIS_URL` | No | Redis connection URL (optional, in-memory fallback) |
| `ENCRYPTION_KEY` | Yes (production) | 64-char hex key for field-level encryption |
| `CLOUDFLARE_ACCOUNT_ID`, `R2_*` | For file uploads | Cloudflare R2 storage credentials |
| `SMTP_*` | For email delivery | SMTP server credentials |
| `GEMINI_API_KEY` / `GROQ_API_KEY` / `OPENAI_API_KEY` | For AI features | AI provider API key (configure one) |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | For payments | Razorpay integration credentials |
| `NEXT_PUBLIC_API_URL` | Frontend | Backend API base URL (default: `http://localhost:5000/api`) |

---

## Local Development Setup

### Prerequisites
- Node.js 20+
- MongoDB 7+ (local or Atlas)
- Redis (optional)

### Backend

```bash
cd backend
cp .env.example .env
# Edit .env with your MongoDB URI and other credentials
npm install
npm run dev
# Server starts at http://localhost:5000
# Swagger UI at http://localhost:5000/documentation
```

### Frontend

```bash
cd frontend
cp .env.example .env.local
# Set NEXT_PUBLIC_API_URL=http://localhost:5000/api
npm install
npm run dev
# App starts at http://localhost:3000
```

### Database Seeding

```bash
cd backend
npm run seed:clean     # Fresh clean database with minimal setup
npm run seed           # Full seed with sample data
npm run seed:clinic1   # Seed a single demo clinic
```

---

## Deployment

Both services ship with multi-stage Dockerfiles optimized for production.

### Backend Docker

```dockerfile
# Node 20 Alpine, production deps only
# Runs TypeScript natively via --experimental-strip-types
# Healthcheck: GET /api/health/readiness
# Exposes port 5000
```

### Frontend Docker

```dockerfile
# 3-stage build: deps → build (next build) → runner
# NEXT_PUBLIC_API_URL baked at build time via ARG
# Healthcheck: GET /
# Exposes port 3000
```

### Health Probes

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Basic health check |
| `GET /api/health/liveness` | Kubernetes liveness probe |
| `GET /api/health/readiness` | Readiness probe (checks MongoDB + Redis connectivity; surfaces degraded single-node mode) |
| `GET /api/health/synthetic` | Deep synthetic canary (isolated DB heartbeat, diagnostic engine panic threshold verification, Redis WebSocket fan-out) |

### Graceful Shutdown
The backend handles `SIGTERM`/`SIGINT` gracefully:
1. Stops background jobs (disruption timeout).
2. Drains notification queue.
3. Closes Fastify server.
4. Disconnects MongoDB.
5. Quits Redis client.

---

## Known Limitations & Incomplete Areas

| Area | Status | Notes |
|---|---|---|
| **ABDM integration** | Sandbox only | Uses simulated ABDM responses. Production NHA gateway integration requires ABDM sandbox certification and production credentials. |
| **PACS / Radiology** | Stub | Model and routes exist; actual DICOM viewer and PACS server integration are placeholders. |
| **Teleconsultation** | Partial | Session model and API routes exist; no actual video conferencing provider (Twilio/Agora/Jitsi) integrated. |
| **E-Invoice (GST)** | Schema only | `eInvoiceIrn` and `eInvoiceQrCode` fields exist on Invoice; actual NIC e-invoice API integration not implemented. |
| **Google SSO** | Partial | Service file exists; full OAuth flow may need completion for production. |
| **SMS delivery** | Partial | Service exists; no dedicated SMS gateway (MSG91/Twilio) configured — uses WhatsApp as primary channel. |
| **Push notifications** | Not implemented | Notification model supports push channel; no FCM/APNs integration. |
| **Report PDF generation** | Partial | Prescription formatter exists; full PDF generation (wkhtmltopdf/Puppeteer) for reports/invoices not fully implemented server-side. |
| **Disaster Recovery (DR)** | Supported | Formal RPO/RTO SLAs documented in `DISASTER_RECOVERY.md`. Tier 1 (Atlas PITR: RPO < 5m) + Tier 2 encrypted snapshot engine (`npm run backup:mongo`, AES-256-GCM, dead-man's switch) and automated drill runner (`npm run restore:mongo:drill --from-r2`). |
| **Horizontal scaling** | Supported | Fully cluster-safe. Stateless API authenticated via shared RS256 keys (`JWT_*_BASE64`). Cross-node WebSocket fan-out and clinical panic-alert replay backed by Redis PubSub with origin-node self-echo suppression. |
| **Observability & Paging** | Supported | Sentry integration with strict allowlist PHI scrubber (erases request bodies/cookies, redacts Aadhaar/ABHA/mobile numbers for DPDP compliance). Real-time webhook alerting (`OPS_ALERT_WEBHOOK_URL`) pages on-call staff immediately on clinical panic-alert evaluation failures or 500 error cascades. |
| **DPDP 2023 Compliance** | Supported | Full statutory implementation under DPDPA 2023: Section 11 Data Portability (`GET /api/dpdp/export`), Section 12 Two-Tier Erasure with 3-year NMC Regulation 1.3 clinical retention hold (`POST /api/dpdp/erasure`), Section 6 purpose consent ledger with WhatsApp opt-out sync (`GET/PUT /api/dpdp/consents`), and Section 8(6) breach governance with automated DPBI notification dossiers and P0 on-call paging. |
| **Email verification** | Implemented | Defaults to `isEmailVerified: true` for staff; patient self-registration sets false. |
| **Audit log archival** | Implemented | Archiver utility exists; automated scheduling not configured. |
