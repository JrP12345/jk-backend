# Backend cleanup contracts

2026-10-07. Organization is the tenant; Location is the physical healthcare place. Current relations, permissions, schemas and routes use locationId, maxLocations, amenities and the locations module. Clinic remains a facility type. DoctorAssignment.doctorId references User.

There is one /api representation and current schema/model names. Public providers resolve slugs. Uploads use /uploads/intent, /uploads/base64, /uploads/verify and /uploads/download/:intentId; responses use objectKey and intentId. Organization branding uses its ownership registry. Root provisioning preserves Root's session, and HTTP/private realtime require persisted session authority in every environment.

Previous ciphertext readers and key aliases are removed. DATA_ENCRYPTION_KEY configures the current enc:v1 envelope. Stable cryptographic derivation constants and immutable audit transition fields remain security boundaries. Development fixtures and guarded reset/seed workflows do not provide runtime readers for superseded schemas.

Lab orders use one structured result and resultedAt; flat result fields, completedDate and the unused future verifiedBy field are removed. Both the direct result action and encounter state-machine action preserve their current lifecycle behavior while using the same stored representation. Privacy exports identify EKAVYU_DPDP_EXPORT. Demo seeding requires explicit root credentials and never prints their password.

Final verification covers 155 backend files and 879 current cases using the broad run plus affected reruns. Encryption/configuration regressions pass 12 cases; the Root-preserving reset passes seven integration cases, including rollback and empty worker-collection recreation. Package TypeScript passes; the API and four workers build to five verified bundles. See the frontend [verification and retained occurrence inventory](../../frontend/docs/pre-production-cleanup.md) for combined evidence and scope. Source verification performed no database reset, seed, index application, secret rotation or deployment.

Both deployment examples declare DATA_ENCRYPTION_KEY. When updating Render, configure that name with the exact persistent encryption secret already used by the database. Sharing the key through the existing environment group keeps API and workers consistent; a fresh value is suitable only for a fresh database. See [deployment troubleshooting](../DEPLOYMENT.md#missing-data-encryption-key-on-render).

Separately, the user authorized resetting the shared local/Render development
database `test` on 2026-10-07. Of 1,956 records, only the existing Root document
and its one passkey remain. Root's password and encrypted MFA were preserved;
final read-only verification confirmed usable MFA and zero other records. Empty
collections and their indexes were removed; a running worker recreated an empty
workerleases collection. See [development-data.md](development-data.md) for the
explicit Root-preserving reset command. No seed or secret rotation was performed.

The no-op automatic no-show worker and unavailable endpoint are removed. Four current worker executables remain. Manual visit outcomes, overdue review, current module gates, payment verification and reconciliation remain. Session-close cancellation uses cancel without a financial promise.

Development lifecycle: [development-data.md](development-data.md). API: [api-contract.md](api-contract.md). Deployment: [DEPLOYMENT.md](../DEPLOYMENT.md). Operational evidence: [production-readiness-tracker.md](production-readiness-tracker.md). Cross-repository changes and final validation: [frontend cleanup audit](../../frontend/docs/pre-production-cleanup.md).
