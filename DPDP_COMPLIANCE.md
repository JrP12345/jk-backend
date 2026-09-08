# HealthOS — DPDP 2023 Compliance & Data Breach Incident Runbook

## 1. Overview & Regulatory Framework

As a multi-tenant outpatient healthcare SaaS platform operating in India, HealthOS processes sensitive personal data of patients and medical practitioners. This document establishes the statutory data governance architecture required under the **Digital Personal Data Protection Act, 2023 (DPDPA 2023)** and reconciles its requirements with clinical record-keeping obligations under the **National Medical Commission (NMC)**.

| Role Under Law | Entity | Responsibilities |
| :--- | :--- | :--- |
| **Data Fiduciary** | Enrolled Clinic / Hospital Organization | Determines purpose and means of clinical data processing; legally accountable for compliance. |
| **Data Processor** | HealthOS Platform (Cloud Infrastructure) | Processes data on behalf of the fiduciary under strict tenant isolation. |
| **Data Principal** | Patient / Legal Guardian | Individual to whom personal and health data relates. |
| **Supervisory Authority** | Data Protection Board of India (DPBI) | Regulatory body empowered to adjudicate breaches and penalize non-compliance. |

---

## 2. Patient Data Subject Rights (DSAR) Architecture

HealthOS implements automated, programmatic workflows for patients or their authorized legal representatives to exercise their rights under Chapter III of DPDPA 2023.

### A. Right to Access & Data Portability (Section 11)
- **Endpoint:** `GET /api/dpdp/export`
- **Access Control:** Authenticated patient self-service (or clinic administrator on behalf of patient).
- **Format:** Structured, machine-readable JSON dossier (`HEALTHOS_DPDP_EXPORT_V1`).
- **Payload Contents:**
  - Complete demographic profile (name, contact numbers, address, Aadhaar/ABHA references).
  - Chronological encounters & consultation SOAP notes.
  - Prescriptions & dispensed medications.
  - Laboratory investigation orders and diagnostic test results.
  - Billing invoices, receipts, and payment transactions.
  - Active DPDP purpose-based consent ledger.
- **Statutory Resolution SLA:** Immediate on-demand generation via API (< 500ms). Formal offline requests must be fulfilled within **30 days**.

### B. Right to Erasure with NMC 3-Year Carve-Out (Section 12 & Section 17)
- **Endpoint:** `POST /api/dpdp/erasure`
- **The Legal Conflict:**
  - DPDPA Section 12 gives data principals the right to erasure of their personal data upon request or withdrawal of consent.
  - However, **Indian Medical Council (Professional Conduct, Etiquette and Ethics) Regulations, 2002 (Regulation 1.3)** legally mandates that doctors and medical establishments retain clinical outpatient records for a minimum period of **3 years**.
  - DPDPA **Section 17(1)(b)** explicitly provides an exemption: *provisions of Chapter III (including erasure) do not apply where processing is necessary for compliance with any law for the time being in force*.
- **The HealthOS Two-Tier Anonymization Solution:**
  1. **Tier 1 (Immediate PII Anonymization)**:
     - Patient name is irreversibly replaced with `[Anonymized Patient]`.
     - Contact numbers are masked to `0000000000`.
     - Email is replaced with synthetic tombstone `anonymized_<id>@deleted.local`.
     - Physical address, emergency contacts, and insurance numbers are wiped.
     - ABHA ID and ABDM care context linkages are unlinked and marked `deactivated`.
     - Linked user portal authentication account is deactivated (`isActive: false`).
  2. **Tier 2 (Clinical Legal Hold & Scheduled Purge)**:
     - Medical consultations, lab results, prescriptions, and financial invoices are retained under a **3-year statutory legal hold** (`legalRetentionHoldUntil: latestActivityDate + 3 years`).
     - Records are frozen in read-only mode for medical defence and regulatory inspections.
     - An immutable compliance audit receipt is logged in `AuditLog` under category `COMPLIANCE_DPDP`.

---

## 3. Granular Purpose-Based Consent Ledger (Section 6 & Section 7)

HealthOS decouples clinical care consent from secondary or auxiliary communication processing.

### Supported DPDP Purpose Grants

| Purpose Code | Description | Default Status | Downstream Impact Upon Withdrawal |
| :--- | :--- | :--- | :--- |
| `COMMUNICATION_WHATSAPP` | Automated appointment reminders and follow-up messages via WhatsApp. | `GRANTED` | Automatically sets `Patient.optOutWhatsApp = true`, halting automated WhatsApp outreach. |
| `AI_CLINICAL_ASSISTANCE` | Ambient clinical note summarization and diagnostic validation. | `GRANTED` | Disables automated LLM copilot suggestions on the patient's encounter notes. |
| `PREVENTIVE_HEALTH_RECALLS` | Periodic chronic care reminders and vaccination schedules. | `GRANTED` | Excludes patient from clinic preventive health batch campaigns. |
| `FEEDBACK_AND_SURVEYS` | Post-consultation clinic quality surveys. | `GRANTED` | Prevents automated satisfaction survey dispatch. |

### API Endpoints
- **View Consents:** `GET /api/dpdp/consents`
- **Update / Revoke Consents:** `PUT /api/dpdp/consents` with `{ updates: [{ purpose, status: "WITHDRAWN" }] }`
- **Audit Logging:** Every consent grant and withdrawal records an immutable timestamp, IP address, user-agent, and source channel in `DPDPConsent.history`.

---

## 4. Personal Data Breach Incident Management (Section 8(6))

Under Section 8(6) of DPDPA 2023:
> *"In the event of a personal data breach, the Data Fiduciary shall give the Board and each affected Data Principal, intimation of such breach in such form and manner as may be prescribed."*

### A. Severity Matrix & Response Tiers

| Severity | Definition | Examples | SLA to DPBI & Principals | Alert Escalation |
| :--- | :--- | :--- | :--- | :--- |
| **CRITICAL** | Massive exfiltration of patient clinical or financial records (> 500 subjects) or active credential dump. | Database leak, unauthorized S3 dump, active ransom attack. | **Immediate (≤ 24 hours)** | Real-time P0 Webhook to on-call pager / Slack. |
| **HIGH** | Unauthorized access to clinical PHI or sensitive demographics (< 500 subjects). | Misconfigured API route exposing lab reports, staff account takeover. | **≤ 72 hours** | Real-time P0 Webhook to security team. |
| **MEDIUM** | Accidental internal disclosure with limited scope (< 50 subjects). | Patient report sent to incorrect email/phone number. | **Internal review / 72h** | Logged to `DataBreachIncident`, reviewed by DPO. |
| **LOW** | Minor non-sensitive telemetry exposure (no PII/PHI). | Error stack trace containing non-identifying route IDs. | **Routine triage** | Standard bug triage. |

### B. Incident Response Workflow (72-Hour Clock)

```
[Hour 0: Detection]
       │
       ▼
[Hour 0-2: Containment & Triage]
  • Log incident via POST /api/dpdp/breaches
  • System triggers P0 Paging via captureCriticalError()
  • Isolate compromised credentials / revoke active sessions
       │
       ▼
[Hour 2-24: Forensic Assessment]
  • Identify affected Data Principals (affectedPatientIds)
  • Classify exposed data categories (PII, CLINICAL_PHI, FINANCIAL_BILLING)
       │
       ▼
[Hour 24-72: Statutory Notifications]
  • Generate official filing dossier: GET /api/dpdp/breaches/:id/dpbi-dossier
  • Submit formal incident intimation to the Data Protection Board of India (DPBI)
  • Dispatch advisory notifications to affected patients (Email / WhatsApp / SMS)
       │
       ▼
[Post-Incident: Remediation]
  • Close incident (status: RESOLVED) with rootCause and remediationSteps
  • Immutable audit trail locked in AuditLog
```

### C. Statutory DPBI Notice Schema
The platform automatically generates the required DPBI disclosure via:
`GET /api/dpdp/breaches/:incidentId/dpbi-dossier`

The generated payload includes:
1. **Fiduciary Details:** Clinic/Organization legal name, registration identifier, and DPO contact.
2. **Nature & Extent of Incident:** Incident tracking ID, discovery timestamp, containment status, assessed severity.
3. **Data Categories Compromised:** `PII`, `CLINICAL_PHI`, `FINANCIAL_BILLING`, `CREDENTIALS`.
4. **Impact Assessment:** Exact/estimated count of affected data subjects.
5. **Mitigation & Remediation:** Forensic root cause, containment steps applied, and patient support helpline.

---

## 5. Summary Checklist for Compliance Officers

- [x] Data portability endpoint active (`GET /api/dpdp/export`).
- [x] Two-tier erasure with 3-year NMC legal hold active (`POST /api/dpdp/erasure`).
- [x] Purpose-based consent ledger and WhatsApp opt-out synchronization active (`GET/PUT /api/dpdp/consents`).
- [x] Security breach logging, DPBI dossier generator, and P0 paging active (`/api/dpdp/breaches`).
- [x] All compliance operations recorded under `AuditLog.category = "COMPLIANCE_DPDP"`.
