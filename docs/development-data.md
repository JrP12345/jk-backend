# Development database lifecycle

The current model uses Organization tenants, Location physical places, locationId, facilityType, amenities and maxLocations. Development databases containing superseded model fields must be reset and reseeded. Startup does not backfill domain fields or subscription quotas.

The reset and seed commands accept only NODE_ENV=development and an explicit local mongodb URI for localhost, 127.0.0.1 or ::1. The database must be ekavyu_dev or ekavyu_test, optionally with an underscore suffix. All commands require --confirm-database matching the URI. Reset application requires --writes-paused and --apply; without --apply it only lists the target collections.

Stop API and worker writes, then run:

    npm run reset:development -- --confirm-database=ekavyu_dev
    npm run reset:development -- --confirm-database=ekavyu_dev --writes-paused --apply

Reset discards development records, sessions, queues and pending jobs. Both seeds refuse any nonempty collection. ROOT_ADMIN_EMAIL and ROOT_ADMIN_PASSWORD select the new root; passwords require at least 12 characters.

    npm run seed:root -- --confirm-database=ekavyu_dev

seed:root creates a root and the current plans. npm run seed -- --confirm-database=ekavyu_dev creates demo data instead. Root MFA requires fresh encrypted enrollment; use DATA_ENCRYPTION_KEY consistently. Do not copy superseded documents or plaintext credentials into current schemas.

npm run db:indexes previews current schema indexes without connecting. During a controlled rollout with writes paused, npm run db:indexes -- --writes-paused --apply creates indexes. It does not drop indexes or repair conflicting rows. Review uniqueness conflicts explicitly. Immutable audit history has a separate chain-preserving remediation procedure.

No database reset, seed, index application or secret rotation is part of source verification. Development reset is never a production deployment step.

## Start over while preserving Root

For an explicitly chosen development installation, including a shared hosted
database, `reset:root-only` preserves one existing Root document and its registered
passkeys. Root's ID, password hash, encrypted MFA secret and other authentication
fields stay unchanged. All other records, sessions, organizations, patient data,
billing, plans, queues, audit history and jobs are removed. This is an operator
action for disposable development data, never an application startup step.

Preview the exact connected database first:

    npm run reset:root-only -- --confirm-database=<database>

If multiple Root accounts exist, select one with `--root-email=<email>`. The
database name must match the actual connection; `admin`, `local` and `config`
are refused. The existing DATA_ENCRYPTION_KEY must successfully decrypt Root's
current MFA secret. Preview prints counts and IDs, without credentials or keys.

Stop API and workers when possible to prevent new writes, then apply:

    npm run reset:root-only -- --confirm-database=<database> --apply

Deletion uses one replica-set/sharded-cluster transaction and verifies the retained
authentication before commit. Afterward, empty collections and their indexes are
dropped. A running worker can recreate an empty collection; this is reported
separately. Recreated records cause verification to stop. Root must sign in again;
the current role catalog and model indexes are prepared through normal startup.
Create fresh commercial plans through Root administration. Do not run the empty-
database seed over the preserved Root account.
