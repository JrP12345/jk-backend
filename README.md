# HealthOS / Anant Health — Backend API Engine

An enterprise healthcare platform backend built with **Fastify 5**, **Node.js (ES Modules)**, **MongoDB (Mongoose 9)**, **Redis**, and asymmetric **RS256 JWT authentication**.

---

## Technical Stack

- **Framework**: Fastify 5 (`fastify`)
- **Runtime**: Node.js ES Modules with `--experimental-strip-types`
- **Database**: MongoDB with Mongoose 9 (`mongoose`)
- **Caching & Rate-Limiting**: ioredis (`ioredis`) & `@fastify/rate-limit`
- **Authentication**: Asymmetric RS256 JWT tokens with httpOnly cookies (`@fastify/cookie`, `jsonwebtoken`)
- **Event Bus & Notifications**: PubSub EventBus (`eventBus.ts`), Server-Sent Events (SSE), and fail-closed Nodemailer delivery (`emailProvider.ts`)
- **Cloud Storage**: AWS S3 / Cloudflare R2 presigned upload integration (`@aws-sdk/client-s3`)
- **Testing**: Vitest (`vitest`) with MongoDB Memory Server (`mongodb-memory-server`)

---

## Complete 37 Mongoose Schemas & Database Inventory

| Model Name | Source File | Purpose | Key Fields & Indexes |
| :--- | :--- | :--- | :--- |
| `Organization` | `models/Organization.ts` | Multi-tenant hospital org | `name`, `city`, `plan`, `isActive`, `maxClinics` |
| `Clinic` | `models/Clinic.ts` | Physical clinic branch | `organizationId`, `name`, `city`, `isActive` |
| `Department` | `models/Department.ts` | Medical department | `organizationId`, `clinicId`, `name` |
| `User` | `models/User.ts` | System user account | `email` (Unique Index), `role`, `isActive` |
| `OrgMember` | `models/OrgMember.ts` | User org binding | `{ userId, organizationId }` (Compound Unique Index) |
| `Role` | `models/Role.ts` | Role & permissions | `name` (Unique Index), `permissions[]` |
| `Permission` | `models/Permission.ts` | Permission definition | `code` (Unique Index), `category` |
| `Doctor` | `models/Doctor.ts` | Physician profile | `userId`, `organizationId`, `specialty`, `licenseNumber` |
| `Receptionist` | `models/Receptionist.ts` | Receptionist profile | `userId`, `organizationId` |
| `DoctorAssignment` | `models/DoctorAssignment.ts` | Multi-clinic schedule | `doctorId`, `clinicId`, `assignedDays` |
| `Patient` | `models/Patient.ts` | Patient medical profile | `userId`, `mrn`, `gender`, `allergies[]`, `conditions[]` |
| `Appointment` | `models/Appointment.ts` | Appointment slot | `patientId`, `doctorId`, `clinicId`, `date`, `status` |
| `Task` | `models/Task.ts` | Task assignment | `organizationId`, `title`, `assignedTo`, `createdBy`, `priority` |
| `Encounter` | `models/Encounter.ts` | Clinical encounter | `patientId`, `doctorId`, `clinicId`, `status`, `encounterType` |
| `ClinicalNote` | `models/ClinicalNote.ts` | SOAP note document | `encounterId`, `patientId`, `isFinal`, `parentNoteId` |
| `CDSEvaluation` | `models/CDSEvaluation.ts` | CDS safety check log | `encounterId`, `patientId`, `alerts[]` |
| `Observation` | `models/Observation.ts` | Vital signs reading | `encounterId`, `patientId`, `code`, `value` |
| `ObservationScore` | `models/ObservationScore.ts` | NEWS2 score log | `encounterId`, `patientId`, `totalScore`, `riskCategory` |
| `ObservationAlert` | `models/ObservationAlert.ts` | Deterioration alert | `encounterId`, `scoreId`, `severity`, `acknowledged` |
| `LabTest` | `models/LabTest.ts` | Lab test catalog | `clinicId`, `code`, `name`, `price`, `normalRange` |
| `LabOrder` | `models/LabOrder.ts` | Diagnostic order | `encounterId`, `patientId`, `testId`, `status`, `result` |
| `Medicine` | `models/Medicine.ts` | Pharmacy inventory | `organizationId`, `name`, `stockQuantity`, `price` |
| `Prescription` | `models/Prescription.ts` | Prescribed drug | `encounterId`, `patientId`, `medicineId`, `dosage` |
| `MedicationAdministration` | `models/MedicationAdministration.ts` | MAR dose administration | `encounterId`, `prescriptionId`, `status` |
| `Bed` | `models/Bed.ts` | Ward bed unit | `clinicId`, `departmentId`, `bedNumber`, `status` |
| `Admission` | `models/Admission.ts` | IPD admission record | `patientId`, `bedId`, `admittedAt`, `status` |
| `DischargeDocument` | `models/DischargeDocument.ts` | Discharge summary | `encounterId`, `patientId`, `isFinal`, `documentHash` (SHA-256) |
| `Invoice` | `models/Invoice.ts` | Invoice & payment | `patientId`, `encounterId`, `totalAmount`, `status` |
| `AuditLog` | `models/AuditLog.ts` | Immutable audit log | `userId`, `organizationId`, `action`, `resource` |
| `Notification` | `models/Notification.ts` | In-app notification | `targetUserId`, `organizationId`, `title`, `message`, `isRead` |
| `NotificationPreference` | `models/NotificationPreference.ts` | Delivery preferences | `userId`, `channels`, `categories` |
| `NotificationTemplate` | `models/NotificationTemplate.ts` | Notification template | `code`, `subject`, `bodyTemplate` |
| `NotificationDelivery` | `models/NotificationDelivery.ts` | Channel log | `notificationId`, `channel`, `status` |
| `PendingTwoFactorSetup` | `models/PendingTwoFactorSetup.ts` | TOTP secret state | `userId`, `tempSecret` |
| `OnboardingDraft` | `models/OnboardingDraft.ts` | Onboarding draft | `orgSecret`, `draftData` |
| `RefreshToken` | `models/RefreshToken.ts` | Hashed refresh token | `userId`, `tokenHash`, `expiresAt` |
| `Counter` | `models/Counter.ts` | Sequence generator | `name`, `seq` |

---

## Complete API Domain Catalog

### 1. Auth & Session (`/api/auth/*`)
- `POST /api/auth/login` — Login user & set httpOnly cookies.
- `POST /api/auth/register` — Self-register new patient account.
- `POST /api/auth/refresh` — Exchange refresh token for access token.
- `POST /api/auth/logout` — Revoke session & clear cookies.
- `GET /api/auth/me` — Get current user details & permissions.
- `POST /api/auth/switch-org` — Root Admin organization context switch.

### 2. Onboarding & Administration (`/api/onboarding/*`)
- `POST /api/onboarding/organization` — Register organization & initial admin.
- `GET/PUT/DELETE /api/organizations` — Root Admin platform organization CRUD.
- `POST/GET/PUT/DELETE /api/onboarding/clinics` — Multi-location clinic management.
- `POST/GET /api/departments` — Department management.
- `POST/GET/PUT/DELETE /api/onboarding/staff` — Staff management & role provisioning.
- `GET/PUT /api/onboarding/organization/me` — Organization settings management.

### 3. OPD Queue Management (`/api/queue/*`)
- `GET /api/queue` — Fetch live OPD patient queue.
- `PUT /api/queue/reorder` — Reorder queue tokens & VIP overrides.
- `POST /api/queue/call-next` — Advance queue token to consultation.

### 4. Appointments & Scheduling (`/api/*`)
- `POST /api/appointments` — Book appointment slot.
- `GET /api/appointments` — List appointments.
- `PUT /api/appointments/:id/status` — Update status.
- `GET /api/doctors/:doctorId/slots` — Fetch doctor schedule slots.

### 5. Clinical Encounter & SOAP (`/api/*`)
- `POST /api/encounters` — Initiate encounter session.
- `POST /api/clinical-notes` — Save draft SOAP note.
- `PUT /api/clinical-notes/:id/sign` — Sign and immutably lock note.
- `POST /api/clinical-notes/:id/amend` — Create note amendment version.

### 6. NEWS2 Vitals & Alerts (`/api/*`)
- `POST /api/encounters/:id/evaluate-score` — Evaluate vitals & compute NEWS2 score.
- `GET /api/encounters/:id/scores` — List historical NEWS2 scores.
- `POST /api/alerts/:id/acknowledge` — Acknowledge high-risk deterioration alert.

### 7. Diagnostics & Orders (`/api/*`)
- `POST/GET/PUT/DELETE /api/lab-tests` — Diagnostic catalog management.
- `POST /api/encounters/:id/orders` — Place diagnostic order.
- `PUT /api/orders/:id/collect` — Mark sample collected.
- `PUT /api/orders/:id/process` — Transition to lab processing.
- `PUT /api/orders/:id/result` — Upload result & flag abnormal values.
- `PUT /api/orders/:id/cancel` — Cancel order.

### 8. Medication Administration Record (`/api/*`)
- `POST /api/encounters/:id/mar` — Schedule MAR dose.
- `GET /api/encounters/:id/mar` — Fetch MAR schedule.
- `PUT /api/mar/:id/administer` — Administer dose (5 Rights verification).
- `PUT /api/mar/:id/refuse` — Record patient refusal.
- `PUT /api/mar/:id/hold` — Record clinical hold.

### 9. Discharge Summary (`/api/*`)
- `POST /api/encounters/:id/discharge/compile` — Compile discharge summary draft.
- `PUT /api/discharge/:id/finalize` — Finalize summary & SHA-256 lock.
- `PUT /api/discharge/:id/countersign` — Physician countersign.

### 10. FHIR R4 Interoperability (`/api/fhir/R4/*`)
- `GET /api/fhir/R4/Patient/:id` — FHIR Patient Resource.
- `GET /api/fhir/R4/Encounter/:id` — FHIR Encounter Resource.
- `GET /api/fhir/R4/Observation/:id` — FHIR Observation Resource.
- `GET /api/fhir/R4/DiagnosticReport/:id` — FHIR DiagnosticReport Resource.
- `GET /api/fhir/R4/MedicationAdministration/:id` — FHIR MedicationAdministration Resource.
- `GET /api/fhir/R4/Composition/:id` — FHIR Composition Resource.
- `GET /api/fhir/R4/Encounter/:id/$export` — FHIR Bundle Document Export.

---

## Environment Setup (`backend/.env`)

```env
PORT=5000
MONGODB_URI=mongodb://localhost:27017/healthos
NODE_ENV=development
CORS_ALLOWED_ORIGINS=http://localhost:3000
ONBOARDING_SECRET=your_secret_key_here
REDIS_URL=redis://localhost:6379
```

---

## Running Development & Test Suite

1. **Install Dependencies**: `npm install`
2. **Start Dev Server**: `npm run dev`
3. **Run Test Suite**: `npm test` (**118/118 tests passing** across 25 integration suites).
