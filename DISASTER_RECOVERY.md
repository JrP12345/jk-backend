# HealthOS Disaster Recovery (DR) & Backup Runbook

This document defines the Backup & Disaster Recovery policy, service-level objectives, encryption standards, operational runbooks, and restore verification protocols for HealthOS.

---

## 1. Objectives & Service Level Agreements (SLAs)

HealthOS processes Protected Health Information (PHI), diagnostic observations, clinical SOAP notes, electronic prescriptions, billing invoices, and ABDM care-context links. 

### Service-Level Matrix

| Tier | Deployment Profile | RPO (Recovery Point Objective) | RTO (Recovery Time Objective) | Mechanism |
| :--- | :--- | :--- | :--- | :--- |
| **Tier 1: Primary Production** | MongoDB Atlas Dedicated Replica Set (M10+) | **< 5 Minutes** (down to 1-second granularity) | **< 30 Minutes** | Continuous Oplog Backup with Point-in-Time Recovery (PITR) |
| **Tier 2: Hybrid / Secondary Off-Site** | Scripted Snapshot Archive (`mongoBackup.ts`) | **= Snapshot Cadence** (e.g., 6 Hours) | **< 60 Minutes** | Encrypted compressed archive streamed to off-site WORM storage (Cloudflare R2 / AWS S3) |

> [!IMPORTANT]
> **RPO Realism & Oplog Requirement**:
> A 5-minute RPO cannot be achieved via periodic dump scripts without continuous oplog streaming. Production environments requiring RPO < 5 minutes **must** use MongoDB Atlas Continuous Cloud Backups (or an equivalent continuous oplog tailing daemon). The included `npm run backup:mongo` script provides a reliable Tier-2 disaster-recovery snapshot whose RPO is determined by its cron trigger interval (default: 6 hours).

---

## 2. Encryption & Key Escrow Architecture

### Separation of Encryption Keys
To avoid the **key rotation trap** (where rotating the application's runtime field-level encryption key inadvertently invalidates historic backups), HealthOS separates backup encryption from application-level field encryption:

1. **`ENCRYPTION_KEY`**: Used solely for in-database field-level encryption (e.g., stored SMTP passwords, API tokens).
2. **`BACKUP_ENCRYPTION_KEY`**: A dedicated 64-character hex key (256-bit AES) used exclusively for backup archive encryption.
   - If omitted in development, `mongoBackup.ts` falls back to `ENCRYPTION_KEY` with a prominent warning.
   - In production, a dedicated `BACKUP_ENCRYPTION_KEY` should be provisioned and escrowed in an offline password safe / hardware security module (HSM).

### Versioned Header Format
Backups use AES-256-GCM authenticated encryption formatted as:
```text
v1:<iv_hex>:<authTag_hex>:<ciphertext_binary>
```
This version prefix (`v1:`) allows future key or cipher upgrades without breaking decryption of legacy archives.

---

## 3. Storage Immutability & Ransomware Protection

To protect against credential compromise, insider threats, and ransomware:

1. **S3 Object Lock (WORM - Write Once, Read Many)**:
   - When using AWS S3, enable **Object Lock** in *Compliance Mode* with a default retention period matching your retention policy (e.g., 30 days).
   - In Compliance Mode, no user (including the AWS root account) can overwrite or delete the backup objects until the retention period expires.
2. **Cloudflare R2 Bucket Versioning**:
   - If using Cloudflare R2, enable **Bucket Versioning** and restrict `DeleteObject` permissions to a separate break-glass IAM role.
3. **Cross-Region / Cross-Cloud Replication**:
   - Primary database in region A; backup archives stored in an independent cloud provider or separate cloud account.

---

## 4. Failure Alerting & Dead-Man's Switch

A backup system that fails silently is discovered broken during the disaster. HealthOS implements failure detection through two layers:

1. **Dead-Man's Switch (`BACKUP_HEARTBEAT_URL`)**:
   - The backup script supports `BACKUP_HEARTBEAT_URL` (compatible with Healthchecks.io, Better Uptime, or Cronitor).
   - The script pings this endpoint **only** upon successful completion and verification of the backup upload.
   - If the cron job fails, hangs, encounters disk exhaustion, or has invalid S3 credentials, the external monitoring service will page on-call engineers.
2. **Local Status & Audit Receipt (`.backup-status.json`)**:
   - Every run writes an audit receipt containing timestamp, duration, compressed size, sha256 hash, and status.
   - The backend `/api/health` subsystem reads this receipt and flags a warning if the last successful backup is older than 24 hours.

---

## 5. Automated Backup Tooling

### Creating a Backup (`scripts/mongoBackup.ts`)
```bash
# Run standalone backup with default settings
npm run backup:mongo

# Test dry-run without writing or uploading
npm run backup:mongo -- --dry-run

# Specify custom output path
npm run backup:mongo -- --out-dir /mnt/secure-backups
```

### Automated Restore Verification Drill (`scripts/mongoRestoreDrill.ts`)
A backup is only as good as its tested restore procedure. HealthOS provides a non-destructive drill runner:
```bash
npm run restore:mongo:drill
```
What the drill runner does:
1. Locates the most recent encrypted backup archive.
2. Decrypts and decompresses the archive into an isolated temporary database (`healthos_restore_drill_<timestamp>`).
3. Runs integrity checks:
   - Verifies all critical collections (`users`, `patients`, `appointments`, `prescriptions`, `invoices`, `laborders`).
   - Verifies document counts and index validity.
4. Drops the temporary drill database.
5. Emits a signed drill report with execution metrics.

---

## 6. Manual Restore Runbook (Disaster Incident Protocol)

### Scenario A: Restoring on MongoDB Atlas (Tier 1 PITR)
1. Log in to **MongoDB Atlas Console** → Cluster → **Backup**.
2. Select **Point-in-Time Restore**.
3. Specify the exact target timestamp (e.g. `2026-09-08 22:15:00 UTC`, 2 minutes prior to the catastrophic event).
4. Choose restore destination:
   - Option 1 (Recommended): Restore to a **New Cluster** to verify integrity before cutting over DNS/connection strings.
   - Option 2: Restore in-place on existing cluster.
5. Update `MONGODB_URI` in application environment secrets if restored to a new cluster, then restart application pods.

### Scenario B: Restoring from Tier-2 Encrypted Archive
1. Retrieve target backup file (e.g., `backup-2026-09-08T22-00-00.gz.enc`).
2. Run decrypt utility using the `BACKUP_ENCRYPTION_KEY`:
   ```bash
   node --experimental-strip-types scripts/mongoRestore.ts --input ./backup-target.gz.enc --target-db healthos_production
   ```
3. The restore utility decrypts the archive, unpacks the BSON stream, and applies indexes.
4. Execute validation smoke tests:
   ```bash
   node --experimental-strip-types scripts/verifyDataIntegrity.ts
   ```

---

## 7. Regulatory & Retention Compliance Advisory

> [!WARNING]
> **Legal & Regulatory Compliance Sign-off Required**:
> - **Medical Records Retention**: Under National Medical Commission (NMC) regulations and Indian Medical Council (Professional Conduct, Etiquette and Ethics) Regulations, medical practitioners are commonly advised to maintain medical records for a minimum period (frequently cited as 3 years from the date of commencement of treatment or last visit).
> - **DPDP Act 2023 Interplay**: The Digital Personal Data Protection Act 2023 allows data retention when required by statutory law. Clinical data retention exemptions override standard data erasure requests.
> - **Action Required**: The specific backup retention window (e.g. 30 days active PITR, 1 year daily, 3-7 years long-term cold archive) **must be formally reviewed and ratified by your organization's legal and compliance officers** before deploying into production.
