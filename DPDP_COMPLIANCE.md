# Data-rights and incident implementation

This document describes the code's behavior. It does not certify legal compliance,
statutory deadlines, regulatory filings or an approved clinical retention policy.

## Routes

Authenticated patient/self-service and authorized staff workflows use:

- GET /api/dpdp/export
- POST /api/dpdp/erasure
- GET /api/dpdp/consents
- PUT /api/dpdp/consents

Compliance administration also provides GET/POST /api/dpdp/breaches and
GET /api/dpdp/breaches/:incidentId/dpbi-dossier. Route authorization and patient/
organization scope must be checked together; a role name is not blanket access.

## Implemented behavior and limits

DPDPService builds the data export, anonymizes supported patient/profile fields,
disables the linked account and records a legalRetentionHoldUntil date for retained
records. The date is an application policy value. It does not create a scheduled
purge or enforce read-only access throughout the clinical system. Cleanup must not
introduce automatic deletion of these records.

Purpose-based consent and history are persisted. WhatsApp consent is integrated
with messaging opt-out checks. Storing a consent purpose is not evidence that every
AI, recall or survey workflow enforces it; verify each downstream path before making
that claim to patients or operators.

Breach records and dossier generation support internal investigation. Submission to
a regulator and communication to affected people remain operational actions. The
API does not automatically complete statutory reporting. Response deadlines and
retention periods must be determined under the approved, current organization policy.

Review export coverage, anonymization coverage, family authorization, retained
clinical identifiers, audit history and backup handling before enabling these flows
for production. Record independent validation in the production readiness tracker.
