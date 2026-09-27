# Backup and disaster recovery runbook

This is an internal operating procedure, not a measured recovery SLA.
Snapshot recovery-point loss depends on the actual backup schedule. Point-in-time
recovery requires a separately configured database backup service.

## Backup

From a source checkout with Node 24, configure MONGODB_URI and a dedicated
BACKUP_ENCRYPTION_KEY, then run npm run backup:mongo. Preview database connectivity
with npm run backup:mongo -- --dry-run. Choose storage with --out-dir <directory>.
Keep the application encryption key and backup encryption key escrowed separately;
both may be needed to recover readable historical records. Preserve old keys.

The script creates encrypted archives and a .backup-status.json receipt in its
output directory. BACKUP_HEARTBEAT_URL supports external success monitoring. The
API does not read that local receipt or guarantee backup freshness. Configure
external monitoring and verify that archives reach the intended off-site store.
Storage retention, deletion restrictions and immutability are operator settings;
the application does not provision them.

## Restore drill

Use npm run restore:mongo:drill against an isolated test environment. Read
scripts/mongoRestoreDrill.ts for archive/target arguments and safeguards before
running it. The drill uses temporary data and validates critical collections;
it is not a production restore or cutover command. Retain its report as evidence.

A production recovery needs an approved provider restore procedure or a
separately reviewed archive restore procedure.

## Incident recovery

1. Stop writes and preserve incident evidence.
2. Restore to an isolated destination using the configured database provider.
3. Verify collection counts, indexes, tenant isolation, decryption, and representative
   clinical and financial records. Check outbox state before enabling workers.
4. Record the actual recovered timestamp and elapsed recovery time.
5. Approve cutover, update secrets/connection settings, then restart services and
   verify readiness and critical user flows.

Retention periods and legal holds require the organization's approved policy.
This repository does not establish legal retention requirements or certify compliance.
